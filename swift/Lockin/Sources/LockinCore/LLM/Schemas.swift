import Foundation

/// Every model reply is validated against one of these before it touches the database
/// (port of `lib/llm/schemas.ts`). Validation follows zod 4 exactly: the same defaults,
/// the same refinements, every issue collected, and the same issue JSON as zod's
/// `error.message` — which is what the repair pass quotes back to the model and what a
/// failed job shows.

// MARK: - Validation issues

public enum JSONPathComponent: Equatable, Sendable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral {
    case key(String)
    case index(Int)

    public init(stringLiteral value: String) {
        self = .key(value)
    }

    public init(integerLiteral value: Int) {
        self = .index(value)
    }

    public var json: JSONValue {
        switch self {
        case .key(let key): return .string(key)
        case .index(let index): return .int(index)
        }
    }
}

public struct ValidationIssue: Equatable, Sendable {
    /// zod's fields before `path`, in its order: `code` plus `expected`/`origin`/`minimum`…
    public var fields: JSONObject
    public var path: [JSONPathComponent]
    public var message: String

    public init(fields: JSONObject, path: [JSONPathComponent], message: String) {
        self.fields = fields
        self.path = path
        self.message = message
    }

    public var code: String { fields["code"]?.stringValue ?? "" }

    public var json: JSONValue {
        var object = fields
        object["path"] = .array(path.map(\.json))
        object["message"] = .string(message)
        return .object(object)
    }
}

/// A reply that does not match its schema (a `ZodError` in TypeScript). Its message is
/// the issues as zod prints them.
public struct LLMValidationError: Error, LocalizedError, Equatable, Sendable {
    public var issues: [ValidationIssue]

    public init(issues: [ValidationIssue]) {
        self.issues = issues
    }

    public var message: String {
        JSONValue.array(issues.map(\.json)).stringified(indent: 2)
    }

    public var errorDescription: String? { message }

    /// The wrong parts' paths with array positions left out ("questions.rubric"), unique
    /// and non-empty, as the offline provider names them (`checked` in lib/llm/local.ts).
    public var keyPaths: [String] {
        var out: [String] = []
        for issue in issues {
            let keys = issue.path.compactMap { component -> String? in
                if case .key(let key) = component { return key }
                return nil
            }
            let joined = keys.joined(separator: ".")
            if !joined.isEmpty && !out.contains(joined) {
                out.append(joined)
            }
        }
        return out
    }
}

/// zod's names for what it received.
func jsTypeName(_ value: JSONValue) -> String {
    switch value {
    case .null: return "null"
    case .bool: return "boolean"
    case .number: return "number"
    case .string: return "string"
    case .array: return "array"
    case .object: return "object"
    }
}

/// Reads a parsed reply against a schema, collecting zod's issues. Readers return a
/// stand-in value on failure; `finish()` throws when anything was wrong.
struct SchemaReader {
    typealias Path = [JSONPathComponent]

    private(set) var issues: [ValidationIssue] = []

    var error: LLMValidationError {
        LLMValidationError(issues: issues)
    }

    func finish() throws {
        if !issues.isEmpty {
            throw LLMValidationError(issues: issues)
        }
    }

    mutating func fail(_ fields: JSONObject, _ path: Path, _ message: String) {
        issues.append(ValidationIssue(fields: fields, path: path, message: message))
    }

    mutating func invalidType(_ expected: String, _ value: JSONValue?, _ path: Path) {
        let received = value.map { jsTypeName($0) } ?? "undefined"
        fail(
            ["expected": .string(expected), "code": "invalid_type"],
            path,
            "Invalid input: expected \(expected), received \(received)"
        )
    }

    mutating func object(_ value: JSONValue?, _ path: Path) -> JSONObject? {
        if case .object(let object)? = value {
            return object
        }
        invalidType("object", value, path)
        return nil
    }

    /// `z.array(…)`, optionally `.min(n)`, optionally `.default([])`.
    mutating func array(_ value: JSONValue?, _ path: Path, minItems: Int? = nil, defaultEmpty: Bool = false) -> [JSONValue]? {
        if value == nil && defaultEmpty {
            return []
        }
        guard case .array(let items)? = value else {
            invalidType("array", value, path)
            return nil
        }
        if let minItems, items.count < minItems {
            fail(
                ["origin": "array", "code": "too_small", "minimum": .int(minItems), "inclusive": true],
                path,
                "Too small: expected array to have >=\(minItems) items"
            )
        }
        return items
    }

    /// `z.string()`, optionally `.min(n)` (counted in UTF-16 units, as JavaScript does).
    mutating func string(_ value: JSONValue?, _ path: Path, minLength: Int? = nil) -> String {
        guard case .string(let text)? = value else {
            invalidType("string", value, path)
            return ""
        }
        if let minLength, text.utf16.count < minLength {
            fail(
                ["origin": "string", "code": "too_small", "minimum": .int(minLength), "inclusive": true],
                path,
                "Too small: expected string to have >=\(minLength) characters"
            )
        }
        return text
    }

    /// `z.string().default(fallback)`: only a missing value takes the default.
    mutating func stringOrDefault(_ value: JSONValue?, _ path: Path, _ fallback: String) -> String {
        if value == nil {
            return fallback
        }
        return string(value, path)
    }

    /// `z.string().nullable().default(null)`.
    mutating func nullableString(_ value: JSONValue?, _ path: Path) -> String? {
        guard let value else { return nil }
        switch value {
        case .null:
            return nil
        case .string(let text):
            return text
        default:
            invalidType("string", value, path)
            return nil
        }
    }

    /// `z.number()`, optionally `.int()`, `.min(a)`, `.max(b)`.
    mutating func number(
        _ value: JSONValue?,
        _ path: Path,
        integer: Bool = false,
        minimum: Double? = nil,
        maximum: Double? = nil
    ) -> Double {
        guard case .number(let found)? = value else {
            invalidType("number", value, path)
            return 0
        }
        if !found.isFinite {
            // JSON.parse reads 1e400 as Infinity, which z.number() refuses.
            let received = found.isNaN ? "NaN" : (found < 0 ? "-Infinity" : "Infinity")
            fail(
                ["expected": "number", "code": "invalid_type", "received": .string(received)],
                path,
                "Invalid input: expected number, received \(received)"
            )
            return 0
        }
        if integer {
            if found != found.rounded(.towardZero) {
                // zod 4 stops at a failed `.int()`: no min/max issue follows it.
                fail(
                    ["expected": "int", "format": "safeint", "code": "invalid_type"],
                    path,
                    "Invalid input: expected int, received number"
                )
                return found
            }
            // Outside the safe range zod says so, then carries on to min/max.
            if found > 9_007_199_254_740_991 {
                fail(
                    [
                        "code": "too_big", "maximum": 9_007_199_254_740_991,
                        "note": "Integers must be within the safe integer range.", "origin": "int", "inclusive": true,
                    ],
                    path,
                    "Too big: expected int to be <=9007199254740991"
                )
            } else if found < -9_007_199_254_740_991 {
                fail(
                    [
                        "code": "too_small", "minimum": -9_007_199_254_740_991,
                        "note": "Integers must be within the safe integer range.", "origin": "int", "inclusive": true,
                    ],
                    path,
                    "Too small: expected int to be >=-9007199254740991"
                )
            }
        }
        if let minimum, found < minimum {
            fail(
                ["origin": "number", "code": "too_small", "minimum": .number(minimum), "inclusive": true],
                path,
                "Too small: expected number to be >=\(jsNumberString(minimum))"
            )
        }
        if let maximum, found > maximum {
            fail(
                ["origin": "number", "code": "too_big", "maximum": .number(maximum), "inclusive": true],
                path,
                "Too big: expected number to be <=\(jsNumberString(maximum))"
            )
        }
        return found
    }

    /// `z.number().nullable().default(null)`.
    mutating func nullableNumber(_ value: JSONValue?, _ path: Path) -> Double? {
        guard let value else { return nil }
        if case .null = value {
            return nil
        }
        return number(value, path)
    }

    /// `z.number().int().min(n)` as an Int.
    mutating func integer(_ value: JSONValue?, _ path: Path, minimum: Int) -> Int {
        let found = number(value, path, integer: true, minimum: Double(minimum))
        return Int(exactly: found) ?? 0
    }

    /// `z.literal(expected)`.
    mutating func literal(_ value: JSONValue?, _ path: Path, _ expected: Double) {
        if case .number(let found)? = value, found == expected {
            return
        }
        fail(
            ["code": "invalid_value", "values": .array([.number(expected)])],
            path,
            "Invalid input: expected \(jsNumberString(expected))"
        )
    }

    /// `z.enum(options)`.
    mutating func option(_ value: JSONValue?, _ path: Path, _ options: [String]) -> String {
        if case .string(let text)? = value, options.contains(text) {
            return text
        }
        let listed = options.map { "\"\($0)\"" }.joined(separator: "|")
        fail(
            ["code": "invalid_value", "values": .strings(options)],
            path,
            "Invalid option: expected one of \(listed)"
        )
        return options.first ?? ""
    }
}

// MARK: - Output protocol

/// A model reply type: parsed (and validated) from JSON the way zod parses it, and
/// written back as the JSON `JSON.stringify` would write for the parsed value.
public protocol LLMOutput: Equatable, Sendable {
    /// `Schema.parse(value)`: throws `LLMValidationError` with zod's issues.
    static func parse(_ json: JSONValue) throws -> Self
    /// The value as JSON, keys in the schema's order (what is stored in the database).
    var json: JSONValue { get }
}

extension LLMOutput {
    /// Checks a value built in code (the fake provider's, a test's) against its schema.
    public func validate() throws {
        _ = try Self.parse(json)
    }
}

// MARK: - Digest

/// A section set aside in the digest. zod defaults: `where` and `about` to "".
public struct DigestSkip: Codable, Equatable, Sendable {
    public var what: String
    public var `where`: String
    public var about: String

    public init(what: String, where: String = "", about: String = "") {
        self.what = what
        self.where = `where`
        self.about = about
    }

    public var json: JSONValue {
        ["what": .string(what), "where": .string(self.where), "about": .string(about)]
    }

    /// As stored in `Lecture.skipped` (before `mergeSkipped`).
    public var asSkipped: Skipped {
        Skipped(what: what, where: self.where, about: about)
    }
}

public struct DigestConcept: Codable, Equatable, Sendable {
    /// Set when reusing a concept already on the course list; nil when minting a new one.
    public var existingId: String?
    public var name: String
    public var definition: String
    public var sourceRef: String?

    public init(existingId: String? = nil, name: String, definition: String, sourceRef: String? = nil) {
        self.existingId = existingId
        self.name = name
        self.definition = definition
        self.sourceRef = sourceRef
    }

    public var json: JSONValue {
        [
            "existingId": .orNull(existingId),
            "name": .string(name),
            "definition": .string(definition),
            "sourceRef": .orNull(sourceRef),
        ]
    }
}

/// `Digest` in TypeScript: title, set-aside sections, summary and concepts in one pass.
public struct LectureDigest: Equatable, Sendable {
    public var title: String
    public var skipped: [DigestSkip]
    public var summaryMd: String
    public var concepts: [DigestConcept]
    /// What each slide says and shows, from a model that could see them; else empty.
    public var slideNotes: [SlideNote]

    public init(
        title: String,
        skipped: [DigestSkip] = [],
        summaryMd: String,
        concepts: [DigestConcept],
        slideNotes: [SlideNote] = []
    ) {
        self.title = title
        self.skipped = skipped
        self.summaryMd = summaryMd
        self.concepts = concepts
        self.slideNotes = slideNotes
    }
}

extension LectureDigest: LLMOutput {
    public static func parse(_ json: JSONValue) throws -> LectureDigest {
        var reader = SchemaReader()
        guard let object = reader.object(json, []) else { throw reader.error }
        let title = reader.string(object["title"], ["title"], minLength: 1)

        var skipped: [DigestSkip] = []
        let skippedItems = reader.array(object["skipped"], ["skipped"], defaultEmpty: true) ?? []
        for (i, item) in skippedItems.enumerated() {
            let path: [JSONPathComponent] = ["skipped", .index(i)]
            guard let entry = reader.object(item, path) else { continue }
            let what = reader.string(entry["what"], path + [.key("what")], minLength: 1)
            let place = reader.stringOrDefault(entry["where"], path + [.key("where")], "")
            let about = reader.stringOrDefault(entry["about"], path + [.key("about")], "")
            skipped.append(DigestSkip(what: what, where: place, about: about))
        }

        let summaryMd = reader.string(object["summaryMd"], ["summaryMd"], minLength: 1)

        var concepts: [DigestConcept] = []
        let conceptItems = reader.array(object["concepts"], ["concepts"]) ?? []
        for (i, item) in conceptItems.enumerated() {
            let path: [JSONPathComponent] = ["concepts", .index(i)]
            guard let entry = reader.object(item, path) else { continue }
            let existingId = reader.nullableString(entry["existingId"], path + [.key("existingId")])
            let name = reader.string(entry["name"], path + [.key("name")], minLength: 1)
            let definition = reader.string(entry["definition"], path + [.key("definition")], minLength: 1)
            let sourceRef = reader.nullableString(entry["sourceRef"], path + [.key("sourceRef")])
            concepts.append(DigestConcept(existingId: existingId, name: name, definition: definition, sourceRef: sourceRef))
        }

        var slideNotes: [SlideNote] = []
        let noteItems = reader.array(object["slideNotes"], ["slideNotes"], defaultEmpty: true) ?? []
        for (i, item) in noteItems.enumerated() {
            let path: [JSONPathComponent] = ["slideNotes", .index(i)]
            guard let entry = reader.object(item, path) else { continue }
            let slide = reader.integer(entry["slide"], path + [.key("slide")], minimum: 1)
            let notes = reader.string(entry["notes"], path + [.key("notes")], minLength: 1)
            slideNotes.append(SlideNote(slide: slide, notes: notes))
        }

        try reader.finish()
        return LectureDigest(title: title, skipped: skipped, summaryMd: summaryMd, concepts: concepts, slideNotes: slideNotes)
    }

    public var json: JSONValue {
        [
            "title": .string(title),
            "skipped": .array(skipped.map(\.json)),
            "summaryMd": .string(summaryMd),
            "concepts": .array(concepts.map(\.json)),
            "slideNotes": .array(slideNotes.map(\.json)),
        ]
    }
}

extension LectureDigest: Codable {
    public init(from decoder: Decoder) throws {
        self = try LectureDigest.parse(JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}

// MARK: - Rubric and questions

public struct RubricCriterion: Codable, Equatable, Sendable {
    /// One thing a complete answer states.
    public var point: String
    public var marks: Double

    public init(point: String, marks: Double) {
        self.point = point
        self.marks = marks
    }

    public var json: JSONValue {
        ["point": .string(point), "marks": .number(marks)]
    }
}

/// A question's marking guide; `totalMarks` is always 10. Stored as `Question.rubric`.
public struct Rubric: Equatable, Sendable {
    public var modelAnswer: String
    public var criteria: [RubricCriterion]
    public var totalMarks: Int

    public init(modelAnswer: String, criteria: [RubricCriterion], totalMarks: Int = 10) {
        self.modelAnswer = modelAnswer
        self.criteria = criteria
        self.totalMarks = totalMarks
    }

    static func read(_ reader: inout SchemaReader, _ value: JSONValue?, _ path: [JSONPathComponent]) -> Rubric {
        guard let object = reader.object(value, path) else {
            return Rubric(modelAnswer: "", criteria: [])
        }
        let modelAnswer = reader.string(object["modelAnswer"], path + [.key("modelAnswer")], minLength: 1)
        var criteria: [RubricCriterion] = []
        let items = reader.array(object["criteria"], path + [.key("criteria")], minItems: 1) ?? []
        for (j, item) in items.enumerated() {
            let at = path + [.key("criteria"), .index(j)]
            guard let entry = reader.object(item, at) else { continue }
            let point = reader.string(entry["point"], at + [.key("point")])
            let marks = reader.number(entry["marks"], at + [.key("marks")], minimum: 0, maximum: 10)
            criteria.append(RubricCriterion(point: point, marks: marks))
        }
        reader.literal(object["totalMarks"], path + [.key("totalMarks")], 10)
        return Rubric(modelAnswer: modelAnswer, criteria: criteria)
    }
}

extension Rubric: LLMOutput {
    public static func parse(_ json: JSONValue) throws -> Rubric {
        var reader = SchemaReader()
        let rubric = Rubric.read(&reader, json, [])
        try reader.finish()
        return rubric
    }

    public var json: JSONValue {
        [
            "modelAnswer": .string(modelAnswer),
            "criteria": .array(criteria.map(\.json)),
            "totalMarks": .int(totalMarks),
        ]
    }
}

extension Rubric: Codable {
    public init(from decoder: Decoder) throws {
        self = try Rubric.parse(JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}

public struct GeneratedQuestion: Equatable, Sendable {
    public var stem: String
    public var type: QuestionType
    public var conceptIds: [String]
    public var rubric: Rubric

    public init(stem: String, type: QuestionType, conceptIds: [String], rubric: Rubric) {
        self.stem = stem
        self.type = type
        self.conceptIds = conceptIds
        self.rubric = rubric
    }

    public var json: JSONValue {
        [
            "stem": .string(stem),
            "type": .string(type.rawValue),
            "conceptIds": .strings(conceptIds),
            "rubric": rubric.json,
        ]
    }
}

public struct QuestionSet: Equatable, Sendable {
    public var questions: [GeneratedQuestion]

    public init(questions: [GeneratedQuestion]) {
        self.questions = questions
    }
}

extension QuestionSet: LLMOutput {
    public static func parse(_ json: JSONValue) throws -> QuestionSet {
        var reader = SchemaReader()
        guard let object = reader.object(json, []) else { throw reader.error }
        var questions: [GeneratedQuestion] = []
        let items = reader.array(object["questions"], ["questions"]) ?? []
        for (i, item) in items.enumerated() {
            let path: [JSONPathComponent] = ["questions", .index(i)]
            guard let entry = reader.object(item, path) else { continue }
            let stem = reader.string(entry["stem"], path + [.key("stem")], minLength: 1)
            let type = reader.option(entry["type"], path + [.key("type")], QuestionType.allKnown.map { $0.rawValue })
            var conceptIds: [String] = []
            let ids = reader.array(entry["conceptIds"], path + [.key("conceptIds")], minItems: 1) ?? []
            for (j, id) in ids.enumerated() {
                conceptIds.append(reader.string(id, path + [.key("conceptIds"), .index(j)]))
            }
            let rubric = Rubric.read(&reader, entry["rubric"], path + [.key("rubric")])
            questions.append(
                GeneratedQuestion(
                    stem: stem,
                    type: QuestionType(rawValue: type) ?? .laq,
                    conceptIds: conceptIds,
                    rubric: rubric
                )
            )
        }
        try reader.finish()
        return QuestionSet(questions: questions)
    }

    public var json: JSONValue {
        ["questions": .array(questions.map(\.json))]
    }
}

extension QuestionSet: Codable {
    public init(from decoder: Decoder) throws {
        self = try QuestionSet.parse(JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}

// MARK: - Marking

public struct MarkingCriterion: Codable, Equatable, Sendable {
    public var point: String
    public var awarded: Double
    public var outOf: Double
    public var note: String?

    public init(point: String, awarded: Double, outOf: Double, note: String? = nil) {
        self.point = point
        self.awarded = awarded
        self.outOf = outOf
        self.note = note
    }

    public var json: JSONValue {
        ["point": .string(point), "awarded": .number(awarded), "outOf": .number(outOf), "note": .orNull(note)]
    }
}

public struct MarkingGap: Codable, Equatable, Sendable {
    /// Must be an id from the concept list supplied in the prompt.
    public var conceptId: String
    public var type: GapType
    public var text: String

    public init(conceptId: String, type: GapType, text: String) {
        self.conceptId = conceptId
        self.type = type
        self.text = text
    }

    public var json: JSONValue {
        ["conceptId": .string(conceptId), "type": .string(type.rawValue), "text": .string(text)]
    }
}

public struct Marking: Equatable, Sendable {
    public var mark: Double
    public var criteria: [MarkingCriterion]
    public var gaps: [MarkingGap]

    public init(mark: Double, criteria: [MarkingCriterion], gaps: [MarkingGap]) {
        self.mark = mark
        self.criteria = criteria
        self.gaps = gaps
    }
}

extension Marking: LLMOutput {
    public static func parse(_ json: JSONValue) throws -> Marking {
        var reader = SchemaReader()
        guard let object = reader.object(json, []) else { throw reader.error }
        let mark = reader.number(object["mark"], ["mark"], minimum: 0, maximum: 10)

        var criteria: [MarkingCriterion] = []
        let criterionItems = reader.array(object["criteria"], ["criteria"]) ?? []
        for (i, item) in criterionItems.enumerated() {
            let path: [JSONPathComponent] = ["criteria", .index(i)]
            guard let entry = reader.object(item, path) else { continue }
            let point = reader.string(entry["point"], path + [.key("point")])
            let awarded = reader.number(entry["awarded"], path + [.key("awarded")], minimum: 0)
            let outOf = reader.number(entry["outOf"], path + [.key("outOf")], minimum: 0)
            let note = reader.nullableString(entry["note"], path + [.key("note")])
            criteria.append(MarkingCriterion(point: point, awarded: awarded, outOf: outOf, note: note))
        }

        var gaps: [MarkingGap] = []
        let gapItems = reader.array(object["gaps"], ["gaps"]) ?? []
        for (i, item) in gapItems.enumerated() {
            let path: [JSONPathComponent] = ["gaps", .index(i)]
            guard let entry = reader.object(item, path) else { continue }
            let conceptId = reader.string(entry["conceptId"], path + [.key("conceptId")])
            let type = reader.option(entry["type"], path + [.key("type")], GapType.allKnown.map { $0.rawValue })
            let text = reader.string(entry["text"], path + [.key("text")], minLength: 1)
            gaps.append(MarkingGap(conceptId: conceptId, type: GapType(rawValue: type) ?? .missed, text: text))
        }

        try reader.finish()
        return Marking(mark: mark, criteria: criteria, gaps: gaps)
    }

    public var json: JSONValue {
        [
            "mark": .number(mark),
            "criteria": .array(criteria.map(\.json)),
            "gaps": .array(gaps.map(\.json)),
        ]
    }
}

extension Marking: Codable {
    public init(from decoder: Decoder) throws {
        self = try Marking.parse(JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}

// MARK: - Folder sort

public struct FolderSortLecture: Codable, Equatable, Sendable {
    public var title: String
    public var module: String?
    /// 1-based file numbers, as the files were listed in the prompt.
    public var files: [Int]

    public init(title: String, module: String? = nil, files: [Int]) {
        self.title = title
        self.module = module
        self.files = files
    }

    public var json: JSONValue {
        ["title": .string(title), "module": .orNull(module), "files": .array(files.map { JSONValue.int($0) })]
    }
}

public struct FolderSortSetAside: Codable, Equatable, Sendable {
    public var file: Int
    public var reason: String

    public init(file: Int, reason: String = "") {
        self.file = file
        self.reason = reason
    }

    public var json: JSONValue {
        ["file": .int(file), "reason": .string(reason)]
    }
}

/// A folder grouped into lectures. Files are the numbers they were listed under.
public struct FolderSort: Equatable, Sendable {
    public var lectures: [FolderSortLecture]
    public var setAside: [FolderSortSetAside]

    public init(lectures: [FolderSortLecture], setAside: [FolderSortSetAside] = []) {
        self.lectures = lectures
        self.setAside = setAside
    }
}

extension FolderSort: LLMOutput {
    public static func parse(_ json: JSONValue) throws -> FolderSort {
        var reader = SchemaReader()
        guard let object = reader.object(json, []) else { throw reader.error }

        var lectures: [FolderSortLecture] = []
        let lectureItems = reader.array(object["lectures"], ["lectures"]) ?? []
        for (i, item) in lectureItems.enumerated() {
            let path: [JSONPathComponent] = ["lectures", .index(i)]
            guard let entry = reader.object(item, path) else { continue }
            let title = reader.string(entry["title"], path + [.key("title")], minLength: 1)
            let module = reader.nullableString(entry["module"], path + [.key("module")])
            var files: [Int] = []
            let fileItems = reader.array(entry["files"], path + [.key("files")], minItems: 1) ?? []
            for (j, file) in fileItems.enumerated() {
                files.append(reader.integer(file, path + [.key("files"), .index(j)], minimum: 1))
            }
            lectures.append(FolderSortLecture(title: title, module: module, files: files))
        }

        var setAside: [FolderSortSetAside] = []
        let asideItems = reader.array(object["setAside"], ["setAside"], defaultEmpty: true) ?? []
        for (i, item) in asideItems.enumerated() {
            let path: [JSONPathComponent] = ["setAside", .index(i)]
            guard let entry = reader.object(item, path) else { continue }
            let file = reader.integer(entry["file"], path + [.key("file")], minimum: 1)
            let reason = reader.stringOrDefault(entry["reason"], path + [.key("reason")], "")
            setAside.append(FolderSortSetAside(file: file, reason: reason))
        }

        try reader.finish()
        return FolderSort(lectures: lectures, setAside: setAside)
    }

    public var json: JSONValue {
        ["lectures": .array(lectures.map(\.json)), "setAside": .array(setAside.map(\.json))]
    }
}

extension FolderSort: Codable {
    public init(from decoder: Decoder) throws {
        self = try FolderSort.parse(JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}

// MARK: - Answer

/// A short answer for someone waiting on the lecture page.
public struct Answer: Equatable, Sendable {
    public var answer: String
    /// Question answers only: the summary heading the answer belongs under.
    public var section: String?

    public init(answer: String, section: String? = nil) {
        self.answer = answer
        self.section = section
    }
}

extension Answer: LLMOutput {
    public static func parse(_ json: JSONValue) throws -> Answer {
        var reader = SchemaReader()
        guard let object = reader.object(json, []) else { throw reader.error }
        let answer = reader.string(object["answer"], ["answer"], minLength: 1)
        let section = reader.nullableString(object["section"], ["section"])
        try reader.finish()
        return Answer(answer: answer, section: section)
    }

    public var json: JSONValue {
        ["answer": .string(answer), "section": .orNull(section)]
    }
}

extension Answer: Codable {
    public init(from decoder: Decoder) throws {
        self = try Answer.parse(JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}

// MARK: - Past papers

public struct ParsedPaperItem: Codable, Equatable, Sendable {
    public var questionNumber: String?
    public var stem: String
    public var marksAllocated: Double?
    public var conceptIds: [String]

    public init(questionNumber: String? = nil, stem: String, marksAllocated: Double? = nil, conceptIds: [String] = []) {
        self.questionNumber = questionNumber
        self.stem = stem
        self.marksAllocated = marksAllocated
        self.conceptIds = conceptIds
    }

    public var json: JSONValue {
        [
            "questionNumber": .orNull(questionNumber),
            "stem": .string(stem),
            "marksAllocated": .orNull(marksAllocated),
            "conceptIds": .strings(conceptIds),
        ]
    }
}

public struct PaperItems: Equatable, Sendable {
    public var items: [ParsedPaperItem]

    public init(items: [ParsedPaperItem]) {
        self.items = items
    }
}

extension PaperItems: LLMOutput {
    public static func parse(_ json: JSONValue) throws -> PaperItems {
        var reader = SchemaReader()
        guard let object = reader.object(json, []) else { throw reader.error }
        var items: [ParsedPaperItem] = []
        let entries = reader.array(object["items"], ["items"]) ?? []
        for (i, item) in entries.enumerated() {
            let path: [JSONPathComponent] = ["items", .index(i)]
            guard let entry = reader.object(item, path) else { continue }
            let questionNumber = reader.nullableString(entry["questionNumber"], path + [.key("questionNumber")])
            let stem = reader.string(entry["stem"], path + [.key("stem")], minLength: 1)
            let marksAllocated = reader.nullableNumber(entry["marksAllocated"], path + [.key("marksAllocated")])
            var conceptIds: [String] = []
            let ids = reader.array(entry["conceptIds"], path + [.key("conceptIds")], defaultEmpty: true) ?? []
            for (j, id) in ids.enumerated() {
                conceptIds.append(reader.string(id, path + [.key("conceptIds"), .index(j)]))
            }
            items.append(
                ParsedPaperItem(
                    questionNumber: questionNumber,
                    stem: stem,
                    marksAllocated: marksAllocated,
                    conceptIds: conceptIds
                )
            )
        }
        try reader.finish()
        return PaperItems(items: items)
    }

    public var json: JSONValue {
        ["items": .array(items.map(\.json))]
    }
}

extension PaperItems: Codable {
    public init(from decoder: Decoder) throws {
        self = try PaperItems.parse(JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}
