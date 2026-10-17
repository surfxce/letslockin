import Compression
import CryptoKit
import Foundation
import PDFKit

public struct ParsedFile: Equatable, Sendable {
    public var text: String
    public var warnings: [String]
    public var pages: Int?

    public init(text: String, warnings: [String] = [], pages: Int? = nil) {
        self.text = text
        self.warnings = warnings
        self.pages = pages
    }
}

public enum MaterialParseError: LocalizedError, Equatable {
    case unsupportedExtension(String)
    case unreadablePdf
    case noSlidesInPptx

    public var errorDescription: String? {
        switch self {
        case .unsupportedExtension(let ext):
            return #"cannot parse "\#(ext)" — supported: .txt .md .vtt .srt .pdf .pptx"#
        case .unreadablePdf:
            return "could not read PDF document"
        case .noSlidesInPptx:
            return "no slides found inside the .pptx — is the file complete?"
        }
    }
}

/// Parsing happens once, at ingest. Every later model call reads the stored text,
/// so a bad extraction is caught and corrected before four phases sit on top of it.
public func parseMaterial(filename: String, data: Data) throws -> ParsedFile {
    let ext = (filename as NSString).pathExtension.lowercased()
    let dotExt = ext.isEmpty ? "" : ".\(ext)"
    switch dotExt {
    case ".txt", ".md":
        return ParsedFile(text: String(decoding: data, as: UTF8.self), warnings: [])
    case ".vtt", ".srt":
        return parseCaptions(String(decoding: data, as: UTF8.self))
    case ".pdf":
        return try parsePdf(data: data)
    case ".pptx":
        return try parsePptx(data: data)
    default:
        throw MaterialParseError.unsupportedExtension(dotExt.isEmpty ? filename : dotExt)
    }
}

/// Extension alone is not enough: .txt and .md are used for both transcripts and
/// exported slide notes. Look at the text when there is text.
public func guessKind(filename: String, text: String? = nil) -> MaterialKind {
    let ext = (filename as NSString).pathExtension.lowercased()
    let dotExt = ext.isEmpty ? "" : ".\(ext)"
    if dotExt == ".pptx" { return .slides }
    if dotExt == ".vtt" || dotExt == ".srt" { return .transcript }

    if let text, !text.isEmpty {
        let head = text.utf16Prefix(4000)
        if text.contains(#/\A\s*WEBVTT/#) || head.contains(#/\[(?:\d+:)?\d{2}:\d{2}\]/#) {
            return .transcript
        }
        if head.contains(#/(?m)^-{3} (?:Slide|Page) \d+/#) || head.contains(#/(?m)^\s*Slide \d+\s*[:.]/#) {
            return .slides
        }
    }

    if dotExt == ".txt" || dotExt == ".md" { return .transcript }
    return .slides
}

public func checksum(_ data: Data) -> String {
    let digest = SHA256.hash(data: data)
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    return String(hex.prefix(16))
}

/// WebVTT/SRT into readable prose. Timestamps are kept at paragraph starts.
public func parseCaptions(_ raw: String) -> ParsedFile {
    let lines = raw.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var out: [String] = []
    var pending: String? = nil
    var lastStamp = ""
    var buffer: [String] = []

    func flush() {
        guard !buffer.isEmpty else { return }
        let text = dedupeRepeats(buffer.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines))
        if !text.isEmpty {
            let prefix = pending ?? lastStamp
            let line = "\(prefix) \(text)".trimmingCharacters(in: .whitespacesAndNewlines)
            out.append(line)
        }
        buffer.removeAll(keepingCapacity: true)
        pending = nil
    }

    let timeRegex = #/^(?:(\d+):)?(\d{2}):(\d{2})[.,]\d{3}\s+-->/#
    for line in lines {
        if let match = line.firstMatch(of: timeRegex) {
            let hours = match.1.flatMap { Int($0) } ?? 0
            let mins = String(match.2)
            let secs = String(match.3)
            let stamp = hours > 0 ? "[\(hours):\(mins):\(secs)]" : "[\(mins):\(secs)]"
            if stamp != lastStamp {
                flush()
                pending = stamp
                lastStamp = stamp
            }
            continue
        }
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || line.hasPrefix("WEBVTT") || trimmed.wholeMatch(of: #/\d+/#) != nil {
            continue
        }
        let stripped = line.replacing(#/<[^>]+>/#, with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        buffer.append(stripped)
    }
    flush()

    let text = out.joined(separator: "\n\n")
    let warnings = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        ? ["no caption text found — is this really a VTT/SRT file?"]
        : []
    return ParsedFile(text: text, warnings: warnings)
}

/// Live captions repeat the previous line as they extend it; collapse that.
private func dedupeRepeats(_ text: String) -> String {
    let words = text.split(whereSeparator: \.isWhitespace).map(String.init)
    var out: [String] = []
    for w in words {
        if out.count >= 2 && out[out.count - 1] == w && out[out.count - 2] == w {
            continue
        }
        out.append(w)
    }
    return out.joined(separator: " ")
}

public func parsePdf(data: Data) throws -> ParsedFile {
    guard let doc = PDFDocument(data: data) else {
        throw MaterialParseError.unreadablePdf
    }
    let totalPages = doc.pageCount
    var pageBlocks: [String] = []
    for i in 0..<totalPages {
        let pageText = (doc.page(at: i)?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !pageText.isEmpty {
            pageBlocks.append("--- Page \(i + 1) ---\n\(pageText)")
        }
    }
    let body = pageBlocks.joined(separator: "\n\n")
    var warnings: [String] = []
    let empty = totalPages - pageBlocks.count
    if empty > 0 {
        warnings.append(
            "\(empty) of \(totalPages) pages have no selectable text — pictures or scans. Claude Code reads " +
                "them as images; offline, Lockin reads their words with text recognition; for copy & paste, " +
                "attach the PDF in your AI chat."
        )
    }
    return ParsedFile(text: body, warnings: warnings, pages: totalPages)
}

/// A .pptx is a zip; slide text lives in <a:t> runs inside ppt/slides/slideN.xml.
public func parsePptx(data: Data) throws -> ParsedFile {
    let entries = extractZipEntries(from: data)
    let slideRegex = #/\Appt\/slides\/slide(\d+)\.xml\z/#
    let slideFiles: [(name: String, number: Int, content: Data)] = entries.compactMap { name, content in
        guard let m = name.firstMatch(of: slideRegex), let num = Int(m.1) else { return nil }
        return (name, num, content)
    }.sorted { $0.number < $1.number }

    if slideFiles.isEmpty {
        throw MaterialParseError.noSlidesInPptx
    }

    var sections: [String] = []
    var imageOnly: [Int] = []
    let runRegex = #/(?s)<a:t>(.*?)<\/a:t>/#

    for slide in slideFiles {
        let xml = String(decoding: slide.content, as: UTF8.self)
        let runs = xml.matches(of: runRegex).map { decodeXml(String($0.1)) }
        let body = runs
            .joined(separator: " ")
            .replacing(#/\s+/#, with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty {
            imageOnly.append(slide.number)
        }
        sections.append("--- Slide \(slide.number) ---\n\(body.isEmpty ? "(no text — image or diagram only)" : body)")
    }

    var warnings: [String] = []
    if !imageOnly.isEmpty {
        let list = imageOnly.map(String.init).joined(separator: ", ")
        warnings.append(
            "slide\(imageOnly.count == 1 ? "" : "s") \(list) carry no text " +
                "(diagram or image only) — describe them by hand if they matter."
        )
    }
    return ParsedFile(text: sections.joined(separator: "\n\n"), warnings: warnings, pages: slideFiles.count)
}

private func decodeXml(_ s: String) -> String {
    s
        .replacingOccurrences(of: "&lt;", with: "<")
        .replacingOccurrences(of: "&gt;", with: ">")
        .replacingOccurrences(of: "&quot;", with: "\"")
        .replacingOccurrences(of: "&apos;", with: "'")
        .replacingOccurrences(of: "&amp;", with: "&")
}

/// How long the lecture actually ran, from the transcript's own last timestamp.
public func measureHours(_ text: String) -> Double? {
    let matches = text.matches(of: #/\[(?:(\d+):)?(\d{2}):(\d{2})\]/#)
    guard let last = matches.last else { return nil }
    let h = last.1.flatMap { Int($0) } ?? 0
    let m = Int(last.2) ?? 0
    let s = Int(last.3) ?? 0
    let seconds = h * 3600 + m * 60 + s
    if seconds < 300 { return nil }
    let doubled = (Double(seconds) / 3600.0) * 2.0
    return floor(doubled + 0.5) / 2.0
}

// MARK: - Minimal In-Memory ZIP Reader for .pptx

private func extractZipEntries(from data: Data) -> [String: Data] {
    var result: [String: Data] = [:]
    let bytes = [UInt8](data)
    let count = bytes.count
    guard count >= 22 else { return result }

    func u16(_ offset: Int) -> Int {
        Int(bytes[offset]) | (Int(bytes[offset + 1]) << 8)
    }
    func u32(_ offset: Int) -> Int {
        Int(bytes[offset])
            | (Int(bytes[offset + 1]) << 8)
            | (Int(bytes[offset + 2]) << 16)
            | (Int(bytes[offset + 3]) << 24)
    }

    // Locate End of Central Directory (0x06054b50)
    var eocdOffset: Int? = nil
    let minSearch = max(0, count - 65_557)
    for i in stride(from: count - 22, through: minSearch, by: -1) {
        if bytes[i] == 0x50 && bytes[i + 1] == 0x4b && bytes[i + 2] == 0x05 && bytes[i + 3] == 0x06 {
            eocdOffset = i
            break
        }
    }
    guard let eocd = eocdOffset else { return result }

    let totalEntries = u16(eocd + 10)
    let cdOffset = u32(eocd + 16)
    var cursor = cdOffset

    for _ in 0..<totalEntries {
        guard cursor + 46 <= count else { break }
        guard bytes[cursor] == 0x50 && bytes[cursor + 1] == 0x4b && bytes[cursor + 2] == 0x01 && bytes[cursor + 3] == 0x02 else {
            break
        }
        let method = u16(cursor + 10)
        let compressedSize = u32(cursor + 20)
        let uncompressedSize = u32(cursor + 24)
        let nameLen = u16(cursor + 28)
        let extraLen = u16(cursor + 30)
        let commentLen = u16(cursor + 32)
        let localHeaderOffset = u32(cursor + 42)

        let nameStart = cursor + 46
        guard nameStart + nameLen <= count else { break }
        let name = String(decoding: bytes[nameStart..<(nameStart + nameLen)], as: UTF8.self)
        cursor = nameStart + nameLen + extraLen + commentLen

        guard localHeaderOffset + 30 <= count else { continue }
        guard bytes[localHeaderOffset] == 0x50 && bytes[localHeaderOffset + 1] == 0x4b && bytes[localHeaderOffset + 2] == 0x03 && bytes[localHeaderOffset + 3] == 0x04 else {
            continue
        }
        let localNameLen = u16(localHeaderOffset + 26)
        let localExtraLen = u16(localHeaderOffset + 28)
        let dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen
        guard dataStart >= 0, compressedSize >= 0, dataStart + compressedSize <= count else { continue }

        let payload = Data(bytes[dataStart..<(dataStart + compressedSize)])
        if method == 0 {
            result[name] = payload
        } else if method == 8 {
            if let inflated = inflateRawDeflate(payload, expectedSize: max(uncompressedSize, 64)) {
                result[name] = inflated
            }
        }
    }
    return result
}

private func inflateRawDeflate(_ data: Data, expectedSize: Int) -> Data? {
    if data.isEmpty { return Data() }
    var capacity = max(expectedSize + 256, data.count * 4, 4096)
    let maxCapacity = max(expectedSize * 16, 64 * 1024 * 1024)
    while capacity <= maxCapacity {
        var out = Data(count: capacity)
        let written: Int = data.withUnsafeBytes { srcPtr in
            out.withUnsafeMutableBytes { dstPtr in
                guard let srcBase = srcPtr.bindMemory(to: UInt8.self).baseAddress,
                      let dstBase = dstPtr.bindMemory(to: UInt8.self).baseAddress else {
                    return 0
                }
                return compression_decode_buffer(
                    dstBase,
                    capacity,
                    srcBase,
                    data.count,
                    nil,
                    COMPRESSION_ZLIB
                )
            }
        }
        if written > 0 && written < capacity {
            out.count = written
            return out
        }
        capacity *= 2
    }
    return nil
}
