import Foundation

/// How an exam chooses its questions (lib/exam/pick.ts): spread like the real one, or aimed at weak spots.
public enum ExamFocus: String, Codable, CaseIterable, Identifiable, Sendable {
    case mixed, weak
    public var id: String { rawValue }
    public var label: String { self == .mixed ? "Mixed" : "Weak areas first" }
}

public struct ExamCandidate: Hashable, Sendable {
    public var id: String
    public var lectureId: String
    /// Times it has been answered before.
    public var seen: Int
    /// Its latest mark out of 10 (an MCQ is 10 or 0); nil if never marked.
    public var lastMark: Double?

    public init(id: String, lectureId: String, seen: Int = 0, lastMark: Double? = nil) {
        self.id = id
        self.lectureId = lectureId
        self.seen = seen
        self.lastMark = lastMark
    }
}

/// As the computer picks (pickExamItems): one from each lecture in turn, unseen first;
/// weak focus brings back what was answered worst, then the weakest lectures.
public func pickExamItems<G: RandomNumberGenerator>(
    _ candidates: [ExamCandidate],
    count: Int,
    focus: ExamFocus,
    lectureScore: [String: Double] = [:],
    using generator: inout G
) -> [String] {
    guard count > 0, !candidates.isEmpty else { return [] }
    let weak = focus == .weak
    let markKey = { (mark: Double?) -> Double in mark ?? 5 }
    var byLecture: [String: [ExamCandidate]] = [:]
    var lectureOrder: [String] = []
    for candidate in candidates.shuffled(using: &generator) {
        if byLecture[candidate.lectureId] == nil { lectureOrder.append(candidate.lectureId) }
        byLecture[candidate.lectureId, default: []].append(candidate)
    }
    for (lecture, list) in byLecture {
        // Sorted with the shuffled position as the last key, so ties stay random.
        byLecture[lecture] = list.enumerated().sorted { a, b in
            let ka = weak ? markKey(a.element.lastMark) : 0
            let kb = weak ? markKey(b.element.lastMark) : 0
            if ka != kb { return ka < kb }
            if a.element.seen != b.element.seen { return a.element.seen < b.element.seen }
            return a.offset < b.offset
        }.map(\.element)
    }
    var lectures = lectureOrder.shuffled(using: &generator)
    if weak {
        lectures = lectures.enumerated().sorted { a, b in
            let sa = lectureScore[a.element] ?? -1
            let sb = lectureScore[b.element] ?? -1
            return sa != sb ? sa < sb : a.offset < b.offset
        }.map(\.element)
    }
    var ordered: [ExamCandidate] = []
    var round = 0
    while ordered.count < candidates.count {
        for lecture in lectures {
            if let list = byLecture[lecture], round < list.count { ordered.append(list[round]) }
        }
        round += 1
    }
    if weak {
        ordered = ordered.enumerated().sorted { a, b in
            let ka = markKey(a.element.lastMark)
            let kb = markKey(b.element.lastMark)
            return ka != kb ? ka < kb : a.offset < b.offset
        }.map(\.element)
    }
    return ordered.prefix(count).map(\.id)
}

/// A rough exam time: a minute and a half per MCQ and fifteen minutes per LAQ.
public func suggestedExamMinutes(mcqs: Int, laqs: Int) -> Int {
    let minutes = Double(mcqs) * 1.5 + Double(laqs) * 15
    return max(5, Int((minutes / 5).rounded(.up)) * 5)
}

/// An exam being sat on the phone, kept as it's answered.
public struct ExamDraft: Codable, Hashable, Identifiable, Sendable {
    public struct Item: Codable, Hashable, Identifiable, Sendable {
        public var id: String
        /// "MCQ" or "LAQ".
        public var kind: String
        public var lectureId: String
        public var mcqId: String?
        public var questionId: String?
        public var choice: Int?
        public var answer: String
    }

    public var id: String
    public var title: String
    public var startedAt: Date
    public var timeLimitMin: Int?
    public var items: [Item]

    public var mcqs: [Item] { items.filter { $0.kind == "MCQ" } }
    public var laqs: [Item] { items.filter { $0.kind == "LAQ" } }
    public var unanswered: (mcqs: Int, laqs: Int) {
        (mcqs.filter { $0.choice == nil }.count,
         laqs.filter { $0.answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.count)
    }
}

/// What the phone has to set an exam from: the computer's copy and what was answered here.
public struct ExamSource {
    public var snapshot: Snapshot
    /// Sittings answered here and not yet sent, including earlier exams' long answers.
    public var localSittings: [PhoneSitting]
    /// Exams sat here before, for which multiple choice has been seen.
    public var pastExams: [PhoneExam]

    public init(snapshot: Snapshot, localSittings: [PhoneSitting], pastExams: [PhoneExam]) {
        self.snapshot = snapshot
        self.localSittings = localSittings
        self.pastExams = pastExams
    }

    /// The LAQs an exam may ask of a lecture: not past-paper ones.
    public func laqs(of lecture: Lecture) -> [Question] {
        lecture.questions.filter { $0.fromPaper != true }
    }

    public func mcqs(of lectureId: String) -> [Mcq] {
        (snapshot.mcqs ?? []).filter { $0.lectureId == lectureId && $0.options.count > $0.answer }
    }

    /// Sets an exam. Multiple choice comes first, shuffled; long answers in lecture order.
    public func makeExam<G: RandomNumberGenerator>(
        lectureIds: Set<String>, mcqs mcqCount: Int, laqs laqCount: Int, focus: ExamFocus, timeLimitMin: Int?,
        now: Date = Date(), using generator: inout G
    ) -> ExamDraft? {
        let lectures = snapshot.lectures.filter { lectureIds.contains($0.id) }
        guard !lectures.isEmpty else { return nil }

        // How each LAQ has gone before: the computer's sittings, then this phone's.
        var laqSeen: [String: Int] = [:]
        var laqLast: [String: (Date, Double)] = [:]
        for sitting in snapshot.sittings {
            for r in sitting.responses where r.answerText.trimmingCharacters(in: .whitespacesAndNewlines) != "" || r.mark != nil {
                laqSeen[r.questionId, default: 0] += 1
                if let mark = r.mark, (laqLast[r.questionId]?.0 ?? .distantPast) <= sitting.sittingDate {
                    laqLast[r.questionId] = (sitting.sittingDate, mark)
                }
            }
        }
        for sitting in localSittings { for r in sitting.responses { laqSeen[r.questionId, default: 0] += 1 } }
        var mcqSeen: [String: Int] = [:]
        var mcqLast: [String: Double] = [:]
        let answers = Dictionary((snapshot.mcqs ?? []).map { ($0.id, $0.answer) }, uniquingKeysWith: { first, _ in first })
        for exam in pastExams.sorted(by: { $0.submittedAt < $1.submittedAt }) {
            for item in exam.items where item.kind == "MCQ" {
                guard let id = item.mcqId else { continue }
                mcqSeen[id, default: 0] += 1
                mcqLast[id] = item.choice != nil && item.choice == answers[id] ? 10 : 0
            }
        }

        let scores = Dictionary(lectures.compactMap { l in l.drillScore.map { (l.id, $0) } }, uniquingKeysWith: { first, _ in first })
        let mcqPool = lectures.flatMap { l in mcqs(of: l.id).map { ExamCandidate(id: $0.id, lectureId: l.id, seen: mcqSeen[$0.id] ?? 0, lastMark: mcqLast[$0.id]) } }
        let laqPool = lectures.flatMap { l in laqs(of: l).map { ExamCandidate(id: $0.id, lectureId: l.id, seen: laqSeen[$0.id] ?? 0, lastMark: laqLast[$0.id]?.1) } }
        let pickedMcqs = pickExamItems(mcqPool, count: mcqCount, focus: focus, lectureScore: scores, using: &generator).shuffled(using: &generator)
        let order = Dictionary(lectures.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
        let laqLecture = Dictionary(laqPool.map { ($0.id, $0.lectureId) }, uniquingKeysWith: { first, _ in first })
        let pickedLaqs = pickExamItems(laqPool, count: laqCount, focus: focus, lectureScore: scores, using: &generator)
            .sorted { (order[laqLecture[$0] ?? ""] ?? 0) < (order[laqLecture[$1] ?? ""] ?? 0) }
        guard !pickedMcqs.isEmpty || !pickedLaqs.isEmpty else { return nil }

        let mcqLecture = Dictionary(mcqPool.map { ($0.id, $0.lectureId) }, uniquingKeysWith: { first, _ in first })
        let items = pickedMcqs.map { ExamDraft.Item(id: LockinID.make(prefix: "x"), kind: "MCQ", lectureId: mcqLecture[$0] ?? "", mcqId: $0, questionId: nil, choice: nil, answer: "") }
            + pickedLaqs.map { ExamDraft.Item(id: LockinID.make(prefix: "x"), kind: "LAQ", lectureId: laqLecture[$0] ?? "", mcqId: nil, questionId: $0, choice: nil, answer: "") }
        let codes = Array(Set(lectures.compactMap { l in snapshot.courses.first(where: { $0.id == l.courseId })?.code })).sorted()
        return ExamDraft(
            id: LockinID.make(prefix: "e"),
            title: codes.count <= 3 ? "\(codes.joined(separator: ", ")) exam" : "Exam across \(codes.count) courses",
            startedAt: now,
            timeLimitMin: timeLimitMin,
            items: items
        )
    }
}

extension ExamDraft {
    /// Hands the exam in: long answers become a sitting of each lecture, as on the computer.
    public func handIn(at now: Date = Date()) -> PhoneExam {
        var responseIds: [String: String] = [:]
        var sittings: [PhoneSitting] = []
        var byLecture: [String: [Item]] = [:]
        var lectureOrder: [String] = []
        for item in laqs {
            if byLecture[item.lectureId] == nil { lectureOrder.append(item.lectureId) }
            byLecture[item.lectureId, default: []].append(item)
        }
        for lectureId in lectureOrder {
            let responses = (byLecture[lectureId] ?? []).map { item -> PhoneResponse in
                let id = LockinID.make(prefix: "a")
                responseIds[item.id] = id
                return PhoneResponse(id: id, questionId: item.questionId ?? "",
                                     answerText: item.answer.trimmingCharacters(in: .whitespacesAndNewlines))
            }
            sittings.append(PhoneSitting(id: LockinID.make(prefix: "s"), lectureId: lectureId, startedAt: startedAt, submittedAt: now, responses: responses))
        }
        return PhoneExam(
            id: id,
            title: title,
            startedAt: startedAt,
            submittedAt: now,
            timeLimitMin: timeLimitMin,
            items: items.map { item in
                item.kind == "MCQ"
                    ? PhoneExamItem(id: item.id, kind: "MCQ", mcqId: item.mcqId, choice: item.choice)
                    : PhoneExamItem(id: item.id, kind: "LAQ", questionId: item.questionId, responseId: responseIds[item.id])
            },
            sittings: sittings
        )
    }
}

extension PhoneExam {
    /// Multiple choice right, out of those whose question is still known.
    public func mcqScore(_ mcqs: [Mcq]) -> (right: Int, total: Int) {
        let answers = Dictionary(mcqs.map { ($0.id, $0.answer) }, uniquingKeysWith: { first, _ in first })
        var right = 0
        var total = 0
        for item in items where item.kind == "MCQ" {
            guard let id = item.mcqId, let answer = answers[id] else { continue }
            total += 1
            if item.choice == answer { right += 1 }
        }
        return (right, total)
    }
}
