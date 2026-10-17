import Foundation

/// Where Lockin keeps its database, uploaded lecture files, prompts and migrations.
///
/// Matches `lib/paths.ts` and `electron/main.ts`, keeping `databaseFile` and
/// `materialsDirectory` rooted in the same data folder at all times.
public enum LockinPaths {
    public static var repoRoot: URL? {
        var dir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for _ in 0..<6 {
            let prisma = dir.appendingPathComponent("prisma/schema.prisma")
            if FileManager.default.fileExists(atPath: prisma.path) {
                return dir
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }

    public static var appSupportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Lockin", isDirectory: true)
    }

    /// Whether the current process should use the repository's data (`<repo>/prisma/lockin.db` + `<repo>/materials`)
    /// rather than `~/Library/Application Support/Lockin`.
    private static var usesRepoData: Bool {
        if let env = ProcessInfo.processInfo.environment["LOCKIN_DATA_DIR"], !env.isEmpty {
            return false
        }
        if Bundle.main.bundlePath.hasSuffix(".app") {
            return false
        }
        guard let root = repoRoot else { return false }
        let repoPrismaDb = root.appendingPathComponent("prisma/lockin.db")
        if nonEmptyFile(at: repoPrismaDb) {
            return true
        }
        let appSupportDb = appSupportDirectory.appendingPathComponent("lockin.db")
        if nonEmptyFile(at: appSupportDb) {
            return false
        }
        return true
    }

    public static var dataDirectory: URL {
        if let env = ProcessInfo.processInfo.environment["LOCKIN_DATA_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        if usesRepoData, let root = repoRoot {
            return root
        }
        return appSupportDirectory
    }

    public static var databaseFile: URL {
        if let urlEnv = ProcessInfo.processInfo.environment["DATABASE_URL"], !urlEnv.isEmpty {
            let stripped = urlEnv.hasPrefix("file:") ? String(urlEnv.dropFirst(5)) : urlEnv
            if stripped.hasPrefix("/") {
                return URL(fileURLWithPath: stripped)
            }
            let base = repoRoot ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            return base.appendingPathComponent(stripped).standardizedFileURL
        }
        if let env = ProcessInfo.processInfo.environment["LOCKIN_DATA_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true).appendingPathComponent("lockin.db")
        }
        if usesRepoData, let root = repoRoot {
            return root.appendingPathComponent("prisma/lockin.db")
        }
        return appSupportDirectory.appendingPathComponent("lockin.db")
    }

    public static var materialsDirectory: URL {
        dataDirectory.appendingPathComponent("materials", isDirectory: true)
    }

    public static var modelsDirectory: URL {
        dataDirectory.appendingPathComponent("models", isDirectory: true)
    }

    public static var promptsDirectory: URL {
        if let env = ProcessInfo.processInfo.environment["LOCKIN_PROMPTS_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("prompts"),
           FileManager.default.fileExists(atPath: bundled.path) {
            return bundled
        }
        if let root = repoRoot {
            return root.appendingPathComponent("prompts", isDirectory: true)
        }
        return dataDirectory.appendingPathComponent("prompts", isDirectory: true)
    }

    public static var migrationsDirectory: URL? {
        if let env = ProcessInfo.processInfo.environment["LOCKIN_MIGRATIONS_DIR"], !env.isEmpty {
            let url = URL(fileURLWithPath: env, isDirectory: true)
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("migrations"),
           FileManager.default.fileExists(atPath: bundled.path) {
            return bundled
        }
        if let root = repoRoot {
            let url = root.appendingPathComponent("prisma/migrations", isDirectory: true)
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        return nil
    }

    public static var engineBinary: URL? {
        if let env = ProcessInfo.processInfo.environment["LOCKIN_ENGINE"], !env.isEmpty {
            let url = URL(fileURLWithPath: env)
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("engine/lockin-engine"),
           FileManager.default.fileExists(atPath: bundled.path) {
            return bundled
        }
        if let root = repoRoot {
            let built = root.appendingPathComponent("swift/LockinEngine/.build-xcode/Build/Products/Release/lockin-engine")
            if FileManager.default.fileExists(atPath: built.path) { return built }
        }
        return nil
    }

    private static func nonEmptyFile(at url: URL) -> Bool {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? NSNumber else { return false }
        return size.int64Value > 0
    }
}
