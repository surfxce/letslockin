import Foundation

/// Everything the computer sends: lib/phone/schema.ts, PhoneSnapshotSchema, version 1.
public struct Snapshot: Codable, Hashable, Sendable {
    public var v: Int
    public var computer: String
    public var generatedAt: Date
    /// How this phone may mark answers itself; nil when the computer marks them.
    public var marking: MarkingTemplate?
    /// Who marks on the computer ("Claude Code"), or nil in copy-and-paste mode.
    public var computerMarker: String?
    public var courses: [Course]
    public var lectures: [Lecture]
    public var sittings: [Sitting]
    public var cards: [Card]

    public init(v: Int = 1, computer: String, generatedAt: Date, marking: MarkingTemplate?, computerMarker: String?,
                courses: [Course], lectures: [Lecture], sittings: [Sitting], cards: [Card]) {
        self.v = v
        self.computer = computer
        self.generatedAt = generatedAt
        self.marking = marking
        self.computerMarker = computerMarker
        self.courses = courses
        self.lectures = lectures
        self.sittings = sittings
        self.cards = cards
    }
}

public struct Course: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var code: String
    public var title: String
    public var examDate: Date?
}

public struct Lecture: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var courseId: String
    /// L-number within the course.
    public var ordinal: Int
    public var title: String
    public var module: String?
    public var deliveredOn: Date
    /// Rendered as on the computer; pictures are lockin-slide://<lecture>/<n>[?crop=…].
    public var summaryHtml: String?
    public var summaryModel: String?
    /// Pictures the summary and cards show: "<n>" or "<n>?crop=x,y,w,h".
    public var images: [String]
    public var questions: [Question]
    /// The questions a sitting asks now, as the computer picks them.
    public var nextSitting: [String]
    /// As the computer's lecture table shows them (absent from older computers).
    public var drillScore: Double?
    public var sittingCount: Int?
    public var dueAt: Date?
}

public struct Question: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var stem: String
    public var type: String
    public var modelAnswer: String?
    public var criteria: [Criterion]
    public var markVars: MarkVars
}

public struct Criterion: Codable, Hashable, Sendable {
    public var point: String
    public var marks: Double?
}

/// The marking prompt's variables, all but the answer.
public struct MarkVars: Codable, Hashable, Sendable {
    public var questionStem: String
    public var rubric: String
    public var concepts: String
}

public struct Sitting: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var lectureId: String
    public var sittingDate: Date
    public var completedAt: Date?
    public var score: Double?
    public var responses: [SittingResponse]
}

public struct SittingResponse: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var questionId: String
    public var answerText: String
    public var mark: Double?
    /// Waiting in the computer's queue to be marked.
    public var pending: Bool
    public var feedback: [FeedbackItem]
}

public struct FeedbackItem: Codable, Hashable, Sendable {
    /// "good", "wrong", "missed", "note".
    public var kind: String
    public var text: String

    public init(kind: String, text: String) {
        self.kind = kind
        self.text = text
    }
}

public struct Card: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var lectureId: String
    public var frontHtml: String
    public var backHtml: String
    public var state: String
    public var dueAt: Date
    public var intervalDays: Double
    public var ease: Double
    public var repetitions: Int
    public var lapses: Int
    public var version: Int
    public var createdAt: Date
}

/// How to mark an answer with the computer's API key (lib/phone/marking.ts).
public struct MarkingTemplate: Codable, Hashable, Sendable {
    /// "anthropic" or "openai": how to read the reply.
    public var kind: String
    public var label: String
    public var promptVersion: String
    public var prompt: String
    public var request: TemplateRequest
}

public struct TemplateRequest: Codable, Hashable, Sendable {
    public var url: String
    public var headers: [String: String]
    /// With "{{LOCKIN_PROMPT}}" where the filled-in prompt goes.
    public var body: JSONValue
}

/// Dates as the computer writes them (ISO 8601, with or without milliseconds).
public enum LockinJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = parseDate(text) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "not a date: \(text)")
        }
        return decoder
    }

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatDate(date))
        }
        return encoder
    }

    public static func parseDate(_ text: String) -> Date? {
        let withMillis = ISO8601DateFormatter()
        withMillis.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withMillis.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }

    /// "2026-10-23T01:02:03.456Z", as JavaScript's toISOString().
    public static func formatDate(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
