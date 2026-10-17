import Foundation
import GRDB

private let supportedExtensions: Set<String> = [".txt", ".md", ".vtt", ".srt", ".pdf", ".pptx"]
private let maxScanFiles = 120
private let maxScanBytes = 80 * 1024 * 1024
private let skipDirectories: Set<String> = ["node_modules", ".git", ".venv", "__pycache__", "materials"]

public struct ScannedFile: Equatable, Sendable {
    public var absolutePath: String
    public var relativePath: String
    public var filename: String
    public var modifiedOn: Date
    public var bytes: Int
    public var kindGuess: MaterialKind
    public var text: String
    public var pages: Int?
    public var measuredHours: Double?
    public var warnings: [String]
    public var checksum: String

    public init(
        absolutePath: String,
        relativePath: String,
        filename: String,
        modifiedOn: Date,
        bytes: Int,
        kindGuess: MaterialKind,
        text: String,
        pages: Int?,
        measuredHours: Double?,
        warnings: [String],
        checksum: String
    ) {
        self.absolutePath = absolutePath
        self.relativePath = relativePath
        self.filename = filename
        self.modifiedOn = modifiedOn
        self.bytes = bytes
        self.kindGuess = kindGuess
        self.text = text
        self.pages = pages
        self.measuredHours = measuredHours
        self.warnings = warnings
        self.checksum = checksum
    }

    public var groupInput: GroupInput {
        GroupInput(
            relativePath: relativePath,
            kind: kindGuess.rawValue,
            modifiedOn: modifiedOn,
            measuredHours: measuredHours
        )
    }
}

public struct SkippedScanItem: Equatable, Sendable {
    public var path: String
    public var why: String

    public init(path: String, why: String) {
        self.path = path
        self.why = why
    }
}

public struct ScanResult: Equatable, Sendable {
    public var files: [ScannedFile]
    public var skipped: [SkippedScanItem]

    public init(files: [ScannedFile], skipped: [SkippedScanItem]) {
        self.files = files
        self.skipped = skipped
    }
}

public enum ScanFolderError: LocalizedError, Equatable {
    case noSuchFolder(String)
    case notAFolder(String)
    case message(String)

    public var errorDescription: String? {
        switch self {
        case .noSuchFolder(let root): return "no such folder: \(root)"
        case .notAFolder(let root): return "not a folder: \(root)"
        case .message(let msg): return msg
        }
    }
}

/// Walks a folder, parses everything it recognises, and returns enough of each file
/// to group them. Nothing is written and nothing is copied.
public func scanFolder(root: String) throws -> ScanResult {
    let fm = FileManager.default
    let rootURL = URL(fileURLWithPath: (root as NSString).expandingTildeInPath).standardizedFileURL
    let rootPath = rootURL.path

    var isDir: ObjCBool = false
    guard fm.fileExists(atPath: rootPath, isDirectory: &isDir) else {
        throw ScanFolderError.noSuchFolder(rootPath)
    }
    guard isDir.boolValue else {
        throw ScanFolderError.notAFolder(rootPath)
    }

    var found: [String] = []
    var skipped: [SkippedScanItem] = []

    func relativeToRoot(_ fullPath: String) -> String {
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        if fullPath.hasPrefix(prefix) {
            return String(fullPath.dropFirst(prefix.count))
        }
        return (fullPath as NSString).lastPathComponent
    }

    func walk(dir: String, depth: Int) {
        if depth > 4 || found.count >= maxScanFiles { return }
        guard let entries = try? fm.contentsOfDirectory(atPath: dir).sorted() else { return }
        for name in entries {
            if name.hasPrefix(".") { continue }
            let full = (dir as NSString).appendingPathComponent(name)
            var entryIsDir: ObjCBool = false
            guard fm.fileExists(atPath: full, isDirectory: &entryIsDir) else { continue }
            if entryIsDir.boolValue {
                if skipDirectories.contains(name) { continue }
                walk(dir: full, depth: depth + 1)
            } else {
                let ext = (name as NSString).pathExtension.lowercased()
                let dotExt = ext.isEmpty ? "" : ".\(ext)"
                if !supportedExtensions.contains(dotExt) {
                    skipped.append(SkippedScanItem(path: relativeToRoot(full), why: "unsupported file type"))
                    continue
                }
                if found.count >= maxScanFiles {
                    skipped.append(SkippedScanItem(path: relativeToRoot(full), why: "over the \(maxScanFiles)-file limit"))
                    continue
                }
                found.append(full)
            }
        }
    }

    walk(dir: rootPath, depth: 0)

    var files: [ScannedFile] = []
    for absolutePath in found {
        let rel = relativeToRoot(absolutePath)
        let attrs = (try? fm.attributesOfItem(atPath: absolutePath)) ?? [:]
        let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
        let mtime = (attrs[.modificationDate] as? Date) ?? Date()

        if size > maxScanBytes {
            skipped.append(SkippedScanItem(path: rel, why: "larger than 80MB"))
            continue
        }

        guard let data = try? Data(contentsOf: URL(fileURLWithPath: absolutePath)) else {
            skipped.append(SkippedScanItem(path: rel, why: "could not be parsed"))
            continue
        }

        let filename = (absolutePath as NSString).lastPathComponent
        do {
            let parsed = try parseMaterial(filename: filename, data: data)
            if parsed.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (parsed.pages ?? 0) == 0 {
                skipped.append(SkippedScanItem(path: rel, why: "no extractable text"))
                continue
            }
            files.append(
                ScannedFile(
                    absolutePath: absolutePath,
                    relativePath: rel,
                    filename: filename,
                    modifiedOn: mtime,
                    bytes: size,
                    kindGuess: guessKind(filename: absolutePath, text: parsed.text),
                    text: parsed.text,
                    pages: parsed.pages,
                    measuredHours: measureHours(parsed.text),
                    warnings: parsed.warnings,
                    checksum: checksum(data)
                )
            )
        } catch {
            skipped.append(SkippedScanItem(path: rel, why: error.localizedDescription))
        }
    }

    return ScanResult(files: files, skipped: skipped)
}

// MARK: - Excerpts & AI Folder Sorting (port of lib/sortfiles.ts)

public struct SortFileExcerpt: Equatable, Sendable {
    public var detail: String
    public var excerpt: String

    public init(detail: String, excerpt: String) {
        self.detail = detail
        self.excerpt = excerpt
    }
}

public struct SortFile: Equatable, Codable, Sendable {
    public var number: Int
    public var path: String
    public var detail: String
    public var excerpt: String

    public init(number: Int, path: String, detail: String, excerpt: String) {
        self.number = number
        self.path = path
        self.detail = detail
        self.excerpt = excerpt
    }
}

public func excerptOf(
    kind: String,
    text: String,
    budget: Int,
    pages: Int? = nil,
    hours: Double? = nil
) -> SortFileExcerpt {
    func cap(_ s: String) -> String {
        guard budget > 0 else { return "" }
        return s.utf16Count > budget ? "\(s.utf16Prefix(budget - 1))…" : s
    }

    if kind == MaterialKind.slides.rawValue {
        let markerRegex = #/(?m)^-{3} (?:Page|Slide) \d+ -{3}$/#
        var parts: [String] = []
        var lastEnd = text.startIndex
        for m in text.matches(of: markerRegex) {
            parts.append(String(text[lastEnd..<m.range.lowerBound]))
            lastEnd = m.range.upperBound
        }
        parts.append(String(text[lastEnd...]))
        let pageBodies = parts.count > 1 ? Array(parts.dropFirst()) : []
        let rawFirstLines = pageBodies.map { body -> String in
            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            let first = trimmed.components(separatedBy: "\n").first ?? ""
            return first.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let firstLines = rawFirstLines.compactMap { line -> String? in
            if line.hasPrefix("(no text") || line.isEmpty { return nil }
            return line.utf16Prefix(70)
        }
        let total = pages ?? pageBodies.count
        let blank = total - firstLines.count
        let detail = "slides, \(total) page\(total == 1 ? "" : "s")\(blank > 0 ? ", \(blank) without text" : "")"
        let fallback = text.replacing(#/\s+/#, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        let joined = firstLines.joined(separator: " · ")
        return SortFileExcerpt(detail: detail, excerpt: cap(joined.isEmpty ? fallback : joined))
    }

    let spoken = text
        .replacing(#/(?m)^WEBVTT.*$/#, with: "")
        .replacing(#/(?m)^\d+\s*$/#, with: "")
        .replacing(#/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*\S+/#, with: "")
        .replacing(#/\[(?:\d+:)?\d{2}:\d{2}\]/#, with: "")
        .replacing(#/\s+/#, with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)

    if kind == MaterialKind.transcript.rawValue {
        let minutes = hours.map { Int(($0 * 60.0).rounded()) }
        let minPart = (minutes != nil && minutes! > 0) ? ", \(minutes!) min" : ""
        return SortFileExcerpt(detail: "transcript\(minPart)", excerpt: cap(spoken))
    }

    let label = kind.lowercased().replacingOccurrences(of: "_", with: " ")
    return SortFileExcerpt(detail: label, excerpt: cap(spoken))
}

public func describeForSort(root: String, relPaths: [String], budget: Int) throws -> [SortFile] {
    let rootURL = URL(fileURLWithPath: root).standardizedFileURL
    var out: [SortFile] = []
    for (idx, rel) in relPaths.enumerated() {
        let absURL = URL(fileURLWithPath: rel, relativeTo: rootURL).standardizedFileURL
        let data = try Data(contentsOf: absURL)
        let parsed = try parseMaterial(filename: absURL.lastPathComponent, data: data)
        let kind = guessKind(filename: absURL.path, text: parsed.text)
        let ex = excerptOf(
            kind: kind.rawValue,
            text: parsed.text,
            budget: budget,
            pages: parsed.pages,
            hours: measureHours(parsed.text)
        )
        out.append(SortFile(number: idx + 1, path: rel, detail: ex.detail, excerpt: ex.excerpt))
    }
    return out
}

public func formatSortFilesVar(_ files: [SortFile]) -> String {
    files.map { f in
        let cleanExcerpt = f.excerpt.replacing(#/\s+/#, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return "[\(f.number)] \(f.path) — \(f.detail)\n    \(cleanExcerpt.isEmpty ? "(no text)" : cleanExcerpt)"
    }.joined(separator: "\n")
}

private struct RawNumberedFolderSort: Decodable {
    struct LectureItem: Decodable {
        var title: String
        var module: String?
        var files: [Int]
    }
    struct SetAsideItem: Decodable {
        var file: Int
        var reason: String?
    }
    var lectures: [LectureItem]
    var setAside: [SetAsideItem]?
}

public func resolveFolderSortResponse(_ rawJson: String, files: [SortFile]) throws -> SortedFolder {
    let cleaned = rawJson
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .replacing(#/\A```(?:json)?\s*/#.ignoresCase(), with: "")
        .replacing(#/\s*```\z/#, with: "")
    guard let data = cleaned.data(using: .utf8) else {
        throw ScanFolderError.message("AI sort returned invalid UTF-8")
    }
    let decoded = try JSONDecoder().decode(RawNumberedFolderSort.self, from: data)
    func pathOf(_ n: Int) -> String? {
        guard n >= 1 && n <= files.count else { return nil }
        return files[n - 1].path
    }
    return SortedFolder(
        lectures: decoded.lectures.map { l in
            .init(
                title: l.title,
                module: l.module,
                files: l.files.compactMap(pathOf)
            )
        },
        setAside: (decoded.setAside ?? []).compactMap { s in
            guard let path = pathOf(s.file) else { return nil }
            return .init(file: path, reason: s.reason ?? "")
        }
    )
}

public func enqueueSortJob(
    db: Database,
    root: String,
    relPaths: [String],
    budget: Int = 600
) throws -> Job {
    let files = try describeForSort(root: root, relPaths: relPaths, budget: budget)
    struct Payload: Encodable {
        var root: String
        var files: [SortFile]
    }
    let payloadData = try JSONEncoder().encode(Payload(root: root, files: files))
    let payloadString = String(decoding: payloadData, as: UTF8.self)
    var job = Job(
        kind: .sort,
        payload: payloadString,
        lectureId: nil,
        status: .pending,
        priority: 0
    )
    try job.insert(db)
    return job
}

// MARK: - Import Review State & Ingestion (port of ImportFlow.tsx, app/actions.ts, lib/materials.ts)

public struct ExistingLectureRef: Equatable, Sendable {
    public var id: String
    public var title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

public enum ImportRowStatus: String, Equatable, Sendable {
    case new
    case adds
    case have
}

public struct ImportReviewRow: Identifiable, Equatable, Sendable {
    public var id: Int { index }
    public var index: Int
    public var proposed: ProposedLecture
    public var title: String
    public var moduleTitle: String
    public var deliveredOn: String
    public var durationHours: Double
    public var included: Bool
    public var droppedFileIndexes: Set<Int>
    public var home: ExistingLectureRef?
    public var freshFileIndexes: [Int]
    public var status: ImportRowStatus

    public var keptFileIndexes: [Int] {
        proposed.fileIndexes.filter { !droppedFileIndexes.contains($0) }
    }

    public mutating func toggleDropFile(_ fileIndex: Int) {
        if droppedFileIndexes.contains(fileIndex) {
            droppedFileIndexes.remove(fileIndex)
        } else if proposed.fileIndexes.count > 1 {
            droppedFileIndexes.insert(fileIndex)
        }
    }
}

/// Finds which scanned files (by index) already exist in the given course by checksum.
public func existingFilesInCourse(
    db: Database,
    courseId: String,
    scannedFiles: [ScannedFile]
) throws -> [Int: [ExistingLectureRef]] {
    let courseLectures = try Lecture
        .filter(Column("courseId") == courseId)
        .fetchAll(db)
    if courseLectures.isEmpty { return [:] }

    let lectureById = Dictionary(uniqueKeysWithValues: courseLectures.map { ($0.id, $0) })
    let lectureIds = courseLectures.map(\.id)
    let materials = try Material
        .filter(lectureIds.contains(Column("lectureId")))
        .fetchAll(db)

    var heldByChecksum: [String: [ExistingLectureRef]] = [:]
    for m in materials {
        guard let lid = m.lectureId, let lec = lectureById[lid] else { continue }
        var list = heldByChecksum[m.checksum] ?? []
        if !list.contains(where: { $0.id == lec.id }) {
            list.append(ExistingLectureRef(id: lec.id, title: lec.title))
        }
        heldByChecksum[m.checksum] = list
    }

    var result: [Int: [ExistingLectureRef]] = [:]
    for (idx, file) in scannedFiles.enumerated() {
        if let refs = heldByChecksum[file.checksum], !refs.isEmpty {
            result[idx] = refs
        }
    }
    return result
}

public func homeLectureOf(
    proposed: ProposedLecture,
    files: [ScannedFile],
    inLectures: [Int: [ExistingLectureRef]]
) -> ExistingLectureRef? {
    var scores: [String: (ref: ExistingLectureRef, score: Int)] = [:]
    var order: [String] = []
    for n in proposed.fileIndexes {
        guard n >= 0 && n < files.count else { continue }
        let weight = (files[n].kindGuess == .transcript) ? 10 : 1
        for ref in inLectures[n] ?? [] {
            if scores[ref.id] == nil {
                order.append(ref.id)
                scores[ref.id] = (ref, 0)
            }
            scores[ref.id]?.score += weight
        }
    }
    return order
        .compactMap { scores[$0] }
        .sorted { $0.score > $1.score }
        .first?
        .ref
}

public func buildImportReviewRows(
    lectures: [ProposedLecture],
    files: [ScannedFile],
    inLectures: [Int: [ExistingLectureRef]] = [:]
) -> [ImportReviewRow] {
    lectures.enumerated().map { idx, l in
        let home = homeLectureOf(proposed: l, files: files, inLectures: inLectures)
        let fresh = l.fileIndexes.filter { n in
            !(inLectures[n] ?? []).contains { $0.id == home?.id }
        }
        let status: ImportRowStatus = (home == nil) ? .new : (!fresh.isEmpty ? .adds : .have)
        let included = (l.setAside == nil) && (status != .have)
        return ImportReviewRow(
            index: idx,
            proposed: l,
            title: l.title,
            moduleTitle: l.moduleTitle ?? "",
            deliveredOn: l.deliveredOn,
            durationHours: l.durationHours,
            included: included,
            droppedFileIndexes: [],
            home: home,
            freshFileIndexes: fresh,
            status: status
        )
    }
}

/// Moves a file index from one review row to another and recomputes both rows' status.
public func moveFileInReviewRows(
    _ rows: inout [ImportReviewRow],
    fileIndex: Int,
    fromRow: Int,
    toRow: Int,
    files: [ScannedFile],
    inLectures: [Int: [ExistingLectureRef]] = [:]
) {
    guard fromRow != toRow,
          fromRow >= 0, fromRow < rows.count,
          toRow >= 0, toRow < rows.count else { return }

    rows[fromRow].proposed.fileIndexes.removeAll { $0 == fileIndex }
    rows[fromRow].droppedFileIndexes.remove(fileIndex)
    if !rows[toRow].proposed.fileIndexes.contains(fileIndex) {
        rows[toRow].proposed.fileIndexes.append(fileIndex)
        rows[toRow].proposed.fileIndexes.sort()
    }
    rows[toRow].droppedFileIndexes.remove(fileIndex)

    for i in [fromRow, toRow] {
        let home = homeLectureOf(proposed: rows[i].proposed, files: files, inLectures: inLectures)
        let kept = rows[i].keptFileIndexes
        let fresh = kept.filter { n in
            !(inLectures[n] ?? []).contains { $0.id == home?.id }
        }
        rows[i].home = home
        rows[i].freshFileIndexes = fresh
        rows[i].status = (home == nil) ? .new : (!fresh.isEmpty ? .adds : .have)
        if rows[i].proposed.fileIndexes.isEmpty {
            rows[i].included = false
        }
    }
}

/// Stores a file under materials/<scope>/<checksum>_<safeName> and inserts its Material row.
@discardableResult
public func ingestFile(
    db: Database,
    filename: String,
    data: Data,
    lectureId: String? = nil,
    courseId: String? = nil,
    kind: MaterialKind? = nil,
    materialsDir: URL = LockinPaths.materialsDirectory
) throws -> (material: Material, warnings: [String]) {
    let parsed = try parseMaterial(filename: filename, data: data)
    let resolvedKind = kind ?? guessKind(filename: filename, text: parsed.text)
    let hash = checksum(data)

    let scope = lectureId ?? courseId ?? "loose"
    let safeName = filename.replacing(#/[^\w.\-]+/#, with: "_")
    let relPath = "\(scope)/\(hash)_\(safeName)"
    let scopeDir = materialsDir.appendingPathComponent(scope, isDirectory: true)
    try FileManager.default.createDirectory(at: scopeDir, withIntermediateDirectories: true)
    let destURL = materialsDir.appendingPathComponent(relPath, isDirectory: false)
    try data.write(to: destURL, options: .atomic)

    var material = Material(
        courseId: courseId,
        lectureId: lectureId,
        kind: resolvedKind,
        path: relPath,
        originalName: filename,
        extractedText: parsed.text,
        pageCount: parsed.pages,
        checksum: hash
    )
    try material.insert(db)
    return (material, parsed.warnings)
}

private func resolveOrCreateModuleId(
    db: Database,
    courseId: String,
    title: String,
    cache: inout [String: String]
) throws -> String? {
    let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { return nil }
    let key = name.lowercased()
    if let hit = cache[key] { return hit }

    if let existing = try Module
        .filter(Column("courseId") == courseId && Column("title") == name)
        .fetchOne(db) {
        cache[key] = existing.id
        return existing.id
    }

    let count = try Module.filter(Column("courseId") == courseId).fetchCount(db)
    var mod = Module(courseId: courseId, title: name, position: count)
    try mod.insert(db)
    cache[key] = mod.id
    return mod.id
}

/// Queues lectures to be prepared one at a time, in order.
@discardableResult
public func queuePrepare(
    db: Database,
    lectureIds: [String],
    redo: Bool = false
) throws -> Int {
    guard !lectureIds.isEmpty else { return 0 }
    let busyJobs = try Job
        .filter(
            lectureIds.contains(Column("lectureId")) &&
                Column("kind") == JobKind.prepare.rawValue &&
                [JobStatus.pending.rawValue, JobStatus.running.rawValue].contains(Column("status"))
        )
        .fetchAll(db)
    let busyLectureIds = Set(busyJobs.compactMap(\.lectureId))

    var queued = 0
    for lid in lectureIds where !busyLectureIds.contains(lid) {
        let payload = #"{"lectureId":"\#(lid)","redo":\#(redo ? "true" : "false")}"#
        var job = Job(
            kind: .prepare,
            payload: payload,
            lectureId: lid,
            status: .pending,
            priority: 0
        )
        try job.insert(db)
        queued += 1
    }
    return queued
}

public struct ImportSummary: Equatable, Sendable {
    public var createdLectureIds: [String]
    public var updatedLectureIds: [String]

    public init(createdLectureIds: [String], updatedLectureIds: [String]) {
        self.createdLectureIds = createdLectureIds
        self.updatedLectureIds = updatedLectureIds
    }
}

/// Creates the reviewed lectures (or adds fresh files to existing ones) and optionally queues AI preparation.
public func importReviewedLectures(
    db: Database,
    courseId: String,
    root: String,
    rows: [ImportReviewRow],
    files: [ScannedFile],
    prepareWithAi: Bool = true,
    materialsDir: URL = LockinPaths.materialsDirectory
) throws -> ImportSummary {
    let ticked = rows.filter(\.included)
    if ticked.isEmpty {
        throw ScanFolderError.message("Tick at least one lecture to import.")
    }
    if ticked.contains(where: { $0.keptFileIndexes.isEmpty }) {
        throw ScanFolderError.message("A ticked lecture has no files left — tick a file back, or untick the lecture.")
    }

    let rootURL = URL(fileURLWithPath: root).standardizedFileURL
    let rootPrefix = rootURL.path.hasSuffix("/") ? rootURL.path : rootURL.path + "/"
    var missing: [String] = []

    for row in ticked {
        for idx in row.keptFileIndexes {
            guard idx >= 0 && idx < files.count else { continue }
            let rel = files[idx].relativePath
            let absURL = URL(fileURLWithPath: rel, relativeTo: rootURL).standardizedFileURL
            if !absURL.path.hasPrefix(rootPrefix) {
                throw ScanFolderError.message("\(rel) is outside \(rootURL.path).")
            }
            if !FileManager.default.fileExists(atPath: absURL.path) {
                missing.append(rel)
            }
        }
    }
    if !missing.isEmpty {
        throw ScanFolderError.message("These files have moved since the scan: \(missing.joined(separator: ", ")). Scan again.")
    }

    var moduleCache: [String: String] = [:]
    var created: [String] = []
    var added: [String] = []

    for row in ticked {
        if row.status == .adds, let home = row.home {
            if let existingLecture = try Lecture
                .filter(Column("id") == home.id && Column("courseId") == courseId)
                .fetchOne(db) {
                let existingMats = try Material.filter(Column("lectureId") == existingLecture.id).fetchAll(db)
                let existingChecksums = Set(existingMats.map(\.checksum))
                var freshCount = 0
                for idx in row.keptFileIndexes {
                    let rel = files[idx].relativePath
                    let absURL = URL(fileURLWithPath: rel, relativeTo: rootURL).standardizedFileURL
                    let data = try Data(contentsOf: absURL)
                    if existingChecksums.contains(checksum(data)) { continue }
                    _ = try ingestFile(
                        db: db,
                        filename: absURL.lastPathComponent,
                        data: data,
                        lectureId: existingLecture.id,
                        materialsDir: materialsDir
                    )
                    freshCount += 1
                }
                if freshCount > 0 {
                    added.append(existingLecture.id)
                }
                continue
            }
        }

        let trimmedTitle = row.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalTitle = trimmedTitle.isEmpty
            ? (row.proposed.title.isEmpty ? "Untitled lecture" : row.proposed.title)
            : trimmedTitle
        let autoTitle = trimmedTitle.isEmpty || trimmedTitle == row.proposed.title
        let delivered = fromDateInput(row.deliveredOn) ?? Date()
        let hours = (row.durationHours.isFinite && row.durationHours > 0) ? row.durationHours : 1.0
        let modId = try resolveOrCreateModuleId(
            db: db,
            courseId: courseId,
            title: row.moduleTitle,
            cache: &moduleCache
        )

        var lecture = Lecture(
            courseId: courseId,
            moduleId: modId,
            title: finalTitle,
            deliveredOn: delivered,
            durationHours: hours,
            autoTitle: autoTitle
        )
        try lecture.insert(db)

        do {
            for idx in row.keptFileIndexes {
                let rel = files[idx].relativePath
                let absURL = URL(fileURLWithPath: rel, relativeTo: rootURL).standardizedFileURL
                let data = try Data(contentsOf: absURL)
                _ = try ingestFile(
                    db: db,
                    filename: absURL.lastPathComponent,
                    data: data,
                    lectureId: lecture.id,
                    materialsDir: materialsDir
                )
            }
        } catch {
            _ = try? Lecture.deleteOne(db, key: lecture.id)
            throw ScanFolderError.message(#"Stopped at "\#(finalTitle)": \#(error.localizedDescription)"#)
        }
        created.append(lecture.id)
    }

    if prepareWithAi {
        _ = try queuePrepare(db: db, lectureIds: created, redo: false)
        _ = try queuePrepare(db: db, lectureIds: added, redo: true)
    }

    return ImportSummary(createdLectureIds: created, updatedLectureIds: added)
}
