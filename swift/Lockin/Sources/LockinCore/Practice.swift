import Foundation
import GRDB

public struct PracticeAnswer: Identifiable, Sendable {
    public var id: String { response.id }
    public var response: Response
    public var question: Question
    public var number: Int
    public var gaps: [Gap]
    public var conceptNames: [String: String]
    public var feedback: [ParsedFeedback] {
        let data = response.rawMarkingJson.flatMap { try? JSONValue.parse($0) }
        if let items = data?["feedback"]?.arrayValue {
            return items.compactMap { item in
                guard let kind = item["kind"]?.stringValue.flatMap(FeedbackKind.init(rawValue:)),
                      let text = item["text"]?.stringValue else { return nil }
                return ParsedFeedback(kind: kind, text: text)
            }
        }
        var items = gaps.map { ParsedFeedback(kind: $0.type == .wrong ? .wrong : .missed, text: $0.text) }
        for criterion in data?["criteria"]?.arrayValue ?? [] {
            let awarded = criterion["awarded"]?.numberValue ?? 0
            let total = criterion["outOf"]?.numberValue ?? 0
            let point = criterion["point"]?.stringValue ?? ""
            if total > 0 && awarded >= total { items.append(.init(kind: .good, text: point)) }
            else if awarded > 0, let note = criterion["note"]?.stringValue, !note.isEmpty {
                items.append(.init(kind: .note, text: "\(point) — \(note)"))
            }
        }
        return items
    }
    public var guide: [String] {
        ((try? JSONValue.parse(question.rubric))?["criteria"]?.arrayValue ?? [])
            .compactMap { $0["point"]?.stringValue }
    }
}

public struct PracticeSnapshot: Sendable {
    public var attempt: Attempt
    public var lecture: Lecture
    public var answers: [PracticeAnswer]
    public var jobs: [Job]
    public var review: ScheduledReview
    public var submitted: Bool {
        attempt.completedAt != nil || answers.contains { !$0.response.answerText.isEmpty || $0.response.mark != nil }
    }
}

public func practiceSnapshot(db: Database, attemptId: String) throws -> PracticeSnapshot {
    guard let attempt = try Attempt.fetchOne(db, key: attemptId),
          let lecture = try Lecture.fetchOne(db, key: attempt.lectureId) else { throw LockinError("This sitting no longer exists.") }
    let numbers = try questionNumbers(db: db, lectureId: lecture.id)
    let answers = try Response.filter(Column("attemptId") == attemptId).fetchAll(db).map { response -> PracticeAnswer in
        guard let question = try Question.fetchOne(db, key: response.questionId) else { throw LockinError("Question no longer exists.") }
        let gaps = try Gap.filter(Column("responseId") == response.id).fetchAll(db)
        let concepts = try Concept.filter(gaps.map(\.conceptId).contains(Column("id"))).fetchAll(db)
        return PracticeAnswer(response: response, question: question, number: numbers[question.id] ?? 0,
                              gaps: gaps, conceptNames: Dictionary(uniqueKeysWithValues: concepts.map { ($0.id, $0.name) }))
    }.sorted { $0.number < $1.number }
    let ids = Set(answers.map(\.id))
    let jobs = try Job.filter(Column("lectureId") == lecture.id && Column("kind") == JobKind.mark.rawValue).fetchAll(db)
        .filter { ids.contains((try? JSONValue.parse($0.payload))?["responseId"]?.stringValue ?? "") }
    let sittings = try Attempt.filter(Column("lectureId") == lecture.id).fetchAll(db)
        .compactMap { attempt in attempt.geometricMean.map { Sitting(at: attempt.sittingDate, score: $0) } }
    let course = try Course.fetchOne(db, key: lecture.courseId)
    return PracticeSnapshot(attempt: attempt, lecture: lecture, answers: answers, jobs: jobs,
                            review: nextReview(sittings: sittings, readySince: answers.map { $0.question.createdAt }.min(), examDate: course?.examDate))
}

/// Call inside a writer transaction: resume and creation cannot race another window.
public func startPractice(db: Database, lectureId: String, now: Date = Date()) throws -> String {
    let open = try Attempt.filter(Column("lectureId") == lectureId && Column("source") == AttemptSource.app.rawValue)
        .order(Column("sittingDate").desc).fetchAll(db)
    for attempt in open where attempt.sittingDate >= now.addingTimeInterval(-14 * 86_400) && attempt.completedAt == nil {
        let rows = try Response.filter(Column("attemptId") == attempt.id).fetchAll(db)
        if !rows.isEmpty && rows.allSatisfy({ $0.answerText.isEmpty && $0.mark == nil }) { return attempt.id }
    }
    let ids = try pickQuestions(db, lectureId: lectureId, sittingPerHour: Double(getSettings(db: db).sittingPerHour))
    guard !ids.isEmpty else { throw LockinError("This lecture has no LAQs yet.") }
    var attempt = Attempt(lectureId: lectureId, sittingDate: now)
    try attempt.insert(db)
    for id in ids {
        var response = Response(attemptId: attempt.id, questionId: id, answerText: "")
        try response.insert(db)
    }
    return attempt.id
}

public func savePracticeDraft(db: Database, responseId: String, text: String) throws {
    guard let response = try Response.fetchOne(db, key: responseId) else { throw LockinError("Answer no longer exists.") }
    let answered = try Response.filter(Column("attemptId") == response.attemptId)
        .filter(Column("answerText") != "" || Column("mark") != nil).fetchCount(db)
    let attempt = try Attempt.fetchOne(db, key: response.attemptId)
    guard answered == 0 && attempt?.completedAt == nil else { throw LockinError("This sitting has already been submitted.") }
    try db.execute(sql: #"UPDATE "Response" SET "draftText" = ? WHERE "id" = ?"#, arguments: [String(text.prefix(50_000)), responseId])
}

/// Answers, blank marks and jobs commit together. Repeated submission is a no-op.
public func submitPractice(db: Database, attemptId: String, answers: [String: String], now: Date = Date()) throws {
    let snapshot = try practiceSnapshot(db: db, attemptId: attemptId)
    guard !snapshot.submitted else { return }
    let texts = snapshot.answers.map { String((answers[$0.id] ?? $0.response.draftText ?? "").prefix(50_000)).trimmingCharacters(in: .whitespacesAndNewlines) }
    guard texts.contains(where: { !$0.isEmpty }) else { throw LockinError("Answer at least one question first.") }
    let manual = try getSettings(db: db).mode == .manual
    for (item, text) in zip(snapshot.answers, texts) {
        var response = item.response
        response.answerText = text
        response.draftText = nil
        if text.isEmpty {
            response.mark = 0
            response.markedAt = now
            response.rawMarkingJson = #"{"source":"blank","feedback":[{"kind":"missed","text":"Left blank."}]}"#
        }
        try response.update(db)
        if !text.isEmpty && !manual {
            try enqueue(db: db, kind: .mark, payload: ["responseId": .string(response.id)], lectureId: snapshot.lecture.id, now: now)
        }
    }
    try scoreAttemptIfMarked(db: db, attemptId: attemptId, now: now)
}

public struct PracticeNotes: Sendable {
    public var markdown: String
    public var plain: String
    public var count: Int
}

/// Corrections are taken from the marking itself; no extra model call.
public func practiceNotes(_ snapshot: PracticeSnapshot) -> PracticeNotes {
    var groups: [(heading: String, points: [(String, String)])] = []
    func add(_ heading: String, _ symbol: String, _ text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        if let i = groups.firstIndex(where: { $0.heading.lowercased() == heading.lowercased() }) { groups[i].points.append((symbol, clean)) }
        else { groups.append((heading, [(symbol, clean)])) }
    }
    for item in snapshot.answers where item.response.mark != nil {
        let heading = "LAQ \(item.number)"
        for feedback in item.feedback where feedback.kind == .note && (item.response.mark ?? 10) < 10 {
            if feedback.text.range(of: #"^(good|great|well done|nice|excellent|correct|accurate|covered)\b"#, options: [.regularExpression, .caseInsensitive]) == nil {
                add(heading, "~", feedback.text)
            }
        }
        if !item.gaps.isEmpty {
            for gap in item.gaps { add(item.conceptNames[gap.conceptId] ?? heading, gap.type == .wrong ? "✗" : "+", gap.text) }
        } else if (try? JSONValue.parse(item.response.rawMarkingJson ?? ""))?["source"]?.stringValue == "blank" {
            for point in item.guide.isEmpty ? ["Left blank — learn this one from the marking guide."] : item.guide { add(heading, "+", point) }
        } else {
            for feedback in item.feedback where feedback.kind == .wrong || feedback.kind == .missed {
                add(heading, feedback.kind == .wrong ? "✗" : "+", feedback.text)
            }
        }
    }
    var seen = Set<String>(), markdown = "", plain = "", count = 0
    for group in groups {
        var md: [String] = [], txt: [String] = []
        for (symbol, text) in group.points {
            let key = plainInline(text).folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
                .unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined()
            guard !key.isEmpty && seen.insert(key).inserted else { continue }
            md.append("- \(symbol == "✗" ? symbol : "\\" + symbol) \(text)")
            txt.append("\(symbol) \(plainInline(text))")
            count += 1
        }
        if !md.isEmpty {
            markdown += "\n### \(group.heading)\n\n" + md.joined(separator: "\n") + "\n"
            plain += "\n\(group.heading)\n" + txt.joined(separator: "\n") + "\n"
        }
    }
    if count > 0 {
        let title = "Notes to copy — \(snapshot.lecture.title), \(longDate(snapshot.attempt.sittingDate))"
        markdown = "## \(title)\n" + markdown
        plain = title + "\n" + plain
    }
    return PracticeNotes(markdown: markdown, plain: plain, count: count)
}
