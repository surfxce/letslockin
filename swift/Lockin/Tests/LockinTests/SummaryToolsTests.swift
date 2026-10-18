import Foundation
import GRDB
@testable import LockinCore
import XCTest

final class SummaryToolsTests: XCTestCase {
    // MARK: - Glossary (lib/glossary.test.ts)

    func testCleanTerm() {
        XCTAssertEqual(cleanTerm("  “mitochondrial   matrix”  "), "mitochondrial matrix")
        XCTAssertEqual(cleanTerm("(ATP synthase):"), "ATP synthase")
        XCTAssertEqual(cleanTerm("  ...   "), "")
        let long = String(repeating: "a", count: 350)
        XCTAssertEqual(cleanTerm(long).count, 300)
    }

    func testFindTermRanges() {
        let text = "The Na+/K+ pump moves Na+ and K+ across the cell membrane."
        let ranges = findTermRanges(text, terms: ["Na+", "Na+/K+ pump", "membrane"])
        // Longer term "Na+/K+ pump" wins over "Na+" at offset 4.
        XCTAssertEqual(
            ranges,
            [
                TermRange(start: 4, end: 15, index: 1),
                TermRange(start: 22, end: 25, index: 0),
                TermRange(start: 49, end: 57, index: 2),
            ]
        )
    }

    func testFindTermRangesRespectsWordBoundariesAndCase() {
        let text = "ATP and atpase and catp"
        let ranges = findTermRanges(text, terms: ["atp"])
        XCTAssertEqual(ranges, [TermRange(start: 0, end: 3, index: 0)])
    }

    // MARK: - Left Out (lib/left-out.test.ts)

    func testLeftOutActionHintAndButton() {
        let canAskCtx = LeftOutContext(canAsk: true)
        XCTAssertEqual(leftOutAction(about: nil, added: nil, ctx: canAskCtx), .ask)
        XCTAssertEqual(leftOutHint(.ask, ctx: canAskCtx), "Click to find out what it said")
        XCTAssertEqual(leftOutButton(.ask), "Find out what it said")

        XCTAssertEqual(leftOutAction(about: "Was on slide 9", added: false, ctx: canAskCtx), .add)
        XCTAssertEqual(leftOutHint(.add, ctx: canAskCtx), "Click to add it to your summary")
        XCTAssertEqual(leftOutButton(.add), "Add to summary")

        XCTAssertEqual(leftOutAction(about: "Was on slide 9", added: true, ctx: canAskCtx), .added)
        XCTAssertEqual(leftOutHint(.added, ctx: canAskCtx), "✓ In your summary")
        XCTAssertNil(leftOutButton(.added))

        let busyCtx = LeftOutContext(canAsk: true, busy: true)
        XCTAssertEqual(leftOutAction(about: "Was on slide 9", added: false, ctx: busyCtx), .busy)
        XCTAssertNil(leftOutHint(.busy, ctx: busyCtx))

        let noAICtx = LeftOutContext(canAsk: false)
        XCTAssertEqual(leftOutAction(about: nil, added: nil, ctx: noAICtx), .none)
        XCTAssertEqual(leftOutHint(.none, ctx: noAICtx), "Prepare this lecture again with AI to see what it said.")
    }

    func testPartLabelsAndKeys() {
        XCTAssertEqual(partLabel(what: "Welcome", where: "Slides 1–2"), "Welcome · Slides 1–2")
        XCTAssertEqual(partLabel(what: "Welcome", where: "  "), "Welcome")
        XCTAssertEqual(partsLabel(1), "1 part")
        XCTAssertEqual(partsLabel(3), "3 parts")

        let keys = partKeys([
            (what: "Housekeeping", where: "Slide 1"),
            (what: "Housekeeping", where: "Slide 1"),
            (what: "Housekeeping", where: "Slide 2"),
        ])
        XCTAssertEqual(keys.count, 3)
        XCTAssertNotEqual(keys[0], keys[1])
        XCTAssertNotEqual(keys[0], keys[2])
    }

    func testPlaceCard() {
        let viewport = CardSize(width: 800, height: 600)
        let size = CardSize(width: 240, height: 120)
        let below = placeCard(
            anchor: CardBox(top: 40, bottom: 68, left: 100, right: 200),
            size: size,
            viewport: viewport
        )
        XCTAssertEqual(below.side, .below)
        XCTAssertEqual(below.top, 74)
        XCTAssertEqual(below.left, 100)

        let above = placeCard(
            anchor: CardBox(top: 520, bottom: 548, left: 700, right: 780),
            size: size,
            viewport: viewport
        )
        XCTAssertEqual(above.side, .above)
        XCTAssertEqual(above.top, 394)
        XCTAssertEqual(above.left, 552)
    }

    // MARK: - Summary Tools (lib/summary-tools.test.ts)

    func testPlaceNear() {
        let viewport = CardSize(width: 800, height: 600)
        let size = CardSize(width: 200, height: 80)
        let p1 = placeNear(
            anchor: CardBox(top: 200, bottom: 220, left: 300, right: 400),
            size: size,
            viewport: viewport,
            prefer: .above
        )
        XCTAssertEqual(p1.side, .above)
        XCTAssertEqual(p1.top, 112)
        XCTAssertEqual(p1.left, 250)

        let p2 = placeNear(
            anchor: CardBox(top: 20, bottom: 40, left: 300, right: 400),
            size: size,
            viewport: viewport,
            prefer: .above
        )
        XCTAssertEqual(p2.side, .below)
        XCTAssertEqual(p2.top, 48)
    }

    func testSplitRangesAndTermPieces() {
        let pieces = termPieces(
            ["The ", "mitochondrial", " matrix and ", "ATP"],
            blocks: [0, 0, 0, 1],
            terms: ["mitochondrial matrix", "ATP"]
        )
        XCTAssertEqual(
            pieces,
            [
                TermPiece(node: 1, start: 0, end: 13, range: 0, term: 0),
                TermPiece(node: 2, start: 0, end: 7, range: 0, term: 0),
                TermPiece(node: 3, start: 0, end: 3, range: 1, term: 1),
            ]
        )
    }

    func testShortenAndPasteMemoryAndMergeGlossary() {
        XCTAssertEqual(oneLine("  hello \n\t world "), "hello world")
        XCTAssertEqual(shorten("short text", max: 20), "short text")
        let s = shorten("abcdefghijklmnopqrstuvwxyz", max: 11)
        XCTAssertEqual(s, "abcdefg…xyz")

        var pastes: [PastePair] = []
        pastes = rememberPaste(pastes, passage: "p1", text: "a1")
        pastes = rememberPaste(pastes, passage: "p2", text: "a2")
        pastes = rememberPaste(pastes, passage: "p1", text: "a1-updated")
        XCTAssertEqual(pastes, [PastePair("p1", "a1-updated"), PastePair("p2", "a2")])
        pastes = rememberPaste(pastes, passage: "p1", text: "")
        XCTAssertEqual(pastes, [PastePair("p2", "a2")])

        let parsed = readPastes(#"[["q1","r1"],["q2","r2"]]"#)
        XCTAssertEqual(parsed, [PastePair("q1", "r1"), PastePair("q2", "r2")])

        let merged = mergeGlossary(
            server: [
                GlossaryEntry(id: "1", term: "ATP", explanation: "Energy"),
                GlossaryEntry(id: "2", term: "NADH", explanation: "Carrier"),
            ],
            added: [
                GlossaryEntry(id: "3", term: "atp", explanation: "Dup"),
                GlossaryEntry(id: "4", term: "FADH2", explanation: "Carrier 2"),
            ],
            removed: ["2"]
        )
        XCTAssertEqual(
            merged,
            [
                GlossaryEntry(id: "1", term: "ATP", explanation: "Energy"),
                GlossaryEntry(id: "4", term: "FADH2", explanation: "Carrier 2"),
            ]
        )
    }

    // MARK: - Editor Text & Drafts (app/ui/editor/text.test.ts)

    func testLineKindAt() {
        let md = "## Heading\n### Sub\nPlain\n- Level 1\n  - Level 2\n    - Level 3\n1. Numbered"
        XCTAssertEqual(lineKindAt(md, pos: 2), .h2)
        XCTAssertEqual(lineKindAt(md, pos: 12), .h3)
        XCTAssertEqual(lineKindAt(md, pos: 20), .text)
        XCTAssertEqual(lineKindAt(md, pos: 27), .bullet1)
        XCTAssertEqual(lineKindAt(md, pos: 38), .bullet2)
        XCTAssertEqual(lineKindAt(md, pos: 52), .bullet3)
        XCTAssertNil(lineKindAt(md, pos: 66))
    }

    func testToggleMark() {
        let wrapped = toggleMark("hello world", start: 0, end: 5, marker: "**")
        XCTAssertEqual(wrapped, LineEditResult(text: "**hello** world", start: 2, end: 7))

        let unwrappedOutside = toggleMark("**hello** world", start: 2, end: 7, marker: "**")
        XCTAssertEqual(unwrappedOutside, LineEditResult(text: "hello world", start: 0, end: 5))

        let unwrappedInside = toggleMark("**hello** world", start: 0, end: 9, marker: "**")
        XCTAssertEqual(unwrappedInside, LineEditResult(text: "hello world", start: 0, end: 5))

        let empty = toggleMark("hello", start: 5, end: 5, marker: "*")
        XCTAssertEqual(empty, LineEditResult(text: "hello**", start: 6, end: 6))
    }

    func testContinueList() {
        let nextBullet = continueList("- first item", start: 12, end: 12)
        XCTAssertEqual(nextBullet, LineEditResult(text: "- first item\n- ", start: 15, end: 15))

        let nextNumber = continueList("1. first", start: 8, end: 8)
        XCTAssertEqual(nextNumber, LineEditResult(text: "1. first\n2. ", start: 12, end: 12))

        let outdentEmpty = continueList("  - ", start: 4, end: 4)
        XCTAssertEqual(outdentEmpty, LineEditResult(text: "- ", start: 2, end: 2))

        let exitEmpty = continueList("- ", start: 2, end: 2)
        XCTAssertEqual(exitEmpty, LineEditResult(text: "", start: 0, end: 0))
    }

    func testLooksLikeMarkdownAndRelativeTimeAndSameSummary() {
        XCTAssertTrue(looksLikeMarkdown("## Section\n- item"))
        XCTAssertTrue(looksLikeMarkdown("A **bold** word"))
        XCTAssertFalse(looksLikeMarkdown("Just plain text without formatting"))

        let now = 1_700_000_000_000.0
        XCTAssertEqual(relativeTime(now - 10_000, nowMs: now), "a moment ago")
        XCTAssertEqual(relativeTime(now - 60_000, nowMs: now), "a minute ago")
        XCTAssertEqual(relativeTime(now - 300_000, nowMs: now), "5 minutes ago")
        XCTAssertEqual(relativeTime(now - 3_600_000, nowMs: now), "an hour ago")

        XCTAssertTrue(sameSummary("Hello\n\n", "Hello"))
        XCTAssertFalse(sameSummary("Hello", "World"))
    }

    // MARK: - Study Actions (app/study-actions.ts)

    func testStudyActionsSaveAddCropGlossaryAndAsk() throws {
        let database = try LockinDatabase.inMemory()
        let lectureId = try database.writer.write { db -> String in
            var course = Course(code: "BIOL1001", title: "Biology")
            try course.insert(db)
            var lecture = Lecture(
                courseId: course.id,
                title: "Week 1",
                summaryMd: "## Aim 1\n- Initial point\n\n![Slide 3 — Diagram](slide:3)\n",
                skipped: skippedJSON([
                    Skipped(what: "Admin", where: "Slide 1", about: "Mid-sem is May 4")
                ]).stringified()
            )
            try lecture.insert(db)
            return lecture.id
        }

        // 1. saveSummaryEdit conflict vs non-conflict
        let conflict = try saveSummaryEdit(
            database: database,
            lectureId: lectureId,
            markdown: "## Aim 1\n- Changed",
            base: "## Wrong base"
        )
        XCTAssertFalse(conflict.ok)
        XCTAssertTrue(conflict.conflict)

        let saved = try saveSummaryEdit(
            database: database,
            lectureId: lectureId,
            markdown: "## Aim 1\n- Updated point\n\n![Slide 3 — Diagram](slide:3)",
            base: "## Aim 1\n- Initial point\n\n![Slide 3 — Diagram](slide:3)\n"
        )
        XCTAssertTrue(saved.ok)

        // 2. addToSummary
        let added = addToSummary(
            database: database,
            lectureId: lectureId,
            markdown: "- Added bullet",
            place: .section("Aim 1")
        )
        XCTAssertTrue(added.ok)

        // 3. setSlideCrop
        let cropped = try setSlideCrop(
            database: database,
            lectureId: lectureId,
            figure: 0,
            slide: 3,
            crop: Crop(x: 0.1, y: 0.2, w: 0.5, h: 0.4)
        )
        XCTAssertTrue(cropped.ok)
        let afterCropMd = try database.reader.read { db in
            try Lecture.fetchOne(db, key: lectureId)?.summaryMd ?? ""
        }
        XCTAssertTrue(afterCropMd.contains("slide:3#crop=3:0.1,0.2,0.5,0.4"))

        // 4. addLeftOutToSummary
        let leftOutRes = try addLeftOutToSummary(database: database, lectureId: lectureId, what: "Admin")
        XCTAssertTrue(leftOutRes.ok)
        let afterLeftOut = try database.reader.read { db in
            try Lecture.fetchOne(db, key: lectureId)
        }
        XCTAssertTrue(afterLeftOut?.summaryMd?.contains("## Admin") == true)
        XCTAssertEqual(readSkipped(afterLeftOut?.skipped).first?.added, true)

        // 5. addGlossaryTerm & removeGlossaryTerm
        let g1 = try addGlossaryTerm(
            database: database,
            lectureId: lectureId,
            term: " “ATP” ",
            explanation: "Adenosine triphosphate"
        ).get()
        XCTAssertEqual(g1.term, "ATP")
        let g2 = try addGlossaryTerm(
            database: database,
            lectureId: lectureId,
            term: "atp",
            explanation: "Updated explanation"
        ).get()
        XCTAssertEqual(g1.id, g2.id)
        XCTAssertEqual(g2.explanation, "Updated explanation")
        try removeGlossaryTerm(database: database, id: g1.id)
        let count = try database.reader.read { db in
            try GlossaryTerm.filter(Column("lectureId") == lectureId).fetchCount(db)
        }
        XCTAssertEqual(count, 0)

        // 6. startAsk with known left-out returns .done immediately
        let askKnown = try startAsk(
            database: database,
            payload: AskPayload(kind: .leftout, lectureId: lectureId, what: "Admin")
        )
        XCTAssertEqual(
            askKnown,
            AskStartOutcome.done(AskResult(kind: .leftout, answer: "Mid-sem is May 4", section: nil, what: "Admin", found: true))
        )
    }
}
