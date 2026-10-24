import Foundation

/// Marking an answer on the phone, with the computer's API key, the way the computer
/// would: the same prompt file and version (lib/llm/prompts.ts fill), the same request
/// to the same model (lib/phone/marking.ts), the reply read as lib/llm/base.ts reads it.
public enum MarkingError: LocalizedError, Equatable {
    case badTemplate
    case service(String)
    case unreadable(String)

    public var errorDescription: String? {
        switch self {
        case .badTemplate: return "The computer's marking settings couldn't be used. Sync again."
        case .service(let message): return message
        case .unreadable(let message): return "The marker's reply couldn't be used: \(message)"
        }
    }
}

public let promptSlot = "{{LOCKIN_PROMPT}}"

/// `{{name}}` replaced by its variable, or by nothing, in one pass.
public func fillPrompt(_ template: String, _ vars: [String: String]) -> String {
    guard let regex = try? NSRegularExpression(pattern: "\\{\\{(\\w+)\\}\\}") else { return template }
    let source = template as NSString
    var result = ""
    var last = 0
    for match in regex.matches(in: template, range: NSRange(location: 0, length: source.length)) {
        result += source.substring(with: NSRange(location: last, length: match.range.location - last))
        result += vars[source.substring(with: match.range(at: 1))] ?? ""
        last = match.range.location + match.range.length
    }
    result += source.substring(from: last)
    return result
}

/// The marking prompt for one answer.
public func markingPrompt(_ template: MarkingTemplate, question: Question, answer: String) -> String {
    fillPrompt(template.prompt, [
        "questionStem": question.markVars.questionStem,
        "rubric": question.markVars.rubric,
        "answerText": answer,
        "concepts": question.markVars.concepts,
    ])
}

public func markingRequest(_ template: MarkingTemplate, prompt: String) throws -> URLRequest {
    guard let url = URL(string: template.request.url), let scheme = url.scheme?.lowercased(),
          scheme == "https" || scheme == "http"
    else { throw MarkingError.badTemplate }
    var request = URLRequest(url: url, timeoutInterval: 300)
    request.httpMethod = "POST"
    for (name, value) in template.request.headers { request.setValue(value, forHTTPHeaderField: name) }
    request.httpBody = try JSONEncoder().encode(template.request.body.replacingString(promptSlot, with: prompt))
    return request
}

/// The text of a reply, or what went wrong, as lib/llm/api.ts reports it.
public func replyText(kind: String, label: String, status: Int, data: Data) throws -> String {
    let json = try? JSONDecoder().decode(JSONValue.self, from: data)
    let service = label.components(separatedBy: " · ").first ?? label
    guard (200..<300).contains(status), let json else {
        let error = json?["error"]
        let why = error?.stringValue ?? error?["message"]?.stringValue ?? HTTPURLResponse.localizedString(forStatusCode: status)
        let hint = status == 401 || status == 403 ? " — check the API key in Lockin's Settings on the computer" : ""
        if status == 429 { throw MarkingError.service("\(service) is rate limiting this key — try again shortly") }
        throw MarkingError.service("\(service) said \(status): \(why)\(hint)")
    }
    if kind == "anthropic" {
        let stop = json["stop_reason"]?.stringValue
        if stop == "refusal" { throw MarkingError.service("Claude declined to mark this answer") }
        if stop == "max_tokens" { throw MarkingError.service("Claude's reply was cut off before it finished") }
        let text = (json["content"]?.arrayValue ?? [])
            .filter { $0["type"]?.stringValue == "text" }
            .compactMap { $0["text"]?.stringValue }
            .joined()
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw MarkingError.service("Claude sent back an empty reply") }
        return text
    }
    let choice = json["choices"]?.arrayValue?.first
    if choice?["finish_reason"]?.stringValue == "length" { throw MarkingError.service("\(service)'s reply was cut off before it finished") }
    let content = choice?["message"]?["content"]
    let text = content?.stringValue
        ?? (content?.arrayValue ?? []).compactMap { $0["text"]?.stringValue }.joined()
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw MarkingError.service("\(service) sent back an empty reply") }
    return text
}

/// The JSON in a reply that may be fenced or wrapped in prose (lib/llm/base.ts, extractJson).
public func extractJSON(_ text: String) throws -> Data {
    var candidate = text
    if let regex = try? NSRegularExpression(pattern: "```(?:json)?\\s*\\n([\\s\\S]*?)\\n?```"),
       let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
       let range = Range(match.range(at: 1), in: text) {
        candidate = String(text[range])
    }
    let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
    if let data = trimmed.data(using: .utf8), (try? JSONSerialization.jsonObject(with: data)) != nil {
        return data
    }
    guard let start = candidate.firstIndex(where: { $0 == "{" || $0 == "[" }) else {
        throw MarkingError.unreadable("no JSON found in reply: \(text.prefix(300))")
    }
    let closer: Character = candidate[start] == "{" ? "}" : "]"
    guard let end = candidate.lastIndex(of: closer), end > start else {
        throw MarkingError.unreadable("unbalanced JSON in reply: \(text.prefix(300))")
    }
    return Data(candidate[start...end].utf8)
}

/// A marking that satisfies MarkingSchema, or why not.
public func decodeMarking(_ text: String) throws -> Marking {
    let data = try extractJSON(text)
    let marking: Marking
    do {
        marking = try JSONDecoder().decode(Marking.self, from: data)
    } catch {
        throw MarkingError.unreadable("it didn't have the mark, criteria and gaps")
    }
    guard (0...10).contains(marking.mark) else { throw MarkingError.unreadable("the mark \(marking.mark) isn't between 0 and 10") }
    guard marking.criteria.allSatisfy({ $0.awarded >= 0 && $0.outOf >= 0 }) else {
        throw MarkingError.unreadable("a criterion has negative marks")
    }
    guard marking.gaps.allSatisfy({ ($0.type == "MISSED" || $0.type == "WRONG") && !$0.text.isEmpty }) else {
        throw MarkingError.unreadable("a gap isn't MISSED or WRONG with some text")
    }
    return marking
}

/// Sends requests; replaceable in tests.
public protocol HTTPSending: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, Int)
}

public struct URLSessionSender: HTTPSending {
    public let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, Int) {
        let (data, response) = try await session.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

/// Marks one answer. A reply that can't be read is asked for again once, as the computer does.
public func markAnswer(_ answer: String, question: Question, template: MarkingTemplate,
                       sender: HTTPSending = URLSessionSender()) async throws -> Marking {
    let prompt = markingPrompt(template, question: question, answer: answer)
    func attempt(_ extra: String) async throws -> Marking {
        let request = try markingRequest(template, prompt: prompt + extra)
        let (data, status): (Data, Int)
        do {
            (data, status) = try await sender.send(request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            let service = template.label.components(separatedBy: " · ").first ?? template.label
            throw MarkingError.service("Couldn't reach \(service): \(error.localizedDescription)")
        }
        return try decodeMarking(try replyText(kind: template.kind, label: template.label, status: status, data: data))
    }
    do {
        return try await attempt("")
    } catch MarkingError.unreadable(let why) {
        return try await attempt("\n\nYour previous reply could not be used: \(why)\n"
            + "Reply again with valid JSON matching the schema exactly. No prose, no code fences.")
    }
}

/// What a marking says, as the computer lists it (lib/feedback.ts, feedbackFor).
public func feedback(for marking: Marking) -> [FeedbackItem] {
    var items: [FeedbackItem] = []
    for c in marking.criteria where c.outOf > 0 && c.awarded >= c.outOf {
        items.append(FeedbackItem(kind: "good", text: c.point))
    }
    for g in marking.gaps where g.type == "WRONG" { items.append(FeedbackItem(kind: "wrong", text: g.text)) }
    for g in marking.gaps where g.type == "MISSED" { items.append(FeedbackItem(kind: "missed", text: g.text)) }
    for c in marking.criteria where c.awarded > 0 && c.awarded < c.outOf {
        if let note = c.note, !note.isEmpty {
            items.append(FeedbackItem(kind: "note", text: "\(c.point) (\(formatMark(c.awarded))/\(formatMark(c.outOf))): \(note)"))
        }
    }
    return items
}

/// A sitting's score: the geometric mean of its marks (lib/engines/geomean.ts). One zero zeroes it.
public func geometricMean(_ marks: [Double]) -> Double? {
    guard !marks.isEmpty, marks.allSatisfy({ $0.isFinite && $0 >= 0 }) else { return nil }
    if marks.contains(0) { return 0 }
    return pow(marks.reduce(1, *), 1 / Double(marks.count))
}

/// 7, 6.5 — as JavaScript prints a number, for marks.
public func formatMark(_ value: Double) -> String {
    value.rounded() == value ? String(Int(value)) : String(format: "%g", value)
}
