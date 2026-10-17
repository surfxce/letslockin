import Foundation

/// The shape every cloud engine shares (port of `lib/llm/base.ts`): a versioned prompt
/// goes in, JSON comes out, is validated, and one bad reply gets a repair pass before the
/// job fails. An engine only says how it sends a prompt (and the slides) and gets text back.

/// What a call is for. Quick work — sorting files, a question asked on a lecture page —
/// needs little thought (`Task` in TypeScript).
public enum LLMTask: String, Sendable {
    case digest
    case questions
    case mark
    case paper
    case sort
    case ask

    public var isQuick: Bool { self == .sort || self == .ask }
}

public func isQuick(_ task: LLMTask) -> Bool {
    task.isQuick
}

/// What a call needs beyond its prompt text.
public struct CallOptions: Equatable, Sendable {
    public var task: LLMTask
    /// The lecture's slide decks, for an engine that looks at them; only on digests, and
    /// only when the engine sees slides and a deck is a PDF with pages.
    public var slides: SlidesInfo?

    public init(task: LLMTask, slides: SlidesInfo? = nil) {
        self.task = task
        self.slides = slides
    }
}

public struct Reply: Equatable, Sendable {
    public var text: String
    /// The model that wrote it, when the engine says.
    public var model: String?

    public init(text: String, model: String? = nil) {
        self.text = text
        self.model = model
    }
}

/// A cloud engine: conform, give `complete` and `label`, and every `LLMProvider` method
/// comes from the extension below (`PromptProvider` in TypeScript).
///
///     public final class CodexProvider: PromptProvider, @unchecked Sendable {
///         public let name = "codex-cli"
///         public let seesSlides = true
///         public let report = ProviderReport()
///         public func label(model: String?) -> String { … }
///         public func complete(_ prompt: String, options: CallOptions) async throws -> Reply { … }
///     }
public protocol PromptProvider: LLMProvider {
    /// Holds `lastPromptVersion`, `lastModel` and `onProgress` (set `report.lastModel =
    /// label(model: nil)` in init, as the TypeScript constructors do).
    var report: ProviderReport { get }
    /// Where the prompts are read from; defaults to `LockinPaths.promptsDirectory`.
    var promptsDirectory: URL { get }
    /// Claude Code repairs after any failure, not only an unparseable reply
    /// (`ClaudeCliProvider.call`); defaults to false.
    var repairsAnyFailure: Bool { get }
    /// Sends one prompt and returns the reply's text. Throws `CloudError` on failure and
    /// `CancellationError` when the task is cancelled (killing any process it started).
    func complete(_ prompt: String, options: CallOptions) async throws -> Reply
    /// How this engine's replies are credited: "ChatGPT Codex · gpt-…".
    func label(model: String?) -> String
}

extension PromptProvider {
    public var promptsDirectory: URL { LockinPaths.promptsDirectory }

    public var repairsAnyFailure: Bool { false }

    public var lastPromptVersion: String { report.lastPromptVersion }

    public var lastModel: String { report.lastModel }

    public var onProgress: (@Sendable (String?) -> Void)? {
        get { report.onProgress }
        set { report.onProgress = newValue }
    }

    /// Renders the prompt, sends it, and parses the reply against `type`. One failure gets
    /// a repair pass; a failure to reach the engine is not fixed by asking again.
    /// `append` goes after the rendered prompt, before any repair note.
    public func call<T: LLMOutput>(
        _ prompt: PromptName,
        vars: [String: String],
        as type: T.Type,
        options: CallOptions,
        append: String = ""
    ) async throws -> T {
        let rendered = try renderPrompt(prompt, vars: vars, directory: promptsDirectory)
        report.lastPromptVersion = rendered.version
        let text = rendered.text + append
        do {
            return try await attemptCall(text, as: type, options: options)
        } catch {
            if error is CancellationError || Task.isCancelled {
                throw error
            }
            if !repairsAnyFailure, let cloud = error as? CloudError, !cloud.isUnusableReply {
                throw error
            }
            let why = messageOf(error)
            let repair = "\n\nYour previous reply could not be used: \(why)\n"
                + "Reply again with valid JSON matching the schema exactly. No prose, no code fences."
            return try await attemptCall(text + repair, as: type, options: options)
        }
    }

    private func attemptCall<T: LLMOutput>(_ prompt: String, as type: T.Type, options: CallOptions) async throws -> T {
        let reply = try await complete(prompt, options: options)
        report.lastModel = label(model: reply.model)
        return try T.parse(try extractJson(reply.text))
    }

    public func digest(_ input: DigestInput) async throws -> LectureDigest {
        let pictured = seesSlides && (input.slides?.hasPicturedDeck ?? false)
        return try await call(
            .digestLecture,
            vars: digestVars(input, visual: pictured),
            as: LectureDigest.self,
            options: CallOptions(task: .digest, slides: pictured ? input.slides : nil)
        )
    }

    public func generateQuestions(_ input: GenerateQuestionsInput) async throws -> QuestionSet {
        try await call(.generateQuestions, vars: generateVars(input), as: QuestionSet.self, options: CallOptions(task: .questions))
    }

    public func mark(_ input: MarkInput) async throws -> Marking {
        try await call(.mark, vars: markVars(input), as: Marking.self, options: CallOptions(task: .mark))
    }

    public func parsePastPaper(_ input: ParsePastPaperInput) async throws -> PaperItems {
        try await call(.parsePastPaper, vars: paperVars(input), as: PaperItems.self, options: CallOptions(task: .paper))
    }

    public func sortFiles(_ input: SortFilesInput) async throws -> FolderSort {
        try await call(.sortFiles, vars: sortVars(input), as: FolderSort.self, options: CallOptions(task: .sort))
    }

    public func ask(_ input: AskInput) async throws -> Answer {
        let chosen = askVars(input)
        return try await call(chosen.prompt, vars: chosen.vars, as: Answer.self, options: CallOptions(task: .ask))
    }
}

/// Whether the cloud AI failed (rather than the lecture, or the user cancelling): a
/// `CloudError`, a reply that would not validate, or one that would not parse. Only these
/// are handed to the offline model by `withFallback`.
public func isCloudFailure(_ error: Error) -> Bool {
    error is CloudError || error is LLMValidationError || error is JSONParseError
}

private let fencedJsonRe = Regex.compile(#"```(?:json)?\s*\n([\s\S]*?)\n?```"#)

/// Pulls the JSON body out of a reply that may be fenced or prefaced with prose. Throws
/// `CloudError` when there is none, `JSONParseError` when it will not parse.
public func extractJson(_ text: String) throws -> JSONValue {
    var candidate = text
    if let match = Regex.firstMatch(fencedJsonRe, in: text), let inner = Regex.group(match, at: 1, in: text) {
        candidate = inner
    }
    if let parsed = try? JSONValue.parse(candidate.trimmingCharacters(in: .whitespacesAndNewlines)) {
        return parsed
    }
    let ns = candidate as NSString
    let start = ns.rangeOfCharacter(from: CharacterSet(charactersIn: "[{"))
    if start.location == NSNotFound {
        throw CloudError("no JSON found in reply: \(text.utf16Prefix(300))")
    }
    let opener = ns.substring(with: NSRange(location: start.location, length: 1))
    let closer = opener == "{" ? "}" : "]"
    let end = ns.range(of: closer, options: .backwards)
    if end.location == NSNotFound || end.location <= start.location {
        throw CloudError("unbalanced JSON in reply: \(text.utf16Prefix(300))")
    }
    return try JSONValue.parse(ns.substring(with: NSRange(location: start.location, length: end.location - start.location + 1)))
}

/// What to tell a model that has been given the slides as pictures.
public func picturesNote(_ pictures: [SlidePicture], total: Int) -> String {
    guard let first = pictures.first?.slide, let last = pictures.last?.slide else { return "" }
    let rest = total > pictures.count ? " (the rest are only in the slide text above)" : ""
    return "\n\n---\n\nThe slides are attached as \(pictures.count) pictures, in order: the first is slide \(first), "
        + "the last slide \(last)\(rest). The "
        + "slide text above was extracted from them and misses everything inside pictures, diagrams, tables and photos, "
        + "so look at every picture before writing anything. Use those slide numbers for slide pictures and slideNotes. "
        + "Then reply with the JSON described above."
}

/// What to tell a model that has been given the slide PDFs themselves.
public func decksNote(_ slides: SlidesInfo) -> String {
    let pdfs = slides.decks.filter { $0.isPictured }
    if pdfs.isEmpty {
        return ""
    }
    let list = pdfs.map { "- \($0.name): slides \($0.first)–\($0.first + $0.pages - 1)" }.joined(separator: "\n")
    return "\n\n---\n\nThe slide decks are attached as PDF files. The slide text above was extracted from them and misses "
        + "everything inside pictures, diagrams, tables and photos, so look at every page yourself before writing "
        + "anything. Slides are numbered across the decks as listed:\n\n\(list)\n\nUse those numbers for slide pictures "
        + "and slideNotes. Then reply with the JSON described above."
}

/// The PDF slides in a call's decks, counted (`total` for `picturesNote`).
public func pdfSlideCount(_ slides: SlidesInfo?) -> Int {
    guard let slides else { return 0 }
    return slides.decks.reduce(0) { $0 + ($1.pdf ? $1.pages : 0) }
}

/// An engine that can't run as set up — no API key, no address — and says so on every call.
public final class MisconfiguredProvider: PromptProvider, @unchecked Sendable {
    public let name = "misconfigured"
    public let seesSlides = false
    public let report: ProviderReport
    private let what: String
    private let problem: String

    public init(what: String, problem: String) {
        self.what = what
        self.problem = problem
        self.report = ProviderReport(lastModel: what)
    }

    public func label(model: String?) -> String {
        what
    }

    public func complete(_ prompt: String, options: CallOptions) async throws -> Reply {
        throw CloudError(problem)
    }
}
