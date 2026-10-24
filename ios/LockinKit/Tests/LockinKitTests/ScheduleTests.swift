import XCTest
@testable import LockinKit

/// The cases in lib/flashcards/schedule.test.ts, so both ends schedule a card alike.
final class ScheduleTests: XCTestCase {
    let now = LockinJSON.parseDate("2026-10-20T12:00:00Z")!

    func schedule(state: String = "new", interval: Double = 0, ease: Double = 2.5, reps: Int = 0, lapses: Int = 0,
                  _ rating: Rating) -> ScheduledCard {
        scheduleCard(state: state, intervalDays: interval, ease: ease, repetitions: reps, lapses: lapses, rating: rating, now: now)
    }

    func testRelearnsAMissedCardInOneMinuteAndPartialRecallInFive() {
        XCTAssertEqual(schedule(.missed).dueAt.timeIntervalSince(now), 60, accuracy: 0.001)
        XCTAssertEqual(schedule(.little).dueAt.timeIntervalSince(now), 300, accuracy: 0.001)
    }

    func testGraduatesGoodAndEasyNewCardsToOneAndFourDays() {
        let good = schedule(.bit)
        XCTAssertEqual(good.state, "review")
        XCTAssertEqual(good.intervalDays, 1)
        XCTAssertEqual(good.repetitions, 1)
        XCTAssertEqual(schedule(.gotIt).intervalDays, 4)
    }

    func testIncreasesIntervalsInRatingOrderForEstablishedCards() {
        XCTAssertEqual([Rating.little, .bit, .gotIt].map { schedule(state: "review", interval: 10, reps: 5, $0).intervalDays }, [12, 25, 34])
        let missed = schedule(state: "review", interval: 10, reps: 5, .missed)
        XCTAssertEqual(missed.state, "learning")
        XCTAssertEqual(missed.lapses, 1)
        XCTAssertEqual(missed.ease, 2.3)
    }

    func testRepeatedFailuresStopAtTheLowestEaseAndCountOneLapse() {
        var card = ScheduledCard(state: "review", intervalDays: 10, ease: 2.5, repetitions: 0, lapses: 0, dueAt: now)
        for _ in 0..<30 {
            card = scheduleCard(state: card.state, intervalDays: card.intervalDays, ease: card.ease, repetitions: card.repetitions,
                                lapses: card.lapses, rating: .missed, now: now)
        }
        XCTAssertEqual(card.ease, 1.3)
        XCTAssertEqual(card.lapses, 1)
        XCTAssertEqual(scheduleCard(state: card.state, intervalDays: card.intervalDays, ease: card.ease, repetitions: card.repetitions,
                                    lapses: card.lapses, rating: .bit, now: now).intervalDays, 1)
    }

    func testBoundsIntervalsAndLabelsThem() {
        XCTAssertEqual(schedule(state: "review", interval: 3000, .gotIt).intervalDays, 3650)
        XCTAssertEqual(intervalLabel(1.0 / 1440), "1 min")
        XCTAssertEqual(intervalLabel(4), "4 days")
        XCTAssertEqual(intervalLabel(1), "1 day")
    }

    func testDueOrderAndReviewing() throws {
        let snapshot = try LockinJSON.decoder().decode(Snapshot.self, from: try Fixture.data("snapshot"))
        var cards = snapshot.cards
        let template = cards[0]
        var seen = template
        seen.id = "seen"
        seen.state = "review"
        seen.dueAt = now.addingTimeInterval(-10)
        var later = template
        later.id = "later"
        later.dueAt = now.addingTimeInterval(3600)
        cards += [seen, later]
        XCTAssertEqual(dueCards(cards, now: now).map(\.id), ["seen", template.id], "seen cards first, then new")
        XCTAssertEqual(nextDue(cards, now: now), later.dueAt)

        let (after, review) = template.reviewed(.bit, now: now)
        XCTAssertEqual(after.version, template.version + 1)
        XCTAssertEqual(review.version, template.version, "the review names the version it was made on")
        XCTAssertEqual(review.rating, 3)
        XCTAssertFalse(after.isDue(at: now))
    }
}
