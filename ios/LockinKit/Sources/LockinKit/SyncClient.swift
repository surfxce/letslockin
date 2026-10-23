import Foundation

public enum SyncError: LocalizedError, Equatable {
    /// The computer doesn't know this phone (unpaired, or a different library).
    case notPaired(String)
    /// None of the computer's addresses answered.
    case unreachable(String)
    /// The computer answered, but not with something usable.
    case computer(String)

    public var errorDescription: String? {
        switch self {
        case .notPaired(let computer):
            return "\(computer) doesn't recognise this phone any more. Pair it again in Lockin's Settings → iPhone."
        case .unreachable(let computer):
            return "Can't reach \(computer). Open Lockin on it, and keep the phone on the same Wi-Fi."
        case .computer(let message):
            return message
        }
    }
}

/// Talks to the paired computer: POST http://<host>:<port>/v1/<op>, sealed both ways
/// (lib/phone/protocol.ts). A quick hello finds which of the computer's addresses
/// answers, the one that last worked first; syncs and pictures then go there.
public final class SyncClient: @unchecked Sendable {
    public private(set) var pairing: Pairing
    private let channel: SealedChannel
    private let session: URLSession
    private let device: Device
    /// The address that answered this session.
    private var confirmedHost: String?
    /// Told when a different address starts working, so it is tried first next time.
    public var onHostChange: ((String) -> Void)?

    public init?(pairing: Pairing, device: Device, session: URLSession? = nil) {
        guard let key = pairing.keyData, let channel = SealedChannel(keyData: key) else { return nil }
        self.pairing = pairing
        self.channel = channel
        self.device = device
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.waitsForConnectivity = false
            config.timeoutIntervalForResource = 600
            self.session = URLSession(configuration: config)
        }
    }

    private struct Envelope<Body: Encodable>: Encodable {
        let t: Int64
        let r: String
        let body: Body
    }

    private struct Status: Decodable {
        let ok: Bool?
        let error: String?
    }

    /// Finds an address that answers, and tells the computer this phone's name.
    @discardableResult
    public func hello() async throws -> HelloReply {
        var lastError: Error = SyncError.unreachable(pairing.computer)
        for host in pairing.hostsToTry {
            do {
                let data = try await send("hello", ["device": device], host: host, timeout: 6)
                confirmedHost = host
                if host != pairing.lastHost {
                    pairing.lastHost = host
                    onHostChange?(host)
                }
                return try LockinJSON.decoder().decode(HelloReply.self, from: data)
            } catch let error as URLError {
                lastError = unreachable(error)
            }
        }
        throw lastError
    }

    public func sync(_ request: SyncRequest) async throws -> SyncReply {
        try LockinJSON.decoder().decode(SyncReply.self, from: try await call("sync", request, timeout: 180))
    }

    /// One slide picture (JPEG), by the reference the snapshot lists it under.
    public func slide(lectureId: String, ref: String) async throws -> Data {
        try await call("slide", ["lectureId": lectureId, "ref": ref], timeout: 60, image: true)
    }

    private func unreachable(_ error: URLError) -> SyncError {
        switch error.code {
        case .timedOut, .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .notConnectedToInternet,
             .dnsLookupFailed, .cannotParseResponse, .badServerResponse, .secureConnectionFailed:
            return .unreachable(pairing.computer)
        default:
            return .computer(error.localizedDescription)
        }
    }

    private func call<Body: Encodable>(_ op: String, _ body: Body, timeout: TimeInterval, image: Bool = false) async throws -> Data {
        if confirmedHost == nil { try await hello() }
        guard let host = confirmedHost else { throw SyncError.unreachable(pairing.computer) }
        do {
            return try await send(op, body, host: host, timeout: timeout, image: image)
        } catch let error as URLError {
            // The address stopped answering (new Wi-Fi, new address): find it again, once.
            guard case .unreachable = unreachable(error) else { throw unreachable(error) }
            confirmedHost = nil
            try await hello()
            guard let again = confirmedHost else { throw SyncError.unreachable(pairing.computer) }
            do {
                return try await send(op, body, host: again, timeout: timeout, image: image)
            } catch let error as URLError {
                throw unreachable(error)
            }
        }
    }

    private func send<Body: Encodable>(_ op: String, _ body: Body, host: String, timeout: TimeInterval, image: Bool = false) async throws -> Data {
        // A new id and time for each try: the computer refuses a request it has already seen.
        let requestId = LockinID.make(prefix: "r")
        let envelope = Envelope(t: Int64(Date().timeIntervalSince1970 * 1000), r: requestId, body: body)
        let plaintext = try LockinJSON.encoder().encode(envelope)
        let sealed = try channel.seal(plaintext, aad: SealedChannel.requestAAD(op: op, pairingId: pairing.id))

        let address = host.contains(":") ? "[\(host)]" : host
        guard let url = URL(string: "http://\(address):\(pairing.port)/v1/\(op)") else { throw SyncError.unreachable(pairing.computer) }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        request.setValue(pairing.id, forHTTPHeaderField: "x-lockin-pairing")
        request.httpBody = sealed

        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200: break
        case 401: throw SyncError.notPaired(pairing.computer)
        case 503: throw SyncError.computer("Lockin is still starting on \(pairing.computer). Try again in a moment.")
        default:
            let text = String(data: data.prefix(300), encoding: .utf8) ?? ""
            throw SyncError.computer(text.isEmpty ? "\(pairing.computer) answered \(status)." : text)
        }
        guard let plain = channel.open(data, aad: SealedChannel.replyAAD(op: op, requestId: requestId)) else {
            throw SyncError.computer("The reply from \(pairing.computer) couldn't be read.")
        }
        let type = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "x-lockin-type") ?? "json"
        if type == "json", let status = try? JSONDecoder().decode(Status.self, from: plain), status.ok == false {
            throw SyncError.computer(status.error ?? "Something went wrong on \(pairing.computer).")
        }
        if image && type == "json" { throw SyncError.computer("No picture came back.") }
        return plain
    }
}
