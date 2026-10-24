import XCTest
@testable import LockinCore

final class PasteTests: XCTestCase {
    func testParseSummaryTakesTitleFromLeadingHeadingAndDropsChatFiller() {
        let out = parseSummary(
            "Here's a summary of the lecture:\n\n# The lac operon & CAP\n\n## Structure\nThree genes.\n\nLet me know if you'd like flashcards!"
        )
        XCTAssertEqual(out.title, "The lac operon & CAP")
        XCTAssertEqual(out.markdown, "## Structure\nThree genes.")
    }

    func testParseSummaryStripsSummaryStylePrefixesFromTitle() {
        XCTAssertEqual(parseSummary("# Summary: Cardiac cycle\n\nbody").title, "Cardiac cycle")
        XCTAssertEqual(parseSummary("# Lecture 4: Cardiac cycle\n\nbody").title, "Cardiac cycle")
    }

    func testParseSummaryKeepsPlainTextWhenNoHeading() {
        XCTAssertEqual(
            parseSummary("The operon is induced by allolactose."),
            ParsedSummary(title: nil, markdown: "The operon is induced by allolactose.")
        )
    }

    func testParseLaqsReadsCopyPasteFormat() {
        let text = """
        Sure! Here are your long-answer questions.

        ### LAQ 1 (10 marks)
        Explain how the lac operon responds when glucose is absent and lactose is present.

        **Marking guide**
        - Repressor released by allolactose (2 marks)
        - cAMP high, CAP bound upstream (3 marks)
        - Full transcription of lacZYA [3]
        - Correct link to diauxic growth — 2 marks

        **Model answer**
        With lactose present, allolactose binds the repressor…

        ### LAQ 2 (10 marks)
        Compare inducible and repressible operons using lac and trp.

        **Marking guide**
        - Default states differ (5 marks)
        - Effector roles (5 marks)

        **Model answer**
        Lac is off by default…
        """
        let out = parseLaqs(text)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].number, 1)
        XCTAssertEqual(out[0].marks, 10)
        XCTAssertEqual(out[0].stem, "Explain how the lac operon responds when glucose is absent and lactose is present.")
        XCTAssertEqual(
            out[0].criteria,
            [
                ParsedCriterion(point: "Repressor released by allolactose", marks: 2),
                ParsedCriterion(point: "cAMP high, CAP bound upstream", marks: 3),
                ParsedCriterion(point: "Full transcription of lacZYA", marks: 3),
                ParsedCriterion(point: "Correct link to diauxic growth", marks: 2),
            ]
        )
        XCTAssertEqual(out[0].modelAnswer, "With lactose present, allolactose binds the repressor…")
        XCTAssertEqual(out[1].criteria.count, 2)
    }

    func testParseLaqsAcceptsQuestionOnHeaderLineItself() {
        let out = parseLaqs("**Question 1:** Describe CAP.\n\n**Question 2:** Explain the trp operon.")
        XCTAssertEqual(out.map(\.stem), ["Describe CAP.", "Explain the trp operon."])
    }

    func testParseLaqsTurnsHeaderTopicIntoBoldTitleOverQuestion() {
        let out = parseLaqs("## LAQ 1 — Cardiac output\nExplain how preload affects stroke volume.")
        XCTAssertEqual(out[0].stem, "**Cardiac output**\n\nExplain how preload affects stroke volume.")
    }

    func testParseLaqsFallsBackToNumberedList() {
        let out = parseLaqs("1. Explain diauxie.\n2. Compare lac and trp.\n   - point one")
        XCTAssertEqual(out.map(\.number), [1, 2])
        XCTAssertTrue(out[1].stem.contains("Compare lac and trp."))
    }

    func testParseLaqsDoesNotMistakeAnswerTheFollowingForAnswerSection() {
        let out = parseLaqs("LAQ 1\nAnswer the following with reference to the lac operon.\nModel answer: Allolactose…")
        XCTAssertEqual(out[0].stem, "Answer the following with reference to the lac operon.")
        XCTAssertEqual(out[0].modelAnswer, "Allolactose…")
    }

    func testParseLaqsTreatsUnstructuredTextAsSingleQuestion() {
        XCTAssertEqual(
            parseLaqs("Explain the lac operon."),
            [ParsedLaq(number: 1, stem: "Explain the lac operon.", marks: nil, criteria: [], modelAnswer: nil)]
        )
    }

    func testParseScoresReadsMarkingPromptFormat() {
        let text = """
        Here's how you did:

        LAQ 1: 7/10
        - Good: Correctly named allolactose as the inducer
        - Missed: cAMP–CAP is needed for full expression
        - Wrong: The repressor binds the promoter, not the operator

        LAQ 2: 4/10
        - Missed: Trp acts as a corepressor

        Overall geometric mean: 5.29/10
        """
        let out = parseScores(text)
        XCTAssertEqual(out.map(\.number), [1, 2])
        XCTAssertEqual(out.map(\.mark), [7, 4])
        XCTAssertEqual(
            out[0].feedback,
            [
                ParsedFeedback(kind: .good, text: "Correctly named allolactose as the inducer"),
                ParsedFeedback(kind: .missed, text: "cAMP–CAP is needed for full expression"),
                ParsedFeedback(kind: .wrong, text: "The repressor binds the promoter, not the operator"),
            ]
        )
    }

    func testParseScoresNormalisesOtherScalesAndReadsScoreOnOwnLine() {
        let out = parseScores("### Question 1\n**Score:** 14/20\n\n**Missed:**\n- CAP\n- cAMP\n\n### Question 2\nMark: 3 out of 5")
        XCTAssertEqual(out.map(\.mark), [7, 6])
        XCTAssertEqual(out[0].raw, "14/20")
        XCTAssertEqual(
            out[0].feedback,
            [
                ParsedFeedback(kind: .missed, text: "CAP"),
                ParsedFeedback(kind: .missed, text: "cAMP"),
            ]
        )
    }

    func testParseScoresAcceptsTerseList() {
        XCTAssertEqual(parseScores("1. 8/10\n2) 5.5/10\nQ3 - 9/10").map(\.mark), [8, 5.5, 9])
    }

    func testParseScoresIgnoresTotalsAndUnrelatedText() {
        XCTAssertEqual(parseScores("Total: 15/20"), [])
        XCTAssertEqual(parseScores("great job overall"), [])
    }
}
