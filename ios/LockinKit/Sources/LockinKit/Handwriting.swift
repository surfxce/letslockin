import Foundation

/// A handwritten answer as the AI typed it out (lib/handwriting/schema.ts): the text,
/// and the words it wasn't sure of, for the student to check.
public struct HandwritingRead: Codable, Equatable, Sendable {
    public var text: String
    public var unclear: [String]
    /// Who read it, for the note under the answer.
    public var model: String?

    public init(text: String, unclear: [String], model: String? = nil) {
        self.text = text
        self.unclear = unclear
        self.model = model
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        unclear = try c.decodeIfPresent([String].self, forKey: .unclear) ?? []
        model = try c.decodeIfPresent(String.self, forKey: .model)
    }
}

/// Photos of one answer at most, as the computer allows.
public let maxHandwritingPages = 8

/// Where the typed-out answer goes: the box, or after what's already in it.
public func withHandwriting(_ current: String, _ read: String) -> String {
    let kept = current.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
    return kept.isEmpty ? read : "\(kept)\n\n\(read)"
}

/// The reading prompt for one answer, filled as lib/handwriting/schema.ts fills it.
public func handwritingPrompt(_ template: MarkingTemplate, question: String, pages: Int) -> String {
    let note = pages == 1 ? "The photo is attached." : "The \(pages) photos are attached, in page order."
    return fillPrompt(template.prompt, ["question": String(question.prefix(4000)), "pages": String(pages)])
        + "\n\n---\n\n\(note) Read every one before replying."
}

/// The template's request with the photos in its one message: before the prompt as
/// "image" blocks for Anthropic, after it as "image_url" parts for the others.
public func handwritingBody(_ template: MarkingTemplate, prompt: String, photos: [Data]) -> JSONValue {
    let body = template.request.body.replacingString(promptSlot, with: prompt)
    guard case .object(var top) = body, case .array(var messages)? = top["messages"], case .object(var first)? = messages.first else {
        return body
    }
    var parts: [JSONValue]
    switch first["content"] {
    case .array(let existing)?: parts = existing
    case .string(let text)?: parts = [.object(["type": .string("text"), "text": .string(text)])]
    default: parts = []
    }
    let encoded = photos.map { $0.base64EncodedString() }
    if template.kind == "anthropic" {
        let images: [JSONValue] = encoded.map {
            .object(["type": .string("image"),
                     "source": .object(["type": .string("base64"), "media_type": .string("image/jpeg"), "data": .string($0)])])
        }
        parts = images + parts
    } else {
        parts += encoded.map { .object(["type": .string("image_url"), "image_url": .object(["url": .string("data:image/jpeg;base64,\($0)")])]) }
    }
    first["content"] = .array(parts)
    messages[0] = .object(first)
    top["messages"] = .array(messages)
    return .object(top)
}

/// A reading that satisfies HandwritingSchema; only words that are in the text are kept to check.
public func decodeHandwriting(_ text: String) throws -> HandwritingRead {
    let data = try extractJSON(text)
    guard var read = try? JSONDecoder().decode(HandwritingRead.self, from: data) else {
        throw MarkingError.unreadable("it didn't have the text")
    }
    read.text = read.text.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    var seen = Set<String>()
    read.unclear = read.unclear.filter { !$0.isEmpty && read.text.contains($0) && seen.insert($0).inserted }
    read.model = nil
    return read
}

/// Types out a handwritten answer with the computer's API key, from this phone.
public func readHandwriting(photos: [Data], question: String, template: MarkingTemplate,
                            sender: HTTPSending = URLSessionSender()) async throws -> HandwritingRead {
    let prompt = handwritingPrompt(template, question: question, pages: photos.count)
    func attempt(_ extra: String) async throws -> HandwritingRead {
        guard let url = URL(string: template.request.url), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            throw MarkingError.badTemplate
        }
        var request = URLRequest(url: url, timeoutInterval: 300)
        request.httpMethod = "POST"
        for (name, value) in template.request.headers { request.setValue(value, forHTTPHeaderField: name) }
        request.httpBody = try JSONEncoder().encode(handwritingBody(template, prompt: prompt + extra, photos: photos))
        let (data, status): (Data, Int)
        do {
            (data, status) = try await sender.send(request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            let service = template.label.components(separatedBy: " · ").first ?? template.label
            throw MarkingError.service("Couldn't reach \(service): \(error.localizedDescription)")
        }
        var read = try decodeHandwriting(try replyText(kind: template.kind, label: template.label, status: status, data: data))
        read.model = template.label
        return read
    }
    do {
        return try await attempt("")
    } catch MarkingError.unreadable(let why) {
        return try await attempt("\n\nYour previous reply could not be used: \(why)\n"
            + "Reply again with valid JSON matching the schema exactly. No prose, no code fences.")
    }
}
