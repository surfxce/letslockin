import Foundation
import XCTest
@testable import LockinCore

final class FormatTests: XCTestCase {
    private var cal: Calendar { .gregorian }

    private func makeDate(_ y: Int, _ m: Int, _ d: Int, hour: Int = 12, minute: Int = 0) -> Date {
        var comps = DateComponents()
        comps.year = y
        comps.month = m
        comps.day = d
        comps.hour = hour
        comps.minute = minute
        return cal.date(from: comps)!
    }

    func testShortLongClockAndDateInput() {
        let now = makeDate(2026, 3, 10)
        let sameYear = makeDate(2026, 3, 3, hour: 9, minute: 5)
        let otherYear = makeDate(2025, 11, 15, hour: 14, minute: 30)

        XCTAssertEqual(shortDate(sameYear, now: now, calendar: cal), "Tue 3 Mar")
        XCTAssertEqual(shortDate(otherYear, now: now, calendar: cal), "Sat 15 Nov 2025")
        XCTAssertEqual(longDate(sameYear, calendar: cal), "Tuesday 3 Mar 2026")
        XCTAssertEqual(clockTime(sameYear, calendar: cal), "9:05am")
        XCTAssertEqual(clockTime(otherYear, calendar: cal), "2:30pm")
        XCTAssertEqual(dateInput(sameYear, calendar: cal), "2026-03-03")

        let parsed = try! XCTUnwrap(fromDateInput("2026-03-03", calendar: cal))
        XCTAssertEqual(dateInput(parsed, calendar: cal), "2026-03-03")
        XCTAssertNil(fromDateInput("not-a-date", calendar: cal))
    }

    func testDurationHoursPluralAndScores() {
        XCTAssertEqual(duration(42_000), "42s")
        XCTAssertEqual(duration(185_000), "3m 05s")
        XCTAssertEqual(duration(3_720_000), "1h 02m")

        XCTAssertEqual(formatHours(1), "1 hour")
        XCTAssertEqual(formatHours(2), "2 hours")
        XCTAssertEqual(formatHours(1.5), "1.5 hours")

        XCTAssertEqual(plural(1, "lecture"), "1 lecture")
        XCTAssertEqual(plural(3, "lecture"), "3 lectures")

        XCTAssertEqual(scoreTone(nil), .gray)
        XCTAssertEqual(scoreTone(3.9), .red)
        XCTAssertEqual(scoreTone(5.5), .orange)
        XCTAssertEqual(scoreTone(7.2), .yellow)
        XCTAssertEqual(scoreTone(8.0), .green)
        XCTAssertEqual(formatScore(7), "7.0")
    }

    func testDueLabelAndTagTone() {
        let now = makeDate(2026, 3, 10)
        XCTAssertEqual(dueLabel(nil, now: now, calendar: cal), DueLabel(text: "—", tone: .gray))
        XCTAssertEqual(dueLabel(makeDate(2026, 3, 9), now: now, calendar: cal), DueLabel(text: "Overdue 1 day", tone: .red))
        XCTAssertEqual(dueLabel(makeDate(2026, 3, 7), now: now, calendar: cal), DueLabel(text: "Overdue 3 days", tone: .red))
        XCTAssertEqual(dueLabel(makeDate(2026, 3, 10), now: now, calendar: cal), DueLabel(text: "Today", tone: .orange))
        XCTAssertEqual(dueLabel(makeDate(2026, 3, 11), now: now, calendar: cal), DueLabel(text: "Tomorrow", tone: .yellow))
        XCTAssertEqual(dueLabel(makeDate(2026, 3, 14), now: now, calendar: cal), DueLabel(text: "In 4 days", tone: .gray))
        XCTAssertEqual(dueLabel(makeDate(2026, 3, 24), now: now, calendar: cal), DueLabel(text: "Tue 24 Mar", tone: .gray))

        let tone = tagTone("BIOL3010")
        XCTAssertTrue([Tone.blue, .purple, .pink, .brown, .gray].contains(tone))
        XCTAssertEqual(tagTone("BIOL3010"), tone)
    }
}
