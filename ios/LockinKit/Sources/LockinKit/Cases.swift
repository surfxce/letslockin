import Foundation

/// A clinical case, OSCE-style (lib/cases/schema.ts): a patient presented, then asked
/// about a stage at a time, each stage's findings told before the next. Run as a viva.
public struct PhoneCase: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var courseId: String
    public var title: String
    /// What the student is told first.
    public var presentation: String
    public var stages: [PhoneCaseStage]
}

public struct PhoneCaseStage: Codable, Hashable, Sendable {
    /// Where its answer is filed.
    public var lectureId: String
    /// "history", "examination", "investigations", "diagnosis", "management" or "mechanism".
    public var kind: String
    /// What the examiner asks.
    public var ask: String
    /// What the examiner says once it's answered: what this stage found.
    public var reveal: String
    /// The stage as a question telling the case so far, marked like any LAQ.
    public var question: Question
}

/// A stage as a run of the case keeps it: what to ask, and what to tell after.
public struct CaseStep: Codable, Hashable, Sendable {
    public var questionId: String
    public var kind: String
    public var ask: String
    public var reveal: String

    public init(questionId: String, kind: String, ask: String, reveal: String) {
        self.questionId = questionId
        self.kind = kind
        self.ask = ask
        self.reveal = reveal
    }
}

/// "History", "Investigations"… as the computer names the stages.
public func stageLabel(_ kind: String) -> String {
    switch kind {
    case "history": return "History"
    case "examination": return "Examination"
    case "investigations": return "Investigations"
    case "diagnosis": return "Diagnosis"
    case "management": return "Management"
    case "mechanism": return "Mechanism"
    default: return kind.capitalized
    }
}

extension PhoneCase {
    /// Starts a run of the case: the presentation and the first stage's question at once.
    public func makeRun(now: Date = Date()) -> VivaDraft? {
        guard let first = stages.first else { return nil }
        return VivaDraft(
            id: LockinID.make(prefix: "v"),
            title: title,
            startedAt: now,
            plan: stages.map { VivaPlanItem(questionId: $0.question.id, lectureId: $0.lectureId) },
            turns: [VivaLine(role: "examiner", text: "\(presentation)\n\n\(first.ask)", questionId: first.question.id, at: now)],
            current: 0,
            probes: 0,
            caseId: id,
            steps: stages.map { CaseStep(questionId: $0.question.id, kind: $0.kind, ask: $0.ask, reveal: $0.reveal) }
        )
    }
}
