import Foundation

/// Slide pictures, downloaded at sync so summaries and cards show them offline. They
/// can always be fetched again, so they stay out of iCloud backups.
final class ImageStore: @unchecked Sendable {
    let root: URL

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var root = support.appendingPathComponent("Slides", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? root.setResourceValues(values)
        self.root = root
    }

    private func safe(_ text: String) -> String {
        String(text.map { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") ? $0 : "_" })
    }

    private func file(lectureId: String, ref: String) -> URL {
        root.appendingPathComponent(safe(lectureId), isDirectory: true).appendingPathComponent(safe(ref) + ".jpg")
    }

    func has(lectureId: String, ref: String) -> Bool {
        FileManager.default.fileExists(atPath: file(lectureId: lectureId, ref: ref).path)
    }

    func data(lectureId: String, ref: String) -> Data? {
        try? Data(contentsOf: file(lectureId: lectureId, ref: ref))
    }

    func write(_ data: Data, lectureId: String, ref: String) {
        let url = file(lectureId: lectureId, ref: ref)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    /// Deletes pictures no summary or card shows any more.
    func prune(keeping wanted: [(lectureId: String, ref: String)]) {
        let keep = Set(wanted.map { file(lectureId: $0.lectureId, ref: $0.ref).standardizedFileURL.path })
        let fm = FileManager.default
        guard let lectures = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for folder in lectures {
            let files = (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
            for f in files where !keep.contains(f.standardizedFileURL.path) { try? fm.removeItem(at: f) }
            if (try? fm.contentsOfDirectory(atPath: folder.path))?.isEmpty == true { try? fm.removeItem(at: folder) }
        }
    }

    func removeAll() {
        let fm = FileManager.default
        for item in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] {
            try? fm.removeItem(at: item)
        }
    }
}
