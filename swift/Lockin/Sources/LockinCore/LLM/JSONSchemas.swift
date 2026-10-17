import Foundation

// MARK: - JSON values, written and read the way JavaScript does

/// A JSON value with object keys kept in order, so what Swift writes to `lockin.db`
/// (job results, steps, rubrics, slide notes) is byte-for-byte what the Electron app's
/// `JSON.stringify` writes, and a schema sent to a model keeps its shape.
public enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object(JSONObject)
}

/// A JSON object with its keys in a JavaScript object's order: integer keys ("0", "12")
/// first, ascending, then every other key in the order it was first set. Setting an
/// existing key keeps its place; setting a new one appends it. Equality ignores key
/// order, as `toEqual` does.
public struct JSONObject: Equatable, Sendable, ExpressibleByDictionaryLiteral {
    public private(set) var keys: [String] = []
    private var values: [String: JSONValue] = [:]

    public init() {}

    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        for (key, value) in elements {
            self[key] = value
        }
    }

    public init(_ pairs: [(String, JSONValue)]) {
        for (key, value) in pairs {
            self[key] = value
        }
    }

    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }

    public subscript(key: String) -> JSONValue? {
        get { values[key] }
        set {
            if let newValue {
                if values.updateValue(newValue, forKey: key) == nil {
                    insertKey(key)
                }
            } else if values.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    /// A new key goes last, unless it is an array index, which JavaScript lists first.
    private mutating func insertKey(_ key: String) {
        guard let number = arrayIndex(key) else {
            keys.append(key)
            return
        }
        var position = 0
        while position < keys.count, let other = arrayIndex(keys[position]), other < number {
            position += 1
        }
        keys.insert(key, at: position)
    }

    /// "0", "7", "4294967294": a canonical whole number below 2³² − 1, which a JavaScript
    /// object orders before its other keys.
    private func arrayIndex(_ key: String) -> UInt64? {
        let units = Array(key.utf8)
        guard !units.isEmpty, units.count <= 10 else { return nil }
        if units.count > 1 && units[0] == 0x30 { return nil }
        var number: UInt64 = 0
        for unit in units {
            guard unit >= 0x30 && unit <= 0x39 else { return nil }
            number = number * 10 + UInt64(unit - 0x30)
        }
        return number < 4_294_967_295 ? number : nil
    }

    /// Key/value pairs in order.
    public var entries: [(key: String, value: JSONValue)] {
        var out: [(key: String, value: JSONValue)] = []
        out.reserveCapacity(keys.count)
        for key in keys {
            if let value = values[key] {
                out.append((key: key, value: value))
            }
        }
        return out
    }

    public static func == (lhs: JSONObject, rhs: JSONObject) -> Bool {
        lhs.values == rhs.values
    }
}

extension JSONValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension JSONValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
}

extension JSONValue: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) { self = .number(value) }
}

extension JSONValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}

extension JSONValue: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}

extension JSONValue: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        var object = JSONObject()
        for (key, value) in elements {
            object[key] = value
        }
        self = .object(object)
    }
}

extension JSONValue {
    public var stringValue: String? {
        if case .string(let text) = self { return text }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let number) = self { return number }
        return nil
    }

    /// The number as an Int, when it is a whole number that fits.
    public var intValue: Int? {
        if case .number(let number) = self { return Int(exactly: number) }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let flag) = self { return flag }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let items) = self { return items }
        return nil
    }

    public var objectValue: JSONObject? {
        if case .object(let object) = self { return object }
        return nil
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    /// `value.key` on an object; nil for a missing key or a non-object.
    public subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }

    /// `value[index]` on an array; nil out of range or for a non-array.
    public subscript(index: Int) -> JSONValue? {
        guard case .array(let items) = self, index >= 0, index < items.count else { return nil }
        return items[index]
    }

    /// JavaScript truthiness: `if (value)`.
    public var isTruthy: Bool {
        switch self {
        case .null: return false
        case .bool(let flag): return flag
        case .number(let number): return number != 0 && !number.isNaN
        case .string(let text): return !text.isEmpty
        case .array, .object: return true
        }
    }

    public static func int(_ value: Int) -> JSONValue {
        .number(Double(value))
    }

    public static func strings(_ values: [String]) -> JSONValue {
        .array(values.map { JSONValue.string($0) })
    }

    /// A string, or `null` when there is none (a zod `.nullable()` field).
    public static func orNull(_ value: String?) -> JSONValue {
        if let value { return .string(value) }
        return .null
    }

    public static func orNull(_ value: Double?) -> JSONValue {
        if let value { return .number(value) }
        return .null
    }

    public static func orNull(_ value: Int?) -> JSONValue {
        if let value { return .number(Double(value)) }
        return .null
    }

    public static func orNull(_ value: Bool?) -> JSONValue {
        if let value { return .bool(value) }
        return .null
    }
}

// MARK: - JSON.stringify

extension JSONValue {
    /// `JSON.stringify(value)` with `indent` 0, or `JSON.stringify(value, null, indent)`.
    public func stringified(indent: Int = 0) -> String {
        var out = ""
        JSONValue.write(self, into: &out, indent: indent, level: 0)
        return out
    }

    private static func write(_ value: JSONValue, into out: inout String, indent: Int, level: Int) {
        switch value {
        case .null:
            out += "null"
        case .bool(let flag):
            out += flag ? "true" : "false"
        case .number(let number):
            out += number.isFinite ? jsNumberString(number) : "null"
        case .string(let text):
            out += jsonQuoted(text)
        case .array(let items):
            if items.isEmpty {
                out += "[]"
                return
            }
            out += "["
            for (position, item) in items.enumerated() {
                if position > 0 { out += "," }
                if indent > 0 {
                    out += "\n" + String(repeating: " ", count: indent * (level + 1))
                }
                write(item, into: &out, indent: indent, level: level + 1)
            }
            if indent > 0 {
                out += "\n" + String(repeating: " ", count: indent * level)
            }
            out += "]"
        case .object(let object):
            let entries = object.entries
            if entries.isEmpty {
                out += "{}"
                return
            }
            out += "{"
            for (position, entry) in entries.enumerated() {
                if position > 0 { out += "," }
                if indent > 0 {
                    out += "\n" + String(repeating: " ", count: indent * (level + 1))
                }
                out += jsonQuoted(entry.key)
                out += indent > 0 ? ": " : ":"
                write(entry.value, into: &out, indent: indent, level: level + 1)
            }
            if indent > 0 {
                out += "\n" + String(repeating: " ", count: indent * level)
            }
            out += "}"
        }
    }
}

/// A string as `JSON.stringify` quotes it: only `"`, `\` and control characters are
/// escaped (no `\/`, unlike `JSONEncoder`).
public func jsonQuoted(_ text: String) -> String {
    var out = "\""
    for scalar in text.unicodeScalars {
        switch scalar {
        case "\"":
            out += "\\\""
        case "\\":
            out += "\\\\"
        case "\n":
            out += "\\n"
        case "\r":
            out += "\\r"
        case "\t":
            out += "\\t"
        case "\u{08}":
            out += "\\b"
        case "\u{0C}":
            out += "\\f"
        default:
            if scalar.value < 0x20 {
                let hex = String(scalar.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    out += "\""
    return out
}

/// `String(n)` for a JavaScript number: "10", "2.5", "0.00001", "1e-7", "1e+21".
public func jsNumberString(_ value: Double) -> String {
    if value.isNaN { return "NaN" }
    if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
    if value == 0 { return "0" }
    let sign = value < 0 ? "-" : ""
    let magnitude = Swift.abs(value)
    if magnitude < 1e15, magnitude == magnitude.rounded(.towardZero) {
        return sign + String(Int64(magnitude))
    }
    // Swift's description is the shortest form that reads back as the same number, as
    // JavaScript's is; only the layout differs. Take its digits and exponent apart.
    let described = "\(magnitude)".lowercased()
    let halves = described.components(separatedBy: "e")
    let mantissa = halves[0]
    let exponent = halves.count > 1 ? (Int(halves[1]) ?? 0) : 0
    let pieces = mantissa.components(separatedBy: ".")
    let whole = pieces[0]
    let fraction = pieces.count > 1 ? pieces[1] : ""
    var digits = Array(whole + fraction)
    var point = whole.count + exponent
    while digits.first == "0" {
        digits.removeFirst()
        point -= 1
    }
    while digits.last == "0" {
        digits.removeLast()
    }
    if digits.isEmpty { return "0" }
    let k = digits.count
    let n = point
    if k <= n && n <= 21 {
        return sign + String(digits) + String(repeating: "0", count: n - k)
    }
    if 0 < n && n <= 21 {
        return sign + String(digits[0..<n]) + "." + String(digits[n...])
    }
    if -6 < n && n <= 0 {
        return sign + "0." + String(repeating: "0", count: -n) + String(digits)
    }
    let e = n - 1
    let lead = String(digits[0])
    let rest = k > 1 ? "." + String(digits[1...]) : ""
    return sign + lead + rest + (e < 0 ? "e-\(-e)" : "e+\(e)")
}

/// `Math.round`: halves go up, towards +∞ (`Math.round(-2.5)` is -2).
public func jsMathRound(_ value: Double) -> Double {
    (value + 0.5).rounded(.down)
}

/// `Number(value)` for a parsed JSON value; nil stands for `undefined`.
public func jsNumberValue(_ value: JSONValue?) -> Double {
    guard let value else { return .nan }
    switch value {
    case .null:
        return 0
    case .bool(let flag):
        return flag ? 1 : 0
    case .number(let number):
        return number
    case .string(let text):
        return jsStringToNumber(text)
    case .array:
        // `Number([5])` is `Number(String([5]))`, so `Number("5")`.
        return jsStringToNumber(jsString(value))
    case .object:
        return .nan
    }
}

/// `String(value)`: an array's items joined with ",", with null as "".
func jsString(_ value: JSONValue) -> String {
    switch value {
    case .null:
        return "null"
    case .bool(let flag):
        return flag ? "true" : "false"
    case .number(let number):
        return jsNumberString(number)
    case .string(let text):
        return text
    case .array(let items):
        return items.map { $0.isNull ? "" : jsString($0) }.joined(separator: ",")
    case .object:
        return "[object Object]"
    }
}

/// JavaScript's white space and line ends, which `Number(" 4 ")` ignores.
private let jsWhitespace: CharacterSet = {
    var set = CharacterSet.whitespacesAndNewlines
    set.insert(charactersIn: "\u{FEFF}")
    set.remove(charactersIn: "\u{0085}")
    return set
}()

private let jsDecimalLiteralRe = Regex.compile(#"\A[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\z"#)

/// `Number(text)`: a decimal, "Infinity", or an unsigned 0x/0o/0b whole number; else NaN.
private func jsStringToNumber(_ text: String) -> Double {
    let trimmed = text.trimmingCharacters(in: jsWhitespace)
    if trimmed.isEmpty { return 0 }
    if trimmed == "Infinity" || trimmed == "+Infinity" { return .infinity }
    if trimmed == "-Infinity" { return -.infinity }
    let lower = trimmed.lowercased()
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] where lower.hasPrefix(prefix) {
        let digits = lower.dropFirst(2)
        guard !digits.isEmpty else { return .nan }
        var number = 0.0
        for character in digits {
            guard character.isASCII, let digit = character.hexDigitValue, digit < radix else { return .nan }
            number = number * Double(radix) + Double(digit)
        }
        return number
    }
    guard Regex.test(jsDecimalLiteralRe, in: trimmed) else { return .nan }
    if let number = Double(trimmed) { return number }
    // Out of range for a double: Number() gives ±Infinity, or ±0 for a tiny one.
    let negative = trimmed.hasPrefix("-")
    let tiny = lower.contains("e-")
    if tiny { return negative ? -0.0 : 0 }
    return negative ? -.infinity : .infinity
}

// MARK: - JSON.parse

/// What `JSON.parse` throws (a `SyntaxError` in JavaScript), worded as V8 words it:
/// "Unexpected token 'x', "x" is not valid JSON", "Expected ',' or '}' after property
/// value in JSON at position 7 (line 1 column 8)", positions in UTF-16 units. The
/// repair pass quotes it to the model and a failed job shows it. The worker counts it as
/// a cloud failure, so it gets a repair pass and the offline fallback.
public struct JSONParseError: Error, LocalizedError, Equatable, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

extension JSONValue {
    /// `JSON.parse(text)`, keeping object keys in JavaScript's order.
    public static func parse(_ text: String) throws -> JSONValue {
        var parser = JSONTextParser(text)
        return try parser.document()
    }

    public static func parse(data: Data) throws -> JSONValue {
        try parse(String(decoding: data, as: UTF8.self))
    }
}

/// V8's JSON parser (src/json/json-parser.cc), step for step where it matters: what it
/// accepts, and which error it reports first, where. It reads UTF-16 code units, as a
/// JavaScript string is, so positions and lengths match.
private struct JSONTextParser {
    private let units: [UInt16]
    private var index = 0
    private var depth = 0

    init(_ text: String) {
        units = Array(text.utf16)
    }

    mutating func document() throws -> JSONValue {
        let value = try parseValue()
        skipSpace()
        if index < units.count {
            throw positioned("Unexpected non-whitespace character after JSON")
        }
        return value
    }

    // MARK: Errors

    /// "… at position N (line L column C)": `\r\n` counts as one line end.
    private func positioned(_ what: String) -> JSONParseError {
        let end = min(index, units.count)
        var line = 1
        var lineStart = 0
        var cursor = 0
        while cursor < end {
            if units[cursor] == 0x0D && cursor < end - 1 && units[cursor + 1] == 0x0A {
                cursor += 1
            }
            if units[cursor] == 0x0D || units[cursor] == 0x0A {
                line += 1
                lineStart = cursor + 1
            }
            cursor += 1
        }
        return JSONParseError("\(what) at position \(end) (line \(line) column \(end - lineStart + 1))")
    }

    /// A character that can't start what was expected (`ReportUnexpectedCharacter`).
    private func unexpectedCharacter() -> JSONParseError {
        guard index < units.count else {
            return JSONParseError("Unexpected end of JSON input")
        }
        let unit = units[index]
        if unit == 0x22 {
            return positioned("Unexpected string in JSON")
        }
        if unit == 0x2D || isDigit(unit) {
            return positioned("Unexpected number in JSON")
        }
        return unexpectedToken()
    }

    /// "Unexpected token 'x', "…" is not valid JSON", with up to ten units either side
    /// of it when the text is longer than 21.
    private func unexpectedToken() -> JSONParseError {
        let source = String(decoding: units, as: UTF16.self)
        if ["[object Object]", "undefined", "Infinity", "NaN"].contains(source) {
            return JSONParseError("\"\(source)\" is not valid JSON")
        }
        let position = min(index, units.count - 1)
        let token = String(decoding: units[position...position], as: UTF16.self)
        let length = units.count
        let context = 10
        if length <= context * 2 + 1 {
            return JSONParseError("Unexpected token '\(token)', \"\(source)\" is not valid JSON")
        }
        if position < context {
            let shown = String(decoding: units[0..<(position + context)], as: UTF16.self)
            return JSONParseError("Unexpected token '\(token)', \"\(shown)\"... is not valid JSON")
        }
        if position < length - context {
            let shown = String(decoding: units[(position - context)..<(position + context)], as: UTF16.self)
            return JSONParseError("Unexpected token '\(token)', ...\"\(shown)\"... is not valid JSON")
        }
        let shown = String(decoding: units[(position - context)..<length], as: UTF16.self)
        return JSONParseError("Unexpected token '\(token)', ...\"\(shown)\" is not valid JSON")
    }

    // MARK: Reading

    private func isDigit(_ unit: UInt16) -> Bool {
        unit >= 0x30 && unit <= 0x39
    }

    private func hexValue(_ unit: UInt16) -> UInt16? {
        if unit >= 0x30 && unit <= 0x39 { return unit - 0x30 }
        if unit >= 0x61 && unit <= 0x66 { return unit - 0x61 + 10 }
        if unit >= 0x41 && unit <= 0x46 { return unit - 0x41 + 10 }
        return nil
    }

    /// Whether the next unit is `unit` (false at the end).
    private func at(_ unit: UInt16) -> Bool {
        index < units.count && units[index] == unit
    }

    private func atDigit() -> Bool {
        index < units.count && isDigit(units[index])
    }

    private mutating func skipSpace() {
        while index < units.count {
            let unit = units[index]
            if unit == 0x20 || unit == 0x09 || unit == 0x0A || unit == 0x0D {
                index += 1
            } else {
                return
            }
        }
    }

    private mutating func enter() throws {
        depth += 1
        if depth > 512 {
            throw JSONParseError("Maximum call stack size exceeded")
        }
    }

    private mutating func parseValue() throws -> JSONValue {
        skipSpace()
        guard index < units.count else { throw unexpectedCharacter() }
        switch units[index] {
        case 0x22:
            index += 1
            return .string(try parseString())
        case 0x7B:
            return try parseObject()
        case 0x5B:
            return try parseArray()
        case 0x74:
            try parseLiteral("true")
            return .bool(true)
        case 0x66:
            try parseLiteral("false")
            return .bool(false)
        case 0x6E:
            try parseLiteral("null")
            return .null
        case 0x2D, 0x30...0x39:
            return .number(try parseNumber())
        default:
            throw unexpectedCharacter()
        }
    }

    /// `true`, `false` or `null`, whose first letter is already known (`ScanLiteral`).
    private mutating func parseLiteral(_ word: String) throws {
        let expected = Array(word.utf16)
        if units.count - index >= expected.count && Array(units[index..<(index + expected.count)]) == expected {
            index += expected.count
            return
        }
        index += 1
        var next = 1
        while next < expected.count && index < units.count {
            if units[index] != expected[next] {
                throw unexpectedCharacter()
            }
            index += 1
            next += 1
        }
        throw JSONParseError("Unexpected end of JSON input")
    }

    private mutating func parseObject() throws -> JSONValue {
        try enter()
        defer { depth -= 1 }
        index += 1
        var object = JSONObject()
        skipSpace()
        if at(0x7D) {
            index += 1
            return .object(object)
        }
        guard at(0x22) else { throw positioned("Expected property name or '}' in JSON") }
        while true {
            index += 1
            let key = try parseString()
            skipSpace()
            guard at(0x3A) else { throw positioned("Expected ':' after property name in JSON") }
            index += 1
            // A repeated key keeps its first place and takes the last value, as JSON.parse does.
            object[key] = try parseValue()
            skipSpace()
            if at(0x2C) {
                index += 1
                skipSpace()
                guard at(0x22) else { throw positioned("Expected double-quoted property name in JSON") }
                continue
            }
            guard at(0x7D) else { throw positioned("Expected ',' or '}' after property value in JSON") }
            index += 1
            return .object(object)
        }
    }

    private mutating func parseArray() throws -> JSONValue {
        try enter()
        defer { depth -= 1 }
        index += 1
        var items: [JSONValue] = []
        skipSpace()
        if at(0x5D) {
            index += 1
            return .array(items)
        }
        while true {
            items.append(try parseValue())
            skipSpace()
            if at(0x2C) {
                index += 1
                continue
            }
            guard at(0x5D) else { throw positioned("Expected ',' or ']' after array element in JSON") }
            index += 1
            return .array(items)
        }
    }

    /// The rest of a string, its opening quote already read (`ScanJsonString`). A lone
    /// surrogate escape, which a Swift string cannot hold, becomes U+FFFD.
    private mutating func parseString() throws -> String {
        var buffer: [UInt16] = []
        while true {
            guard index < units.count else { throw positioned("Unterminated string in JSON") }
            let unit = units[index]
            if unit == 0x22 {
                index += 1
                return String(decoding: buffer, as: UTF16.self)
            }
            if unit == 0x5C {
                index += 1
                guard index < units.count else { throw JSONParseError("Unexpected end of JSON input") }
                let escape = units[index]
                switch escape {
                case 0x22, 0x5C, 0x2F:
                    buffer.append(escape)
                case 0x62:
                    buffer.append(0x08)
                case 0x66:
                    buffer.append(0x0C)
                case 0x6E:
                    buffer.append(0x0A)
                case 0x72:
                    buffer.append(0x0D)
                case 0x74:
                    buffer.append(0x09)
                case 0x75:
                    var code: UInt16 = 0
                    for _ in 0..<4 {
                        index += 1
                        guard index < units.count, let digit = hexValue(units[index]) else {
                            throw positioned("Bad Unicode escape in JSON")
                        }
                        code = code &* 16 &+ digit
                    }
                    buffer.append(code)
                default:
                    if escape > 0xFF {
                        throw unexpectedToken()
                    }
                    throw positioned("Bad escaped character in JSON")
                }
                index += 1
                continue
            }
            if unit < 0x20 {
                throw positioned("Bad control character in string literal in JSON")
            }
            buffer.append(unit)
            index += 1
        }
    }

    /// A number (`ParseJsonNumber`): no leading zeros, digits after a point or an `e`.
    private mutating func parseNumber() throws -> Double {
        let start = index
        if at(0x2D) {
            index += 1
        }
        if at(0x30) {
            index += 1
            if atDigit() { throw positioned("Unexpected number in JSON") }
        } else {
            let digits = index
            while atDigit() {
                index += 1
            }
            if index == digits { throw positioned("No number after minus sign in JSON") }
        }
        if at(0x2E) {
            index += 1
            guard atDigit() else { throw positioned("Unterminated fractional number in JSON") }
            while atDigit() {
                index += 1
            }
        }
        if at(0x65) || at(0x45) {
            index += 1
            if at(0x2B) || at(0x2D) {
                index += 1
            }
            guard atDigit() else { throw positioned("Exponent part is missing a number in JSON") }
            while atDigit() {
                index += 1
            }
        }
        let text = String(decoding: units[start..<index], as: UTF16.self)
        if let value = Double(text) {
            return value
        }
        // Too large or too small for a double: JavaScript reads ±Infinity, or ±0.
        let negative = text.hasPrefix("-")
        if text.contains("e-") || text.contains("E-") {
            return negative ? -0.0 : 0
        }
        return negative ? -.infinity : .infinity
    }
}

// MARK: - Codable

struct JSONCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init(_ key: String) {
        stringValue = key
        intValue = nil
    }

    init?(stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let flag = try? container.decode(Bool.self) {
            self = .bool(flag)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let text = try? container.decode(String.self) {
            self = .string(text)
        } else if let items = try? container.decode([JSONValue].self) {
            self = .array(items)
        } else if let dictionary = try? container.decode([String: JSONValue].self) {
            // A decoder's dictionary has no order; sort it so the result is at least stable.
            var object = JSONObject()
            for key in dictionary.keys.sorted() {
                object[key] = dictionary[key]
            }
            self = .object(object)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "not a JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .null:
            var container = encoder.singleValueContainer()
            try container.encodeNil()
        case .bool(let flag):
            var container = encoder.singleValueContainer()
            try container.encode(flag)
        case .number(let number):
            var container = encoder.singleValueContainer()
            try container.encode(number)
        case .string(let text):
            var container = encoder.singleValueContainer()
            try container.encode(text)
        case .array(let items):
            var container = encoder.unkeyedContainer()
            for item in items {
                try container.encode(item)
            }
        case .object(let object):
            var container = encoder.container(keyedBy: JSONCodingKey.self)
            for entry in object.entries {
                try container.encode(entry.value, forKey: JSONCodingKey(entry.key))
            }
        }
    }
}

// MARK: - Schemas for offline replies (lib/llm/local.ts)

/// The JSON Schemas an offline model's replies are held to, as `lib/llm/local.ts` builds
/// them. They are written in llama.cpp grammar style (every property required, none
/// extra); the MLX engine gets them through `strictSchema`, which spells that out.
public enum OfflineSchemas {
    public static func nullable(_ schema: JSONValue) -> JSONValue {
        let none: JSONValue = ["type": "null"]
        return ["oneOf": .array([schema, none])]
    }

    /// Marks are out of ten in half marks; an open number lets a small model write -3 or 40.
    public static let marks: JSONValue = ["enum": .array((0...20).map { JSONValue.number(Double($0) / 2) })]
    public static let wholeMarks: JSONValue = ["enum": .array((0...10).map { JSONValue.number(Double($0)) })]

    /// Non-empty text, matching the schemas' min(1): a grammar alone would allow "".
    public static func text(_ maxLength: Int? = nil) -> JSONValue {
        // `maxLength ? … : …` in TypeScript: 0 means no limit.
        if let maxLength, maxLength != 0 {
            return ["type": "string", "minLength": 1, "maxLength": .int(maxLength)]
        }
        return ["type": "string", "minLength": 1]
    }

    public static func idOf(_ ids: [String]) -> JSONValue {
        if ids.isEmpty {
            return ["type": "null"]
        }
        return ["enum": .strings(ids)]
    }

    public static func digest(existingIds: [String]) -> JSONValue {
        let skippedProperties: JSONValue = [
            "what": text(120),
            "where": ["type": "string", "maxLength": 120],
            "about": ["type": "string", "maxLength": 500],
        ]
        let skippedItem: JSONValue = ["type": "object", "properties": skippedProperties]
        let existingId: JSONValue
        if existingIds.isEmpty {
            existingId = ["type": "null"]
        } else {
            existingId = nullable(["enum": .strings(existingIds)])
        }
        let conceptProperties: JSONValue = [
            "existingId": existingId,
            "name": text(140),
            "definition": text(),
            "sourceRef": nullable(["type": "string", "maxLength": 60]),
        ]
        let conceptItem: JSONValue = ["type": "object", "properties": conceptProperties]
        let properties: JSONValue = [
            "title": text(140),
            "skipped": ["type": "array", "maxItems": 12, "items": skippedItem],
            "summaryMd": text(),
            "concepts": ["type": "array", "minItems": 1, "maxItems": 60, "items": conceptItem],
            // Notes describe what a slide shows; a model that never saw it has none to give.
            "slideNotes": ["type": "array", "maxItems": 0],
        ]
        return ["type": "object", "properties": properties]
    }

    public static func questions(conceptIds: [String], type: QuestionType, total: Int) -> JSONValue {
        let count = JSONValue.int(max(1, total))
        let criterionProperties: JSONValue = ["point": text(), "marks": wholeMarks]
        let criterion: JSONValue = ["type": "object", "properties": criterionProperties]
        let rubricProperties: JSONValue = [
            "modelAnswer": text(),
            "criteria": ["type": "array", "minItems": 2, "maxItems": 8, "items": criterion],
            "totalMarks": ["const": 10],
        ]
        let rubric: JSONValue = ["type": "object", "properties": rubricProperties]
        let questionProperties: JSONValue = [
            "stem": text(),
            "type": ["const": .string(type.rawValue)],
            "conceptIds": ["type": "array", "minItems": 1, "maxItems": 4, "items": idOf(conceptIds)],
            "rubric": rubric,
        ]
        let question: JSONValue = ["type": "object", "properties": questionProperties]
        let questions: JSONValue = ["type": "array", "minItems": count, "maxItems": count, "items": question]
        let properties: JSONValue = ["questions": questions]
        return ["type": "object", "properties": properties]
    }

    public static func marking(conceptIds: [String]) -> JSONValue {
        let criterionProperties: JSONValue = [
            "point": text(),
            "awarded": marks,
            "outOf": marks,
            "note": nullable(["type": "string"]),
        ]
        let criterion: JSONValue = ["type": "object", "properties": criterionProperties]
        let gaps: JSONValue
        if conceptIds.isEmpty {
            gaps = ["type": "array", "maxItems": 0]
        } else {
            let gapProperties: JSONValue = [
                "conceptId": ["enum": .strings(conceptIds)],
                "type": ["enum": ["MISSED", "WRONG"]],
                "text": text(),
            ]
            let gap: JSONValue = ["type": "object", "properties": gapProperties]
            gaps = ["type": "array", "maxItems": 10, "items": gap]
        }
        let properties: JSONValue = [
            "mark": marks,
            "criteria": ["type": "array", "maxItems": 12, "items": criterion],
            "gaps": gaps,
        ]
        return ["type": "object", "properties": properties]
    }

    public static func sort(fileCount: Int) -> JSONValue {
        let numbers: [JSONValue] = fileCount > 0 ? (1...fileCount).map { JSONValue.int($0) } : []
        let file: JSONValue = ["enum": .array(numbers)]
        let lectureProperties: JSONValue = [
            "title": text(120),
            "module": nullable(text(80)),
            "files": ["type": "array", "minItems": 1, "maxItems": 8, "items": file],
        ]
        let lecture: JSONValue = ["type": "object", "properties": lectureProperties]
        let setAsideProperties: JSONValue = ["file": file, "reason": text(80)]
        let setAside: JSONValue = ["type": "object", "properties": setAsideProperties]
        let properties: JSONValue = [
            "lectures": ["type": "array", "maxItems": .int(fileCount), "items": lecture],
            "setAside": ["type": "array", "maxItems": .int(fileCount), "items": setAside],
        ]
        return ["type": "object", "properties": properties]
    }

    /// A question's answer may only be filed under a heading the summary has.
    public static func answer(headings: [String], maxLength: Int) -> JSONValue {
        let section: JSONValue
        if headings.isEmpty {
            section = ["type": "null"]
        } else {
            section = nullable(["enum": .strings(headings)])
        }
        let properties: JSONValue = ["answer": text(maxLength), "section": section]
        return ["type": "object", "properties": properties]
    }

    public static let paper: JSONValue = {
        let itemProperties: JSONValue = [
            "questionNumber": OfflineSchemas.nullable(["type": "string", "maxLength": 12]),
            "stem": OfflineSchemas.text(),
            "marksAllocated": OfflineSchemas.nullable(["type": "number"]),
            "conceptIds": ["type": "array", "items": ["type": "string"]],
        ]
        let item: JSONValue = ["type": "object", "properties": itemProperties]
        let properties: JSONValue = ["items": ["type": "array", "items": item]]
        return ["type": "object", "properties": properties]
    }()
}

private let strictRecursiveKeys: Set<String> = ["items", "prefixItems", "oneOf", "anyOf", "allOf", "additionalProperties"]

/// Port of `lib/llm/strict-schema.ts`. The schemas above are written for llama.cpp's
/// grammar, where an object's properties are all required and no others are allowed.
/// The MLX engine holds replies to real JSON Schema instead, where properties are
/// optional and extras allowed unless the schema says otherwise — so this spells out
/// what the grammar assumes, all the way down. The original is left as it was.
public func strictSchema(_ schema: JSONValue) -> JSONValue {
    switch schema {
    case .array(let items):
        return .array(items.map { strictSchema($0) })
    case .object(let object):
        var out = JSONObject()
        for entry in object.entries {
            let key = entry.key
            if key == "properties" || key == "$defs" || key == "defs" {
                if case .object(let properties) = entry.value {
                    var mapped = JSONObject()
                    for property in properties.entries {
                        mapped[property.key] = strictSchema(property.value)
                    }
                    out[key] = .object(mapped)
                } else {
                    out[key] = entry.value
                }
            } else if strictRecursiveKeys.contains(key) {
                out[key] = strictSchema(entry.value)
            } else {
                out[key] = entry.value
            }
        }
        if case .object(let properties)? = out["properties"] {
            out["required"] = .strings(properties.keys)
            if out["additionalProperties"] == nil {
                out["additionalProperties"] = .bool(false)
            }
        }
        return .object(out)
    default:
        return schema
    }
}
