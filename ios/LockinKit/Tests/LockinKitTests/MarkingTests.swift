import XCTest
@testable import LockinKit

final class MarkingTests: XCTestCase {
    private func template() throws -> MarkingTemplate {
        try XCTUnwrap(try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot")).marking)
    }

    private func question() throws -> Question {
        try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot")).lectures[0].questions[0]
    }

    func testFillsThePromptInOnePassAsTheComputerDoes() {
        XCTAssertEqual(fillPrompt("A {{x}} B {{missing}} C", ["x": "{{x}}"]), "A {{x}} B  C")
        XCTAssertEqual(fillPrompt("é {{name}}!", ["name": "Ünï"]), "é Ünï!")
    }

    func testBuildsTheComputersRequestWithTheAnswerInIt() throws {
        let template = try template()
        let prompt = markingPrompt(template, question: try question(), answer: "Gd-IgA1 \"quoted\"\nnext line")
        XCTAssertTrue(prompt.contains("## Answer\nGd-IgA1 \"quoted\"\nnext line"))
        XCTAssertTrue(prompt.contains("Explain how galactose-deficient IgA1"))
        let request = try markingRequest(template, prompt: prompt)
        XCTAssertEqual(request.url?.absoluteString, "https://api.anthropic.com/v1/messages")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-api-key"), "sk-test")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(body["max_tokens"] as? Int, 16000)
        let messages = try XCTUnwrap(body["messages"] as? [[String: Any]])
        let content = try XCTUnwrap(messages[0]["content"] as? [[String: Any]])
        XCTAssertEqual(content[0]["text"] as? String, prompt)
    }

    func testReadsAnthropicAndOpenAIReplies() throws {
        let anthropic = Data(#"{"content":[{"type":"text","text":"{\"mark\":7"},{"type":"text","text":",\"criteria\":[],\"gaps\":[]}"}],"stop_reason":"end_turn"}"#.utf8)
        XCTAssertEqual(try replyText(kind: "anthropic", label: "Anthropic API · m", status: 200, data: anthropic), #"{"mark":7,"criteria":[],"gaps":[]}"#)
        let openai = Data(#"{"choices":[{"message":{"content":"```json\n{\"mark\":5,\"criteria\":[],\"gaps\":[]}\n```"},"finish_reason":"stop"}]}"#.utf8)
        let text = try replyText(kind: "openai", label: "OpenAI · gpt", status: 200, data: openai)
        XCTAssertEqual(try decodeMarking(text).mark, 5)
        XCTAssertThrowsError(try replyText(kind: "anthropic", label: "Anthropic API · m", status: 401, data: Data(#"{"error":{"message":"invalid x-api-key"}}"#.utf8))) { error in
            XCTAssertTrue((error as? MarkingError)?.errorDescription?.contains("check the API key") == true)
        }
        XCTAssertThrowsError(try replyText(kind: "anthropic", label: "Anthropic API · m", status: 200, data: Data(#"{"content":[],"stop_reason":"max_tokens"}"#.utf8)))
    }

    func testFindsJSONInProseAndChecksTheMarking() throws {
        let marking = try decodeMarking("""
        Here you go:
        {"mark": 6.5, "criteria": [{"point": "Names Gd-IgA1", "awarded": 2, "outOf": 2, "note": null},
          {"point": "Mesangium", "awarded": 1, "outOf": 3, "note": "Only mentioned"}],
         "gaps": [{"conceptId": "c1", "type": "MISSED", "text": "Complexes deposit in the mesangium."}]}
        Thanks!
        """)
        XCTAssertEqual(marking.mark, 6.5)
        XCTAssertEqual(feedback(for: marking).map(\.kind), ["good", "missed", "note"])
        XCTAssertEqual(feedback(for: marking).last?.text, "Mesangium (1/3): Only mentioned")
        XCTAssertThrowsError(try decodeMarking(#"{"mark": 12, "criteria": [], "gaps": []}"#))
        XCTAssertThrowsError(try decodeMarking(#"{"mark": 5, "criteria": [], "gaps": [{"conceptId": "c", "type": "MAYBE", "text": "x"}]}"#))
        XCTAssertThrowsError(try decodeMarking("no json here"))
    }

    func testAsksAgainOnceWhenTheReplyCantBeRead() async throws {
        final class Replies: HTTPSending, @unchecked Sendable {
            var sent: [URLRequest] = []
            var replies: [String]
            init(_ replies: [String]) { self.replies = replies }
            func send(_ request: URLRequest) async throws -> (Data, Int) {
                sent.append(request)
                let text = replies.removeFirst()
                let body = ["content": [["type": "text", "text": text]], "stop_reason": "end_turn"] as [String: Any]
                return (try JSONSerialization.data(withJSONObject: body), 200)
            }
        }
        let replies = Replies(["I think it deserves a 7.", #"{"mark":7,"criteria":[],"gaps":[]}"#])
        let marking = try await markAnswer("An answer", question: try question(), template: try template(), sender: replies)
        XCTAssertEqual(marking.mark, 7)
        XCTAssertEqual(replies.sent.count, 2)
        let second = String(data: try XCTUnwrap(replies.sent[1].httpBody), encoding: .utf8) ?? ""
        XCTAssertTrue(second.contains("Your previous reply could not be used"))
    }

    func testScoresLikeTheComputer() {
        XCTAssertEqual(geometricMean([4, 9])!, 6, accuracy: 1e-9)
        XCTAssertEqual(geometricMean([7, 0, 9]), 0)
        XCTAssertNil(geometricMean([]))
        XCTAssertEqual(formatMark(7), "7")
        XCTAssertEqual(formatMark(6.5), "6.5")
    }
}
