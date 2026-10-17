import Foundation
import GRDB
import XCTest
@testable import LockinCore

final class ScanAndImportTests: XCTestCase {
    func testExcerptOfMatchesTypeScriptSortFilesBehaviour() {
        let slideText = "--- Page 1 ---\nAppetite & Satiety\nDr Lee\n\n--- Page 3 ---\nGhrelin\nrises before meals"
        XCTAssertEqual(
            excerptOf(kind: "SLIDES", text: slideText, budget: 500, pages: 4),
            SortFileExcerpt(
                detail: "slides, 4 pages, 2 without text",
                excerpt: "Appetite & Satiety · Ghrelin"
            )
        )

        let vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nGood morning everyone.\n\n2\n00:00:04.500 --> 00:00:07.000\nToday: appetite."
        XCTAssertEqual(
            excerptOf(kind: "TRANSCRIPT", text: vtt, budget: 500, hours: 0.75),
            SortFileExcerpt(
                detail: "transcript, 45 min",
                excerpt: "Good morning everyone. Today: appetite."
            )
        )

        let capped = excerptOf(kind: "TRANSCRIPT", text: String(repeating: "word ", count: 500), budget: 40)
        XCTAssertLessThanOrEqual(capped.excerpt.utf16Count, 40)
        XCTAssertTrue(capped.excerpt.hasSuffix("…"))
    }

    func testScansFolderReviewsMovesFilesAndImportsIntoDatabase() throws {
        let tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("lockin-scan-test-\(UUID().uuidString)", isDirectory: true)
        let materialsDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("lockin-materials-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: materialsDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: tempRoot)
            try? FileManager.default.removeItem(at: materialsDir)
        }

        let l1Vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:05.000\nLac operon intro.\n\n2\n00:52:00.000 --> 00:52:05.000\nEnd of lecture 1."
        let l1Slides = "--- Slide 1 ---\nLac Operon\n\n--- Slide 2 ---\ncAMP and CAP"
        let l2Txt = "[00:01] Trp operon attenuation.\n\n[01:55:00] Summary of lecture 2."
        let ignoredBin = Data([0x00, 0x01, 0x02])

        try Data(l1Vtt.utf8).write(to: tempRoot.appendingPathComponent("L1_Lac_operon.vtt"))
        try Data(l1Slides.utf8).write(to: tempRoot.appendingPathComponent("L1_Lac_operon_slides.md"))
        try Data(l2Txt.utf8).write(to: tempRoot.appendingPathComponent("L2_Trp_operon.txt"))
        try ignoredBin.write(to: tempRoot.appendingPathComponent("recording.mp4"))

        let scan = try scanFolder(root: tempRoot.path)
        XCTAssertEqual(scan.files.count, 3)
        XCTAssertEqual(scan.skipped, [SkippedScanItem(path: "recording.mp4", why: "unsupported file type")])

        let db = try LockinDatabase.inMemory()
        try db.writer.write { conn in
            var course = Course(id: "c1", code: "BIOL3010", title: "Molecular Genetics")
            try course.insert(conn)
        }

        let proposed = groupFiles(scan.files.map(\.groupInput))
        XCTAssertEqual(proposed.count, 2)

        var rows = buildImportReviewRows(lectures: proposed, files: scan.files)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].status, .new)
        XCTAssertEqual(rows[0].durationHours, 1.0)
        XCTAssertEqual(rows[1].durationHours, 2.0)

        // Retitle row 0 before importing
        rows[0].title = "The Lac Operon (Edited)"

        let summary = try db.writer.write { conn in
            try importReviewedLectures(
                db: conn,
                courseId: "c1",
                root: tempRoot.path,
                rows: rows,
                files: scan.files,
                prepareWithAi: true,
                materialsDir: materialsDir
            )
        }
        XCTAssertEqual(summary.createdLectureIds.count, 2)
        XCTAssertTrue(summary.updatedLectureIds.isEmpty)

        // Re-scanning the same folder detects both lectures as already imported ("have")
        try db.reader.read { conn in
            let lectures = try Lecture.order(Column("deliveredOn").asc, Column("createdAt").asc).fetchAll(conn)
            XCTAssertEqual(lectures.count, 2)
            XCTAssertFalse(lectures[0].autoTitle, "Edited title should mark autoTitle = false")
            XCTAssertTrue(lectures[1].autoTitle, "Unedited filename title should keep autoTitle = true")
            XCTAssertEqual(try Material.fetchCount(conn), 3)
            XCTAssertEqual(try Job.filter(Column("kind") == JobKind.prepare.rawValue).fetchCount(conn), 2)

            let held = try existingFilesInCourse(db: conn, courseId: "c1", scannedFiles: scan.files)
            let secondReview = buildImportReviewRows(lectures: proposed, files: scan.files, inLectures: held)
            XCTAssertEqual(secondReview.map(\.status), [.have, .have])
            XCTAssertEqual(secondReview.map(\.included), [false, false])
        }
    }
}
