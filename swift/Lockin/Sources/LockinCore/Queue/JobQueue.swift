import Foundation
import GRDB
import os

// Port of worker/index.ts: drains the Job table one job at a time — so a folder of
// lectures is prepared one lecture at a time, each finished before the next starts, and
// marking jumps the queue. Every job records its raw result, duration, prompt version,
// model and a timeline of the stages it went through.
//
// The main lane runs PREPARE, GENERATE and MARK. Sorting a folder (SORT), quick questions
// (ASK) and model downloads (DOWNLOAD) run in lanes of their own beside it, looked at
// more often: someone is waiting on the screen that started them.
//
// Both apps share lockin.db, and only one runs the queue at a time: whichever owns the
// `worker.heartbeat` row. This queue claims work only while it does, refreshes the row
// every few seconds, and deletes it on a clean stop. A job it was running when the app
// quit stays RUNNING, and whoever takes the queue next puts it back in line.

private let queueLogger = os.Logger(subsystem: "app.lockin", category: "queue")

private func queueInfo(_ line: String) {
    queueLogger.info("\(line, privacy: .public)")
}

private func queueError(_ line: String) {
    queueLogger.error("\(line, privacy: .public)")
}

/// What the side lanes say when Settings leave nothing to run them on.
private let noAIMessage = "no AI is set up — choose Claude Code or download an offline model in Settings"

/// What a job is told when the cloud AI failed and the offline model took over.
private let fellBackDetail = "The cloud AI failed — the offline model is doing it instead"

extension LockinServices {
    /// The real thing: PDFKit slide pictures, the Vision framework's text recognition and
    /// the MLX engine.
    public static func live(environment: [String: String] = ProcessInfo.processInfo.environment) -> LockinServices {
        LockinServices(renderer: SlideRenderer(), textReader: SlideOCR(), engine: MLXEngine.shared, environment: environment)
    }
}

/// What the queue is doing, for the AI panel.
public struct QueueStatus: Equatable, Sendable {
    public var started: Bool
    /// This app runs the queue: its heartbeat is the one in the database.
    public var ownsQueue: Bool
    /// The other app's heartbeat while it owns the queue.
    public var owner: Heartbeat?
    /// The job each lane is running, by id.
    public var running: [QueueLane: String]

    public init(started: Bool, ownsQueue: Bool, owner: Heartbeat?, running: [QueueLane: String]) {
        self.started = started
        self.ownsQueue = ownsQueue
        self.owner = owner
        self.running = running
    }
}

/// A main-lane handler (`JobHandler` in Handlers.swift has this shape).
typealias QueueJobHandler = @Sendable (JSONValue, JobContext, any LLMProvider) async throws -> JSONValue

/// What the queue looks up as it goes; tests hand in their own.
struct JobQueueHooks: Sendable {
    /// The provider the next job runs on (`currentProvider`); nil leaves the work waiting.
    var provider: @Sendable (LockinDatabase, LockinServices) async throws -> (any LLMProvider)?
    /// The main lane's handler for a kind (`mainLaneHandler(for:)`).
    var handler: @Sendable (JobKind) -> QueueJobHandler?
    /// The offline model a failed cloud job is handed to (`fallbackLocalModel`).
    var offline: @Sendable (LockinDatabase, LockinServices) throws -> OfflineFallbackChoice?

    static let live = JobQueueHooks(
        provider: { database, services in
            try await currentProvider(database: database, services: services)
        },
        handler: { kind in
            mainLaneHandler(for: kind)
        },
        offline: { database, services in
            try offlineFallback(database: database, services: services)
        }
    )
}

/// `claimNext()`, for an app that shares the queue: in one IMMEDIATE transaction, takes the
/// lane's next job only if no other live queue owns it. Nil when there is no job, or when
/// another app took the queue since this one last checked.
func claimNextJobIfOwner(database: LockinDatabase, lane: QueueLane, pid: Int, now: Date = Date()) throws -> Job? {
    // Most looks find nothing: a plain read first, so an idle lane never takes the write
    // lock the other app may want.
    let waiting = try database.reader.read { db in
        try nextPendingJob(db: db, lane: lane)
    }
    if waiting == nil {
        return nil
    }
    return try immediateWrite(database) { db -> Job? in
        let beat = try readHeartbeat(db: db, now: now)
        if case .taken = queueOwnership(beat, pid: pid) {
            return nil
        }
        return try claimNextJob(db: db, lane: lane, now: now)
    }
}

/// `{ ...result, fellBack }`: the job's result with why the cloud failed added last.
func resultWithFellBack(_ result: JSONValue, why: String) -> JSONValue {
    var object: JSONObject
    switch result {
    case .object(let existing):
        object = existing
    case .array(let items):
        object = JSONObject(items.enumerated().map { (String($0.offset), $0.element) })
    default:
        object = JSONObject()
    }
    object["fellBack"] = .string(why)
    return .object(object)
}

/// `{ ...result, model: used.lastModel }`: an answer with who wrote it, last.
func askResultJSON(_ result: AskResult, model: String) -> JSONValue {
    var answered = result
    answered.model = model
    guard case .object(var object) = answered.json else { return answered.json }
    object["model"] = .string(model)
    return .object(object)
}

/// Runs the queue in this app while it owns it (`main()` in worker/index.ts).
public actor JobQueue {
    private let database: LockinDatabase
    private let services: LockinServices
    private let timing: QueueTiming
    private let pid: Int
    private let hooks: JobQueueHooks

    private var started = false
    private var stopping = false
    /// This app's heartbeat is the live one: its lanes may claim work.
    private var owning = false
    private var owner: Heartbeat?
    private var running: [QueueLane: String] = [:]
    private var laneTasks: [Task<Void, Never>] = []
    private var heartbeatTask: Task<Void, Never>?
    /// The main lane's running work, so a cancel stops it at once.
    private var workTasks: [String: Task<FallbackOutcome<JSONValue>, Error>] = [:]
    /// Jobs cancelled while running here (the × in the AI panel, in either app).
    private var sideCancels: [String: @Sendable () -> Void] = [:]
    private var cancelledJobIds: Set<String> = []
    /// The last reason no provider could be chosen, so it is logged once.
    private var providerProblem: String?

    public init(
        database: LockinDatabase,
        services: LockinServices,
        timing: QueueTiming = .fromEnvironment(),
        pid: Int = Int(ProcessInfo.processInfo.processIdentifier)
    ) {
        self.database = database
        self.services = services
        self.timing = timing
        self.pid = pid
        self.hooks = .live
    }

    init(database: LockinDatabase, services: LockinServices, timing: QueueTiming, pid: Int, hooks: JobQueueHooks) {
        self.database = database
        self.services = services
        self.timing = timing
        self.pid = pid
        self.hooks = hooks
    }

    public var status: QueueStatus {
        QueueStatus(started: started, ownsQueue: owning, owner: owning ? nil : owner, running: running)
    }

    /// Takes the queue if no other app runs it (putting back jobs the last owner left
    /// RUNNING), then starts the heartbeat and the lanes. Calling it again does nothing.
    public func start() {
        guard !started else { return }
        started = true
        stopping = false
        beat()
        queueInfo("queue up, polling every \(Int((timing.poll * 1000).rounded()))ms")
        // The heartbeat runs on its own, so a long model call does not make the queue
        // look stopped to the other app.
        heartbeatTask = Task { await self.heartbeatLoop() }
        laneTasks = QueueLane.allCases.map { lane in
            Task { await self.laneLoop(lane) }
        }
    }

    /// A clean stop. A model call can run for minutes and is not waited out: running jobs
    /// are stopped where they are and left RUNNING, for whoever runs the queue next to put
    /// back in line. The heartbeat is deleted, and the MLX engine stopped.
    public func stop() async {
        guard started, !stopping else { return }
        stopping = true
        heartbeatTask?.cancel()
        let lanes = laneTasks
        for lane in lanes {
            lane.cancel()
        }
        for lane in lanes {
            await lane.value
        }
        if let beatTask = heartbeatTask {
            await beatTask.value
        }
        laneTasks = []
        heartbeatTask = nil
        let pid = self.pid
        do {
            try queueWrite(database) { db in try releaseQueue(db: db, pid: pid) }
        } catch {
            queueError("couldn't delete the heartbeat: \(messageOf(error))")
        }
        owning = false
        owner = nil
        await services.engine.stop()
        started = false
        stopping = false
        queueInfo("queue stopped")
    }

    /// The × in the AI panel: a waiting job leaves the queue; one running here is stopped
    /// at once (the other app's watcher notices within a couple of seconds).
    public func cancel(jobId: String) throws {
        let stopped = try queueWrite(database) { db in
            try (cancelJob(db: db, jobId: jobId) || cancelDownloadJob(db: db, jobId: jobId))
        }
        if stopped {
            cancelLocally(jobId)
        }
    }

    /// Puts a failed job back in the queue with its attempts reset.
    public func retry(jobId: String) throws {
        try queueWrite(database) { db in try retryJob(db: db, jobId: jobId) }
    }

    // MARK: - Owning the queue

    private func heartbeatLoop() async {
        while !Task.isCancelled && !stopping {
            await queueSleep(timing.heartbeat)
            if Task.isCancelled || stopping {
                return
            }
            beat()
        }
    }

    /// Writes this app's heartbeat if the queue is free or already ours (`heartbeat()`).
    private func beat() {
        let provider: String?
        do {
            let settings = try getSettings(database: database)
            provider = heartbeatProviderLabel(settings)
        } catch {
            queueError("heartbeat: \(messageOf(error))")
            return
        }
        let wasOwner = owning
        do {
            switch try acquireQueue(database: database, pid: pid, provider: provider, alreadyOwner: wasOwner) {
            case .kept:
                owning = true
                owner = nil
            case .tookOver(let requeued):
                owning = true
                owner = nil
                if requeued > 0 {
                    queueInfo("requeued \(requeued) job(s) interrupted by the last shutdown")
                }
            case .taken(let other):
                if wasOwner {
                    // The jobs running here finish as they are; nothing new is claimed.
                    queueInfo("the queue is now run by \(other.isSwift ? "another copy of Lockin" : "the Electron worker") (pid \(other.pid))")
                }
                owning = false
                owner = other
            }
        } catch {
            queueError("heartbeat: \(messageOf(error))")
        }
    }

    // MARK: - Lanes

    private func laneLoop(_ lane: QueueLane) async {
        let poll: TimeInterval
        switch lane {
        case .main: poll = timing.poll
        case .download, .sort: poll = timing.sortPoll
        case .ask: poll = timing.askPoll
        }
        while !Task.isCancelled && !stopping {
            let didWork: Bool
            switch lane {
            case .main: didWork = await runOne()
            case .download: didWork = await downloadOne()
            case .sort: didWork = await sortOne()
            case .ask: didWork = await askOne()
            }
            if Task.isCancelled || stopping {
                return
            }
            if !didWork {
                await queueSleep(poll)
            }
        }
    }

    /// The lane's next job, claimed, while this app owns the queue.
    private func claimNext(_ lane: QueueLane) -> Job? {
        guard owning, !stopping, !Task.isCancelled else { return nil }
        do {
            return try claimNextJobIfOwner(database: database, lane: lane, pid: pid)
        } catch {
            queueError("couldn't take the next \(lane.rawValue) job: \(messageOf(error))")
            return nil
        }
    }

    /// Starts a stage on a job's timeline, from the actor.
    private func enterStageOnActor(_ jobId: String, stage: Stage) throws {
        try queueWrite(database) { db in
            try LockinCore.enterStage(db: db, jobId: jobId, stage: stage)
        }
    }

    // MARK: - The main lane

    /// `runOne()`: false when there was nothing to run.
    private func runOne() async -> Bool {
        guard owning, !stopping else { return false }
        let chosen: (any LLMProvider)?
        do {
            chosen = try await hooks.provider(database, services)
            providerProblem = nil
        } catch {
            let message = messageOf(error)
            if message != providerProblem {
                queueError("couldn't choose the AI for the next job: \(message)")
                providerProblem = message
            }
            return false
        }
        // Copy-and-paste mode, or no offline model yet: the jobs wait.
        guard let provider = chosen else { return false }
        guard let job = claimNext(.main) else { return false }
        running[.main] = job.id
        await runMainJob(job, provider: provider)
        running[.main] = nil
        return true
    }

    private func runMainJob(_ job: Job, provider: any LLMProvider) async {
        let startedAt = Date()
        let database = self.database
        let services = self.services
        let hooks = self.hooks
        let fallbackBox = FallbackProviderBox()
        var watcher: Task<Void, Never>?

        do {
            let settings = try getSettings(database: database)
            let context = JobContext(job: job, database: database, settings: settings, services: services)
            let progress = context.progress
            provider.onProgress = progress
            guard let handler = hooks.handler(job.kind) else {
                throw LockinError("no handler for job kind \"\(job.kind.rawValue)\"")
            }
            let payload = try context.payload()
            let work = Task.detached { () async throws -> FallbackOutcome<JSONValue> in
                try await withFallback(
                    provider,
                    settings: { try getSettings(database: database) },
                    isFake: isFakeProvider(services.environment),
                    offline: { try hooks.offline(database, services) },
                    work: { chosen in try await handler(payload, context, chosen) },
                    onFallback: { _, local in
                        fallbackBox.provider = local
                        local.onProgress = progress
                        progress(fellBackDetail)
                    }
                )
            }
            workTasks[job.id] = work
            if cancelledJobIds.contains(job.id) {
                work.cancel()
            }
            // Cancelling is a status change, made by either app; watch for it.
            watcher = startCancelWatch(jobId: job.id)
            let outcome = try await withTaskCancellationHandler {
                try await work.value
            } onCancel: {
                work.cancel()
            }
            if cancelledJobIds.contains(job.id) {
                throw CancellationError()
            }
            let result = outcome.fellBack.map { resultWithFellBack(outcome.result, why: $0) } ?? outcome.result
            let used = outcome.used
            let durationMs = elapsedMs(since: startedAt)
            try queueWrite(database) { db in
                try completeJob(
                    db: db,
                    jobId: job.id,
                    result: result,
                    promptVersion: used.lastPromptVersion,
                    model: used.lastModel,
                    durationMs: durationMs,
                    closeTimeline: true
                )
            }
            queueInfo("✓ \(job.kind.rawValue) \(job.id) on \(used.name) (\(secondsText(durationMs))s)")
        } catch {
            let durationMs = elapsedMs(since: startedAt)
            if cancelledJobIds.contains(job.id) {
                // The row already says FAILED, "Cancelled".
                try? queueWrite(database) { db in try markJobCancelled(db: db, jobId: job.id, durationMs: durationMs) }
                queueInfo("■ \(job.kind.rawValue) \(job.id) cancelled")
            } else if stopping || Task.isCancelled {
                // The app is quitting: the job stays RUNNING, and is put back in line by
                // whoever runs the queue next.
                queueInfo("■ \(job.kind.rawValue) \(job.id) stopped with the queue; it runs again at the next start")
            } else {
                let message = messageOf(error)
                let retry = job.attempts < maxJobAttempts
                // Parked, never silently written to the database as a partial result. The
                // lecture may have been deleted mid-run, which deletes this job with it.
                try? queueWrite(database) { db in
                    try failJob(db: db, jobId: job.id, message: message, retry: retry, durationMs: durationMs)
                }
                queueError("✗ \(job.kind.rawValue) \(job.id) attempt \(job.attempts): \(message)")
            }
        }
        watcher?.cancel()
        workTasks[job.id] = nil
        cancelledJobIds.remove(job.id)
        provider.onProgress = nil
        if let local = fallbackBox.provider {
            local.onProgress = nil
        }
    }

    /// Re-reads the job's row every `cancelWatch` and stops its work once it is no longer
    /// RUNNING: cancelled in either app, or gone with its lecture.
    private func startCancelWatch(jobId: String) -> Task<Void, Never> {
        let database = self.database
        let interval = timing.cancelWatch
        return Task.detached { [weak self] in
            while !Task.isCancelled {
                await queueSleep(interval)
                if Task.isCancelled {
                    return
                }
                let status: JobStatus?
                do {
                    status = try queueRead(database) { db in try jobStatus(db: db, jobId: jobId) }
                } catch {
                    // A read that failed says nothing about the job: look again.
                    continue
                }
                if status != JobStatus.running {
                    await self?.cancelLocally(jobId)
                    return
                }
            }
        }
    }

    /// Stops the main lane's job if it is the one running here.
    private func cancelLocally(_ jobId: String) {
        guard running.values.contains(jobId) else { return }
        cancelledJobIds.insert(jobId)
        workTasks[jobId]?.cancel()
        sideCancels[jobId]?()
    }

    // MARK: - The side lanes

    /// `downloadOne()`: a model being fetched for the Models pane of Settings
    /// (`downloadOne` in worker/index.ts). Progress is written into the job's result as
    /// it goes, and a finished download links itself up: it becomes the model local mode
    /// uses, so there is nothing else to set.
    private func downloadOne() async -> Bool {
        guard let job = claimNext(.download) else { return false }
        running[.download] = job.id
        let startedAt = Date()
        do {
            try enterStageOnActor(job.id, stage: .download)
            let database = self.database, services = self.services
            let done = try await sideWork(jobId: job.id) {
                try await runDownloadJob(job, database: database, environment: services.environment)
            }
            let durationMs = elapsedMs(since: startedAt)
            try queueWrite(database) { db in
                try completeJob(
                    db: db,
                    jobId: job.id,
                    result: done.result,
                    promptVersion: nil,
                    model: "download",
                    durationMs: durationMs,
                    closeTimeline: false
                )
            }
            queueInfo("✓ DOWNLOAD \(job.id): \(done.name)")
        } catch {
            sideJobFailed(job, startedAt: startedAt, error: error)
        }
        running[.download] = nil
        return true
    }

    /// `sortOne()`: a folder sorted into lectures while its import screen waits.
    private func sortOne() async -> Bool {
        guard let job = claimNext(.sort) else { return false }
        running[.sort] = job.id
        let startedAt = Date()
        do {
            let database = self.database, services = self.services, hooks = self.hooks
            let done = try await sideWork(jobId: job.id) { try await sortFolder(job, database: database, services: services, hooks: hooks) }
            let durationMs = elapsedMs(since: startedAt)
            let result = sortedFolderJSON(done.folder)
            let used = done.used
            try queueWrite(database) { db in
                try completeJob(
                    db: db,
                    jobId: job.id,
                    result: result,
                    promptVersion: used.lastPromptVersion,
                    model: used.lastModel,
                    durationMs: durationMs,
                    closeTimeline: false
                )
            }
            queueInfo("✓ SORT \(job.id): \(done.files) files into \(done.folder.lectures.count) lectures on \(used.name)")
        } catch {
            sideJobFailed(job, startedAt: startedAt, error: error)
        }
        running[.sort] = nil
        return true
    }

    /// `askOne()`: a question asked on a lecture page while the student waits.
    private func askOne() async -> Bool {
        guard let job = claimNext(.ask) else { return false }
        running[.ask] = job.id
        let startedAt = Date()
        do {
            let database = self.database, services = self.services, hooks = self.hooks
            let done = try await sideWork(jobId: job.id) { try await answerAsk(job, database: database, services: services, hooks: hooks) }
            let durationMs = elapsedMs(since: startedAt)
            let used = done.used
            let result = askResultJSON(done.result, model: used.lastModel)
            try queueWrite(database) { db in
                try completeJob(
                    db: db,
                    jobId: job.id,
                    result: result,
                    promptVersion: used.lastPromptVersion,
                    model: used.lastModel,
                    durationMs: durationMs,
                    closeTimeline: false
                )
            }
            queueInfo("✓ ASK \(job.id) (\(done.result.kind.rawValue)) on \(used.name) (\(secondsText(durationMs))s)")
        } catch {
            sideJobFailed(job, startedAt: startedAt, error: error)
        }
        running[.ask] = nil
        return true
    }

    private func sideWork<T: Sendable>(jobId: String, operation: @escaping @Sendable () async throws -> T) async throws -> T {
        let task = Task.detached(operation: operation)
        sideCancels[jobId] = { task.cancel() }
        let watcher = startCancelWatch(jobId: jobId)
        defer {
            watcher.cancel()
            sideCancels[jobId] = nil
        }
        let result = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
        if cancelledJobIds.contains(jobId) { throw CancellationError() }
        try Task.checkCancellation()
        return result
    }

    /// A side job failed: parked as FAILED, no second attempt.
    private func sideJobFailed(_ job: Job, startedAt: Date, error: Error) {
        if cancelledJobIds.remove(job.id) != nil {
            try? queueWrite(database) { db in try markJobCancelled(db: db, jobId: job.id, durationMs: elapsedMs(since: startedAt)) }
            return
        }
        if stopping || Task.isCancelled {
            queueInfo("■ \(job.kind.rawValue) \(job.id) stopped with the queue; it runs again at the next start")
            return
        }
        let message = messageOf(error)
        let durationMs = elapsedMs(since: startedAt)
        // The lecture may have been deleted while it waited, which deletes this job with it.
        try? queueWrite(database) { db in
            try failJob(db: db, jobId: job.id, message: message, retry: false, durationMs: durationMs)
        }
        queueError("✗ \(job.kind.rawValue) \(job.id): \(message)")
    }
}

// MARK: - Side-lane work, off the actor

private struct SortDone: Sendable {
    var folder: SortedFolder
    var used: any LLMProvider
    /// Files in the folder, for the log.
    var files: Int
}

private func sortFolder(
    _ job: Job,
    database: LockinDatabase,
    services: LockinServices,
    hooks: JobQueueHooks
) async throws -> SortDone {
    guard let provider = try await hooks.provider(database, services) else {
        throw LockinError(noAIMessage)
    }
    let payload = try JSONValue.parse(job.payload)
    // The model answers in file numbers; the screen knows files by path (handleSort).
    let outcome = try await withFallback(
        provider,
        settings: { try getSettings(database: database) },
        isFake: isFakeProvider(services.environment),
        offline: { try hooks.offline(database, services) },
        work: { chosen in try await handleSort(payload, provider: chosen) },
        onFallback: nil
    )
    return SortDone(folder: outcome.result, used: outcome.used, files: payload["files"]?.arrayValue?.count ?? 0)
}

private struct AskDone: Sendable {
    var result: AskResult
    var used: any LLMProvider
}

private func answerAsk(
    _ job: Job,
    database: LockinDatabase,
    services: LockinServices,
    hooks: JobQueueHooks
) async throws -> AskDone {
    guard let provider = try await hooks.provider(database, services) else {
        throw LockinError(noAIMessage)
    }
    let payload = try JSONValue.parse(job.payload)
    let outcome = try await withFallback(
        provider,
        settings: { try getSettings(database: database) },
        isFake: isFakeProvider(services.environment),
        offline: { try hooks.offline(database, services) },
        work: { chosen in try await handleAsk(payload, database: database, provider: chosen) },
        onFallback: nil
    )
    return AskDone(result: outcome.result, used: outcome.used)
}

// MARK: - The download lane's work, off the actor

private struct DownloadDone: Sendable {
    var result: JSONValue
    var name: String
}

/// `downloadOne`'s body (worker/index.ts): the payload decides what is fetched, the
/// download reports into the job's row as it goes, the model is registered, a llama.cpp
/// copy it replaces is removed, and `link` makes it the model local mode uses.
private func runDownloadJob(
    _ job: Job,
    database: LockinDatabase,
    environment: [String: String]
) async throws -> DownloadDone {
    let payload = try JSONValue.parse(job.payload)
    guard let modelId = payload["modelId"]?.stringValue else {
        throw LockinError("the download names no model")
    }
    guard let model = findModel(modelId) else {
        throw LockinError("unknown model \(modelId)")
    }
    if payload["visionOnly"]?.isTruthy == true {
        throw LockinError("a model's vision part is fetched by the Electron app, which runs llama.cpp")
    }
    let mlx = payload["mlx"]?.isTruthy == true
    if !mlx {
        throw LockinError("\(model.name) comes as a llama.cpp download, which only the Electron app fetches")
    }

    // Progress lands in the job's result at most once a second, as the worker writes it.
    let jobId = job.id
    let progressBox = ProgressBox()
    let report: @Sendable (Int, Int) -> Void = { downloaded, total in
        progressBox.report(jobId: jobId, database: database, downloaded: downloaded, total: total)
    }
    let previous = (try? installedModels(database: database, environment: environment))?
        .first(where: { $0.id == model.id })
    let dir = modelsDirectory(environment: environment)
    let (path, bytes) = try await downloadMlxModel(model, dir: dir, onProgress: report)
    let now = Date()
    try queueWrite(database) { db in
        try registerModel(db: db, id: model.id, path: path, bytes: bytes, format: "mlx", now: now)
        // It replaces the llama.cpp copy, which would only take up space.
        if let previous, previous.path != path {
            try? FileManager.default.removeItem(atPath: previous.path)
        }
        if payload["link"]?.isTruthy != false {
            try linkModel(db: db, model: model, reader: readerFromPayload(payload), now: now)
        }
    }
    return DownloadDone(
        result: .object(["downloaded": .int(bytes), "total": .int(bytes)]),
        name: model.name
    )
}

/// `linkModel`'s reader argument, from the job's payload: absent is `.keep`, a string or
/// null is `.value`.
func readerFromPayload(_ payload: JSONValue) -> LinkReader {
    guard case .object(let fields) = payload, fields.keys.contains("reader") else { return .keep }
    switch fields["reader"] {
    case .string(let named):
        return .value(named)
    default:
        return .value(nil)
    }
}

/// Writes download progress at most once a second (`lastWrite` in downloadOne).
private final class ProgressBox: @unchecked Sendable {
    private var lastWrite = Date.distantPast
    private let lock = NSLock()

    func report(jobId: String, database: LockinDatabase, downloaded: Int, total: Int) {
        lock.lock()
        let now = Date()
        guard now.timeIntervalSince(lastWrite) >= 1 else {
            lock.unlock()
            return
        }
        lastWrite = now
        lock.unlock()
        try? database.writer.write { db in
            try setDownloadProgress(db: db, jobId: jobId, downloaded: downloaded, total: total, part: "mlx")
        }
    }
}

// MARK: - Helpers

/// The offline provider that took over a job, so its progress reports can be stopped.
private final class FallbackProviderBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: (any LLMProvider)?

    var provider: (any LLMProvider)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            stored = newValue
            lock.unlock()
        }
    }
}

/// Synchronous database calls, so they never resolve to GRDB's async overloads inside
/// async code. Never call them from inside another read or write.
private func queueRead<T>(_ database: LockinDatabase, _ body: (Database) throws -> T) throws -> T {
    try database.reader.read { db in
        try body(db)
    }
}

private func queueWrite<T>(_ database: LockinDatabase, _ body: (Database) throws -> T) throws -> T {
    try database.writer.write { db in
        try body(db)
    }
}

/// Waits, or returns early once the task is cancelled.
private func queueSleep(_ seconds: TimeInterval) async {
    guard seconds.isFinite, seconds > 0 else {
        await Task.yield()
        return
    }
    let nanoseconds = UInt64(min(seconds, 86_400) * 1_000_000_000)
    try? await Task.sleep(nanoseconds: nanoseconds)
}

/// `Date.now()`.
private func epochMs(_ date: Date) -> Int {
    Int((date.timeIntervalSince1970 * 1000).rounded(.down))
}

/// `Date.now() - started`.
private func elapsedMs(since start: Date, now: Date = Date()) -> Int {
    max(0, epochMs(now) - epochMs(start))
}

/// `(ms / 1000).toFixed(1)`, for the log.
private func secondsText(_ ms: Int) -> String {
    String(format: "%.1f", Double(ms) / 1000)
}
