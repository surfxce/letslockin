import Foundation
import GRDB
import XCTest
@testable import LockinCore

final class SummaryEditAndAskTests: XCTestCase {
    private let sampleMd = """
    ## Fed state

    After a meal, **insulin** rises.

    - Liver: glycogen synthesis
      - GLUT2 lets glucose in
    - Muscle: GLUT4 translocation

    ### Adipose

    LPL releases fatty acids.

    ## Fasting

    Glucagon rises.

    ```
    ## not a heading
    ```

    """

    // MARK: - Headings (lib/summary-edit.test.ts)

    func testListsHeadingsAsAReaderSeesThemSkippingCode() {
        XCTAssertEqual(summaryHeadings(sampleMd), ["Fed state", "Adipose", "Fasting"])
        XCTAssertEqual(summaryHeadings("## The **lac** operon\n\n# `cAMP` & CAP"), ["The lac operon", "cAMP & CAP"])
    }

    func testMatchesAModelsHeadingDespiteCaseOrMarkup() {
        XCTAssertEqual(matchHeading(sampleMd, "fed STATE"), "Fed state")
        XCTAssertEqual(matchHeading(sampleMd, "**Fasting**"), "Fasting")
        XCTAssertNil(matchHeading(sampleMd, "Something else"))
        XCTAssertNil(matchHeading(sampleMd, nil))
    }

    func testReducesInlineMarkupToWords() {
        XCTAssertEqual(plainInline("**Insulin** _rises_ after [meals](x) `fast`"), "Insulin rises after meals fast")
        XCTAssertEqual(plainInline("snake_case_name stays"), "snake_case_name stays")
    }

    // MARK: - insertIntoSection & insertAtStart

    func testInsertIntoSectionFilesBlockAtEndOfSectionBeforeNextHeadingAtItsLevel() {
        let out = insertIntoSection(sampleMd, "Fed state", "**Why?**\n\nBecause.")
        XCTAssertTrue(out.contains("LPL releases fatty acids.\n\n**Why?**\n\nBecause.\n\n## Fasting"))
    }

    func testInsertIntoSectionEndsASubsectionAtNextHeadingOfAnyLevelUp() {
        let out = insertIntoSection(sampleMd, "Adipose", "More fat.")
        XCTAssertTrue(out.contains("LPL releases fatty acids.\n\nMore fat.\n\n## Fasting"))
    }

    func testInsertIntoSectionAppendsAtEndWhenSectionUnknownOrNotGiven() {
        XCTAssertEqual(insertIntoSection("## A\n\nText.\n", nil, "New."), "## A\n\nText.\n\nNew.\n")
        XCTAssertEqual(insertIntoSection("## A\n\nText.", "Nope", "New."), "## A\n\nText.\n\nNew.\n")
        XCTAssertEqual(insertIntoSection("", nil, "New."), "New.\n")
        XCTAssertEqual(
            insertIntoSection("## A\n\nOne.\n\n## B\n\nTwo.\n", "B", "Three."),
            "## A\n\nOne.\n\n## B\n\nTwo.\n\nThree.\n"
        )
    }

    func testInsertAtStartGoesAfterTitleHeadingElseFirst() {
        XCTAssertEqual(insertAtStart("# Title\n\nBody.", "Aims."), "# Title\n\nAims.\n\nBody.\n")
        XCTAssertEqual(insertAtStart("## Part\n\nBody.", "Aims."), "Aims.\n\n## Part\n\nBody.\n")
    }

    // MARK: - insertUnder, asChildPoints, formatAnswer, addLeftOut

    func testInsertUnderNestsBreakdownUnderDotPointAndHandlesMarkdownAndNumberedLists() {
        let out = insertUnder(sampleMd, "Liver: glycogen", "Glycogen is stored glucose.")
        XCTAssertTrue(
            out.contains("- Liver: glycogen synthesis\n  - GLUT2 lets glucose in\n  - Glycogen is stored glucose.\n- Muscle")
        )

        let boldMatch = insertUnder(sampleMd, "insulin rises", "It's released by beta cells.")
        XCTAssertTrue(
            boldMatch.contains("After a meal, **insulin** rises.\n\nIt's released by beta cells.\n\n- Liver")
        )

        XCTAssertEqual(
            insertUnder("- A\n- B\n", "A", "- one\n  - two"),
            "- A\n  - one\n    - two\n- B\n"
        )
        XCTAssertEqual(
            insertUnder("1. First\n2. Second", "First", "More."),
            "1. First\n   - More.\n2. Second"
        )
        XCTAssertTrue(
            insertUnder(sampleMd, "Glucagon rises. And then much more text that is not there", "x")
                .contains("Glucagon rises.\n\nx\n\n```")
        )
        XCTAssertEqual(insertUnder("Para.", "missing words", "x"), "Para.\n\nx\n")
        XCTAssertEqual(
            insertUnder("## Fasting\n\nGlucagon.", "Fasting", "x"),
            "## Fasting\n\nx\n\nGlucagon.\n"
        )
    }

    func testAsChildPointsAndFormatAnswerAndAddLeftOut() {
        XCTAssertEqual(asChildPoints("One line\nwrapped.\n\nTwo.", 2), "  - One line wrapped.\n  - Two.")
        XCTAssertEqual(formatAnswer(" Why  **does** it rise? ", "Because.\n"), "**Why does it rise?**\n\nBecause.")
        XCTAssertEqual(
            addLeftOut("## A\n\nBody.", "Module 3 aims", "- Explain X"),
            "## Module 3 aims\n\n- Explain X\n\n## A\n\nBody.\n"
        )
        XCTAssertEqual(
            addLeftOut("## A\n\nBody.", "Assessment dates", "Exam in week 13."),
            "## A\n\nBody.\n\n## Assessment dates\n\nExam in week 13.\n"
        )
    }

    // MARK: - Line Tools

    func testLineToolsSetLineKindAndShiftLines() {
        let text = "Alpha\nBeta\n\nGamma"
        let r = setLineKind(text, 2, 8, .bullet2)
        XCTAssertEqual(r.text, "  - Alpha\n  - Beta\n\nGamma")
        XCTAssertEqual(r.text.utf16Slice(r.start, r.end), "  - Alpha\n  - Beta")

        XCTAssertEqual(setLineKind("- Alpha", 0, 0, .h2).text, "## Alpha")
        XCTAssertEqual(setLineKind("## Alpha", 3, 3, .bullet3).text, "    - Alpha")
        XCTAssertEqual(setLineKind("    - Alpha", 0, 11, .text).text, "Alpha")
        XCTAssertEqual(setLineKind("1. Alpha", 0, 0, .bullet1).text, "- Alpha")
        XCTAssertEqual(setLineKind("A\nB", 0, 2, .bullet1).text, "- A\nB")

        let shifted = shiftLines("- A\n- B\nText", 0, 7, 1)
        XCTAssertEqual(shifted.text, "  - A\n  - B\nText")
        XCTAssertEqual(shiftLines(shifted.text, shifted.start, shifted.end, -1).text, "- A\n- B\nText")
        XCTAssertEqual(shiftLines("- A", 3, 3, 1), LineEditResult(text: "  - A", start: 5, end: 5))
        XCTAssertEqual(shiftLines("- A", 0, 0, -1).text, "- A")
    }

    // MARK: - AskHistory (lib/ask-history.test.ts)

    func testMergeHistoryChosenSectionFormatWaitAndDraftKeys() {
        func makeItem(_ id: String, _ q: String, _ a: String, _ at: String) -> AskHistoryItem {
            AskHistoryItem(id: id, question: q, answer: a, section: nil, at: at)
        }

        let saved = [makeItem("a", "What is GLUT4?", "A transporter.", "2026-10-13T10:00:00Z")]
        let session = [makeItem("s1", "Why insulin?", "Because.", "2026-10-14T09:00:00Z")]
        XCTAssertEqual(mergeHistory([session, saved]).map(\.id), ["s1", "a"])

        let sDup = [makeItem("s1", "Why  insulin?", "Because.\n", "2026-10-14T09:00:00Z")]
        let jobDup = [makeItem("job1", "Why insulin?", "Because.", "2026-10-14T09:00:02Z")]
        let deduped = mergeHistory([sDup, jobDup])
        XCTAssertEqual(deduped.map(\.id), ["s1"])

        let two = [makeItem("a", "Q1", "A1", "2026-10-13T10:00:00Z"), makeItem("b", "Q2", "A2", "2026-10-12T10:00:00Z")]
        XCTAssertEqual(mergeHistory([two], showing: (question: " Q1", answer: "A1 ")).map(\.id), ["b"])

        let headings = ["Insulin", "Glucagon secretion", "Summary"]
        XCTAssertEqual(chosenSection(headings, suggested: "Insulin"), "Insulin")
        XCTAssertEqual(chosenSection(headings, suggested: "glucagon  Secretion"), "Glucagon secretion")
        XCTAssertEqual(chosenSection(headings, suggested: nil), endOfSummary)
        XCTAssertEqual(chosenSection(headings, suggested: "Not a heading"), endOfSummary)
        XCTAssertEqual(chosenSection([], suggested: "Insulin"), endOfSummary)
        XCTAssertEqual(chosenSection(headings, suggested: "Insulin", picked: "Summary"), "Summary")
        XCTAssertEqual(chosenSection(headings, suggested: "Insulin", picked: endOfSummary), endOfSummary)
        XCTAssertEqual(chosenSection(headings, suggested: "Insulin", picked: "Removed heading"), "Insulin")

        XCTAssertEqual(formatWait(-50), "0s")
        XCTAssertEqual(formatWait(12_400), "12s")
        XCTAssertEqual(formatWait(65_000), "1m 05s")
        XCTAssertEqual(formatWait(600_000), "10m 00s")
        XCTAssertEqual(askDraftKey("abc"), "lockin.askDraft.abc")
        XCTAssertEqual(askPasteKey("abc"), "lockin.askPaste.abc")
    }
}
