import Foundation

/// Runs a downloaded model on this computer on the MLX engine (port of the MLX path of
/// `LocalProvider` in `lib/llm/local.ts`). Fully offline.
///
/// Small models are unreliable at free-form JSON, so every reply is held to the expected
/// shape (`OfflineSchemas`, spelled out by `strictSchema`); concept ids are held to the
/// ones that exist, so a reply cannot cite a concept that isn't there. MLX models take a
/// whole lecture at once, so nothing is condensed first.
public final class MLXProvider: OfflineModelProvider, @unchecked Sendable {
    public let name: String
    /// It never sees the slides itself: the queue shows them to a model that can see first
    /// (`lookLocally`), or reads them as text.
    public let seesSlides = false
    public let lastModel: String
    public let modelPath: String
    public let modelName: String
    public let modelId: String
    public let promptsDirectory: URL
    private let engine: any EngineGenerating
    private let report = ProviderReport()

    /// `modelPath` is the model's MLX folder; `modelId` its catalog id, for finding out
    /// whether it can see the slides.
    public init(
        modelPath: String,
        modelName: String,
        modelId: String,
        engine: any EngineGenerating,
        promptsDirectory: URL = LockinPaths.promptsDirectory
    ) {
        self.modelPath = modelPath
        self.modelName = modelName
        self.modelId = modelId
        self.engine = engine
        self.promptsDirectory = promptsDirectory
        self.name = "local:\(modelName)"
        self.lastModel = "Offline · \(modelName) (MLX)"
    }

    public var lastPromptVersion: String { report.lastPromptVersion }

    public var onProgress: (@Sendable (String?) -> Void)? {
        get { report.onProgress }
        set { report.onProgress = newValue }
    }

    public func digest(_ input: DigestInput) async throws -> LectureDigest {
        try await run(
            MLXRequest(
                prompt: .digestLecture,
                vars: digestVars(input),
                schema: OfflineSchemas.digest(existingIds: input.existingConcepts.map { $0.id }),
                // A summary plus 8-20 concepts an hour.
                maxTokens: mlxWholeNumber(jsMathRound(2500 + 1200 * input.durationHours)),
                temperature: 0.3
            ),
            as: LectureDigest.self
        )
    }

    public func generateQuestions(_ input: GenerateQuestionsInput) async throws -> QuestionSet {
        let total = input.total
        // A fresh start from the summary alone: the summary step already read the transcript
        // and slides, and reading them all again is what ran laptops out of memory.
        var source = input
        let summary = (input.summary ?? "").trimmingCharacters(in: mlxProviderTrimCharacters)
        if !summary.isEmpty {
            source.transcript = "(This is the lecture's revision summary, written from its transcript and slides. "
                + "Write the questions and marking guides from it.)\n\n"
                + summary
            source.slidesText = "(already covered in the summary above)"
        }
        return try await run(
            MLXRequest(
                prompt: .generateQuestions,
                vars: generateVars(source),
                schema: OfflineSchemas.questions(conceptIds: input.concepts.map { $0.id }, type: input.type, total: total),
                // A ceiling, not a target: a full model answer and up to eight criteria each.
                maxTokens: 2000 * max(1, total) + 300,
                temperature: 0.5
            ),
            as: QuestionSet.self
        )
    }

    public func mark(_ input: MarkInput) async throws -> Marking {
        try await run(
            MLXRequest(
                prompt: .mark,
                vars: markVars(input),
                schema: OfflineSchemas.marking(conceptIds: input.concepts.map { $0.id }),
                maxTokens: 1500,
                // The same answer should earn the same mark every time.
                temperature: 0
            ),
            as: Marking.self
        )
    }

    public func parsePastPaper(_ input: ParsePastPaperInput) async throws -> PaperItems {
        try await run(
            MLXRequest(
                prompt: .parsePastPaper,
                vars: paperVars(input),
                schema: OfflineSchemas.paper,
                maxTokens: 4000,
                temperature: 0
            ),
            as: PaperItems.self
        )
    }

    public func sortFiles(_ input: SortFilesInput) async throws -> FolderSort {
        try await run(
            MLXRequest(
                prompt: .sortFiles,
                vars: sortVars(input),
                schema: OfflineSchemas.sort(fileCount: input.files.count),
                maxTokens: 120 + 60 * input.files.count,
                temperature: 0,
                // It runs beside a lecture being prepared, whose progress line this must not take over.
                quiet: true
            ),
            as: FolderSort.self
        )
    }

    public func ask(_ input: AskInput) async throws -> Answer {
        let chosen = askVars(input)
        var headings: [String] = []
        if case .question(let question) = input {
            headings = question.headings
        }
        let isQuestion = input.kind == .question
        return try await run(
            MLXRequest(
                prompt: chosen.prompt,
                vars: chosen.vars,
                schema: OfflineSchemas.answer(headings: headings, maxLength: isQuestion ? 2400 : 900),
                maxTokens: isQuestion ? 700 : 300,
                temperature: 0.3,
                // It runs beside a lecture being prepared, whose progress line this must not take over.
                quiet: true
            ),
            as: Answer.self
        )
    }

    /// One request on the engine (`runOnMlx`): the prompt rendered, the reply held to the
    /// schema, then checked against the output's own rules.
    private func run<T: LLMOutput>(_ request: MLXRequest, as type: T.Type) async throws -> T {
        let reporter = report
        let rendered = try renderPrompt(request.prompt, vars: request.vars, directory: promptsDirectory)
        reporter.lastPromptVersion = rendered.version
        let quiet = request.quiet
        let progress: @Sendable (String?) -> Void = { detail in
            if !quiet {
                reporter.progress(detail)
            }
        }
        progress("loading \(modelName) on MLX")
        let text = try await engine.generate(
            model: modelPath,
            prompt: rendered.text,
            images: [],
            schema: strictSchema(request.schema),
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            // Roughly three words for every four tokens.
            onTokens: { tokens in
                progress("writing — about \(mlxWordsSoFar(tokens)) words so far")
            }
        )
        progress(nil)
        let parsed: JSONValue
        do {
            parsed = try JSONValue.parse(text)
        } catch {
            throw LockinError(
                "the offline model stopped before finishing its answer — try a smaller model, or close other apps to free memory"
            )
        }
        return try mlxChecked(type, parsed)
    }
}

/// What one offline call asks of the engine (`RunOpts`).
private struct MLXRequest {
    var prompt: PromptName
    var vars: [String: String]
    var schema: JSONValue
    var maxTokens: Int
    var temperature: Double
    /// Reports no progress: it runs beside a job whose progress line it must not take over.
    var quiet = false
}

/// The reply, held to its shape — with what was wrong in words, not zod's list of issues
/// (`checked`).
func mlxChecked<T: LLMOutput>(_ type: T.Type, _ reply: JSONValue) throws -> T {
    do {
        return try T.parse(reply)
    } catch let invalid as LLMValidationError {
        let paths = Array(invalid.keyPaths.prefix(3))
        let place = paths.isEmpty ? "" : " (\(paths.joined(separator: ", ")))"
        throw LockinError("the offline model's answer was missing parts\(place) — try again, or use a larger model")
    }
}

/// `Math.round(tokens * 0.75).toLocaleString("en")`: "1,500".
func mlxWordsSoFar(_ tokens: Int) -> String {
    let words = jsMathRound(Double(tokens) * 0.75)
    guard words.isFinite else { return jsNumberString(words) }
    let negative = words < 0
    let digits = String(Int64(max(-9e18, min(9e18, words.magnitude))))
    var grouped = ""
    for (index, digit) in digits.enumerated() {
        if index > 0 && (digits.count - index) % 3 == 0 {
            grouped.append(",")
        }
        grouped.append(digit)
    }
    return negative ? "-\(grouped)" : grouped
}

/// A token budget as a whole number, whatever the arithmetic gave.
private func mlxWholeNumber(_ value: Double) -> Int {
    guard value.isFinite else { return 0 }
    return Int(max(-1e15, min(1e15, value)))
}

/// JavaScript's white space and line ends, which `String.prototype.trim` removes.
private let mlxProviderTrimCharacters: CharacterSet = {
    var set = CharacterSet.whitespacesAndNewlines
    set.insert(charactersIn: "\u{FEFF}")
    set.remove(charactersIn: "\u{0085}")
    return set
}()
