import Foundation
import GRDB

// Port of lib/llm/catalog.ts (the models Lockin offers to run on this computer) and of
// the installed-model registry in lib/models.ts (the "localModels" setting, shared with
// the Electron app). Downloading stays with the Electron worker for now.

// MARK: - The catalog (lib/llm/catalog.ts)

/// A model Lockin offers to run on this computer, smallest first.
public struct LocalModel: Equatable, Sendable {
    public var id: String
    public var name: String
    public var maker: String
    /// "8B, 4.5B active" — what the card shows under the name.
    public var params: String
    /// Approximate download, GB.
    public var downloadGb: Double
    /// Memory for the model plus a lecture-length context, GB. Below this it will crawl or fail.
    public var needsRamGb: Double
    /// Relative speed on the same machine, 1 (slowest) to 5 (fastest).
    public var speed: Int
    /// Its llama.cpp (GGUF) download. Absent for a model offered on MLX only.
    public var uri: String?
    /// Its MLX copy on Hugging Face, for the engine on Apple Silicon.
    public var mlx: String?
    public var blurb: String
    /// Takes images, so it can be shown the slides (Slides/VisionPass.swift).
    public var vision: Bool
    /// For an alternative: the main model it compares with, so it shows in that one's column.
    public var like: String?

    public init(
        id: String,
        name: String,
        maker: String,
        params: String,
        downloadGb: Double,
        needsRamGb: Double,
        speed: Int,
        uri: String? = nil,
        mlx: String? = nil,
        blurb: String = "",
        vision: Bool = false,
        like: String? = nil
    ) {
        self.id = id
        self.name = name
        self.maker = maker
        self.params = params
        self.downloadGb = downloadGb
        self.needsRamGb = needsRamGb
        self.speed = speed
        self.uri = uri
        self.mlx = mlx
        self.blurb = blurb
        self.vision = vision
        self.like = like
    }
}

/// The main ladder (`LOCAL_MODELS`): each has a llama.cpp download and an MLX copy.
public let localModels: [LocalModel] = [
    LocalModel(
        id: "qwen-3.5-0.8b",
        name: "Qwen 3.5 0.8B",
        maker: "Alibaba",
        params: "0.8B",
        downloadGb: 0.6,
        needsRamGb: 4,
        speed: 5,
        uri: "hf:unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M",
        mlx: "mlx-community/Qwen3.5-0.8B-4bit",
        blurb: "Tiny and quick. Fine for summaries; its questions are simpler."
    ),
    LocalModel(
        id: "gemma-4-e2b",
        name: "Gemma 4 E2B",
        maker: "Google",
        params: "5B, 2.3B active",
        downloadGb: 3.1,
        needsRamGb: 6,
        speed: 4,
        uri: "hf:giladgd/gemma-4-E2B-it-GGUF:Q4_K_M",
        mlx: "mlx-community/gemma-4-e2b-it-4bit",
        blurb: "Google's smallest Gemma 4. Good summaries on modest laptops.",
        vision: true
    ),
    LocalModel(
        id: "gemma-4-e4b",
        name: "Gemma 4 E4B",
        maker: "Google",
        params: "8B, 4.5B active",
        downloadGb: 5,
        needsRamGb: 10,
        speed: 3,
        uri: "hf:giladgd/gemma-4-E4B-it-GGUF:Q4_K_M",
        mlx: "mlx-community/gemma-4-e4b-it-4bit",
        blurb: "A solid all-rounder: clear summaries and fair exam questions.",
        vision: true
    ),
    LocalModel(
        id: "gemma-4-12b",
        name: "Gemma 4 12B",
        maker: "Google",
        params: "12B",
        downloadGb: 7.3,
        needsRamGb: 16,
        speed: 2,
        uri: "hf:giladgd/gemma-4-12B-it-GGUF:Q4_K_M",
        mlx: "mlx-community/gemma-4-12b-it-4bit",
        blurb: "A real step up in detail, marking and question quality.",
        vision: true
    ),
    LocalModel(
        id: "gemma-4-26b-a4b",
        name: "Gemma 4 26B",
        maker: "Google",
        params: "26B, 3.8B active",
        downloadGb: 15.5,
        needsRamGb: 24,
        speed: 3,
        uri: "hf:giladgd/gemma-4-26B-A4B-it-GGUF:Q4_K_M",
        mlx: "mlx-community/gemma-4-26b-a4b-it-4bit",
        blurb: "Near-flagship quality, and quick for its size — it only runs part of itself per word.",
        vision: true
    ),
    LocalModel(
        id: "gemma-4-31b",
        name: "Gemma 4 31B",
        maker: "Google",
        params: "31B",
        downloadGb: 18.7,
        needsRamGb: 32,
        speed: 1,
        uri: "hf:giladgd/gemma-4-31B-it-GGUF:Q4_K_M",
        mlx: "mlx-community/gemma-4-31b-it-4bit",
        blurb: "The most capable Gemma 4. Slow, but the most careful marker.",
        vision: true
    ),
]

/// Other models to choose from, on MLX only (`MORE_MODELS`) — every one is in
/// mlx-swift-lm's own model registry, so the engine is known to load it. Those that see
/// images are offered as alternatives beside the main three (`like`); the rest, tiny to
/// enormous, are in the full list. Sizes are the 4-bit downloads, roughly.
public let moreModels: [LocalModel] = [
    // Sees slides
    LocalModel(
        id: "fastvlm-0.5b", name: "FastVLM 0.5B", maker: "Apple", params: "0.5B", downloadGb: 1.2, needsRamGb: 3, speed: 5,
        mlx: "mlx-community/FastVLM-0.5B-bf16", vision: true, like: "qwen-3.5-0.8b"
    ),
    LocalModel(
        id: "lfm2.5-vl-1.6b", name: "LFM2.5-VL 1.6B", maker: "Liquid AI", params: "1.6B", downloadGb: 1.0, needsRamGb: 3, speed: 5,
        mlx: "mlx-community/LFM2.5-VL-1.6B-4bit", vision: true, like: "gemma-4-e2b"
    ),
    LocalModel(
        id: "ministral-3-3b", name: "Ministral 3 3B", maker: "Mistral", params: "3B", downloadGb: 2.2, needsRamGb: 5, speed: 5,
        mlx: "mlx-community/Ministral-3-3B-Instruct-2512-4bit", blurb: "Small and quick, with a good eye for diagrams.",
        vision: true, like: "gemma-4-e2b"
    ),
    LocalModel(
        id: "qwen3-vl-4b", name: "Qwen3-VL 4B", maker: "Alibaba", params: "4B", downloadGb: 4.6, needsRamGb: 8, speed: 4,
        mlx: "mlx-community/Qwen3-VL-4B-Instruct-8bit", blurb: "Qwen's vision model: strong at reading text in figures and tables.",
        vision: true, like: "gemma-4-e4b"
    ),
    LocalModel(
        id: "qwen-3.8-27b", name: "Qwen 3.8 27B", maker: "Alibaba", params: "27B", downloadGb: 15.5, needsRamGb: 24, speed: 1,
        mlx: "mlx-community/Qwen3.8-27B-4bit", blurb: "The newest Qwen at this size: careful and thorough, a strong marker.",
        vision: true, like: "gemma-4-31b"
    ),
    // Text only: slides are read as text
    LocalModel(
        id: "lille-130m", name: "Lille 130M", maker: "Nikita Martynov", params: "130M", downloadGb: 0.26, needsRamGb: 1, speed: 5,
        mlx: "mlx-community/lille-130m-instruct-bf16"
    ),
    LocalModel(
        id: "gpt-oss-20b", name: "gpt-oss 20B", maker: "OpenAI", params: "21B, 3.6B active", downloadGb: 12, needsRamGb: 16, speed: 4,
        mlx: "mlx-community/gpt-oss-20b-MXFP4-Q8"
    ),
    LocalModel(
        id: "qwen-3.6-27b", name: "Qwen 3.6 27B", maker: "Alibaba", params: "27B", downloadGb: 15.5, needsRamGb: 24, speed: 1,
        mlx: "mlx-community/Qwen3.6-27B-4bit"
    ),
    LocalModel(
        id: "deepseek-r1", name: "DeepSeek R1", maker: "DeepSeek", params: "671B, 37B active", downloadGb: 380, needsRamGb: 420, speed: 1,
        mlx: "mlx-community/DeepSeek-R1-4bit"
    ),
]

/// A small model that sees the slides paired with a larger one that writes (`ModelPair`):
/// the eye is shown each slide and notes what is on it, then the writer writes the summary
/// and LAQs from those notes. They run one after the other, so the memory needed is the
/// larger of the two. The eye runs on MLX.
public struct ModelPair: Equatable, Sendable {
    public var eye: String
    public var writer: String
    public var blurb: String

    public init(eye: String, writer: String, blurb: String) {
        self.eye = eye
        self.writer = writer
        self.blurb = blurb
    }
}

/// `PAIRS`.
public let modelPairs: [ModelPair] = [
    ModelPair(eye: "fastvlm-0.5b", writer: "gemma-4-e4b", blurb: "Light: through the slides in no time, on a modest laptop."),
    ModelPair(eye: "fastvlm-0.5b", writer: "gpt-oss-20b", blurb: "Quickest through the slides, and gpt-oss writes fast for its size."),
    ModelPair(eye: "qwen3-vl-4b", writer: "gpt-oss-20b", blurb: "Reads labels, figures and tables well, and still writes quickly."),
    ModelPair(eye: "qwen3-vl-4b", writer: "qwen-3.6-27b", blurb: "The most careful pair: slower, with thorough summaries and marking."),
]

private let parameterCountRe = Regex.compile(#"([0-9.]+)\s*([BM])"#, options: [.caseInsensitive])

/// "35B, 3B active" → 35e9; "135M" → 135e6 — for listing models smallest first.
public func parameterCount(_ model: LocalModel) -> Double {
    guard let match = Regex.firstMatch(parameterCountRe, in: model.params),
          let number = Regex.group(match, at: 1, in: model.params),
          let unit = Regex.group(match, at: 2, in: model.params) else {
        return 0
    }
    return jsNumberValue(.string(number)) * (unit.uppercased() == "B" ? 1e9 : 1e6)
}

/// The catalog entry for an id, from either list (`findModel`).
public func findModel(_ id: String?) -> LocalModel? {
    guard let id else { return nil }
    if let model = localModels.first(where: { $0.id == id }) {
        return model
    }
    return moreModels.first(where: { $0.id == id })
}

/// What this computer has, for picking a model (`MachineSpecs`).
public struct MachineSpecs: Equatable, Sendable {
    public var ramGb: Double
    public var cores: Int
    /// Unified memory and a GPU: much faster per GB.
    public var appleSilicon: Bool
    /// "Mac", "Windows PC", "Linux PC" — for the sentence on the card.
    public var kind: String

    public init(ramGb: Double, cores: Int, appleSilicon: Bool, kind: String) {
        self.ramGb = ramGb
        self.cores = cores
        self.appleSilicon = appleSilicon
        self.kind = kind
    }
}

public struct ModelPicks: Equatable, Sendable {
    public var performance: LocalModel
    public var recommended: LocalModel
    public var quality: LocalModel
    /// One line on why, for the onboarding card.
    public var why: String
    /// A warning when even the recommendation is a stretch, or quality will crawl.
    public var caution: String?

    public init(performance: LocalModel, recommended: LocalModel, quality: LocalModel, why: String, caution: String?) {
        self.performance = performance
        self.recommended = recommended
        self.quality = quality
        self.why = why
        self.caution = caution
    }
}

/// Three choices around what this computer can comfortably run (`recommendModels`): the
/// largest model that fits its memory in the middle, one size down for speed, one up for
/// quality. Without Apple Silicon or a lot of cores, everything runs on the CPU, so the
/// middle pick drops a size to stay usable.
public func recommendModels(_ specs: MachineSpecs) -> ModelPicks {
    let ladder = localModels
    let lowest = 1 // the tiny model is only ever the fast option, never the default
    let highest = ladder.count - 2 // the largest is only ever the quality option

    var rec = lowest
    // Half a GB of slack: a "16 GB" machine can report 15.6 once the system takes its share.
    for i in lowest...highest where ladder[i].needsRamGb <= specs.ramGb + 0.5 {
        rec = i
    }
    let cpuOnly = !specs.appleSilicon && specs.cores < 8
    if cpuOnly {
        rec = max(lowest, rec - 1)
    }

    let performance = ladder[rec - 1]
    let recommended = ladder[rec]
    let quality = ladder[rec + 1]
    let ram = "\(jsNumberString(jsMathRound(specs.ramGb))) GB memory"
    let chip = specs.appleSilicon ? "Apple Silicon" : "\(specs.cores) cores"
    let why = cpuOnly
        ? "Your \(specs.kind) has \(ram) and \(chip), and will run models on its processor — so a size down keeps each lecture to minutes, not hours."
        : "Your \(specs.kind) has \(ram) and \(chip): this is the largest model that runs comfortably on it."

    var caution: String?
    if specs.ramGb < recommended.needsRamGb {
        caution = "With \(ram), even the recommended model is a squeeze — close other apps while it works, or use Performance."
    } else if specs.ramGb < quality.needsRamGb {
        caution = "Quality wants about \(jsNumberString(quality.needsRamGb)) GB of memory; on this computer it will be slow."
    }
    return ModelPicks(performance: performance, recommended: recommended, quality: quality, why: why, caution: caution)
}

// MARK: - Installed models (lib/models.ts)

/// The setting the registry of downloaded models is kept in (`REGISTRY_KEY`).
public let localModelsSettingKey = "localModels"

/// A downloaded model, as the registry records it.
public struct InstalledModel: Equatable, Sendable {
    public var id: String
    /// Absolute: a folder for MLX, a file for llama.cpp.
    public var path: String
    public var bytes: Int
    public var downloadedAt: String
    /// "mlx": a folder for the MLX engine. Absent or "gguf": a file for llama.cpp, which
    /// only the Electron app runs.
    public var format: String?

    public init(id: String, path: String, bytes: Int, downloadedAt: String, format: String? = nil) {
        self.id = id
        self.path = path
        self.bytes = bytes
        self.downloadedAt = downloadedAt
        self.format = format
    }

    public var isMLX: Bool { format == "mlx" }

    /// A registry entry, when it names a model and where it is.
    init?(registryEntry fields: JSONObject) {
        guard case .string(let id)? = fields["id"], case .string(let path)? = fields["path"] else { return nil }
        self.init(
            id: id,
            path: path,
            bytes: fields["bytes"]?.intValue ?? 0,
            downloadedAt: fields["downloadedAt"]?.stringValue ?? "",
            format: fields["format"]?.stringValue
        )
    }
}

/// A catalog model and the folder it was downloaded to.
public struct ActiveLocalModel: Equatable, Sendable {
    public var model: LocalModel
    public var path: String

    public init(model: LocalModel, path: String) {
        self.model = model
        self.path = path
    }
}

/// Where downloaded models are kept (`modelsDir()`): `LOCKIN_MODELS_DIR`, else `models`
/// in the data folder.
public func modelsDirectory(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
    if let configured = environment["LOCKIN_MODELS_DIR"], !configured.isEmpty {
        return URL(fileURLWithPath: configured, isDirectory: true)
    }
    return LockinPaths.modelsDirectory
}

/// The registry read, with moved models found again: the models whose files are there,
/// and the registry to write back when a path was corrected.
private struct ModelRegistryScan {
    var installed: [InstalledModel]
    var rewrite: JSONValue?
}

/// `readRegistry()` and the looking of `installedModels()`, without writing anything. An
/// entry that names no model and path is kept as it is and never counts as installed.
private func scanModelRegistry(db: Database, environment: [String: String]) throws -> ModelRegistryScan {
    guard let row = try Setting.fetchOne(db, key: localModelsSettingKey),
          let parsed = try? JSONValue.parse(row.value),
          case .array(let entries) = parsed else {
        return ModelRegistryScan(installed: [], rewrite: nil)
    }
    let folder = modelsDirectory(environment: environment)
    let files = FileManager.default
    var moved = false
    var kept: [JSONValue] = []
    var installed: [InstalledModel] = []
    for entry in entries {
        guard case .object(var fields) = entry, let model = InstalledModel(registryEntry: fields) else {
            kept.append(entry)
            continue
        }
        if files.fileExists(atPath: model.path) {
            kept.append(entry)
            installed.append(model)
            continue
        }
        let here: String
        if model.isMLX {
            here = folder.appendingPathComponent("mlx", isDirectory: true).appendingPathComponent(model.id).path
        } else {
            here = folder.appendingPathComponent((model.path as NSString).lastPathComponent).path
        }
        guard files.fileExists(atPath: here) else {
            kept.append(entry)
            continue
        }
        moved = true
        fields["path"] = .string(here)
        kept.append(.object(fields))
        var found = model
        found.path = here
        installed.append(found)
    }
    return ModelRegistryScan(installed: installed, rewrite: moved ? .array(kept) : nil)
}

/// Installed models whose files are still there — a deleted file is not installed
/// (`installedModels()`). A model whose folder was moved (from running Lockin out of its
/// code folder into the app's data folder, say) is found again in the models folder and
/// its path corrected in the registry. That needs a write; under a read-only connection the
/// model is still found, and the registry is corrected by the next look that can write.
public func installedModels(
    db: Database,
    environment: [String: String] = ProcessInfo.processInfo.environment
) throws -> [InstalledModel] {
    let scan = try scanModelRegistry(db: db, environment: environment)
    if let rewrite = scan.rewrite {
        try? setSetting(db: db, key: localModelsSettingKey, value: rewrite)
    }
    return scan.installed
}

/// The model local mode uses, if it is downloaded (`activeLocalModel()`). This app runs
/// offline models on MLX only, so a llama.cpp download counts as none.
public func activeLocalModel(
    db: Database,
    environment: [String: String] = ProcessInfo.processInfo.environment
) throws -> ActiveLocalModel? {
    let settings = try getSettings(db: db)
    let model = findModel(settings.localModel)
    let installed = try installedModels(db: db, environment: environment).first(where: { $0.id == settings.localModel })
    guard let model, let installed, installed.isMLX else { return nil }
    return ActiveLocalModel(model: model, path: installed.path)
}

/// The separate model that looks at the slides, when one is chosen, sees images, is
/// downloaded on MLX, and can run here (`activeSlideReader()`).
public func activeSlideReader(
    db: Database,
    engineAvailable: Bool = MLXEngine.isAvailable,
    environment: [String: String] = ProcessInfo.processInfo.environment
) throws -> ActiveLocalModel? {
    let settings = try getSettings(db: db)
    guard let model = findModel(settings.slideReader), model.vision, engineAvailable else { return nil }
    let installed = try installedModels(db: db, environment: environment).first(where: { $0.id == model.id && $0.isMLX })
    guard let installed else { return nil }
    return ActiveLocalModel(model: model, path: installed.path)
}

/// The offline model to fall back on when the cloud AI fails (`fallbackLocalModel()`):
/// the one chosen for local mode, else the first downloaded on MLX.
public func fallbackLocalModel(
    db: Database,
    environment: [String: String] = ProcessInfo.processInfo.environment
) throws -> ActiveLocalModel? {
    if let active = try activeLocalModel(db: db, environment: environment) {
        return active
    }
    for installed in try installedModels(db: db, environment: environment) where installed.isMLX {
        if let model = findModel(installed.id) {
            return ActiveLocalModel(model: model, path: installed.path)
        }
    }
    return nil
}

public func installedModels(
    database: LockinDatabase,
    environment: [String: String] = ProcessInfo.processInfo.environment
) throws -> [InstalledModel] {
    try withModelRegistry(database, environment: environment) { db in
        try installedModels(db: db, environment: environment)
    }
}

public func activeLocalModel(
    database: LockinDatabase,
    environment: [String: String] = ProcessInfo.processInfo.environment
) throws -> ActiveLocalModel? {
    try withModelRegistry(database, environment: environment) { db in
        try activeLocalModel(db: db, environment: environment)
    }
}

public func activeSlideReader(
    database: LockinDatabase,
    engineAvailable: Bool = MLXEngine.isAvailable,
    environment: [String: String] = ProcessInfo.processInfo.environment
) throws -> ActiveLocalModel? {
    try withModelRegistry(database, environment: environment) { db in
        try activeSlideReader(db: db, engineAvailable: engineAvailable, environment: environment)
    }
}

public func fallbackLocalModel(
    database: LockinDatabase,
    environment: [String: String] = ProcessInfo.processInfo.environment
) throws -> ActiveLocalModel? {
    try withModelRegistry(database, environment: environment) { db in
        try fallbackLocalModel(db: db, environment: environment)
    }
}

/// Runs `body` with a read, or with a write when a moved model's path is to be corrected.
private func withModelRegistry<T>(
    _ database: LockinDatabase,
    environment: [String: String],
    _ body: (Database) throws -> T
) throws -> T {
    let moved = try database.reader.read { db in
        try scanModelRegistry(db: db, environment: environment).rewrite != nil
    }
    if moved {
        return try database.writer.write { db in
            try body(db)
        }
    }
    return try database.reader.read { db in
        try body(db)
    }
}
