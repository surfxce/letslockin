import Foundation

// The cloud AIs reached through a command-line tool signed in with the student's own plan:
// Claude Code (lib/llm/cli.ts), ChatGPT's Codex (lib/llm/codex.ts) and Google's
// Antigravity, or the Gemini CLI it replaced (lib/llm/antigravity.ts), and whether each
// can be run from here (lib/llm/detect.ts). Every tool runs through `ProcessRunner`: the
// prompt on stdin, arguments as a list (never a shell line), from a neutral folder, and
// killed when it takes too long or its job is cancelled.

// MARK: - Detecting the tools

/// Whether a command-line tool can be run from here, and its version (`CliStatus`).
public struct CLIStatus: Equatable, Sendable {
    public var found: Bool
    public var version: String?
    public var binary: String

    public init(found: Bool, version: String?, binary: String) {
        self.found = found
        self.version = version
        self.binary = binary
    }
}

/// Remembers what `--version` said for a minute: it starts a process, and pages ask on
/// every render.
final class CLIDetectCache: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String: (at: Date, status: CLIStatus)] = [:]

    func status(for key: String, now: Date) -> CLIStatus? {
        lock.lock()
        defer { lock.unlock() }
        guard let hit = entries[key], now.timeIntervalSince(hit.at) < 60 else { return nil }
        return hit.status
    }

    func store(_ status: CLIStatus, for key: String, now: Date) {
        lock.lock()
        entries[key] = (at: now, status: status)
        lock.unlock()
    }

    func clear() {
        lock.lock()
        entries.removeAll()
        lock.unlock()
    }
}

public enum CLIDetect {
    static let cache = CLIDetectCache()

    /// Whether the Claude Code CLI can be run from here (`detectCli`), so the app can
    /// recommend copy-and-paste mode instead of queueing work that will never run.
    public static func claude(environment: [String: String]) async -> CLIStatus {
        if let fake = fakeStatus(environment) {
            return fake
        }
        return await detect(ClaudeCodeConfig.fromEnvironment(environment).binary, environment: environment)
    }

    /// ChatGPT's Codex CLI (`detectCodex`).
    public static func codex(environment: [String: String]) async -> CLIStatus {
        if let fake = fakeStatus(environment) {
            return fake
        }
        return await detect(environment["LOCKIN_CODEX_BIN"] ?? "codex", environment: environment)
    }

    /// Google's Antigravity CLI, or the Gemini CLI it replaced when that is all there is
    /// (`detectAntigravity`; `LOCKIN_AGY_BIN` names one outright).
    public static func antigravity(environment: [String: String]) async -> CLIStatus {
        if let forced = environment["LOCKIN_AGY_BIN"], !forced.isEmpty {
            if let fake = fakeStatus(environment) {
                return fake
            }
            return await detect(forced, environment: environment)
        }
        if let fake = fakeStatus(environment) {
            return fake
        }
        let agy = await detect("agy", environment: environment)
        if agy.found {
            return agy
        }
        let gemini = await detect("gemini", environment: environment)
        return gemini.found ? gemini : agy
    }

    /// Forgets every remembered answer (for tests, and after installing a tool).
    static func clearCache() {
        cache.clear()
    }

    /// Under `LOCKIN_PROVIDER=fake` every tool is "found".
    static func fakeStatus(_ environment: [String: String]) -> CLIStatus? {
        guard (environment["LOCKIN_PROVIDER"] ?? "cli") == "fake" else { return nil }
        return CLIStatus(found: true, version: "fake provider", binary: "fake")
    }

    /// `binary --version`, given 8 seconds: found when it exits 0, its version the first
    /// line it printed. Remembered for a minute per command and search path.
    static func detect(_ binary: String, environment: [String: String]) async -> CLIStatus {
        let key = binary + "\u{0}" + ProcessRunner.searchPath(environment: environment).joined(separator: ":")
        if let hit = cache.status(for: key, now: Date()) {
            return hit
        }
        var status = CLIStatus(found: false, version: nil, binary: binary)
        do {
            let result = try await ProcessRunner.execute(
                binary,
                arguments: ["--version"],
                input: "",
                timeout: 8,
                environment: environment
            )
            if result.code == 0 {
                let first = cliLines(cliTrim(result.stdout)).first ?? ""
                status = CLIStatus(found: true, version: first.isEmpty ? nil : first, binary: binary)
            }
        } catch is CancellationError {
            // Asked to stop: no answer, and none to remember.
            return status
        } catch {
            // Not installed, can't be run, or no answer in time: not found.
        }
        cache.store(status, for: key, now: Date())
        return status
    }
}

// MARK: - Shared helpers

/// `value || fallback` for a string that may be missing: nil and "" both fall through.
func jsOr(_ value: String?, _ fallback: String) -> String {
    if let value, !value.isEmpty {
        return value
    }
    return fallback
}

/// `${code}` for a Node exit code: "null" when a signal ended the process.
func exitCodeText(_ code: Int32?) -> String {
    code.map { String($0) } ?? "null"
}

/// `path.dirname(p)` (POSIX), in UTF-16 units as Node counts them.
func nodeDirname(_ path: String) -> String {
    let units = Array(path.utf16)
    if units.isEmpty {
        return "."
    }
    let slash: UInt16 = 0x2F
    let hasRoot = units[0] == slash
    var end = -1
    var matchedSlash = true
    var index = units.count - 1
    while index >= 1 {
        if units[index] == slash {
            if !matchedSlash {
                end = index
                break
            }
        } else {
            matchedSlash = false
        }
        index -= 1
    }
    if end == -1 {
        return hasRoot ? "/" : "."
    }
    if hasRoot && end == 1 {
        return "//"
    }
    return String(decoding: units[0..<end], as: UTF16.self)
}

/// `path.basename(p)` (POSIX, no suffix).
func nodeBasename(_ path: String) -> String {
    let units = Array(path.utf16)
    let slash: UInt16 = 0x2F
    var start = 0
    var end = -1
    var matchedSlash = true
    var index = units.count - 1
    while index >= 0 {
        if units[index] == slash {
            if !matchedSlash {
                start = index + 1
                break
            }
        } else if end == -1 {
            matchedSlash = false
            end = index + 1
        }
        index -= 1
    }
    if end == -1 {
        return ""
    }
    return String(decoding: units[start..<end], as: UTF16.self)
}

/// The decks a model can open as pages: PDFs with pages (`d.pdf && d.pages > 0`).
func picturedDecks(_ slides: SlidesInfo?) -> [SlideDeck] {
    slides?.decks.filter { $0.isPictured } ?? []
}

/// `[...new Set(pdfs.map((d) => path.dirname(d.file)))]`: the folders holding those
/// decks, each once, in order.
func deckDirectories(_ decks: [SlideDeck]) -> [String] {
    var seen = Set<String>()
    var folders: [String] = []
    for deck in decks {
        let folder = nodeDirname(deck.file)
        if seen.insert(folder).inserted {
            folders.append(folder)
        }
    }
    return folders
}

// MARK: - Claude Code

/// How Claude Code is run (`ClaudeCliConfig`).
public struct ClaudeCodeConfig: Equatable, Sendable {
    /// The standalone CLI. The desktop app ships its own copy that is not on PATH.
    public var binary: String
    public var model: String
    /// For sorting a folder: a quick look at file openings, so a small fast model.
    public var sortModel: String
    /// For questions asked from a lecture page while the student waits: quick, but
    /// answering about the content, so not the smallest model.
    public var askModel: String
    /// How hard the model thinks before preparing or marking a lecture (`--effort`). Nil
    /// leaves it to the CLI's own default.
    public var effort: String?
    /// Seconds a call may take.
    public var timeout: TimeInterval
    /// Extra flags, space-separated, from LOCKIN_CLI_FLAGS. Lets flag drift be fixed
    /// without a code change.
    public var extraArgs: [String]

    public init(
        binary: String,
        model: String,
        sortModel: String,
        askModel: String,
        effort: String?,
        timeout: TimeInterval,
        extraArgs: [String]
    ) {
        self.binary = binary
        self.model = model
        self.sortModel = sortModel
        self.askModel = askModel
        self.effort = effort
        self.timeout = timeout
        self.extraArgs = extraArgs
    }

    /// `cliConfigFromEnv()`.
    public static func fromEnvironment(_ environment: [String: String]) -> ClaudeCodeConfig {
        let effort: String?
        if let raw = environment["LOCKIN_EFFORT"] {
            effort = raw == "default" ? nil : raw
        } else {
            effort = "medium"
        }
        // `Number(LOCKIN_CLI_TIMEOUT_MS ?? 600_000)`: one digest call does what three
        // used to, so a double lecture needs room.
        let timeoutMs = environment["LOCKIN_CLI_TIMEOUT_MS"].map { jsNumberValue(.string($0)) } ?? 600_000
        return ClaudeCodeConfig(
            binary: environment["LOCKIN_CLAUDE_BIN"] ?? "claude",
            // Settings choose the model (ProviderFactory.swift); this is only the fallback.
            model: environment["LOCKIN_MODEL"] ?? "sonnet",
            sortModel: environment["LOCKIN_SORT_MODEL"] ?? "haiku",
            askModel: environment["LOCKIN_ASK_MODEL"] ?? "sonnet",
            effort: effort,
            timeout: timeoutMs / 1000,
            extraArgs: (environment["LOCKIN_CLI_FLAGS"] ?? "").components(separatedBy: " ").filter { !$0.isEmpty }
        )
    }
}

/// One `claude -p` call: the model and effort its task gets, the folders it may read the
/// slide decks from, and the arguments (`runClaude`).
struct ClaudeCodeCall: Equatable, Sendable {
    var model: String
    var effort: String?
    var readDirs: [String]
    var arguments: [String]

    init(config: ClaudeCodeConfig, options: CallOptions) {
        let chosenModel: String
        let chosenEffort: String?
        switch options.task {
        case .sort:
            chosenModel = config.sortModel
            chosenEffort = "low"
        case .ask:
            // Someone chose Haiku to be quick: questions stay on it too.
            chosenModel = config.model == "haiku" ? "haiku" : config.askModel
            chosenEffort = "low"
        default:
            chosenModel = config.model
            chosenEffort = config.effort
        }
        let reads = deckDirectories(picturedDecks(options.slides))
        var args = ["-p", "--output-format", "json", "--model", chosenModel]
        if let effort = chosenEffort, !effort.isEmpty {
            args += ["--effort", effort]
        }
        // Text is inlined in the prompt; the only thing worth opening is a slide deck, so
        // Read is allowed only when there is one, and only in its folder. --allowed-tools
        // and --add-dir are variadic, so each is followed by another flag, and "none" is
        // said by denying rather than by an empty list.
        if !reads.isEmpty {
            args += ["--allowed-tools", "Read", "--add-dir"]
            args += reads
        }
        let denied = reads.isEmpty ? "Read," : ""
        args += ["--disallowed-tools", "Bash," + denied + "Write,Edit,Glob,Grep,WebFetch,WebSearch,Task"]
        args += config.extraArgs
        model = chosenModel
        effort = chosenEffort
        readDirs = reads
        arguments = args
    }
}

/// `--output-format json` wraps the reply in a result envelope. Be tolerant about its
/// shape: a JSON string is the reply, `result` or text `content` blocks are, and anything
/// else is taken as the bare reply some flag combinations print.
public func unwrapEnvelope(_ stdout: String) throws -> String {
    let trimmed = cliTrim(stdout)
    if trimmed.isEmpty {
        throw CloudError("claude returned nothing on stdout")
    }
    guard let parsed = try? JSONValue.parse(trimmed) else {
        // Not an envelope.
        return trimmed
    }
    switch parsed {
    case .string(let text):
        return text
    case .object(let envelope):
        if envelope["is_error"]?.isTruthy == true {
            let detail = nonNullish(envelope["result"]) ?? nonNullish(envelope["error"]) ?? .string("")
            throw CloudError("claude reported an error: \(jsString(detail))")
        }
        if case .string(let text)? = envelope["result"] {
            return text
        }
        if case .array(let blocks)? = envelope["content"] {
            return blocks.compactMap { block -> String? in
                guard case .object(let fields) = block,
                      fields["type"]?.stringValue == "text",
                      case .string(let text)? = fields["text"] else { return nil }
                return text
            }.joined()
        }
        return trimmed
    default:
        return trimmed
    }
}

/// `value ?? …`: nil (undefined) and JSON null both count as missing.
private func nonNullish(_ value: JSONValue?) -> JSONValue? {
    guard let value, !value.isNull else { return nil }
    return value
}

/// The model that did most of the writing, from the envelope's per-model usage. A call
/// can touch more than one (a small model for housekeeping), so the one that wrote the
/// most output is the one that answered.
public func modelOf(_ stdout: String) -> String? {
    guard let parsed = try? JSONValue.parse(cliTrim(stdout)),
          case .object(let envelope) = parsed,
          let usage = envelope["modelUsage"] else { return nil }
    let entries: [(key: String, value: JSONValue)]
    switch usage {
    case .object(let models):
        entries = models.entries
    case .array(let items):
        entries = items.enumerated().map { (key: String($0.offset), value: $0.element) }
    default:
        return nil
    }
    // A stable sort by output tokens, most first, keeps the earliest of equals first.
    var best: (key: String, tokens: Double)?
    for entry in entries {
        let tokens = outputTokens(entry.value)
        if let current = best {
            if tokens > current.tokens {
                best = (key: entry.key, tokens: tokens)
            }
        } else {
            best = (key: entry.key, tokens: tokens)
        }
    }
    return best?.key
}

/// `usage?.outputTokens ?? 0`, as a number.
private func outputTokens(_ usage: JSONValue) -> Double {
    guard case .object(let fields) = usage, let tokens = nonNullish(fields["outputTokens"]) else { return 0 }
    return jsNumberValue(tokens)
}

/// What `runClaude` makes of a finished `claude -p`. The envelope is read before the exit
/// code: the CLI still prints one on failure, and its message ("Not logged in", a rate
/// limit, a refusal) is far more useful than the status.
func claudeReply(_ result: ProcessResult, callModel: String) throws -> Reply {
    do {
        let text = try unwrapEnvelope(result.stdout)
        return Reply(text: text, model: modelOf(result.stdout) ?? callModel)
    } catch {
        let reported = (error as? CloudError)?.message.contains("claude reported") ?? false
        if result.code != 0 && !reported {
            let detail = cliTrim(result.stderr)
            let said = detail.isEmpty ? "" : ": " + detail
            throw CloudError(
                "claude exited \(exitCodeText(result.code))\(said)",
                stdout: result.stdout,
                stderr: result.stderr,
                code: result.code
            )
        }
        throw error
    }
}

/// `${cfg.timeoutMs}` for a timeout kept in seconds, without the float noise of
/// converting back (1.1 s reads "1100", not "1100.0000000000002").
func claudeTimeoutText(_ timeout: TimeInterval) -> String {
    let ms = timeout * 1000
    guard ms.isFinite else { return jsNumberString(ms) }
    return jsNumberString((ms * 1_000_000).rounded() / 1_000_000)
}

/// Claude Code, signed in with the student's plan (`ClaudeCliProvider`). It reads PDF
/// slide decks itself, as pages it can see.
public final class ClaudeCodeProvider: PromptProvider, @unchecked Sendable {
    public let name = "claude-code-cli"
    public let seesSlides = true
    public let report: ProviderReport
    public let promptsDirectory: URL
    public let config: ClaudeCodeConfig

    public init(config: ClaudeCodeConfig, promptsDirectory: URL = LockinPaths.promptsDirectory) {
        self.config = config
        self.promptsDirectory = promptsDirectory
        self.report = ProviderReport(lastModel: "Claude Code · \(config.model)")
    }

    /// One repair pass after any failure, not only an unparseable reply.
    public var repairsAnyFailure: Bool { true }

    public func label(model: String?) -> String {
        "Claude Code · \(model ?? config.model)"
    }

    /// Runs `claude -p` with the prompt on stdin (transcripts blow past ARG_MAX). Gives
    /// back the reply, and the model that actually wrote it when the CLI says.
    public func complete(_ prompt: String, options: CallOptions) async throws -> Reply {
        let plan = ClaudeCodeCall(config: config, options: options)
        let result: ProcessResult
        do {
            // From a neutral folder: from a project, the CLI would load its CLAUDE.md,
            // settings and hooks into every call.
            result = try await ProcessRunner.execute(
                config.binary,
                arguments: plan.arguments,
                input: prompt,
                timeout: config.timeout
            )
        } catch ProcessRunFailure.timedOut {
            throw CloudError("claude timed out after \(claudeTimeoutText(config.timeout))ms")
        } catch ProcessRunFailure.couldNotRun(let reason) {
            throw CloudError(
                "could not run \"\(config.binary)\" (\(reason)). Install it with "
                    + "`npm i -g @anthropic-ai/claude-code` and run `claude` once to log in."
            )
        }
        return try claudeReply(result, callModel: plan.model)
    }

    /// With PDF slides, Claude reads the decks itself, as pages it can see: text inside
    /// pictures, diagrams and photos never reaches the extracted text. It writes notes on
    /// each slide as it goes, for the later steps that only read text.
    public func digest(_ input: DigestInput) async throws -> LectureDigest {
        let pdfs = picturedDecks(input.slides)
        if pdfs.isEmpty {
            return try await call(
                .digestLecture,
                vars: digestVars(input),
                as: LectureDigest.self,
                options: CallOptions(task: .digest)
            )
        }
        return try await call(
            .digestLecture,
            vars: digestVars(input, visual: true),
            as: LectureDigest.self,
            options: CallOptions(task: .digest, slides: input.slides),
            append: ClaudeCodeProvider.readDecksNote(pdfs)
        )
    }

    /// What Claude is told about the decks it may open with the Read tool.
    static func readDecksNote(_ pdfs: [SlideDeck]) -> String {
        let list = pdfs.map { deck -> String in
            let plural = deck.pages == 1 ? "" : "s"
            return "- \(deck.file) — \(deck.pages) page\(plural), slides \(deck.first)–\(deck.first + deck.pages - 1)"
        }.joined(separator: "\n")
        return "\n\n---\n\nThe slide decks are attached as PDF files you can open with the Read tool. The slide text "
            + "above was extracted from them and misses everything inside pictures, diagrams, tables and photos, so "
            + "look at every page yourself before writing anything — up to 20 pages per Read call (pages \"1-20\", then "
            + "\"21-40\", and so on):\n\n\(list)\n\nSlides are numbered across the decks as listed: use those numbers for "
            + "slide pictures and slideNotes. Read nothing else. Then reply with the JSON described above."
    }
}

// MARK: - ChatGPT Codex

private let codexInstall = "Install it with `npm i -g @openai/codex` and run `codex login` once."

/// When each Codex binary's sign-in was last confirmed. Codex signed out waits rather than
/// failing, so it is asked first; the answer holds for five minutes.
final class CodexSignInCache: @unchecked Sendable {
    static let shared = CodexSignInCache()

    private let lock = NSLock()
    private var confirmed: [String: Date] = [:]

    func isFresh(_ binary: String, now: Date) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let at = confirmed[binary] else { return false }
        return now.timeIntervalSince(at) < 5 * 60
    }

    func confirm(_ binary: String, now: Date) {
        lock.lock()
        confirmed[binary] = now
        lock.unlock()
    }

    func clear() {
        lock.lock()
        confirmed.removeAll()
        lock.unlock()
    }
}

/// A fresh, private folder in the temporary folder (`mkdtemp(prefix)`).
func makeWorkDirectory(prefix: String) throws -> URL {
    let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
    let base = FileManager.default.temporaryDirectory
    var attempts = 0
    while true {
        let suffix = String((0..<6).map { _ in letters[Int.random(in: 0..<letters.count)] })
        let folder = base.appendingPathComponent(prefix + suffix, isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: folder,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            return folder
        } catch {
            attempts += 1
            if attempts >= 10 || !FileManager.default.fileExists(atPath: folder.path) {
                throw error
            }
        }
    }
}

/// ChatGPT's Codex CLI, signed in with a ChatGPT plan (`codex login`). It reads the slides
/// as pictures: each PDF page is drawn once and attached with --image (`CodexCliProvider`).
///
/// Codex is an agent that can run commands; here it only ever answers. It runs in a
/// read-only sandbox, outside any repository, with nothing saved between calls.
public final class CodexProvider: PromptProvider, @unchecked Sendable {
    public let name = "codex-cli"
    public let seesSlides = true
    public let report: ProviderReport
    public let promptsDirectory: URL
    public let binary: String
    /// Empty for whatever Codex is set to use.
    public let model: String
    public let timeout: TimeInterval
    private let renderer: any SlideRendering

    public init(
        binary: String,
        model: String,
        renderer: any SlideRendering,
        timeout: TimeInterval = 600,
        promptsDirectory: URL = LockinPaths.promptsDirectory
    ) {
        self.binary = binary
        self.model = model
        self.renderer = renderer
        self.timeout = timeout
        self.promptsDirectory = promptsDirectory
        self.report = ProviderReport()
        report.lastModel = label(model: nil)
    }

    public func label(model: String?) -> String {
        "ChatGPT Codex · \(jsOr(model, jsOr(self.model, "default model")))"
    }

    /// `codex login status`, unless a sign-in was confirmed in the last five minutes.
    private func checkSignedIn() async throws {
        if CodexSignInCache.shared.isFresh(binary, now: Date()) {
            return
        }
        let status = try await ProcessRunner.run(
            binary,
            arguments: ["login", "status"],
            input: "",
            timeout: 20,
            what: "Codex",
            install: codexInstall
        )
        if status.code != 0 {
            throw CloudError("Codex isn't signed in — run `codex login` in a terminal, then try again")
        }
        CodexSignInCache.shared.confirm(binary, now: Date())
    }

    /// `codex exec` arguments: the reply is written to `out`; pictures go with --image.
    static func arguments(model: String, task: LLMTask, work: String, out: String, pictures: [SlidePicture]) -> [String] {
        let effort = task.isQuick ? "low" : "medium"
        var args = [
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--cd",
            work,
            "--output-last-message",
            out,
            "-c",
            "model_reasoning_effort=\"\(effort)\"",
        ]
        if !model.isEmpty {
            args += ["--model", model]
        }
        for picture in pictures {
            args += ["--image", picture.file]
        }
        args.append("-")
        return args
    }

    public func complete(_ prompt: String, options: CallOptions) async throws -> Reply {
        try await checkSignedIn()
        let work = try makeWorkDirectory(prefix: "lockin-codex-")
        defer { try? FileManager.default.removeItem(at: work) }
        var pictures: [SlidePicture] = []
        if let slides = options.slides {
            pictures = try slidePictures(slides, renderer: renderer)
        }
        let total = pdfSlideCount(options.slides)
        let out = work.appendingPathComponent("reply.txt", isDirectory: false)
        let args = CodexProvider.arguments(model: model, task: options.task, work: work.path, out: out.path, pictures: pictures)
        let instructions = "Answer from the text below alone: do not run any commands or open any files.\n\n"
            + prompt
            + picturesNote(pictures, total: total)
        let run = try await ProcessRunner.run(
            binary,
            arguments: args,
            input: instructions,
            timeout: timeout,
            what: "Codex",
            install: codexInstall
        )
        let text = (try? Data(contentsOf: out)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        if run.code != 0 || cliTrim(text).isEmpty {
            let why = jsOr(
                ProcessRunner.lastLine(run.stderr),
                jsOr(ProcessRunner.lastLine(run.stdout), "exit code \(exitCodeText(run.code))")
            )
            throw CloudError("Codex couldn't answer: \(why)")
        }
        return Reply(text: text)
    }
}

// MARK: - Antigravity / Gemini CLI

/// Google's Antigravity CLI (`agy`), signed in with a Google account, or the Gemini CLI it
/// replaced (`gemini`), which takes the same headless flags (`AntigravityCliProvider`).
/// Gemini reads PDFs itself, so the slide decks are attached as they are, with "@path".
public final class AntigravityProvider: PromptProvider, @unchecked Sendable {
    public let name = "antigravity-cli"
    public let seesSlides = true
    public let report: ProviderReport
    public let promptsDirectory: URL
    public let binary: String
    /// Empty for the CLI's own choice.
    public let model: String
    public let timeout: TimeInterval

    public init(
        binary: String,
        model: String,
        timeout: TimeInterval = 600,
        promptsDirectory: URL = LockinPaths.promptsDirectory
    ) {
        self.binary = binary
        self.model = model
        self.timeout = timeout
        self.promptsDirectory = promptsDirectory
        self.report = ProviderReport()
        report.lastModel = label(model: nil)
    }

    public func label(model: String?) -> String {
        let tool = nodeBasename(binary).hasPrefix("gemini") ? "Gemini CLI" : "Antigravity"
        return "\(tool) · \(jsOr(model, jsOr(self.model, "auto")))"
    }

    /// The long prompt goes in on stdin; the short instruction on --prompt is where
    /// "@file" attachments are read, and stdin comes before it.
    static func arguments(model: String, slides: SlidesInfo?) -> [String] {
        let pdfs = picturedDecks(slides)
        let attached = pdfs.map { "@" + $0.file }.joined(separator: " ")
        let instruction = pdfs.isEmpty
            ? "Follow the instructions above."
            : "The slide decks: " + attached + " — read every page, then follow the instructions above."
        var args = ["--output-format", "json", "--skip-trust"]
        if !model.isEmpty {
            args += ["--model", model]
        }
        for folder in deckDirectories(pdfs) {
            args += ["--include-directories", folder]
        }
        args += ["--prompt", instruction]
        return args
    }

    public func complete(_ prompt: String, options: CallOptions) async throws -> Reply {
        let run = try await ProcessRunner.run(
            binary,
            arguments: AntigravityProvider.arguments(model: model, slides: options.slides),
            input: prompt + (options.slides.map { decksNote($0) } ?? ""),
            timeout: timeout,
            what: "Antigravity",
            install: "Install the Antigravity CLI (antigravity.google/cli) and run `agy` once to sign in."
        )
        return try antigravityReply(run)
    }
}

/// What the Antigravity CLI's `--output-format json` says: the reply in `response`, or an
/// `error`; usage is reported per model, and the one listed is the one that answered.
func antigravityReply(_ run: ProcessResult) throws -> Reply {
    let parsed: JSONValue
    do {
        parsed = try JSONValue.parse(cliTrim(run.stdout))
    } catch {
        let why = jsOr(
            ProcessRunner.lastLine(run.stderr),
            jsOr(ProcessRunner.lastLine(run.stdout), "exit code \(exitCodeText(run.code))")
        )
        throw CloudError("Antigravity couldn't answer: \(why)")
    }
    if parsed.isNull {
        // `parsed.error` on null: JavaScript's own TypeError.
        throw LockinError("Cannot read properties of null (reading 'error')")
    }
    let error = parsed.objectValue?["error"]
    let response = parsed.objectValue?["response"]
    guard !(error?.isTruthy ?? false), case .string(let text)? = response else {
        let why: String
        if case .string(let message)? = error {
            why = message
        } else if let message = nonNullish(error?.objectValue?["message"]) {
            why = jsString(message)
        } else {
            why = "no reply"
        }
        throw CloudError("Antigravity couldn't answer: \(why)")
    }
    // `Object.keys(parsed.stats?.models ?? {})[0] ?? null`.
    let model: String?
    switch parsed.objectValue?["stats"]?.objectValue?["models"] {
    case .object(let models)?:
        model = models.keys.first
    case .array(let items)?:
        model = items.isEmpty ? nil : "0"
    case .string(let characters)?:
        model = characters.isEmpty ? nil : "0"
    default:
        model = nil
    }
    return Reply(text: text, model: model)
}
