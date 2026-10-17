import Foundation
import GRDB
import os

// Port of lib/llm/index.ts (which provider a job runs on) and of the worker's
// `currentProvider()` and `withFallback()` (worker/index.ts): the cloud AI Settings chose,
// or the downloaded model in local mode; and when the cloud AI fails, the offline model
// does the job instead, if one is downloaded and Settings allow.
//
// Unlike the TypeScript nothing is cached: every call builds a fresh provider, so a
// change in Settings applies to the next job, and `lastModel` describes only that job.

private let factoryLogger = os.Logger(subsystem: "app.lockin", category: "queue")

/// JavaScript's white space and line ends, which `String.prototype.trim` removes.
private let jsTrimCharacters: CharacterSet = {
    var set = CharacterSet.whitespacesAndNewlines
    set.insert(charactersIn: "\u{FEFF}")
    set.remove(charactersIn: "\u{0085}")
    return set
}()

/// `text.trim()`.
private func jsTrim(_ text: String) -> String {
    text.trimmingCharacters(in: jsTrimCharacters)
}

/// `isFake()`: `LOCKIN_PROVIDER=fake` stands in for every mode with canned output.
public func isFakeProvider(_ environment: [String: String]) -> Bool {
    environment["LOCKIN_PROVIDER"] == "fake"
}

/// `Number(process.env.LOCKIN_CLI_TIMEOUT_MS ?? 600_000)`, in seconds: how long a CLI or
/// an API request may take. A value setTimeout would not take (NaN, below 1 ms, past
/// its limit) waits 1 ms, as setTimeout does.
public func cliTimeout(environment: [String: String]) -> TimeInterval {
    guard let raw = environment["LOCKIN_CLI_TIMEOUT_MS"] else { return 600 }
    let ms = jsNumberValue(.string(raw))
    guard ms >= 1 && ms <= 2_147_483_647 else { return 0.001 }
    return ms / 1000
}

/// `getProvider(model)`: the Claude Code provider for a model ("sonnet", "opus"…), or the
/// fake one when the environment asks for it (`LOCKIN_PROVIDER`, "cli" by default).
public func claudeCodeProvider(model: String?, services: LockinServices) throws -> any LLMProvider {
    let kind = services.environment["LOCKIN_PROVIDER"] ?? "cli"
    switch kind {
    case "cli":
        var config = ClaudeCodeConfig.fromEnvironment(services.environment)
        if let model, !model.isEmpty {
            config.model = model
        }
        return ClaudeCodeProvider(config: config)
    case "fake":
        return FakeProvider(environment: services.environment)
    case "api":
        throw LockinError("the Anthropic SDK adapter is not built yet — set LOCKIN_PROVIDER=cli")
    default:
        throw LockinError("unknown LOCKIN_PROVIDER \"\(kind)\"")
    }
}

/// `cloudProvider()`: the cloud AI Settings have chosen for "auto" mode — Claude Code,
/// ChatGPT Codex, Google Antigravity, or a service reached with an API key. Built at the
/// start of each job, so a change in Settings applies to the next one.
public func cloudProvider(
    settings: LockinSettings,
    database: LockinDatabase,
    services: LockinServices
) async throws -> any LLMProvider {
    let environment = services.environment
    if isFakeProvider(environment) {
        return FakeProvider(environment: environment)
    }
    switch settings.cloudEngine {
    case .codex:
        return CodexProvider(
            binary: environment["LOCKIN_CODEX_BIN"] ?? "codex",
            model: jsTrim(settings.codexModel),
            renderer: services.renderer,
            timeout: cliTimeout(environment: environment)
        )
    case .antigravity:
        let status = await CLIDetect.antigravity(environment: environment)
        return AntigravityProvider(
            binary: status.binary,
            model: jsTrim(settings.agyModel),
            timeout: cliTimeout(environment: environment)
        )
    case .api:
        let key = try factoryRead(database) { db in try getApiKey(db: db) }
        let service = settings.apiService
        let info = service.info
        if service == .anthropic {
            guard let key else {
                return MisconfiguredProvider(what: "Anthropic API", problem: "Add your Anthropic API key in Settings")
            }
            return AnthropicAPIProvider(
                apiKey: key,
                model: apiClaudeModels[settings.cloudModel] ?? settings.cloudModel.rawValue,
                timeout: cliTimeout(environment: environment)
            )
        }
        let base = service == .custom ? jsTrim(settings.apiBaseUrl) : info.baseUrl
        if base.isEmpty {
            return MisconfiguredProvider(what: info.label, problem: "Add the service's address in Settings")
        }
        // A service on this computer (Ollama, LM Studio) may need no key.
        if key == nil && service != .custom {
            return MisconfiguredProvider(what: info.label, problem: "Add your \(info.label) API key in Settings")
        }
        return OpenAICompatibleProvider(
            service: service == .custom ? serviceHostName(base) : info.label,
            baseURL: base,
            apiKey: key ?? "",
            model: jsTrim(settings.apiModel),
            seesSlides: settings.apiVision,
            renderer: services.renderer,
            timeout: cliTimeout(environment: environment)
        )
    case .claude:
        return try claudeCodeProvider(model: settings.cloudModel.rawValue, services: services)
    }
}

/// `new URL(url).host`, or "API" when the address isn't one: what a custom service is
/// called beside what it wrote ("localhost:11434 · llama3").
func serviceHostName(_ url: String) -> String {
    guard let components = URLComponents(string: url), let scheme = components.scheme?.lowercased() else {
        return "API"
    }
    let defaultPorts: [String: Int] = ["http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21]
    var host = components.host ?? ""
    if defaultPorts[scheme] != nil {
        // A web address must name a host; its name is case-blind.
        if host.isEmpty {
            return "API"
        }
        host = host.lowercased()
    }
    if host.contains(":") && !host.hasPrefix("[") {
        host = "[\(host)]"
    }
    guard let port = components.port else { return host }
    if let standard = defaultPorts[scheme], standard == port {
        return host
    }
    return "\(host):\(port)"
}

/// A provider for a downloaded model (`getLocalProvider`): MLX, or the fake one under
/// `LOCKIN_PROVIDER=fake`.
public func localProvider(_ model: ActiveLocalModel, services: LockinServices) -> any LLMProvider {
    if isFakeProvider(services.environment) {
        return FakeProvider(environment: services.environment)
    }
    return MLXProvider(modelPath: model.path, modelName: model.model.name, modelId: model.model.id, engine: services.engine)
}

/// `currentProvider()`: which provider the next job runs on, from the settings as they are
/// now. Nil means nothing can run — copy-and-paste mode, or local mode with no model
/// downloaded yet — and jobs then wait in the queue rather than failing.
public func currentProvider(database: LockinDatabase, services: LockinServices) async throws -> (any LLMProvider)? {
    let settings = try getSettings(database: database)
    if settings.mode == .manual {
        return nil
    }
    if settings.mode == .local {
        guard let active = try activeLocalModel(database: database) else { return nil }
        return localProvider(active, services: services)
    }
    return try await cloudProvider(settings: settings, database: database, services: services)
}

/// The offline model a failed cloud job is handed to, and its name for the log.
struct OfflineFallbackChoice: Sendable {
    var provider: any LLMProvider
    var modelName: String
}

/// `fallbackLocalModel()` as a provider: nil when no offline model is downloaded.
func offlineFallback(database: LockinDatabase, services: LockinServices) throws -> OfflineFallbackChoice? {
    guard let model = try fallbackLocalModel(database: database) else { return nil }
    return OfflineFallbackChoice(provider: localProvider(model, services: services), modelName: model.model.name)
}

/// `withFallback(primary, work, onFallback)`: the cloud AI first; if it fails — signed out,
/// rate limited, a reply that would not parse — the offline model does the job instead,
/// when one is downloaded and Settings allow (auto mode, "use the offline model when the
/// cloud fails" on). A lecture with nothing to read fails the same way on any model, so
/// that is not retried; nor is a cancelled job.
public func withFallback<T>(
    _ primary: any LLMProvider,
    database: LockinDatabase,
    services: LockinServices,
    work: (any LLMProvider) async throws -> T,
    onFallback: (@Sendable (String, any LLMProvider) -> Void)? = nil
) async throws -> FallbackOutcome<T> {
    try await withFallback(
        primary,
        settings: { try getSettings(database: database) },
        isFake: isFakeProvider(services.environment),
        offline: { try offlineFallback(database: database, services: services) },
        work: work,
        onFallback: onFallback
    )
}

/// `withFallback` with its lookups handed in: the settings as they are when the cloud
/// fails, whether the fake provider is in use, and the offline model, if any.
func withFallback<T>(
    _ primary: any LLMProvider,
    settings: () throws -> LockinSettings,
    isFake: Bool,
    offline: () throws -> OfflineFallbackChoice?,
    work: (any LLMProvider) async throws -> T,
    onFallback: (@Sendable (String, any LLMProvider) -> Void)?
) async throws -> FallbackOutcome<T> {
    do {
        let result = try await work(primary)
        return FallbackOutcome(result: result, used: primary)
    } catch {
        // Cancelled on purpose: nothing to fall back from.
        if error is CancellationError || Task.isCancelled {
            throw error
        }
        let cloudFailed = isCloudFailure(error)
        let current = try settings()
        if !cloudFailed || current.mode != .auto || !current.fallbackLocal || isFake {
            throw error
        }
        guard let choice = try offline() else {
            throw error
        }
        let why = messageOf(error)
        let line = "\(primary.lastModel) failed (\(why)); doing it on \(choice.modelName) instead"
        factoryLogger.warning("\(line, privacy: .public)")
        onFallback?(why, choice.provider)
        let result = try await work(choice.provider)
        return FallbackOutcome(result: result, used: choice.provider, fellBack: why)
    }
}

/// A synchronous read, so it never resolves to GRDB's async overload inside async code.
private func factoryRead<T>(_ database: LockinDatabase, _ body: (Database) throws -> T) throws -> T {
    try database.reader.read { db in
        try body(db)
    }
}
