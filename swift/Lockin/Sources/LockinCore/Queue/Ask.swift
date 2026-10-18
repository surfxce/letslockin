import Foundation
import GRDB

// Port of lib/ask.ts and lib/ask-history.ts: quick questions from a lecture page,
// answered by the queue in its own lane while the student waits.

/// The longest question or selection sent (`ASK_LIMIT` / `MAX_ASK`).
public let askLimit = 1500
public let maxAsk = askLimit

/// The place picker's value for "End of summary": no heading. Headings are never empty.
public let endOfSummary = ""

private let notFoundRe = Regex.compile(#"couldn'?t find this part"#, options: [.caseInsensitive])
private let askSpaceRe = Regex.compile(#"\s+"#)

public struct AskPayload: Equatable, Sendable {
    public var kind: AskKind
    public var lectureId: String
    /// question
    public var question: String?
    /// breakdown: the text the student selected.
    public var selection: String?
    /// leftout: which part, by its label and place.
    public var what: String?
    public var `where`: String?

    public init(
        kind: AskKind,
        lectureId: String,
        question: String? = nil,
        selection: String? = nil,
        what: String? = nil,
        where: String? = nil
    ) {
        self.kind = kind
        self.lectureId = lectureId
        self.question = question
        self.selection = selection
        self.what = what
        self.where = `where`
    }

    private static func optionalString(_ value: JSONValue?) -> String? {
        guard let value, !value.isNull else { return nil }
        return value.stringValue ?? jsString(value)
    }

    public static func parse(_ value: JSONValue) throws -> AskPayload {
        guard case .object(let object) = value else {
            throw LockinError("Cannot read properties of \(value.isNull ? "null" : "undefined") (reading 'lectureId')")
        }
        let kindRaw = optionalString(object["kind"]) ?? "question"
        let kind = AskKind(rawValue: kindRaw) ?? .question
        let lectureId: String
        if let rawId = object["lectureId"] {
            lectureId = jsString(rawId)
        } else {
            lectureId = "undefined"
        }
        return AskPayload(
            kind: kind,
            lectureId: lectureId,
            question: optionalString(object["question"]),
            selection: optionalString(object["selection"]),
            what: optionalString(object["what"]),
            where: optionalString(object["where"])
        )
    }

    public static func fromJSON(_ value: JSONValue) -> AskPayload? {
        try? parse(value)
    }

    public var json: JSONValue {
        var object: JSONObject = [
            "kind": .string(kind.rawValue),
            "lectureId": .string(lectureId),
        ]
        if let question { object["question"] = .string(question) }
        if let selection { object["selection"] = .string(selection) }
        if let what { object["what"] = .string(what) }
        if let place = self.where { object["where"] = .string(place) }
        return .object(object)
    }
}

public struct AskResult: Equatable, Sendable {
    public var kind: AskKind
    public var answer: String
    /// question: the summary heading it belongs under, if one fits.
    public var section: String?
    public var question: String?
    public var selection: String?
    public var what: String?
    /// leftout: false when the part could not be found, so there is nothing to add.
    public var found: Bool?
    /// Who answered, for display (set by the queue).
    public var model: String?

    public init(
        kind: AskKind,
        answer: String,
        section: String? = nil,
        question: String? = nil,
        selection: String? = nil,
        what: String? = nil,
        found: Bool? = nil,
        model: String? = nil
    ) {
        self.kind = kind
        self.answer = answer
        self.section = section
        self.question = question
        self.selection = selection
        self.what = what
        self.found = found
        self.model = model
    }

    public static func fromJSON(_ value: JSONValue) -> AskResult? {
        guard case .object(let object) = value,
              let kindRaw = object["kind"]?.stringValue,
              let kind = AskKind(rawValue: kindRaw),
              let answer = object["answer"]?.stringValue else {
            return nil
        }
        return AskResult(
            kind: kind,
            answer: answer,
            section: object["section"]?.stringValue,
            question: object["question"]?.stringValue,
            selection: object["selection"]?.stringValue,
            what: object["what"]?.stringValue,
            found: object["found"]?.boolValue,
            model: object["model"]?.stringValue
        )
    }

    public var json: JSONValue {
        var object: JSONObject = [
            "kind": .string(kind.rawValue),
            "answer": .string(answer),
            "section": .orNull(section),
        ]
        switch kind {
        case .leftout:
            object["what"] = .string(what ?? "")
            object["found"] = .bool(found ?? true)
        case .breakdown:
            object["selection"] = .string(selection ?? "")
        case .question:
            object["question"] = .string(question ?? "")
        }
        if let model {
            object["model"] = .string(model)
        }
        return .object(object)
    }
}

/// The left-out parts of a lecture whose text is known without asking a model:
/// aims slides dropped before the summary was written (`knownLeftOut` in lib/ask.ts).
public func knownLeftOut(_ materials: [Material], what: String) -> String? {
    guard let sources = try? lectureSources(materials) else { return nil }
    return sources.skipped.first { $0.what == what && ($0.about?.isEmpty == false) }?.about
}

/// Saves what a left-out part said onto the lecture, so it is there next time (`saveLeftOut`).
public func saveLeftOut(database: LockinDatabase, lectureId: String, what: String, about: String) throws {
    try database.writer.write { db in
        guard let row = try Row.fetchOne(db, sql: #"SELECT "skipped" FROM "Lecture" WHERE "id" = ?"#, arguments: [lectureId]) else {
            return
        }
        let rawSkipped: String? = row["skipped"]
        let updated = readSkipped(rawSkipped).map { item -> Skipped in
            guard item.what == what else { return item }
            var copy = item
            copy.about = about
            return copy
        }
        try db.execute(
            sql: #"UPDATE "Lecture" SET "skipped" = ? WHERE "id" = ?"#,
            arguments: [skippedJSON(updated).stringified(), lectureId]
        )
    }
}

/// `runAsk(payload, provider)` in lib/ask.ts.
public func runAsk(
    database: LockinDatabase,
    payload: AskPayload,
    provider: any LLMProvider
) async throws -> AskResult {
    let (lecture, materials) = try await database.reader.read { db -> (Lecture, [Material]) in
        guard let lecture = try Lecture.fetchOne(db, key: payload.lectureId) else {
            throw LockinError(prismaRecordNotFound)
        }
        let materials = try Material.fetchAll(
            db,
            sql: #"SELECT * FROM "Material" WHERE "lectureId" = ?"#,
            arguments: [payload.lectureId]
        )
        return (lecture, materials)
    }

    if payload.kind == .leftout {
        let what = payload.what ?? ""
        if let known = knownLeftOut(materials, what: what) {
            try saveLeftOut(database: database, lectureId: lecture.id, what: what, about: known)
            return AskResult(kind: .leftout, answer: known, section: nil, what: what, found: true)
        }
        let sources = try lectureSources(materials)
        let reply = try await provider.ask(
            .leftout(
                AskLeftOut(
                    lectureTitle: lecture.title,
                    what: what,
                    where: payload.where ?? "",
                    transcript: sources.transcript,
                    slidesText: sources.slidesText
                )
            )
        )
        let found = !Regex.test(notFoundRe, in: reply.answer)
        let trimmed = pipelineTrim(reply.answer)
        if found {
            try saveLeftOut(database: database, lectureId: lecture.id, what: what, about: trimmed)
        }
        return AskResult(kind: .leftout, answer: trimmed, section: nil, what: what, found: found)
    }

    let summary = pipelineTrim(lecture.summaryMd ?? "")
    if summary.isEmpty {
        throw LockinError("this lecture has no summary yet — prepare it first")
    }

    if payload.kind == .breakdown {
        let selection = (payload.selection ?? "").utf16Slice(0, maxAsk)
        let reply = try await provider.ask(
            .breakdown(
                AskBreakdown(
                    lectureTitle: lecture.title,
                    summary: summary,
                    selection: selection
                )
            )
        )
        return AskResult(kind: .breakdown, answer: pipelineTrim(reply.answer), section: nil, selection: selection)
    }

    let question = (payload.question ?? "").utf16Slice(0, maxAsk)
    let headings = summaryHeadings(summary)
    let reply = try await provider.ask(
        .question(
            AskQuestion(
                lectureTitle: lecture.title,
                summary: summary,
                question: question,
                headings: headings
            )
        )
    )
    return AskResult(
        kind: .question,
        answer: pipelineTrim(reply.answer),
        section: matchHeading(summary, reply.section),
        question: question
    )
}

// MARK: - Ask panel history and helpers (lib/ask-history.ts)

public struct AskHistoryItem: Equatable, Identifiable, Sendable {
    public var id: String
    public var question: String
    public var answer: String
    public var section: String?
    public var at: String
    public var model: String?

    public init(id: String, question: String, answer: String, section: String? = nil, at: String, model: String? = nil) {
        self.id = id
        self.question = question
        self.answer = answer
        self.section = section
        self.at = at
        self.model = model
    }
}

public func askDraftKey(_ lectureId: String) -> String { "lockin.askDraft.\(lectureId)" }
public func askPasteKey(_ lectureId: String) -> String { "lockin.askPaste.\(lectureId)" }

private func normalizeAskWords(_ s: String) -> String {
    Regex.replace(askSpaceRe, in: pipelineTrim(s), with: " ")
}

private func sameAskKey(question: String, answer: String) -> String {
    "\(normalizeAskWords(question))\n\n\(normalizeAskWords(answer))"
}

private func parseAskTime(_ at: String) -> Double {
    guard let date = PrismaDate.parseString(at) else { return 0 }
    return date.timeIntervalSince1970 * 1000
}

/// Every question answered so far, newest first and each once (`mergeHistory`).
public func mergeHistory(
    _ lists: [[AskHistoryItem]],
    showing: (question: String, answer: String)? = nil
) -> [AskHistoryItem] {
    var ids = Set<String>()
    var keys = Set<String>()
    if let showing {
        keys.insert(sameAskKey(question: showing.question, answer: showing.answer))
    }
    var out: [AskHistoryItem] = []
    for list in lists {
        for item in list {
            let key = sameAskKey(question: item.question, answer: item.answer)
            if ids.contains(item.id) || keys.contains(key) { continue }
            ids.insert(item.id)
            keys.insert(key)
            out.append(item)
        }
    }
    return out
        .enumerated()
        .sorted { a, b in
            let ta = parseAskTime(a.element.at)
            let tb = parseAskTime(b.element.at)
            if ta != tb { return ta > tb }
            return a.offset < b.offset
        }
        .map(\.element)
}

/// Which heading an answer goes under (`chosenSection`).
public func chosenSection(
    _ headings: [String],
    suggested: String?,
    picked: String? = nil
) -> String {
    if let picked, picked == endOfSummary || headings.contains(picked) {
        return picked
    }
    guard let suggested, !pipelineTrim(suggested).isEmpty else {
        return endOfSummary
    }
    if headings.contains(suggested) {
        return suggested
    }
    let key = normalizeAskWords(suggested).lowercased()
    return headings.first { normalizeAskWords($0).lowercased() == key } ?? endOfSummary
}

/// Time spent waiting for an answer: "12s", then "1m 05s" (`formatWait`).
public func formatWait(_ ms: Int) -> String {
    let s = max(0, ms / 1000)
    if s < 60 { return "\(s)s" }
    return String(format: "%dm %02ds", s / 60, s % 60)
}
