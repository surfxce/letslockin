import XCTest
@testable import LockinCore

final class GeometricMeanTests: XCTestCase {
    func testReturnsTheMarkItselfForASingleQuestion() throws {
        XCTAssertEqual(try geometricMean([7]), 7)
    }

    func testMatchesHandComputedSquareRootForTwoQuestions() throws {
        XCTAssertEqual(try geometricMean([4, 9]), (4.0 * 9.0).squareRoot())
        XCTAssertEqual(try geometricMean([4, 9]), 6)
    }

    func testCubeRootsThreeQuestions() throws {
        XCTAssertEqual(roundMark(try geometricMean([2, 4, 8])), 4)
    }

    func testPunishesAnUnevenPairHarderThanArithmeticMean() throws {
        // The case the whole system exists for: 0 and 10 averages to 5 but is worth 0.
        XCTAssertEqual(try geometricMean([0, 10]), 0)
        XCTAssertEqual(try geometricMean([4, 4]), 4)
        XCTAssertLessThan(try geometricMean([1, 9]), 5)
    }

    func testRejectsEmptyAndNegativeInput() {
        XCTAssertThrowsError(try geometricMean([]))
        XCTAssertThrowsError(try geometricMean([-1, 5]))
        XCTAssertThrowsError(try geometricMean([.nan]))
        XCTAssertThrowsError(try geometricMean([.infinity]))
    }
}
