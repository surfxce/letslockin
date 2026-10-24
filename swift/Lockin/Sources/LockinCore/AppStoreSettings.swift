import Foundation
import GRDB

// The Settings pane's side of AppStore: writing settings (each a Setting row, so the
// live observation refreshes every view), and the model actions of app/actions.ts
// (downloadModel, switchLocalModel, choosePair, deleteLocalModel) with the payload the
// Models pane reads (modelsPayload in lib/payloads.ts).

extension AppStore {
    // MARK: - Writing settings

    /// The stored JSON for one key, as `LockinSettings` holds it (`getSettings` in
    /// reverse, for writing only what changed).
    private static func settingValue(_ settings: LockinSettings, key: String) -> JSONValue {
        switch key {
        case "mode": return .string(settings.mode.rawValue)
        case "notify": return .bool(settings.notify)
        case "onboarded": return .bool(settings.onboarded)
        case "localModel": return JSONValue.orNull(settings.localModel)
        case "slideReader": return JSONValue.orNull(settings.slideReader)
        case "laqsPerHour": return .int(settings.laqsPerHour)
        case "sittingPerHour": return .int(settings.sittingPerHour)
        case "laqStyle": return .string(settings.laqStyle.rawValue)
        case "cloudModel": return .string(settings.cloudModel.rawValue)
        case "fallbackLocal": return .bool(settings.fallbackLocal)
        case "cloudEngine": return .string(settings.cloudEngine.rawValue)
        case "codexModel": return .string(settings.codexModel)
        case "agyModel": return .string(settings.agyModel)
        case "apiService": return .string(settings.apiService.rawValue)
        case "apiBaseUrl": return .string(settings.apiBaseUrl)
        case "apiModel": return .string(settings.apiModel)
        case "apiVision": return .bool(settings.apiVision)
        default: return .null
        }
    }

    /// Changes settings and writes only the keys that moved (`setSetting` per key — the
    /// observation picks the new values up, so there is no save button to forget).
    public func updateSettings(_ transform: (inout LockinSettings) -> Void) {
        guard let database else { return }
        var next = settings
        transform(&next)
        let changed: [(String, JSONValue)] = LockinSettings.keys.compactMap { key in
            let before = Self.settingValue(settings, key: key)
            let after = Self.settingValue(next, key: key)
            return before == after ? nil : (key, after)
        }
        guard !changed.isEmpty else { return }
        do {
            let now = Date()
            try database.writer.write { db in
                for (key, value) in changed {
                    try setSetting(db: db, key: key, value: value, now: now)
                }
            }
            settings = next
            mode = next.mode.rawValue
            dbRevision &+= 1
        } catch {
            errorMessage = messageOf(error)
        }
    }

    /// The API key, kept apart from the other settings so it is never handed to a page.
    public func setApiKeySetting(_ key: String?) {
        guard let database else { return }
        let trimmed = key.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        do {
            try database.writer.write { db in
                try setApiKey(db: db, trimmed)
            }
        } catch {
            errorMessage = messageOf(error)
        }
    }

    public var savedApiKeySuffix: String? {
        guard let database else { return nil }
        return try? database.reader.read { db in
            try getApiKey(db: db).map { "…\($0.suffix(4))" }
        }
    }

    /// `finishOnboarding`: the tour's last word — how the AI part happens and whether
    /// reminders are on.
    public func finishOnboarding(mode: AppMode, notify: Bool) {
        updateSettings { settings in
            settings.mode = mode
            settings.notify = notify
            settings.onboarded = true
        }
    }

    /// `testCloudEngine`: sends one tiny question, to check the cloud AI is set up.
    public func testCloudEngine() async -> ActionResult {
        guard let database else { return .failed("Database is not open.") }
        do {
            let services = LockinServices.live()
            let settingsNow = try getSettings(database: database)
            let provider = try await cloudProvider(settings: settingsNow, database: database, services: services)
            let started = Date()
            _ = try await provider.ask(.breakdown(AskBreakdown(
                lectureTitle: "A quick test",
                summary: "Insulin lowers blood glucose by moving GLUT4 to the surface of muscle and fat cells.",
                selection: "GLUT4"
            )))
            let seconds = Int(Date().timeIntervalSince(started).rounded())
            return .ok("Working — \(provider.lastModel) answered in \(seconds)s.")
        } catch {
            return .failed(messageOf(error))
        }
    }

    // MARK: - The Models pane (modelsPayload)

    /// What the Models pane shows: this computer, the three picks for it, what is here
    /// already, and what is on its way.
    public struct InstalledModelInfo: Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var bytes: Int
        /// An MLX copy sees slides with the model itself; a vision model without one is
        /// `missing` here (the Electron app can fetch its vision part).
        public var visionReady: Bool
        public var visionMissing: Bool
        public var isMLX: Bool
        public var canSwitchToMlx: Bool

        public var gbOnDisk: String {
            bytes < 1_073_741_824
                ? "\(Int((Double(bytes) / 1_048_576).rounded())) MB"
                : String(format: "%.1f GB", Double(bytes) / 1_073_741_824)
        }
    }

    public struct ModelsSnapshot: Equatable, Sendable {
        public var specs: MachineSpecs
        public var picks: ModelPicks
        /// `mlxAvailable()`: whether this computer runs MLX, so models come as MLX.
        public var mlx: Bool
        public var installed: [InstalledModelInfo]
        public var active: String?
        public var pairs: [ModelPair]
        public var slideReader: String?
        public var downloads: [DownloadState]
        public var workerAlive: Bool

        public var busy: Bool { downloads.contains { $0.isActive } }
        public func download(forModel id: String) -> DownloadState? {
            downloads.first { $0.modelId == id }
        }
        public func installedInfo(forModel id: String) -> InstalledModelInfo? {
            installed.first { $0.id == id }
        }
    }

    /// `modelsPayload()`, read fresh for each look of the pane.
    public func modelsSnapshot() -> ModelsSnapshot {
        let specs = machineSpecs()
        let picks = recommendModels(specs)
        var installedInfos: [InstalledModelInfo] = []
        var installedIds: Set<String> = []
        if let database {
            if let installed = try? installedModels(database: database) {
                installedIds = Set(installed.map(\.id))
                installedInfos = installed.map { entry in
                    let model = findModel(entry.id)
                    let isMlx = entry.isMLX
                    let vision = model?.vision ?? false
                    return InstalledModelInfo(
                        id: entry.id,
                        name: model?.name ?? entry.id,
                        bytes: entry.bytes,
                        visionReady: vision && (isMlx || MLXEngine.isAvailable),
                        visionMissing: vision && !isMlx && !MLXEngine.isAvailable,
                        isMLX: isMlx,
                        canSwitchToMlx: !isMlx && model?.mlx != nil && MLXEngine.isAvailable
                    )
                }
            }
        }
        let settingsNow = settings
        let active = installedIds.contains(settingsNow.localModel ?? "") ? settingsNow.localModel : nil
        let states = database.flatMap { try? downloadStates(database: $0) } ?? []
        return ModelsSnapshot(
            specs: specs,
            picks: picks,
            mlx: MLXEngine.isAvailable,
            installed: installedInfos,
            active: active,
            pairs: modelPairs,
            slideReader: settingsNow.slideReader,
            downloads: states,
            workerAlive: queueActivity?.worker?.alive ?? false
        )
    }

    /// Progress polling only reads job rows. Installed model directories can be many
    /// gigabytes and only need scanning when a download finishes or an action runs.
    public func refreshingModelDownloads(_ previous: ModelsSnapshot) -> ModelsSnapshot {
        guard let database, let states = try? downloadStates(database: database) else { return previous }
        let previousActive = Set(previous.downloads.filter(\.isActive).map(\.jobId))
        let active = Set(states.filter(\.isActive).map(\.jobId))
        if !previousActive.isSubset(of: active) { return modelsSnapshot() }
        var next = previous
        next.downloads = states
        next.workerAlive = queueActivity?.worker?.alive ?? false
        return next
    }

    // MARK: - Model actions (app/actions.ts)

    /// The model registry changed (a download finished, a model was deleted): views that
    /// hold their own snapshot of it re-read. Setting rows are already observed, so this
    /// only nudges the panes that read on demand.
    public func refreshAfterModelChange() {
        dbRevision &+= 1
    }

    /// What an action says back: ok with a line, or why not (`Result` in actions.ts).
    public struct ActionResult: Equatable, Sendable {
        public var ok: Bool
        public var message: String?

        public static func ok(_ message: String? = nil) -> ActionResult {
            ActionResult(ok: true, message: message)
        }
        public static func failed(_ message: String) -> ActionResult {
            ActionResult(ok: false, message: message)
        }
    }

    private func withDatabase(_ body: (LockinDatabase) throws -> ActionResult) -> ActionResult {
        guard let database else { return .failed("Database is not open.") }
        do {
            return try body(database)
        } catch {
            return .failed(messageOf(error))
        }
    }

    /// `downloadModel`: queues the download; the lane links it up when it finishes.
    public func downloadModel(_ modelId: String) -> ActionResult {
        withDatabase { database in
            _ = try database.writer.write { db in
                try enqueueDownload(db: db, modelId: modelId, environment: environment)
            }
            return .ok("Downloading \(findModel(modelId)?.name ?? modelId).")
        }
    }

    /// `switchLocalModel`: uses a model that is already downloaded.
    public func useModel(_ modelId: String) -> ActionResult {
        withDatabase { database in
            guard let model = findModel(modelId) else { return .failed("unknown model \(modelId)") }
            try database.writer.write { db in
                try linkModel(db: db, model: model, reader: .keep)
            }
            return .ok()
        }
    }

    /// `stopDownload`: the worker notices within a couple of seconds; the partial file is
    /// kept for a resume.
    public func stopDownload(_ jobId: String) {
        guard let database else { return }
        if let queue = jobQueue {
            Task { try? await queue.cancel(jobId: jobId) }
        } else {
            _ = try? database.writer.write { db in
                try cancelDownloadJob(db: db, jobId: jobId)
            }
        }
    }

    /// `choosePair`: one model looks at the slides, another writes. Downloads whichever of
    /// the two is not here yet, and links the writer with its eye — now if it is here,
    /// else when it is. The same model twice is just that model.
    public func choosePair(eyeId: String, writerId: String) -> ActionResult {
        withDatabase { database in
            guard let eye = findModel(eyeId), eye.vision, eye.mlx != nil, let writer = findModel(writerId) else {
                return .failed("Pick a model that sees slides, and one that writes")
            }
            let reader: String? = eyeId == writerId ? nil : eyeId
            if reader != nil, !MLXEngine.isAvailable {
                return .failed("A separate eye runs on MLX, on an Apple Silicon Mac with the desktop app")
            }
            return try database.writer.write { db in
                let installed = try installedModels(db: db, environment: environment)
                if let reader, !installed.contains(where: { $0.id == reader && $0.isMLX }) {
                    try enqueueEyeDownload(db: db, eyeId: reader, environment: environment)
                }
                if installed.contains(where: { $0.id == writerId }) {
                    try linkModel(db: db, model: writer, reader: .value(reader))
                } else {
                    try enqueueDownload(db: db, modelId: writerId, reader: .value(reader), environment: environment)
                }
                return .ok("Done.")
            }
        }
    }

    /// `deleteLocalModel`: forgets a model and deletes its file.
    public func deleteModel(_ modelId: String) -> ActionResult {
        withDatabase { database in
            try database.writer.write { db in
                try removeModel(db: db, id: modelId)
            }
            return .ok()
        }
    }

    // MARK: - Who can do the cloud AI (detect.ts)

    /// The three command-line tools, as Settings shows them.
    public struct AiDetection: Equatable, Sendable {
        public var claude: CLIStatus
        public var codex: CLIStatus
        public var antigravity: CLIStatus
    }

    /// `detectCli` / `detectCodex` / `detectAntigravity`, remembered for a minute each.
    public func detectAiTools() async -> AiDetection {
        let environment = self.environment
        async let claude = CLIDetect.claude(environment: environment)
        async let codex = CLIDetect.codex(environment: environment)
        async let antigravity = CLIDetect.antigravity(environment: environment)
        return AiDetection(claude: await claude, codex: await codex, antigravity: await antigravity)
    }

    private var environment: [String: String] {
        ProcessInfo.processInfo.environment
    }
}
