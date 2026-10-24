import Foundation

/// A computer this phone is paired with, from the QR code in Lockin's Settings:
/// `lockin://pair?d=<base64url JSON {v, id, k, n, h, p}>` (lib/phone/pairing.ts).
public struct Pairing: Codable, Hashable, Sendable {
    public var id: String
    /// The shared key, base64url. Kept in the Keychain.
    public var key: String
    /// The computer's name, to show.
    public var computer: String
    /// Its addresses on the local network, best first, then its Bonjour name.
    public var hosts: [String]
    public var port: Int
    /// The address that last worked, tried first.
    public var lastHost: String?

    public init(id: String, key: String, computer: String, hosts: [String], port: Int, lastHost: String? = nil) {
        self.id = id
        self.key = key
        self.computer = computer
        self.hosts = hosts
        self.port = port
        self.lastHost = lastHost
    }

    public var keyData: Data? { Data(base64URLEncoded: key) }

    /// Addresses to try, the one that last worked first.
    public var hostsToTry: [String] {
        guard let lastHost, hosts.contains(lastHost) else { return hosts }
        return [lastHost] + hosts.filter { $0 != lastHost }
    }

    private struct Payload: Decodable {
        let v: Int
        let id: String
        let k: String
        let n: String
        let h: [String]
        let p: Int
    }

    /// The pairing in a scanned or pasted link, or nil when it isn't a Lockin pairing code.
    public static func parse(_ text: String) -> Pairing? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "lockin",
              components.host?.lowercased() == "pair",
              let encoded = components.queryItems?.first(where: { $0.name == "d" })?.value,
              let data = Data(base64URLEncoded: encoded),
              let payload = try? JSONDecoder().decode(Payload.self, from: data),
              payload.v == 1,
              payload.id.range(of: "^[A-Za-z0-9_-]{4,64}$", options: .regularExpression) != nil,
              Data(base64URLEncoded: payload.k)?.count == 32,
              (1...65535).contains(payload.p)
        else { return nil }
        let hosts = payload.h
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && $0.count <= 253 && $0.range(of: "^[A-Za-z0-9.:-]+$", options: .regularExpression) != nil }
        guard !hosts.isEmpty else { return nil }
        return Pairing(id: payload.id, key: payload.k, computer: String(payload.n.prefix(80)), hosts: hosts, port: payload.p)
    }
}
