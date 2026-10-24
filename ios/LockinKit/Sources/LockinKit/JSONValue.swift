import Foundation

/// Any JSON, for the parts of a reply or request whose shape belongs to someone else:
/// the API request the computer prepares for marking on the phone.
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value):
            // Whole numbers as integers: an API that wants `"max_tokens": 16000` gets that.
            if value.rounded() == value, abs(value) < 9_007_199_254_740_992 {
                try container.encode(Int64(value))
            } else {
                try container.encode(value)
            }
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// Every string exactly equal to `slot`, anywhere inside, replaced by `text`.
    public func replacingString(_ slot: String, with text: String) -> JSONValue {
        switch self {
        case .string(let value): return value == slot ? .string(text) : self
        case .array(let values): return .array(values.map { $0.replacingString(slot, with: text) })
        case .object(let values): return .object(values.mapValues { $0.replacingString(slot, with: text) })
        default: return self
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let values) = self { return values[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let values) = self { return values }
        return nil
    }
}
