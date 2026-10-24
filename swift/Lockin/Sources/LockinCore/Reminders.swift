import Foundation
import GRDB

// Port of electron/main.ts's checkReminders: the dock badge is the quiet reminder, and a
// notification goes out for each lecture due for LAQs — one a day per lecture, never
// between 10pm and 8am. The decisions live here so they can be tested; the app target
// carries the UserNotifications side and the dock tile.

/// A lecture due for LAQs, as a reminder names it.
public struct DueLecture: Equatable, Sendable, Identifiable {
    public var lectureId: String
    public var title: String
    public var courseCode: String

    public var id: String { lectureId }

    public init(lectureId: String, title: String, courseCode: String) {
        self.lectureId = lectureId
        self.title = title
        self.courseCode = courseCode
    }

    /// From a library row (`/api/status`'s `due`).
    public init(row: LectureRow) {
        self.init(lectureId: row.id, title: row.title, courseCode: row.courseCode)
    }
}

/// The lectures due for LAQs right now (`dueLectures`, named for the reminder).
public func dueForReminders(db: Database, now: Date = Date()) throws -> [DueLecture] {
    try LockinCore.dueLectures(db: db, now: now).map(DueLecture.init(row:))
}

public func dueForReminders(database: LockinDatabase, now: Date = Date()) throws -> [DueLecture] {
    try database.reader.read { db in
        try dueForReminders(db: db, now: now)
    }
}

/// What a notification says (`checkReminders`): one lecture is asked for by name, several
/// list up to three of their titles.
public struct ReminderContent: Equatable, Sendable {
    public var title: String
    public var body: String
}

public func reminderContent(_ fresh: [DueLecture]) -> ReminderContent {
    if fresh.count == 1, let one = fresh.first {
        return ReminderContent(title: "Time to redo your LAQs", body: "\(one.courseCode) · \(one.title)")
    }
    return ReminderContent(
        title: "\(fresh.count) lectures are due for LAQs",
        body: fresh.prefix(3).map(\.title).joined(separator: " · ")
    )
}

/// Reminders are quiet at night (`checkReminders`'s hour check): 8am to 10pm only.
public func reminderHourAllowed(hour: Int) -> Bool {
    hour >= 8 && hour < 22
}

/// The day key a lecture was last announced on (`new Date().toDateString()`): whatever
/// separates one day from the next does — the calendar's own year, month and day.
public func reminderDayKey(_ date: Date, calendar: Calendar = .current) -> String {
    let c = calendar.dateComponents([.year, .month, .day], from: date)
    return "\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
}

/// Which of the due lectures get their notification this round: reminders on, within the
/// quiet hours, and each lecture once a day at most (`announced` maps lectureId to the
/// day key it was last announced on). Empty when nothing is due or it is not the hour.
public func lecturesToAnnounce(
    due: [DueLecture],
    announced: [String: String],
    notify: Bool,
    now: Date,
    calendar: Calendar = .current
) -> [DueLecture] {
    guard notify, reminderHourAllowed(hour: calendar.component(.hour, from: now)) else {
        return []
    }
    let today = reminderDayKey(now, calendar: calendar)
    return due.filter { announced[$0.lectureId] != today }
}

/// The dock badge is the quiet reminder: the number of due lectures, whether or not
/// notifications are on.
public func reminderBadgeCount(due: [DueLecture]) -> Int {
    due.count
}

/// After a round: the announced map with this round's lectures marked as announced today.
public func announcedAfter(
    _ announced: [String: String],
    fresh: [DueLecture],
    now: Date,
    calendar: Calendar = .current
) -> [String: String] {
    guard !fresh.isEmpty else { return announced }
    var next = announced
    let today = reminderDayKey(now, calendar: calendar)
    for lecture in fresh {
        next[lecture.lectureId] = today
    }
    return next
}
