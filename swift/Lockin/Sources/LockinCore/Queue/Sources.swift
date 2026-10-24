import Foundation

// Port of lib/sources.ts: the text every prompt about a lecture is built from, whether
// the queue sends it or the student copies it into a chat, plus the lecture's stored
// set-aside parts (`Lecture.skipped`) and slide notes (`Lecture.slideNotes`) read back
// tolerantly. `deckPages` and `slideOrder` live in Slides/SlideTypes.swift.

public struct LectureSources: Equatable, Sendable {
    public var transcript: String
    public var slidesText: String?
    /// Aims and objectives slides removed before any model sees the text.
    public var skipped: [Skipped]

    public init(transcript: String, slidesText: String?, skipped: [Skipped]) {
        self.transcript = transcript
        self.slidesText = slidesText
        self.skipped = skipped
    }
}

// MARK: - JavaScript's trim

/// JavaScript's WhiteSpace and LineTerminator characters: what `trim()` removes.
private let pipelineSpace = CharacterSet(
    charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}"
        + "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}"
        + "\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
)

/// `text.trim()`, with JavaScript's idea of white space.
func pipelineTrim(_ text: String) -> String {
    text.trimmingCharacters(in: pipelineSpace)
}

/// `text.trimEnd()`, with JavaScript's idea of white space.
func pipelineTrimEnd(_ text: String) -> String {
    var scalars = text.unicodeScalars
    while let last = scalars.last, pipelineSpace.contains(last) {
        scalars.removeLast()
    }
    return String(scalars)
}

// MARK: - Patterns

// JavaScript's `^` and `$` under the `m` flag see only \n, \r, U+2028 and U+2029 as line
// ends, and its `\d` is ASCII; ICU's differ, so both are spelled out.

/// `/^-{3} (?:Page|Slide) (\d+) -{3}$/gm`
private let sourcesMarkerRe = Regex.compile(
    #"(?<![^\n\r  ])-{3} (?:Page|Slide) ([0-9]+) -{3}(?![^\n\r  ])"#
)

/// `/^--- Slide (\d+) ---\n([\s\S]*?)(?=\n--- Slide \d+ ---|$)/gm`
private let sourcesSlideBlockRe = Regex.compile(
    #"(?<![^\n\r  ])--- Slide ([0-9]+) ---\n([\s\S]*?)(?=\n--- Slide [0-9]+ ---|(?![^\n\r  ]))"#
)

/// `text.replace(re, (match, …) => …)` with the `g` flag: every match, left to right.
private func sourcesReplace(
    _ re: NSRegularExpression,
    in text: String,
    _ transform: (NSTextCheckingResult, NSString) -> String
) -> String {
    let ns = text as NSString
    var out = ""
    var last = 0
    for match in Regex.allMatches(re, in: text) {
        out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
        out += transform(match, ns)
        last = match.range.location + match.range.length
    }
    out += ns.substring(from: last)
    return out
}

/// A capture group's text, or "" when it took no part in the match.
private func sourcesGroup(_ match: NSTextCheckingResult, _ index: Int, _ ns: NSString) -> String {
    guard index < match.numberOfRanges else { return "" }
    let range = match.range(at: index)
    guard range.location != NSNotFound else { return "" }
    return ns.substring(with: range)
}

// MARK: - A lecture's text

/// The text every prompt about a lecture is built from. A transcript split across files
/// is joined in upload order; slides alone still make a lecture. Module aims are stripped
/// from the slides here, at prompt time, so the stored text stays complete.
///
/// Slides are numbered across the lecture ("--- Slide 31 ---" is the first page of a
/// second 30-page deck), the same numbers the slide pictures use.
public func lectureSources(_ materials: [Material]) throws -> LectureSources {
    let transcripts = materials
        .filter { $0.kind == .transcript && !pipelineTrim($0.extractedText ?? "").isEmpty }
        .map { pipelineTrim($0.extractedText ?? "") }

    let slideDecks = materials.filter { $0.kind == .slides }.sorted(by: slideOrder)
    var offset = 0
    var decks: [(text: String, skipped: [Skipped])] = []
    for material in slideDecks {
        let shift = offset
        offset += deckPages(material)
        let text = sourcesReplace(sourcesMarkerRe, in: pipelineTrim(material.extractedText ?? "")) { match, ns in
            // `shift + Number(n)`: only digits were matched, so a failure is an overflow.
            let number = Double(shift) + (Double(sourcesGroup(match, 1, ns)) ?? .infinity)
            return "--- Slide \(jsNumberString(number)) ---"
        }
        decks.append(stripAims(text))
    }
    let joined = decks.map { $0.text }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    let slidesText: String? = joined.isEmpty ? nil : joined
    let skipped = mergeSkipped(decks.flatMap { $0.skipped })

    if !transcripts.isEmpty {
        return LectureSources(transcript: transcripts.joined(separator: "\n\n"), slidesText: slidesText, skipped: skipped)
    }
    if let slidesText {
        return LectureSources(transcript: slidesText, slidesText: nil, skipped: skipped)
    }
    // A deck of pictures: nothing to read as text, but a model that sees the pages can.
    if offset > 0 {
        return LectureSources(
            transcript: "(No transcript, and the slides have no selectable text — work from the slides themselves.)",
            slidesText: nil,
            skipped: skipped
        )
    }
    throw LockinError("this lecture has no transcript or slides with readable text yet")
}

// MARK: - Stored JSON, read tolerantly

/// Parsed `Lecture.skipped`, tolerant of nulls and hand edits (`readSkipped`).
public func readSkipped(_ json: String?) -> [Skipped] {
    guard let json, !json.isEmpty,
          let parsed = try? JSONValue.parse(json),
          case .array(let items) = parsed else { return [] }
    var out: [Skipped] = []
    for item in items {
        guard case .object(let entry) = item, case .string(let what)? = entry["what"] else { continue }
        // `String(s.where ?? "")`
        var place = ""
        if let value = entry["where"], !value.isNull {
            place = jsString(value)
        }
        var about: String? = nil
        if case .string(let raw)? = entry["about"] {
            let trimmed = pipelineTrim(raw)
            if !trimmed.isEmpty {
                about = trimmed
            }
        }
        let added: Bool? = entry["added"]?.boolValue == true ? true : nil
        out.append(Skipped(what: what, where: place, about: about, added: added))
    }
    return out
}

/// Parsed `Lecture.slideNotes`, tolerant of nulls and hand edits (`readSlideNotes`).
public func readSlideNotes(_ json: String?) -> [SlideNote] {
    guard let json, !json.isEmpty,
          let parsed = try? JSONValue.parse(json),
          case .array(let items) = parsed else { return [] }
    var out: [SlideNote] = []
    for item in items {
        // `Number.isInteger(s.slide) && typeof s.notes === "string" && s.notes.trim()`
        guard case .object(let entry) = item,
              case .number(let slide)? = entry["slide"],
              slide.isFinite, slide.rounded(.towardZero) == slide,
              let number = Int(exactly: slide),
              case .string(let notes)? = entry["notes"] else { continue }
        let trimmed = pipelineTrim(notes)
        if trimmed.isEmpty {
            continue
        }
        out.append(SlideNote(slide: number, notes: trimmed))
    }
    return out
}

/// Slide text with what a model saw on each slide written in under it, for an offline
/// model that only reads: the words inside pictures and what each figure shows.
public func withSlideNotes(_ slidesText: String?, _ notes: [SlideNote]) -> String? {
    if notes.isEmpty {
        return slidesText
    }
    guard let slidesText, !pipelineTrim(slidesText).isEmpty else {
        return slideNotesText(notes)
    }
    var bySlide: [Int: String] = [:]
    for note in notes {
        bySlide[note.slide] = note.notes
    }
    var used = Set<Int>()
    let text = sourcesReplace(sourcesSlideBlockRe, in: slidesText) { match, ns in
        let block = ns.substring(with: match.range)
        guard let number = Int(sourcesGroup(match, 1, ns)),
              let seen = bySlide[number], !seen.isEmpty else { return block }
        used.insert(number)
        return "\(pipelineTrimEnd(block))\n[On this slide: \(seen)]\n"
    }
    // Slides with no text at all (pictures only) are not in the text yet.
    let rest = notes.filter { !used.contains($0.slide) }
    return rest.isEmpty ? text : "\(pipelineTrimEnd(text))\n\n\(slideNotesText(rest))"
}

/// Slide notes as the text a prompt reads in place of the extracted slide text.
public func slideNotesText(_ notes: [SlideNote]) -> String {
    notes.map { "--- Slide \($0.slide) ---\n\($0.notes)" }.joined(separator: "\n\n")
}

/// Set-aside parts as `JSON.stringify` writes them into `Lecture.skipped`:
/// `[{"what","where","about"?,"added"?}]`, `about` only when there is one, `added` only when true.
public func skippedJSON(_ items: [Skipped]) -> JSONValue {
    .array(items.map { item -> JSONValue in
        var entry = JSONObject()
        entry["what"] = .string(item.what)
        entry["where"] = .string(item.where)
        if let about = item.about {
            entry["about"] = .string(about)
        }
        if item.added == true {
            entry["added"] = .bool(true)
        }
        return .object(entry)
    })
}
