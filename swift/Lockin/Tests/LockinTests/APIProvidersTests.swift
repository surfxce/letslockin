import Foundation
import XCTest
@testable import LockinCore

// Expected texts were produced by running lib/llm/api.ts (with @anthropic-ai/sdk 0.134)
// against a local server sending the same responses.

/// The repository's prompts/ folder, found from this file so it works from any directory.
private let repoPrompts = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("prompts", isDirectory: true)

/// One answer from the stand-in network.
private struct CannedResponse {
    var status = 200
    var headers: [String: String] = [:]
    var body = ""
    /// Thrown instead of answering (the request never got a response).
    var failure: URLError?
    /// Thrown after the body's lines, as a connection that breaks off mid-stream.
    var endsWith: URLError?
    /// Never finishes: the body's lines, then nothing until the task is cancelled.
    var hangs = false
}

/// An `HTTPTransport` that answers from a list and keeps every request it was sent.
private final class MockTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var canned: [CannedResponse]
    private var sent: [URLRequest] = []
    private var open: [AsyncThrowingStream<String, Error>.Continuation] = []

    init(_ canned: [CannedResponse]) {
        self.canned = canned
    }

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return sent
    }

    private func next(_ request: URLRequest) throws -> (CannedResponse, HTTPURLResponse) {
        lock.lock()
        sent.append(request)
        let reply = canned.isEmpty ? CannedResponse(status: 599, body: "no canned response") : canned.removeFirst()
        lock.unlock()
        if let failure = reply.failure {
            throw failure
        }
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)
        else {
            throw URLError(.badURL)
        }
        return (reply, response)
    }

    private func keepOpen(_ continuation: AsyncThrowingStream<String, Error>.Continuation) {
        lock.lock()
        open.append(continuation)
        lock.unlock()
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (reply, response) = try next(request)
        if reply.hangs {
            try await Task.sleep(nanoseconds: 60_000_000_000)
        }
        return (Data(reply.body.utf8), response)
    }

    func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        let (reply, response) = try next(request)
        var splitter = APILineSplitter()
        var lines: [String] = []
        for byte in Array(reply.body.utf8) {
            if let line = splitter.push(byte) {
                lines.append(line)
            }
        }
        if let rest = splitter.finish() {
            lines.append(rest)
        }
        let stream = AsyncThrowingStream<String, Error> { continuation in
            for line in lines {
                continuation.yield(line)
            }
            if reply.hangs {
                self.keepOpen(continuation)
            } else if let end = reply.endsWith {
                continuation.finish(throwing: end)
            } else {
                continuation.finish()
            }
        }
        return (stream, response)
    }
}

/// Retry waits, recorded instead of slept.
private final class SleepLog: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [TimeInterval] = []

    func record(_ delay: TimeInterval) {
        lock.lock()
        recorded.append(delay)
        lock.unlock()
    }

    var delays: [TimeInterval] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }
}

/// Slide pictures from files already on disk: `<directory>/<page>.png`.
private struct StubRenderer: SlideRendering {
    var directory: URL

    func pageCount(file: String) -> Int? { nil }
    func renderPage(file: String, page: Int) throws -> Data { Data() }
    func pagePNG(lectureId: String, deck: SlideDeck, page: Int) throws -> Data { Data() }
    func pagePNGFile(lectureId: String, deck: SlideDeck, page: Int) throws -> String {
        directory.appendingPathComponent("\(page).png").path
    }
    func cropPNG(_ png: Data, crop: Crop) throws -> Data { png }
}

// MARK: - Server-sent events

private func sse(_ events: [(String, String)]) -> String {
    events.map { "event: \($0.0)\ndata: \($0.1)\n\n" }.joined()
}

private func messageStart(_ model: String) -> (String, String) {
    (
        "message_start",
        #"{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"#
            + jsonQuoted(model)
            + #","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}"#
    )
}

private func messageEnd(_ stopReason: String, details: String = "null") -> [(String, String)] {
    [
        (
            "message_delta",
            #"{"type":"message_delta","delta":{"stop_reason":"# + jsonQuoted(stopReason)
                + #","stop_sequence":null,"stop_details":"# + details + #"},"usage":{"output_tokens":5}}"#
        ),
        ("message_stop", #"{"type":"message_stop"}"#),
    ]
}

/// A whole reply: one text block written in `pieces`.
private func streamedReply(_ pieces: [String], model: String = "claude-sonnet-5-5", stopReason: String = "end_turn") -> String {
    var events: [(String, String)] = [
        messageStart(model),
        ("content_block_start", #"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#),
    ]
    for piece in pieces {
        events.append((
            "content_block_delta",
            #"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"# + jsonQuoted(piece) + "}}"
        ))
    }
    events.append(("content_block_stop", #"{"type":"content_block_stop","index":0}"#))
    return sse(events + messageEnd(stopReason))
}

private func anthropicError(_ type: String, _ message: String) -> String {
    #"{"type":"error","error":{"type":"# + jsonQuoted(type) + #","message":"# + jsonQuoted(message)
        + #"},"request_id":"req_1"}"#
}

// MARK: - Helpers

private func bodyText(_ request: URLRequest?) throws -> String {
    let data = try XCTUnwrap(request?.httpBody)
    return String(decoding: data, as: UTF8.self)
}

private func bodyJSON(_ request: URLRequest?) throws -> JSONValue {
    try JSONValue.parse(bodyText(request))
}

private func makeAnthropic(
    _ canned: [CannedResponse],
    model: String = "claude-sonnet-5-5",
    sleeps: SleepLog = SleepLog()
) -> (AnthropicAPIProvider, MockTransport) {
    let transport = MockTransport(canned)
    let provider = AnthropicAPIProvider(apiKey: "sk-test", model: model, transport: transport, promptsDirectory: repoPrompts)
    provider.retrySleep = { delay in sleeps.record(delay) }
    return (provider, transport)
}

private func makeOpenAI(
    _ canned: [CannedResponse],
    service: String = "OpenAI",
    baseURL: String = "http://127.0.0.1:1234/v1//",
    apiKey: String = "sk-o",
    model: String = "gpt-x",
    seesSlides: Bool = false,
    renderer: StubRenderer = StubRenderer(directory: FileManager.default.temporaryDirectory)
) -> (OpenAICompatibleProvider, MockTransport) {
    let transport = MockTransport(canned)
    let provider = OpenAICompatibleProvider(
        service: service,
        baseURL: baseURL,
        apiKey: apiKey,
        model: model,
        seesSlides: seesSlides,
        renderer: renderer,
        transport: transport,
        promptsDirectory: repoPrompts
    )
    return (provider, transport)
}

/// The `CloudError` message a call fails with, or a failure note.
private func failureMessage(_ work: () async throws -> Reply) async -> String {
    do {
        let reply = try await work()
        return "succeeded with \(reply.text)"
    } catch let error as CloudError {
        return error.message
    } catch {
        return "not a CloudError: \(messageOf(error))"
    }
}

private func temporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("lockin-api-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

private func waitForRequest(_ transport: MockTransport) async throws {
    var tries = 0
    while transport.requests.isEmpty && tries < 500 {
        try await Task.sleep(nanoseconds: 10_000_000)
        tries += 1
    }
}

final class APIProvidersTests: XCTestCase {
    // MARK: Anthropic: the request

    func testAnthropicSendsTheStreamedRequestTheSDKSends() async throws {
        let thinking = sse([
            messageStart("claude-sonnet-5-5"),
            ("content_block_start", #"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#),
            ("content_block_delta", #"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}"#),
            ("content_block_stop", #"{"type":"content_block_stop","index":0}"#),
            ("content_block_start", #"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#),
            ("ping", #"{"type":"ping"}"#),
            ("content_block_delta", #"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"{\"a\":"}}"#),
            ("content_block_delta", #"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"1}"}}"#),
            ("content_block_stop", #"{"type":"content_block_stop","index":1}"#),
        ]) + sse(messageEnd("end_turn"))
        let (provider, transport) = makeAnthropic([CannedResponse(body: thinking)])

        let reply = try await provider.complete("Hello", options: CallOptions(task: .digest))

        XCTAssertEqual(reply, Reply(text: #"{"a":1}"#, model: "claude-sonnet-5-5"))
        XCTAssertEqual(transport.requests.count, 1)
        let request = transport.requests.first
        XCTAssertEqual(request?.url?.absoluteString, "https://api.anthropic.com/v1/messages?beta=true")
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "x-api-key"), "sk-test")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "anthropic-version"), "2023-06-01")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "anthropic-beta"), "server-side-fallback-2026-07-01")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "content-type"), "application/json")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "accept"), "application/json")
        XCTAssertEqual(request?.timeoutInterval, 600)
        XCTAssertEqual(
            try bodyText(request),
            #"{"model":"claude-sonnet-5-5","max_tokens":64000,"output_config":{"effort":"medium"},"messages":[{"role":"user","content":[{"type":"text","text":"Hello"}]}],"fallbacks":"default","stream":true}"#
        )
    }

    func testAnthropicQuickTasksOnHaikuAskForLittleAndHaveNoFallback() async throws {
        let (provider, transport) = makeAnthropic([CannedResponse(body: streamedReply(["ok"]))], model: "claude-haiku-5-5")

        _ = try await provider.complete("Hello", options: CallOptions(task: .ask))

        let request = transport.requests.first
        XCTAssertNil(request?.value(forHTTPHeaderField: "anthropic-beta"))
        XCTAssertEqual(
            try bodyText(request),
            #"{"model":"claude-haiku-5-5","max_tokens":8000,"output_config":{"effort":"low"},"messages":[{"role":"user","content":[{"type":"text","text":"Hello"}]}],"stream":true}"#
        )
    }

    func testAnthropicSortIsQuickToo() async throws {
        let (provider, transport) = makeAnthropic([CannedResponse(body: streamedReply(["ok"]))], model: "claude-opus-5-5")

        _ = try await provider.complete("Hello", options: CallOptions(task: .sort))

        let body = try bodyJSON(transport.requests.first)
        let lowEffort: JSONValue = ["effort": "low"]
        XCTAssertEqual(body["max_tokens"], JSONValue.number(8000))
        XCTAssertEqual(body["output_config"], lowEffort)
        XCTAssertEqual(body["fallbacks"], JSONValue.string("default"))
    }

    func testAnthropicAttachesThePDFDecksWithTheDecksNote() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let pdf = directory.appendingPathComponent("Appetite.pdf")
        let bytes = Data("%PDF-1.4 lockin test".utf8)
        try bytes.write(to: pdf)
        let slides = SlidesInfo(lectureId: "l1", decks: [
            SlideDeck(materialId: "m1", name: "Appetite.pdf", file: pdf.path, pdf: true, pages: 3, first: 1),
            SlideDeck(materialId: "m2", name: "Handout.pptx", file: "/nonexistent/Handout.pptx", pdf: false, pages: 4, first: 4),
        ])
        let (provider, transport) = makeAnthropic([CannedResponse(body: streamedReply(["ok"]))])

        _ = try await provider.complete("Hello", options: CallOptions(task: .digest, slides: slides))

        let content = try XCTUnwrap(try bodyJSON(transport.requests.first)["messages"]?[0]?["content"]?.arrayValue)
        XCTAssertEqual(content.count, 2)
        let source: JSONValue = ["type": "base64", "media_type": "application/pdf", "data": .string(bytes.base64EncodedString())]
        XCTAssertEqual(content[0], ["type": "document", "source": source])
        XCTAssertEqual(content[1], ["type": "text", "text": .string("Hello" + decksNote(slides))])
        XCTAssertTrue(decksNote(slides).contains("- Appetite.pdf: slides 1–3"))
    }

    func testAnthropicSendsDecksPastTheLimitAsTheirTextAlone() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let pdf = directory.appendingPathComponent("Huge.pdf")
        try Data(count: apiMaxPDFBytes + 1).write(to: pdf)
        let slides = SlidesInfo(lectureId: "l1", decks: [
            SlideDeck(materialId: "m1", name: "Huge.pdf", file: pdf.path, pdf: true, pages: 300, first: 1),
        ])
        let (provider, transport) = makeAnthropic([CannedResponse(body: streamedReply(["ok"]))])

        _ = try await provider.complete("Hello", options: CallOptions(task: .digest, slides: slides))

        let content = try XCTUnwrap(try bodyJSON(transport.requests.first)["messages"]?[0]?["content"]?.arrayValue)
        XCTAssertEqual(content, [["type": "text", "text": "Hello"]])
    }

    func testAnthropicFailsAsNodeDoesOnAMissingDeck() async throws {
        let slides = SlidesInfo(lectureId: "l1", decks: [
            SlideDeck(materialId: "m1", name: "Gone.pdf", file: "/nonexistent/lockin/Gone.pdf", pdf: true, pages: 3, first: 1),
        ])
        let (provider, transport) = makeAnthropic([])

        do {
            _ = try await provider.complete("Hello", options: CallOptions(task: .digest, slides: slides))
            XCTFail("expected a failure")
        } catch let error as LockinError {
            XCTAssertEqual(error.message, "ENOENT: no such file or directory, open '/nonexistent/lockin/Gone.pdf'")
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    // MARK: Anthropic: the reply

    func testAnthropicCreditsTheModelAFallbackHandedTo() async throws {
        let body = sse([
            messageStart("claude-sonnet-5-5"),
            ("content_block_start", #"{"type":"content_block_start","index":0,"content_block":{"type":"fallback","from":{"model":"claude-sonnet-5-5"},"to":{"model":"claude-sonnet-5"}}}"#),
            ("content_block_start", #"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":"hi"}}"#),
            ("content_block_delta", #"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" there"}}"#),
        ]) + sse(messageEnd("end_turn"))
        let (provider, _) = makeAnthropic([CannedResponse(body: body)])

        let reply = try await provider.complete("x", options: CallOptions(task: .mark))

        XCTAssertEqual(reply, Reply(text: "hi there", model: "claude-sonnet-5"))
    }

    func testAnthropicSaysWhyClaudeDeclined() async {
        let declined = sse([messageStart("claude-sonnet-5-5")])
            + sse(messageEnd("refusal", details: #"{"type":"refusal","category":"cyber","explanation":"Not this one."}"#))
        let (provider, _) = makeAnthropic([CannedResponse(body: declined)])
        let message = await failureMessage { try await provider.complete("x", options: CallOptions(task: .mark)) }
        XCTAssertEqual(message, "Claude declined this: Not this one.")

        let bare = sse([messageStart("claude-sonnet-5-5")]) + sse(messageEnd("refusal"))
        let (quiet, _) = makeAnthropic([CannedResponse(body: bare)])
        let quietMessage = await failureMessage { try await quiet.complete("x", options: CallOptions(task: .mark)) }
        XCTAssertEqual(quietMessage, "Claude declined this: no reason given")
    }

    func testAnthropicSaysWhenTheReplyWasCutOff() async {
        let (provider, _) = makeAnthropic([CannedResponse(body: streamedReply(["{\"a\":"], stopReason: "max_tokens"))])
        let message = await failureMessage { try await provider.complete("x", options: CallOptions(task: .mark)) }
        XCTAssertEqual(message, "Claude's reply was cut off before it finished")
    }

    // MARK: Anthropic: failures

    func testAnthropicStatusErrorsAreWordedAsTheTypeScriptWordsThem() async {
        let cases: [(CannedResponse, String)] = [
            (CannedResponse(status: 401, body: anthropicError("authentication_error", "invalid x-api-key")),
             "The Anthropic API key was refused — check it in Settings"),
            (CannedResponse(status: 403, body: anthropicError("permission_error", "nope")),
             "This Anthropic API key isn't allowed to use that model"),
            (CannedResponse(status: 404, body: anthropicError("not_found_error", "model: claude-x")),
             #"The Anthropic API said 404: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"},"request_id":"req_1"}"#),
            (CannedResponse(status: 400, body: "bad things"), "The Anthropic API said 400: 400 bad things"),
            (CannedResponse(status: 400, body: ""), "The Anthropic API said 400: 400 status code (no body)"),
            (CannedResponse(status: 400, body: #"{"message":"top level"}"#), "The Anthropic API said 400: 400 top level"),
        ]
        for (canned, expected) in cases {
            let sleeps = SleepLog()
            let (provider, transport) = makeAnthropic([canned], sleeps: sleeps)
            let message = await failureMessage { try await provider.complete("x", options: CallOptions(task: .mark)) }
            XCTAssertEqual(message, expected)
            XCTAssertEqual(transport.requests.count, 1, "\(canned.status) is not retried")
            XCTAssertTrue(sleeps.delays.isEmpty)
        }
    }

    func testAnthropicRetriesRateLimitsAndServerErrorsTwice() async {
        let limited = CannedResponse(status: 429, headers: ["retry-after-ms": "5"], body: anthropicError("rate_limit_error", "slow"))
        let sleeps = SleepLog()
        let (provider, transport) = makeAnthropic([limited, limited, limited], sleeps: sleeps)
        let message = await failureMessage { try await provider.complete("x", options: CallOptions(task: .mark)) }
        XCTAssertEqual(message, "The Anthropic API is rate limiting this key — try again shortly")
        XCTAssertEqual(transport.requests.count, 3)
        XCTAssertEqual(sleeps.delays, [0.005, 0.005])

        let broken = CannedResponse(status: 500, headers: ["retry-after-ms": "5"], body: anthropicError("api_error", "Internal server error"))
        let (server, serverTransport) = makeAnthropic([broken, broken, broken])
        let serverMessage = await failureMessage { try await server.complete("x", options: CallOptions(task: .mark)) }
        XCTAssertEqual(
            serverMessage,
            #"The Anthropic API said 500: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_1"}"#
        )
        XCTAssertEqual(serverTransport.requests.count, 3)
    }

    func testAnthropicGoesOnAfterAnOverloadClears() async throws {
        let overloaded = CannedResponse(status: 529, body: anthropicError("overloaded_error", "Overloaded"))
        let sleeps = SleepLog()
        let (provider, transport) = makeAnthropic([overloaded, CannedResponse(body: streamedReply(["fine"]))], sleeps: sleeps)

        let reply = try await provider.complete("x", options: CallOptions(task: .mark))

        XCTAssertEqual(reply.text, "fine")
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertEqual(sleeps.delays.count, 1)
        // No retry-after: half a second, less up to a quarter.
        XCTAssertGreaterThanOrEqual(sleeps.delays[0], 0.375)
        XCTAssertLessThanOrEqual(sleeps.delays[0], 0.5)
    }

    func testAnthropicObeysXShouldRetry() async {
        let refused = CannedResponse(status: 500, headers: ["x-should-retry": "false"], body: "down")
        let (provider, transport) = makeAnthropic([refused])
        let message = await failureMessage { try await provider.complete("x", options: CallOptions(task: .mark)) }
        XCTAssertEqual(message, "The Anthropic API said 500: 500 down")
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testAnthropicStreamFailuresAreWordedAsTheSDKWordsThem() async {
        let cases: [(CannedResponse, String)] = [
            (CannedResponse(body: sse([
                messageStart("m"),
                ("error", #"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#),
            ])), #"The Anthropic API said no status: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#),
            (CannedResponse(body: "event: error\ndata: oops\n\n"), #"The Anthropic API said no status: "oops""#),
            (CannedResponse(body: ""), "Couldn't reach the Anthropic API: request ended without sending any chunks"),
            (CannedResponse(body: sse([messageStart("m")])),
             "Couldn't reach the Anthropic API: stream ended without producing a Message with role=assistant"),
            (CannedResponse(body: "event: message_start\ndata: {nope\n\n"),
             "Couldn't reach the Anthropic API: Expected property name or '}' in JSON at position 1 (line 1 column 2)"),
            (CannedResponse(body: sse([messageStart("m")]), endsWith: URLError(.networkConnectionLost)),
             "Couldn't reach the Anthropic API: terminated"),
        ]
        for (canned, expected) in cases {
            let (provider, transport) = makeAnthropic([canned])
            let message = await failureMessage { try await provider.complete("x", options: CallOptions(task: .mark)) }
            XCTAssertEqual(message, expected)
            XCTAssertEqual(transport.requests.count, 1)
        }
    }

    func testAnthropicConnectionFailuresAreRetriedThenReported() async {
        let down = CannedResponse(failure: URLError(.cannotConnectToHost))
        let sleeps = SleepLog()
        let (provider, transport) = makeAnthropic([down, down, down], sleeps: sleeps)
        let message = await failureMessage { try await provider.complete("x", options: CallOptions(task: .mark)) }
        XCTAssertEqual(message, "The Anthropic API said no status: Connection error.")
        XCTAssertEqual(transport.requests.count, 3)
        XCTAssertEqual(sleeps.delays.count, 2)

        let slow = CannedResponse(failure: URLError(.timedOut))
        let (timed, _) = makeAnthropic([slow, slow, slow])
        let timedMessage = await failureMessage { try await timed.complete("x", options: CallOptions(task: .mark)) }
        XCTAssertEqual(timedMessage, "The Anthropic API said no status: Request timed out.")
    }

    func testAnthropicCancellingEndsTheStream() async throws {
        let (provider, transport) = makeAnthropic([CannedResponse(body: sse([messageStart("m")]), hangs: true)])
        let task = Task { try await provider.complete("x", options: CallOptions(task: .digest)) }
        try await waitForRequest(transport)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected a cancel")
        } catch is CancellationError {
            // Cancelled, not a cloud failure: nothing to fall back from.
        }
    }

    // MARK: Anthropic: through the prompts

    func testAnthropicAnswersAQuestionThroughThePrompt() async throws {
        let answer = #"{"answer":"Ghrelin rises before meals.","section":"Ghrelin"}"#
        let (provider, transport) = makeAnthropic([CannedResponse(body: streamedReply([answer], model: "claude-sonnet-5"))])
        XCTAssertEqual(provider.lastModel, "Anthropic API · claude-sonnet-5-5")

        let reply = try await provider.ask(.question(AskQuestion(
            lectureTitle: "Appetite",
            summary: "## Ghrelin\nIt rises before meals.",
            question: "When does ghrelin rise?",
            headings: ["Ghrelin"]
        )))

        XCTAssertEqual(reply, Answer(answer: "Ghrelin rises before meals.", section: "Ghrelin"))
        XCTAssertTrue(provider.lastPromptVersion.hasPrefix("answer-question@"), provider.lastPromptVersion)
        XCTAssertEqual(provider.lastModel, "Anthropic API · claude-sonnet-5")
        let body = try bodyJSON(transport.requests.first)
        XCTAssertEqual(body["max_tokens"], JSONValue.number(8000))
        let text = try XCTUnwrap(body["messages"]?[0]?["content"]?[0]?["text"]?.stringValue)
        XCTAssertTrue(text.contains("When does ghrelin rise?"))
    }

    func testAnthropicRepairsAReplyWithNoJSON() async throws {
        let answer = #"{"answer":"Before meals.","section":null}"#
        let (provider, transport) = makeAnthropic([
            CannedResponse(body: streamedReply(["Sorry, no."])),
            CannedResponse(body: streamedReply([answer])),
        ])

        let reply = try await provider.ask(.breakdown(AskBreakdown(lectureTitle: "Appetite", summary: "## Ghrelin", selection: "ghrelin")))

        XCTAssertEqual(reply, Answer(answer: "Before meals.", section: nil))
        XCTAssertEqual(transport.requests.count, 2)
        let second = try XCTUnwrap(try bodyJSON(transport.requests.last)["messages"]?[0]?["content"]?[0]?["text"]?.stringValue)
        XCTAssertTrue(second.hasSuffix(
            "\n\nYour previous reply could not be used: no JSON found in reply: Sorry, no.\n"
                + "Reply again with valid JSON matching the schema exactly. No prose, no code fences."
        ))
    }

    func testAnthropicDoesNotAskAgainWhenTheKeyIsRefused() async throws {
        let (provider, transport) = makeAnthropic([
            CannedResponse(status: 401, body: anthropicError("authentication_error", "invalid x-api-key")),
        ])
        do {
            _ = try await provider.ask(.breakdown(AskBreakdown(lectureTitle: "Appetite", summary: "## Ghrelin", selection: "ghrelin")))
            XCTFail("expected a failure")
        } catch let error as CloudError {
            XCTAssertEqual(error.message, "The Anthropic API key was refused — check it in Settings")
            XCTAssertTrue(isCloudFailure(error))
        }
        XCTAssertEqual(transport.requests.count, 1)
    }

    // MARK: Anthropic: pieces

    func testLabels() {
        let anthropic = AnthropicAPIProvider(apiKey: "k", model: "claude-opus-5-5", transport: MockTransport([]))
        XCTAssertEqual(anthropic.name, "anthropic-api")
        XCTAssertTrue(anthropic.seesSlides)
        XCTAssertEqual(anthropic.lastModel, "Anthropic API · claude-opus-5-5")
        XCTAssertEqual(anthropic.label(model: ""), "Anthropic API · claude-opus-5-5")
        XCTAssertEqual(anthropic.label(model: "claude-opus-5"), "Anthropic API · claude-opus-5")

        let renderer = StubRenderer(directory: FileManager.default.temporaryDirectory)
        let groq = OpenAICompatibleProvider(
            service: "Groq", baseURL: "https://api.groq.com/openai/v1", apiKey: "k", model: "llama-4",
            seesSlides: true, renderer: renderer, transport: MockTransport([])
        )
        XCTAssertEqual(groq.name, "openai-compatible")
        XCTAssertTrue(groq.seesSlides)
        XCTAssertEqual(groq.lastModel, "Groq · llama-4")
        XCTAssertEqual(groq.label(model: nil), "Groq · llama-4")
        XCTAssertEqual(groq.label(model: "llama-4-scout"), "Groq · llama-4-scout")
        XCTAssertEqual(groq.lastPromptVersion, "")
    }

    func testApiClaudeModels() {
        XCTAssertEqual(apiClaudeModels[.sonnet], "claude-sonnet-5-5")
        XCTAssertEqual(apiClaudeModels[.opus], "claude-opus-5-5")
        XCTAssertEqual(apiClaudeModels[.haiku], "claude-haiku-5-5")
        XCTAssertEqual(apiMaxPDFBytes, 25_165_824)
    }

    func testErrorMessagesMatchTheSDK() {
        let body = try? JSONValue.parse(anthropicError("not_found_error", "model: x"))
        XCTAssertEqual(
            apiErrorMessage(status: 404, error: body, message: nil),
            #"404 {"type":"error","error":{"type":"not_found_error","message":"model: x"},"request_id":"req_1"}"#
        )
        let nestedMessage: JSONValue = ["message": ["a": 1]]
        let emptyMessage: JSONValue = ["message": ""]
        let numberMessage: JSONValue = ["message": 42]
        let list: JSONValue = [1, 2]
        XCTAssertEqual(apiErrorMessage(status: 500, error: JSONValue.null, message: "null"), "500 null")
        XCTAssertEqual(apiErrorMessage(status: 400, error: JSONValue.string("str"), message: nil), #"400 "str""#)
        XCTAssertEqual(apiErrorMessage(status: 400, error: nestedMessage, message: nil), #"400 {"a":1}"#)
        XCTAssertEqual(apiErrorMessage(status: 400, error: emptyMessage, message: nil), #"400 {"message":""}"#)
        XCTAssertEqual(apiErrorMessage(status: 400, error: numberMessage, message: nil), "400 42")
        XCTAssertEqual(apiErrorMessage(status: 400, error: list, message: nil), "400 [1,2]")
        XCTAssertEqual(apiErrorMessage(status: 400, error: JSONValue.number(0), message: "0"), "400 0")
        XCTAssertEqual(apiErrorMessage(status: 500, error: nil, message: ""), "500 status code (no body)")
        XCTAssertEqual(apiErrorMessage(status: nil, error: nil, message: nil), "(no status code or body)")
        XCTAssertEqual(apiErrorMessage(status: nil, error: JSONValue.string(""), message: nil), "(no status code or body)")
        XCTAssertEqual(apiErrorMessage(status: nil, error: nil, message: "Connection error."), "Connection error.")
    }

    func testRetryDelaysFollowTheSDK() throws {
        let url = try XCTUnwrap(URL(string: "https://api.anthropic.com/v1/messages"))
        func response(_ headers: [String: String]) -> HTTPURLResponse? {
            HTTPURLResponse(url: url, statusCode: 429, httpVersion: "HTTP/1.1", headerFields: headers)
        }
        XCTAssertEqual(apiRetryDelay(response(["retry-after-ms": "250"]), retriesRemaining: 2, maxRetries: 2), 0.25, accuracy: 1e-9)
        XCTAssertEqual(apiRetryDelay(response(["retry-after": "2"]), retriesRemaining: 2, maxRetries: 2), 2, accuracy: 1e-9)
        XCTAssertEqual(apiRetryDelay(response(["retry-after-ms": "0", "retry-after": "1.5"]), retriesRemaining: 2, maxRetries: 2), 1.5, accuracy: 1e-9)
        let now = Date(timeIntervalSince1970: 1_792_567_677)
        XCTAssertEqual(
            apiRetryDelay(response(["retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"]), retriesRemaining: 2, maxRetries: 2, now: now),
            3,
            accuracy: 1e-6
        )
        // No usable header: half a second doubling, at most 8, less up to a quarter.
        XCTAssertEqual(apiRetryDelay(nil, retriesRemaining: 2, maxRetries: 2, random: 0), 0.5, accuracy: 1e-9)
        XCTAssertEqual(apiRetryDelay(nil, retriesRemaining: 1, maxRetries: 2, random: 0), 1, accuracy: 1e-9)
        XCTAssertEqual(apiRetryDelay(nil, retriesRemaining: 2, maxRetries: 2, random: 1), 0.375, accuracy: 1e-9)
        XCTAssertEqual(apiRetryDelay(nil, retriesRemaining: 1, maxRetries: 10, random: 0), 8, accuracy: 1e-9)
        XCTAssertEqual(apiRetryDelay(response(["retry-after": "-3"]), retriesRemaining: 2, maxRetries: 2, random: 0), 0.5, accuracy: 1e-9)
        XCTAssertEqual(apiRetryDelay(response(["retry-after": "soon"]), retriesRemaining: 2, maxRetries: 2, random: 0), 0.5, accuracy: 1e-9)
        XCTAssertEqual(apiRetryDelay(response(["retry-after": "9999999"]), retriesRemaining: 2, maxRetries: 2, random: 0), 0.5, accuracy: 1e-9)
    }

    func testShouldRetryFollowsTheSDK() throws {
        let url = try XCTUnwrap(URL(string: "https://api.anthropic.com/v1/messages"))
        func retries(_ status: Int, _ headers: [String: String] = [:]) throws -> Bool {
            let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers))
            return apiShouldRetry(response)
        }
        XCTAssertTrue(try retries(408))
        XCTAssertTrue(try retries(409))
        XCTAssertTrue(try retries(429))
        XCTAssertTrue(try retries(500))
        XCTAssertTrue(try retries(529))
        XCTAssertFalse(try retries(400))
        XCTAssertFalse(try retries(404))
        XCTAssertTrue(try retries(400, ["x-should-retry": "true"]))
        XCTAssertFalse(try retries(503, ["x-should-retry": "false"]))
    }

    func testParseFloatReadsTheLeadingNumber() {
        XCTAssertEqual(apiParseFloat("  1.5s"), 1.5)
        XCTAssertTrue(apiParseFloat("abc").isNaN)
        XCTAssertEqual(apiParseFloat("-Infinityx"), -Double.infinity)
        XCTAssertEqual(apiParseFloat(".5e2z"), 50)
        XCTAssertEqual(apiParseFloat("+3"), 3)
        XCTAssertEqual(apiParseFloat("1e"), 1)
        XCTAssertEqual(apiParseFloat("0x10"), 0)
    }

    func testLinesSplitAsTheSDKSplitsThem() {
        var splitter = APILineSplitter()
        var lines: [String] = []
        for byte in Array("a\r\nb\n\nc\rd\r\re".utf8) {
            if let line = splitter.push(byte) {
                lines.append(line)
            }
        }
        if let rest = splitter.finish() {
            lines.append(rest)
        }
        XCTAssertEqual(lines, ["a", "b", "", "c", "d", "", "e"])
    }

    func testEventsDecodeAsTheSDKDecodesThem() {
        var decoder = APIEventDecoder()
        var events: [APIServerSentEvent] = []
        let lines = [
            ": a comment", "event: message_start", "data: {\"a\":", "data:1}", "",
            "", "data: alone", "", "event:ping", "id: 7", "",
        ]
        for line in lines {
            if let event = decoder.decode(line) {
                events.append(event)
            }
        }
        XCTAssertEqual(events, [
            APIServerSentEvent(event: "message_start", data: "{\"a\":\n1}"),
            APIServerSentEvent(event: nil, data: "alone"),
            APIServerSentEvent(event: "ping", data: ""),
        ])
    }

    // MARK: OpenAI-compatible

    func testOpenAISendsAChatCompletion() async throws {
        let canned = CannedResponse(body: #"{"model":"gpt-x-2026","choices":[{"message":{"content":"{\"a\":1}"},"finish_reason":"stop"}]}"#)
        let (provider, transport) = makeOpenAI([canned])

        let reply = try await provider.complete("Hello", options: CallOptions(task: .mark))

        XCTAssertEqual(reply, Reply(text: #"{"a":1}"#, model: "gpt-x-2026"))
        let request = transport.requests.first
        XCTAssertEqual(request?.url?.absoluteString, "http://127.0.0.1:1234/v1/chat/completions")
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer sk-o")
        XCTAssertEqual(try bodyText(request), #"{"model":"gpt-x","messages":[{"role":"user","content":"Hello"}]}"#)
    }

    func testOpenAIWithoutAKeySendsNoAuthorizationAndJoinsTheParts() async throws {
        let canned = CannedResponse(body: #"{"choices":[{"message":{"content":[{"type":"text","text":"a"},{"text":null},"x",{"text":5}]}}]}"#)
        let (provider, transport) = makeOpenAI([canned], service: "localhost:1", baseURL: "http://127.0.0.1:1234/v1", apiKey: "", model: "llama")

        let reply = try await provider.complete("Hello", options: CallOptions(task: .mark))

        XCTAssertEqual(reply, Reply(text: "a5", model: nil))
        XCTAssertNil(transport.requests.first?.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(provider.label(model: reply.model), "localhost:1 · llama")
    }

    func testOpenAIAsksForAModelFirst() async {
        let (provider, transport) = makeOpenAI([], model: "")
        let message = await failureMessage { try await provider.complete("Hello", options: CallOptions(task: .mark)) }
        XCTAssertEqual(message, "Choose which OpenAI model to use, in Settings")
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testOpenAIFailuresAreWordedAsTheTypeScriptWordsThem() async {
        let cases: [(CannedResponse, String)] = [
            (CannedResponse(status: 401, body: #"{"error":{"message":"Incorrect API key provided"}}"#),
             "OpenAI said 401: Incorrect API key provided — check the API key in Settings"),
            (CannedResponse(status: 403, body: #"{"error":{"message":null}}"#), "OpenAI said 403: Forbidden — check the API key in Settings"),
            (CannedResponse(status: 429, body: #"{"error":"slow down"}"#), "OpenAI said 429: slow down"),
            (CannedResponse(status: 500, body: "boom"), "OpenAI said 500: Internal Server Error"),
            (CannedResponse(status: 200, body: "not json"), "OpenAI said 200: OK"),
            (CannedResponse(status: 200, body: "null"), "OpenAI said 200: OK"),
            (CannedResponse(status: 400, body: #"{"error":{"message":{"a":1}}}"#), "OpenAI said 400: [object Object]"),
            (CannedResponse(body: #"{"choices":[{"message":{"content":"  \n"}}]}"#), "OpenAI sent back an empty reply"),
            (CannedResponse(body: #"{"choices":[]}"#), "OpenAI sent back an empty reply"),
            (CannedResponse(body: #"{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}"#),
             "OpenAI's reply was cut off before it finished"),
            (CannedResponse(failure: URLError(.cannotConnectToHost)), "Couldn't reach OpenAI: fetch failed"),
            (CannedResponse(failure: URLError(.timedOut)), "Couldn't reach OpenAI: The operation was aborted due to timeout"),
        ]
        for (canned, expected) in cases {
            let (provider, transport) = makeOpenAI([canned])
            let message = await failureMessage { try await provider.complete("x", options: CallOptions(task: .mark)) }
            XCTAssertEqual(message, expected)
            XCTAssertEqual(transport.requests.count, 1, "never retried")
        }
    }

    func testOpenAIRejectsAnAddressWithNoScheme() async {
        let (provider, transport) = makeOpenAI([], service: "X", baseURL: "api.example.com/v1")
        let message = await failureMessage { try await provider.complete("x", options: CallOptions(task: .mark)) }
        XCTAssertEqual(message, "Couldn't reach X: Failed to parse URL from api.example.com/v1/chat/completions")
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testOpenAISendsTheSlidesAsPicturesToAModelThatSees() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = Data("png one".utf8)
        let second = Data("png two".utf8)
        try first.write(to: directory.appendingPathComponent("1.png"))
        try second.write(to: directory.appendingPathComponent("2.png"))
        let slides = SlidesInfo(lectureId: "l1", decks: [
            SlideDeck(materialId: "m1", name: "Appetite.pdf", file: "/tmp/Appetite.pdf", pdf: true, pages: 2, first: 1),
            SlideDeck(materialId: "m2", name: "Handout.pptx", file: "/tmp/Handout.pptx", pdf: false, pages: 5, first: 3),
        ])
        let canned = CannedResponse(body: #"{"choices":[{"message":{"content":"ok"}}]}"#)
        let (provider, transport) = makeOpenAI([canned], seesSlides: true, renderer: StubRenderer(directory: directory))

        _ = try await provider.complete("Hello", options: CallOptions(task: .digest, slides: slides))

        let pictures = [
            SlidePicture(slide: 1, file: directory.appendingPathComponent("1.png").path),
            SlidePicture(slide: 2, file: directory.appendingPathComponent("2.png").path),
        ]
        let content = try XCTUnwrap(try bodyJSON(transport.requests.first)["messages"]?[0]?["content"]?.arrayValue)
        XCTAssertEqual(content.count, 3)
        XCTAssertEqual(content[0], ["type": "text", "text": .string("Hello" + picturesNote(pictures, total: 2))])
        let firstURL: JSONValue = ["url": .string("data:image/png;base64,\(first.base64EncodedString())")]
        let secondURL: JSONValue = ["url": .string("data:image/png;base64,\(second.base64EncodedString())")]
        XCTAssertEqual(content[1], ["type": "image_url", "image_url": firstURL])
        XCTAssertEqual(content[2], ["type": "image_url", "image_url": secondURL])
    }

    func testOpenAISendsOnlyTextToAModelThatDoesNotSee() async throws {
        let slides = SlidesInfo(lectureId: "l1", decks: [
            SlideDeck(materialId: "m1", name: "Appetite.pdf", file: "/tmp/Appetite.pdf", pdf: true, pages: 2, first: 1),
        ])
        let canned = CannedResponse(body: #"{"choices":[{"message":{"content":"ok"}}]}"#)
        let (provider, transport) = makeOpenAI([canned], seesSlides: false)

        _ = try await provider.complete("Hello", options: CallOptions(task: .digest, slides: slides))

        XCTAssertEqual(try bodyJSON(transport.requests.first)["messages"]?[0]?["content"], JSONValue.string("Hello"))
    }

    func testOpenAICancellingEndsTheRequest() async throws {
        let (provider, transport) = makeOpenAI([CannedResponse(hangs: true)])
        let task = Task { try await provider.complete("x", options: CallOptions(task: .mark)) }
        try await waitForRequest(transport)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected a cancel")
        } catch is CancellationError {
            // Cancelled, not a cloud failure.
        }
    }

    func testReasonPhrases() {
        XCTAssertEqual(apiReasonPhrase(200), "OK")
        XCTAssertEqual(apiReasonPhrase(401), "Unauthorized")
        XCTAssertEqual(apiReasonPhrase(429), "Too Many Requests")
        XCTAssertEqual(apiReasonPhrase(503), "Service Unavailable")
        XCTAssertEqual(apiReasonPhrase(599), "")
    }
}
