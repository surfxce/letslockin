import Foundation

/// Days until the next sitting, by rung.
public let LADDER_DAYS = [1, 3, 7, 14, 30]

/// At or above this, climb a rung.
public let CLIMB_AT: Double = 7

/// Below this, drop back to the bottom. In between, hold the rung.
public let RESET_BELOW: Double = 5

public struct Sitting: Equatable, Sendable {
    public var at: Date
    /// Geometric mean of the sitting, 0-10.
    public var score: Double

    public init(at: Date, score: Double) {
        self.at = at
        self.score = score
    }
}

public struct ScheduledReview: Equatable, Sendable {
    /// Start of the day it is due, or nil when there is nothing to sit yet.
    public var dueAt: Date?
    /// Rung on the ladder after the last sitting, 0-based.
    public var rung: Int
    public var intervalDays: Int?

    public init(dueAt: Date?, rung: Int, intervalDays: Int?) {
        self.dueAt = dueAt
        self.rung = rung
        self.intervalDays = intervalDays
    }
}

public enum DueState: String, Equatable, Sendable {
    case overdue
    case today
    case soon
    case later
    case none
}

public struct DueStatus: Equatable, Sendable {
    public var state: DueState
    public var days: Int?

    public init(state: DueState, days: Int?) {
        self.state = state
        self.days = days
    }
}

public func startOfDay(_ d: Date, calendar: Calendar = .gregorian) -> Date {
    calendar.startOfDay(for: d)
}

public func addDays(_ d: Date, _ days: Int, calendar: Calendar = .gregorian) -> Date {
    calendar.date(byAdding: .day, value: days, to: d) ?? d.addingTimeInterval(Double(days) * 86_400)
}

public func rungAfter(rung: Int, score: Double) -> Int {
    if score >= CLIMB_AT { return min(rung + 1, LADDER_DAYS.count - 1) }
    if score < RESET_BELOW { return 0 }
    return rung
}

public func nextReview(
    sittings: [Sitting],
    readySince: Date?,
    examDate: Date? = nil,
    calendar: Calendar = .gregorian
) -> ScheduledReview {
    let sorted = sittings.sorted { $0.at < $1.at }

    if sorted.isEmpty {
        guard let readySince else {
            return ScheduledReview(dueAt: nil, rung: 0, intervalDays: nil)
        }
        return ScheduledReview(
            dueAt: addDays(startOfDay(readySince, calendar: calendar), 1, calendar: calendar),
            rung: 0,
            intervalDays: 1
        )
    }

    var rung = 0
    for s in sorted {
        rung = rungAfter(rung: rung, score: s.score)
    }

    let last = sorted[sorted.count - 1]
    let interval = LADDER_DAYS[rung]
    var dueAt = addDays(startOfDay(last.at, calendar: calendar), interval, calendar: calendar)

    if let examDate {
        let eve = addDays(startOfDay(examDate, calendar: calendar), -1, calendar: calendar)
        if eve > startOfDay(last.at, calendar: calendar) && dueAt > eve {
            dueAt = eve
        }
    }
    return ScheduledReview(dueAt: dueAt, rung: rung, intervalDays: interval)
}

/// For display: how a due date sits relative to today. "soon" is within three days.
public func dueState(dueAt: Date?, now: Date = Date(), calendar: Calendar = .gregorian) -> DueStatus {
    guard let dueAt else { return DueStatus(state: .none, days: nil) }
    let dueStart = startOfDay(dueAt, calendar: calendar)
    let nowStart = startOfDay(now, calendar: calendar)
    let days = Int(((dueStart.timeIntervalSince(nowStart)) / 86_400.0).rounded())
    if days < 0 { return DueStatus(state: .overdue, days: days) }
    if days == 0 { return DueStatus(state: .today, days: 0) }
    if days <= 3 { return DueStatus(state: .soon, days: days) }
    return DueStatus(state: .later, days: days)
}
