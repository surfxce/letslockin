import XCTest
@testable import LockinKit

final class HandwritingTests: XCTestCase {
    private func template(kind: String) throws -> MarkingTemplate {
        let snapshot = try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot"))
        var template = try XCTUnwrap(snapshot.marking)
        template.kind = kind
        template.prompt = "Pages: {{pages}}\nQuestion: {{question}}"
        if kind == "openai" {
            template.request.body = .object(["model": .string("gemini"), "messages": .array([.object(["role": .string("user"), "content": .string(promptSlot)])])])
        }
        return template
    }

    func testPhotosGoBeforeThePromptForClaude() throws {
        let t = try template(kind: "anthropic")
        let photo = Data([0xFF, 0xD8, 0xFF, 0x01])
        let body = handwritingBody(t, prompt: "Read it.", photos: [photo, photo])
        let content = try XCTUnwrap(body["messages"]?.arrayValue?.first?["content"]?.arrayValue)
        XCTAssertEqual(content.compactMap { $0["type"]?.stringValue }, ["image", "image", "text"])
        XCTAssertEqual(content[0]["source"]?["media_type"]?.stringValue, "image/jpeg")
        XCTAssertEqual(content[0]["source"]?["data"]?.stringValue, photo.base64EncodedString())
        XCTAssertEqual(content[2]["text"]?.stringValue, "Read it.")
        XCTAssertEqual(body["model"], t.request.body["model"], "the rest of the request is the template's")
    }

    func testPhotosGoAfterThePromptForOthers() throws {
        let body = handwritingBody(try template(kind: "openai"), prompt: "Read it.", photos: [Data([1, 2, 3])])
        let content = try XCTUnwrap(body["messages"]?.arrayValue?.first?["content"]?.arrayValue)
        XCTAssertEqual(content.compactMap { $0["type"]?.stringValue }, ["text", "image_url"])
        XCTAssertEqual(content[1]["image_url"]?["url"]?.stringValue, "data:image/jpeg;base64,AQID")
    }

    func testPromptAndReply() throws {
        let prompt = handwritingPrompt(try template(kind: "anthropic"), question: "Explain IgA nephropathy.", pages: 2)
        XCTAssertTrue(prompt.hasPrefix("Pages: 2\nQuestion: Explain IgA nephropathy."))
        XCTAssertTrue(prompt.hasSuffix("The 2 photos are attached, in page order. Read every one before replying."))

        let read = try decodeHandwriting("```json\n{\"text\": \"IgA1 deposits\\r\\nin mesangium \", \"unclear\": [\"IgA1\", \"glomerulus\", \"IgA1\"]}\n```")
        XCTAssertEqual(read.text, "IgA1 deposits\nin mesangium")
        XCTAssertEqual(read.unclear, ["IgA1"], "only words that are in it, once")
        XCTAssertEqual(try decodeHandwriting(#"{"text":"Nothing unsure"}"#).unclear, [])
        XCTAssertThrowsError(try decodeHandwriting(#"{"words":"no"}"#))

        XCTAssertEqual(withHandwriting("", "Typed"), "Typed")
        XCTAssertEqual(withHandwriting("Already here\n\n", "Typed"), "Already here\n\nTyped")
    }

    func testReadsWithTheApiKeyAndAsksAgainOnce() async throws {
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
        let t = try template(kind: "anthropic")
        let replies = Replies(["I can see an answer.", #"{"text":"Mesangial IgA","unclear":["IgA"]}"#])
        let read = try await readHandwriting(photos: [Data([0xFF, 0xD8])], question: "Q", template: t, sender: replies)
        XCTAssertEqual(read, HandwritingRead(text: "Mesangial IgA", unclear: ["IgA"], model: t.label))
        XCTAssertEqual(replies.sent.count, 2, "an unreadable reply is asked again once")
        let sent = try JSONDecoder().decode(JSONValue.self, from: try XCTUnwrap(replies.sent[1].httpBody))
        XCTAssertEqual(sent["messages"]?.arrayValue?.first?["content"]?.arrayValue?.first?["type"]?.stringValue, "image")
    }
}
