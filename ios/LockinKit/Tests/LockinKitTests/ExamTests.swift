import XCTest
@testable import LockinKit

/// A repeatable stand-in for the system's random numbers.
struct SeededGenerator: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return state
    }
}

final class ExamTests: XCTestCase {
    private func item(_ id: String, _ lecture: String, seen: Int = 0, mark: Double? = nil) -> ExamCandidate {
        ExamCandidate(id: id, lectureId: lecture, seen: seen, lastMark: mark)
    }

    func testSpreadsAcrossLecturesBeforeTakingSeconds() {
        let pool = [item("a1", "A"), item("a2", "A"), item("a3", "A"), item("b1", "B"), item("b2", "B"), item("c1", "C")]
        for seed in 1...10 {
            var g = SeededGenerator(state: UInt64(seed))
            let three = pickExamItems(pool, count: 3, focus: .mixed, using: &g)
            XCTAssertEqual(Set(three.map { String($0.prefix(1)) }), ["a", "b", "c"])
        }
        var g = SeededGenerator(state: 3)
        XCTAssertEqual(pickExamItems(pool, count: 50, focus: .mixed, using: &g).count, 6)
        XCTAssertEqual(pickExamItems([], count: 4, focus: .weak, using: &g), [])
    }

    func testUnseenFirstAndFailedBackFirstWhenWeak() {
        let seen = [item("x1", "X", seen: 3, mark: 9), item("x2", "X"), item("x3", "X", seen: 1, mark: 4)]
        for seed in 1...10 {
            var g = SeededGenerator(state: UInt64(seed))
            XCTAssertEqual(pickExamItems(seen, count: 1, focus: .mixed, using: &g), ["x2"])
            XCTAssertEqual(pickExamItems(seen, count: 3, focus: .weak, using: &g), ["x3", "x2", "x1"])
        }
    }

    func testSuggestedMinutes() {
        XCTAssertEqual(suggestedExamMinutes(mcqs: 10, laqs: 4), 75)
        XCTAssertEqual(suggestedExamMinutes(mcqs: 1, laqs: 0), 5)
    }

    func testSetsSitsAndHandsInAnExam() throws {
        var snapshot = try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot"))
        let lecture = snapshot.lectures[0]
        let mcq = try XCTUnwrap(snapshot.mcqs?.first)
        // A past-paper question is never set.
        var paper = lecture.questions[0]
        paper.id = "paper-question-1"
        paper.fromPaper = true
        snapshot.lectures[0].questions.append(paper)

        let source = ExamSource(snapshot: snapshot, localSittings: [], pastExams: [])
        var g = SeededGenerator(state: 7)
        var draft = try XCTUnwrap(source.makeExam(lectureIds: Set(snapshot.lectures.map(\.id)), mcqs: 5, laqs: 10, focus: .mixed, timeLimitMin: 30, using: &g))
        XCTAssertEqual(draft.items.first?.kind, "MCQ", "multiple choice first")
        XCTAssertEqual(draft.mcqs.compactMap(\.mcqId), [mcq.id])
        XCTAssertFalse(draft.laqs.contains { $0.questionId == "paper-question-1" })
        XCTAssertEqual(draft.laqs.count, snapshot.lectures.flatMap(\.questions).filter { $0.fromPaper != true }.count)
        XCTAssertEqual(draft.unanswered.mcqs, 1)

        draft.items[0].choice = mcq.answer
        draft.items[1].answer = "  Gd-IgA1 deposits.  "
        let exam = draft.handIn()
        XCTAssertEqual(exam.mcqScore(snapshot.mcqs ?? []).right, 1)
        XCTAssertEqual(exam.sittings.count, Set(draft.laqs.map(\.lectureId)).count, "a sitting per lecture")
        let laqItem = try XCTUnwrap(exam.items.first { $0.kind == "LAQ" && $0.questionId == draft.items[1].questionId })
        let response = try XCTUnwrap(exam.sittings.flatMap(\.responses).first { $0.id == laqItem.responseId })
        XCTAssertEqual(response.answerText, "Gd-IgA1 deposits.")

        // Sat once, that MCQ is no longer unseen; got right, weak focus asks it last.
        let again = ExamSource(snapshot: snapshot, localSittings: exam.sittings, pastExams: [exam])
        var g2 = SeededGenerator(state: 9)
        XCTAssertNotNil(again.makeExam(lectureIds: [lecture.id], mcqs: 1, laqs: 0, focus: .weak, timeLimitMin: nil, using: &g2))
        XCTAssertNil(source.makeExam(lectureIds: [], mcqs: 5, laqs: 5, focus: .mixed, timeLimitMin: nil, using: &g2))
    }
}
