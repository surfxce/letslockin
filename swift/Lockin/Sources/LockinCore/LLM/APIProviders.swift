import Foundation

// Port of lib/llm/api.ts: Claude through the Anthropic API, and any service that speaks
// OpenAI's chat format, each with the student's own key (Setting "apiKey", read by
// `getApiKey`). The TypeScript reaches Anthropic through @anthropic-ai/sdk 0.134; what the
// SDK does on the wire is done here by hand, so the requests, the retries and the error
// texts a failed job shows are the same: `/v1/messages?beta=true` streamed as server-sent
// events, two retries on 408/409/429/5xx and on connection failures, and `APIError.message`
// ("404 {…}") quoted as the SDK words it.

// MARK: - HTTP

/// How the API providers reach the network: URLSession in the app, a stand-in in tests.
public protocol HTTPTransport: Sendable {
    /// One request with its whole body read. Cancelling the calling task cancels the request.
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
    /// One request whose body arrives line by line (server-sent events), empty lines
    /// included, split on "\n", "\r\n" or "\r" as the SDK's `LineDecoder` splits them.
    /// Ending the iteration, or cancelling the task iterating it, cancels the request.
    func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse)
}

/// `HTTPTransport` over URLSession.
public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }

    public func stream(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        let dataTask = bytes.task
        guard let http = response as? HTTPURLResponse else {
            dataTask.cancel()
            throw URLError(.badServerResponse)
        }
        let lines = AsyncThrowingStream<String, Error> { continuation in
            let reader = Task {
                var splitter = APILineSplitter()
                do {
                    for try await byte in bytes {
                        if let line = splitter.push(byte) {
                            continuation.yield(line)
                        }
                    }
                    if let rest = splitter.finish() {
                        continuation.yield(rest)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                reader.cancel()
                dataTask.cancel()
            }
        }
        return (lines, http)
    }
}

/// Splits a body into lines the way the SDK's `LineDecoder` does: "\n", "\r\n" and a lone
/// "\r" each end a line, and what is left at the end is a last line.
struct APILineSplitter {
    private var buffer: [UInt8] = []
    private var afterCarriageReturn = false

    init() {}

    /// Takes one byte; returns a line when this byte ends one.
    mutating func push(_ byte: UInt8) -> String? {
        if byte == 0x0A {
            if afterCarriageReturn {
                // The "\n" of a "\r\n": that line was already handed out.
                afterCarriageReturn = false
                return nil
            }
            return takeLine()
        }
        if byte == 0x0D {
            afterCarriageReturn = true
            return takeLine()
        }
        afterCarriageReturn = false
        buffer.append(byte)
        return nil
    }

    /// The unfinished last line, if any (`LineDecoder.flush`).
    mutating func finish() -> String? {
        afterCarriageReturn = false
        return buffer.isEmpty ? nil : takeLine()
    }

    private mutating func takeLine() -> String {
        let line = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll(keepingCapacity: true)
        return line
    }
}

/// One server-sent event: its `event:` name, if any, and its `data:` lines joined with "\n".
struct APIServerSentEvent: Equatable, Sendable {
    var event: String?
    var data: String
}

/// The SDK's `SSEDecoder`: fields gather until an empty line ends the event.
struct APIEventDecoder {
    private var event: String?
    private var data: [String] = []

    init() {}

    mutating func decode(_ rawLine: String) -> APIServerSentEvent? {
        var line = rawLine
        if line.unicodeScalars.last == "\r" {
            var scalars = line.unicodeScalars
            scalars.removeLast()
            line = String(scalars)
        }
        if line.isEmpty {
            // An empty line with nothing gathered is not an event.
            if (event ?? "").isEmpty && data.isEmpty {
                return nil
            }
            let finished = APIServerSentEvent(event: event, data: data.joined(separator: "\n"))
            event = nil
            data = []
            return finished
        }
        if line.hasPrefix(":") {
            return nil
        }
        var field = line
        var value = ""
        if let colon = line.firstIndex(of: ":") {
            field = String(line[line.startIndex..<colon])
            value = String(line[line.index(after: colon)...])
        }
        if value.hasPrefix(" ") {
            value.removeFirst()
        }
        if field == "event" {
            event = value
        } else if field == "data" {
            data.append(value)
        }
        return nil
    }
}

/// `APIError.makeMessage(status, error, message)` from @anthropic-ai/sdk: the body's
/// `message` when it has one, else the whole body as JSON, else the raw text, after the
/// status ("404 {"type":"error",…}").
func apiErrorMessage(status: Int?, error: JSONValue?, message: String?) -> String {
    var shown: String?
    if let error, let inner = error["message"], inner.isTruthy {
        shown = inner.stringValue ?? inner.stringified()
    } else if let error, error.isTruthy {
        shown = error.stringified()
    } else {
        shown = message
    }
    // `if (status && msg)`: no status, or 0, counts as none.
    let code: Int? = (status ?? 0) == 0 ? nil : status
    if let code, let shown, !shown.isEmpty {
        return "\(code) \(shown)"
    }
    if let code {
        return "\(code) status code (no body)"
    }
    if let shown, !shown.isEmpty {
        return shown
    }
    return "(no status code or body)"
}

/// The SDK's `shouldRetry`: as the server says (`x-should-retry`), else on a request
/// timeout, a lock timeout, a rate limit or a server error.
func apiShouldRetry(_ response: HTTPURLResponse) -> Bool {
    let header = response.value(forHTTPHeaderField: "x-should-retry")
    if header == "true" {
        return true
    }
    if header == "false" {
        return false
    }
    let status = response.statusCode
    return status == 408 || status == 409 || status == 429 || status >= 500
}

/// How long the SDK waits before a retry, in seconds (`retryRequest`): what `retry-after-ms`
/// or `retry-after` asks for when it is a positive delay one timer can hold, else half a
/// second doubling with each retry, at most 8, less up to a quarter at random.
func apiRetryDelay(
    _ response: HTTPURLResponse?,
    retriesRemaining: Int,
    maxRetries: Int,
    now: Date = Date(),
    random: Double = Double.random(in: 0..<1)
) -> TimeInterval {
    var millis: Double?
    if let header = response?.value(forHTTPHeaderField: "retry-after-ms"), !header.isEmpty {
        let value = apiParseFloat(header)
        if !value.isNaN {
            millis = value
        }
    }
    if let header = response?.value(forHTTPHeaderField: "retry-after"), !header.isEmpty, (millis ?? 0) == 0 {
        let seconds = apiParseFloat(header)
        if !seconds.isNaN {
            millis = seconds * 1000
        } else if let date = apiHTTPDate(header) {
            millis = date.timeIntervalSince(now) * 1000
        } else {
            millis = Double.nan
        }
    }
    if let millis, millis > 0, millis <= 2_147_483_647 {
        return millis / 1000
    }
    let retriesDone = Double(maxRetries - retriesRemaining)
    let seconds = min(0.5 * pow(2, retriesDone), 8)
    return seconds * (1 - random * 0.25)
}

/// Waits before a retry; a cancelled task stops waiting at once.
func apiDefaultSleep(_ seconds: TimeInterval) async throws {
    let clamped = max(0, min(seconds, 2_147_483.647))
    try await Task.sleep(nanoseconds: UInt64(clamped * 1_000_000_000))
}

private let apiFloatPrefixRe = Regex.compile(#"\A[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)"#)

/// `parseFloat(text)`: the number at the start of the text, after white space; NaN when
/// there is none.
func apiParseFloat(_ text: String) -> Double {
    let trimmed = String(text.drop(while: { $0.isWhitespace }))
    guard let match = Regex.firstMatch(apiFloatPrefixRe, in: trimmed),
          let prefix = Regex.group(match, at: 0, in: trimmed) else {
        return .nan
    }
    if prefix.hasSuffix("Infinity") {
        return prefix.hasPrefix("-") ? -Double.infinity : Double.infinity
    }
    if let number = Double(prefix) {
        return number
    }
    // A run of digits past a double's range.
    return prefix.hasPrefix("-") ? -Double.infinity : Double.infinity
}

/// An HTTP date ("Wed, 21 Oct 2015 07:28:00 GMT"), as `Date.parse` reads one.
private func apiHTTPDate(_ text: String) -> Date? {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
    return formatter.date(from: text.trimmingCharacters(in: .whitespaces))
}

/// What a body read that broke off says in Node ("terminated", from undici).
private let apiTerminated = "terminated"

/// JavaScript's white space and line ends, which `String.prototype.trim` removes.
private let apiTrimCharacters: CharacterSet = {
    var set = CharacterSet.whitespacesAndNewlines
    set.insert(charactersIn: "\u{FEFF}")
    set.remove(charactersIn: "\u{0085}")
    return set
}()

/// `a || b` for a model name: nil or "" falls back.
private func apiOr(_ preferred: String?, _ fallback: String) -> String {
    if let preferred, !preferred.isEmpty {
        return preferred
    }
    return fallback
}

/// The body as text, as `response.text()` decodes it: UTF-8 with a leading BOM dropped.
private func apiDecodeBody(_ data: Data) -> String {
    let text = String(decoding: data, as: UTF8.self)
    return apiDroppingBOM(text)
}

private func apiDroppingBOM(_ text: String) -> String {
    guard text.unicodeScalars.first == "\u{FEFF}" else { return text }
    var scalars = text.unicodeScalars
    scalars.removeFirst()
    return String(scalars)
}

/// `readFile(path)`: a missing file fails as Node words it.
private func apiReadFile(_ path: String) throws -> Data {
    do {
        return try Data(contentsOf: URL(fileURLWithPath: path))
    } catch {
        if !FileManager.default.fileExists(atPath: path) {
            throw LockinError("ENOENT: no such file or directory, open '\(path)'")
        }
        throw error
    }
}

/// Whether a failure is the task being cancelled (URLSession then reports `.cancelled`).
private func apiWasCancelled(_ error: Error) -> Bool {
    error is CancellationError || Task.isCancelled
}

// MARK: - Anthropic

/// Claude on the API, by the same names Settings uses for Claude Code (`API_CLAUDE_MODELS`).
public let apiClaudeModels: [CloudModel: String] = [
    .sonnet: "claude-sonnet-5-5",
    .opus: "claude-opus-5-5",
    .haiku: "claude-haiku-5-5",
]

/// A request is limited to 32 MB; past this the decks go as their text alone.
let apiMaxPDFBytes = 24 * 1024 * 1024

/// Sonnet and Opus fall back to another model on a policy decline rather than stopping the job.
let anthropicFallbackBeta = "server-side-fallback-2026-07-01"

/// A failed Messages request, before it becomes a `CloudError` (the SDK's error classes).
enum AnthropicFailure: Error, Equatable {
    /// `APIError`: a status (nil for one sent mid-stream, or no response) and `err.message`.
    case api(status: Int?, message: String)
    /// Any other `AnthropicError` (the stream broke off, a line would not parse…).
    case other(String)
}

/// A content block of a streamed reply: its type, and its text when it is a text block.
struct AnthropicStreamedBlock: Equatable, Sendable {
    var type: String
    var text: String
}

/// The parts of the SDK's `finalMessage()` the provider reads.
struct AnthropicStreamedMessage: Equatable, Sendable {
    var model: String?
    var stopReason: String?
    var stopDetails: JSONValue?
    var blocks: [AnthropicStreamedBlock]

    /// The text blocks, joined.
    var text: String {
        blocks.filter { $0.type == "text" }.map(\.text).joined()
    }
}

/// `BetaMessageStream`'s accumulation of the stream events into the final message.
struct AnthropicMessageAccumulator {
    private static let messageEvents: Set<String> = [
        "message_start", "message_delta", "message_stop",
        "content_block_start", "content_block_delta", "content_block_stop",
    ]

    private var current: AnthropicStreamedMessage?
    private var received: [AnthropicStreamedMessage] = []

    init() {}

    /// Takes one event. An `error` event throws as the SDK does; a line that is not JSON
    /// throws its `JSONParseError`.
    mutating func handle(_ event: APIServerSentEvent) throws {
        guard let name = event.event else { return }
        if name == "error" {
            // `safeJSON(sse.data) ?? sse.data`
            var body = JSONValue.string(event.data)
            if let parsed = try? JSONValue.parse(event.data), !parsed.isNull {
                body = parsed
            }
            throw AnthropicFailure.api(status: nil, message: apiErrorMessage(status: nil, error: body, message: nil))
        }
        guard Self.messageEvents.contains(name) else { return }
        try apply(JSONValue.parse(event.data))
    }

    private mutating func apply(_ data: JSONValue) throws {
        let type = data["type"]?.stringValue ?? ""
        if type == "message_start" {
            if current != nil {
                throw AnthropicFailure.other("Unexpected event order, got message_start before receiving \"message_stop\"")
            }
            guard let message = data["message"], message.objectValue != nil else { return }
            current = AnthropicStreamedMessage(
                model: message["model"]?.stringValue,
                stopReason: message["stop_reason"]?.stringValue,
                stopDetails: message["stop_details"],
                blocks: (message["content"]?.arrayValue ?? []).map { Self.makeBlock($0) }
            )
            return
        }
        guard var snapshot = current else { return }
        switch type {
        case "message_stop":
            received.append(snapshot)
        case "message_delta":
            let delta = data["delta"]
            snapshot.stopReason = delta?["stop_reason"]?.stringValue
            snapshot.stopDetails = delta?["stop_details"]
        case "content_block_start":
            let block = data["content_block"] ?? .null
            snapshot.blocks.append(Self.makeBlock(block))
            // The last hop's fallback block names the model that served the reply.
            if block["type"]?.stringValue == "fallback", let model = block["to"]?["model"]?.stringValue {
                snapshot.model = model
            }
        case "content_block_delta":
            if let index = data["index"]?.intValue, index >= 0, index < snapshot.blocks.count,
               data["delta"]?["type"]?.stringValue == "text_delta",
               snapshot.blocks[index].type == "text" {
                snapshot.blocks[index].text += data["delta"]?["text"]?.stringValue ?? ""
            }
        default:
            break
        }
        current = snapshot
    }

    private static func makeBlock(_ value: JSONValue) -> AnthropicStreamedBlock {
        AnthropicStreamedBlock(type: value["type"]?.stringValue ?? "", text: value["text"]?.stringValue ?? "")
    }

    /// The final message, or the SDK's complaint about a stream that ended early.
    func finish() throws -> AnthropicStreamedMessage {
        if current == nil {
            throw AnthropicFailure.other("request ended without sending any chunks")
        }
        guard let last = received.last else {
            throw AnthropicFailure.other("stream ended without producing a Message with role=assistant")
        }
        return last
    }
}

/// Claude through the Anthropic API with the student's own key, billed per use. The slide
/// decks are attached as PDFs, which Claude reads page by page, pictures and all.
public final class AnthropicAPIProvider: PromptProvider, @unchecked Sendable {
    public let name = "anthropic-api"
    public let seesSlides = true
    public let report: ProviderReport
    public let promptsDirectory: URL
    private let apiKey: String
    private let model: String
    private let transport: any HTTPTransport
    private let timeout: TimeInterval

    /// Where requests go: the SDK's default address.
    let baseURL = "https://api.anthropic.com"
    /// How many times a failed request is tried again (the SDK's `maxRetries`).
    var maxRetries = 2
    /// Waits before each retry; tests make it instant.
    var retrySleep: @Sendable (TimeInterval) async throws -> Void = apiDefaultSleep

    public init(
        apiKey: String,
        model: String,
        transport: any HTTPTransport = URLSessionTransport(),
        timeout: TimeInterval = 600,
        promptsDirectory: URL = LockinPaths.promptsDirectory
    ) {
        self.apiKey = apiKey
        self.model = model
        self.transport = transport
        self.timeout = timeout
        self.promptsDirectory = promptsDirectory
        self.report = ProviderReport()
        report.lastModel = label(model: nil)
    }

    public func label(model: String?) -> String {
        "Anthropic API · \(apiOr(model, self.model))"
    }

    public func complete(_ prompt: String, options: CallOptions) async throws -> Reply {
        var content: [JSONValue] = []
        var note = ""
        if let slides = options.slides {
            let pdfs = slides.decks.filter { $0.isPictured }
            let files = try pdfs.map { try apiReadFile($0.file) }
            if files.reduce(0, { $0 + $1.count }) <= apiMaxPDFBytes {
                for file in files {
                    let source: JSONValue = [
                        "type": "base64",
                        "media_type": "application/pdf",
                        "data": .string(file.base64EncodedString()),
                    ]
                    content.append(["type": "document", "source": source])
                }
                note = decksNote(slides)
            }
        }
        content.append(["type": "text", "text": .string(prompt + note)])

        let request = try messagesRequest(content: content, task: options.task)
        let message: AnthropicStreamedMessage
        do {
            message = try await streamMessage(request)
        } catch {
            if apiWasCancelled(error) {
                throw CancellationError()
            }
            throw Self.cloudError(error)
        }
        if message.stopReason == "refusal" {
            var why = "no reason given"
            if let explanation = message.stopDetails?["explanation"], !explanation.isNull {
                why = jsString(explanation)
            }
            throw CloudError("Claude declined this: \(why)")
        }
        if message.stopReason == "max_tokens" {
            throw CloudError("Claude's reply was cut off before it finished")
        }
        return Reply(text: message.text, model: message.model)
    }

    /// The streamed Messages request, as `client.beta.messages.stream(…)` sends it.
    func messagesRequest(content: [JSONValue], task: LLMTask) throws -> URLRequest {
        let quick = task.isQuick
        // Haiku has no server-side refusal fallback; Sonnet and Opus fall back to another
        // model on a policy decline rather than stopping the job.
        let fallback = model != apiClaudeModels[.haiku]
        let effort: JSONValue = ["effort": .string(quick ? "low" : "medium")]
        let messages: JSONValue = [["role": "user", "content": .array(content)]]
        var body = JSONObject()
        body["model"] = .string(model)
        body["max_tokens"] = .int(quick ? 8000 : 64000)
        body["output_config"] = effort
        body["messages"] = messages
        if fallback {
            body["fallbacks"] = .string("default")
        }
        body["stream"] = .bool(true)

        let address = baseURL + "/v1/messages?beta=true"
        guard let url = URL(string: address) else {
            throw CloudError("Couldn't reach the Anthropic API: Invalid URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if fallback {
            request.setValue(anthropicFallbackBeta, forHTTPHeaderField: "anthropic-beta")
        }
        request.httpBody = Data(JSONValue.object(body).stringified().utf8)
        return request
    }

    /// Sends the request, retrying as the SDK does, and reads the stream to its final message.
    private func streamMessage(_ request: URLRequest) async throws -> AnthropicStreamedMessage {
        let retries = max(0, maxRetries)
        var retriesRemaining = retries
        while true {
            try Task.checkCancellation()
            let opened: (AsyncThrowingStream<String, Error>, HTTPURLResponse)
            do {
                opened = try await transport.stream(request)
            } catch {
                if apiWasCancelled(error) {
                    throw CancellationError()
                }
                if retriesRemaining > 0 {
                    try await retrySleep(apiRetryDelay(nil, retriesRemaining: retriesRemaining, maxRetries: retries))
                    retriesRemaining -= 1
                    continue
                }
                let timedOut = (error as? URLError)?.code == .timedOut
                throw AnthropicFailure.api(status: nil, message: timedOut ? "Request timed out." : "Connection error.")
            }
            let (lines, response) = opened
            if !(200...299).contains(response.statusCode) {
                let retry = apiShouldRetry(response)
                if retriesRemaining > 0 && retry {
                    try await retrySleep(apiRetryDelay(response, retriesRemaining: retriesRemaining, maxRetries: retries))
                    retriesRemaining -= 1
                    continue
                }
                let text = try await Self.readAll(lines)
                // `safeJSON(errText)`; a body that is not JSON is quoted as text.
                let parsed = try? JSONValue.parse(text)
                let quotesBody = parsed.map { $0.isTruthy } ?? false
                throw AnthropicFailure.api(
                    status: response.statusCode,
                    message: apiErrorMessage(status: response.statusCode, error: parsed, message: quotesBody ? nil : text)
                )
            }
            return try await Self.readMessage(lines)
        }
    }

    /// An error response's body (`response.text()`); a read that breaks off gives its message.
    private static func readAll(_ lines: AsyncThrowingStream<String, Error>) async throws -> String {
        var collected: [String] = []
        do {
            for try await line in lines {
                collected.append(line)
            }
        } catch {
            if apiWasCancelled(error) {
                throw CancellationError()
            }
            return apiTerminated
        }
        try Task.checkCancellation()
        return apiDroppingBOM(collected.joined(separator: "\n"))
    }

    private static func readMessage(_ lines: AsyncThrowingStream<String, Error>) async throws -> AnthropicStreamedMessage {
        var decoder = APIEventDecoder()
        var accumulator = AnthropicMessageAccumulator()
        do {
            for try await line in lines {
                if let event = decoder.decode(line) {
                    try accumulator.handle(event)
                }
            }
        } catch let failure as AnthropicFailure {
            throw failure
        } catch let parse as JSONParseError {
            throw AnthropicFailure.other(parse.message)
        } catch {
            if apiWasCancelled(error) {
                throw CancellationError()
            }
            throw AnthropicFailure.other(apiTerminated)
        }
        // A cancelled task ends the stream quietly; that is a cancel, not a short reply.
        try Task.checkCancellation()
        return try accumulator.finish()
    }

    /// The TypeScript's `catch`: what the student is told when a request fails.
    static func cloudError(_ error: Error) -> CloudError {
        if let cloud = error as? CloudError {
            return cloud
        }
        guard let failure = error as? AnthropicFailure else {
            return CloudError("Couldn't reach the Anthropic API: \(messageOf(error))")
        }
        switch failure {
        case .api(let status, let message):
            switch status {
            case .some(401):
                return CloudError("The Anthropic API key was refused — check it in Settings")
            case .some(403):
                return CloudError("This Anthropic API key isn't allowed to use that model")
            case .some(429):
                return CloudError("The Anthropic API is rate limiting this key — try again shortly")
            default:
                let shown = status.map { String($0) } ?? "no status"
                return CloudError("The Anthropic API said \(shown): \(message)")
            }
        case .other(let message):
            return CloudError("Couldn't reach the Anthropic API: \(message)")
        }
    }
}

// MARK: - OpenAI-compatible

/// The reason phrase a server sends with a status (`res.statusText`); URLSession does not
/// pass it on, so the standard one stands in.
func apiReasonPhrase(_ status: Int) -> String {
    switch status {
    case 200: return "OK"
    case 201: return "Created"
    case 202: return "Accepted"
    case 204: return "No Content"
    case 301: return "Moved Permanently"
    case 302: return "Found"
    case 304: return "Not Modified"
    case 307: return "Temporary Redirect"
    case 308: return "Permanent Redirect"
    case 400: return "Bad Request"
    case 401: return "Unauthorized"
    case 402: return "Payment Required"
    case 403: return "Forbidden"
    case 404: return "Not Found"
    case 405: return "Method Not Allowed"
    case 406: return "Not Acceptable"
    case 408: return "Request Timeout"
    case 409: return "Conflict"
    case 410: return "Gone"
    case 413: return "Payload Too Large"
    case 415: return "Unsupported Media Type"
    case 422: return "Unprocessable Entity"
    case 429: return "Too Many Requests"
    case 500: return "Internal Server Error"
    case 501: return "Not Implemented"
    case 502: return "Bad Gateway"
    case 503: return "Service Unavailable"
    case 504: return "Gateway Timeout"
    default: return ""
    }
}

/// What `fetch` rejects with in Node, which the TypeScript quotes.
private func apiFetchFailure(_ error: Error) -> String {
    if let url = error as? URLError {
        return url.code == .timedOut ? "The operation was aborted due to timeout" : "fetch failed"
    }
    return messageOf(error)
}

/// Any service that speaks OpenAI's chat format — OpenAI itself, Google Gemini, OpenRouter,
/// Groq, or one running on this computer — with the student's key. A model that takes
/// images gets the slides as pictures.
public final class OpenAICompatibleProvider: PromptProvider, @unchecked Sendable {
    public let name = "openai-compatible"
    public let seesSlides: Bool
    public let report: ProviderReport
    public let promptsDirectory: URL
    private let service: String
    private let baseURL: String
    private let apiKey: String
    private let model: String
    private let renderer: any SlideRendering
    private let transport: any HTTPTransport
    private let timeout: TimeInterval

    public init(
        service: String,
        baseURL: String,
        apiKey: String,
        model: String,
        seesSlides: Bool,
        renderer: any SlideRendering,
        transport: any HTTPTransport = URLSessionTransport(),
        timeout: TimeInterval = 600,
        promptsDirectory: URL = LockinPaths.promptsDirectory
    ) {
        self.service = service
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.model = model
        self.seesSlides = seesSlides
        self.renderer = renderer
        self.transport = transport
        self.timeout = timeout
        self.promptsDirectory = promptsDirectory
        self.report = ProviderReport()
        report.lastModel = label(model: nil)
    }

    public func label(model: String?) -> String {
        "\(service) · \(apiOr(model, self.model))"
    }

    public func complete(_ prompt: String, options: CallOptions) async throws -> Reply {
        if model.isEmpty {
            throw CloudError("Choose which \(service) model to use, in Settings")
        }
        var pictures: [SlidePicture] = []
        if let slides = options.slides, seesSlides {
            pictures = try slidePictures(slides, renderer: renderer)
        }
        let total = pdfSlideCount(options.slides)
        let content: JSONValue
        if pictures.isEmpty {
            content = .string(prompt)
        } else {
            var parts: [JSONValue] = [["type": "text", "text": .string(prompt + picturesNote(pictures, total: total))]]
            for picture in pictures {
                let png = try apiReadFile(picture.file)
                let image: JSONValue = ["url": .string("data:image/png;base64,\(png.base64EncodedString())")]
                parts.append(["type": "image_url", "image_url": image])
            }
            content = .array(parts)
        }
        let messages: JSONValue = [["role": "user", "content": content]]
        let body: JSONValue = ["model": .string(model), "messages": messages]

        var base = baseURL
        while base.hasSuffix("/") {
            base.removeLast()
        }
        let address = base + "/chat/completions"
        guard let url = URL(string: address), url.scheme != nil else {
            throw CloudError("Couldn't reach \(service): Failed to parse URL from \(address)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = Data(body.stringified().utf8)

        let answered: (Data, HTTPURLResponse)
        do {
            answered = try await transport.send(request)
        } catch {
            if apiWasCancelled(error) {
                throw CancellationError()
            }
            throw CloudError("Couldn't reach \(service): \(apiFetchFailure(error))")
        }
        let (data, response) = answered
        let status = response.statusCode
        // `res.json().catch(() => null)`
        let parsed = try? JSONValue.parse(apiDecodeBody(data))
        guard (200...299).contains(status), let reply = parsed, reply.isTruthy else {
            let why: String
            if case .string(let text)? = parsed?["error"] {
                why = text
            } else if let message = parsed?["error"]?["message"], !message.isNull {
                why = jsString(message)
            } else {
                why = apiReasonPhrase(status)
            }
            let hint = (status == 401 || status == 403) ? " — check the API key in Settings" : ""
            throw CloudError("\(service) said \(status): \(why)\(hint)")
        }

        let choice = Self.firstChoice(reply["choices"])
        let text: String
        switch choice?["message"]?["content"] {
        case .string(let whole)?:
            text = whole
        case .array(let parts)?:
            text = parts.map { part -> String in
                guard let piece = part["text"], !piece.isNull else { return "" }
                return jsString(piece)
            }.joined()
        default:
            text = ""
        }
        if text.trimmingCharacters(in: apiTrimCharacters).isEmpty {
            throw CloudError("\(service) sent back an empty reply")
        }
        if choice?["finish_reason"]?.stringValue == "length" {
            throw CloudError("\(service)'s reply was cut off before it finished")
        }
        return Reply(text: text, model: Self.modelName(reply["model"]))
    }

    /// `body.choices?.[0]`.
    private static func firstChoice(_ choices: JSONValue?) -> JSONValue? {
        switch choices {
        case .array(let items)?:
            return items.first
        case .object(let object)?:
            return object["0"]
        default:
            return nil
        }
    }

    /// `body.model ?? null`, as `label` will show it.
    private static func modelName(_ value: JSONValue?) -> String? {
        guard let value, !value.isNull else { return nil }
        if let name = value.stringValue {
            return name
        }
        return value.isTruthy ? jsString(value) : nil
    }
}
