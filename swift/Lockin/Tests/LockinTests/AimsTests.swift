import XCTest
@testable import LockinCore

final class AimsTests: XCTestCase {
    func testIsAimsSectionRecognisesLabelsCoursesActuallyUse() {
        XCTAssertTrue(isAimsSection("Module 3 aims\n• Describe gene regulation"))
        XCTAssertTrue(isAimsSection("Learning objectives"))
        XCTAssertTrue(isAimsSection("Intended Learning Outcomes: students will…"))
        XCTAssertTrue(isAimsSection("Week 2 objectives - explain the cardiac cycle"))
        XCTAssertTrue(isAimsSection("Today's outcomes"))
        XCTAssertTrue(isAimsSection("Aims and objectives • Outline the lac operon"))
    }

    func testIsAimsSectionHandlesPptxTextWhereHeadingRunsIntoBody() {
        XCTAssertTrue(
            isAimsSection("Learning objectives By the end of this lecture you should be able to explain X")
        )
        XCTAssertTrue(isAimsSection("By the end of this lecture you should be able to: describe Y"))
    }

    func testIsAimsSectionOnlyDropsBareAimsSlideWhenItReadsLikeListOfAims() {
        XCTAssertTrue(isAimsSection("Aims\n• Describe the lac operon\n• Explain CAP"))
        // An experiment's aim is lecture content, not module boilerplate.
        XCTAssertFalse(isAimsSection("Aim: to test whether lactose induces lacZ in E. coli"))
    }

    func testIsAimsSectionKeepsContentThatMerelyStartsWithSameWord() {
        XCTAssertFalse(isAimsSection("Objectives of antibiotic therapy: eradicate the organism"))
        XCTAssertFalse(isAimsSection("Outcome measures in randomised trials"))
        XCTAssertFalse(isAimsSection("Module 3: Gene expression"))
        XCTAssertFalse(isAimsSection("The lac operon has three structural genes"))
    }

    func testStripAimsDropsAimsSlidesAndReportsWhereTheyWere() {
        let deck = [
            "--- Slide 1 ---\nBIOL3010 Genetics",
            "--- Slide 2 ---\nModule 3 aims • Describe prokaryotic gene regulation • Explain operons",
            "--- Slide 3 ---\nLearning objectives By the end of this lecture you should be able to explain CAP",
            "--- Slide 4 ---\nThe lac operon: lacZ, lacY, lacA",
        ].joined(separator: "\n\n")

        let (text, skipped) = stripAims(deck)
        XCTAssertTrue(text.contains("Slide 1"))
        XCTAssertTrue(text.contains("The lac operon"))
        XCTAssertFalse(text.contains("Module 3 aims"))
        XCTAssertFalse(text.contains("Learning objectives"))
        XCTAssertEqual(
            skipped,
            [
                Skipped(
                    what: "Module 3 aims",
                    where: "slide 2",
                    about: "Module 3 aims • Describe prokaryotic gene regulation • Explain operons"
                ),
                Skipped(
                    what: "Learning objectives",
                    where: "slide 3",
                    about: "Learning objectives By the end of this lecture you should be able to explain CAP"
                ),
            ]
        )
    }

    func testStripAimsWorksOnPdfPagesAndExportedSlideNotes() {
        XCTAssertEqual(
            stripAims("--- Page 1 ---\nLearning outcomes\n\n--- Page 2 ---\nContent").skipped,
            [Skipped(what: "Learning outcomes", where: "page 1", about: "Learning outcomes")]
        )
        XCTAssertEqual(
            stripAims("Slide 1: Learning objectives\nSlide 2: Allolactose").text,
            "Slide 2: Allolactose"
        )
    }

    func testStripAimsDropsMarkdownAimsSectionUpToNextHeadingOfSameLevel() {
        let md = "# Lac operon\nintro\n## Learning objectives\n- explain X\n### detail\nmore\n## Regulation\nbody"
        let (text, skipped) = stripAims(md)
        XCTAssertEqual(text, "# Lac operon\nintro\n## Regulation\nbody")
        XCTAssertEqual(
            skipped,
            [Skipped(what: "Learning objectives", where: "section", about: "- explain X\n### detail\nmore")]
        )
    }

    func testStripAimsLeavesTextWithNoStructureAlone() {
        let transcript = "[00:00] So the aims of this module are to understand operons"
        let res = stripAims(transcript)
        XCTAssertEqual(res.text, transcript)
        XCTAssertEqual(res.skipped, [])
    }

    func testMergeSkippedFoldsRepeatsOfSameLabelIntoOneEntry() {
        XCTAssertEqual(
            mergeSkipped([
                Skipped(what: "Module aims", where: "slide 2"),
                Skipped(what: "Module aims", where: "slide 3"),
            ]),
            [Skipped(what: "Module aims", where: "slides 2, 3")]
        )
    }
}
