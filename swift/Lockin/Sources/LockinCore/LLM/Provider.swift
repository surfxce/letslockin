import Foundation

/// The only place in the app a model gets called (port of `lib/llm/provider.ts`).
///
/// Backed by a command-line AI signed in with the student's own plan (Claude Code,
/// Codex, Antigravity), by an API key, by a model running on this computer on the MLX
/// engine, or by a canned stand-in for development and tests. Everything else depends on
/// `LLMProvider`, never on an adapter.

// MARK: - Inputs

/// A concept as the model sees it: enough to reuse an id, not enough to pad the prompt.
public struct ConceptRef: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var definition: String

    public init(id: String, name: String, definition: String) {
        self.id = id
        self.name = name
        self.definition = definition
    }
}

public struct DigestInput: Equatable, Sendable {
    public var currentTitle: String
    /// True when the current title came from a filename and should be replaced.
    public var titleIsPlaceholder: Bool
    public var durationHours: Double
    public var transcript: String
    public var slidesText: String?
    /// Sections already removed before the model saw the text, so it can mention them.
    /// Only `what` and `where` are used.
    public var alreadySkipped: [Skipped]
    /// Concepts already on the course. The model reuses these ids rather than minting
    /// near-duplicates.
    public var existingConcepts: [ConceptRef]
    public var slides: SlidesInfo?

    public init(
        currentTitle: String,
        titleIsPlaceholder: Bool,
        durationHours: Double,
        transcript: String,
        slidesText: String? = nil,
        alreadySkipped: [Skipped] = [],
        existingConcepts: [ConceptRef] = [],
        slides: SlidesInfo? = nil
    ) {
        self.currentTitle = currentTitle
        self.titleIsPlaceholder = titleIsPlaceholder
        self.durationHours = durationHours
        self.transcript = transcript
        self.slidesText = slidesText
        self.alreadySkipped = alreadySkipped
        self.existingConcepts = existingConcepts
        self.slides = slides
    }
}

public struct GenerateQuestionsInput: Equatable, Sendable {
    public var lectureTitle: String
    public var transcript: String
    public var slidesText: String?
    /// The lecture's summary: what an offline model writes LAQs from, in place of the transcript.
    public var summary: String?
    public var concepts: [ConceptRef]
    /// How many questions each concept should get, from the allocation engine.
    public var allocation: [Allocation]
    public var type: QuestionType
    /// A scenario per question, straight to the point, or a mix.
    public var style: LaqStyle?
    /// Other lectures using the same slides: ask only about this lecture's part.
    public var sharedWith: [String]

    public init(
        lectureTitle: String,
        transcript: String,
        slidesText: String? = nil,
        summary: String? = nil,
        concepts: [ConceptRef],
        allocation: [Allocation],
        type: QuestionType = .laq,
        style: LaqStyle? = nil,
        sharedWith: [String] = []
    ) {
        self.lectureTitle = lectureTitle
        self.transcript = transcript
        self.slidesText = slidesText
        self.summary = summary
        self.concepts = concepts
        self.allocation = allocation
        self.type = type
        self.style = style
        self.sharedWith = sharedWith
    }

    /// Questions asked for in all: the allocation's counts added up.
    public var total: Int {
        allocation.reduce(0) { $0 + $1.count }
    }
}

public struct MarkInput: Equatable, Sendable {
    public var questionStem: String
    /// The rubric as stored on the question (`JSON.parse(question.rubric)`), passed on as is.
    public var rubric: JSONValue
    public var answerText: String
    /// Only the concepts this question covers — gaps must cite one of these ids.
    public var concepts: [ConceptRef]

    public init(questionStem: String, rubric: JSONValue, answerText: String, concepts: [ConceptRef]) {
        self.questionStem = questionStem
        self.rubric = rubric
        self.answerText = answerText
        self.concepts = concepts
    }
}

public struct ParsePastPaperInput: Equatable, Sendable {
    public var paperText: String
    public var concepts: [ConceptRef]

    public init(paperText: String, concepts: [ConceptRef]) {
        self.paperText = paperText
        self.concepts = concepts
    }
}

/// Files of a folder being sorted (`SortFile` is in ScanAndImport.swift).
public struct SortFilesInput: Equatable, Sendable {
    public var files: [SortFile]

    public init(files: [SortFile]) {
        self.files = files
    }
}

public enum AskKind: String, Codable, CaseIterable, Sendable {
    case question
    case breakdown
    case leftout
}

public struct AskQuestion: Equatable, Sendable {
    public var lectureTitle: String
    public var summary: String
    public var question: String
    /// The summary's headings, one of which the answer is filed under.
    public var headings: [String]

    public init(lectureTitle: String, summary: String, question: String, headings: [String]) {
        self.lectureTitle = lectureTitle
        self.summary = summary
        self.question = question
        self.headings = headings
    }
}

public struct AskBreakdown: Equatable, Sendable {
    public var lectureTitle: String
    public var summary: String
    public var selection: String

    public init(lectureTitle: String, summary: String, selection: String) {
        self.lectureTitle = lectureTitle
        self.summary = summary
        self.selection = selection
    }
}

public struct AskLeftOut: Equatable, Sendable {
    public var lectureTitle: String
    public var what: String
    public var `where`: String
    public var transcript: String
    public var slidesText: String?

    public init(lectureTitle: String, what: String, where: String, transcript: String, slidesText: String? = nil) {
        self.lectureTitle = lectureTitle
        self.what = what
        self.where = `where`
        self.transcript = transcript
        self.slidesText = slidesText
    }
}

/// A quick question about one lecture, asked from its page while the student waits.
/// Questions and break-downs see only the summary they are reading; a left-out part is
/// looked for in the lecture's own material.
public enum AskInput: Equatable, Sendable {
    case question(AskQuestion)
    case breakdown(AskBreakdown)
    case leftout(AskLeftOut)

    public var kind: AskKind {
        switch self {
        case .question: return .question
        case .breakdown: return .breakdown
        case .leftout: return .leftout
        }
    }

    public var lectureTitle: String {
        switch self {
        case .question(let input): return input.lectureTitle
        case .breakdown(let input): return input.lectureTitle
        case .leftout(let input): return input.lectureTitle
        }
    }
}

// MARK: - The provider

/// The seam every model call goes through. Mirrors `LlmProvider` method for method.
///
/// A provider instance serves one job at a time: `makeProvider` (ProviderFactory.swift)
/// returns a fresh one per job, so `lastModel` and `lastPromptVersion` always describe
/// that job's most recent call.
public protocol LLMProvider: AnyObject, Sendable {
    var name: String { get }
    /// Looks at the slides themselves, as pages it can see. Without this, slides that are
    /// pictures are read with text recognition first (Slides/SlideOCR.swift).
    var seesSlides: Bool { get }
    /// Version of the prompt behind the most recent call ("digest-lecture@1.2.0"),
    /// stamped onto the rows it produced.
    var lastPromptVersion: String { get }
    /// Who wrote the most recent reply, for display beside what it wrote:
    /// "Claude Code · claude-sonnet-…", "Offline · Gemma 4 E4B (MLX)".
    var lastModel: String { get }
    /// Set by the queue: a slow provider reports what it is doing within a stage
    /// ("reading part 2 of 4"), and nil when it has nothing to add.
    var onProgress: (@Sendable (String?) -> Void)? { get set }

    /// Title, set-aside sections, summary and concepts for one lecture, in one call.
    func digest(_ input: DigestInput) async throws -> LectureDigest
    func generateQuestions(_ input: GenerateQuestionsInput) async throws -> QuestionSet
    func mark(_ input: MarkInput) async throws -> Marking
    func parsePastPaper(_ input: ParsePastPaperInput) async throws -> PaperItems
    /// Groups a folder's files into lectures. Quick and cheap: it reads only openings.
    func sortFiles(_ input: SortFilesInput) async throws -> FolderSort
    /// Answers a question about a lecture, breaks a passage down, or says what a left-out
    /// part contained.
    func ask(_ input: AskInput) async throws -> Answer
}

/// A provider running a model downloaded to this computer (MLXProvider), so the queue can
/// show it the slides first (`lookLocally` in Handlers.swift).
public protocol OfflineModelProvider: LLMProvider {
    /// The model's MLX folder.
    var modelPath: String { get }
    /// Its catalog id ("gemma-4-e4b").
    var modelId: String { get }
    /// Its display name ("Gemma 4 E4B").
    var modelName: String { get }
}

/// The MLX engine (`lockin-engine`, LLM/MLXEngine.swift): one long-lived process,
/// a line of JSON each way (lib/llm/mlx.ts).
public protocol EngineGenerating: Sendable {
    /// One request. With a schema the reply is valid JSON of that shape. Cancelling the
    /// calling task ends the engine and throws `CancellationError`.
    func generate(
        model: String,
        prompt: String,
        images: [String],
        schema: JSONValue?,
        maxTokens: Int,
        temperature: Double,
        onTokens: (@Sendable (Int) -> Void)?
    ) async throws -> String

    /// Ends the engine, freeing the model's memory. Anything it was doing fails.
    func stop() async
}

/// What a provider reports after each call, safe to read and write from any task.
public final class ProviderReport: @unchecked Sendable {
    private let lock = NSLock()
    private var promptVersion: String
    private var model: String
    private var progressHandler: (@Sendable (String?) -> Void)?

    public init(lastPromptVersion: String = "", lastModel: String = "") {
        promptVersion = lastPromptVersion
        model = lastModel
    }

    public var lastPromptVersion: String {
        get {
            lock.lock()
            defer { lock.unlock() }
            return promptVersion
        }
        set {
            lock.lock()
            promptVersion = newValue
            lock.unlock()
        }
    }

    public var lastModel: String {
        get {
            lock.lock()
            defer { lock.unlock() }
            return model
        }
        set {
            lock.lock()
            model = newValue
            lock.unlock()
        }
    }

    public var onProgress: (@Sendable (String?) -> Void)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return progressHandler
        }
        set {
            lock.lock()
            progressHandler = newValue
            lock.unlock()
        }
    }

    /// Calls `onProgress`, if set.
    public func progress(_ detail: String?) {
        let handler = onProgress
        handler?(detail)
    }
}

/// The result of `withFallback` (ProviderFactory.swift): what the work returned, the
/// provider that did it, and why the cloud failed when the offline model stepped in.
public struct FallbackOutcome<T> {
    public var result: T
    public var used: any LLMProvider
    public var fellBack: String?

    public init(result: T, used: any LLMProvider, fellBack: String? = nil) {
        self.result = result
        self.used = used
        self.fellBack = fellBack
    }
}

extension FallbackOutcome: Sendable where T: Sendable {}

// MARK: - Errors

/// A cloud AI that could not do the job: not installed, signed out, out of credit, a
/// reply that would not parse. The queue hands such a job to the offline model when
/// there is one; a lecture with nothing to read fails another way. (`CloudError` and
/// `ClaudeCliError` in TypeScript; the CLI's details ride along when there are any.)
public struct CloudError: Error, LocalizedError, Equatable, Sendable {
    public var message: String
    public var stdout: String?
    public var stderr: String?
    public var code: Int32?

    public init(_ message: String, stdout: String? = nil, stderr: String? = nil, code: Int32? = nil) {
        self.message = message
        self.stdout = stdout
        self.stderr = stderr
        self.code = code
    }

    public var errorDescription: String? { message }

    /// A reply with no JSON in it: worth one repair pass, unlike a failure to reach the engine.
    public var isUnusableReply: Bool {
        message.contains("no JSON") || message.contains("unbalanced JSON")
    }
}

/// A plain failure with a message for the student (`new Error(message)` in TypeScript).
public struct LockinError: Error, LocalizedError, Equatable, Sendable {
    public var message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// `err instanceof Error ? err.message : String(err)`: the text stored in `Job.error`.
public func messageOf(_ error: Error) -> String {
    if error is CancellationError {
        return "Cancelled"
    }
    if let described = (error as? LocalizedError)?.errorDescription {
        return described
    }
    // Foundation's own errors (a file, a socket, a request) read best as Foundation words them.
    let bridged = error as NSError
    if bridged.domain == NSCocoaErrorDomain || bridged.domain == NSPOSIXErrorDomain || bridged.domain == NSURLErrorDomain {
        return bridged.localizedDescription
    }
    return String(describing: error)
}
