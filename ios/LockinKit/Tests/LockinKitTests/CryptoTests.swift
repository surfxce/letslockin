import XCTest
@testable import LockinKit

/// The same vector lib/phone/phone.test.ts checks on the computer: if both pass, the
/// two ends seal and open each other's messages.
final class CryptoTests: XCTestCase {
    func testMatchesTheComputerByteForByte() throws {
        let v = try Fixture.object("crypto-vector")
        let key = try XCTUnwrap(Data(base64URLEncoded: v["keyBase64Url"] as! String))
        let channel = try XCTUnwrap(SealedChannel(keyData: key))
        let nonce = try XCTUnwrap(Data(hex: v["nonceHex"] as! String))
        let aad = v["aad"] as! String
        let plaintext = Data((v["plaintext"] as! String).utf8)
        let sealedHex = v["sealedHex"] as! String

        XCTAssertEqual(try channel.seal(plaintext, aad: aad, nonce: nonce).hexString, sealedHex)
        XCTAssertEqual(channel.open(try XCTUnwrap(Data(hex: sealedHex)), aad: aad), plaintext)
        XCTAssertEqual(aad, SealedChannel.requestAAD(op: "sync", pairingId: "pairing-0001"))
    }

    func testRefusesChangedOrMisdirectedMessages() throws {
        let v = try Fixture.object("crypto-vector")
        let channel = try XCTUnwrap(SealedChannel(keyData: try XCTUnwrap(Data(base64URLEncoded: v["keyBase64Url"] as! String))))
        var sealed = try XCTUnwrap(Data(hex: v["sealedHex"] as! String))
        let aad = v["aad"] as! String
        XCTAssertNil(channel.open(sealed, aad: SealedChannel.requestAAD(op: "slide", pairingId: "pairing-0001")))
        XCTAssertNil(channel.open(sealed.prefix(20), aad: aad))
        sealed[20] ^= 1
        XCTAssertNil(channel.open(sealed, aad: aad))
        XCTAssertNil(SealedChannel(keyData: Data(repeating: 1, count: 16)))
    }

    func testRoundTripsWithAFreshNonce() throws {
        let channel = try XCTUnwrap(SealedChannel(keyData: Data(repeating: 7, count: 32)))
        let aad = SealedChannel.replyAAD(op: "sync", requestId: "r1")
        let a = try channel.seal(Data("hello".utf8), aad: aad)
        let b = try channel.seal(Data("hello".utf8), aad: aad)
        XCTAssertNotEqual(a, b, "every message gets its own nonce")
        XCTAssertEqual(channel.open(a, aad: aad), Data("hello".utf8))
        XCTAssertEqual(SealedChannel.replyAAD(op: "slide", requestId: "abc"), "lockin/1 reply slide abc")
    }

    func testBase64URL() {
        let bytes = Data([0xfb, 0xff, 0xfe, 0x00, 0x01])
        XCTAssertEqual(bytes.base64URLEncodedString(), "-__-AAE")
        XCTAssertEqual(Data(base64URLEncoded: "-__-AAE"), bytes)
        XCTAssertNil(Data(base64URLEncoded: "abcde"))
        XCTAssertTrue(LockinID.make().range(of: "^p[a-z0-9]{24}$", options: .regularExpression) != nil)
    }
}
