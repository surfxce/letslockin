import Foundation
import GRDB
import XCTest
@testable import LockinCore

final class LectureLibraryTests: XCTestCase {
    func testComputesLectureStatusesOrdinalsQueuePositionsAndDueRows() throws {
        let db = try LockinDatabase.inMemory()
        let baseDate = Date(timeIntervalSince1970: 1_790_000_000)

        try db.writer.write { conn in
            var course = Course(id: "c1", code: "BIOL3010", title: "Genetics", createdAt: baseDate)
            try course.insert(conn)

            var mod = Module(id: "m1", courseId: "c1", title: "Operons", position: 0, createdAt: baseDate)
            try mod.insert(conn)

            // L1: Practised (has scored attempt and question)
            var l1 = Lecture(
                id: "l1",
                courseId: "c1",
                moduleId: "m1",
                title: "Lac operon",
                deliveredOn: baseDate,
                durationHours: 1,
                summaryMd: "# Summary",
                summaryModel: "MLX · Gemma 4 E4B",
                createdAt: baseDate
            )
            try l1.insert(conn)

            var q1 = Question(
                id: "q1",
                lectureId: "l1",
                stem: "Explain lacZ.",
                type: .laq,
                rubric: "{}",
                promptVersion: "1.0.0",
                model: "MLX · Gemma 4 E4B",
                createdAt: baseDate
            )
            try q1.insert(conn)

            var a1 = Attempt(
                id: "a1",
                lectureId: "l1",
                sittingDate: baseDate.addingTimeInterval(-10 * 86_400),
                closedBook: true,
                geometricMean: 4.5,
                completedAt: baseDate.addingTimeInterval(-10 * 86_400),
                source: .app
            )
            try a1.insert(conn)

            // L2: Queued behind a pending PREPARE job
            var l2 = Lecture(
                id: "l2",
                courseId: "c1",
                moduleId: nil,
                title: "Trp operon",
                deliveredOn: baseDate.addingTimeInterval(86_400),
                durationHours: 1,
                createdAt: baseDate.addingTimeInterval(10)
            )
            try l2.insert(conn)

            var j2 = Job(
                id: "j2",
                kind: .prepare,
                payload: "{}",
                lectureId: "l2",
                status: .pending,
                priority: 0,
                createdAt: baseDate
            )
            try j2.insert(conn)

            // Side-lane SORT job should not affect queuePosition of PREPARE jobs
            var jSort = Job(
                id: "j-sort",
                kind: .sort,
                payload: "{}",
                lectureId: nil,
                status: .pending,
                priority: 10,
                createdAt: baseDate.addingTimeInterval(-50)
            )
            try jSort.insert(conn)
        }

        try db.reader.read { conn in
            let all = try lectureRows(db: conn)
            XCTAssertEqual(all.map(\.ordinal), [1, 2])
            XCTAssertEqual(all[0].status, .practised)
            XCTAssertEqual(all[0].lastScore, 4.5)
            XCTAssertEqual(all[0].moduleTitle, "Operons")

            XCTAssertEqual(all[1].status, .queued)
            XCTAssertEqual(all[1].queuePosition, 1)

            // Filtering by id still preserves course-wide ordinal L2
            let onlySecond = try lectureRows(db: conn, ids: ["l2"])
            XCTAssertEqual(onlySecond.first?.ordinal, 2)

            // Due lectures include l1 since its sitting was 10 days ago with score 4.5 (1-day interval)
            let due = try dueLectures(db: conn, now: baseDate)
            XCTAssertEqual(due.map(\.id), ["l1"])
        }
    }

    func testSortsWithNullsLastAndGroupsWithModuleAverages() {
        let d1 = Date(timeIntervalSince1970: 1_790_000_000)
        let d2 = Date(timeIntervalSince1970: 1_790_086_400)
        let d3 = Date(timeIntervalSince1970: 1_790_172_800)

        let r1 = LectureRow(
            id: "1", title: "Alpha", ordinal: 1, courseId: "c1", courseCode: "BIOL",
            moduleId: "m1", moduleTitle: "Mod A", deliveredOn: d1, durationHours: 1,
            hasSummary: true, laqCount: 3, fileCount: 1, sittings: 1,
            lastScore: 8.0, prevScore: nil, bestScore: 8.0, lastSatOn: d1, dueAt: d3,
            status: .practised, stageLabel: nil, queuePosition: nil, error: nil
        )
        let r2 = LectureRow(
            id: "2", title: "Beta", ordinal: 2, courseId: "c1", courseCode: "BIOL",
            moduleId: "m1", moduleTitle: "Mod A", deliveredOn: d2, durationHours: 1,
            hasSummary: true, laqCount: 3, fileCount: 1, sittings: 0,
            lastScore: nil, prevScore: nil, bestScore: nil, lastSatOn: nil, dueAt: nil,
            status: .ready, stageLabel: nil, queuePosition: nil, error: nil
        )
        let r3 = LectureRow(
            id: "3", title: "Gamma", ordinal: 3, courseId: "c1", courseCode: "BIOL",
            moduleId: "m2", moduleTitle: "Mod B", deliveredOn: d3, durationHours: 1,
            hasSummary: true, laqCount: 3, fileCount: 1, sittings: 1,
            lastScore: 5.0, prevScore: nil, bestScore: 5.0, lastSatOn: d3, dueAt: d2,
            status: .practised, stageLabel: nil, queuePosition: nil, error: nil
        )

        let ascScores = filterAndSortLectures([r1, r2, r3], view: .init(sort: .score, dir: .asc, group: .none))
        XCTAssertEqual(ascScores.map(\.id), ["3", "1", "2"], "Unscored lecture should sink to the end on asc")

        let descScores = filterAndSortLectures([r1, r2, r3], view: .init(sort: .score, dir: .desc, group: .none))
        XCTAssertEqual(descScores.map(\.id), ["1", "3", "2"], "Unscored lecture should also sink to the end on desc")

        let grouped = groupLectures([r1, r2, r3], view: .init(sort: .score, dir: .asc, group: .module))
        XCTAssertEqual(grouped.map(\.name), ["Mod B", "Mod A"], "Weakest module average comes first")
        XCTAssertEqual(grouped[0].avg, 5.0)
        XCTAssertEqual(grouped[1].avg, 8.0)

        let searched = filterAndSortLectures([r1, r2, r3], query: "l2")
        XCTAssertEqual(searched.map(\.id), ["2"])
    }

    func testDescribeModelsFormatsSummaryLaqsAndFallback() {
        let lec = Lecture(
            id: "l1",
            courseId: "c1",
            title: "Operons",
            deliveredOn: Date(),
            summaryMd: "Some summary",
            summaryModel: "Claude Code · Sonnet"
        )
        let questions = [
            Question(id: "q1", lectureId: "l1", stem: "Q1", rubric: "{}", promptVersion: "1.0.0", model: "Offline · Gemma 4 E4B"),
            Question(id: "q2", lectureId: "l1", stem: "Q2", rubric: "{}", promptVersion: "pasted", model: nil),
        ]
        let job = Job(
            id: "j1",
            kind: .prepare,
            payload: "{}",
            lectureId: "l1",
            status: .done,
            result: #"{"fellBack":"Rate limited"}"#,
            model: "Offline · Gemma 4 E4B",
            durationMs: 12_000,
            finishedAt: Date()
        )
        let info = describeModels(lecture: lec, questions: questions, lastRun: job)
        XCTAssertEqual(info.summary, "Claude Code · Sonnet")
        XCTAssertEqual(
            info.laqs,
            [
                .init(model: "Offline · Gemma 4 E4B", count: 1),
                .init(model: "Pasted from an AI chat", count: 1),
            ]
        )
        XCTAssertEqual(info.lastRun?.what, "Prepared")
        XCTAssertEqual(info.lastRun?.fellBack, "Rate limited")
    }
}
