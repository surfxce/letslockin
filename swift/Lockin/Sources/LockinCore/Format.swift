import Foundation

public enum Tone: String, CaseIterable, Codable, Sendable {
    case gray
    case brown
    case orange
    case yellow
    case green
    case blue
    case purple
    case pink
    case red
}

private let shortDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
private let longDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
private let shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
private let tagTones: [Tone] = [.blue, .purple, .pink, .brown, .gray]

/// "Tue 3 Mar", with the year only when it is not this year.
public func shortDate(_ date: Date, now: Date = Date(), calendar: Calendar = .gregorian) -> String {
    let comps = calendar.dateComponents([.year, .month, .day, .weekday], from: date)
    let nowYear = calendar.component(.year, from: now)
    let weekdayIndex = max(0, min(6, (comps.weekday ?? 1) - 1))
    let monthIndex = max(0, min(11, (comps.month ?? 1) - 1))
    let day = comps.day ?? 1
    let year = comps.year ?? nowYear
    let yearSuffix = year == nowYear ? "" : " \(year)"
    return "\(shortDays[weekdayIndex]) \(day) \(shortMonths[monthIndex])\(yearSuffix)"
}

/// "Tuesday 3 Mar 2026" style, for page headers.
public func longDate(_ date: Date, calendar: Calendar = .gregorian) -> String {
    let comps = calendar.dateComponents([.year, .month, .day, .weekday], from: date)
    let weekdayIndex = max(0, min(6, (comps.weekday ?? 1) - 1))
    let monthIndex = max(0, min(11, (comps.month ?? 1) - 1))
    let day = comps.day ?? 1
    let year = comps.year ?? 2026
    return "\(longDays[weekdayIndex]) \(day) \(shortMonths[monthIndex]) \(year)"
}

public func clockTime(_ date: Date, calendar: Calendar = .gregorian) -> String {
    let comps = calendar.dateComponents([.hour, .minute], from: date)
    let h = comps.hour ?? 0
    let m = comps.minute ?? 0
    let hour12 = ((h + 11) % 12) + 1
    let suffix = h < 12 ? "am" : "pm"
    return String(format: "%d:%02d%@", hour12, m, suffix)
}

/// YYYY-MM-DD in local time.
public func dateInput(_ date: Date, calendar: Calendar = .gregorian) -> String {
    let comps = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", comps.year ?? 2026, comps.month ?? 1, comps.day ?? 1)
}

/// Parses YYYY-MM-DD as local midnight, not UTC — "3 March" stays 3 March.
public func fromDateInput(_ value: String, calendar: Calendar = .gregorian) -> Date? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let match = trimmed.firstMatch(of: #/\A(\d{4})-(\d{2})-(\d{2})\z/#),
          let year = Int(match.1),
          let month = Int(match.2),
          let day = Int(match.3) else {
        return nil
    }
    var comps = DateComponents()
    comps.year = year
    comps.month = month
    comps.day = day
    comps.hour = 0
    comps.minute = 0
    comps.second = 0
    return calendar.date(from: comps)
}

/// "42s", "3m 05s", "1h 02m".
public func duration(_ ms: Int) -> String {
    let s = max(0, Int((Double(ms) / 1000.0).rounded()))
    if s < 60 { return "\(s)s" }
    let m = s / 60
    if m < 60 { return String(format: "%dm %02ds", m, s % 60) }
    return String(format: "%dh %02dm", m / 60, m % 60)
}

/// Whole days from now until a date, rounded up — "exam in 12 days".
public func daysUntil(_ date: Date, now: Date = Date()) -> Int {
    Int(ceil((date.timeIntervalSince1970 - now.timeIntervalSince1970) / 86_400.0))
}

public func formatHours(_ h: Double) -> String {
    if h == 1 { return "1 hour" }
    let formatted = h.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(h)) : String(h)
    return "\(formatted) hours"
}

public func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String {
    "\(n) \(n == 1 ? one : (many ?? "\(one)s"))"
}

/// Scores are out of ten; colour carries the meaning before the number is read.
public func scoreTone(_ score: Double?) -> Tone {
    guard let score else { return .gray }
    if score < 4 { return .red }
    if score < 6 { return .orange }
    if score < 8 { return .yellow }
    return .green
}

public func formatScore(_ score: Double) -> String {
    String(format: "%.1f", score)
}

public struct DueLabel: Equatable, Sendable {
    public var text: String
    public var tone: Tone

    public init(text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }
}

/// When the next sitting is due, in words, with a colour for urgency.
public func dueLabel(_ dueAt: Date?, now: Date = Date(), calendar: Calendar = .gregorian) -> DueLabel {
    guard let dueAt else { return DueLabel(text: "—", tone: .gray) }
    let dueStart = calendar.startOfDay(for: dueAt)
    let nowStart = calendar.startOfDay(for: now)
    let days = Int(((dueStart.timeIntervalSince1970 - nowStart.timeIntervalSince1970) / 86_400.0).rounded())
    if days < 0 {
        return DueLabel(text: days == -1 ? "Overdue 1 day" : "Overdue \(-days) days", tone: .red)
    }
    if days == 0 {
        return DueLabel(text: "Today", tone: .orange)
    }
    if days == 1 {
        return DueLabel(text: "Tomorrow", tone: .yellow)
    }
    if days < 7 {
        return DueLabel(text: "In \(days) days", tone: .gray)
    }
    return DueLabel(text: shortDate(dueAt, now: now, calendar: calendar), tone: .gray)
}

/// A stable colour for a module or course name, the way a Notion select gets one.
public func tagTone(_ name: String) -> Tone {
    var h: UInt32 = 0
    for scalar in name.unicodeScalars {
        let codeUnit = String(scalar).utf16.first ?? 0
        h = h &* 31 &+ UInt32(codeUnit)
    }
    return tagTones[Int(h % UInt32(tagTones.count))]
}
