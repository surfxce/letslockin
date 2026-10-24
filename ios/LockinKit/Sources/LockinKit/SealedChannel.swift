import CryptoKit
import Foundation

/// The phone and the computer share a 256-bit key from the pairing QR code. Every
/// request and reply is sealed with AES-256-GCM, as nonce ‖ ciphertext ‖ tag — the
/// layout lib/phone/crypto.ts uses on the computer. The additional data says what a
/// message is for, so one can't be passed off as another.
public struct SealedChannel: @unchecked Sendable {
    private let key: SymmetricKey

    public init?(keyData: Data) {
        guard keyData.count == 32 else { return nil }
        key = SymmetricKey(data: keyData)
    }

    /// `nonce` is for tests; normally a fresh random one is made for every message.
    public func seal(_ plaintext: Data, aad: String, nonce: Data? = nil) throws -> Data {
        let sealedNonce = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plaintext, using: key, nonce: sealedNonce, authenticating: Data(aad.utf8))
        guard let combined = box.combined else { throw CryptoKitError.incorrectParameterSize }
        return combined
    }

    /// The plaintext, or nil when it wasn't sealed with this key for this purpose.
    public func open(_ sealed: Data, aad: String) -> Data? {
        guard sealed.count >= 28, let box = try? AES.GCM.SealedBox(combined: sealed) else { return nil }
        return try? AES.GCM.open(box, using: key, authenticating: Data(aad.utf8))
    }

    public static func requestAAD(op: String, pairingId: String) -> String {
        "lockin/1 request \(op) \(pairingId)"
    }

    public static func replyAAD(op: String, requestId: String) -> String {
        "lockin/1 reply \(op) \(requestId)"
    }
}
