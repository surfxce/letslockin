import Foundation

/// A stand-in that returns plausible, deterministic output after a short delay, so the
/// queue, progress display and every screen can be exercised without a real AI (port of
/// `lib/llm/fake.ts`; `LOCKIN_PROVIDER=fake`). It never pretends to understand the
/// lecture: titles and concepts are lifted from the text, and marks follow answer length.
public final class FakeProvider: LLMProvider, @unchecked Sendable {
    public let name = "fake"
    public let seesSlides = false
    public let lastModel = "Fake (development)"
    public let lastPromptVersion = "fake@0"
    /// How long each call takes (`LOCKIN_FAKE_DELAY_MS`, 1500 by default).
    public let delayMs: Int
    private let report = ProviderReport()

    public init(delayMs: Int? = nil, environment: [String: String] = ProcessInfo.processInfo.environment) {
        if let delayMs {
            self.delayMs = max(0, delayMs)
        } else if let raw = environment["LOCKIN_FAKE_DELAY_MS"] {
            // `Number(raw)` handed to setTimeout, which waits 1 ms for anything below 1 or
            // past its limit (NaN included).
            let parsed = jsNumberValue(.string(raw))
            self.delayMs = parsed >= 1 && parsed <= 2_147_483_647 ? Int(parsed) : 1
        } else {
            self.delayMs = 1500
        }
    }

    public var onProgress: (@Sendable (String?) -> Void)? {
        get { report.onProgress }
        set { report.onProgress = newValue }
    }

    /// Stands in for a model call, so it stops on cancel the way a real one does.
    private func wait() async throws {
        if delayMs > 0 {
            try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
        } else {
            try Task.checkCancellation()
        }
    }

    public func digest(_ input: DigestInput) async throws -> LectureDigest {
        try await wait()
        let spoken = Regex.replace(fakeStampRe, in: input.transcript, with: "")
        let sentences = fakeSplit(spoken, fakeSentenceEndRe)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.utf16Count > 30 }
        let phrases = Array(keyPhrases(sentences.joined(separator: " ")).prefix(6))

        // Shows the first two slides with text, so the slide pictures can be tried too.
        let slidesText = input.slidesText ?? ""
        var slides: [SlideNote] = []
        for match in Regex.allMatches(fakeSlideRe, in: slidesText) {
            if slides.count >= 2 { break }
            guard let number = Regex.group(match, at: 1, in: slidesText).flatMap({ Int($0) }),
                  let line = Regex.group(match, at: 2, in: slidesText) else { continue }
            slides.append(SlideNote(slide: number, notes: line.trimmingCharacters(in: .whitespacesAndNewlines)))
        }

        let titled = phrases.prefix(2).map { capitalizeFirst($0) }.joined(separator: " & ")
        let title = input.titleIsPlaceholder ? (titled.isEmpty ? "Untitled lecture" : titled) : input.currentTitle

        var lines: [String] = ["## Key points"]
        lines.append(contentsOf: sentences.prefix(6).map { "- \($0)" })
        for slide in slides {
            lines.append("")
            lines.append("![\(slide.notes)](slide:\(slide.slide))")
        }
        lines.append("")
        lines.append("## In more detail")
        let detail = Array(sentences.dropFirst(6).prefix(6)).joined(separator: " ")
        lines.append(detail.isEmpty ? "(The fake provider only repeats the transcript.)" : detail)

        let concepts = phrases.map { phrase -> DigestConcept in
            let name = capitalizeFirst(phrase)
            let existing = input.existingConcepts.first { $0.name.lowercased() == phrase }
            let definition = sentences.first { $0.lowercased().contains(phrase) } ?? "\(name), as covered in this lecture."
            return DigestConcept(existingId: existing?.id, name: name, definition: definition, sourceRef: nil)
        }

        return LectureDigest(
            title: title,
            skipped: [],
            summaryMd: lines.joined(separator: "\n"),
            concepts: concepts,
            slideNotes: slides
        )
    }

    public func generateQuestions(_ input: GenerateQuestionsInput) async throws -> QuestionSet {
        try await wait()
        var byId: [String: ConceptRef] = [:]
        for concept in input.concepts {
            byId[concept.id] = concept
        }
        var questions: [GeneratedQuestion] = []
        for allocation in input.allocation {
            guard let concept = byId[allocation.conceptId] else { continue }
            for i in 0..<max(0, allocation.count) {
                let stem: String
                if input.style == .story {
                    stem = "Jane has just eaten a large breakfast. Explain what \(concept.name) does in her body over the next few hours."
                } else if i == 0 {
                    stem = "Explain \(concept.name) and why it matters in this lecture."
                } else {
                    stem = "Using an example, describe how \(concept.name) would change under different conditions."
                }
                let rubric = Rubric(
                    modelAnswer: concept.definition,
                    criteria: [
                        RubricCriterion(point: "Defines \(concept.name) accurately", marks: 4),
                        RubricCriterion(point: "Explains the mechanism in the lecturer's terms", marks: 4),
                        RubricCriterion(point: "Gives a relevant example", marks: 2),
                    ]
                )
                questions.append(GeneratedQuestion(stem: stem, type: input.type, conceptIds: [allocation.conceptId], rubric: rubric))
            }
        }
        return QuestionSet(questions: questions)
    }

    public func mark(_ input: MarkInput) async throws -> Marking {
        try await wait()
        let words = input.answerText.split(whereSeparator: { $0.isWhitespace }).count
        let mark = min(10, jsMathRound(Double(words) / 6))
        let coverage = min(6, jsMathRound(mark * 0.6))
        var gaps: [MarkingGap] = []
        if let concept = input.concepts.first, mark < 8 {
            gaps.append(MarkingGap(conceptId: concept.id, type: .missed, text: concept.definition))
        }
        return Marking(
            mark: mark,
            criteria: [
                MarkingCriterion(point: "Coverage", awarded: coverage, outOf: 6, note: nil),
                MarkingCriterion(point: "Accuracy", awarded: mark - coverage, outOf: 4, note: nil),
            ],
            gaps: gaps
        )
    }

    public func parsePastPaper(_ input: ParsePastPaperInput) async throws -> PaperItems {
        try await wait()
        return PaperItems(items: [])
    }

    /// Sorts by filename, as the import screen does without AI, so the flow can be tried.
    public func sortFiles(_ input: SortFilesInput) async throws -> FolderSort {
        try await wait()
        let grouped = groupFiles(
            input.files.map { file in
                GroupInput(
                    relativePath: file.path,
                    kind: file.detail.hasPrefix("transcript") ? "TRANSCRIPT" : "SLIDES",
                    modifiedOn: Date(timeIntervalSince1970: 0),
                    measuredHours: nil
                )
            }
        )
        var lectures: [FolderSortLecture] = []
        var setAside: [FolderSortSetAside] = []
        for lecture in grouped {
            if let reason = lecture.setAside {
                if let first = lecture.fileIndexes.first {
                    setAside.append(FolderSortSetAside(file: first + 1, reason: reason))
                }
            } else {
                lectures.append(
                    FolderSortLecture(title: lecture.title, module: lecture.moduleTitle, files: lecture.fileIndexes.map { $0 + 1 })
                )
            }
        }
        return FolderSort(lectures: lectures, setAside: setAside)
    }

    /// Echoes the summary back: enough to try asking, breaking down and adding.
    public func ask(_ input: AskInput) async throws -> Answer {
        try await wait()
        switch input {
        case .leftout(let ask):
            let place = ask.where.isEmpty ? "somewhere" : ask.where
            return Answer(answer: "What the lecture said under \"\(ask.what)\" (\(place)).", section: nil)
        case .breakdown(let ask):
            let sentences = summarySentences(ask.summary)
            let lead = sentences.first ?? "the summary says little more about it."
            return Answer(answer: "**In short:** \"\(ask.selection.utf16Prefix(80))\" — \(lead)", section: nil)
        case .question(let ask):
            let sentences = summarySentences(ask.summary)
            let lowered = ask.question.lowercased()
            let words = Regex.allMatches(fakeQuestionWordRe, in: lowered).map { (lowered as NSString).substring(with: $0.range) }
            let related = Array(sentences.filter { s in words.contains { s.lowercased().contains($0) } }.prefix(3))
            let chosen = related.isEmpty ? Array(sentences.prefix(2)) : related
            let answer = chosen.map { "- \($0)" }.joined(separator: "\n")
            let section = ask.headings.first { h in words.contains { h.lowercased().contains($0) } } ?? ask.headings.first
            return Answer(answer: answer.isEmpty ? "- The summary does not say." : answer, section: section)
        }
    }
}

// MARK: - Helpers

private let fakeStampRe = Regex.compile(#"\[(?:\d+:)?\d{2}:\d{2}\]"#)
private let fakeSentenceEndRe = Regex.compile(#"(?<=[.!?])\s+"#)
private let fakeSlideRe = Regex.compile(#"^-{3} Slide (\d+) -{3}\n(.+)$"#, options: [.anchorsMatchLines])
private let fakeWordRe = Regex.compile(#"[a-z][a-z-]{2,}"#)
private let fakeQuestionWordRe = Regex.compile(#"[a-z]{4,}"#)
private let fakeSkipLineRe = Regex.compile(#"^\s*(?:#|!\[|\||>)"#)
private let fakeBulletRe = Regex.compile(#"^\s*(?:[-*+]|\d+[.)])\s+"#)
private let fakeEmphasisRe = Regex.compile(#"\*\*|\*"#)

/// `text.split(regex)`, for a pattern that never matches the empty string.
private func fakeSplit(_ text: String, _ re: NSRegularExpression) -> [String] {
    let ns = text as NSString
    var parts: [String] = []
    var last = 0
    for match in Regex.allMatches(re, in: text) {
        parts.append(ns.substring(with: NSRange(location: last, length: match.range.location - last)))
        last = match.range.location + match.range.length
    }
    parts.append(ns.substring(from: last))
    return parts
}

/// `s.charAt(0).toUpperCase() + s.slice(1)`.
private func capitalizeFirst(_ text: String) -> String {
    guard let first = text.first else { return text }
    return String(first).uppercased() + text.dropFirst()
}

/// The summary's sentences, line by line first: a dot point is a sentence of its own even
/// without a full stop.
private func summarySentences(_ summary: String) -> [String] {
    var out: [String] = []
    for line in summary.components(separatedBy: "\n") {
        if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || Regex.test(fakeSkipLineRe, in: line) {
            continue
        }
        let unbulleted = Regex.replaceFirst(fakeBulletRe, in: line, with: "")
        for piece in fakeSplit(unbulleted, fakeSentenceEndRe) {
            let plain = Regex.replace(fakeEmphasisRe, in: piece, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            if plain.utf16Count > 20 {
                out.append(plain)
            }
        }
    }
    return out
}

private let fakeStopWords: Set<String> = Set(
    ("the and that this with from have for are was but not you your our they them then than when what which there " +
        "their about into just also only some more most very will would could should been being does doing done like " +
        "make sure know right okay today time thing things want going really here where because other first second " +
        "next quick much many each every both lot lots get gets got way ways one two three four come comes")
        .components(separatedBy: " ")
)

/// The transcript's most repeated two-word terms, then single words: a crude stand-in for "topics".
private func keyPhrases(_ text: String) -> [String] {
    let lowered = text.lowercased()
    let ns = lowered as NSString
    let words = Regex.allMatches(fakeWordRe, in: lowered).map { ns.substring(with: $0.range) }

    // Most frequent first; ties keep the order first seen, as a JavaScript Map sorted stably does.
    func ranked(_ items: [String]) -> [String] {
        var counts: [String: Int] = [:]
        var order: [String] = []
        for item in items {
            if counts[item] == nil {
                order.append(item)
            }
            counts[item, default: 0] += 1
        }
        var ranking: [(offset: Int, word: String, seen: Int)] = []
        for (offset, word) in order.enumerated() {
            ranking.append((offset: offset, word: word, seen: counts[word] ?? 0))
        }
        ranking.sort { a, b in
            if a.seen != b.seen {
                return a.seen > b.seen
            }
            return a.offset < b.offset
        }
        return ranking.map { $0.word }
    }

    var bigrams: [String] = []
    if words.count > 1 {
        for i in 1..<words.count {
            let a = words[i - 1]
            let b = words[i]
            if !fakeStopWords.contains(a) && !fakeStopWords.contains(b) {
                bigrams.append("\(a) \(b)")
            }
        }
    }
    let singles = words.filter { !fakeStopWords.contains($0) && $0.utf16Count > 4 }
    var picked = Array(ranked(bigrams).prefix(4))
    for word in ranked(singles) {
        if picked.count >= 8 { break }
        if !picked.contains(where: { $0.contains(word) }) {
            picked.append(word)
        }
    }
    return picked
}
