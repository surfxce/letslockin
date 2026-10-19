import Foundation
import GRDB
import XCTest
@testable import LockinCore

final class RemindersTests: XCTestCase {
    private func day(_ d: Int, _ h: Int = 15) -> Date {
        var comps = DateComponents()
        comps.year = 2026
        comps.month = 3
        comps.day = d
        comps.hour = h
        return Calendar.gregorian.date(from: comps)!
    }

    private func due(_ id: String, _ title: String = "The lac operon", _ code: String = "BIOL3010") -> DueLecture {
        DueLecture(lectureId: id, title: title, courseCode: code)
    }

    // MARK: - Quiet hours

    func testRemindersAreQuietAtNight() {
        XCTAssertFalse(reminderHourAllowed(hour: 7))
        XCTAssertTrue(reminderHourAllowed(hour: 8))
        XCTAssertTrue(reminderHourAllowed(hour: 21))
        XCTAssertFalse(reminderHourAllowed(hour: 22))
        XCTAssertFalse(reminderHourAllowed(hour: 3))
    }

    // MARK: - Which lectures get their notification

    func testNothingIsAnnouncedWhenRemindersAreOff() {
        let fresh = lecturesToAnnounce(due: [due("l1")], announced: [:], notify: false, now: day(5, 10))
        XCTAssertEqual(fresh, [])
    }

    func testNothingIsAnnouncedInQuietHours() {
        let fresh = lecturesToAnnounce(due: [due("l1")], announced: [:], notify: true, now: day(5, 23))
        XCTAssertEqual(fresh, [])
        let morning = lecturesToAnnounce(due: [due("l1")], announced: [:], notify: true, now: day(6, 8))
        XCTAssertEqual(morning.map(\.lectureId), ["l1"], "the lecture waits for the morning and is not lost")
    }

    func testEachLectureNagsOnceADayAtMost() {
        let morning = day(5, 9)
        let fresh = lecturesToAnnounce(due: [due("l1"), due("l2")], announced: [:], notify: true, now: morning)
        XCTAssertEqual(fresh.map(\.lectureId), ["l1", "l2"])

        // Same day, still due: no second notification.
        let again = lecturesToAnnounce(due: [due("l1"), due("l2")], announced: announcedAfter([:], fresh: fresh, now: morning), notify: true, now: day(5, 14))
        XCTAssertEqual(again, [])

        // The next day it may nag again.
        let tomorrow = lecturesToAnnounce(due: [due("l1"), due("l2")], announced: ["l1": reminderDayKey(morning), "l2": reminderDayKey(morning)], notify: true, now: day(6, 9))
        XCTAssertEqual(tomorrow.map(\.lectureId), ["l1", "l2"])

        // A different lecture due the same day still gets its turn.
        let otherToday = lecturesToAnnounce(due: [due("l3")], announced: ["l1": reminderDayKey(morning)], notify: true, now: morning)
        XCTAssertEqual(otherToday.map(\.lectureId), ["l3"])
    }

    func testTheDayKeySeparatesDaysInTheSameCalendar() {
        XCTAssertNotEqual(reminderDayKey(day(5)), reminderDayKey(day(6)))
        XCTAssertEqual(reminderDayKey(day(5, 9)), reminderDayKey(day(5, 21)), "the hour does not matter")
    }

    // MARK: - What a notification says

    func testOneLectureIsAskedForByNameAndSeveralListThreeTitles() {
        let one = reminderContent([due("l1", "The lac operon", "BIOL3010")])
        XCTAssertEqual(one.title, "Time to redo your LAQs")
        XCTAssertEqual(one.body, "BIOL3010 · The lac operon")

        let many = reminderContent([
            due("l1", "First"), due("l2", "Second"), due("l3", "Third"), due("l4", "Fourth"),
        ])
        XCTAssertEqual(many.title, "4 lectures are due for LAQs")
        XCTAssertEqual(many.body, "First · Second · Third", "only three titles fit in a banner")
    }

    // MARK: - The badge

    func testTheBadgeCountsDueLecturesWhetherOrNotNotificationsAreOn() {
        XCTAssertEqual(reminderBadgeCount(due: []), 0)
        XCTAssertEqual(reminderBadgeCount(due: [due("l1"), due("l2")]), 2)
    }

    // MARK: - From the database

    func testDueForRemindersComesFromTheReviewSchedule() throws {
        let db = try LockinDatabase.inMemory()
        let base = day(1)
        try db.writer.write { conn in
            var course = Course(id: "c1", code: "BIOL3010", title: "Genetics", createdAt: base)
            try course.insert(conn)

            // Due: it has LAQs and its last sitting left it due before now.
            var dueLecture = Lecture(id: "l1", courseId: "c1", moduleId: nil, title: "Lac operon", deliveredOn: base, durationHours: 1, summaryMd: "# Summary", createdAt: base)
            try dueLecture.insert(conn)
            var question = Question(id: "q1", lectureId: "l1", stem: "Explain lacZ.", type: .laq, rubric: "{}", promptVersion: "1.0.0", model: nil, createdAt: base)
            try question.insert(conn)
            var attempt = Attempt(id: "a1", lectureId: "l1", sittingDate: base, closedBook: true, geometricMean: 4, completedAt: base, source: .app)
            try attempt.insert(conn)

            // Practised well: not due for weeks.
            var healthy = Lecture(id: "l2", courseId: "c1", moduleId: nil, title: "Trp operon", deliveredOn: base, durationHours: 1, summaryMd: "# Summary", createdAt: base)
            try healthy.insert(conn)
            var q2 = Question(id: "q2", lectureId: "l2", stem: "Explain trpR.", type: .laq, rubric: "{}", promptVersion: "1.0.0", model: nil, createdAt: base)
            try q2.insert(conn)
            var a2 = Attempt(id: "a2", lectureId: "l2", sittingDate: base, closedBook: true, geometricMean: 9, completedAt: base, source: .app)
            try a2.insert(conn)

            // Not practised at all: nothing to come back for yet.
            var fresh = Lecture(id: "l3", courseId: "c1", moduleId: nil, title: "Mutation", deliveredOn: base, durationHours: 1, summaryMd: "# Summary", createdAt: base)
            try fresh.insert(conn)
        }
        // day(1) + 1 day rungs: l1 (score 4) is due tomorrow, l2 (score 9) in three days.
        // The reminder set is "due today or overdue", so only what is due by now shows;
        // with now at the same day, the rung arithmetic decides — l1 is not due yet on
        // its own day, so ask for the day after.
        let later = day(3)
        let rows = try dueForReminders(database: db, now: later)
        XCTAssertEqual(rows.map(\.lectureId), ["l1"], "the weak lecture is due, the strong one is not, the new one waits for its first sitting")
        XCTAssertEqual(rows[0].courseCode, "BIOL3010")
    }
}
