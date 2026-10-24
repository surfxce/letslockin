import Foundation

/// A part of a summary to read aloud: its heading and what's under it, as plain speech.
public struct ReadableSection: Hashable, Sendable {
    public var heading: String
    public var text: String

    public init(heading: String, text: String) {
        self.heading = heading
        self.text = text
    }
}

private func replacing(_ text: String, _ pattern: String, with template: String, options: NSRegularExpression.Options = [.caseInsensitive, .dotMatchesLineSeparators]) -> String {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return text }
    return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
}

/// HTML entities as their characters: the named few summaries use, and numeric ones.
func decodeEntities(_ text: String) -> String {
    var out = text
    for (entity, char) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&rarr;", "→"), ("&larr;", "←"), ("&uarr;", "↑"), ("&darr;", "↓"), ("&ndash;", "–"), ("&mdash;", "—"), ("&hellip;", "…")] {
        out = out.replacingOccurrences(of: entity, with: char)
    }
    if let regex = try? NSRegularExpression(pattern: "&#(x?)([0-9a-fA-F]+);") {
        let source = out as NSString
        var result = ""
        var last = 0
        for match in regex.matches(in: out, range: NSRange(location: 0, length: source.length)) {
            result += source.substring(with: NSRange(location: last, length: match.range.location - last))
            let hex = source.substring(with: match.range(at: 1)) == "x"
            let digits = source.substring(with: match.range(at: 2))
            if let code = UInt32(digits, radix: hex ? 16 : 10), let scalar = Unicode.Scalar(code) {
                result += String(Character(scalar))
            }
            last = match.range.location + match.range.length
        }
        result += source.substring(from: last)
        out = result
    }
    return out.replacingOccurrences(of: "&amp;", with: "&")
}

/// Shorthand that reads badly aloud, said in words.
func speakable(_ text: String) -> String {
    var out = text
    for (symbol, words) in [("→", " leads to "), ("⇒", " so "), ("←", " from "), ("↑", " increased "), ("↓", " decreased "), ("≈", " about "),
                            ("≥", " at least "), ("≤", " at most "), (">", " more than "), ("<", " less than "), ("±", " plus or minus "),
                            ("·", ", "), ("e.g.", "for example"), ("i.e.", "that is"), ("vs.", "versus"), ("&", " and ")] {
        out = out.replacingOccurrences(of: symbol, with: words)
    }
    return out
}

/// A rendered summary (the computer's HTML) as sections to read aloud: each heading with
/// what's under it. Slide pictures, buttons and empty headings are left out.
public func readableSections(html: String, title: String = "") -> [ReadableSection] {
    var body = html
    for tag in ["script", "style", "figure", "button", "figcaption", "svg"] {
        body = replacing(body, "<\(tag)\\b[^>]*>.*?</\(tag)>", with: " ")
    }
    body = replacing(body, "<img\\b[^>]*>", with: " ")
    // Each heading starts a section; mark it so the text can be split there.
    body = replacing(body, "<h[1-4]\\b[^>]*>(.*?)</h[1-4]>", with: "\u{1}$1\u{2}")
    // Ends of blocks are ends of sentences when spoken.
    body = replacing(body, "</(p|li|tr|div|blockquote|dd|dt)>|<br\\s*/?>", with: ". ")
    body = replacing(body, "<[^>]+>", with: " ")
    body = decodeEntities(body)

    func clean(_ text: String) -> String {
        var t = speakable(text)
        t = replacing(t, "\\s+", with: " ", options: [])
        t = replacing(t, "(\\s*\\.\\s*){2,}", with: ". ", options: [])
        t = replacing(t, "\\s+([.,;:!?])", with: "$1", options: [])
        t = t.trimmingCharacters(in: CharacterSet(charactersIn: " .")).trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "" : t + "."
    }

    var sections: [ReadableSection] = []
    var heading = title
    for chunk in body.components(separatedBy: "\u{1}") {
        let parts = chunk.components(separatedBy: "\u{2}")
        let text: String
        if parts.count > 1 {
            heading = clean(parts[0]).trimmingCharacters(in: CharacterSet(charactersIn: "."))
            text = parts.dropFirst().joined(separator: " ")
        } else {
            text = parts[0]
        }
        let said = clean(text)
        if !said.isEmpty { sections.append(ReadableSection(heading: heading, text: said)) }
    }
    return sections
}
