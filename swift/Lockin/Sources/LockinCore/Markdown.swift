import Foundation

public struct SlideImages: Equatable, Sendable {
    public var base: String
    public var ranges: [(Int, Int)]
    public var croppable: Bool
    public var print: Bool

    public init(base: String, ranges: [(Int, Int)], croppable: Bool = false, print: Bool = false) {
        self.base = base
        self.ranges = ranges
        self.croppable = croppable
        self.print = print
    }

    public static func == (lhs: SlideImages, rhs: SlideImages) -> Bool {
        lhs.base == rhs.base
            && lhs.croppable == rhs.croppable
            && lhs.print == rhs.print
            && lhs.ranges.count == rhs.ranges.count
            && zip(lhs.ranges, rhs.ranges).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
    }
}

public struct Crop: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

private func jsRound(_ n: Double) -> Double {
    floor(n + 0.5)
}

private func jsNumber(_ raw: String?) -> Double {
    guard let raw else { return .nan }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return 0 }
    return Double(trimmed) ?? .nan
}

public func cleanCrop(x: Double?, y: Double?, w: Double?, h: Double?) -> Crop? {
    guard let x, let y, let w, let h else { return nil }
    let nums = [x, y, w, h]
    if nums.contains(where: { !$0.isFinite }) { return nil }
    func r(_ n: Double) -> Double {
        jsRound(min(1.0, max(0.0, n)) * 1000.0) / 1000.0
    }
    let rx = r(x)
    let ry = r(y)
    let rw = r(min(w, 1.0 - rx))
    let rh = r(min(h, 1.0 - ry))
    return (rw >= 0.02 && rh >= 0.02) ? Crop(x: rx, y: ry, w: rw, h: rh) : nil
}

public func cleanCrop(_ c: Crop?) -> Crop? {
    guard let c else { return nil }
    return cleanCrop(x: c.x, y: c.y, w: c.w, h: c.h)
}

private func formatNumber(_ n: Double) -> String {
    if n == n.rounded() {
        return String(Int(n))
    }
    var s = String(format: "%.3f", n)
    while s.hasSuffix("0") { s.removeLast() }
    if s.hasSuffix(".") { s.removeLast() }
    return s
}

public func formatCrop(_ c: Crop) -> String {
    [c.x, c.y, c.w, c.h].map(formatNumber).joined(separator: ",")
}

public func parseCrop(_ text: String?) -> Crop? {
    let parts = (text ?? "").components(separatedBy: ",")
    let x = parts.count > 0 ? jsNumber(parts[0]) : .nan
    let y = parts.count > 1 ? jsNumber(parts[1]) : .nan
    let w = parts.count > 2 ? jsNumber(parts[2]) : .nan
    let h = parts.count > 3 ? jsNumber(parts[3]) : .nan
    return cleanCrop(x: x, y: y, w: w, h: h)
}

private let cropPartRe = Regex.compile(#"#crop=([^\s)]*)\z"#, options: [.caseInsensitive])

/// Ordered list of crops plus dictionary access so `#crop=...` serialization preserves slide order.
public func markerCropsOrdered(_ src: String) -> [(Int, Crop)] {
    let decoded = src.removingPercentEncoding ?? src
    guard let m = Regex.firstMatch(cropPartRe, in: decoded),
          let raw = Regex.group(m, at: 1, in: decoded), !raw.isEmpty else {
        return []
    }
    var out: [(Int, Crop)] = []
    for part in raw.components(separatedBy: ";") {
        let kv = part.components(separatedBy: ":")
        let nRaw = kv.count > 0 ? kv[0] : nil
        let rectRaw = kv.count > 1 ? kv[1] : nil
        let num = jsNumber(nRaw)
        guard let crop = parseCrop(rectRaw),
              num.isFinite,
              num == floor(num),
              abs(num) <= Double(Int.max) else { continue }
        let n = Int(num)
        if let idx = out.firstIndex(where: { $0.0 == n }) {
            out[idx] = (n, crop)
        } else {
            out.append((n, crop))
        }
    }
    return out
}

public func markerCrops(_ src: String) -> [Int: Crop] {
    Dictionary(uniqueKeysWithValues: markerCropsOrdered(src))
}

public func slidePictureUrl(base: String, slide: Int, crop: Crop? = nil) -> String {
    if let crop {
        return "\(base)/\(slide)?crop=\(formatCrop(crop))"
    }
    return "\(base)/\(slide)"
}

private let maxPerFigure = 4
private let slideWordPat = #"(?:slides?|pages?|p)\s*[:#._-]?\s*"#
private let slideRefRe = Regex.compile(
    #"\A\s*"# + slideWordPat + #"(\d{1,3})(?:\s*(?:-|–|—|,|&|\+|to|and)\s*(?:"# + slideWordPat + #")?(\d{1,3}))?\s*\z"#,
    options: [.caseInsensitive]
)

public func slideNumbers(_ src: String) -> [Int]? {
    let decoded = src.removingPercentEncoding ?? src
    let withoutCrop = Regex.replaceFirst(cropPartRe, in: decoded, with: "")
    guard let m = Regex.firstMatch(slideRefRe, in: withoutCrop),
          let firstStr = Regex.group(m, at: 1, in: withoutCrop),
          let first = Int(firstStr),
          first >= 1 else {
        return nil
    }
    let last = Regex.group(m, at: 2, in: withoutCrop).flatMap(Int.init) ?? first
    if last < first || last - first >= maxPerFigure {
        return [first]
    }
    return Array(first...last)
}

private let fenceLineRe = Regex.compile(#"^ {0,3}(```|~~~)"#)
private let codeOrImageMarkerRe = Regex.compile(#"(`+)[\s\S]*?\1|(!\[[^\]]*\]\()([^)]*)\)"#)
private let trailingTitleRe = Regex.compile(#"\s+("[^"]*")\s*\z"#)

/// Sets (or with nil, clears) the crop of one slide in the summary's `figure`-th slide picture.
public func setFigureCrop(md: String, figure: Int, slide: Int, crop: Crop?) -> String? {
    var k = -1
    var inFence = false
    var found = false

    let lines = md.components(separatedBy: "\n").map { line -> String in
        if Regex.test(fenceLineRe, in: line) {
            inFence.toggle()
            return line
        }
        if inFence { return line }

        let matches = Regex.allMatches(codeOrImageMarkerRe, in: line)
        guard !matches.isEmpty else { return line }
        let ns = line as NSString
        var out = ""
        var lastEnd = 0
        for m in matches {
            out += ns.substring(with: NSRange(location: lastEnd, length: m.range.location - lastEnd))
            let whole = ns.substring(with: m.range)
            lastEnd = m.range.location + m.range.length

            if Regex.group(m, at: 1, in: line) != nil {
                out += whole
                continue
            }
            guard let open = Regex.group(m, at: 2, in: line),
                  let inner = Regex.group(m, at: 3, in: line) else {
                out += whole
                continue
            }
            let titleMatch = Regex.firstMatch(trailingTitleRe, in: inner)
            let titleStr = titleMatch.flatMap { Regex.group($0, at: 1, in: inner) }
            let rawRef: String
            if let titleMatch {
                rawRef = (inner as NSString).substring(to: titleMatch.range.location)
            } else {
                rawRef = inner
            }
            var ref = rawRef.trimmingCharacters(in: .whitespacesAndNewlines)
            if ref.hasPrefix("<") && ref.hasSuffix(">") && ref.count >= 2 && !ref.dropFirst().dropLast().contains("\n") {
                ref = String(ref.dropFirst().dropLast())
            }
            guard let numbers = slideNumbers(ref) else {
                out += whole
                continue
            }
            k += 1
            if k != figure || !numbers.contains(slide) {
                out += whole
                continue
            }
            found = true
            var crops = markerCropsOrdered(ref)
            if let crop {
                if let idx = crops.firstIndex(where: { $0.0 == slide }) {
                    crops[idx] = (slide, crop)
                } else {
                    crops.append((slide, crop))
                }
            } else {
                crops.removeAll { $0.0 == slide }
            }
            let plain = numbers.count == 1 ? "slide:\(numbers[0])" : "slide:\(numbers[0])-\(numbers[numbers.count - 1])"
            let part = crops.isEmpty ? "" : "#crop=" + crops.map { "\($0.0):\(formatCrop($0.1))" }.joined(separator: ";")
            let titleSuffix = titleStr.map { " \($0)" } ?? ""
            out += "\(open)\(plain)\(part)\(titleSuffix))"
        }
        out += ns.substring(from: lastEnd)
        return out
    }

    return found ? lines.joined(separator: "\n") : nil
}

// MARK: - Markdown -> HTML (renderMarkdown in lib/markdown.ts)

private let slideAnglePrepareRe = Regex.compile(
    #"(!\[[^\]]*\]\()\s*((?:slides?|pages?)\b[^)<>\n"]*?\s[^)<>\n"]*?)\s*("[^"\n]*")?\s*\)"#,
    options: [.caseInsensitive]
)
private let dangerousBlockRe = Regex.compile(
    #"<\s*(script|iframe|object|embed|style)\b[\s\S]*?<\s*\/\s*\1\s*>"#,
    options: [.caseInsensitive]
)
private let dangerousTagRe = Regex.compile(
    #"<\s*\/?\s*(meta|base|link|form)\b[^>]*>"#,
    options: [.caseInsensitive]
)
private let inlineEventHandlerRe = Regex.compile(
    #"\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)"#,
    options: [.caseInsensitive]
)
private let hrefOrSrcAttrRe = Regex.compile(
    #"(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))"#,
    options: [.caseInsensitive]
)
private let imgTagRe = Regex.compile(
    #"<img src="([^"]*)" alt="([^"]*)"(?: title="[^"]*")?\s*\/?>"#,
    options: [.caseInsensitive]
)
private let realPictureSrcRe = Regex.compile(
    #"^(?:https?:|data:image\/|\/)"#,
    options: [.caseInsensitive]
)
private let wrappedFigureRe = Regex.compile(
    #"<p>\s*(<figure[\s\S]*?<\/figure>)\s*<\/p>"#
)

private let ampEntityRe = Regex.compile(#"&amp;"#, options: [.caseInsensitive])
private let hexEntityRe = Regex.compile(#"&#x([0-9a-f]+);?"#, options: [.caseInsensitive])
private let decEntityRe = Regex.compile(#"&#0*(\d+);?"#)
private let colonEntityRe = Regex.compile(#"&colon;"#, options: [.caseInsensitive])
private let tabEntityRe = Regex.compile(#"&tab;"#, options: [.caseInsensitive])
private let newlineEntityRe = Regex.compile(#"&newline;"#, options: [.caseInsensitive])
private let controlOrSpaceRe = Regex.compile(#"[\u0000-\u0020]+"#)

private func decodeAttrUrl(_ raw: String) -> String {
    var s = raw
    for _ in 0..<3 {
        var next = Regex.replace(ampEntityRe, in: s, with: "&")
        next = replaceRegexWithCallback(hexEntityRe, in: next) { m, str in
            guard let hex = Regex.group(m, at: 1, in: str),
                  let code = UInt32(hex, radix: 16),
                  let scalar = UnicodeScalar(code) else { return "\u{0000}" }
            return String(scalar)
        }
        next = replaceRegexWithCallback(decEntityRe, in: next) { m, str in
            guard let dec = Regex.group(m, at: 1, in: str),
                  let code = UInt32(dec, radix: 10),
                  let scalar = UnicodeScalar(code) else { return "\u{0000}" }
            return String(scalar)
        }
        next = Regex.replace(colonEntityRe, in: next, with: ":")
        next = Regex.replace(tabEntityRe, in: next, with: "\t")
        next = Regex.replace(newlineEntityRe, in: next, with: "\n")
        if next == s { break }
        s = next
    }
    for _ in 0..<3 where s.contains("%") {
        guard let next = s.removingPercentEncoding, next != s else { break }
        s = next
    }
    return Regex.replace(controlOrSpaceRe, in: s, with: "").lowercased()
}

private func replaceRegexWithCallback(
    _ re: NSRegularExpression,
    in text: String,
    using transform: (NSTextCheckingResult, String) -> String
) -> String {
    let matches = Regex.allMatches(re, in: text)
    guard !matches.isEmpty else { return text }
    let ns = text as NSString
    var out = ""
    var cursor = 0
    for m in matches {
        if m.range.location >= cursor {
            out += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
            out += transform(m, text)
            cursor = m.range.location + m.range.length
        }
    }
    out += ns.substring(from: cursor)
    return out
}

private func escapeHtmlAttr(_ s: String) -> String {
    s.replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
}

private func escapeHtmlCode(_ s: String) -> String {
    s.replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
}

private let mdInlineCodeRe = Regex.compile(#"(`+)([\s\S]*?)\1"#)
private let mdImageRe = Regex.compile(#"!\[([^\]]*)\]\(\s*(?:<([^>\n]+)>|([^\s)"']+))(?:\s+"([^"]*)")?\s*\)"#)
private let mdLinkRe = Regex.compile(#"\[([^\]]+)\]\(\s*(?:<([^>\n]+)>|([^\s)"']+))(?:\s+"([^"]*)")?\s*\)"#)
private let mdBoldAsteriskRe = Regex.compile(#"\*\*([^\n*]+?)\*\*"#)
private let mdBoldUnderscoreRe = Regex.compile(#"\b__([^\n_]+?)__\b"#)
private let mdItalicAsteriskRe = Regex.compile(#"(?<!\*)\*([^\n*]+?)\*(?!\*)"#)
private let mdItalicUnderscoreRe = Regex.compile(#"(?<![A-Za-z0-9_])_([^\n_]+?)_(?![A-Za-z0-9_])"#)

private func parseMarkdownInline(_ raw: String) -> String {
    // Protect inline code spans with placeholders first.
    var codeSpans: [String] = []
    var s = replaceRegexWithCallback(mdInlineCodeRe, in: raw) { m, str in
        let code = Regex.group(m, at: 2, in: str) ?? ""
        let idx = codeSpans.count
        codeSpans.append("<code>\(escapeHtmlCode(code))</code>")
        return "\u{0001}CODE\(idx)\u{0001}"
    }

    // Images: ![alt](src "title")
    s = replaceRegexWithCallback(mdImageRe, in: s) { m, str in
        let alt = escapeHtmlAttr(Regex.group(m, at: 1, in: str) ?? "")
        let src = escapeHtmlAttr(Regex.group(m, at: 2, in: str) ?? Regex.group(m, at: 3, in: str) ?? "")
        if let title = Regex.group(m, at: 4, in: str) {
            return #"<img src="\#(src)" alt="\#(alt)" title="\#(escapeHtmlAttr(title))">"#
        }
        return #"<img src="\#(src)" alt="\#(alt)">"#
    }

    // Links: [text](href "title")
    s = replaceRegexWithCallback(mdLinkRe, in: s) { m, str in
        let text = Regex.group(m, at: 1, in: str) ?? ""
        let href = escapeHtmlAttr(Regex.group(m, at: 2, in: str) ?? Regex.group(m, at: 3, in: str) ?? "")
        if let title = Regex.group(m, at: 4, in: str) {
            return #"<a href="\#(href)" title="\#(escapeHtmlAttr(title))">\#(text)</a>"#
        }
        return #"<a href="\#(href)">\#(text)</a>"#
    }

    // Bold and Italic
    s = Regex.replace(mdBoldAsteriskRe, in: s, with: "<strong>$1</strong>")
    s = Regex.replace(mdBoldUnderscoreRe, in: s, with: "<strong>$1</strong>")
    s = Regex.replace(mdItalicAsteriskRe, in: s, with: "<em>$1</em>")
    s = Regex.replace(mdItalicUnderscoreRe, in: s, with: "<em>$1</em>")

    for (idx, html) in codeSpans.enumerated() {
        s = s.replacingOccurrences(of: "\u{0001}CODE\(idx)\u{0001}", with: html)
    }
    return s
}

private let mdHeadingBlockRe = Regex.compile(#"^ {0,3}(#{1,6})\s+(.*?)\s*#*$"#)
private let mdHrBlockRe = Regex.compile(#"^ {0,3}(?:-\s*-\s*-[- ]*|\*\s*\*\s*\*[* ]*|_\s*_\s*_[_ ]*)$"#)
private let mdListLineRe = Regex.compile(#"^( *)(?:([-*+])|(\d+)\.)\s+(.*)$"#)
private let mdBlockquoteLineRe = Regex.compile(#"^ {0,3}>\s?(.*)$"#)
private let mdFenceOpenRe = Regex.compile(#"^ {0,3}(```+|~~~+)\s*([^\s`~]*).*$"#)

private func markdownTableCells(_ line: String) -> [String] {
    var value = line.trimmingCharacters(in: .whitespaces)
    if value.hasPrefix("|") { value.removeFirst() }
    if value.hasSuffix("|") { value.removeLast() }
    return value.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
}

private func isTableDivider(_ line: String) -> Bool {
    let cells = markdownTableCells(line)
    return !cells.isEmpty && line.contains("|") && cells.allSatisfy { $0.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil }
}

private func parseMarkdownBlocks(_ md: String) -> String {
    let lines = md.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var out: [String] = []
    var i = 0

    while i < lines.count {
        let line = lines[i]

        if line.trimmingCharacters(in: .whitespaces).isEmpty {
            i += 1
            continue
        }

        // Fenced code block
        if let m = Regex.firstMatch(mdFenceOpenRe, in: line),
           let fence = Regex.group(m, at: 1, in: line) {
            let lang = Regex.group(m, at: 2, in: line) ?? ""
            let fenceChar = fence.first!
            let closeRe = Regex.compile("^ {0,3}\(String(repeating: "\\" + String(fenceChar), count: fence.count))+\\s*$")
            i += 1
            var codeLines: [String] = []
            while i < lines.count && !Regex.test(closeRe, in: lines[i]) {
                codeLines.append(lines[i])
                i += 1
            }
            if i < lines.count { i += 1 }
            let escaped = escapeHtmlCode(codeLines.joined(separator: "\n"))
            let classAttr = lang.isEmpty ? "" : #" class="language-\#(escapeHtmlAttr(lang))""#
            out.append("<pre><code\(classAttr)>\(escaped)\n</code></pre>")
            continue
        }

        // GitHub-style tables, used in lecture summaries and pasted marking guides.
        if i + 1 < lines.count, line.contains("|"), isTableDivider(lines[i + 1]) {
            let headings = markdownTableCells(line)
            let alignments = markdownTableCells(lines[i + 1]).map { cell -> String in
                if cell.hasPrefix(":") && cell.hasSuffix(":") { return "center" }
                return cell.hasSuffix(":") ? "right" : "left"
            }
            func row(_ cells: [String], tag: String) -> String {
                "<tr>" + headings.indices.map { index in
                    let alignment = index < alignments.count ? alignments[index] : "left"
                    let text = index < cells.count ? cells[index] : ""
                    return "<\(tag) style=\"text-align:\(alignment)\">\(parseMarkdownInline(text))</\(tag)>"
                }.joined() + "</tr>"
            }
            var table = "<table><thead>" + row(headings, tag: "th") + "</thead><tbody>"
            i += 2
            while i < lines.count && lines[i].contains("|") && !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                table += row(markdownTableCells(lines[i]), tag: "td")
                i += 1
            }
            out.append(table + "</tbody></table>")
            continue
        }

        // Heading
        if let m = Regex.firstMatch(mdHeadingBlockRe, in: line),
           let hashes = Regex.group(m, at: 1, in: line),
           let text = Regex.group(m, at: 2, in: line) {
            let level = hashes.count
            out.append("<h\(level)>\(parseMarkdownInline(text))</h\(level)>")
            i += 1
            continue
        }

        // Horizontal rule
        if Regex.test(mdHrBlockRe, in: line) {
            out.append("<hr>")
            i += 1
            continue
        }

        // Blockquote
        if Regex.test(mdBlockquoteLineRe, in: line) {
            var qLines: [String] = []
            while i < lines.count, let m = Regex.firstMatch(mdBlockquoteLineRe, in: lines[i]) {
                qLines.append(Regex.group(m, at: 1, in: lines[i]) ?? "")
                i += 1
            }
            out.append("<blockquote>\n\(parseMarkdownBlocks(qLines.joined(separator: "\n")))</blockquote>")
            continue
        }

        // List (unordered or ordered, supporting nested sub-items)
        if Regex.test(mdListLineRe, in: line) {
            var listLines: [String] = []
            while i < lines.count {
                let cur = lines[i]
                if Regex.test(mdListLineRe, in: cur) {
                    listLines.append(cur)
                    i += 1
                } else if cur.trimmingCharacters(in: .whitespaces).isEmpty {
                    if i + 1 < lines.count && Regex.test(mdListLineRe, in: lines[i + 1]) {
                        i += 1
                    } else {
                        break
                    }
                } else {
                    break
                }
            }
            out.append(renderListLines(listLines))
            continue
        }

        // Paragraph
        var pLines: [String] = []
        while i < lines.count {
            let cur = lines[i]
            if cur.trimmingCharacters(in: .whitespaces).isEmpty
                || Regex.test(mdFenceOpenRe, in: cur)
                || Regex.test(mdHeadingBlockRe, in: cur)
                || Regex.test(mdHrBlockRe, in: cur)
                || Regex.test(mdBlockquoteLineRe, in: cur)
                || Regex.test(mdListLineRe, in: cur) {
                break
            }
            pLines.append(cur)
            i += 1
        }
        if !pLines.isEmpty {
            out.append("<p>\(parseMarkdownInline(pLines.joined(separator: "\n")))</p>")
        }
    }

    return out.joined(separator: "\n") + (out.isEmpty ? "" : "\n")
}

private func renderListLines(_ lines: [String]) -> String {
    struct ListItem {
        var indent: Int
        var ordered: Bool
        var text: String
    }
    let items: [ListItem] = lines.compactMap { line in
        guard let m = Regex.firstMatch(mdListLineRe, in: line) else { return nil }
        let indent = (Regex.group(m, at: 1, in: line) ?? "").count
        let ordered = Regex.group(m, at: 3, in: line) != nil
        let text = Regex.group(m, at: 4, in: line) ?? ""
        return ListItem(indent: indent, ordered: ordered, text: text)
    }
    guard let first = items.first else { return "" }

    func build(from start: Int, baseIndent: Int, ordered: Bool) -> (String, Int) {
        let tag = ordered ? "ol" : "ul"
        var html = "<\(tag)>\n"
        var idx = start
        while idx < items.count {
            let item = items[idx]
            if item.indent < baseIndent { break }
            if item.indent > baseIndent {
                let (nested, nextIdx) = build(from: idx, baseIndent: item.indent, ordered: item.ordered)
                if html.hasSuffix("</li>\n") {
                    html.removeLast(6)
                    html += "\n\(nested)</li>\n"
                } else {
                    html += "<li>\(nested)</li>\n"
                }
                idx = nextIdx
                continue
            }
            html += "<li>\(parseMarkdownInline(item.text))</li>\n"
            idx += 1
        }
        html += "</\(tag)>"
        return (html, idx)
    }

    return build(from: 0, baseIndent: first.indent, ordered: first.ordered).0
}

private func slideFigure(
    numbers: [Int]?,
    caption: String,
    slides: SlideImages?,
    marker: (index: Int, crops: [Int: Crop])?
) -> String {
    let label: String
    if let numbers, !numbers.isEmpty {
        if numbers.count == 1 {
            label = " <span>· slide \(numbers[0])</span>"
        } else {
            label = " <span>· slides \(numbers[0])–\(numbers[numbers.count - 1])</span>"
        }
    } else {
        label = ""
    }

    let shown = (numbers ?? []).filter { n in
        slides?.ranges.contains { a, b in n >= a && n <= b } ?? false
    }
    guard let slides, !shown.isEmpty else {
        let cap = caption.isEmpty ? "Slide" : caption
        return #"<figure class="slide-fig missing"><figcaption>\#(cap)\#(label)</figcaption></figure>"#
    }

    let pictures = shown.map { n -> String in
        let crop = marker?.crops[n]
        let src = slidePictureUrl(base: slides.base, slide: n, crop: crop)
        if slides.print {
            return #"<img src="\#(src)" alt="\#(caption)">"#
        }
        let picture = #"<a href="\#(slides.base)/\#(n)" target="_blank" rel="noopener"><img src="\#(src)" alt="\#(caption)" loading="lazy"></a>"#
        guard slides.croppable, let marker else { return picture }
        let cropAttr = crop.map(formatCrop) ?? ""
        let button =
            #"<button type="button" class="slide-crop" data-fig="\#(marker.index)" data-slide="\#(n)" "#
            + #"data-crop="\#(cropAttr)" title="Crop this slide">Crop</button>"#
        return #"<span class="slide-shot">\#(picture)\#(button)</span>"#
    }.joined()

    let multi = shown.count > 1 ? " multi" : ""
    return #"<figure class="slide-fig\#(multi)">\#(pictures)<figcaption>\#(caption)\#(label)</figcaption></figure>"#
}

/// Port of `renderMarkdown(md, slides)` in `lib/markdown.ts`.
public func renderMarkdown(_ md: String, slides: SlideImages? = nil, preserveSlideSource: Bool = false) -> String {
    let prepared = replaceRegexWithCallback(slideAnglePrepareRe, in: md) { m, str in
        let open = Regex.group(m, at: 1, in: str) ?? ""
        let ref = Regex.group(m, at: 2, in: str) ?? ""
        let title = Regex.group(m, at: 3, in: str)
        return "\(open)<\(ref)>\(title.map { " \($0)" } ?? ""))"
    }

    var html = parseMarkdownBlocks(prepared)
    html = Regex.replace(dangerousBlockRe, in: html, with: "")
    html = Regex.replace(dangerousTagRe, in: html, with: "")
    html = Regex.replace(inlineEventHandlerRe, in: html, with: "")
    html = replaceRegexWithCallback(hrefOrSrcAttrRe, in: html) { m, str in
        let whole = (str as NSString).substring(with: m.range)
        let attr = Regex.group(m, at: 1, in: str) ?? "href"
        let rawVal = Regex.group(m, at: 2, in: str)
            ?? Regex.group(m, at: 3, in: str)
            ?? Regex.group(m, at: 4, in: str)
            ?? ""
        let clean = decodeAttrUrl(rawVal)
        let isDangerousScheme = clean.hasPrefix("javascript:") || clean.hasPrefix("vbscript:")
        let isNonImageData = clean.hasPrefix("data:") && !clean.hasPrefix("data:image/")
        if isDangerousScheme || isNonImageData {
            return "\(attr)=\"#\""
        }
        return whole
    }

    var figure = -1
    html = replaceRegexWithCallback(imgTagRe, in: html) { m, str in
        let tag = (str as NSString).substring(with: m.range)
        let src = Regex.group(m, at: 1, in: str) ?? ""
        let alt = Regex.group(m, at: 2, in: str) ?? ""
        if Regex.test(realPictureSrcRe, in: src) {
            return tag
        }
        let numbers = slideNumbers(src)
        if numbers != nil {
            figure += 1
        }
        let rendered = slideFigure(
            numbers: numbers,
            caption: alt,
            slides: slides,
            marker: numbers != nil ? (index: figure, crops: markerCrops(src)) : nil
        )
        guard preserveSlideSource else { return rendered }
        return rendered.replacingOccurrences(of: "<figure ", with: "<figure data-slide-source=\"\(src)\" data-slide-caption=\"\(alt)\" ")
    }

    html = Regex.replace(wrappedFigureRe, in: html, with: "$1")
    return html
}

/// Trackpad crop handles stay within the image and cannot invert the rectangle.
public func resizedSlideCrop(_ crop: Crop, corner: Int, dx: Double, dy: Double) -> Crop {
    guard dx.isFinite, dy.isFinite else { return crop }
    var left = crop.x, right = crop.x + crop.w, top = crop.y, bottom = crop.y + crop.h
    if corner % 2 == 0 { left = min(max(0, left + dx), right - 0.02) }
    else { right = max(min(1, right + dx), left + 0.02) }
    if corner < 2 { top = min(max(0, top + dy), bottom - 0.02) }
    else { bottom = max(min(1, bottom + dy), top + 0.02) }
    return Crop(x: left, y: top, w: right - left, h: bottom - top)
}
