import Foundation

/// AK's four-grade, SM-2-style scheduler — lib/flashcards/schedule.ts, kept identical so
/// a card reviewed on the phone is due when the computer would say.
public enum Rating: Int, CaseIterable, Identifiable, Sendable {
    case missed = 1
    case little = 2
    case bit = 3
    case gotIt = 4

    public var id: Int { rawValue }

    public var label: String {
        switch self {
        case .missed: return "Didn't get this"
        case .little: return "Got this a little"
        case .bit: return "Got this a bit"
        case .gotIt: return "Got it"
        }
    }
}

public struct ScheduledCard: Equatable, Sendable {
    public var state: String
    public var intervalDays: Double
    public var ease: Double
    public var repetitions: Int
    public var lapses: Int
    public var dueAt: Date
}

private let day: TimeInterval = 86_400

public func scheduleCard(state: String, intervalDays: Double, ease: Double, repetitions: Int, lapses: Int,
                         rating: Rating, now: Date = Date()) -> ScheduledCard {
    let learning = state != "review"
    let change: Double
    switch rating {
    case .missed: change = -0.2
    case .little: change = -0.15
    case .gotIt: change = 0.15
    case .bit: change = 0
    }
    let newEase = max(1.3, min(3, ease + change))
    var newInterval: Double
    let newState: String
    if rating == .missed || (learning && rating == .little) {
        newInterval = (rating == .missed ? 1 : 5) / 1440
        newState = "learning"
    } else {
        let previous = max(1, intervalDays)
        if learning {
            newInterval = rating == .gotIt ? 4 : 1
        } else {
            let factor = rating == .little ? 1.2 : rating == .gotIt ? newEase * 1.3 : newEase
            newInterval = max(previous + 1, (previous * factor).rounded())
        }
        newInterval = min(3650, newInterval)
        newState = "review"
    }
    return ScheduledCard(
        state: newState,
        intervalDays: newInterval,
        ease: newEase,
        repetitions: repetitions + 1,
        lapses: lapses + (rating == .missed && state == "review" ? 1 : 0),
        dueAt: now.addingTimeInterval(newInterval * day)
    )
}

/// "1 min", "5 min", "1 day", "4 days".
public func intervalLabel(_ days: Double) -> String {
    if days < 1 { return "\(Int((days * 1440).rounded())) min" }
    return "\(Int(days.rounded())) \(days == 1 ? "day" : "days")"
}

extension Card {
    public func scheduled(_ rating: Rating, now: Date = Date()) -> ScheduledCard {
        scheduleCard(state: state, intervalDays: intervalDays, ease: ease, repetitions: repetitions, lapses: lapses,
                     rating: rating, now: now)
    }

    /// The card after a review on the phone, and the review to send to the computer.
    public func reviewed(_ rating: Rating, now: Date = Date()) -> (card: Card, review: CardReview) {
        let next = scheduled(rating, now: now)
        var card = self
        card.state = next.state
        card.intervalDays = next.intervalDays
        card.ease = next.ease
        card.repetitions = next.repetitions
        card.lapses = next.lapses
        card.dueAt = next.dueAt
        card.version = version + 1
        let review = CardReview(id: LockinID.make(prefix: "v"), cardId: id, version: version, rating: rating.rawValue, reviewedAt: now)
        return (card, review)
    }

    public func isDue(at now: Date = Date()) -> Bool { dueAt <= now }
}

/// The order the computer's AK review uses (app/ak/actions.ts, nextCard): cards already
/// seen that are due, soonest first, then new ones in the order they were made.
public func dueCards(_ cards: [Card], now: Date = Date()) -> [Card] {
    let due = cards.filter { $0.isDue(at: now) }
    let seen = due.filter { $0.state != "new" }.sorted { ($0.dueAt, $0.id) < ($1.dueAt, $1.id) }
    let fresh = due.filter { $0.state == "new" }.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    return seen + fresh
}

/// When the next card that isn't due yet will be.
public func nextDue(_ cards: [Card], now: Date = Date()) -> Date? {
    cards.filter { $0.dueAt > now }.map(\.dueAt).min()
}
