import Foundation
#if canImport(Darwin)
import Darwin
#endif

// Port of lib/llm/mlx.ts. The MLX engine (swift/LockinEngine, `lockin-engine`) runs
// offline models on Apple Silicon's GPU. One process holds the loaded model between
// requests and answers them one at a time over stdin/stdout, a line of JSON each way:
//
//   → {"id":"1","op":"generate","model":"/path/to/mlx/dir","prompt":"…","images":["/slide.png"],
//      "schema":{…JSON Schema…},"maxTokens":4000,"temperature":0.3}
//   ← {"id":"1","progress":{"tokens":120}}   while it writes, then
//   ← {"id":"1","text":"…"}  or  {"id":"1","error":"…"}
//
// A cancelled request ends the engine — the only way to stop a model mid-answer — and
// the next request starts it again. Anything else it was doing fails.

/// The MLX engine (`engineGenerate` and `stopEngine` in TypeScript): one long-lived
/// `lockin-engine` shared by every lane, started on the first request and stopped after
/// five idle minutes, since an idle engine still holds the model's memory.
public actor MLXEngine: EngineGenerating {
    /// The app's engine (`LockinServices.live()`).
    public static let shared = MLXEngine()

    private let binary: URL?
    private let idleTimeout: TimeInterval
    private var engine: MLXEngineProcess?
    private var nextId = 0
    private var idleTimer: Task<Void, Never>?
    /// Bumped whenever the idle timer is set or cleared, so a timer that already fired
    /// stops nothing once a new request has come in.
    private var idleToken = 0

    /// `binary` nil means `LockinPaths.engineBinary` (`LOCKIN_ENGINE`, the app bundle's
    /// `engine/lockin-engine`, or the repository's build), looked up at first use.
    public init(binary: URL? = nil, idleTimeout: TimeInterval = 300) {
        self.binary = binary
        self.idleTimeout = idleTimeout
    }

    /// Whether offline models can run on MLX here (`mlxAvailable()`): Apple Silicon, with
    /// the engine installed.
    public static var isAvailable: Bool {
        #if arch(arm64)
        return LockinPaths.engineBinary != nil
        #else
        return false
        #endif
    }

    /// One request to the engine. With a schema the reply is valid JSON of that shape.
    /// Cancelling the calling task ends the engine and throws `CancellationError`.
    public func generate(
        model: String,
        prompt: String,
        images: [String],
        schema: JSONValue?,
        maxTokens: Int,
        temperature: Double,
        onTokens: (@Sendable (Int) -> Void)?
    ) async throws -> String {
        try Task.checkCancellation()
        cancelIdleTimer()
        let process = try running()
        nextId += 1
        let id = String(nextId)
        let line = MLXEngine.requestLine(
            id: id,
            model: model,
            prompt: prompt,
            images: images,
            schema: schema,
            maxTokens: maxTokens,
            temperature: temperature
        )
        let text: String
        do {
            text = try await process.request(id: id, line: line, onTokens: onTokens)
        } catch {
            requestEnded()
            if error is CancellationError || Task.isCancelled {
                throw CancellationError()
            }
            throw error
        }
        requestEnded()
        return text
    }

    /// Ends the engine, freeing the model's memory. Anything it was doing fails with
    /// "the MLX engine stopped (SIGKILL)".
    public func stop() {
        cancelIdleTimer()
        engine?.forceStop()
        engine = nil
    }

    /// The request as the engine reads it: `JSON.stringify({ id, op: "generate", ...body })`
    /// and a newline. `images` goes in only when there are some, `schema` only when given.
    static func requestLine(
        id: String,
        model: String,
        prompt: String,
        images: [String],
        schema: JSONValue?,
        maxTokens: Int,
        temperature: Double
    ) -> String {
        var body = JSONObject()
        body["id"] = .string(id)
        body["op"] = .string("generate")
        body["model"] = .string(model)
        body["prompt"] = .string(prompt)
        if !images.isEmpty {
            body["images"] = .strings(images)
        }
        if let schema {
            body["schema"] = schema
        }
        body["maxTokens"] = .int(maxTokens)
        body["temperature"] = .number(temperature)
        var line = JSONValue.object(body).stringified()
        // JSON.stringify leaves these as they are, but the engine reads its input a line at
        // a time with Foundation's line reader, which also ends a line at each of them: a
        // transcript holding one would reach it as two halves of a request and never be
        // answered. Escaped, the engine reads the very same text.
        for (character, escape) in mlxLineBreakEscapes {
            line = line.replacingOccurrences(of: character, with: escape)
        }
        return line + "\n"
    }

    // MARK: - The process

    /// The running engine, or a new one: the last one may have stopped, been stopped or
    /// never started.
    private func running() throws -> MLXEngineProcess {
        if let engine, engine.isAlive {
            return engine
        }
        engine = nil
        guard let binary = binary ?? LockinPaths.engineBinary else {
            throw LockinError("the MLX engine isn't installed")
        }
        let started = try MLXEngineProcess.launch(binary)
        engine = started
        return started
    }

    /// A request finished: with nothing else waiting, the engine is let go after a while.
    private func requestEnded() {
        guard let engine, engine.isAlive, engine.pendingCount == 0 else { return }
        scheduleIdleStop()
    }

    private func scheduleIdleStop() {
        idleTimer?.cancel()
        idleToken += 1
        let token = idleToken
        let nanoseconds = UInt64(min(max(0, idleTimeout), 86_400 * 365) * 1_000_000_000)
        idleTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            if Task.isCancelled {
                return
            }
            await self?.idleExpired(token)
        }
    }

    private func idleExpired(_ token: Int) {
        guard token == idleToken else { return }
        idleTimer = nil
        if let engine, engine.pendingCount > 0 {
            return
        }
        engine?.forceStop()
        engine = nil
    }

    private func cancelIdleTimer() {
        idleTimer?.cancel()
        idleTimer = nil
        idleToken += 1
    }
}

/// Line ends besides "\n" that JSON.stringify writes as they are, with their escapes.
private let mlxLineBreakEscapes: [(String, String)] = [
    ("\u{0085}", "\\u0085"),
    ("\u{2028}", "\\u2028"),
    ("\u{2029}", "\\u2029"),
]

// MARK: - One running engine

/// One `lockin-engine` process and the requests waiting on it. Its output and error
/// streams are read on threads of their own and its input is written on a queue of its
/// own, so a long prompt never holds up the actor; everything shared is behind `lock`.
final class MLXEngineProcess: @unchecked Sendable {
    private struct Waiting {
        let continuation: CheckedContinuation<String, Error>
        let onTokens: (@Sendable (Int) -> Void)?
    }

    private let process: Process
    private let input: FileHandle
    private let lock = NSLock()
    /// Entered once for each stream being read; left when it ends.
    private let streams = DispatchGroup()
    private let inputQueue = DispatchQueue(label: "app.lockin.mlx-engine.stdin")
    private var waiting: [String: Waiting] = [:]
    /// Output not yet ended by a newline.
    private var output = Data()
    /// The end of what it printed on stderr, for the message when it stops.
    private var log = Data()
    /// Killed on purpose: no new request goes to it.
    private var stopped = false
    /// Why it stopped, once it has.
    private var gone: String?
    /// Only touched on `inputQueue`.
    private var inputClosed = false

    private init(process: Process, input: FileHandle) {
        self.process = process
        self.input = input
    }

    /// Starts the engine from its own folder, as the worker does.
    static func launch(_ binary: URL) throws -> MLXEngineProcess {
        let process = Process()
        process.executableURL = binary
        process.arguments = []
        process.currentDirectoryURL = binary.deletingLastPathComponent()
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        let engine = MLXEngineProcess(process: process, input: stdinPipe.fileHandleForWriting)
        process.terminationHandler = { _ in
            // Off Foundation's own thread: this waits for the last of the output.
            DispatchQueue.global(qos: .userInitiated).async {
                engine.exited()
            }
        }
        #if canImport(Darwin)
        // Writing to an engine that has died must fail with EPIPE, not end the app with SIGPIPE.
        _ = fcntl(stdinPipe.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        #endif
        engine.streams.enter()
        engine.streams.enter()
        do {
            try process.run()
        } catch {
            engine.streams.leave()
            engine.streams.leave()
            process.terminationHandler = nil
            throw LockinError("the MLX engine couldn't start: \(mlxSpawnFailure(binary.path, error))")
        }
        engine.pump(stdoutPipe.fileHandleForReading, isOutput: true)
        engine.pump(stderrPipe.fileHandleForReading, isOutput: false)
        return engine
    }

    /// Running, and not stopped on purpose.
    var isAlive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !stopped && gone == nil
    }

    var pendingCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return waiting.count
    }

    /// Sends one request and waits for its answer. Cancelling the task kills the engine.
    func request(id: String, line: String, onTokens: (@Sendable (Int) -> Void)?) async throws -> String {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                self.enqueue(id: id, line: line, continuation: continuation, onTokens: onTokens)
            }
        } onCancel: {
            self.cancel(id: id)
        }
    }

    /// SIGKILL. The requests it leaves fail once it has gone.
    func forceStop() {
        lock.lock()
        stopped = true
        lock.unlock()
        let pid = process.processIdentifier
        if pid > 0 && process.isRunning {
            _ = kill(pid, SIGKILL)
        }
    }

    private func enqueue(
        id: String,
        line: String,
        continuation: CheckedContinuation<String, Error>,
        onTokens: (@Sendable (Int) -> Void)?
    ) {
        lock.lock()
        if Task.isCancelled {
            // Cancelled before it was sent: nothing to stop.
            lock.unlock()
            continuation.resume(throwing: CancellationError())
            return
        }
        if let gone {
            lock.unlock()
            continuation.resume(throwing: LockinError(gone))
            return
        }
        waiting[id] = Waiting(continuation: continuation, onTokens: onTokens)
        lock.unlock()
        writeLine(line)
    }

    private func cancel(id: String) {
        lock.lock()
        let request = waiting.removeValue(forKey: id)
        lock.unlock()
        guard let request else { return }
        forceStop()
        request.continuation.resume(throwing: CancellationError())
    }

    private func writeLine(_ line: String) {
        let bytes = Array(line.utf8)
        inputQueue.async { [self] in
            if inputClosed {
                return
            }
            let fd = input.fileDescriptor
            var offset = 0
            while offset < bytes.count {
                let written = bytes.withUnsafeBytes { raw -> Int in
                    guard let base = raw.baseAddress else { return -1 }
                    return write(fd, base + offset, raw.count - offset)
                }
                if written > 0 {
                    offset += written
                } else if written < 0 && errno == EINTR {
                    continue
                } else {
                    // The engine is gone (EPIPE); its exit fails the request.
                    return
                }
            }
        }
    }

    private func closeInput() {
        inputQueue.async { [self] in
            if inputClosed {
                return
            }
            inputClosed = true
            try? input.close()
        }
    }

    /// Reads a stream to its end on a thread of its own, handing on each chunk as it comes.
    private func pump(_ handle: FileHandle, isOutput: Bool) {
        let fd = handle.fileDescriptor
        DispatchQueue.global(qos: .userInitiated).async {
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while true {
                let count = buffer.withUnsafeMutableBytes { raw -> Int in
                    guard let base = raw.baseAddress else { return 0 }
                    return read(fd, base, raw.count)
                }
                if count > 0 {
                    let chunk = Data(buffer[0..<count])
                    if isOutput {
                        self.received(chunk)
                    } else {
                        self.logged(chunk)
                    }
                } else if count < 0 && errno == EINTR {
                    continue
                } else {
                    break
                }
            }
            try? handle.close()
            self.streams.leave()
        }
    }

    /// Whole lines of output, each routed to the request it answers. Progress is passed on
    /// before the answer that follows it, in the order the engine wrote them.
    private func received(_ chunk: Data) {
        var deliveries: [() -> Void] = []
        lock.lock()
        output.append(chunk)
        while let newline = output.firstIndex(of: 0x0A) {
            let line = String(decoding: output[output.startIndex..<newline], as: UTF8.self)
            output.removeSubrange(output.startIndex...newline)
            if let delivery = route(line) {
                deliveries.append(delivery)
            }
        }
        lock.unlock()
        for delivery in deliveries {
            delivery()
        }
    }

    /// What one line of output means for the requests waiting (called under `lock`). Lines
    /// that are not JSON are the libraries' own chatter; lines for no waiting request are
    /// ignored too.
    private func route(_ line: String) -> (() -> Void)? {
        guard let message = try? JSONValue.parse(line),
              case .object(let fields) = message,
              case .string(let id)? = fields["id"],
              !id.isEmpty,
              let request = waiting[id] else {
            return nil
        }
        if let progress = fields["progress"], progress.isTruthy {
            guard let onTokens = request.onTokens else { return nil }
            let tokens = mlxTokenCount(progress)
            return { onTokens(tokens) }
        }
        waiting[id] = nil
        if let error = fields["error"] {
            let failure = LockinError("MLX: \(mlxPlainly(error.stringValue ?? jsString(error)))")
            return { request.continuation.resume(throwing: failure) }
        }
        let text: String
        switch fields["text"] {
        case .none, .some(.null):
            text = ""
        case .some(.string(let value)):
            text = value
        case .some(let other):
            text = jsString(other)
        }
        return { request.continuation.resume(returning: text) }
    }

    private func logged(_ chunk: Data) {
        lock.lock()
        log.append(chunk)
        if log.count > 8_192 {
            log = Data(log.suffix(8_192))
        }
        lock.unlock()
    }

    /// The engine has gone: every request still waiting fails, with its last words.
    private func exited() {
        // Its last output and words are read first (a stream another process still holds
        // open is not waited for long).
        _ = streams.wait(timeout: .now() + 2)
        let reason: String
        if process.terminationReason == .uncaughtSignal {
            reason = mlxSignalName(process.terminationStatus)
        } else {
            reason = "exit \(process.terminationStatus)"
        }
        lock.lock()
        let tail = mlxLastLine(of: log)
        let why = "the MLX engine stopped (\(reason))" + (tail.isEmpty ? "" : ": \(tail)")
        gone = why
        let left = Array(waiting.values)
        waiting.removeAll()
        lock.unlock()
        for request in left {
            request.continuation.resume(throwing: LockinError(why))
        }
        closeInput()
        process.terminationHandler = nil
    }
}

// MARK: - Helpers

/// The guided generation library's errors arrive as "…GuidedGenerationError error 0." (`plainly`).
func mlxPlainly(_ error: String) -> String {
    let text = error as NSString
    if text.range(of: "GuidedGenerationError error 0").location != NSNotFound {
        return "the model ran out of room before finishing its answer — try again, or a larger model"
    }
    if text.range(of: "GuidedGenerationError error 1").location != NSNotFound {
        return "the model stopped before finishing its answer — try again"
    }
    return error
}

/// `message.progress.tokens ?? 0`.
private func mlxTokenCount(_ progress: JSONValue) -> Int {
    guard case .object(let fields) = progress, let tokens = fields["tokens"], !tokens.isNull else { return 0 }
    let number = jsNumberValue(tokens)
    guard number.isFinite else { return 0 }
    return Int(max(-1e15, min(1e15, number)))
}

/// `log.trim().split("\n").at(-1)` over the last 2000 characters it printed.
private func mlxLastLine(of log: Data) -> String {
    let text = String(decoding: log, as: UTF8.self)
    let units = text.utf16Count
    let kept = units > 2_000 ? text.utf16DropFirst(units - 2_000) : text
    let trimmed = kept.trimmingCharacters(in: mlxTrimCharacters)
    let lines = trimmed.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false)
    guard let last = lines.last else { return "" }
    return String(String.UnicodeScalarView(last))
}

/// JavaScript's white space and line ends, which `String.prototype.trim` removes.
private let mlxTrimCharacters: CharacterSet = {
    var set = CharacterSet.whitespacesAndNewlines
    set.insert(charactersIn: "\u{FEFF}")
    set.remove(charactersIn: "\u{0085}")
    return set
}()

/// Node's name for the signal that ended a process ("SIGKILL").
private func mlxSignalName(_ signal: Int32) -> String {
    switch signal {
    case SIGHUP: return "SIGHUP"
    case SIGINT: return "SIGINT"
    case SIGQUIT: return "SIGQUIT"
    case SIGILL: return "SIGILL"
    case SIGTRAP: return "SIGTRAP"
    case SIGABRT: return "SIGABRT"
    case SIGFPE: return "SIGFPE"
    case SIGKILL: return "SIGKILL"
    case SIGBUS: return "SIGBUS"
    case SIGSEGV: return "SIGSEGV"
    case SIGSYS: return "SIGSYS"
    case SIGPIPE: return "SIGPIPE"
    case SIGALRM: return "SIGALRM"
    case SIGTERM: return "SIGTERM"
    case SIGXCPU: return "SIGXCPU"
    case SIGXFSZ: return "SIGXFSZ"
    case SIGUSR1: return "SIGUSR1"
    case SIGUSR2: return "SIGUSR2"
    default: return "signal \(signal)"
    }
}

/// Node's wording for an engine that would not start: "spawn /path/lockin-engine ENOENT".
private func mlxSpawnFailure(_ path: String, _ error: Error) -> String {
    let bridged = error as NSError
    var code: Int32?
    if bridged.domain == NSPOSIXErrorDomain {
        code = Int32(truncatingIfNeeded: bridged.code)
    } else if bridged.domain == NSCocoaErrorDomain {
        switch bridged.code {
        case CocoaError.Code.fileNoSuchFile.rawValue, CocoaError.Code.fileReadNoSuchFile.rawValue:
            code = ENOENT
        case CocoaError.Code.fileReadNoPermission.rawValue, CocoaError.Code.fileWriteNoPermission.rawValue:
            code = EACCES
        default:
            if let underlying = bridged.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSPOSIXErrorDomain {
                code = Int32(truncatingIfNeeded: underlying.code)
            }
        }
    }
    if code == ENOENT {
        return "spawn \(path) ENOENT"
    }
    if code == EACCES {
        return "spawn \(path) EACCES"
    }
    return messageOf(error)
}
