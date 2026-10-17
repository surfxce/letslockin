import Foundation

/// Where Lockin keeps its database, uploaded lecture files, prompts and migrations.
///
/// Matches `lib/paths.ts` and `electron/main.ts`:
/// - Packaged inside `.app`, writable state lives in `~/Library/Application Support/Lockin`.
/// - Running from the repo, uses `LOCKIN_DATA_DIR`, `DATABASE_URL`, `<repo>/prisma/lockin.db`,
///   or falls back to `~/Library/Application Support/Lockin`.
public enum LockinPaths {
    public static var repoRoot: URL? {
        var dir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        for _ in 0..<5 {
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

    public static var dataDirectory: URL {
        if let env = ProcessInfo.processInfo.environment["LOCKIN_DATA_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        let isBundledApp = Bundle.main.bundlePath.hasSuffix(".app")
        if !isBundledApp, let root = repoRoot {
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
        // Running from the repo: check prisma/lockin.db first (where `.env` points),
        // then ~/Library/Application Support/Lockin/lockin.db (where the installed app keeps it).
        if !Bundle.main.bundlePath.hasSuffix(".app"), let root = repoRoot {
            let repoPrismaDb = root.appendingPathComponent("prisma/lockin.db")
            if nonEmptyFile(at: repoPrismaDb) {
                return repoPrismaDb
            }
            let appSupportDb = appSupportDirectory.appendingPathComponent("lockin.db")
            if nonEmptyFile(at: appSupportDb) {
                return appSupportDb
            }
            return repoPrismaDb
        }
        return appSupportDirectory.appendingPathComponent("lockin.db")
    }

    public static var materialsDirectory: URL {
        dataDirectory.appendingPathComponent("materials", isDirectory: true)
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

    private static func nonEmptyFile(at url: URL) -> Bool {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? NSNumber else { return false }
        return size.int64Value > 0
    }
}
