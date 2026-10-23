import XCTest
@testable import LockinKit

/// The fixtures lib/phone/phone.test.ts checks against the computer's schema.
final class SnapshotTests: XCTestCase {
    func testDecodesWhatTheComputerSends() throws {
        let snapshot = try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot"))
        XCTAssertEqual(snapshot.v, 1)
        XCTAssertEqual(snapshot.courses.map(\.code), ["BIOM3015", "PHYS1001"])
        XCTAssertNil(snapshot.courses[1].examDate)
        let lecture = snapshot.lectures[0]
        XCTAssertEqual(lecture.images, ["3?crop=0.1,0.2,0.5,0.4", "5"])
        XCTAssertEqual(lecture.questions[0].criteria[0].marks, 2)
        XCTAssertEqual(lecture.nextSitting, [lecture.questions[0].id])
        XCTAssertEqual(snapshot.sittings[0].responses[0].feedback.map(\.kind), ["good", "missed"])
        XCTAssertEqual(snapshot.cards[0].state, "new")
        XCTAssertEqual(snapshot.marking?.kind, "anthropic")
        XCTAssertEqual(snapshot.marking?.request.body["max_tokens"], .number(16000))
        XCTAssertNil(snapshot.lectures[1].summaryHtml)
        XCTAssertEqual(snapshot.mcqs?.first?.options.count, 5)
        XCTAssertEqual(snapshot.lectures[0].questions[0].fromPaper, false)
    }

    func testSendsWhatTheComputerAccepts() throws {
        let request = try LockinJSON.decoder().decode(SyncRequest.self, from: try Fixture.data("sync-request"))
        XCTAssertEqual(request.exams, [], "absent from older phones' requests")
        XCTAssertEqual(request.sittings[0].responses[0].marking?.mark, 7)
        XCTAssertNil(request.sittings[0].responses[1].marking)
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: try LockinJSON.encoder().encode(request)) as? [String: Any])
        let original = try Fixture.object("sync-request")
        let sitting = try XCTUnwrap((encoded["sittings"] as? [[String: Any]])?.first)
        let originalSitting = try XCTUnwrap((original["sittings"] as? [[String: Any]])?.first)
        XCTAssertEqual(sitting["startedAt"] as? String, originalSitting["startedAt"] as? String, "dates as JavaScript writes them")
        XCTAssertEqual(Set(sitting.keys), Set(originalSitting.keys))
        let review = try XCTUnwrap((encoded["reviews"] as? [[String: Any]])?.first)
        XCTAssertEqual(review["reviewedAt"] as? String, "2026-10-23T01:30:00.000Z")
        XCTAssertNil((sitting["responses"] as? [[String: Any]])?.first?["markingError"], "notes for the phone stay on the phone")
    }

    func testListsSittingsFromBothEnds() throws {
        let snapshot = try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot"))
        let lecture = snapshot.lectures[0]
        let here = PhoneSitting(
            id: "pHere", lectureId: lecture.id, startedAt: Date(), submittedAt: Date(),
            responses: [
                PhoneResponse(id: "pA", questionId: lecture.questions[0].id, answerText: "Answer",
                              marking: Marking(mark: 8, criteria: [], gaps: [])),
                PhoneResponse(id: "pB", questionId: lecture.questions[0].id, answerText: " "),
                PhoneResponse(id: "pC", questionId: lecture.questions[0].id, answerText: "For the computer"),
            ]
        )
        let records = sittingRecords(lectureId: lecture.id, snapshot: snapshot, outbox: [here])
        XCTAssertEqual(records.map(\.id), ["pHere", snapshot.sittings[0].id], "newest first")
        XCTAssertEqual(records[0].answers.map(\.status), [.marked, .marked, .waitingToSync])
        XCTAssertEqual(records[0].answers[1].mark, 0, "blank scores 0")
        XCTAssertNil(records[0].score, "not every answer is marked yet")
        XCTAssertEqual(records[1].score, 6.5)
        // Once the computer has it, it isn't listed twice.
        XCTAssertEqual(sittingRecords(lectureId: lecture.id, snapshot: snapshot, outbox: [PhoneSitting(
            id: snapshot.sittings[0].id, lectureId: lecture.id, startedAt: Date(), submittedAt: Date(), responses: [])]).count, 1)
    }
}
