import Foundation
import GRDB

// Port of lib/llm/download.ts (the MLX half — this app runs models on MLX only) and of
// the model actions around it: the registry writes of lib/models.ts (registerModel,
// removeModel, linkModel), the DOWNLOAD jobs of app/actions.ts (requestDownload,
// cancelDownload) and the progress reads of lib/models.ts (downloads()).
//
// The worker's side (worker/index.ts downloadOne) runs in the queue's download lane
// (JobQueue.swift). A download is a job like any other, so it survives the app being
// closed and is shared with the Electron worker through the same rows.

// MARK: - The MLX downloader (lib/llm/download.ts)

/// One file in a model's Hugging Face tree, as the listing reports it.
public struct MlxTreeFile: Equatable, Sendable {
    public var path: String
    public var size: Int

    public init(path: String, size: Int) {
        self.path = path
        self.size = size
    }
}

private let readmeRe = Regex.compile(#"(^|/)(README\.md|\.gitattributes)$"#, options: [.caseInsensitive])
private let pictureRe = Regex.compile(#"\.(png|jpe?g|gif)$"#, options: [.caseInsensitive])

/// The files of a model tree worth downloading (`downloadMlxModel`'s filter): real files
/// only, without READMEs, .gitattributes, or pictures.
public func mlxFilesToFetch(_ listing: JSONValue) -> [MlxTreeFile] {
    guard case .array(let items) = listing else { return [] }
    return items.compactMap { item in
        guard case .object(let fields) = item,
              fields["type"]?.stringValue == "file",
              let path = fields["path"]?.stringValue else {
            return nil
        }
        if Regex.test(readmeRe, in: path) || Regex.test(pictureRe, in: path) {
            return nil
        }
        return MlxTreeFile(path: path, size: fields["size"]?.intValue ?? 0)
    }
}

/// The listing of a model's files (`…/api/models/<mlx>/tree/main?recursive=true`), and
/// where a file of it is downloaded from. Injected in tests.
public struct MlxEndpoints: Sendable {
    public var listing: @Sendable (String) -> URL
    public var file: @Sendable (String, String) -> URL

    /// Hugging Face, as the Electron worker uses it.
    public static let huggingFace = MlxEndpoints(
        listing: { repo in
            URL(string: "https://huggingface.co/api/models/\(repo)/tree/main?recursive=true")!
        },
        file: { repo, path in
            URL(string: "https://huggingface.co/\(repo)/resolve/main/\(path)")!
        }
    )
}

/// `sizeOf(file)` in the worker: the file's size, or -1 when it is not there.
private func sizeOfFile(at path: String) -> Int {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
          let size = attrs[.size] as? NSNumber else {
        return -1
    }
    return size.intValue
}

/// Downloads a model's MLX copy — a folder of weights, config and tokenizer files from
/// Hugging Face — into `<dir>/mlx/<model id>`. A file already complete is skipped and a
/// partial one carries on from where it stopped, so a stopped download resumes
/// (`.part` files are kept). Cancelling the task stops it the same way.
public func downloadMlxModel(
    _ model: LocalModel,
    dir: URL,
    onProgress: @escaping @Sendable (_ downloaded: Int, _ total: Int) -> Void,
    session: URLSession = .shared,
    endpoints: MlxEndpoints = .huggingFace
) async throws -> (path: String, bytes: Int) {
    guard let repo = model.mlx else {
        throw LockinError("\(model.name) has no MLX version")
    }
    let files: [MlxTreeFile]
    do {
        let (data, response) = try await session.data(from: endpoints.listing(repo))
        guard (response as? HTTPURLResponse)?.statusCode != 404 else {
            throw LockinError("\(model.name) has no MLX version on Hugging Face yet — use llama.cpp for it")
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw LockinError("Hugging Face answered \((response as? HTTPURLResponse)?.statusCode ?? -1)")
        }
        files = mlxFilesToFetch(try JSONValue.parse(data: data))
    } catch is CancellationError {
        throw CancellationError()
    } catch let error as LockinError {
        throw error
    } catch {
        throw LockinError(messageOf(error))
    }

    let total = files.reduce(0) { $0 + $1.size }
    let dest = dir.appendingPathComponent("mlx", isDirectory: true).appendingPathComponent(model.id, isDirectory: true)
    let files_ = FileManager.default
    var done = 0
    for file in files {
        let to = dest.appendingPathComponent(file.path).path
        if sizeOfFile(at: to) == file.size {
            done += file.size
            continue
        }
        try files_.createDirectory(atPath: (to as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let partial = to + ".part"
        let from = max(0, sizeOfFile(at: partial))
        var request = URLRequest(url: endpoints.file(repo, file.path))
        if from > 0 {
            request.setValue("bytes=\(from)-", forHTTPHeaderField: "Range")
        }
        // Streamed to the .part file as the bytes arrive, a chunk at a time — a several-GB
        // weights file is never held in memory. The writer's count includes the offset a
        // resume starts from, so `base` stays the bytes finished before this file.
        let base = done
        let writer = PartFileWriter(path: partial, resumeFrom: from)
        do {
            try await streamToFile(request: request, session: session, writer: writer) { received in
                onProgress(base + received, total)
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw LockinError("\(file.path): \(messageOf(error))")
        }
        // The server may have closed early: a short file stays .part and is retried whole.
        let written = sizeOfFile(at: partial)
        if written != file.size {
            throw LockinError("\(file.path) stopped at \(written < 0 ? 0 : written) of \(file.size) bytes — try again and it resumes")
        }
        try files_.moveItem(atPath: partial, toPath: to)
        done += file.size
    }
    onProgress(total, total)
    return (path: dest.path, bytes: total)
}

/// Streams one request's body into a `.part` file, so the progress comes as the bytes
/// arrive and nothing is buffered whole. 200 starts the file again; 206 continues it
/// (`pipeline(body, createWriteStream(…, { flags }))`).
private func streamToFile(
    request: URLRequest,
    session: URLSession,
    writer: PartFileWriter,
    onProgress: @escaping @Sendable (Int) -> Void
) async throws {
    let runner = StreamRunner(onProgress: onProgress, writer: writer)
    let dedicated = URLSession(configuration: session.configuration, delegate: runner, delegateQueue: nil)
    defer { dedicated.finishTasksAndInvalidate() }
    let task = dedicated.dataTask(with: request)
    try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            runner.continuation = continuation
            task.resume()
        }
    } onCancel: {
        task.cancel()
    }
}

/// The delegate for one streamed download. Appends to the `.part` file (or truncates it
/// for a 200) and reports the count as chunks land.
private final class StreamRunner: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let onProgress: @Sendable (Int) -> Void
    private let writer: PartFileWriter
    private var received = 0
    var continuation: CheckedContinuation<Void, Error>?
    private let lock = NSLock()

    init(onProgress: @escaping @Sendable (Int) -> Void, writer: PartFileWriter) {
        self.onProgress = onProgress
        self.writer = writer
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 || status == 206 else {
            continuation?.resume(throwing: LockinError("the server answered \(status)"))
            continuation = nil
            completionHandler(.cancel)
            return
        }
        let resumed = status == 206
        received = resumed ? writer.resumeOffset : 0
        do {
            try writer.begin(append: resumed)
        } catch {
            continuation?.resume(throwing: error)
            continuation = nil
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        defer { lock.unlock() }
        do {
            try writer.append(data)
        } catch {
            continuation?.resume(throwing: error)
            continuation = nil
            dataTask.cancel()
            return
        }
        received += data.count
        onProgress(received)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        defer { lock.unlock() }
        guard let continuation else { return }
        self.continuation = nil
        writer.finish()
        if let error = error as? URLError, error.code == .cancelled {
            continuation.resume(throwing: CancellationError())
        } else if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume()
        }
    }
}

/// A `.part` file being written: opened for appending or fresh, written as chunks land.
private final class PartFileWriter: @unchecked Sendable {
    /// Bytes already in the file when a resume starts; 0 for a fresh one.
    let resumeOffset: Int
    private let path: String
    private var handle: FileHandle?
    private let lock = NSLock()

    init(path: String, resumeFrom: Int) {
        self.path = path
        self.resumeOffset = resumeFrom
    }

    func begin(append: Bool) throws {
        lock.lock()
        defer { lock.unlock() }
        let files = FileManager.default
        if !append, files.fileExists(atPath: path) {
            try files.removeItem(atPath: path)
        }
        if !files.fileExists(atPath: path) {
            files.createFile(atPath: path, contents: nil)
        }
        handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        if append, let handle {
            try handle.seekToEnd()
        }
    }

    func append(_ data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let handle else { return }
        try handle.write(contentsOf: data)
    }

    func finish() {
        lock.lock()
        defer { lock.unlock() }
        try? handle?.close()
        handle = nil
    }
}

// MARK: - The registry (lib/models.ts)

/// `registerModel`: records the download, replacing any entry for the same model.
public func registerModel(
    db: Database,
    id: String,
    path: String,
    bytes: Int,
    format: String? = "mlx",
    now: Date = Date()
) throws {
    let entries: [JSONValue]
    if let row = try Setting.fetchOne(db, key: localModelsSettingKey),
       let parsed = try? JSONValue.parse(row.value), case .array(let items) = parsed {
        entries = items.filter { entry in
            guard case .object(let fields) = entry, fields["id"]?.stringValue != id else { return false }
            return true
        }
    } else {
        entries = []
    }
    var entry: JSONObject = [
        "id": .string(id),
        "path": .string(path),
        "bytes": .int(bytes),
        "downloadedAt": .string(jsISOString(now)),
    ]
    if let format {
        entry["format"] = .string(format)
    }
    let value = JSONValue.array(entries + [.object(entry)]).stringified()
    var row = Setting(key: localModelsSettingKey, value: value, updatedAt: now)
    try row.save(db)
}

/// What a model is linked with as its slide reader (`linkModel`'s `reader` argument).
public enum LinkReader: Sendable, Equatable {
    /// No reader given: a model that sees slides reads them itself, a text-only one keeps its eye.
    case keep
    /// The reader named, or nil to clear it.
    case value(String?)
}

/// `linkModel`: makes a model the one local mode uses, with the model that looks at its
/// slides when one is given.
public func linkModel(db: Database, model: LocalModel, reader: LinkReader = .keep, now: Date = Date()) throws {
    try setSetting(db: db, key: "localModel", value: .string(model.id), now: now)
    try setSetting(db: db, key: "mode", value: .string(AppMode.local.rawValue), now: now)
    switch reader {
    case .keep:
        if model.vision {
            try setSetting(db: db, key: "slideReader", value: .null, now: now)
        }
    case .value(let named):
        try setSetting(db: db, key: "slideReader", value: JSONValue.orNull(named == model.id ? nil : named), now: now)
    }
}

/// `removeModel`: deletes a model's file and forgets it. If it was the one in use,
/// nothing is — local mode simply has no model until another is chosen.
public func removeModel(db: Database, id: String, now: Date = Date()) throws {
    var entries: [JSONValue] = []
    var path: String?
    if let row = try Setting.fetchOne(db, key: localModelsSettingKey),
       let parsed = try? JSONValue.parse(row.value), case .array(let items) = parsed {
        for entry in items {
            guard case .object(let fields) = entry, fields["id"]?.stringValue == id else {
                entries.append(entry)
                continue
            }
            path = fields["path"]?.stringValue
        }
    }
    if let path {
        try? FileManager.default.removeItem(atPath: path)
    }
    let value = JSONValue.array(entries).stringified()
    var row = Setting(key: localModelsSettingKey, value: value, updatedAt: now)
    try row.save(db)
    let settings = try getSettings(db: db)
    if settings.localModel == id {
        try setSetting(db: db, key: "localModel", value: .null, now: now)
    }
    if settings.slideReader == id {
        try setSetting(db: db, key: "slideReader", value: .null, now: now)
    }
}

// MARK: - DOWNLOAD jobs (app/actions.ts requestDownload, lib/models.ts downloads())

/// `requestDownload`: queues a download. When it finishes, the queue links it: it becomes
/// the model in use, with `reader` as its eye if given. `link: false` only downloads it
/// (a pair's eye). On Apple Silicon with the engine, a model comes as its faster MLX copy.
@discardableResult
public func enqueueDownload(
    db: Database,
    modelId: String,
    link: Bool = true,
    mlx: Bool? = nil,
    reader: LinkReader = .keep,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    now: Date = Date()
) throws -> String {
    guard let model = findModel(modelId) else {
        throw LockinError("unknown model \(modelId)")
    }
    let useMlx: Bool
    switch mlx {
    case .some(let forced):
        useMlx = forced
    case .none:
        useMlx = model.mlx != nil && (machineSpecs().appleSilicon || model.uri == nil)
    }
    if useMlx && !machineSpecs().appleSilicon {
        throw LockinError("\(model.name) runs only on MLX, on an Apple Silicon Mac")
    }
    // One download at a time per model: reuse the one already waiting or running.
    let waiting = try Job.fetchAll(
        db,
        sql: #"SELECT * FROM "Job" WHERE "kind" = 'DOWNLOAD' AND "status" IN ('PENDING', 'RUNNING')"#
    )
    for job in waiting {
        if let payload = try? JSONValue.parse(job.payload), payload["modelId"]?.stringValue == modelId {
            return job.id
        }
    }
    var payload: JSONObject = ["modelId": .string(modelId), "link": .bool(link)]
    if useMlx {
        payload["mlx"] = .bool(true)
    }
    if case .value(let named) = reader {
        payload["reader"] = JSONValue.orNull(named)
    }
    var job = Job(kind: .download, payload: JSONValue.object(payload).stringified(), lectureId: nil, priority: 0, createdAt: now)
    try job.insert(db)
    return job.id
}

/// `choosePair`'s download of the eye that is not here yet: `link: false`, on MLX.
@discardableResult
public func enqueueEyeDownload(
    db: Database,
    eyeId: String,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    now: Date = Date()
) throws -> String {
    try enqueueDownload(db: db, modelId: eyeId, link: false, mlx: true, reader: .keep, environment: environment, now: now)
}

/// `{ downloaded, total, part? }` written while the download runs, so the Models pane
/// can follow it (`downloadOne`'s report). Nothing happens for a job that moved on.
public func setDownloadProgress(
    db: Database,
    jobId: String,
    downloaded: Int,
    total: Int,
    part: String? = "mlx"
) throws {
    var progress: JSONObject = ["downloaded": .int(downloaded), "total": .int(total)]
    if let part {
        progress["part"] = .string(part)
    }
    try db.execute(
        sql: #"UPDATE "Job" SET "result" = ? WHERE "id" = ? AND "status" = 'RUNNING'"#,
        arguments: [JSONValue.object(progress).stringified(), jobId]
    )
}

/// The worker stops within a couple of seconds; the partial file is kept for a resume.
/// (`cancelDownload`: FAILED, "Cancelled" — which is what the row already says when the
/// queue's own × stopped it.)
@discardableResult
public func cancelDownloadJob(db: Database, jobId: String, now: Date = Date()) throws -> Bool {
    try db.execute(
        sql: #"UPDATE "Job" SET "status" = 'FAILED', "error" = 'Cancelled', "stage" = NULL, "finishedAt" = ? WHERE "id" = ? AND "kind" = 'DOWNLOAD' AND "status" IN ('PENDING', 'RUNNING')"#,
        arguments: [PrismaDate.encode(now), jobId]
    )
    return db.changesCount > 0
}

/// A download as the Models pane follows it (`DownloadState`).
public struct DownloadState: Equatable, Sendable {
    public var jobId: String
    public var modelId: String
    public var name: String
    public var status: String
    public var downloaded: Int
    public var total: Int
    /// What is downloading: its MLX copy, or after the model itself, its vision part then
    /// llama.cpp's server (the Electron worker's business, shown as it arrives).
    public var part: String?
    public var error: String?

    /// Whether it is waiting or downloading.
    public var isActive: Bool { status == JobStatus.pending.rawValue || status == JobStatus.running.rawValue }
    /// Whether it failed for a reason other than being stopped.
    public var failed: Bool { status == JobStatus.failed.rawValue && error != "Cancelled" }
    /// `Math.floor(pct)`, 0 while it connects.
    public var percent: Int {
        total > 0 ? Int((Double(downloaded) / Double(total) * 100).rounded(.down)) : 0
    }
    /// "1.7 of 5.0 GB", short enough to sit beside Cancel.
    public var progressText: String {
        let mb = total < 1_073_741_824
        let size = Double(mb ? 1_048_576 : 1_073_741_824)
        let places = mb ? 0 : 1
        return String(format: "%.\(places)f of %.\(places)f \(mb ? "MB" : "GB")", Double(downloaded) / size, Double(total) / size)
    }
}

/// `downloads()`: downloads waiting or running, and any that finished or failed in the
/// last hour — only the latest attempt per model.
public func downloadStates(db: Database, now: Date = Date()) throws -> [DownloadState] {    let jobs = try Job.fetchAll(
        db,
        sql: #"""
        SELECT * FROM "Job" WHERE "kind" = 'DOWNLOAD'
          AND ("status" IN ('PENDING', 'RUNNING') OR "finishedAt" >= ?)
        ORDER BY "createdAt" DESC
        """#,
        arguments: [PrismaDate.encode(now.addingTimeInterval(-3_600)) ]
    )
    var seen: Set<String> = []
    return jobs.compactMap { job -> DownloadState? in
        guard let payload = try? JSONValue.parse(job.payload), let modelId = payload["modelId"]?.stringValue,
              seen.insert(modelId).inserted else {
            return nil
        }
        var downloaded = 0
        var total = 0
        var part: String?
        if let result = job.result, let progress = try? JSONValue.parse(result), case .object(let fields) = progress {
            downloaded = fields["downloaded"]?.intValue ?? 0
            total = fields["total"]?.intValue ?? 0
            part = fields["part"]?.stringValue
        }
        return DownloadState(
            jobId: job.id,
            modelId: modelId,
            name: findModel(modelId)?.name ?? modelId,
            status: job.status.rawValue,
            downloaded: downloaded,
            total: total,
            part: part ?? (payload["visionOnly"]?.isTruthy == true ? "vision" : (payload["mlx"]?.isTruthy == true ? "mlx" : nil)),
            error: job.error
        )
    }
}

public func downloadStates(database: LockinDatabase, now: Date = Date()) throws -> [DownloadState] {
    try database.reader.read { db in
        try downloadStates(db: db, now: now)
    }
}
