import Foundation
import GRDB

// MARK: - CUID generator

public enum Cuid {
    private static let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")

    public static func generate() -> String {
        let ts = String(Int64(Date().timeIntervalSince1970 * 1000), radix: 36)
        var tail = ""
        tail.reserveCapacity(16)
        for _ in 0..<16 {
            tail.append(alphabet[Int.random(in: 0..<alphabet.count)])
        }
        return "c" + ts + tail
    }
}

// MARK: - Prisma / SQLite Date coding

/// Prisma's `@prisma/adapter-better-sqlite3` writes dates as ISO-8601 strings with
/// milliseconds and `+00:00` (e.g. `2026-10-12T05:44:02.278+00:00`), while SQLite's
/// `CURRENT_TIMESTAMP` writes `2026-10-12 05:44:02`. This strategy reads both (plus
/// `Z` suffixes and numeric epoch timestamps) and writes Prisma's exact format so both
/// apps can share `lockin.db` at the same time.
public enum PrismaDate {
    public static func decode(_ dbValue: DatabaseValue) -> Date? {
        switch dbValue.storage {
        case .int64(let ms):
            // Heuristic: values > 10^11 are milliseconds, smaller are seconds.
            let seconds = ms > 100_000_000_000 ? Double(ms) / 1000.0 : Double(ms)
            return Date(timeIntervalSince1970: seconds)
        case .double(let val):
            let seconds = val > 100_000_000_000 ? val / 1000.0 : val
            return Date(timeIntervalSince1970: seconds)
        case .string(let raw):
            return parseString(raw)
        default:
            return nil
        }
    }

    public static func encode(_ date: Date) -> DatabaseValue {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'+00:00'"
        return formatter.string(from: date).databaseValue
    }

    public static func parseString(_ raw: String) -> Date? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }

        let isoFrac = ISO8601DateFormatter()
        isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = isoFrac.date(from: trimmed) { return d }

        let isoPlain = ISO8601DateFormatter()
        isoPlain.formatOptions = [.withInternetDateTime]
        if let d = isoPlain.date(from: trimmed) { return d }

        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(secondsFromGMT: 0)
        for fmt in [
            "yyyy-MM-dd HH:mm:ss.SSS",
            "yyyy-MM-dd HH:mm:ss",
            "yyyy-MM-dd'T'HH:mm:ss.SSS",
            "yyyy-MM-dd'T'HH:mm:ss",
            "yyyy-MM-dd",
        ] {
            df.dateFormat = fmt
            if let d = df.date(from: trimmed) { return d }
        }
        return nil
    }
}

public protocol LockinRecord: Codable, FetchableRecord, MutablePersistableRecord, Equatable, Sendable {}

extension LockinRecord {
    public static func databaseDateDecodingStrategy(for column: String) -> DatabaseDateDecodingStrategy {
        .custom { PrismaDate.decode($0) }
    }

    public static var databaseDateEncodingStrategy: DatabaseDateEncodingStrategy {
        .custom { PrismaDate.encode($0) }
    }
}

// MARK: - Open string types mirroring lib/types.ts (tolerate unknown/future values)

public protocol LockinStringKind: RawRepresentable, Codable, DatabaseValueConvertible, Hashable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible where RawValue == String {}

extension LockinStringKind {
    public init(stringLiteral value: String) {
        self.init(rawValue: value)!
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        self.init(rawValue: raw)!
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var databaseValue: DatabaseValue {
        rawValue.databaseValue
    }

    public static func fromDatabaseValue(_ dbValue: DatabaseValue) -> Self? {
        guard let raw = String.fromDatabaseValue(dbValue) else { return nil }
        return Self(rawValue: raw)
    }

    public var description: String { rawValue }
}

public struct MaterialKind: LockinStringKind, Hashable {
    public var rawValue: String
    public init?(rawValue: String) { self.rawValue = rawValue }

    public static let transcript = MaterialKind(rawValue: "TRANSCRIPT")!
    public static let slides = MaterialKind(rawValue: "SLIDES")!
    public static let figure = MaterialKind(rawValue: "FIGURE")!
    public static let pastPaper = MaterialKind(rawValue: "PAST_PAPER")!
    public static let allKnown: [MaterialKind] = [.transcript, .slides, .figure, .pastPaper]
}

public struct QuestionType: LockinStringKind, Hashable {
    public var rawValue: String
    public init?(rawValue: String) { self.rawValue = rawValue }

    public static let laq = QuestionType(rawValue: "LAQ")!
    public static let saq = QuestionType(rawValue: "SAQ")!
    public static let allKnown: [QuestionType] = [.laq, .saq]
}

public struct GapType: LockinStringKind, Hashable {
    public var rawValue: String
    public init?(rawValue: String) { self.rawValue = rawValue }

    public static let missed = GapType(rawValue: "MISSED")!
    public static let wrong = GapType(rawValue: "WRONG")!
    public static let allKnown: [GapType] = [.missed, .wrong]
}

public struct JobKind: LockinStringKind, Hashable {
    public var rawValue: String
    public init?(rawValue: String) { self.rawValue = rawValue }

    public static let prepare = JobKind(rawValue: "PREPARE")!
    public static let generate = JobKind(rawValue: "GENERATE")!
    public static let mark = JobKind(rawValue: "MARK")!
    public static let download = JobKind(rawValue: "DOWNLOAD")!
    public static let sort = JobKind(rawValue: "SORT")!
    public static let ask = JobKind(rawValue: "ASK")!
    public static let sideLanes: [JobKind] = [.download, .sort, .ask]
    public static let allKnown: [JobKind] = [.prepare, .generate, .mark, .download, .sort, .ask]
}

public struct JobStatus: LockinStringKind, Hashable {
    public var rawValue: String
    public init?(rawValue: String) { self.rawValue = rawValue }

    public static let pending = JobStatus(rawValue: "PENDING")!
    public static let running = JobStatus(rawValue: "RUNNING")!
    public static let done = JobStatus(rawValue: "DONE")!
    public static let failed = JobStatus(rawValue: "FAILED")!
    public static let allKnown: [JobStatus] = [.pending, .running, .done, .failed]
}

public struct Stage: LockinStringKind, Hashable {
    public var rawValue: String
    public init?(rawValue: String) { self.rawValue = rawValue }

    public static let slides = Stage(rawValue: "slides")!
    public static let vision = Stage(rawValue: "vision")!
    public static let digest = Stage(rawValue: "digest")!
    public static let questions = Stage(rawValue: "questions")!
    public static let marking = Stage(rawValue: "marking")!
    public static let download = Stage(rawValue: "download")!

    public var label: String {
        switch rawValue {
        case "slides": return "Reading slide pictures"
        case "vision": return "Looking at the slides"
        case "digest": return "Reading & summarising"
        case "questions": return "Writing LAQs"
        case "marking": return "Marking"
        case "download": return "Downloading model"
        default: return rawValue
        }
    }
}

public struct AttemptSource: LockinStringKind, Hashable {
    public var rawValue: String
    public init?(rawValue: String) { self.rawValue = rawValue }

    public static let app = AttemptSource(rawValue: "APP")!
    public static let pasted = AttemptSource(rawValue: "PASTED")!
    public static let allKnown: [AttemptSource] = [.app, .pasted]
}

// MARK: - Database Models (prisma/schema.prisma)

public struct Course: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Course"

    public var id: String
    public var code: String
    public var title: String
    public var examDate: Date?
    public var weighting: Double?
    public var createdAt: Date

    public init(
        id: String = Cuid.generate(),
        code: String,
        title: String,
        examDate: Date? = nil,
        weighting: Double? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.code = code
        self.title = title
        self.examDate = examDate
        self.weighting = weighting
        self.createdAt = createdAt
    }
}

public struct Module: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Module"

    public var id: String
    public var courseId: String
    public var title: String
    public var position: Int
    public var createdAt: Date

    public init(
        id: String = Cuid.generate(),
        courseId: String,
        title: String,
        position: Int = 0,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.courseId = courseId
        self.title = title
        self.position = position
        self.createdAt = createdAt
    }
}

public struct Lecture: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Lecture"

    public var id: String
    public var courseId: String
    public var moduleId: String?
    public var title: String
    public var deliveredOn: Date
    public var durationHours: Double
    public var summaryMd: String?
    public var autoTitle: Bool
    public var skipped: String?
    public var slideNotes: String?
    public var summaryModel: String?
    public var createdAt: Date

    public init(
        id: String = Cuid.generate(),
        courseId: String,
        moduleId: String? = nil,
        title: String,
        deliveredOn: Date = Date(),
        durationHours: Double = 1,
        summaryMd: String? = nil,
        autoTitle: Bool = false,
        skipped: String? = nil,
        slideNotes: String? = nil,
        summaryModel: String? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.courseId = courseId
        self.moduleId = moduleId
        self.title = title
        self.deliveredOn = deliveredOn
        self.durationHours = durationHours
        self.summaryMd = summaryMd
        self.autoTitle = autoTitle
        self.skipped = skipped
        self.slideNotes = slideNotes
        self.summaryModel = summaryModel
        self.createdAt = createdAt
    }
}

public struct GlossaryTerm: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "GlossaryTerm"

    public var id: String
    public var lectureId: String
    public var term: String
    public var explanation: String
    public var createdAt: Date

    public init(
        id: String = Cuid.generate(),
        lectureId: String,
        term: String,
        explanation: String,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.lectureId = lectureId
        self.term = term
        self.explanation = explanation
        self.createdAt = createdAt
    }
}

public struct Material: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Material"

    public var id: String
    public var courseId: String?
    public var lectureId: String?
    public var kind: MaterialKind
    public var path: String
    public var originalName: String
    public var extractedText: String?
    public var pageCount: Int?
    public var checksum: String
    public var createdAt: Date

    public init(
        id: String = Cuid.generate(),
        courseId: String? = nil,
        lectureId: String? = nil,
        kind: MaterialKind,
        path: String,
        originalName: String,
        extractedText: String? = nil,
        pageCount: Int? = nil,
        checksum: String,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.courseId = courseId
        self.lectureId = lectureId
        self.kind = kind
        self.path = path
        self.originalName = originalName
        self.extractedText = extractedText
        self.pageCount = pageCount
        self.checksum = checksum
        self.createdAt = createdAt
    }
}

public struct Concept: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Concept"

    public var id: String
    public var courseId: String
    public var lectureId: String?
    public var name: String
    public var definition: String
    public var sourceRef: String?
    public var mergedIntoId: String?
    public var createdAt: Date

    public init(
        id: String = Cuid.generate(),
        courseId: String,
        lectureId: String? = nil,
        name: String,
        definition: String,
        sourceRef: String? = nil,
        mergedIntoId: String? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.courseId = courseId
        self.lectureId = lectureId
        self.name = name
        self.definition = definition
        self.sourceRef = sourceRef
        self.mergedIntoId = mergedIntoId
        self.createdAt = createdAt
    }
}

public struct Question: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Question"

    public var id: String
    public var lectureId: String
    public var stem: String
    public var type: QuestionType
    public var rubric: String
    public var promptVersion: String
    public var model: String?
    public var createdAt: Date

    public init(
        id: String = Cuid.generate(),
        lectureId: String,
        stem: String,
        type: QuestionType = .laq,
        rubric: String,
        promptVersion: String,
        model: String? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.lectureId = lectureId
        self.stem = stem
        self.type = type
        self.rubric = rubric
        self.promptVersion = promptVersion
        self.model = model
        self.createdAt = createdAt
    }
}

public struct QuestionConcept: LockinRecord, Equatable {
    public static let databaseTableName = "QuestionConcept"

    public var questionId: String
    public var conceptId: String

    public init(questionId: String, conceptId: String) {
        self.questionId = questionId
        self.conceptId = conceptId
    }
}

public struct Attempt: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Attempt"

    public var id: String
    public var lectureId: String
    public var sittingDate: Date
    public var closedBook: Bool
    public var geometricMean: Double?
    public var completedAt: Date?
    public var source: AttemptSource

    public init(
        id: String = Cuid.generate(),
        lectureId: String,
        sittingDate: Date = Date(),
        closedBook: Bool = true,
        geometricMean: Double? = nil,
        completedAt: Date? = nil,
        source: AttemptSource = .app
    ) {
        self.id = id
        self.lectureId = lectureId
        self.sittingDate = sittingDate
        self.closedBook = closedBook
        self.geometricMean = geometricMean
        self.completedAt = completedAt
        self.source = source
    }
}

public struct Response: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Response"

    public var id: String
    public var attemptId: String
    public var questionId: String
    public var answerText: String
    public var draftText: String?
    public var mark: Double?
    public var rubricVersion: String?
    public var rawMarkingJson: String?
    public var markedAt: Date?

    public init(
        id: String = Cuid.generate(),
        attemptId: String,
        questionId: String,
        answerText: String,
        draftText: String? = nil,
        mark: Double? = nil,
        rubricVersion: String? = nil,
        rawMarkingJson: String? = nil,
        markedAt: Date? = nil
    ) {
        self.id = id
        self.attemptId = attemptId
        self.questionId = questionId
        self.answerText = answerText
        self.draftText = draftText
        self.mark = mark
        self.rubricVersion = rubricVersion
        self.rawMarkingJson = rawMarkingJson
        self.markedAt = markedAt
    }
}

public struct Gap: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Gap"

    public var id: String
    public var responseId: String
    public var conceptId: String
    public var type: GapType
    public var text: String
    public var createdAt: Date

    public init(
        id: String = Cuid.generate(),
        responseId: String,
        conceptId: String,
        type: GapType,
        text: String,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.responseId = responseId
        self.conceptId = conceptId
        self.type = type
        self.text = text
        self.createdAt = createdAt
    }
}

public struct Review: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Review"

    public var id: String
    public var conceptId: String
    public var dueOn: Date
    public var intervalDays: Double
    public var setByAttemptId: String?
    public var completedAt: Date?

    public init(
        id: String = Cuid.generate(),
        conceptId: String,
        dueOn: Date,
        intervalDays: Double,
        setByAttemptId: String? = nil,
        completedAt: Date? = nil
    ) {
        self.id = id
        self.conceptId = conceptId
        self.dueOn = dueOn
        self.intervalDays = intervalDays
        self.setByAttemptId = setByAttemptId
        self.completedAt = completedAt
    }
}

public struct PastPaper: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "PastPaper"

    public var id: String
    public var courseId: String
    public var year: Int
    public var label: String?
    public var materialId: String?
    public var createdAt: Date

    public init(
        id: String = Cuid.generate(),
        courseId: String,
        year: Int,
        label: String? = nil,
        materialId: String? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.courseId = courseId
        self.year = year
        self.label = label
        self.materialId = materialId
        self.createdAt = createdAt
    }
}

public struct PaperItem: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "PaperItem"

    public var id: String
    public var paperId: String
    public var stem: String
    public var marksAllocated: Double?
    public var questionNumber: String?

    public init(
        id: String = Cuid.generate(),
        paperId: String,
        stem: String,
        marksAllocated: Double? = nil,
        questionNumber: String? = nil
    ) {
        self.id = id
        self.paperId = paperId
        self.stem = stem
        self.marksAllocated = marksAllocated
        self.questionNumber = questionNumber
    }
}

public struct PaperItemConcept: LockinRecord, Equatable {
    public static let databaseTableName = "PaperItemConcept"

    public var paperItemId: String
    public var conceptId: String

    public init(paperItemId: String, conceptId: String) {
        self.paperItemId = paperItemId
        self.conceptId = conceptId
    }
}

public struct Job: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Job"

    public var id: String
    public var kind: JobKind
    public var payload: String
    public var lectureId: String?
    public var status: JobStatus
    public var priority: Int
    public var stage: String?
    public var steps: String?
    public var attempts: Int
    public var error: String?
    public var result: String?
    public var promptVersion: String?
    public var model: String?
    public var durationMs: Int?
    public var createdAt: Date
    public var startedAt: Date?
    public var finishedAt: Date?

    public init(
        id: String = Cuid.generate(),
        kind: JobKind,
        payload: String,
        lectureId: String? = nil,
        status: JobStatus = .pending,
        priority: Int = 0,
        stage: String? = nil,
        steps: String? = nil,
        attempts: Int = 0,
        error: String? = nil,
        result: String? = nil,
        promptVersion: String? = nil,
        model: String? = nil,
        durationMs: Int? = nil,
        createdAt: Date = Date(),
        startedAt: Date? = nil,
        finishedAt: Date? = nil
    ) {
        self.id = id
        self.kind = kind
        self.payload = payload
        self.lectureId = lectureId
        self.status = status
        self.priority = priority
        self.stage = stage
        self.steps = steps
        self.attempts = attempts
        self.error = error
        self.result = result
        self.promptVersion = promptVersion
        self.model = model
        self.durationMs = durationMs
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.finishedAt = finishedAt
    }
}

public struct Setting: LockinRecord, Equatable, Identifiable {
    public static let databaseTableName = "Setting"

    public var id: String { key }
    public var key: String
    public var value: String
    public var updatedAt: Date

    public init(key: String, value: String, updatedAt: Date = Date()) {
        self.key = key
        self.value = value
        self.updatedAt = updatedAt
    }
}
