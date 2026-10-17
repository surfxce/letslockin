import Foundation
import GRDB
import XCTest
@testable import LockinCore

// MARK: - Stand-ins for what the queue's work needs beyond the database

private struct StubRenderer: SlideRendering {
    func pageCount(file: String) -> Int? { nil }
    func renderPage(file: String, page: Int) throws -> Data { Data() }
    func pagePNG(lectureId: String, deck: SlideDeck, page: Int) throws -> Data { Data() }
    func pagePNGFile(lectureId: String, deck: SlideDeck, page: Int) throws -> String { "" }
    func cropPNG(_ png: Data, crop: Crop) throws -> Data { png }
}

private struct StubTextReader: SlideTextReading {
    func recognizeText(png: Data) async throws -> String { "" }
}

private actor StubEngine: EngineGenerating {
    private(set) var stops = 0

    func generate(
        model: String,
        prompt: String,
        images: [String],
        schema: JSONValue?,
        maxTokens: Int,
        temperature: Double,
        onTokens: (@Sendable (Int) -> Void)?
    ) async throws -> String {
        throw LockinError("no engine in tests")
    }

    func stop() async {
        stops += 1
    }
}

/// What handlers saw, safe to add to from any task.
private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []

    func add(_ item: String) {
        lock.lock()
        items.append(item)
        lock.unlock()
    }

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}

// MARK: - Helpers

/// Quick enough for tests: look every 20 ms, check in every 50 ms.
private let fast = QueueTiming(poll: 0.02, heartbeat: 0.05, cancelWatch: 0.02)

private let fakeEnvironment = ["LOCKIN_PROVIDER": "fake", "LOCKIN_FAKE_DELAY_MS": "10"]

private func stubServices(_ environment: [String: String] = fakeEnvironment, engine: StubEngine = StubEngine()) -> LockinServices {
    LockinServices(renderer: StubRenderer(), textReader: StubTextReader(), engine: engine, environment: environment)
}

/// Every main-lane job runs `handler` on `provider`; a failed cloud job goes to `offline`.
private func testHooks(
    provider: (any LLMProvider)? = FakeProvider(delayMs: 0),
    offline: OfflineFallbackChoice? = nil,
    handler: @escaping QueueJobHandler
) -> JobQueueHooks {
    JobQueueHooks(
        provider: { _, _ in provider },
        handler: { _ in handler },
        offline: { _, _ in offline }
    )
}

@discardableResult
private func writeSync<T>(_ db: LockinDatabase, _ body: (Database) throws -> T) throws -> T {
    try db.writer.write { conn in
        try body(conn)
    }
}

private func fetchJob(_ db: LockinDatabase, _ id: String) throws -> Job? {
    try db.reader.read { conn in
        try Job.fetchOne(conn, key: id)
    }
}

private func fetchResponse(_ db: LockinDatabase, _ id: String) throws -> Response? {
    try db.reader.read { conn in
        try Response.fetchOne(conn, key: id)
    }
}

private func currentHeartbeat(_ db: LockinDatabase) throws -> HeartbeatStatus? {
    try db.reader.read { conn in
        try readHeartbeat(db: conn)
    }
}

private func makeLecture(_ conn: Database, summary: String? = nil) throws -> Lecture {
    var course = Course(code: "PHYS2001", title: "Physiology")
    try course.insert(conn)
    var lecture = Lecture(courseId: course.id, title: "Appetite", summaryMd: summary)
    try lecture.insert(conn)
    return lecture
}

/// Waits until `condition` holds, for at most `timeout` seconds; whether it did.
private func eventually(timeout: TimeInterval = 10, _ condition: () throws -> Bool) async throws -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if try condition() {
            return true
        }
        try await Task.sleep(nanoseconds: 10_000_000)
    }
    return try condition()
}

/// Runs `withFallback` on `cloud`, which fails with `failure` (when there is one).
private func tryFallback(
    _ failure: Error?,
    cloud: FakeProvider,
    settings: LockinSettings = LockinSettings(),
    isFake: Bool = false,
    offline: OfflineFallbackChoice?,
    told: Recorder
) async throws -> FallbackOutcome<String> {
    try await withFallback(
        cloud,
        settings: { settings },
        isFake: isFake,
        offline: { offline },
        work: { chosen -> String in
            if chosen === cloud {
                if let failure {
                    throw failure
                }
                return "cloud"
            }
            return "offline"
        },
        onFallback: { why, _ in told.add(why) }
    )
}

private let codexSignedOut = "Codex isn't signed in — run `codex login` in a terminal, then try again"

final class JobQueueTests: XCTestCase {
    // MARK: Claiming

    func testTheMainLaneRunsMarkingFirstThenTheOldest() async throws {
        let db = try LockinDatabase.inMemory()
        let base = Date().addingTimeInterval(-600)
        let (ids, downloadId) = try writeSync(db) { conn -> ([String], String) in
            let lecture = try makeLecture(conn)
            let prepare = try enqueue(db: conn, kind: .prepare, payload: ["lectureId": .string(lecture.id), "redo": false], lectureId: lecture.id, now: base)
            let generate = try enqueue(db: conn, kind: .generate, payload: ["lectureId": .string(lecture.id)], lectureId: lecture.id, now: base.addingTimeInterval(1))
            let mark = try enqueue(db: conn, kind: .mark, payload: ["responseId": "r1"], lectureId: lecture.id, now: base.addingTimeInterval(2))
            // Only ever the Electron worker's.
            let download = try enqueue(db: conn, kind: .download, payload: ["modelId": "m"], lectureId: nil, now: base)
            return ([prepare.id, generate.id, mark.id], download.id)
        }
        let order = Recorder()
        let queue = JobQueue(database: db, services: stubServices(), timing: fast, pid: 4101, hooks: testHooks { _, context, _ in
            order.add(context.job.kind.rawValue)
            return ["ok": true]
        })
        await queue.start()
        let finished = try await eventually { try ids.allSatisfy { try fetchJob(db, $0)?.status == .done } }
        await queue.stop()

        XCTAssertTrue(finished)
        XCTAssertEqual(order.all, ["MARK", "PREPARE", "GENERATE"])
        let mark = try fetchJob(db, ids[2])
        XCTAssertEqual(mark?.result, #"{"ok":true}"#)
        XCTAssertEqual(mark?.attempts, 1)
        XCTAssertEqual(mark?.model, "Fake (development)")
        XCTAssertEqual(mark?.promptVersion, "fake@0")
        XCTAssertNil(mark?.stage)
        XCTAssertNil(mark?.error)
        XCTAssertNotNil(mark?.durationMs)
        XCTAssertNotNil(mark?.finishedAt)
        XCTAssertEqual(try fetchJob(db, downloadId)?.status, .pending)
        let stopped = await queue.status
        XCTAssertFalse(stopped.started)
        XCTAssertFalse(stopped.ownsQueue)
    }

    func testClaimsAreAtomicAndOnlyWhileTheQueueIsOurs() throws {
        let db = try LockinDatabase.inMemory()
        let base = Date().addingTimeInterval(-600)
        let ids = try writeSync(db) { conn -> [String] in
            let lecture = try makeLecture(conn)
            // The Electron worker checked in just now.
            try writeHeartbeat(db: conn, Heartbeat(at: jsISOString(Date()), pid: 7, provider: "Claude Code"))
            return try (0..<3).map { i in
                try enqueue(db: conn, kind: .generate, payload: [:], lectureId: lecture.id, now: base.addingTimeInterval(Double(i))).id
            }
        }
        XCTAssertNil(try claimNextJobIfOwner(database: db, lane: .main, pid: 42))
        XCTAssertEqual(try fetchJob(db, ids[0])?.status, .pending)

        // It stopped checking in half a minute ago: free. Eight claimers at once take each
        // job exactly once.
        try writeSync(db) { conn in
            try writeHeartbeat(db: conn, Heartbeat(at: jsISOString(Date().addingTimeInterval(-30)), pid: 7, provider: "Claude Code"))
        }
        let claimed = Recorder()
        DispatchQueue.concurrentPerform(iterations: 8) { _ in
            if let job = try? claimNextJobIfOwner(database: db, lane: .main, pid: 42) {
                claimed.add(job.id)
            }
        }
        XCTAssertEqual(claimed.all.sorted(), ids.sorted())
        for id in ids {
            let row = try fetchJob(db, id)
            XCTAssertEqual(row?.status, .running)
            XCTAssertEqual(row?.attempts, 1)
        }

        // This app's own heartbeat, even a stale one, is no bar.
        let next = try writeSync(db) { conn -> String in
            try writeHeartbeat(db: conn, Heartbeat.current(now: Date().addingTimeInterval(-60), pid: 42, provider: "Claude Code"))
            return try enqueue(db: conn, kind: .mark, payload: [:], lectureId: nil).id
        }
        XCTAssertEqual(try claimNextJobIfOwner(database: db, lane: .main, pid: 42)?.id, next)
    }

    func testAFreshElectronHeartbeatMeansNothingIsClaimed() async throws {
        let db = try LockinDatabase.inMemory()
        let jobId = try writeSync(db) { conn -> String in
            let lecture = try makeLecture(conn)
            try writeHeartbeat(db: conn, Heartbeat(at: jsISOString(Date()), pid: 7, provider: "Claude Code"))
            return try enqueue(db: conn, kind: .mark, payload: ["responseId": "r1"], lectureId: lecture.id).id
        }
        let queue = JobQueue(database: db, services: stubServices(), timing: fast, pid: 4102, hooks: testHooks { _, _, _ in
            ["ok": true]
        })
        await queue.start()
        try await Task.sleep(nanoseconds: 300_000_000)
        let waiting = await queue.status
        XCTAssertTrue(waiting.started)
        XCTAssertFalse(waiting.ownsQueue)
        XCTAssertEqual(waiting.owner?.pid, 7)
        XCTAssertEqual(try fetchJob(db, jobId)?.status, .pending)
        // Nothing written over the other app's heartbeat.
        XCTAssertEqual(try currentHeartbeat(db)?.heartbeat.pid, 7)
        XCTAssertNil(try currentHeartbeat(db)?.heartbeat.app)

        // It stops checking in: 30 seconds on, the queue is free and this app takes it.
        try writeSync(db) { conn in
            try writeHeartbeat(db: conn, Heartbeat(at: jsISOString(Date().addingTimeInterval(-30)), pid: 7, provider: "Claude Code"))
        }
        let ran = try await eventually { try fetchJob(db, jobId)?.status == .done }
        let owning = await queue.status
        let beat = try currentHeartbeat(db)
        await queue.stop()

        XCTAssertTrue(ran)
        XCTAssertTrue(owning.ownsQueue)
        XCTAssertNil(owning.owner)
        XCTAssertEqual(beat?.heartbeat.pid, 4102)
        XCTAssertEqual(beat?.heartbeat.app, "swift")
        XCTAssertEqual(beat?.heartbeat.provider, "Claude Code")
        // A clean stop deletes this app's heartbeat.
        XCTAssertNil(try currentHeartbeat(db))
    }

    func testTakingOverFromAStaleHeartbeatRequeuesWhatWasRunning() async throws {
        let db = try LockinDatabase.inMemory()
        let (leftoverId, downloadId, oldSortId) = try writeSync(db) { conn -> (String, String, String) in
            let lecture = try makeLecture(conn)
            // The Electron worker died mid-job half a minute ago.
            try writeHeartbeat(db: conn, Heartbeat(at: jsISOString(Date().addingTimeInterval(-30)), pid: 7, provider: "Claude Code"))
            var leftover = Job(
                kind: .prepare,
                payload: #"{"lectureId":"\#(lecture.id)","redo":false}"#,
                lectureId: lecture.id,
                status: .running,
                stage: "digest",
                attempts: 1,
                startedAt: Date().addingTimeInterval(-60)
            )
            try leftover.insert(conn)
            var download = Job(kind: .download, payload: #"{"modelId":"m"}"#, status: .running, stage: "download", attempts: 1)
            try download.insert(conn)
            var oldSort = Job(kind: .sort, payload: "{}", status: .done, createdAt: Date().addingTimeInterval(-2 * 86_400))
            try oldSort.insert(conn)
            return (leftover.id, download.id, oldSort.id)
        }
        let seen = Recorder()
        let queue = JobQueue(database: db, services: stubServices(), timing: fast, pid: 4103, hooks: testHooks { _, context, _ in
            seen.add("\(context.job.id) attempt \(context.job.attempts)")
            return ["ok": true]
        })
        await queue.start()
        let taken = await queue.status
        let ran = try await eventually { try fetchJob(db, leftoverId)?.status == .done }
        await queue.stop()

        XCTAssertTrue(taken.ownsQueue)
        XCTAssertTrue(ran)
        XCTAssertEqual(seen.all, ["\(leftoverId) attempt 2"])
        // A download is the Electron worker's own; an old sort's answer is no longer wanted.
        XCTAssertEqual(try fetchJob(db, downloadId)?.status, .running)
        XCTAssertNil(try fetchJob(db, oldSortId))
    }

    // MARK: Cancelling and stopping

    func testCancellingARunningPrepareStopsItAtOnce() async throws {
        let db = try LockinDatabase.inMemory()
        let base = Date().addingTimeInterval(-60)
        let (prepareId, nextId) = try writeSync(db) { conn -> (String, String) in
            let lecture = try makeLecture(conn)
            let prepare = try enqueue(db: conn, kind: .prepare, payload: ["lectureId": .string(lecture.id), "wait": true], lectureId: lecture.id, now: base)
            let next = try enqueue(db: conn, kind: .generate, payload: ["lectureId": .string(lecture.id)], lectureId: lecture.id, now: base.addingTimeInterval(1))
            return (prepare.id, next.id)
        }
        let stoppedHandlers = Recorder()
        let queue = JobQueue(database: db, services: stubServices(), timing: fast, pid: 4104, hooks: testHooks { payload, context, _ in
            try context.enterStage(.digest)
            if payload["wait"]?.boolValue == true {
                do {
                    try await Task.sleep(nanoseconds: 60_000_000_000)
                } catch {
                    stoppedHandlers.add(context.jobId)
                    throw error
                }
            }
            return ["ok": true]
        })
        await queue.start()
        let running = try await eventually { try fetchJob(db, prepareId)?.stage == "digest" }
        XCTAssertTrue(running)
        let busy = await queue.status
        XCTAssertEqual(busy.running[.main], prepareId)

        try await queue.cancel(jobId: prepareId)
        let stopped = try await eventually { try fetchJob(db, prepareId)?.durationMs != nil }
        // The queue carries on with the next job.
        let carriedOn = try await eventually { try fetchJob(db, nextId)?.status == .done }
        await queue.stop()

        XCTAssertTrue(stopped)
        XCTAssertTrue(carriedOn)
        let row = try fetchJob(db, prepareId)
        XCTAssertEqual(row?.status, .failed)
        XCTAssertEqual(row?.error, "Cancelled")
        XCTAssertNil(row?.stage)
        XCTAssertNotNil(row?.finishedAt)
        XCTAssertEqual(stoppedHandlers.all, [prepareId])
    }

    func testACancelMadeInTheOtherAppIsSeenByTheWatcher() async throws {
        let db = try LockinDatabase.inMemory()
        let jobId = try writeSync(db) { conn -> String in
            let lecture = try makeLecture(conn)
            return try enqueue(db: conn, kind: .prepare, payload: ["lectureId": .string(lecture.id)], lectureId: lecture.id).id
        }
        let stoppedHandlers = Recorder()
        let queue = JobQueue(database: db, services: stubServices(), timing: fast, pid: 4105, hooks: testHooks { _, context, _ in
            try context.enterStage(.digest)
            do {
                try await Task.sleep(nanoseconds: 60_000_000_000)
            } catch {
                stoppedHandlers.add(context.jobId)
                throw error
            }
            return ["ok": true]
        })
        await queue.start()
        let running = try await eventually { try fetchJob(db, jobId)?.stage == "digest" }
        XCTAssertTrue(running)

        // The × in the Electron app's AI panel: only the row changes.
        try writeSync(db) { conn in try cancelJob(db: conn, jobId: jobId) }
        let stopped = try await eventually { try fetchJob(db, jobId)?.durationMs != nil }
        await queue.stop()

        XCTAssertTrue(stopped)
        let row = try fetchJob(db, jobId)
        XCTAssertEqual(row?.status, .failed)
        XCTAssertEqual(row?.error, "Cancelled")
        XCTAssertNil(row?.stage)
        XCTAssertEqual(stoppedHandlers.all, [jobId])
    }

    func testStoppingLeavesTheRunningJobForWhoeverRunsTheQueueNext() async throws {
        let db = try LockinDatabase.inMemory()
        let jobId = try writeSync(db) { conn -> String in
            let lecture = try makeLecture(conn)
            return try enqueue(db: conn, kind: .prepare, payload: ["lectureId": .string(lecture.id)], lectureId: lecture.id).id
        }
        let engine = StubEngine()
        let first = JobQueue(database: db, services: stubServices(engine: engine), timing: fast, pid: 4106, hooks: testHooks { _, context, _ in
            try context.enterStage(.digest)
            try await Task.sleep(nanoseconds: 60_000_000_000)
            return ["ok": true]
        })
        await first.start()
        let running = try await eventually { try fetchJob(db, jobId)?.stage == "digest" }
        XCTAssertTrue(running)
        await first.stop()

        // Not cancelled, not failed: left RUNNING, as the worker leaves it on SIGTERM.
        let left = try fetchJob(db, jobId)
        XCTAssertEqual(left?.status, .running)
        XCTAssertEqual(left?.stage, "digest")
        XCTAssertNil(left?.error)
        XCTAssertNil(left?.durationMs)
        XCTAssertNil(try currentHeartbeat(db))
        let stops = await engine.stops
        XCTAssertEqual(stops, 1)
        let stopped = await first.status
        XCTAssertFalse(stopped.started)
        XCTAssertEqual(stopped.running, [:])

        // Whoever takes the queue next puts it back in line and runs it.
        let second = JobQueue(database: db, services: stubServices(), timing: fast, pid: 4107, hooks: testHooks { _, _, _ in
            ["ok": true]
        })
        await second.start()
        let ran = try await eventually { try fetchJob(db, jobId)?.status == .done }
        await second.stop()
        XCTAssertTrue(ran)
        XCTAssertEqual(try fetchJob(db, jobId)?.attempts, 2)
    }

    // MARK: Failing and retrying

    func testAFailedJobIsTriedOnceMoreThenParkedUntilRetried() async throws {
        let db = try LockinDatabase.inMemory()
        let jobId = try writeSync(db) { conn -> String in
            let lecture = try makeLecture(conn)
            return try enqueue(db: conn, kind: .generate, payload: ["lectureId": .string(lecture.id)], lectureId: lecture.id).id
        }
        let calls = Recorder()
        let queue = JobQueue(database: db, services: stubServices(), timing: fast, pid: 4108, hooks: testHooks { _, context, _ in
            calls.add("attempt \(context.job.attempts)")
            if calls.all.count <= 2 {
                throw LockinError("claude exited 1: rate limited")
            }
            return ["generated": 2]
        })
        await queue.start()
        let parked = try await eventually { try fetchJob(db, jobId)?.status == .failed }
        XCTAssertTrue(parked)
        let failed = try fetchJob(db, jobId)
        XCTAssertEqual(failed?.attempts, 2)
        XCTAssertEqual(failed?.error, "claude exited 1: rate limited")
        XCTAssertNil(failed?.stage)
        XCTAssertNotNil(failed?.finishedAt)
        XCTAssertNotNil(failed?.durationMs)
        // Parked: not tried a third time on its own.
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(calls.all, ["attempt 1", "attempt 2"])

        try await queue.retry(jobId: jobId)
        let done = try await eventually { try fetchJob(db, jobId)?.status == .done }
        await queue.stop()

        XCTAssertTrue(done)
        let row = try fetchJob(db, jobId)
        XCTAssertEqual(row?.attempts, 1)
        XCTAssertNil(row?.error)
        XCTAssertEqual(row?.result, #"{"generated":2}"#)
        XCTAssertEqual(calls.all, ["attempt 1", "attempt 2", "attempt 1"])
    }

    func testABadPayloadOrAMissingHandlerIsRecordedAsTheJobsError() async throws {
        let db = try LockinDatabase.inMemory()
        let (markId, generateId) = try writeSync(db) { conn -> (String, String) in
            let lecture = try makeLecture(conn)
            var mark = Job(kind: .mark, payload: "not json", lectureId: lecture.id, priority: 10)
            try mark.insert(conn)
            let generate = try enqueue(db: conn, kind: .generate, payload: ["lectureId": .string(lecture.id)], lectureId: lecture.id)
            return (mark.id, generate.id)
        }
        let ok: QueueJobHandler = { _, _, _ in ["ok": true] }
        let hooks = JobQueueHooks(
            provider: { _, _ in FakeProvider(delayMs: 0) },
            handler: { kind in
                if kind == .generate {
                    return nil
                }
                return ok
            },
            offline: { _, _ in nil }
        )
        let queue = JobQueue(database: db, services: stubServices(), timing: fast, pid: 4109, hooks: hooks)
        await queue.start()
        let finished = try await eventually {
            try [markId, generateId].allSatisfy { try fetchJob(db, $0)?.status == .failed }
        }
        await queue.stop()

        XCTAssertTrue(finished)
        // JSON.parse's own words, as V8 has them.
        XCTAssertEqual(try fetchJob(db, markId)?.error, #"Unexpected token 'o', "not json" is not valid JSON"#)
        XCTAssertEqual(try fetchJob(db, markId)?.attempts, 2)
        XCTAssertEqual(try fetchJob(db, generateId)?.error, #"no handler for job kind "GENERATE""#)
    }

    // MARK: Falling back to the offline model

    func testTheOfflineModelStepsInWhenTheCloudFails() async throws {
        let db = try LockinDatabase.inMemory()
        let jobId = try writeSync(db) { conn -> String in
            let lecture = try makeLecture(conn)
            return try enqueue(db: conn, kind: .generate, payload: ["lectureId": .string(lecture.id)], lectureId: lecture.id).id
        }
        let cloud = FakeProvider(delayMs: 0)
        let offline = FakeProvider(delayMs: 0)
        let hooks = testHooks(provider: cloud, offline: OfflineFallbackChoice(provider: offline, modelName: "Gemma 4 E4B")) { _, context, chosen in
            if chosen === cloud {
                try context.enterStage(.questions)
                throw CloudError(codexSignedOut)
            }
            return ["generated": 3, "budget": 3, "targeted": 1]
        }
        // Not the fake provider's environment, under which nothing falls back.
        let queue = JobQueue(database: db, services: stubServices([:]), timing: fast, pid: 4110, hooks: hooks)
        await queue.start()
        let done = try await eventually { try fetchJob(db, jobId)?.status == .done }
        XCTAssertTrue(done)
        let row = try fetchJob(db, jobId)
        XCTAssertEqual(row?.result, #"{"generated":3,"budget":3,"targeted":1,"fellBack":"\#(codexSignedOut)"}"#)
        XCTAssertEqual(row?.model, "Fake (development)")
        XCTAssertEqual(readSteps(row?.steps).last?.detail, "The cloud AI failed — the offline model is doing it instead")

        // With the fallback turned off in Settings, the cloud's failure is the job's.
        try writeSync(db) { conn in try setSetting(db: conn, key: "fallbackLocal", value: false) }
        let second = try writeSync(db) { conn -> String in
            try enqueue(db: conn, kind: .generate, payload: [:], lectureId: nil).id
        }
        let parked = try await eventually { try fetchJob(db, second)?.status == .failed }
        await queue.stop()
        XCTAssertTrue(parked)
        XCTAssertEqual(try fetchJob(db, second)?.error, codexSignedOut)
        // Neither provider is left reporting into a finished job.
        XCTAssertNil(cloud.onProgress)
        XCTAssertNil(offline.onProgress)
    }

    func testWithFallbackHandsOnlyCloudFailuresToTheOfflineModel() async throws {
        let cloud = FakeProvider(delayMs: 0)
        let offline = OfflineFallbackChoice(provider: FakeProvider(delayMs: 0), modelName: "Gemma 4 E4B")
        let told = Recorder()

        let fine = try await tryFallback(nil, cloud: cloud, offline: offline, told: told)
        XCTAssertEqual(fine.result, "cloud")
        XCTAssertTrue(fine.used === cloud)
        XCTAssertNil(fine.fellBack)

        // Signed out, a reply that would not parse, one that would not validate.
        let failures: [Error] = [
            CloudError(codexSignedOut),
            JSONParseError("Unexpected end of JSON input"),
            LLMValidationError(issues: []),
        ]
        for failure in failures {
            let outcome = try await tryFallback(failure, cloud: cloud, offline: offline, told: told)
            XCTAssertEqual(outcome.result, "offline")
            XCTAssertTrue(outcome.used === offline.provider)
            XCTAssertEqual(outcome.fellBack, messageOf(failure))
        }
        XCTAssertEqual(told.all, failures.map { messageOf($0) })

        // Anything else, or Settings that say no, and the failure comes through as it was.
        var localMode = LockinSettings()
        localMode.mode = .local
        var noFallback = LockinSettings()
        noFallback.fallbackLocal = false
        let refused: [(Error, LockinSettings, Bool, OfflineFallbackChoice?)] = [
            (LockinError("this lecture has no transcript or slides with readable text yet"), LockinSettings(), false, offline),
            (CancellationError(), LockinSettings(), false, offline),
            (CloudError(codexSignedOut), localMode, false, offline),
            (CloudError(codexSignedOut), noFallback, false, offline),
            (CloudError(codexSignedOut), LockinSettings(), true, offline),
            (CloudError(codexSignedOut), LockinSettings(), false, nil),
        ]
        for (failure, settings, isFake, choice) in refused {
            do {
                _ = try await tryFallback(failure, cloud: cloud, settings: settings, isFake: isFake, offline: choice, told: told)
                XCTFail("expected \(messageOf(failure)) to come through")
            } catch {
                XCTAssertEqual(messageOf(error), messageOf(failure))
            }
        }
        XCTAssertEqual(told.all.count, failures.count)
    }

    func testWithFallbackReadsSettingsAndModelsFromTheDatabase() async throws {
        let db = try LockinDatabase.inMemory()
        let cloud = FakeProvider(delayMs: 0)
        // The fake provider never falls back; with no offline model downloaded, nothing can.
        for environment in [fakeEnvironment, [:]] {
            do {
                _ = try await withFallback(cloud, database: db, services: stubServices(environment), work: { _ -> String in
                    throw CloudError(codexSignedOut)
                })
                XCTFail("expected the failure to come through")
            } catch {
                XCTAssertEqual(error as? CloudError, CloudError(codexSignedOut))
            }
        }
        let outcome = try await withFallback(cloud, database: db, services: stubServices(), work: { chosen in chosen.name })
        XCTAssertEqual(outcome.result, "fake")
        XCTAssertTrue(outcome.used === cloud)
    }

    func testAFellBackResultSpreadsAsTheWorkerSpreadsIt() {
        XCTAssertEqual(
            resultWithFellBack(["generated": 3, "budget": 3, "targeted": 1], why: "x").stringified(),
            #"{"generated":3,"budget":3,"targeted":1,"fellBack":"x"}"#
        )
        XCTAssertEqual(resultWithFellBack([1, "a"], why: "x").stringified(), #"{"0":1,"1":"a","fellBack":"x"}"#)
        XCTAssertEqual(resultWithFellBack(.null, why: "x").stringified(), #"{"fellBack":"x"}"#)
    }

    // MARK: The real handlers, on the fake provider

    func testAMarkReachesDoneOnTheFakeProvider() async throws {
        let db = try LockinDatabase.inMemory()
        let (jobId, responseId) = try writeSync(db) { conn -> (String, String) in
            let lecture = try makeLecture(conn)
            var concept = Concept(courseId: lecture.courseId, lectureId: lecture.id, name: "Ghrelin", definition: "A hunger hormone from the stomach.")
            try concept.insert(conn)
            var question = Question(
                lectureId: lecture.id,
                stem: "Explain how ghrelin signals hunger.",
                rubric: #"{"modelAnswer":"Ghrelin rises before meals.","criteria":[{"point":"Defines ghrelin","marks":10}],"totalMarks":10}"#,
                promptVersion: "generate-questions@1.0.0"
            )
            try question.insert(conn)
            var link = QuestionConcept(questionId: question.id, conceptId: concept.id)
            try link.insert(conn)
            var attempt = Attempt(lectureId: lecture.id)
            try attempt.insert(conn)
            let answer = Array(repeating: "ghrelin", count: 30).joined(separator: " ")
            var response = Response(attemptId: attempt.id, questionId: question.id, answerText: answer)
            try response.insert(conn)
            let job = try enqueue(db: conn, kind: .mark, payload: ["responseId": .string(response.id)], lectureId: lecture.id)
            return (job.id, response.id)
        }
        let engine = StubEngine()
        let queue = JobQueue(database: db, services: stubServices(engine: engine), timing: fast, pid: 4111)
        await queue.start()
        let finished = try await eventually {
            let status = try fetchJob(db, jobId)?.status
            return status == .done || status == .failed
        }
        await queue.stop()

        XCTAssertTrue(finished)
        let job = try fetchJob(db, jobId)
        XCTAssertEqual(job?.status, .done, job?.error ?? "")
        // 30 words: 5 out of 10, and the concept is a gap.
        XCTAssertEqual(job?.result, #"{"mark":5,"gaps":1}"#)
        XCTAssertEqual(job?.model, "Fake (development)")
        XCTAssertEqual(job?.promptVersion, "fake@0")
        XCTAssertEqual(readSteps(job?.steps).map { $0.stage }, [.marking])
        let response = try fetchResponse(db, responseId)
        XCTAssertEqual(response?.mark, 5)
        XCTAssertNotNil(response?.rawMarkingJson)
        let stops = await engine.stops
        XCTAssertEqual(stops, 1)
    }

    func testSideLanesRunBesideTheMainOneAndSayWhenNoAIIsSetUp() async throws {
        let db = try LockinDatabase.inMemory()
        let slides: JSONValue = ["number": 1, "path": "Week 1/Lecture 1 Appetite.pdf", "detail": "slides, 24 pages", "excerpt": "Appetite and satiety"]
        let captions: JSONValue = ["number": 2, "path": "Week 1/Lecture 1 Appetite.vtt", "detail": "transcript, 52 min", "excerpt": "Today we look at hunger"]
        let folder: JSONValue = ["root": "/Users/me/PHYS2001", "files": .array([slides, captions])]
        let sortId = try writeSync(db) { conn -> String in
            try enqueue(db: conn, kind: .sort, payload: folder, lectureId: nil).id
        }
        let queue = JobQueue(database: db, services: stubServices(), timing: fast, pid: 4112)
        await queue.start()
        let sorted = try await eventually {
            let status = try fetchJob(db, sortId)?.status
            return status == .done || status == .failed
        }
        XCTAssertTrue(sorted)
        let row = try fetchJob(db, sortId)
        XCTAssertEqual(row?.status, .done, row?.error ?? "")
        XCTAssertEqual(row?.attempts, 1)
        XCTAssertEqual(row?.model, "Fake (development)")
        XCTAssertEqual(row?.promptVersion, "fake@0")
        XCTAssertNil(row?.steps)
        let result = try JSONValue.parse(row?.result ?? "")
        XCTAssertEqual(result.objectValue?.keys, ["lectures", "setAside"])

        // Copy-and-paste mode: a sort fails at once, saying why; lecture work waits.
        try writeSync(db) { conn in try setSetting(db: conn, key: "mode", value: "manual") }
        try await Task.sleep(nanoseconds: 100_000_000)
        let (secondSort, mark) = try writeSync(db) { conn -> (String, String) in
            let sort = try enqueue(db: conn, kind: .sort, payload: folder, lectureId: nil)
            let mark = try enqueue(db: conn, kind: .mark, payload: ["responseId": "r1"], lectureId: nil)
            return (sort.id, mark.id)
        }
        let failed = try await eventually { try fetchJob(db, secondSort)?.status == .failed }
        try await Task.sleep(nanoseconds: 100_000_000)
        await queue.stop()
        XCTAssertTrue(failed)
        XCTAssertEqual(try fetchJob(db, secondSort)?.error, "no AI is set up — choose Claude Code or download an offline model in Settings")
        XCTAssertEqual(try fetchJob(db, secondSort)?.attempts, 1)
        XCTAssertEqual(try fetchJob(db, mark)?.status, .pending)
        XCTAssertEqual(try fetchJob(db, mark)?.attempts, 0)
    }

    func testAQuestionAskedIsAnsweredWithWhoAnswered() async throws {
        let db = try LockinDatabase.inMemory()
        let summary = "## Hunger\n\nGhrelin rises before meals and tells the hypothalamus it is time to eat.\n\n"
            + "## Fullness\n\nLeptin from fat tissue tells the brain that energy stores are full."
        let jobId = try writeSync(db) { conn -> String in
            let lecture = try makeLecture(conn, summary: summary)
            let payload: JSONValue = ["kind": "question", "lectureId": .string(lecture.id), "question": "What does ghrelin do before meals?"]
            return try enqueue(db: conn, kind: .ask, payload: payload, lectureId: lecture.id).id
        }
        let queue = JobQueue(database: db, services: stubServices(), timing: fast, pid: 4113)
        await queue.start()
        let answered = try await eventually {
            let status = try fetchJob(db, jobId)?.status
            return status == .done || status == .failed
        }
        await queue.stop()

        XCTAssertTrue(answered)
        let row = try fetchJob(db, jobId)
        XCTAssertEqual(row?.status, .done, row?.error ?? "")
        let result = try JSONValue.parse(row?.result ?? "")
        XCTAssertEqual(result["kind"]?.stringValue, "question")
        XCTAssertEqual(result["question"]?.stringValue, "What does ghrelin do before meals?")
        // Who answered comes last, as `{ ...result, model }` puts it.
        XCTAssertEqual(result.objectValue?.keys.last, "model")
        XCTAssertEqual(result["model"]?.stringValue, "Fake (development)")
        XCTAssertEqual(row?.model, "Fake (development)")
    }

    // MARK: Which provider

    func testTheFactoryBuildsWhatSettingsChoose() async throws {
        XCTAssertTrue(isFakeProvider(["LOCKIN_PROVIDER": "fake"]))
        XCTAssertFalse(isFakeProvider(["LOCKIN_PROVIDER": "cli"]))
        XCTAssertFalse(isFakeProvider([:]))
        XCTAssertEqual(cliTimeout(environment: [:]), 600)
        XCTAssertEqual(cliTimeout(environment: ["LOCKIN_CLI_TIMEOUT_MS": "90000"]), 90)
        XCTAssertEqual(cliTimeout(environment: ["LOCKIN_CLI_TIMEOUT_MS": "soon"]), 0.001)

        let cli = stubServices([:])
        let claude = try claudeCodeProvider(model: "opus", services: cli)
        XCTAssertEqual(claude.name, "claude-code-cli")
        XCTAssertEqual(claude.lastModel, "Claude Code · opus")
        XCTAssertEqual(try claudeCodeProvider(model: nil, services: stubServices()).name, "fake")
        XCTAssertThrowsError(try claudeCodeProvider(model: nil, services: stubServices(["LOCKIN_PROVIDER": "api"]))) { error in
            XCTAssertEqual(messageOf(error), "the Anthropic SDK adapter is not built yet — set LOCKIN_PROVIDER=cli")
        }
        XCTAssertThrowsError(try claudeCodeProvider(model: nil, services: stubServices(["LOCKIN_PROVIDER": "llama"]))) { error in
            XCTAssertEqual(messageOf(error), #"unknown LOCKIN_PROVIDER "llama""#)
        }

        let db = try LockinDatabase.inMemory()
        var settings = LockinSettings()
        let fake = try await cloudProvider(settings: settings, database: db, services: stubServices())
        XCTAssertEqual(fake.name, "fake")

        settings.cloudModel = .haiku
        let haiku = try await cloudProvider(settings: settings, database: db, services: cli)
        XCTAssertEqual(haiku.name, "claude-code-cli")
        XCTAssertEqual(haiku.lastModel, "Claude Code · haiku")

        settings.cloudEngine = .codex
        settings.codexModel = "  gpt-5.5-codex "
        let codex = try await cloudProvider(settings: settings, database: db, services: cli)
        XCTAssertEqual(codex.name, "codex-cli")
        XCTAssertEqual(codex.lastModel, "ChatGPT Codex · gpt-5.5-codex")

        settings.cloudEngine = .api
        let noKey = try await cloudProvider(settings: settings, database: db, services: cli)
        XCTAssertEqual(noKey.name, "misconfigured")
        XCTAssertEqual(noKey.lastModel, "Anthropic API")

        try writeSync(db) { conn in try setApiKey(db: conn, "sk-ant-test") }
        let anthropic = try await cloudProvider(settings: settings, database: db, services: cli)
        XCTAssertEqual(anthropic.name, "anthropic-api")
        XCTAssertEqual(anthropic.lastModel, "Anthropic API · claude-haiku-5-5")

        // A service on this computer needs no key; it is named by its address.
        try writeSync(db) { conn in try setApiKey(db: conn, nil) }
        settings.apiService = .custom
        settings.apiBaseUrl = " http://localhost:11434/v1 "
        settings.apiModel = "llama3"
        let custom = try await cloudProvider(settings: settings, database: db, services: cli)
        XCTAssertEqual(custom.name, "openai-compatible")
        XCTAssertEqual(custom.lastModel, "localhost:11434 · llama3")

        settings.apiBaseUrl = ""
        let noAddress = try await cloudProvider(settings: settings, database: db, services: cli)
        XCTAssertEqual(noAddress.name, "misconfigured")
        XCTAssertEqual(noAddress.lastModel, "Another service")

        settings.apiService = .groq
        let noGroqKey = try await cloudProvider(settings: settings, database: db, services: cli)
        XCTAssertEqual(noGroqKey.name, "misconfigured")
        XCTAssertEqual(noGroqKey.lastModel, "Groq")
    }

    func testTheCurrentProviderFollowsTheMode() async throws {
        let db = try LockinDatabase.inMemory()
        let auto = try await currentProvider(database: db, services: stubServices())
        XCTAssertEqual(auto?.name, "fake")

        try writeSync(db) { conn in try setSetting(db: conn, key: "mode", value: "manual") }
        let manual = try await currentProvider(database: db, services: stubServices())
        XCTAssertNil(manual)

        // Local mode with no model downloaded yet: jobs wait.
        try writeSync(db) { conn in try setSetting(db: conn, key: "mode", value: "local") }
        let local = try await currentProvider(database: db, services: stubServices())
        XCTAssertNil(local)
    }

    func testACustomServiceIsNamedAsURLHostNamesIt() {
        XCTAssertEqual(serviceHostName("http://localhost:11434/v1"), "localhost:11434")
        XCTAssertEqual(serviceHostName("https://api.example.com/v1"), "api.example.com")
        XCTAssertEqual(serviceHostName("https://api.example.com:443/v1"), "api.example.com")
        XCTAssertEqual(serviceHostName("HTTP://LocalHost:8080/v1"), "localhost:8080")
        XCTAssertEqual(serviceHostName("http://127.0.0.1:1234"), "127.0.0.1:1234")
        XCTAssertEqual(serviceHostName("not a url"), "API")
        XCTAssertEqual(serviceHostName("api.example.com/v1"), "API")
        XCTAssertEqual(serviceHostName("http://"), "API")
    }
}
