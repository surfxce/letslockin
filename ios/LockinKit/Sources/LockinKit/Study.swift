import Foundation

/// A sitting as the phone shows it: from the computer, or answered here and not yet sent.
public struct SittingRecord: Identifiable, Hashable, Sendable {
    public enum Status: Hashable, Sendable {
        /// Marked, here or on the computer.
        case marked
        /// On the computer, in its queue to be marked.
        case markingOnComputer
        /// Answered on this phone, not yet synced.
        case waitingToSync
        /// Synced, but nothing on the computer will mark it (copy-and-paste mode).
        case unmarked
    }

    public struct Answer: Identifiable, Hashable, Sendable {
        public var id: String
        public var questionId: String
        public var answerText: String
        public var mark: Double?
        public var feedback: [FeedbackItem]
        public var status: Status
        /// Why the phone couldn't mark it, when it tried.
        public var note: String?
    }

    public var id: String
    public var lectureId: String
    public var date: Date
    public var answers: [Answer]
    /// Synced to the computer.
    public var synced: Bool

    /// The geometric mean once every answer has a mark.
    public var score: Double? {
        let marks = answers.compactMap(\.mark)
        return marks.count == answers.count ? geometricMean(marks) : nil
    }

    public var waiting: Int { answers.filter { $0.mark == nil }.count }
}

/// Every sitting of a lecture, newest first: the computer's, then any answered here
/// that it hasn't received yet.
public func sittingRecords(lectureId: String, snapshot: Snapshot?, outbox: [PhoneSitting]) -> [SittingRecord] {
    let fromComputer = (snapshot?.sittings ?? []).filter { $0.lectureId == lectureId }
    let known = Set(fromComputer.map(\.id))
    var records = fromComputer.map { sitting in
        SittingRecord(
            id: sitting.id,
            lectureId: sitting.lectureId,
            date: sitting.sittingDate,
            answers: sitting.responses.map { r in
                SittingRecord.Answer(
                    id: r.id,
                    questionId: r.questionId,
                    answerText: r.answerText,
                    mark: r.mark,
                    feedback: r.feedback,
                    status: r.mark != nil ? .marked : r.pending ? .markingOnComputer : .unmarked,
                    note: nil
                )
            },
            synced: true
        )
    }
    for sitting in outbox where sitting.lectureId == lectureId && !known.contains(sitting.id) {
        records.append(SittingRecord(
            id: sitting.id,
            lectureId: sitting.lectureId,
            date: sitting.startedAt,
            answers: sitting.responses.map { r in
                let blank = r.answerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                return SittingRecord.Answer(
                    id: r.id,
                    questionId: r.questionId,
                    answerText: r.answerText,
                    // As the computer will: a blank answer scores 0.
                    mark: blank ? 0 : r.marking?.mark,
                    feedback: blank ? [FeedbackItem(kind: "missed", text: "Left blank.")] : r.marking.map(feedback(for:)) ?? [],
                    status: blank || r.marking != nil ? .marked : .waitingToSync,
                    note: r.markingError
                )
            },
            synced: false
        ))
    }
    return records.sorted { $0.date > $1.date }
}
