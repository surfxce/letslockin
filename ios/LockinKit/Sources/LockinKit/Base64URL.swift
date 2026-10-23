import Foundation

extension Data {
    /// Base64url without padding, as Node's `Buffer.toString("base64url")` writes it.
    public init?(base64URLEncoded text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder == 1 { return nil }
        if remainder > 0 { base64 += String(repeating: "=", count: 4 - remainder) }
        self.init(base64Encoded: base64)
    }

    public func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }

    public var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}

/// Ids the phone makes for what it creates (sittings, answers, reviews). The computer
/// keeps them as they are, so sending something twice never makes two of it.
public enum LockinID {
    private static let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")

    public static func make(prefix: String = "p") -> String {
        var generator = SystemRandomNumberGenerator()
        return prefix + String((0..<24).map { _ in alphabet[Int(generator.next(upperBound: UInt32(alphabet.count)))] })
    }
}
