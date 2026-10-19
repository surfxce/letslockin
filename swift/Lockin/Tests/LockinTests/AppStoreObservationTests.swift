import Foundation
import GRDB
import XCTest
@testable import LockinCore

@MainActor
final class AppStoreObservationTests: XCTestCase {
    private func waitUntil(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Database observation did not deliver its update")
    }

    func testHeartbeatAndTokenProgressDoNotReloadLibraryButStatusAndSummaryDo() async throws {
        let database = try LockinDatabase.inMemory()
        try await database.writer.write { db in
            var course = Course(id: "course", code: "BIO", title: "Biology")
            try course.insert(db)
            var lecture = Lecture(id: "lecture", courseId: "course", title: "Cells", summaryMd: "Before")
            try lecture.insert(db)
            var job = Job(id: "job", kind: .prepare, payload: "{}", lectureId: "lecture", status: .running)
            try job.insert(db)
        }
        let store = AppStore(database: database, startQueue: false)
        try await waitUntil { store.settingsLoaded && store.lectureRows.count == 1 && store.runningJob != nil }
        let beforeProgress = store.dbRevision
        try await database.writer.write { db in
            try writeHeartbeat(db: db, Heartbeat.current(provider: "Test"))
            try db.execute(sql: "UPDATE Job SET result = ? WHERE id = 'job'", arguments: ["streamed output"])
        }
        try await waitUntil { store.runningJob?.result == "streamed output" }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(store.dbRevision, beforeProgress)
        let revision = store.dbRevision
        try await database.writer.write { db in
            try db.execute(sql: "UPDATE Job SET status = 'DONE' WHERE id = 'job'")
            try db.execute(sql: "UPDATE Lecture SET summaryMd = 'After' WHERE id = 'lecture'")
        }
        try await waitUntil { store.dbRevision > revision && store.lectureRows.first?.status == .summary }
        XCTAssertEqual(store.loadLectureDetail(id: "lecture")?.lecture.summaryMd, "After")
    }

    func testSettingsAndGlossaryChangesStillRefreshDetail() async throws {
        let database = try LockinDatabase.inMemory()
        try await database.writer.write { db in
            var course = Course(id: "course", code: "BIO", title: "Biology")
            try course.insert(db)
            var lecture = Lecture(id: "lecture", courseId: "course", title: "Cells")
            try lecture.insert(db)
        }
        let store = AppStore(database: database, startQueue: false)
        try await waitUntil { store.settingsLoaded && store.lectureRows.count == 1 }
        var revision = store.dbRevision
        try await database.writer.write { db in try setSetting(db: db, key: "sittingPerHour", value: 4) }
        try await waitUntil { store.dbRevision > revision && store.settings.sittingPerHour == 4 }
        revision = store.dbRevision
        store.updateSettings { $0.sittingPerHour = 3 }
        XCTAssertGreaterThan(store.dbRevision, revision)
        try await waitUntil { store.settings.sittingPerHour == 3 }
        revision = store.dbRevision
        _ = store.saveGlossaryTerm(lectureId: "lecture", term: "ATP", explanation: "Energy carrier")
        try await waitUntil { store.dbRevision > revision }
        XCTAssertEqual(store.loadLectureDetail(id: "lecture")?.glossaryTerms.first?.term, "ATP")
    }
}
