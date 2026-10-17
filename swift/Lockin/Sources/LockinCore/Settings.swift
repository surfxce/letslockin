import Foundation
import GRDB

// Port of lib/settings.ts and lib/modes.ts. Settings are rows of the `Setting` table,
// each value stored as JSON (`"auto"`, `2`, `null`), shared with the Electron app.
//
// Named `LockinSettings` rather than `Settings`: SwiftUI has a `Settings` scene, and the
// app target imports both.

// MARK: - Modes and choices (lib/modes.ts)

/// How Lockin gets its summaries, LAQs and marks (`Mode`). Open, like the other kinds:
/// a value written by a newer app is kept, and runs as `auto` does.
///  - auto: a cloud AI on this computer (Claude Code by default), through the queue.
///  - local: a model downloaded to this computer, through the queue. Fully offline.
///  - manual: copy a prompt into any AI chat and paste the reply back. Nothing runs here.
public struct AppMode: LockinStringKind, Hashable {
    public var rawValue: String
    public init?(rawValue: String) { self.rawValue = rawValue }

    public static let auto = AppMode(rawValue: "auto")!
    public static let local = AppMode(rawValue: "local")!
    public static let manual = AppMode(rawValue: "manual")!
    public static let allKnown: [AppMode] = [.auto, .local, .manual]

    /// `MODE_LABEL`; nil for a mode this app does not know.
    public var label: String? {
        switch rawValue {
        case "auto": return "Claude Code"
        case "local": return "On this computer"
        case "manual": return "Copy & paste"
        default: return nil
        }
    }

    /// Whether the queue does the AI part, so "Prepare with AI" and marking apply.
    public var usesAi: Bool { rawValue != "manual" }
}

/// Which Claude does the work in "auto" mode, by Claude Code's own names for the latest of each.
public enum CloudModel: String, CaseIterable, Codable, Sendable {
    case sonnet
    case opus
    case haiku

    public var label: String {
        switch self {
        case .sonnet: return "Sonnet"
        case .opus: return "Opus"
        case .haiku: return "Haiku"
        }
    }
}

/// How LAQs are written: as a scenario ("story"), straight out ("facts"), or a mix.
public enum LaqStyle: String, CaseIterable, Codable, Sendable {
    case mixed
    case story
    case facts

    public var label: String {
        switch self {
        case .mixed: return "Mixed"
        case .story: return "Story"
        case .facts: return "Facts"
        }
    }
}

/// Which cloud AI "auto" mode uses.
public enum CloudEngine: String, CaseIterable, Codable, Sendable {
    case claude
    case codex
    case antigravity
    case api

    public var label: String {
        switch self {
        case .claude: return "Claude Code"
        case .codex: return "ChatGPT Codex"
        case .antigravity: return "Google Antigravity"
        case .api: return "API key"
        }
    }
}

public struct ApiServiceInfo: Equatable, Sendable {
    public var label: String
    public var baseUrl: String
    public var keys: String
    public var modelHint: String

    public init(label: String, baseUrl: String, keys: String, modelHint: String) {
        self.label = label
        self.baseUrl = baseUrl
        self.keys = keys
        self.modelHint = modelHint
    }
}

/// Services an API key can be for. All but Anthropic speak OpenAI's chat format.
public enum ApiService: String, CaseIterable, Codable, Sendable {
    case anthropic
    case openai
    case gemini
    case openrouter
    case groq
    case custom

    public var info: ApiServiceInfo {
        switch self {
        case .anthropic:
            return ApiServiceInfo(label: "Anthropic (Claude)", baseUrl: "", keys: "console.anthropic.com", modelHint: "")
        case .openai:
            return ApiServiceInfo(
                label: "OpenAI",
                baseUrl: "https://api.openai.com/v1",
                keys: "platform.openai.com/api-keys",
                modelHint: "a GPT model name from OpenAI's model list"
            )
        case .gemini:
            return ApiServiceInfo(
                label: "Google Gemini",
                baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
                keys: "aistudio.google.com/apikey",
                modelHint: "a Gemini model name from Google AI Studio"
            )
        case .openrouter:
            return ApiServiceInfo(
                label: "OpenRouter",
                baseUrl: "https://openrouter.ai/api/v1",
                keys: "openrouter.ai/keys",
                modelHint: "a model id from openrouter.ai/models, such as provider/model"
            )
        case .groq:
            return ApiServiceInfo(
                label: "Groq",
                baseUrl: "https://api.groq.com/openai/v1",
                keys: "console.groq.com/keys",
                modelHint: "a model id from console.groq.com"
            )
        case .custom:
            return ApiServiceInfo(label: "Another service", baseUrl: "", keys: "", modelHint: "the model name the service expects")
        }
    }
}

/// The most LAQs per lecture hour either setting allows.
public let maxPerHour = 8

/// A per-hour count from a form or a hand-edited setting: a whole number, 1 to
/// `maxPerHour` (`perHour(raw, fallback)`, with JavaScript's `Number(raw)`).
public func perHour(_ raw: JSONValue?, fallback: Int = 2) -> Int {
    let n = jsMathRound(jsNumberValue(raw))
    guard n.isFinite && n >= 1 else { return fallback }
    return Int(min(Double(maxPerHour), n))
}

public func perHour(_ raw: Double, fallback: Int = 2) -> Int {
    perHour(.number(raw), fallback: fallback)
}

/// What the LAQ prompts say about style, in the cloud prompt and the copy-and-paste one.
public func laqStyleNote(_ style: LaqStyle?) -> String {
    if style == .story {
        let note: String = "\nSet every question in a short scenario: a named person in a concrete situation, such as what they "
            + "eat and when, a run, a night without sleep, a symptom or a patient presenting. For example: \"Jane eats "
            + "porridge at 7am, skips lunch and runs 5 km at 5pm. Explain how insulin and glucagon coordinate her energy "
            + "storage and release across liver, muscle and adipose tissue.\" One or two sentences of scenario, then an "
            + "ask that still needs the lecture's mechanisms to answer well.\n"
        return note
    }
    if style == .facts {
        let note: String = "\nAsk straight out, with no scenario or story: name the topic and say exactly what to describe, explain, "
            + "compare or evaluate. For example: \"Describe how insulin is synthesised and how it promotes glucose uptake "
            + "into skeletal muscle. Compare GLUT4 with GLUT1 and GLUT3, and explain the role of GLUT2 in pancreatic "
            + "beta-cells.\" Several linked parts in one question are good.\n"
        return note
    }
    return ""
}

// MARK: - Settings (lib/settings.ts)

public struct LockinSettings: Equatable, Sendable {
    public var mode: AppMode = .auto
    /// Desktop notifications when a lecture's LAQs are due.
    public var notify: Bool = false
    /// The first-run walkthrough has been seen.
    public var onboarded: Bool = false
    /// Catalog id of the downloaded model used in "local" mode.
    public var localModel: String? = nil
    /// A separate model, on MLX, that looks at the slides for `localModel`; nil when it looks itself.
    public var slideReader: String? = nil
    /// LAQs written per hour of lecture, when it is prepared and on "Write new LAQs".
    public var laqsPerHour: Int = 2
    /// LAQs a sitting asks per hour of lecture.
    public var sittingPerHour: Int = 2
    /// How LAQs are asked: as a scenario, straight to the point, or a mix.
    public var laqStyle: LaqStyle = .mixed
    /// Which Claude prepares lectures and marks in "auto" mode.
    public var cloudModel: CloudModel = .sonnet
    /// When the cloud AI fails, do the job on the downloaded offline model instead, if there is one.
    public var fallbackLocal: Bool = true
    /// Which cloud AI "auto" mode uses.
    public var cloudEngine: CloudEngine = .claude
    /// Codex's model; empty for whatever Codex is set to use.
    public var codexModel: String = ""
    /// Antigravity's model; empty for its own choice.
    public var agyModel: String = ""
    /// What the API key is for. Claude on the API uses `cloudModel`.
    public var apiService: ApiService = .anthropic
    /// For "custom": the service's address, ending in /v1 or similar.
    public var apiBaseUrl: String = ""
    /// For services other than Anthropic: the model name.
    public var apiModel: String = ""
    /// The API model takes images, so it is shown the slides as pictures.
    public var apiVision: Bool = true

    public init() {}

    /// `DEFAULTS`.
    public static let defaults = LockinSettings()

    /// The `Setting` keys these come from, in `DEFAULTS` order.
    public static let keys: [String] = [
        "mode", "notify", "onboarded", "localModel", "slideReader", "laqsPerHour", "sittingPerHour",
        "laqStyle", "cloudModel", "fallbackLocal", "cloudEngine", "codexModel", "agyModel", "apiService",
        "apiBaseUrl", "apiModel", "apiVision",
    ]

    /// The defaults with whatever parsed values are given laid over them, then checked as
    /// `getSettings()` checks them.
    public init(raw: [String: JSONValue]) {
        self.init()
        if case .string(let text)? = raw["mode"], let value = AppMode(rawValue: text) {
            mode = value
        }
        if let value = raw["notify"] {
            notify = value.isTruthy
        }
        if let value = raw["onboarded"] {
            onboarded = value.isTruthy
        }
        if let value = raw["localModel"] {
            localModel = value.stringValue
        }
        if let value = raw["slideReader"] {
            slideReader = value.stringValue
        }
        laqsPerHour = perHour(raw["laqsPerHour"] ?? .int(2), fallback: 2)
        sittingPerHour = perHour(raw["sittingPerHour"] ?? .int(2), fallback: 2)
        if case .string(let text)? = raw["laqStyle"], let value = LaqStyle(rawValue: text) {
            laqStyle = value
        }
        if case .string(let text)? = raw["cloudModel"], let value = CloudModel(rawValue: text) {
            cloudModel = value
        }
        if let value = raw["fallbackLocal"] {
            fallbackLocal = value != .bool(false)
        }
        if case .string(let text)? = raw["cloudEngine"], let value = CloudEngine(rawValue: text) {
            cloudEngine = value
        }
        codexModel = raw["codexModel"]?.stringValue ?? ""
        agyModel = raw["agyModel"]?.stringValue ?? ""
        if case .string(let text)? = raw["apiService"], let value = ApiService(rawValue: text) {
            apiService = value
        }
        apiBaseUrl = raw["apiBaseUrl"]?.stringValue ?? ""
        apiModel = raw["apiModel"]?.stringValue ?? ""
        if let value = raw["apiVision"] {
            apiVision = value != .bool(false)
        }
    }
}

/// `getSettings()`: every setting, a hand-edited or half-written value falling back to its default.
public func getSettings(db: Database) throws -> LockinSettings {
    let rows = try Setting.filter(LockinSettings.keys.contains(Column("key"))).fetchAll(db)
    var raw: [String: JSONValue] = [:]
    for row in rows {
        if let value = try? JSONValue.parse(row.value) {
            raw[row.key] = value
        }
    }
    return LockinSettings(raw: raw)
}

public func getSettings(database: LockinDatabase) throws -> LockinSettings {
    try database.reader.read { db in
        try getSettings(db: db)
    }
}

/// `setSetting(key, value)`: stores the value as JSON, creating or updating the row.
public func setSetting(db: Database, key: String, value: JSONValue, now: Date = Date()) throws {
    var row = Setting(key: key, value: value.stringified(), updatedAt: now)
    try row.save(db)
}

/// The API key, kept apart from the other settings so it is never handed to a page.
public let apiKeySettingKey = "apiKey"

public func getApiKey(db: Database) throws -> String? {
    guard let row = try Setting.fetchOne(db, key: apiKeySettingKey) else { return nil }
    guard let value = try? JSONValue.parse(row.value), case .string(let key) = value, !key.isEmpty else {
        return nil
    }
    return key
}

public func setApiKey(db: Database, _ key: String?, now: Date = Date()) throws {
    guard let key, !key.isEmpty else {
        _ = try Setting.deleteOne(db, key: apiKeySettingKey)
        return
    }
    try setSetting(db: db, key: apiKeySettingKey, value: .string(key), now: now)
}

// MARK: - Who runs the queue (worker.heartbeat)

/// Written by whichever app runs the queue every few seconds, so the other app (and the
/// UI) can tell a running queue from a stopped one (`HEARTBEAT_KEY`).
public let heartbeatKey = "worker.heartbeat"
/// A queue counts as running if it has checked in within this window (`HEARTBEAT_STALE_MS`).
public let heartbeatStaleMs = 20_000
/// How often the owner checks in (`HEARTBEAT_MS` in worker/index.ts).
public let heartbeatIntervalMs = 5_000
/// The `app` this app writes into its heartbeat; the Electron worker writes none.
public let swiftHeartbeatApp = "swift"

/// `{at, pid, provider}` as the Electron worker writes it, plus `app: "swift"` from this app.
public struct Heartbeat: Equatable, Sendable {
    /// ISO time, as `new Date().toISOString()` writes it.
    public var at: String
    public var pid: Int
    /// What runs the work: "Claude Code", "On this computer"… (nil when the mode is unknown).
    public var provider: String?
    /// "swift" from this app; nil from the Electron worker.
    public var app: String?

    public init(at: String, pid: Int, provider: String?, app: String? = nil) {
        self.at = at
        self.pid = pid
        self.provider = provider
        self.app = app
    }

    /// This process's heartbeat.
    public static func current(
        now: Date = Date(),
        pid: Int = Int(ProcessInfo.processInfo.processIdentifier),
        provider: String?
    ) -> Heartbeat {
        Heartbeat(at: jsISOString(now), pid: pid, provider: provider, app: swiftHeartbeatApp)
    }

    public var date: Date? { PrismaDate.parseString(at) }

    public var isSwift: Bool { app == swiftHeartbeatApp }

    public var json: JSONValue {
        var object: JSONObject = ["at": .string(at), "pid": .int(pid)]
        if let provider {
            object["provider"] = .string(provider)
        }
        if let app {
            object["app"] = .string(app)
        }
        return .object(object)
    }

    /// Tolerant of hand edits: a value that isn't an object is no heartbeat.
    public static func parse(_ value: String) -> Heartbeat? {
        guard let parsed = try? JSONValue.parse(value), case .object(let object) = parsed else { return nil }
        return Heartbeat(
            at: object["at"]?.stringValue ?? "",
            pid: object["pid"]?.intValue ?? 0,
            provider: object["provider"]?.stringValue,
            app: object["app"]?.stringValue
        )
    }

    /// Checked in within `heartbeatStaleMs` of `now`.
    public func isAlive(now: Date = Date()) -> Bool {
        guard let date else { return false }
        return now.timeIntervalSince(date) * 1000 < Double(heartbeatStaleMs)
    }
}

public struct HeartbeatStatus: Equatable, Sendable {
    public var heartbeat: Heartbeat
    public var alive: Bool

    public init(heartbeat: Heartbeat, alive: Bool) {
        self.heartbeat = heartbeat
        self.alive = alive
    }
}

/// `readHeartbeat()`: nil when there is no heartbeat row (or it is unreadable).
public func readHeartbeat(db: Database, now: Date = Date()) throws -> HeartbeatStatus? {
    guard let row = try Setting.fetchOne(db, key: heartbeatKey) else { return nil }
    guard let beat = Heartbeat.parse(row.value) else { return nil }
    return HeartbeatStatus(heartbeat: beat, alive: beat.isAlive(now: now))
}

public func writeHeartbeat(db: Database, _ beat: Heartbeat, now: Date = Date()) throws {
    try setSetting(db: db, key: heartbeatKey, value: beat.json, now: now)
}

/// Deletes the heartbeat row; with `pid`, only when it is this app's heartbeat with that pid.
public func deleteHeartbeat(db: Database, onlyIfPid pid: Int? = nil) throws {
    if let pid {
        guard let status = try readHeartbeat(db: db),
              status.heartbeat.isSwift,
              status.heartbeat.pid == pid else { return }
    }
    _ = try Setting.deleteOne(db, key: heartbeatKey)
}

/// What the heartbeat says runs the work: the cloud engine in "auto" mode, else the mode.
public func heartbeatProviderLabel(_ settings: LockinSettings) -> String? {
    if settings.mode == .auto {
        return settings.cloudEngine.label
    }
    return settings.mode.label
}

/// Who may claim jobs, from the heartbeat row.
public enum QueueOwnership: Equatable, Sendable {
    /// No live heartbeat — missing, unreadable or stale. Whoever takes the queue requeues
    /// RUNNING jobs left by the last owner.
    case free
    /// This process's own heartbeat (app "swift", same pid), fresh or stale.
    case ours
    /// Another live queue: the Electron worker, or another copy of this app.
    case taken(Heartbeat)
}

public func queueOwnership(_ status: HeartbeatStatus?, pid: Int) -> QueueOwnership {
    guard let status else { return .free }
    if status.heartbeat.isSwift && status.heartbeat.pid == pid {
        return .ours
    }
    return status.alive ? .taken(status.heartbeat) : .free
}
