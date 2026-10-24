import XCTest
@testable import LockinKit

final class PairingTests: XCTestCase {
    /// As lib/phone/pairing.ts writes it.
    private func link(_ payload: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: payload)
        return "lockin://pair?d=\(data.base64URLEncodedString())"
    }

    private let key = Data(repeating: 9, count: 32).base64URLEncodedString()

    func testReadsTheComputersCode() throws {
        let text = try link(["v": 1, "id": "oK5RGktIjDpvFSGT", "k": key, "n": "Sandes-MacBook-Pro",
                             "h": ["192.168.1.20", "Sandes-MacBook-Pro.local"], "p": 47821])
        let pairing = try XCTUnwrap(Pairing.parse("  \(text)\n"))
        XCTAssertEqual(pairing.id, "oK5RGktIjDpvFSGT")
        XCTAssertEqual(pairing.computer, "Sandes-MacBook-Pro")
        XCTAssertEqual(pairing.hosts, ["192.168.1.20", "Sandes-MacBook-Pro.local"])
        XCTAssertEqual(pairing.port, 47821)
        XCTAssertEqual(pairing.keyData?.count, 32)
    }

    func testTriesTheAddressThatWorkedFirst() {
        var pairing = Pairing(id: "abcd", key: key, computer: "Mac", hosts: ["10.0.0.2", "Mac.local"], port: 1)
        XCTAssertEqual(pairing.hostsToTry, ["10.0.0.2", "Mac.local"])
        pairing.lastHost = "Mac.local"
        XCTAssertEqual(pairing.hostsToTry, ["Mac.local", "10.0.0.2"])
        pairing.lastHost = "gone"
        XCTAssertEqual(pairing.hostsToTry, ["10.0.0.2", "Mac.local"])
    }

    func testRefusesAnythingElse() throws {
        XCTAssertNil(Pairing.parse("https://example.com/pair?d=x"))
        XCTAssertNil(Pairing.parse("lockin://pair?d=not-json"))
        XCTAssertNil(Pairing.parse(try link(["v": 1, "id": "abcd", "k": "short", "n": "Mac", "h": ["1.2.3.4"], "p": 1])))
        XCTAssertNil(Pairing.parse(try link(["v": 2, "id": "abcd", "k": key, "n": "Mac", "h": ["1.2.3.4"], "p": 1])))
        XCTAssertNil(Pairing.parse(try link(["v": 1, "id": "a/b", "k": key, "n": "Mac", "h": ["1.2.3.4"], "p": 1])))
        XCTAssertNil(Pairing.parse(try link(["v": 1, "id": "abcd", "k": key, "n": "Mac", "h": ["evil host/x"], "p": 1])))
        XCTAssertNil(Pairing.parse(try link(["v": 1, "id": "abcd", "k": key, "n": "Mac", "h": ["1.2.3.4"], "p": 70000])))
    }
}
