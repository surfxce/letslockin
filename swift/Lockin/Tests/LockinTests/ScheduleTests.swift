import Foundation
import XCTest
@testable import LockinCore

final class ScheduleTests: XCTestCase {
    private func day(_ d: Int, _ h: Int = 15) -> Date {
        var comps = DateComponents()
        comps.year = 2026
        comps.month = 3
        comps.day = d
        comps.hour = h
        comps.minute = 0
        comps.second = 0
        return Calendar.current.date(from: comps)!
    }

    private func midnight(_ d: Int) -> Date {
        day(d, 0)
    }

    func testRungAfterClimbsHoldsAndResets() {
        XCTAssertEqual(rungAfter(rung: 1, score: 8), 2)
        XCTAssertEqual(rungAfter(rung: 2, score: 6), 2)
        XCTAssertEqual(rungAfter(rung: 3, score: 4.9), 0)
        XCTAssertEqual(rungAfter(rung: 4, score: 10), 4)
    }

    func testNextReviewHasNothingDueBeforeThereAreLaqsToSit() {
        XCTAssertNil(nextReview(sittings: [], readySince: nil).dueAt)
    }

    func testNextReviewAsksForFirstSittingTheDayAfterLaqsAreReady() {
        XCTAssertEqual(nextReview(sittings: [], readySince: day(3)).dueAt, midnight(4))
    }

    func testNextReviewSpacesReviewsOutAsScoresHoldUp() {
        let a = nextReview(sittings: [Sitting(at: day(1), score: 8)], readySince: day(1))
        XCTAssertEqual(a.dueAt, midnight(4))
        let b = nextReview(
            sittings: [
                Sitting(at: day(1), score: 8),
                Sitting(at: day(4), score: 9),
            ],
            readySince: day(1)
        )
        XCTAssertEqual(b.intervalDays, 7)
        XCTAssertEqual(b.dueAt, midnight(11))
    }

    func testNextReviewBringsWeakLectureBackTomorrow() {
        let r = nextReview(
            sittings: [
                Sitting(at: day(1), score: 9),
                Sitting(at: day(4), score: 9),
                Sitting(at: day(11), score: 3),
            ],
            readySince: day(1)
        )
        XCTAssertEqual(r.dueAt, midnight(12))
    }

    func testNextReviewOrdersSittingsByDateRatherThanInputOrder() {
        let r = nextReview(
            sittings: [
                Sitting(at: day(11), score: 3),
                Sitting(at: day(1), score: 9),
            ],
            readySince: day(1)
        )
        XCTAssertEqual(r.rung, 0)
    }

    func testNextReviewPullsReviewForwardToDayBeforeExam() {
        let r = nextReview(
            sittings: [
                Sitting(at: day(1), score: 9),
                Sitting(at: day(4), score: 9),
                Sitting(at: day(11), score: 9),
            ],
            readySince: day(1),
            examDate: day(15, 9)
        )
        XCTAssertEqual(r.dueAt, midnight(14))
    }

    func testDueStateLabelsDueDateAgainstToday() {
        let now = day(10, 9)
        XCTAssertEqual(dueState(dueAt: midnight(8), now: now), DueStatus(state: .overdue, days: -2))
        XCTAssertEqual(dueState(dueAt: midnight(10), now: now), DueStatus(state: .today, days: 0))
        XCTAssertEqual(dueState(dueAt: midnight(12), now: now), DueStatus(state: .soon, days: 2))
        XCTAssertEqual(dueState(dueAt: midnight(20), now: now), DueStatus(state: .later, days: 10))
        XCTAssertEqual(dueState(dueAt: nil, now: now), DueStatus(state: .none, days: nil))
    }
}
