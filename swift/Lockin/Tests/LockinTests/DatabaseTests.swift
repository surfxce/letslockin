import Foundation
import GRDB
import XCTest
@testable import LockinCore

final class DatabaseTests: XCTestCase {
    func testMigratesAndRoundTripsEveryModel() throws {
        let db = try LockinDatabase.inMemory()

        try db.writer.write { conn in
            var course = Course(
                id: "course-1",
                code: "BIOL3010",
                title: "Molecular Genetics",
                examDate: Date(timeIntervalSince1970: 1_795_000_000),
                weighting: 0.6,
                createdAt: Date(timeIntervalSince1970: 1_790_000_000)
            )
            try course.insert(conn)

            var mod = Module(
                id: "mod-1",
                courseId: course.id,
                title: "Module 1: Gene Regulation",
                position: 0,
                createdAt: Date(timeIntervalSince1970: 1_790_000_100)
            )
            try mod.insert(conn)

            var lecture = Lecture(
                id: "lec-1",
                courseId: course.id,
                moduleId: mod.id,
                title: "The lac operon",
                deliveredOn: Date(timeIntervalSince1970: 1_790_086_400),
                durationHours: 1.5,
                summaryMd: "## Structure\nThree structural genes.",
                autoTitle: false,
                skipped: #"[{"what":"Module aims","where":"slide 2"}]"#,
                slideNotes: #"[{"slide":1,"notes":"Operon diagram"}]"#,
                summaryModel: "MLX · Gemma 4 E4B",
                createdAt: Date(timeIntervalSince1970: 1_790_086_500)
            )
            try lecture.insert(conn)

            var term = GlossaryTerm(
                id: "term-1",
                lectureId: lecture.id,
                term: "allolactose",
                explanation: "Isomer of lactose that induces the lac operon.",
                createdAt: Date(timeIntervalSince1970: 1_790_086_600)
            )
            try term.insert(conn)

            var material = Material(
                id: "mat-1",
                courseId: course.id,
                lectureId: lecture.id,
                kind: .slides,
                path: "lec-1/slides.pdf",
                originalName: "L1_slides.pdf",
                extractedText: "--- Slide 1 ---\nThe lac operon",
                pageCount: 24,
                checksum: "abc123",
                createdAt: Date(timeIntervalSince1970: 1_790_086_700)
            )
            try material.insert(conn)

            var concept = Concept(
                id: "con-1",
                courseId: course.id,
                lectureId: lecture.id,
                name: "Catabolite repression",
                definition: "Low glucose raises cAMP, activating CAP.",
                sourceRef: "slide 8",
                mergedIntoId: nil,
                createdAt: Date(timeIntervalSince1970: 1_790_086_800)
            )
            try concept.insert(conn)

            var question = Question(
                id: "q-1",
                lectureId: lecture.id,
                stem: "Explain how glucose regulates the lac operon.",
                type: .laq,
                rubric: #"{"criteria":[]}"#,
                promptVersion: "1.3.0",
                model: "MLX · Gemma 4 E4B",
                createdAt: Date(timeIntervalSince1970: 1_790_086_900)
            )
            try question.insert(conn)

            var qc = QuestionConcept(questionId: question.id, conceptId: concept.id)
            try qc.insert(conn)

            var attempt = Attempt(
                id: "att-1",
                lectureId: lecture.id,
                sittingDate: Date(timeIntervalSince1970: 1_790_100_000),
                closedBook: true,
                geometricMean: 8.5,
                completedAt: Date(timeIntervalSince1970: 1_790_101_000),
                source: .app
            )
            try attempt.insert(conn)

            var response = Response(
                id: "resp-1",
                attemptId: attempt.id,
                questionId: question.id,
                answerText: "Low glucose increases adenylyl cyclase activity.",
                draftText: nil,
                mark: 8.5,
                rubricVersion: "1.0.0",
                rawMarkingJson: #"{"mark":8.5}"#,
                markedAt: Date(timeIntervalSince1970: 1_790_101_000)
            )
            try response.insert(conn)

            var gap = Gap(
                id: "gap-1",
                responseId: response.id,
                conceptId: concept.id,
                type: .missed,
                text: "Inhibition of IIA^Glc",
                createdAt: Date(timeIntervalSince1970: 1_790_101_100)
            )
            try gap.insert(conn)

            var review = Review(
                id: "rev-1",
                conceptId: concept.id,
                dueOn: Date(timeIntervalSince1970: 1_790_200_000),
                intervalDays: 3,
                setByAttemptId: attempt.id,
                completedAt: nil
            )
            try review.insert(conn)

            var paper = PastPaper(
                id: "pap-1",
                courseId: course.id,
                year: 2025,
                label: "Semester 1",
                materialId: material.id,
                createdAt: Date(timeIntervalSince1970: 1_790_200_100)
            )
            try paper.insert(conn)

            var item = PaperItem(
                id: "item-1",
                paperId: paper.id,
                stem: "Describe diauxic growth.",
                marksAllocated: 10,
                questionNumber: "Q4"
            )
            try item.insert(conn)

            var pic = PaperItemConcept(paperItemId: item.id, conceptId: concept.id)
            try pic.insert(conn)

            var job = Job(
                id: "job-1",
                kind: .prepare,
                payload: #"{"lectureId":"lec-1"}"#,
                lectureId: lecture.id,
                status: .done,
                priority: 0,
                stage: nil,
                steps: #"[{"stage":"digest","startedAt":"2026-10-12T00:00:00Z"}]"#,
                attempts: 1,
                error: nil,
                result: "{}",
                promptVersion: "1.2.0",
                model: "MLX · Gemma 4 E4B",
                durationMs: 4200,
                createdAt: Date(timeIntervalSince1970: 1_790_086_000),
                startedAt: Date(timeIntervalSince1970: 1_790_086_001),
                finishedAt: Date(timeIntervalSince1970: 1_790_086_005)
            )
            try job.insert(conn)

            var setting = Setting(
                key: "mode",
                value: #""local""#,
                updatedAt: Date(timeIntervalSince1970: 1_790_086_000)
            )
            try setting.save(conn)
        }

        try db.reader.read { conn in
            XCTAssertEqual(try Course.fetchCount(conn), 1)
            XCTAssertEqual(try Module.fetchCount(conn), 1)
            XCTAssertEqual(try Lecture.fetchCount(conn), 1)
            XCTAssertEqual(try GlossaryTerm.fetchCount(conn), 1)
            XCTAssertEqual(try Material.fetchCount(conn), 1)
            XCTAssertEqual(try Concept.fetchCount(conn), 1)
            XCTAssertEqual(try Question.fetchCount(conn), 1)
            XCTAssertEqual(try QuestionConcept.fetchCount(conn), 1)
            XCTAssertEqual(try Attempt.fetchCount(conn), 1)
            XCTAssertEqual(try Response.fetchCount(conn), 1)
            XCTAssertEqual(try Gap.fetchCount(conn), 1)
            XCTAssertEqual(try Review.fetchCount(conn), 1)
            XCTAssertEqual(try PastPaper.fetchCount(conn), 1)
            XCTAssertEqual(try PaperItem.fetchCount(conn), 1)
            XCTAssertEqual(try PaperItemConcept.fetchCount(conn), 1)
            XCTAssertEqual(try Job.fetchCount(conn), 1)
            XCTAssertEqual(try Setting.fetchOne(conn, key: "mode")?.value, #""local""#)

            let applied = try String.fetchAll(
                conn,
                sql: #"SELECT "migration_name" FROM "_prisma_migrations" ORDER BY "migration_name" ASC"#
            )
            XCTAssertEqual(applied, LockinDatabase.embeddedMigrations.map(\.name))
        }
    }

    func testDecodesOpenStringTypesAndPrismaDates() throws {
        let db = try LockinDatabase.inMemory()
        try db.writer.write { conn in
            try conn.execute(
                sql: """
                INSERT INTO "Course" ("id", "code", "title", "examDate", "weighting", "createdAt")
                VALUES ('c1', 'MEDI2001', 'Physiology', '2026-11-15T09:00:00.000+00:00', 0.5, '2026-10-12T05:44:02.278+00:00');
                INSERT INTO "Setting" ("key", "value", "updatedAt")
                VALUES ('notify', 'true', '2026-10-15 14:41:03');
                INSERT INTO "Job" ("id", "kind", "payload", "status", "priority", "attempts", "createdAt")
                VALUES ('j-legacy', 'PARSE_PAPER', '{}', 'CUSTOM_STATE', 0, 0, '2026-10-15T00:00:00.000Z');
                """
            )
        }
        try db.reader.read { conn in
            let course = try XCTUnwrap(Course.fetchOne(conn, key: "c1"))
            XCTAssertEqual(course.code, "MEDI2001")
            XCTAssertNotNil(course.examDate)
            let setting = try XCTUnwrap(Setting.fetchOne(conn, key: "notify"))
            XCTAssertEqual(setting.value, "true")
            let legacyJob = try XCTUnwrap(Job.fetchOne(conn, key: "j-legacy"))
            XCTAssertEqual(legacyJob.kind, JobKind(rawValue: "PARSE_PAPER"))
            XCTAssertEqual(legacyJob.status, JobStatus(rawValue: "CUSTOM_STATE"))
        }
    }

    func testReadsExistingElectronDatabaseCopyWhenPresent() throws {
        // #filePath is .../LetsLockIn/swift/Lockin/Tests/LockinTests/DatabaseTests.swift (5 levels deep)
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let repoDb = repoRoot.appendingPathComponent("prisma/lockin.db")
        guard FileManager.default.fileExists(atPath: repoDb.path) else { return }

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("lockin-db-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let tempDb = tempDir.appendingPathComponent("lockin.db")
        try FileManager.default.copyItem(at: repoDb, to: tempDb)

        let db = try LockinDatabase(path: tempDb.path, migrationsDir: nil)
        try db.reader.read { conn in
            _ = try Course.fetchAll(conn)
            _ = try Module.fetchAll(conn)
            _ = try Lecture.fetchAll(conn)
            _ = try Material.fetchAll(conn)
            _ = try Concept.fetchAll(conn)
            _ = try Question.fetchAll(conn)
            _ = try Attempt.fetchAll(conn)
            _ = try Response.fetchAll(conn)
            _ = try Job.fetchAll(conn)
            _ = try GlossaryTerm.fetchAll(conn)
            _ = try Setting.fetchAll(conn)
        }
    }
}
