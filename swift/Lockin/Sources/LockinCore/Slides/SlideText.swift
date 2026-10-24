import Foundation

/// A deck's stored text is one section per page with text ("--- Page 3 ---"). Pages that
/// are pictures have no section until text recognition reads them (Slides/SlideOCR.swift).
/// Pure, so it can be tested without either (lib/slidetext.ts).

/// `/^-{3} (?:Page|Slide) (\d+) -{3}$/m`. JavaScript's `^` and `$` under the `m` flag see
/// only \n, \r, U+2028 and U+2029 as line ends, and its `\d` is ASCII; ICU's differ, so
/// both are spelled out.
private let slideSectionRe = Regex.compile(
    #"(?<![^\n\r  ])-{3} (?:Page|Slide) ([0-9]+) -{3}(?![^\n\r  ])"#
)

/// What a picture-only page records when nothing could be read from it (`NO_WORDS`).
public let noWordsText = "(no text — image or diagram only)"

/// What a page read from its picture starts with (`READ_FROM_IMAGE`).
private let readFromImageText = "(words read from the slide's picture)"

/// One page read by text recognition: its 1-based page in the deck and the cleaned words,
/// "" when there were none.
public struct ReadPage: Equatable, Sendable {
    public var page: Int
    public var text: String

    public init(page: Int, text: String) {
        self.page = page
        self.text = text
    }
}

// MARK: - JavaScript's white space

/// JavaScript's WhiteSpace and LineTerminator characters: what `trim()` removes and `\s`
/// matches. Not Foundation's set, which adds U+0085 and leaves out U+FEFF.
private func isSlideTextSpace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
        return true
    default:
        return false
    }
}

/// `text.trim()`.
func slideTextTrim(_ text: String) -> String {
    let scalars = Array(text.unicodeScalars)
    var start = 0
    var end = scalars.count
    while start < end && isSlideTextSpace(scalars[start]) {
        start += 1
    }
    while end > start && isSlideTextSpace(scalars[end - 1]) {
        end -= 1
    }
    if start == 0 && end == scalars.count {
        return text
    }
    var kept = String.UnicodeScalarView()
    kept.append(contentsOf: scalars[start..<end])
    return String(kept)
}

/// `text.split(separator)` on single characters, keeping empty pieces unless told not to
/// (`split(/\s+/)` followed by dropping the empty ones).
private func slideTextSplit(_ text: String, omittingEmpty: Bool, where isSeparator: (Unicode.Scalar) -> Bool) -> [String] {
    var parts: [String] = []
    var current = String.UnicodeScalarView()
    for scalar in text.unicodeScalars {
        if isSeparator(scalar) {
            if !(omittingEmpty && current.isEmpty) {
                parts.append(String(current))
            }
            current = String.UnicodeScalarView()
        } else {
            current.append(scalar)
        }
    }
    if !(omittingEmpty && current.isEmpty) {
        parts.append(String(current))
    }
    return parts
}

/// `/[a-z0-9]/i` without the `u` flag: ASCII letters and digits only.
private func isASCIIAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x30...0x39, 0x41...0x5A, 0x61...0x7A:
        return true
    default:
        return false
    }
}

private func asciiAlphanumericCount(_ text: String) -> Int {
    var count = 0
    for scalar in text.unicodeScalars where isASCIIAlphanumeric(scalar) {
        count += 1
    }
    return count
}

// MARK: - A deck's sections

/// `sections(text)`: each page's text by its number, as a JS `Map<number, string>` — a
/// number set again keeps its place and takes the new text.
private struct SlideSections {
    private(set) var numbers: [Double] = []
    private var bodies: [Double: String] = [:]

    func has(_ number: Double) -> Bool {
        bodies[number] != nil
    }

    mutating func set(_ number: Double, _ body: String) {
        if bodies[number] == nil {
            numbers.append(number)
        }
        bodies[number] = body
    }

    /// `[...all].sort((a, b) => a[0] - b[0])`.
    var ascending: [(number: Double, body: String)] {
        numbers
            .sorted()
            .map { (number: $0, body: bodies[$0] ?? "") }
    }
}

/// `text.split(SECTION_gm)` read in pairs: a marker's number, then the text up to the next
/// marker, trimmed. Text before the first marker is not a page and is left out.
private func slideSections(_ text: String) -> SlideSections {
    var out = SlideSections()
    let ns = text as NSString
    let matches = Regex.allMatches(slideSectionRe, in: text)
    for (index, match) in matches.enumerated() {
        let bodyStart = match.range.location + match.range.length
        let bodyEnd = index + 1 < matches.count ? matches[index + 1].range.location : ns.length
        let body = ns.substring(with: NSRange(location: bodyStart, length: max(0, bodyEnd - bodyStart)))
        // Number("007") is 7: both markers are the same page.
        let number = jsNumberValue(.string(Regex.group(match, at: 1, in: text) ?? ""))
        out.set(number, slideTextTrim(body))
    }
    return out
}

// MARK: - lib/slidetext.ts

/// Pages with no section of their own yet: pictures nobody has read (`blankPages`).
public func blankPages(_ text: String, pages: Int) -> [Int] {
    guard pages > 0 else {
        return []
    }
    let have = slideSections(text)
    return (1...pages).filter { !have.has(Double($0)) }
}

/// Text recognition reads shapes and icons as stray symbols ("@®"); keep only the words,
/// and lines with enough of them to mean something (`cleanOcr`).
public func cleanOcr(_ raw: String) -> String {
    let lines = slideTextSplit(raw, omittingEmpty: false) { $0 == "\n" }
        .map { line -> String in
            slideTextSplit(line, omittingEmpty: true, where: isSlideTextSpace)
                .filter { word in word.unicodeScalars.contains(where: isASCIIAlphanumeric) }
                .joined(separator: " ")
        }
        .filter { asciiAlphanumericCount($0) >= 2 }
    return slideTextTrim(lines.joined(separator: "\n"))
}

/// Puts newly read pages into a deck's text, every page in order (`mergePages`). A page
/// read with no words is marked so, and so never read again.
public func mergePages(_ text: String, read: [ReadPage]) -> String {
    var all = slideSections(text)
    for page in read {
        all.set(Double(page.page), page.text.isEmpty ? noWordsText : "\(readFromImageText)\n\(page.text)")
    }
    return all.ascending
        .map { "--- Page \(jsNumberString($0.number)) ---\n\($0.body)" }
        .joined(separator: "\n\n")
}
