import Foundation

public struct ParsedSummary: Equatable, Sendable {
    public var title: String?
    public var markdown: String

    public init(title: String?, markdown: String) {
        self.title = title
        self.markdown = markdown
    }
}

public struct ParsedCriterion: Equatable, Sendable {
    public var point: String
    public var marks: Double?

    public init(point: String, marks: Double?) {
        self.point = point
        self.marks = marks
    }
}

public struct ParsedLaq: Equatable, Sendable {
    public var number: Int
    public var stem: String
    public var marks: Double?
    public var criteria: [ParsedCriterion]
    public var modelAnswer: String?

    public init(number: Int, stem: String, marks: Double?, criteria: [ParsedCriterion], modelAnswer: String?) {
        self.number = number
        self.stem = stem
        self.marks = marks
        self.criteria = criteria
        self.modelAnswer = modelAnswer
    }
}

public enum FeedbackKind: String, Equatable, Sendable {
    case missed
    case wrong
    case good
    case note
}

public struct ParsedFeedback: Equatable, Sendable {
    public var kind: FeedbackKind
    public var text: String

    public init(kind: FeedbackKind, text: String) {
        self.kind = kind
        self.text = text
    }
}

public struct ParsedScore: Equatable, Sendable {
    public var number: Int
    public var mark: Double
    public var raw: String
    public var feedback: [ParsedFeedback]

    public init(number: Int, mark: Double, raw: String, feedback: [ParsedFeedback]) {
        self.number = number
        self.mark = mark
        self.raw = raw
        self.feedback = feedback
    }
}

private let preambleRe = Regex.compile(
    #"^(?:sure|certainly|of course|absolutely|great|okay|ok|here(?:'s| is| are)|below (?:is|are))\b"#,
    options: [.caseInsensitive]
)
private let signOffRe = Regex.compile(
    #"^(?:let me know|would you like|do you want|i can also|if you(?:'d| would) like|happy to|hope this helps|feel free|want me to|good luck)\b"#,
    options: [.caseInsensitive]
)
private let trailingSpacesRe = Regex.compile(#"[ \t]+$"#, options: [.anchorsMatchLines])
private let paragraphSplitRe = Regex.compile(#"\n{2,}"#)
private let leadingStarsOrUnderscoresRe = Regex.compile(#"^[*_]+"#)
private let trailingRuleRe = Regex.compile(#"\n-{3,}\s*$"#)
private let boldMarkersRe = Regex.compile(#"\*\*|__"#)
private let h1FirstLineRe = Regex.compile(#"^#\s+(.+)\n?"#)
private let summaryPrefixRe = Regex.compile(#"^(?:summary|lecture summary)\s*[:\-–—]\s*"#, options: [.caseInsensitive])
private let lectureNumPrefixRe = Regex.compile(#"^lecture\s+\d+\s*[:\-–—]\s*"#, options: [.caseInsensitive])

private func normalise(_ raw: String) -> String {
    var s = raw.replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
        .replacingOccurrences(of: "\u{00A0}", with: " ")
    s = Regex.replace(trailingSpacesRe, in: s, with: "")
    return s.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func stripChat(_ text: String) -> String {
    let matches = Regex.allMatches(paragraphSplitRe, in: text)
    var paragraphs: [String] = []
    let ns = text as NSString
    var lastEnd = 0
    for m in matches {
        paragraphs.append(ns.substring(with: NSRange(location: lastEnd, length: m.range.location - lastEnd)))
        lastEnd = m.range.location + m.range.length
    }
    paragraphs.append(ns.substring(from: lastEnd))

    if paragraphs.count > 1 && Regex.test(preambleRe, in: paragraphs[0]) && paragraphs[0].utf16Count < 240 {
        paragraphs.removeFirst()
    }
    while paragraphs.count > 1 {
        let last = Regex.replaceFirst(leadingStarsOrUnderscoresRe, in: paragraphs[paragraphs.count - 1], with: "")
        if Regex.test(signOffRe, in: last) {
            paragraphs.removeLast()
        } else {
            break
        }
    }
    let joined = paragraphs.joined(separator: "\n\n")
    return Regex.replaceFirst(trailingRuleRe, in: joined, with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func unbold(_ s: String) -> String {
    Regex.replace(boldMarkersRe, in: s, with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

// MARK: - Summary

public func parseSummary(_ raw: String) -> ParsedSummary {
    var text = stripChat(normalise(raw))
    var title: String? = nil

    if let first = Regex.firstMatch(h1FirstLineRe, in: text),
       let group1 = Regex.group(first, at: 1, in: text),
       let fullMatch = Regex.group(first, at: 0, in: text) {
        var t = unbold(group1)
        t = Regex.replaceFirst(summaryPrefixRe, in: t, with: "")
        t = Regex.replaceFirst(lectureNumPrefixRe, in: t, with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        title = t.isEmpty ? nil : t
        text = text.utf16DropFirst(fullMatch.utf16Count).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return ParsedSummary(title: title, markdown: text)
}

// MARK: - LAQs

private let questionHeaderRe = Regex.compile(
    #"^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:LAQ|Q|Question|Long[- ]answer question)\s*#?\s*(\d{1,2})\b\s*(?:\*\*|__)?\s*[:.)\-–—]?\s*(?:\*\*|__)?\s*(.*)$"#,
    options: [.caseInsensitive]
)
private let numberedLineRe = Regex.compile(#"^(?:\*\*)?(\d{1,2})[.)]\s+(.*)$"#)

private let sectionLabelPat = #"(marking (?:guide|criteria|scheme|points|rubric)|rubric|mark(?:ing)? allocation|key points|model answer|sample answer|suggested answer|ideal answer|example answer|answer)"#
private let sectionFormattedRe = Regex.compile(
    #"^\s*(?:#{1,6}\s*|\*\*|__)(?:\*\*|__)?\s*"# + sectionLabelPat + #"\s*(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*(.*)$"#,
    options: [.caseInsensitive]
)
private let sectionPlainRe = Regex.compile(
    #"^\s*"# + sectionLabelPat + #"\s*(?::\s*(.*))?$"#,
    options: [.caseInsensitive]
)

private func sectionOf(_ line: String) -> (label: String, rest: String)? {
    if let m = Regex.firstMatch(sectionFormattedRe, in: line),
       let label = Regex.group(m, at: 1, in: line) {
        return (label, Regex.group(m, at: 2, in: line) ?? "")
    }
    if let m = Regex.firstMatch(sectionPlainRe, in: line),
       let label = Regex.group(m, at: 1, in: line) {
        return (label, Regex.group(m, at: 2, in: line) ?? "")
    }
    return nil
}

private let marksInTextRe = Regex.compile(
    #"\s*[(\[]\s*(\d+(?:\.\d+)?)\s*(?:marks?|pts?|points?)?\s*[)\]]\s*$|\s*[-–—:]\s*(\d+(?:\.\d+)?)\s*(?:marks?|pts?|points?)\s*$"#,
    options: [.caseInsensitive]
)
private let marksPrefixRe = Regex.compile(
    #"^\s*[(\[]?\s*(\d+(?:\.\d+)?)\s*(?:marks?|pts?|points?)\s*[)\]]?\s*[:\-–—]\s*"#,
    options: [.caseInsensitive]
)
private let bulletRe = Regex.compile(#"^\s*(?:[-*•▪●○]|\d{1,2}[.)]|[a-h][.)])\s+"#, options: [.caseInsensitive])
private let standaloneRuleLineRe = Regex.compile(#"^\s*-{3,}\s*$"#, options: [.anchorsMatchLines])

private func splitMarks(_ text: String) -> (text: String, marks: Double?) {
    if let suffix = Regex.firstMatch(marksInTextRe, in: text) {
        let ns = text as NSString
        let prefixText = ns.substring(to: suffix.range.location).trimmingCharacters(in: .whitespacesAndNewlines)
        let mStr = Regex.group(suffix, at: 1, in: text) ?? Regex.group(suffix, at: 2, in: text)
        return (prefixText, mStr.flatMap(Double.init))
    }
    if let prefix = Regex.firstMatch(marksPrefixRe, in: text),
       let full = Regex.group(prefix, at: 0, in: text),
       let mStr = Regex.group(prefix, at: 1, in: text) {
        let rest = text.utf16DropFirst(full.utf16Count).trimmingCharacters(in: .whitespacesAndNewlines)
        return (rest, Double(mStr))
    }
    return (text.trimmingCharacters(in: .whitespacesAndNewlines), nil)
}

public func parseLaqs(_ raw: String) -> [ParsedLaq] {
    let lines = stripChat(normalise(raw)).components(separatedBy: "\n")

    struct Start {
        var i: Int
        var number: Int
        var head: String
    }

    var starts: [Start] = lines.enumerated().compactMap { i, line in
        guard let m = Regex.firstMatch(questionHeaderRe, in: line),
              let nStr = Regex.group(m, at: 1, in: line),
              let n = Int(nStr) else { return nil }
        return Start(i: i, number: n, head: Regex.group(m, at: 2, in: line) ?? "")
    }
    if starts.isEmpty {
        starts = lines.enumerated().compactMap { i, line in
            guard let m = Regex.firstMatch(numberedLineRe, in: line),
                  let nStr = Regex.group(m, at: 1, in: line),
                  let n = Int(nStr) else { return nil }
            return Start(i: i, number: n, head: Regex.group(m, at: 2, in: line) ?? "")
        }
    }

    struct Block {
        var number: Int
        var head: String
        var body: [String]
    }

    let blocks: [Block]
    if !starts.isEmpty {
        blocks = starts.enumerated().map { idx, s in
            let nextIdx = idx + 1 < starts.count ? starts[idx + 1].i : lines.count
            let slice = (s.i + 1) < nextIdx ? Array(lines[(s.i + 1)..<nextIdx]) : []
            return Block(number: s.number, head: s.head, body: slice)
        }
    } else {
        blocks = [Block(number: 1, head: "", body: lines)]
    }

    var out: [ParsedLaq] = []
    for block in blocks {
        let head = splitMarks(unbold(block.head))
        var stem: [String] = []
        var criteria: [ParsedCriterion] = []
        var answer: [String] = []
        enum Section { case stem, criteria, answer }
        var section: Section = .stem

        for line in block.body {
            if let heading = sectionOf(line) {
                section = heading.label.range(of: "answer", options: .caseInsensitive) != nil ? .answer : .criteria
                let inline = unbold(heading.rest)
                if !inline.isEmpty && section == .answer {
                    answer.append(inline)
                } else if !inline.isEmpty {
                    let point = splitMarks(inline)
                    criteria.append(ParsedCriterion(point: point.text, marks: point.marks))
                }
                continue
            }
            switch section {
            case .stem:
                stem.append(line)
            case .answer:
                answer.append(line)
            case .criteria:
                if !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let withoutBullet = Regex.replaceFirst(bulletRe, in: line, with: "")
                    let point = splitMarks(unbold(withoutBullet))
                    if !point.text.isEmpty {
                        criteria.append(ParsedCriterion(point: point.text, marks: point.marks))
                    }
                }
            }
        }

        let cleanedStem = Regex.replace(standaloneRuleLineRe, in: stem.joined(separator: "\n"), with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let body = splitMarks(cleanedStem)
        let isTopic = !head.text.isEmpty && !body.text.isEmpty && head.text.utf16Count < 100
            && !head.text.hasSuffix("?") && !head.text.hasSuffix(".")
        let text: String
        if isTopic {
            text = "**\(head.text)**\n\n\(body.text)"
        } else {
            text = [head.text, body.text].filter { !$0.isEmpty }.joined(separator: "\n")
        }
        if text.isEmpty { continue }

        let cleanedAnswer = Regex.replace(standaloneRuleLineRe, in: answer.joined(separator: "\n"), with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        out.append(
            ParsedLaq(
                number: block.number,
                stem: text,
                marks: body.marks ?? head.marks,
                criteria: criteria,
                modelAnswer: cleanedAnswer.isEmpty ? nil : cleanedAnswer
            )
        )
    }

    let numbers = out.map(\.number)
    if Set(numbers).count != numbers.count {
        for i in out.indices {
            out[i].number = i + 1
        }
    }
    return out
}

// MARK: - Scores

private let scoreRe = Regex.compile(#"(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)"#, options: [.caseInsensitive])
private let numberedScoreRe = Regex.compile(
    #"^\s*(?:\*\*)?(\d{1,2})\s*[:.)\-–—]\s*(?:\*\*)?\s*(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)"#,
    options: [.caseInsensitive]
)
private let totalRe = Regex.compile(
    #"^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:total|overall|geometric|average|mean|final score)\b"#,
    options: [.caseInsensitive]
)
private let scoreLineCueRe = Regex.compile(#"score|mark|grade|result|awarded|\d\s*\/"#, options: [.caseInsensitive])
private let leadingHashesRe = Regex.compile(#"^\s*(?:#{1,6}\s*)?"#)
private let labelSuffixSeparatorRe = Regex.compile(#"^\s*(?:\(s\))?\s*[:\-–—]\s*"#)

private let kindLabels: [(FeedbackKind, NSRegularExpression)] = [
    (.missed, Regex.compile(#"^(?:missed|missing|omitted|not covered|left out|what you missed|gaps?)\b"#, options: [.caseInsensitive])),
    (.wrong, Regex.compile(#"^(?:wrong|incorrect|errors?|inaccura\w*|mistakes?|misconceptions?)\b"#, options: [.caseInsensitive])),
    (.good, Regex.compile(#"^(?:good|strengths?|strong|correct|well done|what you did well|covered|you got)\b"#, options: [.caseInsensitive])),
]

private func kindOf(_ text: String) -> (kind: FeedbackKind?, rest: String) {
    let plain = unbold(text)
    for (kind, re) in kindLabels {
        if let m = Regex.firstMatch(re, in: plain),
           let matched = Regex.group(m, at: 0, in: plain) {
            let tail = plain.utf16DropFirst(matched.utf16Count)
            let rest = Regex.replaceFirst(labelSuffixSeparatorRe, in: tail, with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return (kind, rest)
        }
    }
    return (nil, plain)
}

public func parseScores(_ raw: String) -> [ParsedScore] {
    let lines = stripChat(normalise(raw)).components(separatedBy: "\n")
    var out: [ParsedScore] = []
    var currentNumber: Int? = nil
    var currentScoreIndex: Int? = nil
    var kind: FeedbackKind = .note

    func setScore(number: Int, got: Double, of: Double, raw: String) -> Int? {
        guard of > 0 else { return nil }
        let mark = max(0, min(10, floor((got / of) * 10 * 100 + 0.5) / 100))
        out.append(ParsedScore(number: number, mark: mark, raw: raw, feedback: []))
        return out.count - 1
    }

    for line in lines {
        if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || Regex.test(totalRe, in: line) {
            continue
        }

        let header = Regex.firstMatch(questionHeaderRe, in: line)
        let numbered = header == nil ? Regex.firstMatch(numberedScoreRe, in: line) : nil
        if let match = header ?? numbered,
           let numStr = Regex.group(match, at: 1, in: line),
           let number = Int(numStr) {
            currentNumber = number
            currentScoreIndex = nil
            kind = .note
            if let numbered,
               let gStr = Regex.group(numbered, at: 2, in: line),
               let oStr = Regex.group(numbered, at: 3, in: line),
               let got = Double(gStr),
               let of = Double(oStr) {
                currentScoreIndex = setScore(number: number, got: got, of: of, raw: "\(gStr)/\(oStr)")
            } else if let s = Regex.firstMatch(scoreRe, in: line),
                      let gStr = Regex.group(s, at: 1, in: line),
                      let oStr = Regex.group(s, at: 2, in: line),
                      let got = Double(gStr),
                      let of = Double(oStr) {
                currentScoreIndex = setScore(number: number, got: got, of: of, raw: "\(gStr)/\(oStr)")
            }
            continue
        }
        guard let number = currentNumber else { continue }

        if currentScoreIndex == nil {
            if let s = Regex.firstMatch(scoreRe, in: line),
               Regex.test(scoreLineCueRe, in: line),
               let gStr = Regex.group(s, at: 1, in: line),
               let oStr = Regex.group(s, at: 2, in: line),
               let got = Double(gStr),
               let of = Double(oStr) {
                currentScoreIndex = setScore(number: number, got: got, of: of, raw: "\(gStr)/\(oStr)")
                continue
            }
        }
        guard let scoreIdx = currentScoreIndex else { continue }

        let bare = Regex.replaceFirst(leadingHashesRe, in: line, with: "")
        let isBullet = Regex.test(bulletRe, in: bare)
        let withoutBullet = Regex.replaceFirst(bulletRe, in: bare, with: "")
        let label = kindOf(withoutBullet)
        if !isBullet, let k = label.kind, label.rest.isEmpty {
            kind = k
            continue
        }
        let text = (label.kind != nil ? label.rest : unbold(withoutBullet))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            out[scoreIdx].feedback.append(ParsedFeedback(kind: label.kind ?? kind, text: text))
        }
    }

    return out
}
