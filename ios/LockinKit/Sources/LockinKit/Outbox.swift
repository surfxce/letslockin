import Foundation

/// What the phone did, waiting to go to the computer (lib/phone/schema.ts, SyncRequestSchema).
public struct PhoneSitting: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var lectureId: String
    public var startedAt: Date
    public var submittedAt: Date
    public var responses: [PhoneResponse]

    public init(id: String, lectureId: String, startedAt: Date, submittedAt: Date, responses: [PhoneResponse]) {
        self.id = id
        self.lectureId = lectureId
        self.startedAt = startedAt
        self.submittedAt = submittedAt
        self.responses = responses
    }
}

public struct PhoneResponse: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var questionId: String
    public var answerText: String
    /// Marked on the phone with the API key; the computer checks it again before saving.
    public var marking: Marking?
    /// Why marking on the phone didn't work, to show; not sent.
    public var markingError: String?

    public init(id: String, questionId: String, answerText: String, marking: Marking? = nil, markingError: String? = nil) {
        self.id = id
        self.questionId = questionId
        self.answerText = answerText
        self.marking = marking
        self.markingError = markingError
    }

    private enum CodingKeys: String, CodingKey {
        case id, questionId, answerText, marking, markingError
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(questionId, forKey: .questionId)
        try container.encode(answerText, forKey: .answerText)
        try container.encodeIfPresent(marking, forKey: .marking)
        // markingError stays on the phone when sending, but is kept in its own storage.
        if encoder.userInfo[.lockinStorage] as? Bool == true {
            try container.encodeIfPresent(markingError, forKey: .markingError)
        }
    }
}

extension CodingUserInfoKey {
    /// Set when encoding for the phone's own storage rather than for the computer.
    public static let lockinStorage = CodingUserInfoKey(rawValue: "lockinStorage")!
}

/// A marking, as MarkingSchema in lib/llm/schemas.ts.
public struct Marking: Codable, Hashable, Sendable {
    public var mark: Double
    public var criteria: [MarkCriterion]
    public var gaps: [Gap]

    public init(mark: Double, criteria: [MarkCriterion], gaps: [Gap]) {
        self.mark = mark
        self.criteria = criteria
        self.gaps = gaps
    }
}

public struct MarkCriterion: Codable, Hashable, Sendable {
    public var point: String
    public var awarded: Double
    public var outOf: Double
    public var note: String?

    public init(point: String, awarded: Double, outOf: Double, note: String?) {
        self.point = point
        self.awarded = awarded
        self.outOf = outOf
        self.note = note
    }
}

public struct Gap: Codable, Hashable, Sendable {
    public var conceptId: String
    /// "MISSED" or "WRONG".
    public var type: String
    public var text: String

    public init(conceptId: String, type: String, text: String) {
        self.conceptId = conceptId
        self.type = type
        self.text = text
    }
}

public struct CardReview: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var cardId: String
    /// The card version reviewed, so a card reviewed on both devices is counted once.
    public var version: Int
    public var rating: Int
    public var reviewedAt: Date

    public init(id: String, cardId: String, version: Int, rating: Int, reviewedAt: Date) {
        self.id = id
        self.cardId = cardId
        self.version = version
        self.rating = rating
        self.reviewedAt = reviewedAt
    }
}

public struct Device: Codable, Hashable, Sendable {
    public var name: String
    public var app: String

    public init(name: String, app: String) {
        self.name = name
        self.app = app
    }
}

/// An exam sat on the phone (PhoneExamSchema): its multiple choice, marked here, and its
/// long answers as a sitting of each lecture they came from.
public struct PhoneExam: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var startedAt: Date
    public var submittedAt: Date
    public var timeLimitMin: Int?
    public var items: [PhoneExamItem]
    public var sittings: [PhoneSitting]

    public init(id: String, title: String, startedAt: Date, submittedAt: Date, timeLimitMin: Int?, items: [PhoneExamItem], sittings: [PhoneSitting]) {
        self.id = id
        self.title = title
        self.startedAt = startedAt
        self.submittedAt = submittedAt
        self.timeLimitMin = timeLimitMin
        self.items = items
        self.sittings = sittings
    }
}

public struct PhoneExamItem: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    /// "MCQ" or "LAQ".
    public var kind: String
    public var mcqId: String?
    public var choice: Int?
    public var questionId: String?
    public var responseId: String?

    public init(id: String, kind: String, mcqId: String? = nil, choice: Int? = nil, questionId: String? = nil, responseId: String? = nil) {
        self.id = id
        self.kind = kind
        self.mcqId = mcqId
        self.choice = choice
        self.questionId = questionId
        self.responseId = responseId
    }
}

public struct SyncRequest: Codable, Sendable {
    public var device: Device
    public var sittings: [PhoneSitting]
    public var reviews: [CardReview]
    public var exams: [PhoneExam]
    public var vivas: [PhoneViva]

    public init(device: Device, sittings: [PhoneSitting], reviews: [CardReview], exams: [PhoneExam] = [], vivas: [PhoneViva] = []) {
        self.device = device
        self.sittings = sittings
        self.reviews = reviews
        self.exams = exams
        self.vivas = vivas
    }

    private enum CodingKeys: String, CodingKey {
        case device, sittings, reviews, exams, vivas
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        device = try container.decode(Device.self, forKey: .device)
        sittings = try container.decode([PhoneSitting].self, forKey: .sittings)
        reviews = try container.decode([CardReview].self, forKey: .reviews)
        exams = try container.decodeIfPresent([PhoneExam].self, forKey: .exams) ?? []
        vivas = try container.decodeIfPresent([PhoneViva].self, forKey: .vivas) ?? []
    }
}

public struct SyncReply: Decodable, Sendable {
    public struct Accepted: Decodable, Sendable {
        public var sittings: [String]
        public var reviews: [String]
        /// Absent from computers before exam mode.
        public var exams: [String]?
        /// Absent from computers before viva mode.
        public var vivas: [String]?
    }

    public struct ReviewNote: Decodable, Sendable {
        public var id: String
        public var reason: String?
    }

    public var accepted: Accepted
    public var reviews: [ReviewNote]?
    public var problems: [String]?
    public var snapshot: Snapshot
}

public struct HelloReply: Decodable, Sendable {
    public var computer: String
    public var protocolVersion: Int

    private enum CodingKeys: String, CodingKey {
        case computer
        case protocolVersion = "protocol"
    }
}
