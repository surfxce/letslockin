import Foundation
import GRDB

// MARK: - Glossary (lib/glossary.ts)

/// The longest phrase kept as a glossary term (`MAX_TERM`).
public let maxTermLength = 300

private let cleanTermWhitespaceRe = Regex.compile(#"\s+"#)
private let cleanTermLeadingRe = Regex.compile(#"\A[\s"'“‘(\[•·,;:–—-]+"#)
private let cleanTermTrailingRe = Regex.compile(#"[\s"'”’)\],;:.!?–—-]+\z"#)
private let wordishRe = Regex.compile(#"[\p{L}\p{N}]"#)
private let regexMetaRe = Regex.compile(#"[.*+?^${}()|\[\]\\]"#)

/// A selection made into a term (`cleanTerm` in lib/glossary.ts).
public func cleanTerm(_ raw: String) -> String {
    var s = Regex.replace(cleanTermWhitespaceRe, in: raw, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    s = Regex.replaceFirst(cleanTermLeadingRe, in: s, with: "")
    s = Regex.replaceFirst(cleanTermTrailingRe, in: s, with: "")
    return s.utf16Slice(0, maxTermLength).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func patternFor(_ term: String) -> NSRegularExpression? {
    let t = cleanTerm(term)
    guard !t.isEmpty else { return nil }
    let body = t
        .components(separatedBy: " ")
        .map { w in Regex.replace(regexMetaRe, in: w, with: #"\\$0"#) }
        .joined(separator: #"\s+"#)
    let firstUnit = t.utf16Slice(0, 1)
    let lastUnit = t.utf16Slice(max(0, t.utf16Count - 1), t.utf16Count)
    let before = Regex.test(wordishRe, in: firstUnit) ? #"(?<![\p{L}\p{N}])"# : ""
    let after = Regex.test(wordishRe, in: lastUnit) ? #"(?![\p{L}\p{N}])"# : ""
    return try? NSRegularExpression(pattern: "\(before)\(body)\(after)", options: [.caseInsensitive])
}

public struct TermRange: Equatable, Sendable {
    public var start: Int
    public var end: Int
    /// Index into the terms given.
    public var index: Int

    public init(start: Int, end: Int, index: Int) {
        self.start = start
        self.end = end
        self.index = index
    }
}

/// Every place a term appears in `text`, case-insensitively (`findTermRanges` in lib/glossary.ts).
public func findTermRanges(_ text: String, terms: [String]) -> [TermRange] {
    struct Entry {
        var index: Int
        var pattern: NSRegularExpression
        var length: Int
    }
    let order: [Entry] = terms.enumerated()
        .compactMap { index, term in
            guard let pattern = patternFor(term) else { return nil }
            return Entry(index: index, pattern: pattern, length: cleanTerm(term).utf16Count)
        }
        .sorted { a, b in
            if a.length != b.length { return a.length > b.length }
            return a.index < b.index
        }

    var taken: [TermRange] = []
    func overlaps(_ s: Int, _ e: Int) -> Bool {
        taken.contains { r in s < r.end && e > r.start }
    }

    for entry in order {
        for m in Regex.allMatches(entry.pattern, in: text) {
            let start = m.range.location
            let end = start + m.range.length
            if end > start && !overlaps(start, end) {
                taken.append(TermRange(start: start, end: end, index: entry.index))
            }
        }
    }
    return taken.sorted { $0.start < $1.start }
}

// MARK: - Left Out (lib/left-out.ts)

public typealias LeftOutPart = Skipped

public enum LeftOutAction: String, Equatable, Sendable {
    case add
    case added
    case ask
    case busy
    case none
}

public struct LeftOutContext: Equatable, Sendable {
    public var canAsk: Bool
    public var busy: Bool
    public var notFound: Bool

    public init(canAsk: Bool, busy: Bool = false, notFound: Bool = false) {
        self.canAsk = canAsk
        self.busy = busy
        self.notFound = notFound
    }
}

public func leftOutAction(
    about: String? = nil,
    added: Bool? = nil,
    ctx: LeftOutContext
) -> LeftOutAction {
    if ctx.busy { return .busy }
    if added == true { return .added }
    if let about, !about.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return .add
    }
    if ctx.notFound || !ctx.canAsk { return .none }
    return .ask
}

public func leftOutAction(_ part: LeftOutPart, ctx: LeftOutContext) -> LeftOutAction {
    leftOutAction(about: part.about, added: part.added, ctx: ctx)
}

public func leftOutHint(_ action: LeftOutAction, ctx: LeftOutContext) -> String? {
    switch action {
    case .add:
        return "Click to add it to your summary"
    case .added:
        return "✓ In your summary"
    case .ask:
        return "Click to find out what it said"
    case .none:
        return (ctx.notFound || ctx.canAsk) ? nil : "Prepare this lecture again with AI to see what it said."
    case .busy:
        return nil
    }
}

public func leftOutButton(_ action: LeftOutAction) -> String? {
    switch action {
    case .add: return "Add to summary"
    case .ask: return "Find out what it said"
    case .added, .busy, .none: return nil
    }
}

public func partLabel(what: String, where whereStr: String) -> String {
    let w = whereStr.trimmingCharacters(in: .whitespacesAndNewlines)
    return w.isEmpty ? what : "\(what) · \(w)"
}

public func partLabel(_ part: LeftOutPart) -> String {
    partLabel(what: part.what, where: part.where)
}

public func partsLabel(_ n: Int) -> String {
    "\(n) part\(n == 1 ? "" : "s")"
}

public func partKeys(_ parts: [(what: String, where: String)]) -> [String] {
    var seen: [String: Int] = [:]
    return parts.map { p in
        let base = "\(p.what)\u{0000}\(p.where)"
        let n = seen[base] ?? 0
        seen[base] = n + 1
        return n > 0 ? "\(base)\u{0000}\(n)" : base
    }
}

public func partKeys(_ parts: [LeftOutPart]) -> [String] {
    partKeys(parts.map { ($0.what, $0.where) })
}

public func waited(_ ms: Double) -> String {
    formatWait(Int(ms))
}

public struct CardBox: Equatable, Sendable {
    public var top: Double
    public var bottom: Double
    public var left: Double
    public var right: Double

    public init(top: Double, bottom: Double, left: Double, right: Double) {
        self.top = top
        self.bottom = bottom
        self.left = left
        self.right = right
    }
}

public struct CardSize: Equatable, Sendable {
    public var width: Double
    public var height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
    }
}

public enum CardSide: String, Equatable, Sendable {
    case above
    case below
}

public struct PlacedCard: Equatable, Sendable {
    public var top: Int
    public var left: Int
    public var side: CardSide

    public init(top: Int, left: Int, side: CardSide) {
        self.top = top
        self.left = left
        self.side = side
    }
}

private func clampCard(_ value: Double, _ low: Double, _ high: Double) -> Double {
    max(low, min(value, high))
}

private func jsRoundInt(_ value: Double) -> Int {
    Int(floor(value + 0.5))
}

/// `placeCard` in lib/left-out.ts.
public func placeCard(
    anchor: CardBox,
    size: CardSize,
    viewport: CardSize,
    gap: Double = 6,
    margin: Double = 8
) -> PlacedCard {
    let below = viewport.height - anchor.bottom - gap - margin
    let above = anchor.top - gap - margin
    let side: CardSide = (size.height <= below || above <= below) ? .below : .above
    let ideal = side == .below ? anchor.bottom + gap : anchor.top - gap - size.height
    return PlacedCard(
        top: jsRoundInt(clampCard(ideal, margin, viewport.height - margin - size.height)),
        left: jsRoundInt(clampCard(anchor.left, margin, viewport.width - margin - size.width)),
        side: side
    )
}

// MARK: - Summary Tools (lib/summary-tools.ts)

public let selectionLimit = askLimit

/// `placeNear` in lib/summary-tools.ts.
public func placeNear(
    anchor: CardBox,
    size: CardSize,
    viewport: CardSize,
    prefer: CardSide,
    gap: Double = 8,
    margin: Double = 8
) -> PlacedCard {
    let roomAbove = anchor.top - gap - margin
    let roomBelow = viewport.height - anchor.bottom - gap - margin
    let roomPrefer = prefer == .above ? roomAbove : roomBelow
    let roomOther = prefer == .above ? roomBelow : roomAbove
    let other: CardSide = prefer == .above ? .below : .above
    let side: CardSide
    if size.height <= roomPrefer {
        side = prefer
    } else if size.height <= roomOther {
        side = other
    } else if roomPrefer >= roomOther {
        side = prefer
    } else {
        side = other
    }

    let ideal = side == .above ? anchor.top - gap - size.height : anchor.bottom + gap
    let top = clampCard(ideal, margin, viewport.height - margin - size.height)
    let centre = (anchor.left + anchor.right) / 2.0
    let left = clampCard(centre - size.width / 2.0, margin, viewport.width - margin - size.width)
    return PlacedCard(top: jsRoundInt(top), left: jsRoundInt(left), side: side)
}

public struct RangePiece: Equatable, Sendable {
    public var node: Int
    public var start: Int
    public var end: Int
    public var range: Int

    public init(node: Int, start: Int, end: Int, range: Int) {
        self.node = node
        self.start = start
        self.end = end
        self.range = range
    }
}

public func splitRanges(_ lengths: [Int], ranges: [(start: Int, end: Int)]) -> [RangePiece] {
    var pieces: [RangePiece] = []
    var node = 0
    var nodeStart = 0
    for (rangeIdx, r) in ranges.enumerated() {
        while node < lengths.count && nodeStart + lengths[node] <= r.start {
            nodeStart += lengths[node]
            node += 1
        }
        var n = node
        var at = nodeStart
        while n < lengths.count && at < r.end {
            let start = max(r.start, at) - at
            let end = min(r.end, at + lengths[n]) - at
            if end > start {
                pieces.append(RangePiece(node: n, start: start, end: end, range: rangeIdx))
            }
            at += lengths[n]
            n += 1
        }
    }
    return pieces
}

public struct TermPiece: Equatable, Sendable {
    public var node: Int
    public var start: Int
    public var end: Int
    public var range: Int
    public var term: Int

    public init(node: Int, start: Int, end: Int, range: Int, term: Int) {
        self.node = node
        self.start = start
        self.end = end
        self.range = range
        self.term = term
    }
}

public func termPieces(_ texts: [String], blocks: [Int], terms: [String]) -> [TermPiece] {
    var out: [TermPiece] = []
    var matches = 0
    var from = 0
    while from < texts.count {
        var to = from + 1
        while to < texts.count && to < blocks.count && from < blocks.count && blocks[to] == blocks[from] {
            to += 1
        }
        let run = Array(texts[from..<to])
        let ranges = findTermRanges(run.joined(), terms: terms)
        let lengths = run.map(\.utf16Count)
        let split = splitRanges(lengths, ranges: ranges.map { (start: $0.start, end: $0.end) })
        for p in split {
            out.append(
                TermPiece(
                    node: from + p.node,
                    start: p.start,
                    end: p.end,
                    range: matches + p.range,
                    term: ranges[p.range].index
                )
            )
        }
        matches += ranges.count
        from = to
    }
    return out
}

public func oneLine(_ text: String) -> String {
    Regex.replace(cleanTermWhitespaceRe, in: text, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
}

private let trailingSpaceRe = Regex.compile(#"\s+\z"#)
private let leadingSpaceRe = Regex.compile(#"\A\s+"#)

public func shorten(_ text: String, max maxLen: Int) -> String {
    let t = oneLine(text)
    if t.utf16Count <= maxLen { return t }
    let head = Int(ceil(Double(maxLen - 1) * 0.7))
    let tail = maxLen - 1 - head
    let headPart = Regex.replaceFirst(trailingSpaceRe, in: t.utf16Slice(0, head), with: "")
    let tailPart = tail > 0
        ? Regex.replaceFirst(leadingSpaceRe, in: t.utf16Slice(t.utf16Count - tail, t.utf16Count), with: "")
        : ""
    return "\(headPart)…\(tailPart)"
}

public func elapsed(_ ms: Double) -> String {
    formatWait(Int(ms))
}

public struct PastePair: Equatable, Sendable {
    public var passage: String
    public var text: String

    public init(_ passage: String, _ text: String) {
        self.passage = passage
        self.text = text
    }
}

public func rememberPaste(
    _ saved: [PastePair],
    passage: String,
    text: String,
    keep: Int = 12
) -> [PastePair] {
    let rest = saved.filter { $0.passage != passage }
    let combined = text.isEmpty ? rest : ([PastePair(passage, text)] + rest)
    return Array(combined.prefix(max(0, keep)))
}

public func readPastes(_ raw: String?) -> [PastePair] {
    guard let raw, !raw.isEmpty,
          let parsed = try? JSONValue.parse(raw),
          case .array(let items) = parsed else {
        return []
    }
    return items.compactMap { entry in
        guard case .array(let pair) = entry,
              pair.count >= 2,
              case .string(let p) = pair[0],
              case .string(let t) = pair[1] else {
            return nil
        }
        return PastePair(p, t)
    }
}

public struct GlossaryEntry: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var term: String
    public var explanation: String

    public init(id: String, term: String, explanation: String) {
        self.id = id
        self.term = term
        self.explanation = explanation
    }
}

public func mergeGlossary(
    server: [GlossaryEntry],
    added: [GlossaryEntry],
    removed: Set<String>
) -> [GlossaryEntry] {
    var shown = server.filter { !removed.contains($0.id) }
    var ids = Set(shown.map(\.id))
    var words = Set(shown.map { $0.term.lowercased() })
    for e in added {
        let lower = e.term.lowercased()
        if removed.contains(e.id) || ids.contains(e.id) || words.contains(lower) {
            continue
        }
        shown.append(e)
        ids.insert(e.id)
        words.insert(lower)
    }
    return shown
}

// MARK: - Editor Text & Draft Helpers (app/ui/editor/text.ts, app/ui/editor/drafts.ts)

private let editorHeadingRe = Regex.compile(#"^ {0,3}(#{1,6})(?:\s|$)"#)
private let editorItemRe = Regex.compile(#"^(\s*)([-*+]|\d{1,9}[.)])(?:\s|$)"#)
private let editorListLineRe = Regex.compile(#"^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$"#)
private let editorNumberMarkerRe = Regex.compile(#"^(\d+)([.)])$"#)
private let editorLeadingIndentRe = Regex.compile(#"^\s*"#)
private let editorLeadingTabOrSpaceRe = Regex.compile(#"^[ \t]+"#)
private let looksLikeMdBlockRe = Regex.compile(
    #"^ {0,3}(?:#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>\s?|\|.*\|\s*$)"#,
    options: [.anchorsMatchLines]
)
private let looksLikeMdInlineRe = Regex.compile(
    #"\*\*[^*\n]+\*\*|!\[[^\]\n]*\]\([^)\n]+\)|\[[^\]\n]+\]\([^)\n]+\)"#
)

private func editorIndentOf(_ s: String) -> Int {
    guard let m = Regex.firstMatch(editorLeadingIndentRe, in: s),
          let lead = Regex.group(m, at: 0, in: s) else { return 0 }
    return lead.replacingOccurrences(of: "\t", with: "    ").utf16Count
}

private func editorListLevel(_ rows: [String], _ i: Int) -> Int {
    var indent = editorIndentOf(rows[i])
    var level = 1
    var j = i - 1
    while j >= 0 && indent > 0 {
        let row = rows[j]
        if row.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            j -= 1
            continue
        }
        if Regex.test(editorItemRe, in: row) {
            let own = editorIndentOf(row)
            if own < indent {
                level += 1
                indent = own
            }
        } else if editorIndentOf(row) == 0 {
            break
        }
        j -= 1
    }
    return level
}

/// `lineKindAt(text, pos)` in app/ui/editor/text.ts.
public func lineKindAt(_ text: String, pos: Int) -> LineKind? {
    let rows = text.components(separatedBy: "\n")
    let i = max(0, min(rows.count - 1, text.utf16Slice(0, pos).components(separatedBy: "\n").count - 1))
    let row = rows[i]
    if let h = Regex.firstMatch(editorHeadingRe, in: row),
       let hashes = Regex.group(h, at: 1, in: row) {
        switch hashes.utf16Count {
        case 2: return .h2
        case 3: return .h3
        default: return nil
        }
    }
    guard let item = Regex.firstMatch(editorItemRe, in: row),
          let marker = Regex.group(item, at: 2, in: row) else {
        return .text
    }
    if marker.unicodeScalars.contains(where: { CharacterSet.decimalDigits.contains($0) }) {
        return nil
    }
    let level = editorListLevel(rows, i)
    switch level {
    case 1: return .bullet1
    case 2: return .bullet2
    case 3: return .bullet3
    default: return nil
    }
}

private func starsBefore(_ text: String, at: Int) -> Int {
    let ns = text as NSString
    var n = 0
    while at - n - 1 >= 0 && at - n - 1 < ns.length && ns.character(at: at - n - 1) == 0x2A {
        n += 1
    }
    return n
}

private func starsAfter(_ text: String, at: Int) -> Int {
    let ns = text as NSString
    var n = 0
    while at + n >= 0 && at + n < ns.length && ns.character(at: at + n) == 0x2A {
        n += 1
    }
    return n
}

private func hasStarMark(_ stars: Int, marker: String) -> Bool {
    marker == "**" ? (stars == 2 || stars == 3) : (stars == 1 || stars == 3)
}

private func isWhitespaceUnit(_ unit: unichar) -> Bool {
    guard let scalar = UnicodeScalar(unit) else { return false }
    return CharacterSet.whitespacesAndNewlines.contains(scalar)
}

/// `toggleMark(text, start, end, marker)` in app/ui/editor/text.ts.
public func toggleMark(
    _ text: String,
    start rawStart: Int,
    end rawEnd: Int,
    marker: String
) -> LineEditResult {
    let ns = text as NSString
    let m = marker.utf16Count
    var start = max(0, min(ns.length, rawStart))
    var end = max(start, min(ns.length, rawEnd))
    while start < end && isWhitespaceUnit(ns.character(at: start)) { start += 1 }
    while end > start && isWhitespaceUnit(ns.character(at: end - 1)) { end -= 1 }

    if start == end {
        return LineEditResult(
            text: text.utf16Slice(0, start) + marker + marker + text.utf16Slice(end),
            start: start + m,
            end: start + m
        )
    }

    let outside = min(starsBefore(text, at: start), starsAfter(text, at: end))
    if hasStarMark(outside, marker: marker) {
        return LineEditResult(
            text: text.utf16Slice(0, start - m) + text.utf16Slice(start, end) + text.utf16Slice(end + m),
            start: start - m,
            end: end - m
        )
    }

    let inner = text.utf16Slice(start, end)
    let inside = min(starsAfter(inner, at: 0), starsBefore(inner, at: inner.utf16Count))
    if inner.utf16Count > 2 * inside && hasStarMark(inside, marker: marker) {
        let words = inner.utf16Slice(m, inner.utf16Count - m)
        return LineEditResult(
            text: text.utf16Slice(0, start) + words + text.utf16Slice(end),
            start: start,
            end: start + words.utf16Count
        )
    }

    return LineEditResult(
        text: text.utf16Slice(0, start) + marker + text.utf16Slice(start, end) + marker + text.utf16Slice(end),
        start: start + m,
        end: end + m
    )
}

/// `continueList(text, start, end)` in app/ui/editor/text.ts.
public func continueList(_ text: String, start: Int, end: Int) -> LineEditResult? {
    guard start == end else { return nil }
    let ns = text as NSString
    let clamped = max(0, min(ns.length, start))
    let from: Int
    if clamped == 0 {
        from = 0
    } else {
        let prevRange = ns.range(of: "\n", options: .backwards, range: NSRange(location: 0, length: clamped))
        from = prevRange.location == NSNotFound ? 0 : prevRange.location + 1
    }
    let nextRange = ns.range(of: "\n", options: [], range: NSRange(location: clamped, length: ns.length - clamped))
    let to = nextRange.location == NSNotFound ? ns.length : nextRange.location
    let lineSlice = text.utf16Slice(from, to)
    guard let m = Regex.firstMatch(editorListLineRe, in: lineSlice),
          let indent = Regex.group(m, at: 1, in: lineSlice),
          let marker = Regex.group(m, at: 2, in: lineSlice),
          let gap = Regex.group(m, at: 3, in: lineSlice),
          let words = Regex.group(m, at: 4, in: lineSlice) else {
        return nil
    }
    let contentAt = from + indent.utf16Count + marker.utf16Count + gap.utf16Count
    guard clamped >= contentAt else { return nil }
    if words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        let line = indent.utf16Count >= 2 ? indent.utf16Slice(2) + marker + gap : ""
        let next = text.utf16Slice(0, from) + line + text.utf16Slice(to)
        let at = from + line.utf16Count
        return LineEditResult(text: next, start: at, end: at)
    }
    let nextMarker: String
    if let nMatch = Regex.firstMatch(editorNumberMarkerRe, in: marker),
       let numStr = Regex.group(nMatch, at: 1, in: marker),
       let punct = Regex.group(nMatch, at: 2, in: marker),
       let num = Int(numStr) {
        nextMarker = "\(num + 1)\(punct)"
    } else {
        nextMarker = marker
    }
    let insert = "\n\(indent)\(nextMarker) "
    let at = clamped + insert.utf16Count
    let after = Regex.replaceFirst(editorLeadingTabOrSpaceRe, in: text.utf16Slice(clamped), with: "")
    return LineEditResult(
        text: text.utf16Slice(0, clamped) + insert + after,
        start: at,
        end: at
    )
}

/// `looksLikeMarkdown(text)` in app/ui/editor/text.ts.
public func looksLikeMarkdown(_ text: String) -> Bool {
    Regex.test(looksLikeMdBlockRe, in: text) || Regex.test(looksLikeMdInlineRe, in: text)
}

/// `relativeTime(at, now)` in app/ui/editor/text.ts (`at` and `now` in ms since epoch).
public func relativeTime(_ atMs: Double, nowMs: Double = Date().timeIntervalSince1970 * 1000) -> String {
    let seconds = max(0, (nowMs - atMs) / 1000.0)
    if seconds < 45 { return "a moment ago" }
    let minutes = Int(floor(seconds / 60.0 + 0.5))
    if minutes < 60 { return minutes == 1 ? "a minute ago" : "\(minutes) minutes ago" }
    let hours = Int(floor(Double(minutes) / 60.0 + 0.5))
    if hours < 24 { return hours == 1 ? "an hour ago" : "\(hours) hours ago" }
    let days = Int(floor(Double(hours) / 24.0 + 0.5))
    if days == 1 { return "yesterday" }
    if days < 7 { return "\(days) days ago" }
    return shortDate(Date(timeIntervalSince1970: atMs / 1000.0), now: Date(timeIntervalSince1970: nowMs / 1000.0))
}

public struct SummaryDraft: Codable, Equatable, Sendable {
    public var markdown: String
    public var base: String
    public var at: Double

    public init(markdown: String, base: String, at: Double) {
        self.markdown = markdown
        self.base = base
        self.at = at
    }
}

public func summaryDraftKey(_ lectureId: String) -> String {
    "lockin.summaryDraft.\(lectureId)"
}

public func sameSummary(_ a: String, _ b: String) -> Bool {
    Regex.replaceFirst(trailingSpaceRe, in: a, with: "") == Regex.replaceFirst(trailingSpaceRe, in: b, with: "")
}

// MARK: - Study Actions (app/study-actions.ts)

public enum SummaryPlacement: Equatable, Sendable {
    case section(String?)
    case under(String)
    case start
}

public struct EditOutcome: Equatable, Sendable {
    public var ok: Bool
    public var message: String
    public var conflict: Bool

    public init(ok: Bool, message: String, conflict: Bool = false) {
        self.ok = ok
        self.message = message
        self.conflict = conflict
    }
}

/// `saveSummaryEdit` in app/study-actions.ts.
public func saveSummaryEdit(
    database: LockinDatabase,
    lectureId: String,
    markdown rawMarkdown: String,
    base: String,
    force: Bool = false
) throws -> EditOutcome {
    let markdown = Regex.replaceFirst(trailingSpaceRe, in: rawMarkdown, with: "") + "\n"
    if markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return EditOutcome(ok: false, message: "A summary can't be empty. Use Replace this summary to start again.")
    }
    return try database.writer.write { db in
        guard var lecture = try Lecture.fetchOne(db, key: lectureId) else {
            return EditOutcome(ok: false, message: "This lecture no longer exists.")
        }
        let currentTrimmed = (lecture.summaryMd ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let baseTrimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
        if !force && currentTrimmed != baseTrimmed {
            return EditOutcome(
                ok: false,
                message: "The summary changed since you started editing (an answer was added, or it was rewritten).",
                conflict: true
            )
        }
        lecture.summaryMd = markdown
        try lecture.update(db)
        return EditOutcome(ok: true, message: "Saved.")
    }
}

/// `addToSummary` in app/study-actions.ts.
public func addToSummary(
    database: LockinDatabase,
    lectureId: String,
    markdown rawBlock: String,
    place: SummaryPlacement
) -> EditOutcome {
    let block = rawBlock.trimmingCharacters(in: .whitespacesAndNewlines)
    if block.isEmpty {
        return EditOutcome(ok: false, message: "Nothing to add.")
    }
    do {
        try database.writer.write { db in
            guard var lecture = try Lecture.fetchOne(db, key: lectureId) else {
                throw LockinError(prismaRecordNotFound)
            }
            let md = lecture.summaryMd ?? ""
            let next: String
            switch place {
            case .under(let selection):
                next = insertUnder(md, selection, block)
            case .start:
                next = insertAtStart(md, block)
            case .section(let heading):
                next = insertIntoSection(md, heading, block)
            }
            lecture.summaryMd = next
            try lecture.update(db)
        }
        return EditOutcome(ok: true, message: "Added to the summary.")
    } catch {
        return EditOutcome(ok: false, message: messageOf(error))
    }
}

/// `addLeftOutToSummary` in app/study-actions.ts.
public func addLeftOutToSummary(
    database: LockinDatabase,
    lectureId: String,
    what: String
) throws -> EditOutcome {
    try database.writer.write { db in
        guard var lecture = try Lecture.fetchOne(db, key: lectureId) else {
            return EditOutcome(ok: false, message: "This lecture no longer exists.")
        }
        let list = readSkipped(lecture.skipped)
        guard let item = list.first(where: { $0.what == what }) else {
            return EditOutcome(ok: false, message: "Lockin doesn't know what that part said yet.")
        }
        guard let about = item.about, !about.isEmpty else {
            return EditOutcome(ok: false, message: "Lockin doesn't know what that part said yet.")
        }
        if item.added == true {
            return EditOutcome(ok: true, message: "Already in the summary.")
        }
        lecture.summaryMd = addLeftOut(lecture.summaryMd ?? "", item.what, about)
        let updatedList = list.map { s -> Skipped in
            guard s.what == item.what else { return s }
            var copy = s
            copy.added = true
            return copy
        }
        lecture.skipped = skippedJSON(updatedList).stringified()
        try lecture.update(db)
        return EditOutcome(ok: true, message: "Added to the summary.")
    }
}

/// `setSlideCrop` in app/study-actions.ts.
public func setSlideCrop(
    database: LockinDatabase,
    lectureId: String,
    figure: Int,
    slide: Int,
    crop rawCrop: Crop?
) throws -> EditOutcome {
    let cleaned = rawCrop.flatMap(cleanCrop)
    if rawCrop != nil && cleaned == nil {
        return EditOutcome(ok: false, message: "That's too small to show — drag out a bigger box.")
    }
    return try database.writer.write { db in
        guard var lecture = try Lecture.fetchOne(db, key: lectureId),
              let summaryMd = lecture.summaryMd, !summaryMd.isEmpty else {
            return EditOutcome(ok: false, message: "This lecture has no summary.")
        }
        guard let next = setFigureCrop(md: summaryMd, figure: figure, slide: slide, crop: cleaned) else {
            return EditOutcome(
                ok: false,
                message: "Couldn't find that picture in the summary — it may have just changed. Try again."
            )
        }
        if next != summaryMd {
            lecture.summaryMd = next
            try lecture.update(db)
        }
        return EditOutcome(ok: true, message: cleaned != nil ? "Cropped." : "Showing the whole slide.")
    }
}

/// `addGlossaryTerm` in app/study-actions.ts.
public func addGlossaryTerm(
    database: LockinDatabase,
    lectureId: String,
    term rawTerm: String,
    explanation rawExplanation: String
) throws -> Result<GlossaryEntry, LockinError> {
    let term = cleanTerm(rawTerm)
    let explanation = rawExplanation.trimmingCharacters(in: .whitespacesAndNewlines)
    if term.isEmpty {
        return .failure(LockinError("Select a word or phrase first."))
    }
    if explanation.isEmpty {
        return .failure(LockinError("There's no explanation to keep yet."))
    }
    return try database.writer.write { db in
        let existingAll = try GlossaryTerm
            .filter(Column("lectureId") == lectureId)
            .fetchAll(db)
        if var existing = existingAll.first(where: { $0.term.lowercased() == term.lowercased() }) {
            existing.explanation = explanation
            try existing.update(db)
            return .success(GlossaryEntry(id: existing.id, term: existing.term, explanation: existing.explanation))
        }
        var row = GlossaryTerm(lectureId: lectureId, term: term, explanation: explanation)
        try row.insert(db)
        return .success(GlossaryEntry(id: row.id, term: row.term, explanation: row.explanation))
    }
}

/// `removeGlossaryTerm` in app/study-actions.ts.
public func removeGlossaryTerm(database: LockinDatabase, id: String) throws {
    try database.writer.write { db in
        _ = try GlossaryTerm.deleteOne(db, key: id)
    }
}

public enum AskStartOutcome: Equatable, Sendable {
    case job(String)
    case done(AskResult)
    case error(String)
}

/// `startAsk` in app/study-actions.ts.
public func startAsk(
    database: LockinDatabase,
    payload req: AskPayload
) throws -> AskStartOutcome {
    let (lectureOpt, materials) = try database.reader.read { db -> (Lecture?, [Material]) in
        let lecture = try Lecture.fetchOne(db, key: req.lectureId)
        let materials = try Material
            .filter(Column("lectureId") == req.lectureId)
            .fetchAll(db)
        return (lecture, materials)
    }
    guard let lecture = lectureOpt else {
        return .error("This lecture no longer exists.")
    }

    var payload: AskPayload
    if req.kind == .leftout {
        let what = req.what ?? ""
        guard let item = readSkipped(lecture.skipped).first(where: { $0.what == what }) else {
            return .error("That part is no longer listed — the lecture was prepared again.")
        }
        if let known = item.about ?? knownLeftOut(materials, what: item.what), !known.isEmpty {
            if item.about == nil {
                try saveLeftOut(database: database, lectureId: lecture.id, what: item.what, about: known)
            }
            return .done(AskResult(kind: .leftout, answer: known, section: nil, what: item.what, found: true))
        }
        payload = AskPayload(kind: .leftout, lectureId: lecture.id, what: item.what, where: item.where)
    } else {
        guard let summaryMd = lecture.summaryMd,
              !summaryMd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .error("This lecture has no summary yet — prepare it first.")
        }
        let text = ((req.kind == .question ? req.question : req.selection) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            return .error(req.kind == .question ? "Type a question first." : "Select some text first.")
        }
        if text.utf16Count > maxAsk {
            return .error("That's too long — keep it under 1,500 characters.")
        }
        payload = req.kind == .question
            ? AskPayload(kind: .question, lectureId: lecture.id, question: text)
            : AskPayload(kind: .breakdown, lectureId: lecture.id, selection: text)
    }

    let settings = try getSettings(database: database)
    if !settings.mode.usesAi {
        return .error("No AI runs in copy & paste mode — copy the prompt into your AI chat instead.")
    }
    if try settings.mode == .local && activeLocalModel(database: database) == nil {
        return .error("Download an offline model first, in Settings → Offline AI.")
    }

    let job = try database.writer.write { db in
        try enqueue(db: db, kind: .ask, payload: payload.json, lectureId: lecture.id)
    }
    return .job(job.id)
}

/// Fetches completed ASK question history for a lecture, newest first (matching the lecture page query).
public func fetchAskHistory(database: LockinDatabase, lectureId: String) throws -> [AskHistoryItem] {
    try database.reader.read { db in
        let jobs = try Job
            .filter(Column("lectureId") == lectureId && Column("kind") == JobKind.ask.rawValue && Column("status") == JobStatus.done.rawValue)
            .order(Column("finishedAt").desc, Column("createdAt").desc)
            .fetchAll(db)
        return jobs.compactMap { job in
            guard let rawResult = job.result,
                  let resVal = try? JSONValue.parse(rawResult),
                  let res = AskResult.fromJSON(resVal),
                  res.kind == .question,
                  let payloadVal = try? JSONValue.parse(job.payload),
                  let req = AskPayload.fromJSON(payloadVal) else {
                return nil
            }
            let question = (res.question ?? req.question ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !question.isEmpty, !res.answer.isEmpty else { return nil }
            let at = jsISOString(job.finishedAt ?? job.createdAt)
            return AskHistoryItem(
                id: job.id,
                question: question,
                answer: res.answer,
                section: res.section,
                at: at,
                model: res.model ?? job.model
            )
        }
    }
}
