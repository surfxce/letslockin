import XCTest
@testable import LockinKit

final class VivaTests: XCTestCase {
    private func source() throws -> (Snapshot, ExamSource) {
        let snapshot = try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot"))
        return (snapshot, ExamSource(snapshot: snapshot, localSittings: [], pastExams: []))
    }

    func testHoldsAVivaAndHandsItIn() throws {
        let (snapshot, source) = try source()
        let lecture = snapshot.lectures[0]
        var g = SeededGenerator(state: 5)
        var viva = try XCTUnwrap(source.makeViva(lectureIds: [lecture.id], questions: 3, focus: .mixed, using: &g))
        XCTAssertEqual(viva.plan.count, 1, "only as many as there are")
        XCTAssertTrue(viva.turns[0].text.hasPrefix("Let's begin. Explain"))
        XCTAssertNil(source.makeViva(lectureIds: [snapshot.lectures[1].id], questions: 3, focus: .mixed, using: &g), "a lecture with no LAQs")

        let stem = { (id: String) in snapshot.lectures.flatMap(\.questions).first { $0.id == id }?.stem }
        XCTAssertFalse(viva.answer("   "))
        XCTAssertTrue(viva.answer("Deposits."))
        viva.examiner(VivaMove(move: "probe", say: "Where exactly?"), stem: stem)
        XCTAssertEqual(viva.probes, 1)
        XCTAssertEqual(viva.probesLeft, vivaMaxProbes - 1)
        viva.answer("In the mesangium.")
        viva.examiner(VivaMove(move: "probe", say: "And then?"), stem: stem)
        viva.answer("Inflammation.")
        // Out of follow-ups: a probe now closes the question instead.
        viva.examiner(VivaMove(move: "probe", say: "Okay, thank you."), stem: stem)
        XCTAssertTrue(viva.isOver)
        XCTAssertEqual(viva.turns.last?.questionId, "", "the closing line belongs to no question")

        let handed = viva.handIn()
        XCTAssertEqual(handed.sittings.count, 1)
        let response = try XCTUnwrap(handed.sittings[0].responses.first)
        XCTAssertEqual(handed.plan[0].responseId, response.id)
        XCTAssertTrue(response.answerText.hasPrefix("(Answered out loud in a viva."))
        XCTAssertTrue(response.answerText.hasSuffix("Student: Deposits.\n\nExaminer: Where exactly?\n\nStudent: In the mesangium.\n\nExaminer: And then?\n\nStudent: Inflammation."))
    }

    func testEndingEarlyAndSkipping() throws {
        let (snapshot, _) = try source()
        let q = snapshot.lectures[0].questions[0]
        var viva = VivaDraft(id: "v1", title: "T", startedAt: Date(), plan: [VivaPlanItem(questionId: q.id, lectureId: snapshot.lectures[0].id),
                                                                              VivaPlanItem(questionId: "gone", lectureId: snapshot.lectures[0].id)],
                             turns: [VivaLine(role: "examiner", text: "Let's begin.", questionId: q.id, at: Date())], current: 0, probes: 0)
        viva.moveOn(closing: "Alright, let's move on.", stem: { _ in nil })
        XCTAssertEqual(viva.current, 1)
        XCTAssertTrue(viva.turns.last!.text.contains("no longer on the computer"))
        viva.end()
        XCTAssertTrue(viva.isOver)
        XCTAssertEqual(viva.plan.count, 2)
        let handed = viva.handIn()
        XCTAssertEqual(handed.sittings[0].responses.map(\.answerText), ["", ""], "asked and not answered goes in blank")
        XCTAssertEqual(vivaAnswerText([VivaLine(role: "examiner", text: "Q?", questionId: "q", at: Date())]), "")
    }

    func testAsksTheExaminerWithTheApiKey() async throws {
        final class Replies: HTTPSending, @unchecked Sendable {
            var sent: [URLRequest] = []
            var replies: [String]
            init(_ replies: [String]) { self.replies = replies }
            func send(_ request: URLRequest) async throws -> (Data, Int) {
                sent.append(request)
                let body = ["content": [["type": "text", "text": replies.removeFirst()]], "stop_reason": "end_turn"] as [String: Any]
                return (try JSONSerialization.data(withJSONObject: body), 200)
            }
        }
        let (snapshot, _) = try source()
        var template = try XCTUnwrap(snapshot.marking)
        template.prompt = "Q: {{question}}\nCriteria:\n{{criteria}}\n{{exchange}}\nLeft: {{probesLeft}}"
        let question = snapshot.lectures[0].questions[0]
        let exchange = [VivaLine(role: "examiner", text: "Explain it.", questionId: question.id, at: Date()),
                        VivaLine(role: "student", text: "Deposits.", questionId: question.id, at: Date())]
        let prompt = vivaPrompt(template, lectureTitle: "IgA", question: question, exchange: exchange, probesLeft: 2)
        XCTAssertTrue(prompt.contains("- (2) Names Gd-IgA1"))
        XCTAssertTrue(prompt.contains("Examiner: Explain it.\n\nStudent: Deposits."))
        XCTAssertTrue(prompt.hasSuffix("Left: 2"))

        let replies = Replies(["Let me think.", #"{"move":"probe","say":"Where is it deposited?"}"#])
        let move = try await askExaminer(template: template, lectureTitle: "IgA", question: question, exchange: exchange, probesLeft: 2, sender: replies)
        XCTAssertEqual(move, VivaMove(move: "probe", say: "Where is it deposited?"))
        XCTAssertEqual(replies.sent.count, 2, "an unreadable reply is asked again once")
        XCTAssertThrowsError(try decodeVivaMove(#"{"move":"wander","say":"Hi"}"#))
    }
}
