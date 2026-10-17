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
