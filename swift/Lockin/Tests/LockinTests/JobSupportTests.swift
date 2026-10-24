import Foundation
import GRDB
import XCTest
@testable import LockinCore

final class JobSupportTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func makeLecture(_ conn: Database) throws -> Lecture {
        var course = Course(code: "PHYS2001", title: "Physiology")
        try course.insert(conn)
        var lecture = Lecture(courseId: course.id, title: "Appetite")
        try lecture.insert(conn)
        return lecture
    }

    func testTheMainLaneTakesMarkingFirstThenTheOldest() throws {
        let db = try LockinDatabase.inMemory()
        let ids = try db.writer.write { conn -> [String] in
            let lecture = try makeLecture(conn)
            let first = try enqueue(db: conn, kind: .prepare, payload: ["lectureId": .string(lecture.id), "redo": false], lectureId: lecture.id, now: t0)
            let second = try enqueue(db: conn, kind: .generate, payload: ["lectureId": .string(lecture.id)], lectureId: lecture.id, now: t0.addingTimeInterval(1))
            let mark = try enqueue(db: conn, kind: .mark, payload: ["responseId": "r1"], lectureId: lecture.id, now: t0.addingTimeInterval(2))
            _ = try enqueue(db: conn, kind: .sort, payload: ["root": "/x", "files": []], lectureId: nil, now: t0)
            _ = try enqueue(db: conn, kind: .download, payload: ["modelId": "m"], lectureId: nil, now: t0)
            XCTAssertEqual(mark.priority, 10)
            XCTAssertEqual(first.payload, #"{"lectureId":"\#(lecture.id)","redo":false}"#)
            return [first.id, second.id, mark.id]
        }

        let claimed = try claimNextJob(database: db, lane: .main, now: t0.addingTimeInterval(5))
        XCTAssertEqual(claimed?.id, ids[2])
        XCTAssertEqual(claimed?.status, .running)
        XCTAssertEqual(claimed?.attempts, 1)
        XCTAssertEqual(try claimNextJob(database: db, lane: .main)?.id, ids[0])
        XCTAssertEqual(try claimNextJob(database: db, lane: .main)?.id, ids[1])
        XCTAssertNil(try claimNextJob(database: db, lane: .main))
        XCTAssertEqual(try claimNextJob(database: db, lane: .sort)?.kind, .sort)
        XCTAssertNil(try claimNextJob(database: db, lane: .ask))

        // A job already taken is not taken twice.
        try db.writer.write { conn in
            XCTAssertFalse(try claimJob(db: conn, jobId: ids[0]))
        }
    }

    func testStagesMakeATimeline() throws {
        let db = try LockinDatabase.inMemory()
        let job = try db.writer.write { conn -> Job in
            let lecture = try makeLecture(conn)
            return try enqueue(db: conn, kind: .prepare, payload: [:], lectureId: lecture.id)
        }
        let t1 = t0.addingTimeInterval(1)
        let t2 = t0.addingTimeInterval(2)
        try db.writer.write { conn in
            XCTAssertTrue(try claimJob(db: conn, jobId: job.id, now: t0))
            try enterStage(db: conn, jobId: job.id, stage: .digest, now: t0)
            try setStageDetail(db: conn, jobId: job.id, detail: "reading part 1 of 2")
            try enterStage(db: conn, jobId: job.id, stage: .questions, now: t1)
            try setStageDetail(db: conn, jobId: job.id, detail: nil)
        }
        let row = try db.reader.read { conn in try Job.fetchOne(conn, key: job.id) }
        XCTAssertEqual(row?.stage, "questions")
        XCTAssertEqual(
            row?.steps,
            #"[{"stage":"digest","startedAt":"2027-01-15T08:00:00.000Z","finishedAt":"2027-01-15T08:00:01.000Z","detail":"reading part 1 of 2"},"#
                + #"{"stage":"questions","startedAt":"2027-01-15T08:00:01.000Z","finishedAt":null,"detail":null}]"#
        )
        let steps = readSteps(row?.steps)
        XCTAssertEqual(steps.map { $0.stage }, [.digest, .questions])
        XCTAssertEqual(steps.first?.detail, "reading part 1 of 2")
        XCTAssertNil(steps.last?.finishedAt)
        XCTAssertEqual(steps.last?.label, "Writing LAQs")

        XCTAssertEqual(
            closeSteps(row?.steps, now: t2),
            #"[{"stage":"digest","startedAt":"2027-01-15T08:00:00.000Z","finishedAt":"2027-01-15T08:00:01.000Z","detail":"reading part 1 of 2"},"#
                + #"{"stage":"questions","startedAt":"2027-01-15T08:00:01.000Z","finishedAt":"2027-01-15T08:00:02.000Z","detail":null}]"#
        )
        XCTAssertEqual(closeSteps(nil), "[]")
        XCTAssertEqual(readSteps("not json"), [])

        try db.writer.write { conn in
            try completeJob(
                db: conn,
                jobId: job.id,
                result: ["digest": ["title": "Appetite"]],
                promptVersion: "",
                model: "Fake (development)",
                durationMs: 1500,
                closeTimeline: true,
                now: t2
            )
        }
        let done = try db.reader.read { conn in try Job.fetchOne(conn, key: job.id) }
        XCTAssertEqual(done?.status, .done)
        XCTAssertNil(done?.stage)
        XCTAssertNil(done?.promptVersion)
        XCTAssertEqual(done?.result, #"{"digest":{"title":"Appetite"}}"#)
        XCTAssertEqual(done?.model, "Fake (development)")
        XCTAssertEqual(done?.durationMs, 1500)
        XCTAssertEqual(readSteps(done?.steps).last?.finishedAt, "2027-01-15T08:00:02.000Z")

        // A job deleted mid-run (with its lecture) fails as Prisma's findUniqueOrThrow does.
        try db.writer.write { conn in
            XCTAssertThrowsError(try enterStage(db: conn, jobId: "gone", stage: .digest)) { error in
                XCTAssertEqual(messageOf(error), prismaRecordNotFound)
            }
            // Detail for a job that is gone is simply dropped.
            XCTAssertNoThrow(try setStageDetail(db: conn, jobId: "gone", detail: "x"))
        }
    }

    func testFailingRetriesOnceThenParksAndCancelOnlyStopsLectureWork() throws {
        let db = try LockinDatabase.inMemory()
        let (job, sort) = try db.writer.write { conn -> (Job, Job) in
            let lecture = try makeLecture(conn)
            let job = try enqueue(db: conn, kind: .generate, payload: [:], lectureId: lecture.id)
            let sort = try enqueue(db: conn, kind: .sort, payload: [:], lectureId: nil)
            return (job, sort)
        }
        try db.writer.write { conn in
            XCTAssertTrue(try claimJob(db: conn, jobId: job.id))
            try failJob(db: conn, jobId: job.id, message: "claude exited 1", retry: true, durationMs: 10)
        }
        var row = try db.reader.read { conn in try Job.fetchOne(conn, key: job.id) }
        XCTAssertEqual(row?.status, .pending)
        XCTAssertEqual(row?.error, "claude exited 1")
        XCTAssertNil(row?.finishedAt)

        try db.writer.write { conn in
            XCTAssertTrue(try cancelJob(db: conn, jobId: job.id))
            XCTAssertTrue(try cancelJob(db: conn, jobId: sort.id))
            XCTAssertEqual(try jobStatus(db: conn, jobId: job.id), .failed)
            XCTAssertNil(try jobStatus(db: conn, jobId: "gone"))
        }
        row = try db.reader.read { conn in try Job.fetchOne(conn, key: job.id) }
        XCTAssertEqual(row?.error, "Cancelled")
        XCTAssertNotNil(row?.finishedAt)

        try db.writer.write { conn in
            try retryJob(db: conn, jobId: job.id)
        }
        row = try db.reader.read { conn in try Job.fetchOne(conn, key: job.id) }
        XCTAssertEqual(row?.status, .pending)
        XCTAssertEqual(row?.attempts, 0)
        XCTAssertNil(row?.error)
    }

    func testTakingTheQueueFromAStoppedOwnerRequeuesItsJobs() throws {
        let db = try LockinDatabase.inMemory()
        let (running, download) = try db.writer.write { conn -> (Job, Job) in
            let lecture = try makeLecture(conn)
            var running = Job(kind: .prepare, payload: "{}", lectureId: lecture.id, status: .running, stage: "digest")
            try running.insert(conn)
            var download = Job(kind: .download, payload: "{}", status: .running, stage: "download")
            try download.insert(conn)
            var oldSort = Job(kind: .sort, payload: "{}", status: .done, createdAt: t0.addingTimeInterval(-2 * 86_400))
            try oldSort.insert(conn)
            var recentAsk = Job(kind: .ask, payload: "{}", status: .done, createdAt: t0.addingTimeInterval(-2 * 86_400))
            try recentAsk.insert(conn)
            // The Electron worker checked in 30 s ago: stopped.
            try writeHeartbeat(db: conn, Heartbeat(at: jsISOString(t0.addingTimeInterval(-30)), pid: 7, provider: "Claude Code"))
            return (running, download)
        }

        let first = try acquireQueue(database: db, pid: 42, provider: "Claude Code", alreadyOwner: false, now: t0)
        // The prepare and the download were both left RUNNING: both go back in the queue.
        XCTAssertEqual(first, .tookOver(requeued: 2))
        try db.reader.read { conn in
            XCTAssertEqual(try Job.fetchOne(conn, key: running.id)?.status, .pending)
            XCTAssertNil(try Job.fetchOne(conn, key: running.id)?.stage)
            XCTAssertEqual(try Job.fetchOne(conn, key: download.id)?.status, .pending, "the download lane of whoever takes over carries it on from its .part files")
            XCTAssertEqual(try Job.filter(Column("kind") == "SORT").fetchCount(conn), 0)
            XCTAssertEqual(try Job.filter(Column("kind") == "ASK").fetchCount(conn), 1)
            let beat = try readHeartbeat(db: conn, now: t0)
            XCTAssertEqual(beat?.heartbeat.pid, 42)
            XCTAssertEqual(beat?.heartbeat.app, "swift")
            XCTAssertEqual(beat?.alive, true)
        }

        XCTAssertEqual(try acquireQueue(database: db, pid: 42, provider: "Claude Code", alreadyOwner: true, now: t0.addingTimeInterval(5)), .kept)
        // Another copy of the app finds it taken.
        let other = try acquireQueue(database: db, pid: 99, provider: "Claude Code", alreadyOwner: false, now: t0.addingTimeInterval(6))
        guard case .taken(let owner) = other else {
            return XCTFail("expected the queue to be taken, got \(other)")
        }
        XCTAssertEqual(owner.pid, 42)

        // The owner's own row went missing (the other app deleted it): rewritten, nothing requeued.
        try db.writer.write { conn in
            var mine = Job(kind: .mark, payload: "{}", status: .running)
            try mine.insert(conn)
            try deleteHeartbeat(db: conn)
        }
        XCTAssertEqual(try acquireQueue(database: db, pid: 42, provider: "Claude Code", alreadyOwner: true, now: t0.addingTimeInterval(10)), .kept)
        try db.reader.read { conn in
            XCTAssertEqual(try Job.filter(Column("status") == "RUNNING" && Column("kind") == "MARK").fetchCount(conn), 1)
        }

        try db.writer.write { conn in
            try releaseQueue(db: conn, pid: 42)
            XCTAssertNil(try readHeartbeat(db: conn))
        }
    }

    func testActivitySaysWhatIsRunningWaitingAndDone() throws {
        let db = try LockinDatabase.inMemory()
        let lecture = try db.writer.write { conn -> Lecture in
            let lecture = try makeLecture(conn)
            var running = Job(kind: .prepare, payload: "{}", lectureId: lecture.id, status: .running, stage: "digest", createdAt: t0, startedAt: t0)
            try running.insert(conn)
            try enterStage(db: conn, jobId: running.id, stage: .digest, now: t0)
            try setStageDetail(db: conn, jobId: running.id, detail: "writing")
            _ = try enqueue(db: conn, kind: .generate, payload: [:], lectureId: lecture.id, now: t0)
            _ = try enqueue(db: conn, kind: .ask, payload: [:], lectureId: lecture.id, now: t0)
            var failed = Job(kind: .mark, payload: "{}", lectureId: lecture.id, status: .failed, error: "Cancelled", createdAt: t0, finishedAt: t0)
            try failed.insert(conn)
            return lecture
        }
        let activity = try db.reader.read { conn in try loadActivity(db: conn, now: t0.addingTimeInterval(60)) }
        XCTAssertEqual(activity.running?.lectureTitle, lecture.title)
        XCTAssertEqual(activity.running?.courseCode, "PHYS2001")
        XCTAssertEqual(activity.running?.stageLabel, "Reading & summarising")
        XCTAssertEqual(activity.queued.map { $0.kind }, [.generate])
        XCTAssertEqual(activity.recent.map { $0.error }, ["Cancelled"])
        XCTAssertNil(activity.worker)
        XCTAssertEqual(activity.version, "\(activity.running?.id ?? ""):digest:writing|1|\(activity.recent.first?.id ?? "")|FAILED|0")
    }

    func testJSISOStringAndTiming() {
        XCTAssertEqual(jsISOString(t0.addingTimeInterval(0.25)), "2027-01-15T08:00:00.250Z")
        XCTAssertEqual(jobPriority(.mark), 10)
        XCTAssertEqual(jobPriority(.prepare), 0)
        XCTAssertEqual(QueueTiming.standard.sortPoll, 0.75)
        XCTAssertEqual(QueueTiming.standard.askPoll, 0.5)
        XCTAssertEqual(QueueTiming.fromEnvironment(["LOCKIN_WORKER_POLL_MS": "400"]).sortPoll, 0.4)
        XCTAssertEqual(QueueLane.main.kinds, [.prepare, .generate, .mark])
    }
}
