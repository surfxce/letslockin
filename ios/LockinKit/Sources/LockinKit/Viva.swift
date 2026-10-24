import Foundation

/// Follow-ups the examiner may ask on one question before moving on (lib/viva/schema.ts).
public let vivaMaxProbes = 2

/// One thing said in a viva.
public struct VivaLine: Codable, Hashable, Sendable {
    /// "examiner" or "student".
    public var role: String
    public var text: String
    /// The question it belongs to; empty for the viva's closing line.
    public var questionId: String
    public var at: Date

    public init(role: String, text: String, questionId: String, at: Date) {
        self.role = role
        self.text = text
        self.questionId = questionId
        self.at = at
    }
}

public struct VivaPlanItem: Codable, Hashable, Sendable {
    public var questionId: String
    public var lectureId: String
    /// The answer it became when the viva was handed in.
    public var responseId: String?

    public init(questionId: String, lectureId: String, responseId: String? = nil) {
        self.questionId = questionId
        self.lectureId = lectureId
        self.responseId = responseId
    }
}

/// What the examiner does after an answer (VivaMoveSchema): "probe" asks a follow-up;
/// "next" closes the question.
public struct VivaMove: Codable, Hashable, Sendable {
    public var move: String
    public var say: String

    public init(move: String, say: String) {
        self.move = move
        self.say = say
    }
}

/// A viva held on the phone (PhoneVivaSchema): everything said, and each question's
/// answers as a sitting of its lecture.
public struct PhoneViva: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var startedAt: Date
    public var submittedAt: Date
    public var plan: [VivaPlanItem]
    public var turns: [VivaLine]
    public var sittings: [PhoneSitting]
    /// Set when it ran a clinical case.
    public var caseId: String? = nil
}

/// A viva being held on the phone, kept as it goes (as lib/viva/service.ts runs one).
public struct VivaDraft: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var startedAt: Date
    public var plan: [VivaPlanItem]
    public var turns: [VivaLine]
    /// Index into `plan` of the question being asked; `plan.count` once it's over.
    public var current: Int
    /// Follow-ups asked on the current question.
    public var probes: Int
    /// Set when it runs a clinical case: its stages, in plan order.
    public var caseId: String? = nil
    public var steps: [CaseStep]? = nil

    public var item: VivaPlanItem? { current < plan.count ? plan[current] : nil }

    /// The stage being asked, when it runs a case.
    public var step: CaseStep? { item.flatMap { item in steps?.first { $0.questionId == item.questionId } } }
    public var isOver: Bool { current >= plan.count }

    /// One question's exchange so far, the question itself first.
    public func exchange(_ questionId: String) -> [VivaLine] { turns.filter { $0.questionId == questionId } }

    /// Follow-ups the examiner may still ask on this question.
    public var probesLeft: Int { max(0, vivaMaxProbes - probes) }

    /// The student's answer. False when there's no question to answer.
    @discardableResult
    public mutating func answer(_ text: String, at now: Date = Date()) -> Bool {
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let item, !said.isEmpty else { return false }
        turns.append(VivaLine(role: "student", text: String(said.prefix(8000)), questionId: item.questionId, at: now))
        return true
    }

    /// What the examiner said: a follow-up stays on the question while any are left;
    /// anything else closes it and puts the next one, by its stem.
    public mutating func examiner(_ move: VivaMove, stem: (String) -> String?, at now: Date = Date()) {
        guard let item else { return }
        if move.move == "probe", probes < vivaMaxProbes {
            turns.append(VivaLine(role: "examiner", text: move.say, questionId: item.questionId, at: now))
            probes += 1
        } else {
            moveOn(closing: move.say, stem: stem, at: now)
        }
    }

    /// Closes the current question and puts the next, or ends the viva. A case says what
    /// the stage found first, then asks the next stage.
    public mutating func moveOn(closing: String, stem: (String) -> String?, at now: Date = Date()) {
        guard let item else { return }
        let line = closing.trimmingCharacters(in: .whitespacesAndNewlines)
        if !line.isEmpty { turns.append(VivaLine(role: "examiner", text: line, questionId: item.questionId, at: now)) }
        if let reveal = step?.reveal, !reveal.isEmpty {
            turns.append(VivaLine(role: "examiner", text: reveal, questionId: item.questionId, at: now))
        }
        current += 1
        probes = 0
        if let next = self.item {
            let text: String
            if let steps {
                text = steps.first { $0.questionId == next.questionId }?.ask ?? "(This stage is no longer on the computer — say anything to move on.)"
            } else {
                text = stem(next.questionId).map { "Next question. \($0)" } ?? "Next question. (This question is no longer on the computer — say anything to move on.)"
            }
            turns.append(VivaLine(role: "examiner", text: text, questionId: next.questionId, at: now))
        } else {
            let end = steps == nil ? "That's the end of the viva." : "That's the end of the case."
            turns.append(VivaLine(role: "examiner", text: "\(end) Thank you — your answers will be marked.", questionId: "", at: now))
        }
    }

    /// Ends it early: what was asked is marked; what wasn't is left out.
    public mutating func end(at now: Date = Date()) {
        guard !isOver else { return }
        plan = Array(plan.prefix(current + 1))
        current = plan.count
        probes = 0
        turns.append(VivaLine(role: "examiner", text: "We'll stop there. Thank you — your answers will be marked.", questionId: "", at: now))
    }

    /// Hands it in: each question's exchange becomes an answer in a sitting of its lecture.
    /// A question asked and never answered goes in blank, which scores 0.
    public func handIn(at now: Date = Date()) -> PhoneViva {
        var plan = self.plan
        var byLecture: [String: [Int]] = [:]
        var lectureOrder: [String] = []
        for (index, item) in plan.enumerated() {
            if byLecture[item.lectureId] == nil { lectureOrder.append(item.lectureId) }
            byLecture[item.lectureId, default: []].append(index)
        }
        var sittings: [PhoneSitting] = []
        for lectureId in lectureOrder {
            let responses = (byLecture[lectureId] ?? []).map { index -> PhoneResponse in
                let id = LockinID.make(prefix: "a")
                plan[index].responseId = id
                return PhoneResponse(id: id, questionId: plan[index].questionId, answerText: vivaAnswerText(exchange(plan[index].questionId)))
            }
            sittings.append(PhoneSitting(id: LockinID.make(prefix: "s"), lectureId: lectureId, startedAt: startedAt, submittedAt: now, responses: responses))
        }
        return PhoneViva(id: id, title: title, startedAt: startedAt, submittedAt: now, plan: plan, turns: turns, sittings: sittings, caseId: caseId)
    }
}

/// One question's exchange as the answer that is marked (lib/viva/schema.ts, vivaAnswerText):
/// from the first answer to the last, the examiner's follow-ups between.
public func vivaAnswerText(_ exchange: [VivaLine]) -> String {
    let said = exchange.contains { $0.role == "student" && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    guard said,
          let first = exchange.firstIndex(where: { $0.role == "student" }),
          let last = exchange.lastIndex(where: { $0.role == "student" })
    else { return "" }
    let lines = exchange[first...last].map { "\($0.role == "examiner" ? "Examiner" : "Student"): \($0.text.trimmingCharacters(in: .whitespacesAndNewlines))" }
    return (["(Answered out loud in a viva. The examiner's follow-up questions are shown between the student's answers; credit what the student said in any of them.)"] + lines)
        .joined(separator: "\n\n")
}

extension ExamSource {
    /// Starts a viva: a few of the chosen lectures' LAQs, spread across them (or weak
    /// spots first), the first one put at once.
    public func makeViva<G: RandomNumberGenerator>(
        lectureIds: Set<String>, questions count: Int, focus: ExamFocus, now: Date = Date(), using generator: inout G
    ) -> VivaDraft? {
        let lectures = snapshot.lectures.filter { lectureIds.contains($0.id) }
        let (seen, last) = laqHistory()
        let scores = Dictionary(lectures.compactMap { l in l.drillScore.map { (l.id, $0) } }, uniquingKeysWith: { first, _ in first })
        let pool = lectures.flatMap { l in
            laqs(of: l).map { ExamCandidate(id: $0.id, lectureId: l.id, seen: seen[$0.id] ?? 0, lastMark: last[$0.id]?.1) }
        }
        let picked = pickExamItems(pool, count: max(1, min(12, count)), focus: focus, lectureScore: scores, using: &generator)
        let lectureOf = Dictionary(pool.map { ($0.id, $0.lectureId) }, uniquingKeysWith: { first, _ in first })
        let stems = Dictionary(lectures.flatMap(\.questions).map { ($0.id, $0.stem) }, uniquingKeysWith: { first, _ in first })
        guard let first = picked.first, let stem = stems[first] else { return nil }
        let codes = Array(Set(lectures.compactMap { l in snapshot.courses.first(where: { $0.id == l.courseId })?.code })).sorted()
        return VivaDraft(
            id: LockinID.make(prefix: "v"),
            title: codes.count <= 3 ? "\(codes.joined(separator: ", ")) viva" : "Viva across \(codes.count) courses",
            startedAt: now,
            plan: picked.map { VivaPlanItem(questionId: $0, lectureId: lectureOf[$0] ?? "") },
            turns: [VivaLine(role: "examiner", text: "Let's begin. \(stem)", questionId: first, at: now)],
            current: 0,
            probes: 0
        )
    }
}

/// The examiner prompt for one turn, filled as lib/viva/schema.ts (vivaVars) fills it.
public func vivaPrompt(_ template: MarkingTemplate, lectureTitle: String, question: Question, exchange: [VivaLine], probesLeft: Int) -> String {
    let criteria = question.criteria.map { "- (\(formatMark($0.marks ?? 0))) \($0.point)" }.joined(separator: "\n")
    return fillPrompt(template.prompt, [
        "lectureTitle": lectureTitle,
        "question": question.stem,
        "modelAnswer": question.modelAnswer ?? "(none written)",
        "criteria": criteria.isEmpty ? "(none)" : criteria,
        "exchange": exchange.map { "\($0.role == "examiner" ? "Examiner" : "Student"): \($0.text)" }.joined(separator: "\n\n"),
        "probesLeft": String(probesLeft),
    ])
}

/// A move that satisfies VivaMoveSchema, or why not.
public func decodeVivaMove(_ text: String) throws -> VivaMove {
    let move: VivaMove
    do {
        move = try JSONDecoder().decode(VivaMove.self, from: try extractJSON(text))
    } catch let error as MarkingError {
        throw error
    } catch {
        throw MarkingError.unreadable("it didn't have the move and what to say")
    }
    let say = move.say.trimmingCharacters(in: .whitespacesAndNewlines)
    guard move.move == "probe" || move.move == "next", !say.isEmpty else {
        throw MarkingError.unreadable("the move must be probe or next, with something to say")
    }
    return VivaMove(move: move.move, say: String(say.prefix(600)))
}

/// Asks the examiner with the computer's API key, as marking does. One unreadable reply is asked again.
public func askExaminer(template: MarkingTemplate, lectureTitle: String, question: Question, exchange: [VivaLine], probesLeft: Int,
                        sender: HTTPSending = URLSessionSender()) async throws -> VivaMove {
    let prompt = vivaPrompt(template, lectureTitle: lectureTitle, question: question, exchange: exchange, probesLeft: probesLeft)
    func attempt(_ extra: String) async throws -> VivaMove {
        let request = try markingRequest(template, prompt: prompt + extra)
        let (data, status): (Data, Int)
        do {
            (data, status) = try await sender.send(request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            let service = template.label.components(separatedBy: " · ").first ?? template.label
            throw MarkingError.service("Couldn't reach \(service): \(error.localizedDescription)")
        }
        return try decodeVivaMove(try replyText(kind: template.kind, label: template.label, status: status, data: data))
    }
    do {
        return try await attempt("")
    } catch MarkingError.unreadable(let why) {
        return try await attempt("\n\nYour previous reply could not be used: \(why)\n"
            + "Reply again with valid JSON matching the schema exactly. No prose, no code fences.")
    }
}
