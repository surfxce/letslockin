import XCTest
@testable import LockinKit

final class LectureOrderTests: XCTestCase {
    private func lectures() throws -> [Lecture] {
        let template = try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot")).lectures[0]
        return (1...5).map { n in
            var lecture = template
            lecture.id = "L\(n)"
            lecture.ordinal = n
            return lecture
        }
    }

    private let standings: [String: LectureStanding] = [
        "L1": LectureStanding(score: 7.5, drills: 3),
        "L2": LectureStanding(score: nil, drills: 0),
        "L3": LectureStanding(score: 4.2, drills: 1),
        "L4": LectureStanding(score: 7.5, drills: 3),
        "L5": LectureStanding(score: nil, drills: 2),
    ]

    private func order(_ order: LectureOrder) throws -> [String] {
        sortLectures(try lectures(), by: order) { self.standings[$0.id]! }.map(\.id)
    }

    func testByLectureNumber() throws {
        XCTAssertEqual(try order(.newest), ["L5", "L4", "L3", "L2", "L1"])
        XCTAssertEqual(try order(.oldest), ["L1", "L2", "L3", "L4", "L5"])
    }

    func testByScoreWithUnscoredLast() throws {
        XCTAssertEqual(try order(.weakest), ["L3", "L1", "L4", "L2", "L5"])
        XCTAssertEqual(try order(.strongest), ["L1", "L4", "L3", "L2", "L5"])
    }

    func testByDrills() throws {
        XCTAssertEqual(try order(.mostDrilled), ["L1", "L4", "L5", "L3", "L2"])
        XCTAssertEqual(try order(.leastDrilled), ["L2", "L3", "L5", "L1", "L4"])
    }

    func testReadsTheComputersStanding() throws {
        let lecture = try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot")).lectures[0]
        XCTAssertEqual(lecture.drillScore, 6.5)
        XCTAssertEqual(lecture.sittingCount, 1)
        XCTAssertNotNil(lecture.dueAt)
    }
}
