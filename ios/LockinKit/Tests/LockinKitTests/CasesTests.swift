import XCTest
@testable import LockinKit

final class CasesTests: XCTestCase {
    func testRunsACaseStageByStage() throws {
        let snapshot = try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot"))
        let found = try XCTUnwrap(snapshot.cases?.first)
        XCTAssertEqual(found.stages.map(\.kind), ["history", "diagnosis"])
        XCTAssertFalse(snapshot.lectures.flatMap(\.questions).contains { $0.id == found.stages[0].question.id }, "a stage isn't one of its lecture's questions")

        var run = try XCTUnwrap(found.makeRun())
        XCTAssertEqual(run.caseId, found.id)
        XCTAssertEqual(run.title, "Cola-coloured urine after a sore throat")
        XCTAssertEqual(run.turns.first?.text, "\(found.presentation)\n\nWhat would you ask him?")
        XCTAssertEqual(run.step?.kind, "history")
        XCTAssertEqual(stageLabel(run.step?.kind ?? ""), "History")

        XCTAssertTrue(run.answer("When it started, and whether it happened before."))
        run.examiner(VivaMove(move: "next", say: "Okay, thank you."), stem: { _ in nil })
        XCTAssertEqual(run.turns.suffix(3).map(\.text), ["Okay, thank you.", "It has happened twice before, each time with a cold.", "What's the most likely diagnosis?"])
        XCTAssertEqual(run.turns.suffix(2).first?.questionId, found.stages[0].question.id, "the findings close their own stage")
        XCTAssertEqual(run.step?.kind, "diagnosis")

        run.moveOn(closing: "Alright, let's move on.", stem: { _ in nil })
        XCTAssertTrue(run.isOver)
        XCTAssertEqual(run.turns.last?.text, "That's the end of the case. Thank you — your answers will be marked.")
        XCTAssertTrue(run.turns.contains { $0.text == "Biopsy shows mesangial IgA deposits: IgA nephropathy." }, "a skipped stage still tells what it found")

        let handed = run.handIn()
        XCTAssertEqual(handed.caseId, found.id)
        let answers = handed.sittings.flatMap(\.responses)
        XCTAssertEqual(answers.count, 2)
        XCTAssertTrue(answers[0].answerText.hasSuffix("Student: When it started, and whether it happened before."), "the findings aren't part of the answer")
        XCTAssertEqual(answers[1].answerText, "", "not answered, so it scores 0")
    }

    func testAPlainVivaIsUnchanged() throws {
        let snapshot = try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot"))
        let q = snapshot.lectures[0].questions[0]
        var viva = VivaDraft(id: "v1", title: "T", startedAt: Date(), plan: [VivaPlanItem(questionId: q.id, lectureId: snapshot.lectures[0].id)],
                             turns: [VivaLine(role: "examiner", text: "Let's begin.", questionId: q.id, at: Date())], current: 0, probes: 0)
        XCTAssertNil(viva.step)
        viva.moveOn(closing: "Okay.", stem: { _ in nil })
        XCTAssertEqual(viva.turns.last?.text, "That's the end of the viva. Thank you — your answers will be marked.")
        XCTAssertNil(viva.handIn().caseId)
    }
}
