import Foundation

public struct Skipped: Codable, Equatable, Sendable {
    public var what: String
    public var `where`: String
    public var about: String?
    public var added: Bool?

    public init(what: String, where: String, about: String? = nil, added: Bool? = nil) {
        self.what = what
        self.where = `where`
        self.about = about
        self.added = added
    }
}

// MARK: - UTF-16 & Calendar helpers matching JavaScript semantics

extension Calendar {
    public static let gregorian = Calendar(identifier: .gregorian)
}

extension String {
    /// Length in UTF-16 code units, matching JavaScript's `String.prototype.length`.
    var utf16Count: Int {
        (self as NSString).length
    }

    /// Prefix of at most `maxUnits` UTF-16 code units, matching JavaScript's `str.slice(0, maxUnits)`.
    func utf16Prefix(_ maxUnits: Int) -> String {
        guard maxUnits > 0 else { return "" }
        let ns = self as NSString
        guard ns.length > maxUnits else { return self }
        return ns.substring(to: maxUnits)
    }

    /// Drops the first `units` UTF-16 code units, matching JavaScript's `str.slice(units)`.
    func utf16DropFirst(_ units: Int) -> String {
        guard units > 0 else { return self }
        let ns = self as NSString
        guard units < ns.length else { return "" }
        return ns.substring(from: units)
    }

    /// Slices by UTF-16 code unit indices `[from, to)`, matching JavaScript's `str.slice(from, to)`.
    public func utf16Slice(_ from: Int, _ to: Int? = nil) -> String {
        let ns = self as NSString
        let len = ns.length
        let start = max(0, min(len, from < 0 ? len + from : from))
        let rawEnd = to ?? len
        let end = max(start, min(len, rawEnd < 0 ? len + rawEnd : rawEnd))
        return ns.substring(with: NSRange(location: start, length: end - start))
    }
}

// MARK: - Internal regex helper

enum Regex {
    static func compile(_ pattern: String, options: NSRegularExpression.Options = []) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern, options: options)
    }

    static func test(_ re: NSRegularExpression, in text: String) -> Bool {
        let range = NSRange(location: 0, length: (text as NSString).length)
        return re.firstMatch(in: text, options: [], range: range) != nil
    }

    static func firstMatch(_ re: NSRegularExpression, in text: String) -> NSTextCheckingResult? {
        let range = NSRange(location: 0, length: (text as NSString).length)
        return re.firstMatch(in: text, options: [], range: range)
    }

    static func allMatches(_ re: NSRegularExpression, in text: String) -> [NSTextCheckingResult] {
        let range = NSRange(location: 0, length: (text as NSString).length)
        return re.matches(in: text, options: [], range: range)
    }

    static func group(_ match: NSTextCheckingResult, at index: Int, in text: String) -> String? {
        guard index < match.numberOfRanges else { return nil }
        let nsRange = match.range(at: index)
        guard nsRange.location != NSNotFound else { return nil }
        return (text as NSString).substring(with: nsRange)
    }

    /// Replaces all matches (`String.prototype.replace(/.../g, ...)`).
    static func replace(_ re: NSRegularExpression, in text: String, with template: String) -> String {
        let range = NSRange(location: 0, length: (text as NSString).length)
        return re.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: template)
    }

    /// Replaces only the first match (`String.prototype.replace(/.../, ...)` without `/g`).
    static func replaceFirst(_ re: NSRegularExpression, in text: String, with template: String) -> String {
        let range = NSRange(location: 0, length: (text as NSString).length)
        guard let m = re.firstMatch(in: text, options: [], range: range) else { return text }
        let replacement = re.replacementString(for: m, in: text, offset: 0, template: template)
        return (text as NSString).replacingCharacters(in: m.range, with: replacement)
    }

    /// Splits `text` by matches of `re` (`String.prototype.split(re)` without capturing groups).
    static func split(_ re: NSRegularExpression, in text: String) -> [String] {
        let ns = text as NSString
        let matches = allMatches(re, in: text)
        guard !matches.isEmpty else { return [text] }
        var parts: [String] = []
        var cursor = 0
        for m in matches {
            let r = m.range
            if r.location >= cursor {
                parts.append(ns.substring(with: NSRange(location: cursor, length: r.location - cursor)))
                cursor = r.location + r.length
            }
        }
        parts.append(ns.substring(from: cursor))
        return parts
    }
}

private func aboutOf(_ body: String) -> String {
    let joined = body
        .components(separatedBy: "\n")
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
    return joined.utf16Prefix(900).trimmingCharacters(in: .whitespacesAndNewlines)
}

private let strongLabelRe = Regex.compile(
    "^(?:" +
        [
            #"(?:(?:module|lecture|course|session|unit|week|topic|block)\s*\d*|today'?s?)\s*[:.\-–—]?\s*(?:aims?|objectives?|outcomes?|goals?)"#,
            #"(?:intended\s+)?learning\s+(?:objectives?|outcomes?|goals?|aims?)"#,
            #"ilos?"#,
            #"aims?\s*(?:and|&)\s*(?:objectives|outcomes)"#,
        ].joined(separator: "|") +
        #")\b"#,
    options: [.caseInsensitive]
)

private let weakLabelRe = Regex.compile(#"^(?:aims?|objectives?|outcomes?)\b"#, options: [.caseInsensitive])

private let byTheEndRe = Regex.compile(
    #"^by\s+the\s+end\s+of\s+(?:this|today'?s?|the)\s+(?:module|lecture|session|week|course|topic|class)"#,
    options: [.caseInsensitive]
)

private let headingEndRe = Regex.compile(
    #"^\s*(?:$|[:.\-–—•·*▪●○(]|(?:by|for\s+(?:this|today)|of\s+(?:this|today)|this|today|in\s+this|students?|you|on|upon|at\s+the\s+end|after\s+this|\d)\b)"#,
    options: [.caseInsensitive]
)

private let ableToRe = Regex.compile(
    #"\b(?:be able to|should be able|will be able|students will|you will learn)\b"#,
    options: [.caseInsensitive]
)

private let learningVerbsRe = Regex.compile(
    #"\b(?:understand|describe|explain|identify|outline|discuss|list|define|compare|contrast|apply|recogni[sz]e|appreciate|evaluate|analy[sz]e|summari[sz]e|demonstrate)\b"#,
    options: [.caseInsensitive]
)

private let leadingMarkupRe = Regex.compile(#"^[#*_>\s]+"#)
private let sectionMarkerRe = Regex.compile(
    #"^(?:---\s*(Slide|Page)\s+(\d+)\s*---|(Slide)\s+(\d+)\s*[:.])"#,
    options: [.caseInsensitive, .anchorsMatchLines]
)
private let mdHeadingAtLineStartRe = Regex.compile(#"^#{1,6}\s"#, options: [.anchorsMatchLines])
private let mdHeadingLineRe = Regex.compile(#"^(#{1,6})\s+(.*)$"#)

/// Whether one slide or section is module aims / learning objectives.
public func isAimsSection(_ body: String) -> Bool {
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    let stripped = Regex.replaceFirst(leadingMarkupRe, in: trimmed, with: "")
    let head = stripped.utf16Prefix(240)
    if Regex.test(byTheEndRe, in: head) { return true }

    if let strong = Regex.firstMatch(strongLabelRe, in: head),
       let matched = Regex.group(strong, at: 0, in: head) {
        let rest = head.utf16DropFirst(matched.utf16Count)
        return Regex.test(headingEndRe, in: rest) || Regex.test(ableToRe, in: body.utf16Prefix(800))
    }

    if let weak = Regex.firstMatch(weakLabelRe, in: head),
       let matched = Regex.group(weak, at: 0, in: head) {
        let rest = head.utf16DropFirst(matched.utf16Count)
        if Regex.test(headingEndRe, in: rest) {
            let sample = body.utf16Prefix(800)
            return Regex.test(ableToRe, in: sample) || Regex.allMatches(learningVerbsRe, in: sample).count >= 2
        }
    }
    return false
}

private func labelOf(_ body: String) -> String {
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    let head = Regex.replaceFirst(leadingMarkupRe, in: trimmed, with: "")
    let match = Regex.firstMatch(strongLabelRe, in: head)
        ?? Regex.firstMatch(weakLabelRe, in: head)
        ?? Regex.firstMatch(byTheEndRe, in: head)
    let raw = match.flatMap { Regex.group($0, at: 0, in: head) } ?? "Learning objectives"
    let squashed = Regex.replace(Regex.compile(#"\s+"#), in: raw, with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = squashed.first else { return "Learning objectives" }
    return String(first).uppercased() + squashed.dropFirst()
}

/// Removes aims sections from slide or page text.
public func stripAims(_ text: String) -> (text: String, skipped: [Skipped]) {
    if Regex.test(sectionMarkerRe, in: text) {
        return stripMarkedSections(text)
    }
    if Regex.test(mdHeadingAtLineStartRe, in: text) {
        return stripHeadingSections(text)
    }
    return (text, [])
}

private func stripMarkedSections(_ text: String) -> (text: String, skipped: [Skipped]) {
    let starts = Regex.allMatches(sectionMarkerRe, in: text)
    guard !starts.isEmpty else { return (text, []) }
    var kept: [String] = []
    var skipped: [Skipped] = []

    let nsText = text as NSString
    let preamble = nsText.substring(with: NSRange(location: 0, length: starts[0].range.location))
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if !preamble.isEmpty { kept.append(preamble) }

    for (i, m) in starts.enumerated() {
        let end = i + 1 < starts.count ? starts[i + 1].range.location : nsText.length
        let section = nsText.substring(with: NSRange(location: m.range.location, length: end - m.range.location))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let markerString = nsText.substring(with: m.range)
        let body = section.utf16DropFirst(markerString.utf16Count)
        if isAimsSection(body) {
            let unit = (Regex.group(m, at: 1, in: text) ?? Regex.group(m, at: 3, in: text) ?? "slide").lowercased()
            let num = Regex.group(m, at: 2, in: text) ?? Regex.group(m, at: 4, in: text) ?? "1"
            skipped.append(Skipped(what: labelOf(body), where: "\(unit) \(num)", about: aboutOf(body)))
        } else {
            kept.append(section)
        }
    }

    return (kept.joined(separator: "\n\n"), mergeSkipped(skipped))
}

private func stripHeadingSections(_ text: String) -> (text: String, skipped: [Skipped]) {
    let lines = text.components(separatedBy: "\n")
    var out: [String] = []
    var skipped: [Skipped] = []
    var droppingBelow = 0
    var dropped: [String] = []

    func finish() {
        if !skipped.isEmpty && !dropped.isEmpty {
            skipped[skipped.count - 1].about = aboutOf(dropped.joined(separator: "\n"))
        }
        dropped = []
    }

    for i in 0..<lines.count {
        let line = lines[i]
        if let heading = Regex.firstMatch(mdHeadingLineRe, in: line),
           let hashes = Regex.group(heading, at: 1, in: line),
           let title = Regex.group(heading, at: 2, in: line) {
            let level = hashes.utf16Count
            if droppingBelow > 0 && level > droppingBelow {
                dropped.append(line)
                continue
            }
            if droppingBelow > 0 { finish() }
            droppingBelow = 0
            let upper = min(lines.count, i + 12)
            let bodyLines = [title] + Array(lines[(i + 1)..<upper])
            let body = bodyLines.joined(separator: "\n")
            if isAimsSection(body) {
                droppingBelow = level
                skipped.append(Skipped(what: labelOf(title), where: "section"))
                continue
            }
        }
        if droppingBelow > 0 {
            dropped.append(line)
        } else {
            out.append(line)
        }
    }
    if droppingBelow > 0 { finish() }
    return (out.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), mergeSkipped(skipped))
}

/// Folds repeats of the same label into one entry: "slide 2", "slide 3" -> "slides 2, 3".
public func mergeSkipped(_ items: [Skipped]) -> [Skipped] {
    var order: [String] = []
    var byWhat: [String: [Skipped]] = [:]
    for s in items {
        if byWhat[s.what] == nil { order.append(s.what) }
        byWhat[s.what, default: []].append(s)
    }

    return order.map { what in
        let group = byWhat[what]!
        var unique: [String] = []
        for s in group where !unique.contains(s.where) {
            unique.append(s.where)
        }
        let unit = unique.first?.components(separatedBy: " ").first ?? ""
        let sameUnit = unique.count > 1 && unique.allSatisfy { $0.hasPrefix("\(unit) ") }

        var abouts: [String] = []
        for s in group {
            if let a = s.about?.trimmingCharacters(in: .whitespacesAndNewlines), !a.isEmpty, !abouts.contains(a) {
                abouts.append(a)
            }
        }

        let whereStr = sameUnit
            ? "\(unit)s " + unique.map { String($0.dropFirst(unit.count + 1)) }.joined(separator: ", ")
            : unique.joined(separator: ", ")
        let aboutStr = abouts.isEmpty ? nil : abouts.joined(separator: "\n\n").utf16Prefix(900)
        return Skipped(what: what, where: whereStr, about: aboutStr)
    }
}
