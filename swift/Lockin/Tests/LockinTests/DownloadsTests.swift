import Foundation
import XCTest
@testable import LockinCore

final class DownloadsTests: XCTestCase {
    // MARK: - The tree filter

    func testTheTreeFilterKeepsRealFilesAndDropsReadmesAndPictures() {
        let listing: JSONValue = .array([
            .object(["type": .string("file"), "path": .string("config.json"), "size": .int(5)]),
            .object(["type": .string("file"), "path": .string("README.md"), "size": .int(100)]),
            .object(["type": .string("file"), "path": .string(".gitattributes"), "size": .int(10)]),
            .object(["type": .string("file"), "path": .string("weights/model.safetensors"), "size": .int(9)]),
            .object(["type": .string("file"), "path": .string("cover.png"), "size": .int(50)]),
            .object(["type": .string("directory"), "path": .string("sub"), "size": .int(0)]),
        ])
        let files = mlxFilesToFetch(listing)
        XCTAssertEqual(files.map(\.path), ["config.json", "weights/model.safetensors"])
        XCTAssertEqual(files.map(\.size), [5, 9])
        XCTAssertEqual(mlxFilesToFetch(.string("nope")), [])
    }

    // MARK: - The registry

    private func makeDatabase() throws -> LockinDatabase {
        try LockinDatabase.inMemory()
    }

    func testRegisterFindAndRemoveAModel() throws {
        let db = try makeDatabase()
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("dl-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let folder = dir.appendingPathComponent("mlx/gemma-4-e4b")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "weights".write(to: folder.appendingPathComponent("model.safetensors"), atomically: true, encoding: .utf8)

        try db.writer.write { conn in
            try registerModel(db: conn, id: "gemma-4-e4b", path: folder.path, bytes: 5_000, format: "mlx")
        }
        let installed = try installedModels(database: db)
        XCTAssertEqual(installed.map(\.id), ["gemma-4-e4b"])
        XCTAssertTrue(installed[0].isMLX)
        XCTAssertEqual(installed[0].bytes, 5_000)

        // Registering again replaces, never duplicates.
        try db.writer.write { conn in
            try registerModel(db: conn, id: "gemma-4-e4b", path: folder.path, bytes: 5_001, format: "mlx")
        }
        XCTAssertEqual(try installedModels(database: db).count, 1)

        // Removing forgets it, deletes the file, and clears anything that was in use.
        try db.writer.write { conn in
            try linkModel(db: conn, model: findModel("gemma-4-e4b")!)
            try removeModel(db: conn, id: "gemma-4-e4b")
        }
        XCTAssertEqual(try installedModels(database: db), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
        let settings = try getSettings(database: db)
        XCTAssertNil(settings.localModel)
        XCTAssertEqual(settings.mode, .local, "the mode itself stays; local mode just has no model")
    }

    func testLinkingSetsTheReaderByTheLinkModelRules() throws {
        let db = try makeDatabase()
        let vision = findModel("gemma-4-e4b")! // sees slides
        let textOnly = findModel("qwen-3.5-0.8b")! // text only

        try db.writer.write { conn in
            // A model that sees slides reads them itself.
            try linkModel(db: conn, model: vision, reader: .keep)
            var settings = try getSettings(db: conn)
            XCTAssertEqual(settings.localModel, vision.id)
            XCTAssertEqual(settings.mode, .local)
            XCTAssertNil(settings.slideReader)

            // A text-only model keeps the eye it had.
            try setSetting(db: conn, key: "slideReader", value: .string("fastvlm-0.5b"))
            try linkModel(db: conn, model: textOnly, reader: .keep)
            settings = try getSettings(db: conn)
            XCTAssertEqual(settings.slideReader, "fastvlm-0.5b")

            // A named reader is used, and naming the model itself is no reader.
            try linkModel(db: conn, model: vision, reader: .value("fastvlm-0.5b"))
            settings = try getSettings(db: conn)
            XCTAssertEqual(settings.slideReader, "fastvlm-0.5b")
            try linkModel(db: conn, model: vision, reader: .value(vision.id))
            settings = try getSettings(db: conn)
            XCTAssertNil(settings.slideReader)
        }
    }

    // MARK: - Queueing downloads

    func testQueueingADownloadRecordsMlxAndReusesTheWaitingOne() throws {
        let db = try makeDatabase()
        try db.writer.write { conn in
            let first = try enqueueDownload(db: conn, modelId: "gemma-4-e4b")
            let again = try enqueueDownload(db: conn, modelId: "gemma-4-e4b")
            XCTAssertEqual(first, again, "one download at a time per model")

            let job = try Job.fetchOne(conn, key: first)
            let payload = try JSONValue.parse(job!.payload)
            XCTAssertEqual(payload["modelId"]?.stringValue, "gemma-4-e4b")
            XCTAssertEqual(payload["link"]?.isTruthy, true)
            XCTAssertEqual(payload["mlx"]?.isTruthy, true, "with the engine, the download is the MLX copy")
            XCTAssertNil(job!.lectureId)
        }
    }

    func testQueueingAReaderDownloadSaysLinkFalseAndNamesTheReader() throws {
        let db = try makeDatabase()
        try db.writer.write { conn in
            _ = try enqueueEyeDownload(db: conn, eyeId: "fastvlm-0.5b")
            let job = try Job.fetchAll(conn, sql: #"SELECT * FROM "Job" WHERE "kind" = 'DOWNLOAD'"#).first!
            let payload = try JSONValue.parse(job.payload)
            XCTAssertEqual(payload["link"]?.isTruthy, false, "a pair's eye downloads without linking")
        }
    }

    func testQueueingAnUnknownModelSaysSo() throws {
        let db = try makeDatabase()
        try db.writer.write { conn in
            XCTAssertThrowsError(try enqueueDownload(db: conn, modelId: "not-a-model"))
        }
    }

    // MARK: - Progress and cancel

    func testDownloadStatesShowTheLatestAttemptPerModel() throws {
        let db = try makeDatabase()
        let now = Date()
        try db.writer.write { conn in
            // An older finished attempt, then a running one: only the running one shows.
            var old = Job(kind: .download, payload: #"{"modelId":"gemma-4-e4b","link":true,"mlx":true}"#, lectureId: nil, priority: 0, createdAt: now.addingTimeInterval(-7_200))
            try old.insert(conn)
            try completeJob(db: conn, jobId: old.id, result: .object(["downloaded": .int(5), "total": .int(5)]), promptVersion: nil, model: nil, durationMs: 1, closeTimeline: false, now: now.addingTimeInterval(-7_100))

            var running = Job(kind: .download, payload: #"{"modelId":"gemma-4-e4b","link":true,"mlx":true}"#, lectureId: nil, priority: 0, createdAt: now.addingTimeInterval(-60))
            running.status = .running
            running.startedAt = now.addingTimeInterval(-50)
            try running.insert(conn)
            try setDownloadProgress(db: conn, jobId: running.id, downloaded: 2, total: 5, part: "mlx")

            // A different model, finished within the hour: shows with its progress.
            var done = Job(kind: .download, payload: #"{"modelId":"qwen-3.5-0.8b","link":true,"mlx":true}"#, lectureId: nil, priority: 0, createdAt: now.addingTimeInterval(-3_000))
            done.status = .running
            try done.insert(conn)
            try completeJob(db: conn, jobId: done.id, result: .object(["downloaded": .int(600), "total": .int(600)]), promptVersion: nil, model: nil, durationMs: 4_000, closeTimeline: false, now: now.addingTimeInterval(-1_000))
        }
        let states = try downloadStates(database: db, now: now)
        XCTAssertEqual(states.count, 2, "one line per model, not per attempt")
        let gemma = states.first { $0.modelId == "gemma-4-e4b" }
        XCTAssertEqual(gemma?.status, JobStatus.running.rawValue)
        XCTAssertEqual(gemma?.downloaded, 2)
        XCTAssertEqual(gemma?.part, "mlx")
        XCTAssertEqual(gemma?.percent, 40)
        XCTAssertEqual(gemma?.name, "Gemma 4 E4B")
        let qwen = states.first { $0.modelId == "qwen-3.5-0.8b" }
        XCTAssertEqual(qwen?.status, JobStatus.done.rawValue)
        XCTAssertFalse(qwen?.isActive ?? true)

        // Cancelling marks it Cancelled, and it stops counting as active.
        try db.writer.write { conn in
            XCTAssertTrue(try cancelDownloadJob(db: conn, jobId: states.first { $0.modelId == "gemma-4-e4b" }!.jobId))
        }
        let after = try downloadStates(database: db, now: now)
        XCTAssertEqual(after.first { $0.modelId == "gemma-4-e4b" }?.error, "Cancelled")
        XCTAssertFalse(after.first { $0.modelId == "gemma-4-e4b" }!.isActive)
    }

    func testTakingOverTheQueueRequeuesInterruptedDownloads() throws {
        let db = try makeDatabase()
        try db.writer.write { conn in
            var stuck = Job(kind: .download, payload: #"{"modelId":"gemma-4-e4b","link":true,"mlx":true}"#, lectureId: nil, priority: 0, createdAt: Date())
            stuck.status = .running
            try stuck.insert(conn)
            try requeueInterruptedJobs(db: conn)
            XCTAssertEqual(try jobStatus(db: conn, jobId: stuck.id), .pending)
        }
    }

    // MARK: - The downloader itself

    /// Serves the listing and the files from memory (`URLProtocol`).
    final class StubProtocol: URLProtocol {
        nonisolated(unsafe) static var routes: [String: (status: Int, body: Data, headers: [String: String])] = [:]
        nonisolated(unsafe) static var requestedPaths: [String] = []
        private static let lock = NSLock()

        static func reset() {
            lock.lock()
            defer { lock.unlock() }
            routes = [:]
            requestedPaths = []
        }

        static func serve(_ url: String, status: Int, body: Data, headers: [String: String] = [:]) {
            lock.lock()
            defer { lock.unlock() }
            routes[url] = (status, body, headers)
        }

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            Self.lock.lock()
            Self.requestedPaths.append(request.url!.path)
            let route = Self.routes[request.url!.absoluteString]
            Self.lock.unlock()
            guard let route else {
                client?.urlProtocol(self, didFailWithError: URLError(.fileDoesNotExist))
                return
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: route.status, httpVersion: nil, headerFields: route.headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: route.body)
            client?.urlProtocolDidFinishLoading(self)
        }

        override func stopLoading() {}
    }

    private func stubbedSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    private var model: LocalModel { findModel("gemma-4-e4b")! }

    private var endpoints: MlxEndpoints {
        MlxEndpoints(
            listing: { repo in URL(string: "http://stub/api/models/\(repo)/tree/main?recursive=true")! },
            file: { repo, path in URL(string: "http://stub/\(repo)/resolve/main/\(path)")! }
        )
    }

    override func setUp() {
        super.setUp()
        StubProtocol.reset()
    }

    func testADownloadFetchesTheWorthwhileFilesAndReportsTheTotal() async throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("dl-\(UUID().uuidString)")
        StubProtocol.serve(
            "http://stub/api/models/\(model.mlx!)/tree/main?recursive=true",
            status: 200,
            body: Data(#"[{"type":"file","path":"config.json","size":5},{"type":"file","path":"README.md","size":9},{"type":"file","path":"weights.bin","size":9}]"#.utf8)
        )
        StubProtocol.serve("http://stub/\(model.mlx!)/resolve/main/config.json", status: 200, body: Data("hello".utf8))
        StubProtocol.serve("http://stub/\(model.mlx!)/resolve/main/weights.bin", status: 200, body: Data("012345678".utf8))

        var reports: [(Int, Int)] = []
        let result = try await downloadMlxModel(model, dir: dir, onProgress: { reports.append(($0, $1)) }, session: stubbedSession(), endpoints: endpoints)

        XCTAssertEqual(result.path.hasSuffix("mlx/gemma-4-e4b"), true)
        XCTAssertEqual(result.bytes, 14)
        XCTAssertEqual(String(data: try Data(contentsOf: URL(fileURLWithPath: result.path + "/config.json")), encoding: .utf8), "hello")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: result.path + "/weights.bin")).count, 9)
        XCTAssertFalse(FileManager.default.fileExists(atPath: result.path + "/README.md"))
        XCTAssertEqual(reports.last?.0, 14)
        XCTAssertEqual(StubProtocol.requestedPaths.filter { $0.hasSuffix("README.md") }, [], "the README is never fetched")
    }

    func testAPartialFileCarriesOnAndAWholeOneIsSkipped() async throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("dl-\(UUID().uuidString)")
        // config.json is already complete: skipped, never requested.
        let dest = dir.appendingPathComponent("mlx/\(model.id)")
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        try "hello".write(to: dest.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
        // weights.bin stopped at 4 of 9 bytes.
        try "0123".write(to: dest.appendingPathComponent("weights.bin.part"), atomically: true, encoding: .utf8)

        StubProtocol.serve(
            "http://stub/api/models/\(model.mlx!)/tree/main?recursive=true",
            status: 200,
            body: Data(#"[{"type":"file","path":"config.json","size":5},{"type":"file","path":"weights.bin","size":9}]"#.utf8)
        )
        // The Range request is answered with the rest of the file.
        StubProtocol.serve(
            "http://stub/\(model.mlx!)/resolve/main/weights.bin",
            status: 206,
            body: Data("45678".utf8),
            headers: ["Content-Range": "bytes 4-8/9"]
        )

        let result = try await downloadMlxModel(model, dir: dir, onProgress: { _, _ in }, session: stubbedSession(), endpoints: endpoints)
        let weights = try Data(contentsOf: URL(fileURLWithPath: result.path + "/weights.bin"))
        XCTAssertEqual(String(data: weights, encoding: .utf8), "012345678", "the .part file carried on from where it stopped")
        XCTAssertEqual(StubProtocol.requestedPaths.filter { $0.hasSuffix("config.json") }, [], "a complete file is not fetched again")
        XCTAssertFalse(FileManager.default.fileExists(atPath: result.path + "/weights.bin.part"))
    }

    func testANonResumableAnswerStartsTheFileAgain() async throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("dl-\(UUID().uuidString)")
        let dest = dir.appendingPathComponent("mlx/\(model.id)")
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        // A stale .part from another world: a 200 answer replaces it whole.
        try "OLDOLDOLDOLD".write(to: dest.appendingPathComponent("weights.bin.part"), atomically: true, encoding: .utf8)

        StubProtocol.serve(
            "http://stub/api/models/\(model.mlx!)/tree/main?recursive=true",
            status: 200,
            body: Data(#"[{"type":"file","path":"weights.bin","size":9}]"#.utf8)
        )
        StubProtocol.serve("http://stub/\(model.mlx!)/resolve/main/weights.bin", status: 200, body: Data("012345678".utf8))

        let result = try await downloadMlxModel(model, dir: dir, onProgress: { _, _ in }, session: stubbedSession(), endpoints: endpoints)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: result.path + "/weights.bin")).count, 9)
    }

    func testAModelWithoutMlxAndA404BothSaySo() async throws {
        // A catalog entry that never had an MLX copy: only its llama.cpp download exists.
        let ggufOnly = LocalModel(
            id: "gguf-only", name: "GGUF Only", maker: "Someone", params: "1B",
            downloadGb: 1, needsRamGb: 2, speed: 3, uri: "hf:someone/gguf-only:Q4_K_M", mlx: nil
        )
        do {
            _ = try await downloadMlxModel(ggufOnly, dir: URL(fileURLWithPath: NSTemporaryDirectory()), onProgress: { _, _ in }, session: stubbedSession(), endpoints: endpoints)
            XCTFail("expected an error")
        } catch {
            // the error names the model
        }
        StubProtocol.serve("http://stub/api/models/\(model.mlx!)/tree/main?recursive=true", status: 404, body: Data())
        do {
            _ = try await downloadMlxModel(model, dir: URL(fileURLWithPath: NSTemporaryDirectory()), onProgress: { _, _ in }, session: stubbedSession(), endpoints: endpoints)
            XCTFail("expected an error")
        } catch let error as LockinError {
            XCTAssertTrue(messageOf(error).contains("no MLX version on Hugging Face"), messageOf(error))
        }
    }
}
