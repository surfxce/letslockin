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

public func cleanCrop(x: Double?, y: Double?, w: Double?, h: Double?) -> Crop? {
    guard let x, let y, let w, let h else { return nil }
    let nums = [x, y, w, h]
    if nums.contains(where: { !$0.isFinite }) { return nil }
    func r(_ n: Double) -> Double {
        (min(1.0, max(0.0, n)) * 1000.0).rounded() / 1000.0
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
    guard let text else { return nil }
    let parts = text.components(separatedBy: ",")
    guard parts.count >= 4,
          let x = Double(parts[0]),
          let y = Double(parts[1]),
          let w = Double(parts[2]),
          let h = Double(parts[3]) else { return nil }
    return cleanCrop(x: x, y: y, w: w, h: h)
}

private let cropPartRe = Regex.compile(#"#crop=([^\s)]*)$"#, options: [.caseInsensitive])

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
        guard kv.count == 2, let n = Int(kv[0]), let crop = parseCrop(kv[1]) else { continue }
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
    #"^\s*"# + slideWordPat + #"(\d{1,3})(?:\s*(?:-|–|—|,|&|\+|to|and)\s*(?:"# + slideWordPat + #")?(\d{1,3}))?\s*$"#,
    options: [.caseInsensitive]
)

public func slideNumbers(_ src: String) -> [Int]? {
    let decoded = src.removingPercentEncoding ?? src
    let withoutCrop = Regex.replace(cropPartRe, in: decoded, with: "")
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
private let trailingTitleRe = Regex.compile(#"\s+("[^"]*")\s*$"#)
private let angleWrappedRe = Regex.compile(#"^<(.*)>$"#)

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
            let ref = Regex.replace(angleWrappedRe, in: rawRef.trimmingCharacters(in: .whitespacesAndNewlines), with: "$1")
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

// MARK: - Markdown renderer (matching lib/markdown.ts)

private let spacedSlideImageRe = Regex.compile(
    #"(!\[[^\]]*\]\()\s*((?:slides?|pages?)\b[^)<>\n"]*?\s[^)<>\n"]*?)\s*("[^"\n]*")?\s*\)"#,
    options: [.caseInsensitive]
)
private let dangerousBlockRe = Regex.compile(
    #"<\s*(script|iframe|object|embed|style)\b[\s\S]*?<\s*\/\s*\1\s*>"#,
    options: [.caseInsensitive]
)
private let dangerousVoidTagRe = Regex.compile(
    #"<\s*\/?\s*(meta|base|link|form)\b[^>]*>"#,
    options: [.caseInsensitive]
)
private let inlineEventHandlerRe = Regex.compile(
    #"\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)"#,
    options: [.caseInsensitive]
)
private let jsLinkAttrRe = Regex.compile(
    #"(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2"#,
    options: [.caseInsensitive]
)
private let imgTagRe = Regex.compile(
    #"<img src="([^"]*)" alt="([^"]*)"(?: title="[^"]*")?\s*\/?>"#
)
private let realPictureSrcRe = Regex.compile(#"^(?:https?:|data:image\/|\/)"#, options: [.caseInsensitive])
private let wrappedFigureParagraphRe = Regex.compile(#"<p>\s*(<figure[\s\S]*?<\/figure>)\s*<\/p>"#)
private let mdImageRe = Regex.compile(#"!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s"]+))(?:\s+"([^"]*)")?\s*\)"#)
private let mdLinkRe = Regex.compile(#"\[([^\]]+)\]\(\s*([^)\s"]+)\s*\)"#)

/// Renders Markdown with `slide:N` figures, crops, and XSS stripping (`lib/markdown.ts`).
public func renderMarkdown(_ md: String, slides: SlideImages? = nil) -> String {
    let prepared = replaceMatches(spacedSlideImageRe, in: md) { m, src in
        let open = Regex.group(m, at: 1, in: src) ?? ""
        let ref = Regex.group(m, at: 2, in: src) ?? ""
        let titlePart = Regex.group(m, at: 3, in: src).map { " \($0)" } ?? ""
        return "\(open)<\(ref)>\(titlePart))"
    }

    var html = basicMarkdownToHtml(prepared)
    var figure = -1

    html = Regex.replace(dangerousBlockRe, in: html, with: "")
    html = Regex.replace(dangerousVoidTagRe, in: html, with: "")
    html = Regex.replace(inlineEventHandlerRe, in: html, with: "")
    html = Regex.replace(jsLinkAttrRe, in: html, with: "$1=\"#\"")
    html = replaceMatches(imgTagRe, in: html) { m, text in
        let whole = (text as NSString).substring(with: m.range)
        let src = Regex.group(m, at: 1, in: text) ?? ""
        let alt = Regex.group(m, at: 2, in: text) ?? ""
        if Regex.test(realPictureSrcRe, in: src) {
            return whole
        }
        let numbers = slideNumbers(src)
        if numbers != nil { figure += 1 }
        return slideFigure(
            numbers: numbers,
            caption: alt,
            slides: slides,
            marker: numbers != nil ? (index: figure, crops: markerCrops(src)) : nil
        )
    }
    html = Regex.replace(wrappedFigureParagraphRe, in: html, with: "$1")
    return html
}

private func slideFigure(
    numbers: [Int]?,
    caption: String,
    slides: SlideImages?,
    marker: (index: Int, crops: [Int: Crop])?
) -> String {
    let label: String
    if let numbers, !numbers.isEmpty {
        label = numbers.count == 1
            ? " <span>· slide \(numbers[0])</span>"
            : " <span>· slides \(numbers[0])–\(numbers[numbers.count - 1])</span>"
    } else {
        label = ""
    }
    let shown = (numbers ?? []).filter { n in
        slides?.ranges.contains(where: { n >= $0.0 && n <= $0.1 }) == true
    }
    let fallbackCaption = caption.isEmpty ? "Slide" : caption
    guard let slides, !shown.isEmpty else {
        return #"<figure class="slide-fig missing"><figcaption>\#(fallbackCaption)\#(label)</figcaption></figure>"#
    }
    let pictures = shown.map { n -> String in
        let crop = marker?.crops[n]
        let src = slidePictureUrl(base: slides.base, slide: n, crop: crop)
        if slides.print {
            return #"<img src="\#(src)" alt="\#(caption)">"#
        }
        let picture = #"<a href="\#(slides.base)/\#(n)" target="_blank" rel="noopener"><img src="\#(src)" alt="\#(caption)" loading="lazy"></a>"#
        guard slides.croppable, let marker else { return picture }
        let cropData = crop.map(formatCrop) ?? ""
        let button =
            #"<button type="button" class="slide-crop" data-fig="\#(marker.index)" data-slide="\#(n)" "# +
            #"data-crop="\#(cropData)" title="Crop this slide">Crop</button>"#
        return #"<span class="slide-shot">\#(picture)\#(button)</span>"#
    }.joined()
    let multi = shown.count > 1 ? " multi" : ""
    return #"<figure class="slide-fig\#(multi)">\#(pictures)<figcaption>\#(caption)\#(label)</figcaption></figure>"#
}

private func replaceMatches(
    _ re: NSRegularExpression,
    in text: String,
    transform: (NSTextCheckingResult, String) -> String
) -> String {
    let matches = Regex.allMatches(re, in: text)
    guard !matches.isEmpty else { return text }
    let ns = text as NSString
    var out = ""
    var lastEnd = 0
    for m in matches {
        out += ns.substring(with: NSRange(location: lastEnd, length: m.range.location - lastEnd))
        out += transform(m, text)
        lastEnd = m.range.location + m.range.length
    }
    out += ns.substring(from: lastEnd)
    return out
}

private func basicMarkdownToHtml(_ md: String) -> String {
    let blocks = md.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n\n")
    return blocks.map { block -> String in
        let trimmed = block.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        if let h = Regex.firstMatch(Regex.compile(#"^(#{1,6})\s+(.*)$"#), in: trimmed),
           let hashes = Regex.group(h, at: 1, in: trimmed),
           let body = Regex.group(h, at: 2, in: trimmed) {
            let level = hashes.count
            return "<h\(level)>\(inlineMarkdown(body))</h\(level)>"
        }
        return "<p>\(inlineMarkdown(trimmed))</p>"
    }.filter { !$0.isEmpty }.joined(separator: "\n")
}

private func inlineMarkdown(_ text: String) -> String {
    var out = replaceMatches(mdImageRe, in: text) { m, s in
        let alt = Regex.group(m, at: 1, in: s) ?? ""
        let src = Regex.group(m, at: 2, in: s) ?? Regex.group(m, at: 3, in: s) ?? ""
        let title = Regex.group(m, at: 4, in: s)
        let titleAttr = title != nil ? #" title="\#(title!)""# : ""
        return #"<img src="\#(src)" alt="\#(alt)"\#(titleAttr)>"#
    }
    out = replaceMatches(mdLinkRe, in: out) { m, s in
        let label = Regex.group(m, at: 1, in: s) ?? ""
        let href = Regex.group(m, at: 2, in: s) ?? ""
        return #"<a href="\#(href)">\#(label)</a>"#
    }
    return out
}
