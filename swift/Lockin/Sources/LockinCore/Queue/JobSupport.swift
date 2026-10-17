import Foundation
import GRDB

// Port of the database side of lib/jobs.ts and worker/index.ts: priorities, lanes,
// each job's timeline of stages, claiming, finishing, and which app runs the queue.
// Every function taking `db: Database` runs inside the caller's write (or read); call
// them from async code through a synchronous helper or `immediateWrite`, never across
// an `await`.

// MARK: - Time and constants

/// `new Date().toISOString()`: "2026-10-17T05:44:02.278Z". Steps and heartbeats use it.
public func jsISOString(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: date)
}

/// One retry. Each model call already gets a repair pass for bad JSON, so a second
/// failure is usually real (not logged in, rate limited) and the queue should move on.
public let maxJobAttempts = 2

/// What Prisma 7 throws when `findUniqueOrThrow` (or an update of a row that is gone)
/// finds nothing — the job error the Electron worker records when a lecture, response
/// or job was deleted mid-run. Throw it as `LockinError(prismaRecordNotFound)`.
public let prismaRecordNotFound =
    "An operation failed because it depends on one or more records that were required but not found. No record was found for a query."

/// Marking jumps the queue: someone is sitting there waiting for their score (`PRIORITY`).
public func jobPriority(_ kind: JobKind) -> Int {
    kind == .mark ? 10 : 0
}

/// The job kinds this app runs in its main lane. DOWNLOAD is only ever run by the
/// Electron worker; an unknown kind is left for whichever app knows it.
public let mainLaneKinds: [JobKind] = [.prepare, .generate, .mark]

/// The queue's lanes. Each runs one job at a time; the side lanes run beside the main one
/// and are polled faster, because someone is waiting on the screen that started them.
public enum QueueLane: String, CaseIterable, Sendable {
    /// PREPARE, GENERATE, MARK: priority first, then oldest first.
    case main
    /// SORT: a folder being sorted while the import screen waits.
    case sort
    /// ASK: a question asked on a lecture page.
    case ask

    public var kinds: [JobKind] {
        switch self {
        case .main: return mainLaneKinds
        case .sort: return [.sort]
        case .ask: return [.ask]
        }
    }
}

/// How often the queue looks (worker/index.ts): `LOCKIN_WORKER_POLL_MS` (2 s) for the
/// main lane, at most 750 ms for sorts and 500 ms for asks, a heartbeat every 5 s, and a
/// running job's row re-read every 1.5 s for a cancel.
public struct QueueTiming: Equatable, Sendable {
    public var poll: TimeInterval
    public var sortPoll: TimeInterval
    public var askPoll: TimeInterval
    public var heartbeat: TimeInterval
    public var cancelWatch: TimeInterval

    public init(poll: TimeInterval = 2, heartbeat: TimeInterval = 5, cancelWatch: TimeInterval = 1.5) {
        self.poll = poll
        self.sortPoll = min(poll, 0.75)
        self.askPoll = min(poll, 0.5)
        self.heartbeat = heartbeat
        self.cancelWatch = cancelWatch
    }

    public static let standard = QueueTiming()

    public static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> QueueTiming {
        guard let raw = environment["LOCKIN_WORKER_POLL_MS"], let ms = Double(raw), ms.isFinite, ms > 0 else {
            return .standard
        }
        return QueueTiming(poll: ms / 1000)
    }
}

// MARK: - A job's timeline (Job.steps)

/// One stage a job went through, as stored in `Job.steps`:
/// `[{"stage":"digest","startedAt":"…Z","finishedAt":null,"detail":"reading part 2 of 4"}]`.
public struct JobStep: Equatable, Sendable {
    public var stage: Stage
    public var startedAt: String
    public var finishedAt: String?
    /// What a slow provider is doing within the stage.
    public var detail: String?

    public init(stage: Stage, startedAt: String, finishedAt: String? = nil, detail: String? = nil) {
        self.stage = stage
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.detail = detail
    }

    public var startedDate: Date? { PrismaDate.parseString(startedAt) }
    public var finishedDate: Date? { finishedAt.flatMap { PrismaDate.parseString($0) } }
    /// `STAGES[stage] ?? stage`.
    public var label: String { stage.label }
}

/// The stored steps as JSON values, so a rewrite keeps every key, in order, as `{ ...s }` does.
func stepValues(_ json: String?) -> [JSONValue] {
    guard let json, let parsed = try? JSONValue.parse(json), case .array(let items) = parsed else { return [] }
    return items
}

private func closedStep(_ value: JSONValue, at iso: String) -> JSONValue {
    if case .object(var object) = value {
        if object["finishedAt"]?.isTruthy == true {
            return value
        }
        object["finishedAt"] = .string(iso)
        return .object(object)
    }
    return ["finishedAt": .string(iso)]
}

/// `readSteps(json)`, tolerant of nulls and hand edits.
public func readSteps(_ json: String?) -> [JobStep] {
    stepValues(json).compactMap { value -> JobStep? in
        guard case .object(let object) = value,
              let stageName = object["stage"]?.stringValue,
              let stage = Stage(rawValue: stageName) else { return nil }
        return JobStep(
            stage: stage,
            startedAt: object["startedAt"]?.stringValue ?? "",
            finishedAt: object["finishedAt"]?.stringValue,
            detail: object["detail"]?.stringValue
        )
    }
}

/// Every open step finished now (`closeSteps`).
public func closeSteps(_ json: String?, now: Date = Date()) -> String {
    let iso = jsISOString(now)
    return JSONValue.array(stepValues(json).map { closedStep($0, at: iso) }).stringified()
}

private func storedSteps(db: Database, jobId: String) throws -> (found: Bool, steps: String?) {
    guard let row = try Row.fetchOne(db, sql: #"SELECT "steps" FROM "Job" WHERE "id" = ?"#, arguments: [jobId]) else {
        return (false, nil)
    }
    let steps: String? = row["steps"]
    return (true, steps)
}

/// Called as a job moves on, so the UI can say what it is doing and since when.
public func enterStage(db: Database, jobId: String, stage: Stage, now: Date = Date()) throws {
    let stored = try storedSteps(db: db, jobId: jobId)
    guard stored.found else {
        throw LockinError(prismaRecordNotFound)
    }
    let iso = jsISOString(now)
    var steps = stepValues(stored.steps).map { closedStep($0, at: iso) }
    steps.append(["stage": .string(stage.rawValue), "startedAt": .string(iso), "finishedAt": .null])
    try db.execute(
        sql: #"UPDATE "Job" SET "stage" = ?, "steps" = ? WHERE "id" = ?"#,
        arguments: [stage.rawValue, JSONValue.array(steps).stringified(), jobId]
    )
}

/// Updates what the current stage is doing, without starting a new one. Nothing happens
/// for a job that is gone, a finished stage, or the same detail again.
public func setStageDetail(db: Database, jobId: String, detail: String?) throws {
    let stored = try storedSteps(db: db, jobId: jobId)
    guard stored.found else { return }
    var steps = stepValues(stored.steps)
    guard let lastIndex = steps.indices.last, case .object(var step) = steps[lastIndex] else { return }
    if step["finishedAt"]?.isTruthy == true {
        return
    }
    let wanted = JSONValue.orNull(detail)
    if step["detail"] == wanted {
        return
    }
    step["detail"] = wanted
    steps[lastIndex] = .object(step)
    try db.execute(
        sql: #"UPDATE "Job" SET "steps" = ? WHERE "id" = ?"#,
        arguments: [JSONValue.array(steps).stringified(), jobId]
    )
}

// MARK: - Queueing and claiming

/// `enqueue(kind, payload, lectureId)`.
@discardableResult
public func enqueue(db: Database, kind: JobKind, payload: JSONValue, lectureId: String?, now: Date = Date()) throws -> Job {
    var job = Job(kind: kind, payload: payload.stringified(), lectureId: lectureId, priority: jobPriority(kind), createdAt: now)
    try job.insert(db)
    return job
}

/// Stops a lecture's job. One still waiting leaves the queue; the one running is stopped
/// by its queue within a couple of seconds, wherever it is. True when a job was stopped.
@discardableResult
public func cancelJob(db: Database, jobId: String, now: Date = Date()) throws -> Bool {
    try db.execute(
        sql: #"""
        UPDATE "Job" SET "status" = 'FAILED', "error" = 'Cancelled', "finishedAt" = ?
        WHERE "id" = ? AND "status" IN ('PENDING', 'RUNNING') AND "kind" IN ('PREPARE', 'GENERATE', 'MARK')
        """#,
        arguments: [PrismaDate.encode(now), jobId]
    )
    return db.changesCount > 0
}

public func retryJob(db: Database, jobId: String) throws {
    try db.execute(
        sql: #"""
        UPDATE "Job" SET "status" = 'PENDING', "attempts" = 0, "error" = NULL, "finishedAt" = NULL, "stage" = NULL, "steps" = NULL
        WHERE "id" = ?
        """#,
        arguments: [jobId]
    )
}

/// Drops work that has not started. A running job finishes its current lecture.
@discardableResult
public func clearQueue(db: Database, lectureId: String? = nil) throws -> Int {
    if let lectureId {
        try db.execute(
            sql: #"DELETE FROM "Job" WHERE "status" = 'PENDING' AND "kind" IN ('PREPARE', 'GENERATE') AND "lectureId" = ?"#,
            arguments: [lectureId]
        )
    } else {
        try db.execute(sql: #"DELETE FROM "Job" WHERE "status" = 'PENDING' AND "kind" IN ('PREPARE', 'GENERATE')"#)
    }
    return db.changesCount
}

/// The job a lane would run next: the main lane by priority then age, a side lane by age.
public func nextPendingJob(db: Database, lane: QueueLane) throws -> Job? {
    switch lane {
    case .main:
        return try Job.fetchOne(
            db,
            sql: #"""
            SELECT * FROM "Job" WHERE "status" = 'PENDING' AND "kind" IN ('PREPARE', 'GENERATE', 'MARK')
            ORDER BY "priority" DESC, "createdAt" ASC LIMIT 1
            """#
        )
    case .sort:
        return try Job.fetchOne(
            db,
            sql: #"SELECT * FROM "Job" WHERE "status" = 'PENDING' AND "kind" = 'SORT' ORDER BY "createdAt" ASC LIMIT 1"#
        )
    case .ask:
        return try Job.fetchOne(
            db,
            sql: #"SELECT * FROM "Job" WHERE "status" = 'PENDING' AND "kind" = 'ASK' ORDER BY "createdAt" ASC LIMIT 1"#
        )
    }
}

/// Takes a waiting job, atomically: true only when this call moved it from PENDING to
/// RUNNING. Each attempt gets a fresh timeline.
public func claimJob(db: Database, jobId: String, now: Date = Date()) throws -> Bool {
    try db.execute(
        sql: #"""
        UPDATE "Job" SET "status" = 'RUNNING', "startedAt" = ?, "attempts" = "attempts" + 1, "stage" = NULL, "steps" = NULL
        WHERE "id" = ? AND "status" = 'PENDING'
        """#,
        arguments: [PrismaDate.encode(now), jobId]
    )
    return db.changesCount == 1
}

/// The lane's next job, claimed, as it now stands (attempts already counted); nil when
/// there is none. Run it inside `immediateWrite`.
public func claimNextJob(db: Database, lane: QueueLane, now: Date = Date()) throws -> Job? {
    for _ in 0..<5 {
        guard let candidate = try nextPendingJob(db: db, lane: lane) else { return nil }
        if try claimJob(db: db, jobId: candidate.id, now: now) {
            return try Job.fetchOne(db, key: candidate.id)
        }
    }
    return nil
}

/// `claimNextJob` in its own IMMEDIATE transaction, so the other app cannot claim the same job.
public func claimNextJob(database: LockinDatabase, lane: QueueLane, now: Date = Date()) throws -> Job? {
    try immediateWrite(database) { db in
        try claimNextJob(db: db, lane: lane, now: now)
    }
}

/// A job's status now; nil when it is gone (its lecture was deleted). The cancel watcher
/// stops a job whose status is no longer RUNNING.
public func jobStatus(db: Database, jobId: String) throws -> JobStatus? {
    guard let raw = try String.fetchOne(db, sql: #"SELECT "status" FROM "Job" WHERE "id" = ?"#, arguments: [jobId]) else {
        return nil
    }
    return JobStatus(rawValue: raw)
}

/// A job finished. The main lane closes its timeline (`closeTimeline`); the side lanes
/// have none and leave `stage`, `steps` and `error` as they are. An empty prompt version
/// is stored as NULL. Nothing happens for a job that is gone.
public func completeJob(
    db: Database,
    jobId: String,
    result: JSONValue,
    promptVersion: String?,
    model: String?,
    durationMs: Int,
    closeTimeline: Bool,
    now: Date = Date()
) throws {
    let version: String? = (promptVersion?.isEmpty ?? true) ? nil : promptVersion
    if closeTimeline {
        let stored = try storedSteps(db: db, jobId: jobId)
        guard stored.found else { return }
        try db.execute(
            sql: #"""
            UPDATE "Job" SET "status" = 'DONE', "stage" = NULL, "steps" = ?, "result" = ?, "promptVersion" = ?,
              "model" = ?, "durationMs" = ?, "finishedAt" = ?, "error" = NULL
            WHERE "id" = ?
            """#,
            arguments: [closeSteps(stored.steps, now: now), result.stringified(), version, model, durationMs, PrismaDate.encode(now), jobId]
        )
    } else {
        try db.execute(
            sql: #"""
            UPDATE "Job" SET "status" = 'DONE', "result" = ?, "promptVersion" = ?, "model" = ?, "durationMs" = ?, "finishedAt" = ?
            WHERE "id" = ?
            """#,
            arguments: [result.stringified(), version, model, durationMs, PrismaDate.encode(now), jobId]
        )
    }
}

/// A job failed: back in the queue for another attempt (`retry`), or parked as FAILED —
/// never silently written to the database as a partial result.
public func failJob(db: Database, jobId: String, message: String, retry: Bool, durationMs: Int, now: Date = Date()) throws {
    if retry {
        try db.execute(
            sql: #"""
            UPDATE "Job" SET "status" = 'PENDING', "stage" = NULL, "error" = ?, "durationMs" = ?, "finishedAt" = NULL
            WHERE "id" = ?
            """#,
            arguments: [message, durationMs, jobId]
        )
    } else {
        try db.execute(
            sql: #"""
            UPDATE "Job" SET "status" = 'FAILED', "stage" = NULL, "error" = ?, "durationMs" = ?, "finishedAt" = ?
            WHERE "id" = ?
            """#,
            arguments: [message, durationMs, PrismaDate.encode(now), jobId]
        )
    }
}

/// A running job that was cancelled: its row already says FAILED, "Cancelled".
public func markJobCancelled(db: Database, jobId: String, durationMs: Int) throws {
    try db.execute(
        sql: #"UPDATE "Job" SET "stage" = NULL, "durationMs" = ? WHERE "id" = ?"#,
        arguments: [durationMs, jobId]
    )
}

/// Runs `body` in one IMMEDIATE transaction: the write lock is taken first, so a
/// read-then-write (claiming, taking the queue) can't interleave with the other app's.
public func immediateWrite<T>(_ database: LockinDatabase, _ body: (Database) throws -> T) throws -> T {
    try database.writer.writeWithoutTransaction { db -> T in
        var outcome: T?
        try db.inTransaction(.immediate) {
            outcome = try body(db)
            return .commit
        }
        guard let finished = outcome else {
            throw LockinError("the database write did not finish")
        }
        return finished
    }
}

// MARK: - Which app runs the queue

/// A job left RUNNING means the last owner stopped mid-job: put it back in the queue
/// (`main()` in worker/index.ts). DOWNLOAD jobs are the Electron worker's own and are left alone.
@discardableResult
public func requeueInterruptedJobs(db: Database) throws -> Int {
    try db.execute(sql: #"UPDATE "Job" SET "status" = 'PENDING', "stage" = NULL WHERE "status" = 'RUNNING' AND "kind" <> 'DOWNLOAD'"#)
    return db.changesCount
}

/// A sort's answer is only wanted while its import screen is open (a day); questions asked
/// are kept a while, because the lecture page lists recent ones (30 days).
@discardableResult
public func deleteExpiredSideJobs(db: Database, now: Date = Date()) throws -> Int {
    let jobs = try Job.filter([JobKind.sort.rawValue, JobKind.ask.rawValue].contains(Column("kind"))).fetchAll(db)
    let sortCutoff = now.addingTimeInterval(-86_400)
    let askCutoff = now.addingTimeInterval(-30 * 86_400)
    let expired = jobs.filter { job in
        job.kind == .sort ? job.createdAt < sortCutoff : job.createdAt < askCutoff
    }
    if expired.isEmpty {
        return 0
    }
    return try Job.deleteAll(db, keys: expired.map(\.id))
}

public enum QueueAcquisition: Equatable, Sendable {
    /// The queue was already this app's: heartbeat refreshed.
    case kept
    /// No live owner: ours now. RUNNING jobs were requeued and expired SORT/ASK jobs deleted.
    case tookOver(requeued: Int)
    /// Another live queue owns it: nothing was written; claim nothing.
    case taken(Heartbeat)
}

/// Takes or keeps the queue, writing this app's heartbeat (`{at, pid, provider, app:"swift"}`).
/// Call it on start and every `heartbeatIntervalMs` while running, inside one IMMEDIATE
/// transaction (`acquireQueue(database:…)`). `alreadyOwner` is whether this app held the
/// queue at its last check: then a missing or stale row is simply rewritten — the jobs
/// RUNNING are this app's own and must not be requeued under it.
public func acquireQueue(
    db: Database,
    pid: Int,
    provider: String?,
    alreadyOwner: Bool,
    now: Date = Date()
) throws -> QueueAcquisition {
    let status = try readHeartbeat(db: db, now: now)
    let beat = Heartbeat.current(now: now, pid: pid, provider: provider)
    switch queueOwnership(status, pid: pid) {
    case .taken(let other):
        return .taken(other)
    case .ours:
        try writeHeartbeat(db: db, beat, now: now)
        return .kept
    case .free:
        try writeHeartbeat(db: db, beat, now: now)
        if alreadyOwner {
            return .kept
        }
        let requeued = try requeueInterruptedJobs(db: db)
        try deleteExpiredSideJobs(db: db, now: now)
        return .tookOver(requeued: requeued)
    }
}

public func acquireQueue(
    database: LockinDatabase,
    pid: Int = Int(ProcessInfo.processInfo.processIdentifier),
    provider: String?,
    alreadyOwner: Bool,
    now: Date = Date()
) throws -> QueueAcquisition {
    try immediateWrite(database) { db in
        try acquireQueue(db: db, pid: pid, provider: provider, alreadyOwner: alreadyOwner, now: now)
    }
}

/// On a clean stop: deletes the heartbeat row if it is still this app's.
public func releaseQueue(db: Database, pid: Int = Int(ProcessInfo.processInfo.processIdentifier)) throws {
    try deleteHeartbeat(db: db, onlyIfPid: pid)
}

// MARK: - What jobs are handed

/// What the queue's work needs beyond the database: drawing slides, reading the words in
/// slide pictures, and the MLX engine. `JobQueue` builds the live set (`LockinServices.live`);
/// tests pass stand-ins.
public struct LockinServices: Sendable {
    public var renderer: any SlideRendering
    public var textReader: any SlideTextReading
    public var engine: any EngineGenerating
    /// The environment the providers are configured from (`LOCKIN_PROVIDER`, `LOCKIN_CLAUDE_BIN`…).
    public var environment: [String: String]

    public init(
        renderer: any SlideRendering,
        textReader: any SlideTextReading,
        engine: any EngineGenerating,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.renderer = renderer
        self.textReader = textReader
        self.engine = engine
        self.environment = environment
    }
}

/// Everything a job handler is handed (with the provider): the claimed job, the database,
/// the settings as they were when it started, and the services.
public struct JobContext: Sendable {
    /// The job as claimed: RUNNING, `attempts` already counted.
    public let job: Job
    public let database: LockinDatabase
    public let settings: LockinSettings
    public let services: LockinServices

    public init(job: Job, database: LockinDatabase, settings: LockinSettings, services: LockinServices) {
        self.job = job
        self.database = database
        self.settings = settings
        self.services = services
    }

    public var jobId: String { job.id }

    /// `JSON.parse(job.payload)`.
    public func payload() throws -> JSONValue {
        try JSONValue.parse(job.payload)
    }

    /// Starts a new stage in the job's timeline (`enterStage(jobId, stage)`).
    public func enterStage(_ stage: Stage, now: Date = Date()) throws {
        let id = job.id
        try database.writer.write { db in
            try LockinCore.enterStage(db: db, jobId: id, stage: stage, now: now)
        }
    }

    /// What the current stage is doing; failures are ignored, as the worker's `.catch(() => undefined)`.
    public func setDetail(_ detail: String?) {
        let id = job.id
        try? database.writer.write { db in
            try LockinCore.setStageDetail(db: db, jobId: id, detail: detail)
        }
    }

    /// `setDetail` as a callback: what the queue sets as `provider.onProgress`.
    public var progress: @Sendable (String?) -> Void {
        let database = self.database
        let id = job.id
        return { detail in
            try? database.writer.write { db in
                try LockinCore.setStageDetail(db: db, jobId: id, detail: detail)
            }
        }
    }

    /// Throws `CancellationError` once the job has been cancelled.
    public func checkCancellation() throws {
        try Task.checkCancellation()
    }
}

// MARK: - What the queue is doing (activity in lib/jobs.ts)

public struct ActivityJob: Identifiable, Equatable, Sendable {
    public var id: String
    public var kind: JobKind
    public var status: JobStatus
    public var lectureId: String?
    public var lectureTitle: String?
    public var courseCode: String?
    public var stage: Stage?
    /// `STAGES[stage] ?? stage`.
    public var stageLabel: String?
    public var steps: [JobStep]
    public var attempts: Int
    public var createdAt: Date
    public var startedAt: Date?
    public var finishedAt: Date?
    public var durationMs: Int?
    public var error: String?

    public init(job: Job, lectureTitle: String?, courseCode: String?) {
        id = job.id
        kind = job.kind
        status = job.status
        lectureId = job.lectureId
        self.lectureTitle = lectureTitle
        self.courseCode = courseCode
        let parsedStage = job.stage.flatMap { Stage(rawValue: $0) }
        stage = parsedStage
        stageLabel = parsedStage?.label
        steps = readSteps(job.steps)
        attempts = job.attempts
        createdAt = job.createdAt
        startedAt = job.startedAt
        finishedAt = job.finishedAt
        durationMs = job.durationMs
        error = job.error
    }
}

public struct QueueActivity: Equatable, Sendable {
    /// Whoever runs the queue — this app or the Electron worker — and whether it is alive.
    public var worker: HeartbeatStatus?
    public var running: ActivityJob?
    public var queued: [ActivityJob]
    /// Finished or failed in the last day, newest first.
    public var recent: [ActivityJob]
    /// Changes whenever anything above does, so a view knows when to refresh.
    public var version: String

    public init(worker: HeartbeatStatus?, running: ActivityJob?, queued: [ActivityJob], recent: [ActivityJob], version: String) {
        self.worker = worker
        self.running = running
        self.queued = queued
        self.recent = recent
        self.version = version
    }
}

/// `activity()`: the main lane's running job, what waits, and the last day's finished
/// ones. Downloads, sorts and asks are reported where they were started.
public func loadActivity(db: Database, now: Date = Date()) throws -> QueueActivity {
    let running = try Job.fetchAll(
        db,
        sql: #"""
        SELECT * FROM "Job" WHERE "kind" NOT IN ('DOWNLOAD', 'SORT', 'ASK') AND "status" = 'RUNNING'
        ORDER BY "startedAt" ASC LIMIT 1
        """#
    )
    let queued = try Job.fetchAll(
        db,
        sql: #"""
        SELECT * FROM "Job" WHERE "kind" NOT IN ('DOWNLOAD', 'SORT', 'ASK') AND "status" = 'PENDING'
        ORDER BY "priority" DESC, "createdAt" ASC LIMIT 50
        """#
    )
    let recent = try Job.fetchAll(
        db,
        sql: #"""
        SELECT * FROM "Job" WHERE "kind" NOT IN ('DOWNLOAD', 'SORT', 'ASK') AND "status" IN ('DONE', 'FAILED')
          AND "finishedAt" >= ?
        ORDER BY "finishedAt" DESC LIMIT 12
        """#,
        arguments: [PrismaDate.encode(now.addingTimeInterval(-86_400))]
    )
    let beat = try readHeartbeat(db: db, now: now)

    let all = running + queued + recent
    let lectureIds = Array(Set(all.compactMap(\.lectureId)))
    let lectures = try Lecture.fetchAll(db, keys: lectureIds)
    var lectureById: [String: Lecture] = [:]
    for lecture in lectures {
        lectureById[lecture.id] = lecture
    }
    let courseIds = Array(Set(lectures.map(\.courseId)))
    let courses = try Course.fetchAll(db, keys: courseIds)
    var codeById: [String: String] = [:]
    for course in courses {
        codeById[course.id] = course.code
    }

    func describe(_ job: Job) -> ActivityJob {
        let lecture = job.lectureId.flatMap { lectureById[$0] }
        let code = lecture.flatMap { codeById[$0.courseId] }
        return ActivityJob(job: job, lectureTitle: lecture?.title, courseCode: code)
    }

    let runningJob = running.first.map { describe($0) }
    let queuedJobs = queued.map { describe($0) }
    let recentJobs = recent.map { describe($0) }

    let runningPart: String
    if let runningJob {
        runningPart = "\(runningJob.id):\(runningJob.stage?.rawValue ?? "null"):\(runningJob.steps.last?.detail ?? "")"
    } else {
        runningPart = "-"
    }
    let version = [
        runningPart,
        String(queuedJobs.count),
        recentJobs.first?.id ?? "-",
        recentJobs.first?.status.rawValue ?? "-",
        (beat?.alive ?? false) ? "1" : "0",
    ].joined(separator: "|")

    return QueueActivity(worker: beat, running: runningJob, queued: queuedJobs, recent: recentJobs, version: version)
}
