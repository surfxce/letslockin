import Foundation
import GRDB
import XCTest
@testable import LockinCore

private func mac(_ ramGb: Double, cores: Int = 8) -> MachineSpecs {
    MachineSpecs(ramGb: ramGb, cores: cores, appleSilicon: true, kind: "Mac")
}

private func pc(_ ramGb: Double, cores: Int) -> MachineSpecs {
    MachineSpecs(ramGb: ramGb, cores: cores, appleSilicon: false, kind: "Windows PC")
}

private func picked(_ specs: MachineSpecs) -> [String] {
    let picks = recommendModels(specs)
    return [picks.performance.id, picks.recommended.id, picks.quality.id]
}

/// A folder of its own for one test's models, removed afterwards.
private func scratchFolder() throws -> URL {
    let folder = FileManager.default.temporaryDirectory
        .appendingPathComponent("lockin-models-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    return folder
}

private func makeFolder(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
}

private func makeFile(_ url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("gguf".utf8).write(to: url)
}

/// Stores the registry exactly as given, as the Electron app's `JSON.stringify` wrote it.
private func storeRegistry(_ database: LockinDatabase, _ value: String) throws {
    try database.writer.write { db in
        var row = Setting(key: localModelsSettingKey, value: value)
        try row.save(db)
    }
}

private func storedRegistry(_ database: LockinDatabase) throws -> String? {
    try database.reader.read { db in
        try Setting.fetchOne(db, key: localModelsSettingKey)?.value
    }
}

private func setChoice(_ database: LockinDatabase, _ key: String, _ value: String?) throws {
    try database.writer.write { db in
        try setSetting(db: db, key: key, value: .orNull(value))
    }
}

/// A registry entry as `JSON.stringify` writes it.
private func entry(_ id: String, _ path: String, bytes: Int = 1_000, format: String? = "mlx") -> String {
    let formatField = format.map { #","format":"\#($0)""# } ?? ""
    return #"{"id":"\#(id)","path":"\#(path)","bytes":\#(bytes),"downloadedAt":"2026-10-01T10:00:00.000Z"\#(formatField)}"#
}

final class ModelCatalogTests: XCTestCase {
    // MARK: - recommendModels (catalog.test.ts)

    func testPutsTheLargestComfortableModelInTheMiddleOneSizeEitherSide() {
        XCTAssertEqual(picked(mac(8)), ["qwen-3.5-0.8b", "gemma-4-e2b", "gemma-4-e4b"])
        XCTAssertEqual(picked(mac(16, cores: 10)), ["gemma-4-e4b", "gemma-4-12b", "gemma-4-26b-a4b"])
        XCTAssertEqual(picked(mac(32, cores: 12)), ["gemma-4-12b", "gemma-4-26b-a4b", "gemma-4-31b"])
    }

    func testNeverRecommendsTheTinyModelOrTheLargestOne() {
        XCTAssertEqual(recommendModels(mac(4)).recommended.id, "gemma-4-e2b")
        XCTAssertEqual(recommendModels(mac(128, cores: 24)).recommended.id, "gemma-4-26b-a4b")
    }

    func testAllowsForMemoryTheSystemReserves() {
        XCTAssertEqual(recommendModels(mac(15.6)).recommended.id, "gemma-4-12b")
    }

    func testDropsASizeOnACPUOnlyMachineWithFewCores() {
        XCTAssertEqual(recommendModels(pc(16, cores: 6)).recommended.id, "gemma-4-e4b")
        XCTAssertEqual(recommendModels(pc(16, cores: 16)).recommended.id, "gemma-4-12b")
    }

    func testWarnsWhenTheQualityPickWillNotFitComfortably() {
        XCTAssertTrue(recommendModels(mac(16)).caution?.contains("24 GB") == true)
        XCTAssertNil(recommendModels(mac(64)).caution)
        XCTAssertTrue(recommendModels(mac(4)).caution?.contains("squeeze") == true)
    }

    func testSaysWhyInTheCardsWords() {
        XCTAssertEqual(
            recommendModels(mac(15.6)).why,
            "Your Mac has 16 GB memory and Apple Silicon: this is the largest model that runs comfortably on it."
        )
        XCTAssertEqual(
            recommendModels(pc(16, cores: 6)).why,
            "Your Windows PC has 16 GB memory and 6 cores, and will run models on its processor — so a size down keeps each lecture to minutes, not hours."
        )
        XCTAssertEqual(
            recommendModels(mac(16)).caution,
            "Quality wants about 24 GB of memory; on this computer it will be slow."
        )
        XCTAssertEqual(
            recommendModels(mac(4)).caution,
            "With 4 GB memory, even the recommended model is a squeeze — close other apps while it works, or use Performance."
        )
    }

    func testKeepsTheLadderOrderedBySizeEachWithAResolvableLink() throws {
        let sizes = localModels.map { $0.downloadGb }
        XCTAssertEqual(sizes.sorted(), sizes)
        let link = try NSRegularExpression(pattern: #"^hf:[\w.-]+/[\w.-]+:Q4_K_M$"#)
        for model in localModels {
            let uri = model.uri ?? ""
            XCTAssertNotNil(link.firstMatch(in: uri, range: NSRange(location: 0, length: (uri as NSString).length)), model.id)
        }
    }

    // MARK: - The other models

    func testGivesEveryAlternativeAnMLXCopyAndAMainModelToSitBeside() {
        for model in moreModels {
            XCTAssertFalse((model.mlx ?? "").isEmpty, model.id)
            if let like = model.like {
                XCTAssertTrue(localModels.contains { $0.id == like }, model.id)
            }
        }
    }

    func testPairsAnEyeThatSeesSlidesOnMLXWithAWriterThatExists() {
        for pair in modelPairs {
            let eye = findModel(pair.eye)
            XCTAssertTrue(eye?.vision == true && !(eye?.mlx ?? "").isEmpty, pair.eye)
            XCTAssertNotNil(findModel(pair.writer), pair.writer)
            XCTAssertNotEqual(pair.eye, pair.writer)
        }
    }

    func testFindsAModelInEitherList() {
        XCTAssertEqual(findModel("gemma-4-e4b")?.name, "Gemma 4 E4B")
        XCTAssertEqual(findModel("fastvlm-0.5b")?.maker, "Apple")
        XCTAssertNil(findModel("no-such-model"))
        XCTAssertNil(findModel(nil))
    }

    func testCountsParametersForListingSmallestFirst() {
        let model = { (params: String) in
            LocalModel(id: "x", name: "X", maker: "Y", params: params, downloadGb: 1, needsRamGb: 1, speed: 1)
        }
        XCTAssertEqual(parameterCount(model("35B, 3B active")), 35e9)
        XCTAssertEqual(parameterCount(model("130M")), 130e6)
        XCTAssertEqual(parameterCount(model("0.8b")), 0.8e9)
        XCTAssertEqual(parameterCount(model("tiny")), 0)
    }

    // MARK: - Installed models (lib/models.ts)

    func testInstalledModelsAreThoseStillThereAndMovedOnesAreFoundAgain() throws {
        let root = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: root) }
        let models = root.appendingPathComponent("models", isDirectory: true)
        try makeFolder(models.appendingPathComponent("mlx/gemma-4-e4b"))
        try makeFile(models.appendingPathComponent("Qwen3.5-0.8B-Q4_K_M.gguf"))
        let elsewhere = root.appendingPathComponent("elsewhere/fastvlm-0.5b")
        try makeFolder(elsewhere)
        let environment = ["LOCKIN_MODELS_DIR": models.path]

        let database = try LockinDatabase.inMemory()
        let entries = [
            entry("gemma-4-e4b", "/old/lockin/models/mlx/gemma-4-e4b", bytes: 5_000_000_000),
            entry("qwen-3.5-0.8b", "/old/lockin/models/Qwen3.5-0.8B-Q4_K_M.gguf", bytes: 600_000_000, format: nil),
            entry("fastvlm-0.5b", elsewhere.path),
            entry("gemma-4-31b", "/gone/gemma-4-31b"),
        ]
        let registry = "[" + entries.joined(separator: ",") + "]"
        try storeRegistry(database, registry)

        let installed = try installedModels(database: database, environment: environment)

        XCTAssertEqual(installed.map { $0.id }, ["gemma-4-e4b", "qwen-3.5-0.8b", "fastvlm-0.5b"])
        XCTAssertEqual(installed.map { $0.path }, [
            models.appendingPathComponent("mlx/gemma-4-e4b").path,
            models.appendingPathComponent("Qwen3.5-0.8B-Q4_K_M.gguf").path,
            elsewhere.path,
        ])
        XCTAssertEqual(installed.map { $0.isMLX }, [true, false, true])
        XCTAssertEqual(installed.first?.bytes, 5_000_000_000)
        XCTAssertEqual(installed.first?.downloadedAt, "2026-10-01T10:00:00.000Z")

        // The registry is corrected in place, as JSON.stringify writes it; a model that is
        // nowhere stays listed and is not installed.
        let corrected = registry
            .replacingOccurrences(of: "/old/lockin/models/mlx/gemma-4-e4b", with: models.appendingPathComponent("mlx/gemma-4-e4b").path)
            .replacingOccurrences(
                of: "/old/lockin/models/Qwen3.5-0.8B-Q4_K_M.gguf",
                with: models.appendingPathComponent("Qwen3.5-0.8B-Q4_K_M.gguf").path
            )
        XCTAssertEqual(try storedRegistry(database), corrected)
    }

    func testARegistryWithNothingMovedIsLeftAsItIs() throws {
        let root = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: root) }
        let model = root.appendingPathComponent("mlx/gemma-4-e4b")
        try makeFolder(model)
        let database = try LockinDatabase.inMemory()
        // Spaced out, as no app writes it: any rewrite would show.
        let registry = "[ " + entry("gemma-4-e4b", model.path) + " , " + entry("gemma-4-31b", "/gone/gemma-4-31b") + " ]"
        try storeRegistry(database, registry)

        let installed = try database.writer.write { db in
            try installedModels(db: db, environment: ["LOCKIN_MODELS_DIR": root.path])
        }

        XCTAssertEqual(installed, [InstalledModel(id: "gemma-4-e4b", path: model.path, bytes: 1_000, downloadedAt: "2026-10-01T10:00:00.000Z", format: "mlx")])
        XCTAssertEqual(try storedRegistry(database), registry)
    }

    func testAnUnreadableRegistryMeansNothingIsInstalled() throws {
        let database = try LockinDatabase.inMemory()
        XCTAssertEqual(try installedModels(database: database), [])
        for broken in ["{not json", #"{"id":"gemma-4-e4b"}"#, "null", #"[5, null, {"id": 3}]"#] {
            try storeRegistry(database, broken)
            XCTAssertEqual(try installedModels(database: database), [], broken)
            XCTAssertEqual(try storedRegistry(database), broken)
        }
    }

    func testAMovedModelIsFoundEvenWhereNothingCanBeWritten() throws {
        let root = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: root) }
        let moved = root.appendingPathComponent("mlx/gemma-4-e4b")
        try makeFolder(moved)
        let database = try LockinDatabase.inMemory()
        let registry = "[" + entry("gemma-4-e4b", "/old/models/mlx/gemma-4-e4b") + "]"
        try storeRegistry(database, registry)

        let installed = try database.reader.read { db in
            try installedModels(db: db, environment: ["LOCKIN_MODELS_DIR": root.path])
        }

        XCTAssertEqual(installed.map { $0.path }, [moved.path])
        XCTAssertEqual(try storedRegistry(database), registry)
    }

    func testTheActiveModelIsTheChosenOneDownloadedOnMLX() throws {
        let root = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: root) }
        let gemma = root.appendingPathComponent("mlx/gemma-4-e4b")
        let qwen = root.appendingPathComponent("Qwen3.5-0.8B-Q4_K_M.gguf")
        let mine = root.appendingPathComponent("mlx/my-model")
        try makeFolder(gemma)
        try makeFile(qwen)
        try makeFolder(mine)
        let environment = ["LOCKIN_MODELS_DIR": root.path]
        let database = try LockinDatabase.inMemory()
        try storeRegistry(database, "[" + [
            entry("my-model", mine.path),
            entry("qwen-3.5-0.8b", qwen.path, format: nil),
            entry("gemma-4-e4b", gemma.path),
        ].joined(separator: ",") + "]")

        XCTAssertNil(try activeLocalModel(database: database, environment: environment))

        try setChoice(database, "localModel", "gemma-4-e4b")
        let active = try XCTUnwrap(try activeLocalModel(database: database, environment: environment))
        XCTAssertEqual(active.model.id, "gemma-4-e4b")
        XCTAssertEqual(active.model.name, "Gemma 4 E4B")
        XCTAssertEqual(active.path, gemma.path)

        // A llama.cpp download only the Electron app can run, or a model not in the catalog.
        try setChoice(database, "localModel", "qwen-3.5-0.8b")
        XCTAssertNil(try activeLocalModel(database: database, environment: environment))
        try setChoice(database, "localModel", "my-model")
        XCTAssertNil(try activeLocalModel(database: database, environment: environment))
        // Chosen but not downloaded.
        try setChoice(database, "localModel", "gemma-4-12b")
        XCTAssertNil(try activeLocalModel(database: database, environment: environment))
    }

    func testTheFallbackIsTheActiveModelElseTheFirstDownloadedOnMLX() throws {
        let root = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: root) }
        let qwen = root.appendingPathComponent("Qwen3.5-0.8B-Q4_K_M.gguf")
        let mine = root.appendingPathComponent("mlx/my-model")
        let small = root.appendingPathComponent("mlx/gemma-4-e2b")
        let large = root.appendingPathComponent("mlx/gemma-4-12b")
        try makeFile(qwen)
        try makeFolder(mine)
        try makeFolder(small)
        try makeFolder(large)
        let environment = ["LOCKIN_MODELS_DIR": root.path]
        let database = try LockinDatabase.inMemory()

        XCTAssertNil(try fallbackLocalModel(database: database, environment: environment))

        try storeRegistry(database, "[" + [
            entry("qwen-3.5-0.8b", qwen.path, format: nil),
            entry("my-model", mine.path),
            entry("gemma-4-e2b", small.path),
            entry("gemma-4-12b", large.path),
        ].joined(separator: ",") + "]")

        XCTAssertEqual(try fallbackLocalModel(database: database, environment: environment)?.model.id, "gemma-4-e2b")
        try setChoice(database, "localModel", "gemma-4-12b")
        XCTAssertEqual(try fallbackLocalModel(database: database, environment: environment)?.path, large.path)
    }

    func testTheSlideReaderSeesImagesIsOnMLXAndCanRunHere() throws {
        let root = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: root) }
        let eye = root.appendingPathComponent("mlx/fastvlm-0.5b")
        let writer = root.appendingPathComponent("mlx/gpt-oss-20b")
        try makeFolder(eye)
        try makeFolder(writer)
        let environment = ["LOCKIN_MODELS_DIR": root.path]
        let database = try LockinDatabase.inMemory()
        try storeRegistry(database, "[" + entry("fastvlm-0.5b", eye.path) + "," + entry("gpt-oss-20b", writer.path) + "]")

        XCTAssertNil(try activeSlideReader(database: database, engineAvailable: true, environment: environment))

        try setChoice(database, "slideReader", "fastvlm-0.5b")
        let reader = try XCTUnwrap(try activeSlideReader(database: database, engineAvailable: true, environment: environment))
        XCTAssertEqual(reader.model.name, "FastVLM 0.5B")
        XCTAssertEqual(reader.path, eye.path)
        // Not without the engine.
        XCTAssertNil(try activeSlideReader(database: database, engineAvailable: false, environment: environment))
        // A model that cannot see is no eye.
        try setChoice(database, "slideReader", "gpt-oss-20b")
        XCTAssertNil(try activeSlideReader(database: database, engineAvailable: true, environment: environment))
        // Chosen but not downloaded.
        try setChoice(database, "slideReader", "qwen3-vl-4b")
        XCTAssertNil(try activeSlideReader(database: database, engineAvailable: true, environment: environment))
    }

    func testModelsAreKeptInTheDataFolderUnlessSaidOtherwise() {
        XCTAssertEqual(modelsDirectory(environment: [:]), LockinPaths.modelsDirectory)
        XCTAssertEqual(modelsDirectory(environment: ["LOCKIN_MODELS_DIR": "/Volumes/Models"]).path, "/Volumes/Models")
    }
}
