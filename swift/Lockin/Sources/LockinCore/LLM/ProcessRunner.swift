import Foundation
#if canImport(Darwin)
import Darwin
#endif

// Port of lib/llm/process.ts (`runTool`, `lastLine`), and of the PATH the Electron app
// hands its worker (`searchPath` in electron/main.ts): an AI command-line tool runs with
// the prompt on stdin, from a neutral folder, and is killed when it takes too long or
// when its job is cancelled.

/// What a finished command printed, and how it exited.
public struct ProcessResult: Equatable, Sendable {
    public var stdout: String
    public var stderr: String
    /// The exit status; nil when a signal ended it (Node's `code: null`).
    public var code: Int32?

    public init(stdout: String, stderr: String, code: Int32?) {
        self.stdout = stdout
        self.stderr = stderr
        self.code = code
    }
}

/// How a run ended without the command closing by itself. Each caller words these its
/// own way (`runTool` and `runClaude` say a timeout differently).
enum ProcessRunFailure: Error, Equatable, Sendable {
    /// The time ran out; the command was killed.
    case timedOut
    /// It never started. Carries Node's spawn error message ("spawn claude ENOENT").
    case couldNotRun(String)
}

public enum ProcessRunner {
    /// `runTool(binary, args, input, { timeoutMs, what, install, cwd })`: runs an AI
    /// command-line tool with `input` on stdin (a transcript is far past the longest
    /// command line allowed), from a neutral folder so it picks up no project's own
    /// instructions, and gives up after `timeout` seconds, since some tools wait for a
    /// sign-in forever. A cancelled task kills it (SIGKILL) and throws `CancellationError`.
    ///
    /// `environment` is the one to run under (this process's by default); the command is
    /// looked up on `searchPath(environment:)`, which the command also gets as its PATH.
    public static func run(
        _ binary: String,
        arguments: [String],
        input: String,
        timeout: TimeInterval,
        what: String,
        install: String,
        workingDirectory: URL? = nil,
        environment: [String: String]? = nil
    ) async throws -> ProcessResult {
        do {
            return try await execute(
                binary,
                arguments: arguments,
                input: input,
                timeout: timeout,
                workingDirectory: workingDirectory,
                environment: environment
            )
        } catch ProcessRunFailure.timedOut {
            throw CloudError("\(what) gave no answer after \(jsNumberString(jsMathRound(timeout)))s")
        } catch ProcessRunFailure.couldNotRun(let reason) {
            throw CloudError("could not run \"\(binary)\" (\(reason)). \(install)")
        }
    }

    /// The last useful line a failed tool printed, for the error shown to the student.
    public static func lastLine(_ text: String) -> String {
        let lines = cliLines(text).map { cliTrim($0) }.filter { !$0.isEmpty }
        return (lines.last ?? "").utf16Prefix(400)
    }

    /// Where `name` would be run from: the first executable file of that name on
    /// `searchPath(environment:)`, or `name` itself when it is a path. Nil when there is none.
    public static func resolveExecutable(_ name: String, environment: [String: String]) -> String? {
        guard !name.isEmpty else { return nil }
        let location = locate(
            name,
            in: searchPath(environment: environment),
            workingDirectory: FileManager.default.temporaryDirectory
        )
        if case .found(let path) = location {
            return path
        }
        return nil
    }

    /// The folders a command is looked for in, in order (`searchPath()` in electron/main.ts).
    /// An app opened from the Finder inherits launchd's PATH, which has none of the places a
    /// CLI actually lives, so `claude` would be missing in the app and present from a
    /// terminal. The usual install folders come first, then PATH, then the system's own.
    /// Claude Code's own local install (`~/.claude/local`) is looked in last.
    public static func searchPath(environment: [String: String]) -> [String] {
        let home = homeDirectory(environment) as NSString
        let extra = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            home.appendingPathComponent(".local/bin"),
            home.appendingPathComponent(".bun/bin"),
            home.appendingPathComponent(".npm-global/bin"),
        ]
        let current = (environment["PATH"] ?? "").components(separatedBy: ":").filter { !$0.isEmpty }
        let system = ["/usr/bin", "/bin", home.appendingPathComponent(".claude/local")]
        var seen = Set<String>()
        var folders: [String] = []
        for folder in extra + current + system where seen.insert(folder).inserted {
            folders.append(folder)
        }
        return folders
    }

    // MARK: - Running

    /// Runs a command to the end: its output once it has exited and closed both streams
    /// (Node's "close"). Throws `ProcessRunFailure` when it times out or cannot start, and
    /// `CancellationError` when the task is cancelled (the command is killed).
    static func execute(
        _ binary: String,
        arguments: [String],
        input: String,
        timeout: TimeInterval,
        workingDirectory: URL? = nil,
        environment: [String: String]? = nil
    ) async throws -> ProcessResult {
        if binary.isEmpty {
            // spawn("") throws before anything starts (Node's ERR_INVALID_ARG_VALUE).
            throw LockinError("The argument 'file' cannot be empty. Received ''")
        }
        let base = environment ?? ProcessInfo.processInfo.environment
        let folders = searchPath(environment: base)
        var childEnvironment = base
        childEnvironment["PATH"] = folders.joined(separator: ":")
        let run = ProcessRun(
            binary: binary,
            arguments: arguments,
            input: Data(input.utf8),
            timeout: timeout,
            directory: workingDirectory ?? FileManager.default.temporaryDirectory,
            searchPath: folders,
            environment: childEnvironment
        )
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<ProcessResult, Error>) in
                run.start(continuation)
            }
        } onCancel: {
            run.cancel()
        }
    }

    /// How long setTimeout would wait for `timeout` seconds: anything below 1 ms or past
    /// its limit (NaN included) waits 1 ms.
    static func timerDelay(_ timeout: TimeInterval) -> TimeInterval {
        let ms = timeout * 1000
        guard ms >= 1 && ms <= 2_147_483_647 else { return 0.001 }
        return ms / 1000
    }

    // MARK: - Finding the command

    enum Location: Equatable {
        case found(String)
        /// Not runnable: the error code execvp would give ("ENOENT", "EACCES").
        case missing(String)
    }

    private enum FileState {
        case runnable
        case notRunnable
        case absent
    }

    /// execvp's lookup: a name with a slash is used as it is (relative to the working
    /// folder); a bare name is tried in each folder in turn, skipping files that can't be
    /// run, and reports EACCES rather than ENOENT when it found only those.
    static func locate(_ binary: String, in folders: [String], workingDirectory: URL) -> Location {
        if binary.contains("/") {
            let candidate = binary.hasPrefix("/") ? binary : (workingDirectory.path as NSString).appendingPathComponent(binary)
            switch fileState(candidate) {
            case .runnable: return .found(candidate)
            case .notRunnable: return .missing("EACCES")
            case .absent: return .missing("ENOENT")
            }
        }
        var denied = false
        for folder in folders {
            let base = folder.hasPrefix("/") ? folder : (workingDirectory.path as NSString).appendingPathComponent(folder)
            let candidate = (base as NSString).appendingPathComponent(binary)
            switch fileState(candidate) {
            case .runnable: return .found(candidate)
            case .notRunnable: denied = true
            case .absent: continue
            }
        }
        return .missing(denied ? "EACCES" : "ENOENT")
    }

    private static func fileState(_ path: String) -> FileState {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else { return .absent }
        if isDirectory.boolValue || !FileManager.default.isExecutableFile(atPath: path) {
            return .notRunnable
        }
        return .runnable
    }

    private static func homeDirectory(_ environment: [String: String]) -> String {
        if let home = environment["HOME"], !home.isEmpty {
            return home
        }
        return NSHomeDirectory()
    }

    /// Node's wording for a command that would not start: "spawn claude EACCES".
    static func spawnFailure(_ binary: String, _ error: Error) -> String {
        let bridged = error as NSError
        if bridged.domain == NSPOSIXErrorDomain {
            return "spawn \(binary) \(errnoName(Int32(truncatingIfNeeded: bridged.code)))"
        }
        if bridged.domain == NSCocoaErrorDomain {
            switch bridged.code {
            case CocoaError.Code.fileNoSuchFile.rawValue, CocoaError.Code.fileReadNoSuchFile.rawValue:
                return "spawn \(binary) ENOENT"
            case CocoaError.Code.fileReadNoPermission.rawValue, CocoaError.Code.fileWriteNoPermission.rawValue:
                return "spawn \(binary) EACCES"
            default:
                break
            }
            if let underlying = bridged.userInfo[NSUnderlyingErrorKey] as? NSError, underlying.domain == NSPOSIXErrorDomain {
                return "spawn \(binary) \(errnoName(Int32(truncatingIfNeeded: underlying.code)))"
            }
        }
        return "spawn \(binary) \(messageOf(error))"
    }

    private static func errnoName(_ code: Int32) -> String {
        switch code {
        case EPERM: return "EPERM"
        case ENOENT: return "ENOENT"
        case EIO: return "EIO"
        case E2BIG: return "E2BIG"
        case ENOEXEC: return "ENOEXEC"
        case EBADF: return "EBADF"
        case ENOMEM: return "ENOMEM"
        case EACCES: return "EACCES"
        case EFAULT: return "EFAULT"
        case EBUSY: return "EBUSY"
        case ENOTDIR: return "ENOTDIR"
        case EISDIR: return "EISDIR"
        case EINVAL: return "EINVAL"
        case ENFILE: return "ENFILE"
        case EMFILE: return "EMFILE"
        case ETXTBSY: return "ETXTBSY"
        case EAGAIN: return "EAGAIN"
        case ELOOP: return "ELOOP"
        case ENAMETOOLONG: return "ENAMETOOLONG"
        default: return "errno \(code)"
        }
    }
}

// MARK: - One run

/// One command from start to finish. Every path out (closed, timed out, cancelled, would
/// not start) goes through `finish`, which resumes the caller exactly once.
final class ProcessRun: @unchecked Sendable {
    private let binary: String
    private let arguments: [String]
    private let input: Data
    private let timeout: TimeInterval
    private let directory: URL
    private let searchPath: [String]
    private let environment: [String: String]

    private let lock = NSLock()
    private var continuation: CheckedContinuation<ProcessResult, Error>?
    private var cancelled = false
    private var done = false
    private var process: Process?
    private var timer: DispatchWorkItem?
    private var stdoutData = Data()
    private var stderrData = Data()
    private var openStreams = 2
    private var exited = false
    private var exitCode: Int32?

    init(
        binary: String,
        arguments: [String],
        input: Data,
        timeout: TimeInterval,
        directory: URL,
        searchPath: [String],
        environment: [String: String]
    ) {
        self.binary = binary
        self.arguments = arguments
        self.input = input
        self.timeout = timeout
        self.directory = directory
        self.searchPath = searchPath
        self.environment = environment
    }

    func start(_ continuation: CheckedContinuation<ProcessResult, Error>) {
        lock.lock()
        if cancelled {
            lock.unlock()
            continuation.resume(throwing: CancellationError())
            return
        }
        self.continuation = continuation
        lock.unlock()

        let executable: String
        switch ProcessRunner.locate(binary, in: searchPath, workingDirectory: directory) {
        case .found(let path):
            executable = path
        case .missing(let code):
            finish(.failure(ProcessRunFailure.couldNotRun("spawn \(binary) \(code)")))
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = directory
        process.environment = environment
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.terminationHandler = { [weak self] ended in
            self?.processExited(ended)
        }

        lock.lock()
        let stoppedEarly = done
        lock.unlock()
        if stoppedEarly {
            return
        }

        do {
            try process.run()
        } catch {
            finish(.failure(ProcessRunFailure.couldNotRun(ProcessRunner.spawnFailure(binary, error))))
            return
        }

        lock.lock()
        self.process = process
        let stoppedWhileStarting = done
        lock.unlock()
        if stoppedWhileStarting {
            // Cancelled while it was starting: nothing is waiting for it any more.
            ProcessRun.forceKill(process)
            return
        }

        collect(stdoutPipe.fileHandleForReading, isStdout: true)
        collect(stderrPipe.fileHandleForReading, isStdout: false)
        feed(input, to: stdinPipe.fileHandleForWriting)
        scheduleTimeout()
    }

    /// The task was cancelled: kill the command at once and stop waiting for it.
    func cancel() {
        lock.lock()
        cancelled = true
        let process = self.process
        let finished = done
        lock.unlock()
        if finished {
            return
        }
        if let process {
            ProcessRun.forceKill(process)
        }
        finish(.failure(CancellationError()))
    }

    /// Reads a stream to its end on a thread of its own.
    private func collect(_ handle: FileHandle, isStdout: Bool) {
        DispatchQueue.global(qos: .userInitiated).async {
            var collected = Data()
            while true {
                guard let chunk = try? handle.read(upToCount: 65_536), !chunk.isEmpty else { break }
                collected.append(chunk)
            }
            try? handle.close()
            self.streamClosed(isStdout: isStdout, data: collected)
        }
    }

    /// Writes the input and closes stdin, on a thread of its own: a long prompt fills the
    /// pipe until the command reads it. A command that exits without reading closes the
    /// pipe; its exit code says why, so a failed write is ignored.
    private func feed(_ data: Data, to handle: FileHandle) {
        DispatchQueue.global(qos: .userInitiated).async {
            #if canImport(Darwin)
            // Writing to a pipe nobody reads must fail with EPIPE, not end the app with SIGPIPE.
            _ = fcntl(handle.fileDescriptor, F_SETNOSIGPIPE, 1)
            #endif
            if !data.isEmpty {
                try? handle.write(contentsOf: data)
            }
            try? handle.close()
        }
    }

    private func scheduleTimeout() {
        let item = DispatchWorkItem { [weak self] in
            self?.timedOut()
        }
        lock.lock()
        if done {
            lock.unlock()
            return
        }
        timer = item
        lock.unlock()
        DispatchQueue.global(qos: .userInitiated).asyncAfter(
            deadline: .now() + ProcessRunner.timerDelay(timeout),
            execute: item
        )
    }

    private func timedOut() {
        lock.lock()
        let process = self.process
        let finished = done
        lock.unlock()
        if finished {
            return
        }
        if let process {
            ProcessRun.forceKill(process)
        }
        finish(.failure(ProcessRunFailure.timedOut))
    }

    private func processExited(_ ended: Process) {
        let code: Int32? = ended.terminationReason == .exit ? ended.terminationStatus : nil
        lock.lock()
        exited = true
        exitCode = code
        let ready = openStreams == 0
        lock.unlock()
        if ready {
            completeNormally()
        }
    }

    private func streamClosed(isStdout: Bool, data: Data) {
        lock.lock()
        if isStdout {
            stdoutData = data
        } else {
            stderrData = data
        }
        openStreams -= 1
        let ready = exited && openStreams == 0
        lock.unlock()
        if ready {
            completeNormally()
        }
    }

    private func completeNormally() {
        lock.lock()
        let result = ProcessResult(
            stdout: String(decoding: stdoutData, as: UTF8.self),
            stderr: String(decoding: stderrData, as: UTF8.self),
            code: exitCode
        )
        lock.unlock()
        finish(.success(result))
    }

    private func finish(_ result: Result<ProcessResult, Error>) {
        lock.lock()
        if done {
            lock.unlock()
            return
        }
        done = true
        let continuation = self.continuation
        self.continuation = nil
        let timer = self.timer
        self.timer = nil
        lock.unlock()
        timer?.cancel()
        continuation?.resume(with: result)
    }

    /// SIGKILL, as the TypeScript does; only a process that was started and is still running.
    static func forceKill(_ process: Process) {
        let pid = process.processIdentifier
        guard pid > 0, process.isRunning else { return }
        _ = kill(pid, SIGKILL)
    }
}

// MARK: - JavaScript string helpers shared by the CLI providers

/// JavaScript's white space and line ends, which `String.prototype.trim` removes.
private let cliTrimCharacters: CharacterSet = {
    var set = CharacterSet.whitespacesAndNewlines
    set.insert(charactersIn: "\u{FEFF}")
    set.remove(charactersIn: "\u{0085}")
    return set
}()

/// `text.trim()`.
func cliTrim(_ text: String) -> String {
    text.trimmingCharacters(in: cliTrimCharacters)
}

/// `text.split("\n")`: split at every U+000A, keeping "\r" and empty parts.
func cliLines(_ text: String) -> [String] {
    text.unicodeScalars
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { String(String.UnicodeScalarView($0)) }
}
