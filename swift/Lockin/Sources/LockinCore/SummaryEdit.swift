import Foundation

/// Small, careful edits to a lecture summary's Markdown (port of `lib/summary-edit.ts`):
/// filing an answer under the right heading, a break-down under the line it explains, and
/// turning lines into headings or dot points at a chosen level.

private let inlineImageRe = Regex.compile(#"!\[([^\]]*)\]\([^)]*\)"#)
private let inlineLinkRe = Regex.compile(#"\[([^\]]*)\]\([^)]*\)"#)
private let inlineHtmlRe = Regex.compile(#"<[^>]+>"#)
private let inlineBoldCodeRe = Regex.compile(#"(\*\*|__|~~|`)"#)
private let inlineEmRe = Regex.compile(#"(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)"#)
private let inlineEscapedRe = Regex.compile(#"\\([\\`*_{}\[\]()#+\-.!|>~])"#)
private let multiSpaceRe = Regex.compile(#"\s+"#)

private let headingLineRe = Regex.compile(#"\A {0,3}(#{1,6})\s+(.*?)\s*#*\s*\z"#)
private let fenceBlockLineRe = Regex.compile(#"\A {0,3}(```|~~~)"#)
private let listItemLineRe = Regex.compile(#"\A(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)\z"#)
private let leadingSpacesRe = Regex.compile(#"\A\s*"#)
private let indentedNonBlankRe = Regex.compile(#"\A\s{2,}\S"#)
private let blankParaSplitRe = Regex.compile(#"\n\s*\n"#)
private let newlineAroundSpaceRe = Regex.compile(#"\s*\n\s*"#)
private let leadingBulletRe = Regex.compile(#"\A[-*+]\s+"#)
private let sentenceEndSplitRe = Regex.compile(#"(?<=[.!?;:])\s"#)
private let trailingWhitespaceRe = Regex.compile(#"\s+\z"#)
private let leadingBlankLineRe = Regex.compile(#"\A\s*\n"#)
private let trailingNewlinesRe = Regex.compile(#"\n*\z"#)
private let aimsWordRe = Regex.compile(#"\b(aims?|objectives?|outcomes?|goals?)\b"#, options: [.caseInsensitive])
private let leadingTwoSpacesRe = Regex.compile(#"\A {1,2}"#)

/// Inline Markdown reduced to its words: what a reader sees, for matching.
public func plainInline(_ s: String) -> String {
    var out = Regex.replace(inlineImageRe, in: s, with: "$1")
    out = Regex.replace(inlineLinkRe, in: out, with: "$1")
    out = Regex.replace(inlineHtmlRe, in: out, with: "")
    out = Regex.replace(inlineBoldCodeRe, in: out, with: "")
    out = Regex.replace(inlineEmRe, in: out, with: "$1$2")
    out = Regex.replace(inlineEscapedRe, in: out, with: "$1")
    out = Regex.replace(multiSpaceRe, in: out, with: " ")
    return pipelineTrim(out)
}

private struct SummaryLine {
    var text: String
    /// Inside a fenced code block, where a `#` is not a heading.
    var code: Bool
}

private func summaryLines(_ md: String) -> [SummaryLine] {
    var inFence = false
    return md.components(separatedBy: "\n").map { text in
        if Regex.test(fenceBlockLineRe, in: text) {
            inFence.toggle()
            return SummaryLine(text: text, code: true)
        }
        return SummaryLine(text: text, code: inFence)
    }
}

private func headingOf(_ line: SummaryLine) -> (level: Int, text: String)? {
    if line.code { return nil }
    guard let m = Regex.firstMatch(headingLineRe, in: line.text),
          let hashes = Regex.group(m, at: 1, in: line.text),
          let rawTitle = Regex.group(m, at: 2, in: line.text) else {
        return nil
    }
    return (level: hashes.utf16Count, text: plainInline(rawTitle))
}

/// The summary's headings, as a reader sees them, in order and without repeats.
public func summaryHeadings(_ md: String) -> [String] {
    var out: [String] = []
    for line in summaryLines(md) {
        if let h = headingOf(line), !h.text.isEmpty, !out.contains(h.text) {
            out.append(h.text)
        }
    }
    return out
}

/// A heading as given back by a model: the exact text, or a near miss in case or spacing.
public func matchHeading(_ md: String, _ wanted: String?) -> String? {
    guard let wanted, !wanted.isEmpty else { return nil }
    let key = plainInline(wanted).lowercased()
    return summaryHeadings(md).first { $0.lowercased() == key }
}

private func joinBlocks(_ before: String, _ block: String, _ after: String) -> String {
    let head = Regex.replaceFirst(trailingWhitespaceRe, in: before, with: "")
    let tail = Regex.replaceFirst(leadingBlankLineRe, in: after, with: "")
    let joined = [head, pipelineTrim(block), tail]
        .filter { !$0.isEmpty }
        .joined(separator: "\n\n")
    return Regex.replaceFirst(trailingNewlinesRe, in: joined, with: "\n")
}

/// Adds a block at the end of the section under `section` — before the next heading of
/// the same or a higher level — or at the end of the summary when there is no such section.
public func insertIntoSection(_ md: String, _ section: String?, _ block: String) -> String {
    let all = summaryLines(md)
    let key: String? = (section?.isEmpty == false) ? plainInline(section!).lowercased() : nil
    let start: Int?
    if let key {
        start = all.firstIndex { headingOf($0)?.text.lowercased() == key }
    } else {
        start = nil
    }
    guard let startIdx = start, let heading = headingOf(all[startIdx]) else {
        return joinBlocks(md, block, "")
    }
    let level = heading.level
    var end = all.count
    for i in (startIdx + 1)..<all.count {
        if let h = headingOf(all[i]), h.level <= level {
            end = i
            break
        }
    }
    let text = all.map(\.text)
    let before = text[0..<end].joined(separator: "\n")
    let after = text[end..<text.count].joined(separator: "\n")
    return joinBlocks(before, block, after)
}

/// Adds a block at the top of the summary, after a leading title heading if it has one.
public func insertAtStart(_ md: String, _ block: String) -> String {
    let all = summaryLines(md)
    let first = all.firstIndex { !pipelineTrim($0.text).isEmpty }
    let h = first.flatMap { headingOf(all[$0]) }
    let text = all.map(\.text)
    if let firstIdx = first, let h, h.level == 1 {
        let before = text[0...(firstIdx)].joined(separator: "\n")
        let after = text[(firstIdx + 1)..<text.count].joined(separator: "\n")
        return joinBlocks(before, block, after)
    }
    return joinBlocks("", block, md)
}

private func indentOf(_ s: String) -> Int {
    guard let m = Regex.firstMatch(leadingSpacesRe, in: s) else { return 0 }
    let prefix = (s as NSString).substring(with: m.range)
    return prefix.replacingOccurrences(of: "\t", with: "    ").utf16Count
}

/// Markdown as dot points one level under an item indented by `indent`: a list keeps
/// its own nesting, and each paragraph of anything else becomes one dot point.
public func asChildPoints(_ block: String, _ indent: Int) -> String {
    let pad = String(repeating: " ", count: max(0, indent))
    let trimmed = pipelineTrim(block)
    let rows = trimmed.components(separatedBy: "\n")
    let allListOrIndented = rows.allSatisfy { r in
        pipelineTrim(r).isEmpty || Regex.test(listItemLineRe, in: r) || Regex.test(indentedNonBlankRe, in: r)
    }
    if allListOrIndented {
        let nonEmpty = rows.filter { !pipelineTrim($0).isEmpty }
        let base = nonEmpty.map(indentOf).min() ?? 0
        return nonEmpty
            .map { r in pad + r.utf16Slice(min(base, indentOf(r))) }
            .joined(separator: "\n")
    }
    return Regex.split(blankParaSplitRe, in: trimmed)
        .map { p in
            let oneLine = Regex.replace(newlineAroundSpaceRe, in: p, with: " ")
            return Regex.replaceFirst(leadingBulletRe, in: oneLine, with: "")
        }
        .map { "\(pad)- \($0)" }
        .joined(separator: "\n")
}

private func findSummaryLine(_ all: [SummaryLine], needle: String) -> Int? {
    func norm(_ s: String) -> String { plainInline(s).lowercased() }
    var tries: [String] = []
    let whole = norm(needle)
    if !whole.isEmpty { tries.append(whole) }
    let firstRaw = needle.components(separatedBy: "\n").first { !pipelineTrim($0).isEmpty } ?? ""
    let firstLine = norm(firstRaw)
    if !firstLine.isEmpty && firstLine != whole { tries.append(firstLine) }
    let sentence = Regex.split(sentenceEndSplitRe, in: firstLine).first ?? ""
    if !sentence.isEmpty && sentence != firstLine { tries.append(sentence) }
    let words = firstLine.components(separatedBy: " ")
    if words.count > 6 {
        tries.append(words.prefix(6).joined(separator: " "))
    }
    for t in tries {
        if let idx = all.firstIndex(where: { !$0.code && norm($0.text).contains(t) }) {
            return idx
        }
    }
    return nil
}

/// Adds a block right under the line that contains `needle` (text the student selected
/// in the rendered summary): as dot points nested under it when that line is a dot
/// point, else as a paragraph after its paragraph.
public func insertUnder(_ md: String, _ needle: String, _ block: String) -> String {
    let all = summaryLines(md)
    let text = all.map(\.text)
    guard let at = findSummaryLine(all, needle: needle) else {
        return joinBlocks(md, block, "")
    }

    if let item = Regex.firstMatch(listItemLineRe, in: text[at]),
       let g1 = Regex.group(item, at: 1, in: text[at]),
       let g2 = Regex.group(item, at: 2, in: text[at]),
       let g3 = Regex.group(item, at: 3, in: text[at]) {
        let indent = indentOf(g1)
        let childIndent = indent + g2.utf16Count + g3.utf16Count
        var end = at + 1
        while end < text.count {
            let row = text[end]
            if !pipelineTrim(row).isEmpty && indentOf(row) <= indent { break }
            if pipelineTrim(row).isEmpty {
                let nextNonBlank = text[(end + 1)..<text.count].first { !pipelineTrim($0).isEmpty }
                if nextNonBlank == nil || indentOf(nextNonBlank!) <= indent { break }
            }
            end += 1
        }
        let children = asChildPoints(block, childIndent)
        let out = Array(text[0..<end]) + [children] + Array(text[end..<text.count])
        return out.joined(separator: "\n")
    }

    var end = at + 1
    while end < text.count
        && !pipelineTrim(text[end]).isEmpty
        && !Regex.test(headingLineRe, in: text[end])
        && !Regex.test(listItemLineRe, in: text[end]) {
        end += 1
    }
    if Regex.test(headingLineRe, in: text[at]) {
        end = at + 1
    }
    return joinBlocks(text[0..<end].joined(separator: "\n"), block, text[end..<text.count].joined(separator: "\n"))
}

/// How a question and its answer read once filed in the summary.
public func formatAnswer(_ question: String, _ answer: String) -> String {
    let q = Regex.replace(multiSpaceRe, in: pipelineTrim(question), with: " ")
    let cleanQ = q.replacingOccurrences(of: "**", with: "")
    return "**\(cleanQ)**\n\n\(pipelineTrim(answer))"
}

/// A left-out part as it goes back into a summary, and whether it goes at the top.
public func leftOutInsert(_ what: String, _ about: String) -> (block: String, atStart: Bool) {
    return (
        block: "## \(pipelineTrim(what))\n\n\(pipelineTrim(about))",
        atStart: Regex.test(aimsWordRe, in: what)
    )
}

/// A left-out part put back: aims and objectives at the top, anything else at the end.
public func addLeftOut(_ md: String, _ what: String, _ about: String) -> String {
    let ins = leftOutInsert(what, about)
    return ins.atStart ? insertAtStart(md, ins.block) : insertIntoSection(md, nil, ins.block)
}

// MARK: - The Markdown editor's line tools

public enum LineKind: String, Codable, CaseIterable, Sendable {
    case text
    case h2
    case h3
    case bullet1
    case bullet2
    case bullet3

    public var prefix: String {
        switch self {
        case .text: return ""
        case .h2: return "## "
        case .h3: return "### "
        case .bullet1: return "- "
        case .bullet2: return "  - "
        case .bullet3: return "    - "
        }
    }
}

public struct LineEditResult: Equatable, Sendable {
    public var text: String
    public var start: Int
    public var end: Int

    public init(text: String, start: Int, end: Int) {
        self.text = text
        self.start = start
        self.end = end
    }
}

private func touchedLines(_ text: String, start: Int, end: Int) -> (Int, Int) {
    let first = text.utf16Slice(0, start).components(separatedBy: "\n").count - 1
    let ns = text as NSString
    let adjustedEnd: Int
    if end > start && end <= ns.length && ns.substring(with: NSRange(location: end - 1, length: 1)) == "\n" {
        adjustedEnd = end - 1
    } else {
        adjustedEnd = end
    }
    let last = text.utf16Slice(0, max(start, adjustedEnd)).components(separatedBy: "\n").count - 1
    return (first, last)
}

private func lineStartOffset(_ rows: [String], _ index: Int) -> Int {
    guard index > 0 else { return 0 }
    return rows[0..<min(index, rows.count)].reduce(0) { $0 + $1.utf16Count + 1 }
}

private func bareLine(_ row: String) -> String {
    if let h = Regex.firstMatch(headingLineRe, in: row), let title = Regex.group(h, at: 2, in: row) {
        return title
    }
    if let li = Regex.firstMatch(listItemLineRe, in: row), let body = Regex.group(li, at: 4, in: row) {
        return body
    }
    return Regex.replaceFirst(leadingSpacesRe, in: row, with: "")
}

/// Turns every line a selection touches into one kind: plain text, a heading, or a dot
/// point at level 1, 2 or 3. Blank lines stay blank.
public func setLineKind(_ text: String, _ start: Int, _ end: Int, _ kind: LineKind) -> LineEditResult {
    var rows = text.components(separatedBy: "\n")
    let (first, last) = touchedLines(text, start: start, end: end)
    if first <= last {
        for i in first...min(last, rows.count - 1) {
            if pipelineTrim(rows[i]).isEmpty { continue }
            rows[i] = kind.prefix + bareLine(rows[i])
        }
    }
    let out = rows.joined(separator: "\n")
    let from = lineStartOffset(rows, first)
    let clampedLast = min(last, max(0, rows.count - 1))
    let to = lineStartOffset(rows, clampedLast) + (rows.isEmpty ? 0 : rows[clampedLast].utf16Count)
    return LineEditResult(text: out, start: from, end: to)
}

/// Tab and Shift+Tab: moves the dot points a selection touches one level in or out (two spaces).
public func shiftLines(_ text: String, _ start: Int, _ end: Int, _ direction: Int) -> LineEditResult {
    var rows = text.components(separatedBy: "\n")
    let (first, last) = touchedLines(text, start: start, end: end)
    var delta0 = 0
    var delta = 0
    if first <= last {
        for i in first...min(last, rows.count - 1) {
            if !Regex.test(listItemLineRe, in: rows[i]) { continue }
            let before = rows[i].utf16Count
            if direction == 1 {
                rows[i] = "  " + rows[i]
            } else {
                rows[i] = Regex.replaceFirst(leadingTwoSpacesRe, in: rows[i], with: "")
            }
            let change = rows[i].utf16Count - before
            if i == first { delta0 = change }
            delta += change
        }
    }
    let lineFrom = lineStartOffset(rows, first)
    return LineEditResult(
        text: rows.joined(separator: "\n"),
        start: max(lineFrom, start + delta0),
        end: max(lineFrom, end + delta)
    )
}
