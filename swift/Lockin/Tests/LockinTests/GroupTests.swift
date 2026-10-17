import Foundation
import XCTest
@testable import LockinCore

final class GroupTests: XCTestCase {
    private var at: Date {
        var comps = DateComponents()
        comps.year = 2026
        comps.month = 3
        comps.day = 10
        comps.hour = 12
        return Calendar.current.date(from: comps)!
    }

    private func f(_ relativePath: String, _ kind: String = "TRANSCRIPT", _ measuredHours: Double? = nil) -> GroupInput {
        GroupInput(relativePath: relativePath, kind: kind, modifiedOn: at, measuredHours: measuredHours)
    }

    func testPairsEachTranscriptWithItsSlidesByLectureNumber() {
        let out = groupFiles([
            f("L1 transcript.vtt", "TRANSCRIPT", 1),
            f("Lecture 01 - Gene regulation slides.pdf", "SLIDES"),
            f("BIOL3010_L2_transcript.txt", "TRANSCRIPT", 2),
            f("lec2 - Operons.pptx", "SLIDES"),
        ])
        XCTAssertEqual(out.map(\.fileIndexes), [[0, 1], [2, 3]])
        XCTAssertEqual(out.map(\.number), [1, 2])
        XCTAssertEqual(out[0].title, "Gene regulation")
        XCTAssertEqual(out[1].title, "Operons")
        XCTAssertEqual(out[1].durationHours, 2)
    }

    func testDoesNotReadCourseCodeAsLectureNumber() {
        let out = groupFiles([f("BIOL3010 L4.vtt"), f("BIOL3010 notes on genes.txt")])
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].number, 4)
        XCTAssertNil(out[1].number)
    }

    func testKeepsSameLectureNumberApartInDifferentModuleFolders() {
        let out = groupFiles([
            f("Module 1 - Heart/Lecture 1.vtt"),
            f("Module 2 - Kidney/Lecture 1.vtt"),
            f("Module 2 - Kidney/Lecture 1 slides.pdf", "SLIDES"),
        ])
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out.map(\.moduleTitle), ["Module 1 - Heart", "Module 2 - Kidney"])
        XCTAssertEqual(out[1].fileIndexes, [1, 2])
    }

    func testOrdersWeekAndLectureNumberingProperly() {
        let out = groupFiles([f("W3L1.vtt"), f("Week 2 Lecture 2.vtt"), f("Week 2 Lecture 1.vtt")])
        XCTAssertEqual(out.map { $0.fileIndexes[0] }, [2, 1, 0])
    }

    func testFallsBackToSharedNameWhenThereIsNoNumber() {
        let out = groupFiles([
            f("Gene regulation transcript.txt"),
            f("Gene regulation slides.pdf", "SLIDES"),
            f("Cell cycle.txt"),
        ])
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out.first { $0.fileIndexes.contains(0) }?.fileIndexes, [0, 1])
    }

    func testTakesDateFromFilenameElseFilesOwnDate() {
        let out = groupFiles([f("2026-03-04 lecture.vtt"), f("Cell cycle.txt")])
        XCTAssertEqual(out.first { $0.fileIndexes[0] == 0 }?.deliveredOn, "2026-03-04")
        XCTAssertEqual(out.first { $0.fileIndexes[0] == 1 }?.deliveredOn, "2026-03-10")
    }

    func testSetsAsidePastPapersAndCourseAdminInsteadOfImportingThem() {
        let out = groupFiles([
            f("L1.vtt"),
            f("Past exam 2024.pdf", "SLIDES"),
            f("BIOL3010 Course Profile.pdf", "SLIDES"),
        ])
        XCTAssertNil(out[0].setAside)
        XCTAssertTrue(out[1].setAside?.contains("past exam") == true)
        XCTAssertTrue(out[2].setAside?.contains("admin") == true)
    }

    func testTellsPastPaperSavedAsTextFromRecordedRevisionLecture() {
        let out = groupFiles([f("Past exam 2024.md", "TRANSCRIPT", nil), f("Final exam revision.vtt", "TRANSCRIPT", 1)])
        XCTAssertTrue(out.first { $0.fileIndexes[0] == 0 }?.setAside?.contains("past exam") == true)
        XCTAssertNil(out.first { $0.fileIndexes[0] == 1 }?.setAside)
    }

    func testSharedDecksAndLectureCodes() {
        let folder = [
            f("A1_Endocrine-Control-of-Metabolism_slides.pdf", "SLIDES"),
            f("A1_Endocrine-Control-of-Metabolism_transcript.txt"),
            f("A2_Glucose-Homeostasis-and-Diabetes_slides.pdf", "SLIDES"),
            f("A2_Glucose-Homeostasis-and-Diabetes_transcript.txt"),
            f("A3_Lipid-Metabolism-and-Disease_slides.pdf", "SLIDES"),
            f("A3_Lipid-Metabolism-and-Disease_transcript.txt"),
            f("A4-A5_Appetite-and-Satiety_slides_shared.pdf", "SLIDES"),
            f("A4_Appetite-and-Satiety-Part1_transcript.txt"),
            f("A5_Appetite-and-Satiety-Part2_transcript.txt"),
        ]

        let out = groupFiles(folder)
        XCTAssertEqual(out.count, 5)
        XCTAssertEqual(out.map(\.label), ["A1", "A2", "A3", "A4", "A5"])
        XCTAssertEqual(out.map(\.fileIndexes), [[0, 1], [2, 3], [4, 5], [6, 7], [6, 8]])
        XCTAssertEqual(
            out.map(\.title),
            [
                "Endocrine Control of Metabolism",
                "Glucose Homeostasis and Diabetes",
                "Lipid Metabolism and Disease",
                "Appetite and Satiety Part 1",
                "Appetite and Satiety Part 2",
            ]
        )
    }

    func testReadsRangesHoweverTheyAreWritten() {
        let out = groupFiles([
            f("L4.vtt"),
            f("L5.vtt"),
            f("L6.vtt"),
            f("Lectures 4 & 5 slides.pdf", "SLIDES"),
            f("L5-6 handout.pdf", "SLIDES"),
        ])
        XCTAssertEqual(out.map(\.fileIndexes), [[0, 3], [1, 3, 4], [2, 4]])
    }

    func testKeepsRangeAsItsOwnLectureWhenNoneOfItsLecturesIsInFolder() {
        let out = groupFiles([f("A4-A5_Appetite_slides.pdf", "SLIDES"), f("A1_Intro_transcript.txt")])
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[1].label, "A4–A5")
        XCTAssertEqual(out[1].title, "Appetite")
    }

    func testDoesNotTakeDateOrLongSpanForRange() {
        let out = groupFiles([f("L1 - 2026-03-04.vtt"), f("L1-20 complete deck.pdf", "SLIDES")])
        XCTAssertEqual(out[0].deliveredOn, "2026-03-04")
        XCTAssertTrue(out.allSatisfy { $0.fileIndexes.count == 1 })
    }

    func testLecturesFromSortKeepsAiGroupingAndListsForgottenFiles() {
        let files = [
            f("misc/recording 1.vtt", "TRANSCRIPT", 1),
            f("misc/deck final final.pdf", "SLIDES"),
            f("misc/recording 2.vtt", "TRANSCRIPT", 2),
            f("misc/syllabus.pdf", "SLIDES"),
        ]

        let out = lecturesFromSort(
            files,
            SortedFolder(
                lectures: [
                    .init(title: "Hunger signals", module: "Appetite", files: ["misc/recording 1.vtt", "misc/deck final final.pdf"]),
                    .init(title: "Satiety", module: nil, files: ["misc/recording 2.vtt", "misc/deck final final.pdf", "nope.pdf"]),
                ],
                setAside: [.init(file: "misc/syllabus.pdf", reason: "course outline")]
            )
        )
        XCTAssertEqual(out.count, 3)
        XCTAssertEqual(out[0].title, "Hunger signals")
        XCTAssertEqual(out[0].fileIndexes, [0, 1])
        XCTAssertEqual(out[0].durationHours, 1)
        XCTAssertNil(out[0].setAside)
        XCTAssertEqual(out[0].moduleTitle, "Appetite")

        XCTAssertEqual(out[1].title, "Satiety")
        XCTAssertEqual(out[1].fileIndexes, [1, 2])
        XCTAssertEqual(out[1].durationHours, 2)
        XCTAssertNil(out[1].setAside)

        XCTAssertEqual(out[2].title, "Syllabus")
        XCTAssertEqual(out[2].fileIndexes, [3])
        XCTAssertEqual(out[2].durationHours, 1)
        XCTAssertEqual(out[2].setAside, "course outline")

        let out2 = lecturesFromSort(
            files,
            SortedFolder(
                lectures: [.init(title: "One", module: nil, files: ["misc/recording 1.vtt"])],
                setAside: []
            )
        )
        XCTAssertEqual(out2.filter { $0.setAside != nil }.map { $0.fileIndexes[0] }, [1, 2, 3])
        XCTAssertTrue(out2[1].setAside?.contains("didn't place") == true)
    }

    func testFilenameHelpers() {
        XCTAssertEqual(titleFromFilename("BIOL3010_Lecture_07_-_Lac_operon_slides.pdf"), "Lac operon")
        XCTAssertEqual(titleFromFilename("L1 transcript.vtt"), "")
        XCTAssertEqual(titleFromFilename("Week 3 - ECG fundamentals (1).pdf"), "ECG fundamentals")

        XCTAssertEqual(titleFromFilename("A1_Endocrine-Control-of-Metabolism_slides.pdf"), "Endocrine Control of Metabolism")
        XCTAssertEqual(titleFromFilename("Lecture 3 - X-ray imaging.pdf"), "X-ray imaging")
        XCTAssertEqual(titleFromFilename("Week 2 - Heart: valves & murmurs.pdf"), "Heart – valves & murmurs")
        XCTAssertEqual(titleFromFilename("A5_Appetite-and-Satiety-Part2_transcript.txt"), "Appetite and Satiety Part 2")

        XCTAssertEqual(stemOf("Gene regulation transcript.txt"), "gene regulation")
        XCTAssertEqual(stemOf("Gene_regulation_slides_v2.pdf"), "gene regulation")

        XCTAssertEqual(dateFromName("2026-03-04 lecture"), "2026-03-04")
        XCTAssertEqual(dateFromName("rec 20260304"), "2026-03-04")
        XCTAssertEqual(dateFromName("lecture 4.3.26"), "2026-03-04")
        XCTAssertNil(dateFromName("no date"))
    }
}
