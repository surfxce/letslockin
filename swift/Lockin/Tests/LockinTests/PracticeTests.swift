import XCTest
import GRDB
@testable import LockinCore

final class PracticeTests: XCTestCase {
    private func fixture(manual: Bool = false) throws -> LockinDatabase {
        let database = try LockinDatabase.inMemory()
        try database.writer.write { db in
            var course = Course(id: "course", code: "BIO", title: "Biology")
            try course.insert(db)
            var lecture = Lecture(id: "lecture", courseId: course.id, title: "Cells", deliveredOn: Date(), summaryMd: "# Cells\n\nATP & energy")
            try lecture.insert(db)
            for i in 1...3 {
                var question = Question(id: "q\(i)", lectureId: lecture.id, stem: "Explain process \(i)", type: .laq, rubric: #"{"criteria":[{"point":"ATP supplies energy","marks":10}],"totalMarks":10}"#, promptVersion: "test", createdAt: Date(timeIntervalSince1970: Double(i)))
                try question.insert(db)
            }
            if manual { try setSetting(db: db, key: "mode", value: "manual") }
        }
        return database
    }

    func testResumesDraftAndRotatesQuestionsAfterSubmission() throws {
        let database = try fixture()
        try database.writer.write { db in
            let id = try startPractice(db: db, lectureId: "lecture")
            let first = try practiceSnapshot(db: db, attemptId: id)
            XCTAssertEqual(first.answers.count, 2)
            try savePracticeDraft(db: db, responseId: first.answers[0].id, text: "Remembered ATP")
            XCTAssertEqual(try startPractice(db: db, lectureId: "lecture"), id)
            XCTAssertEqual(try practiceSnapshot(db: db, attemptId: id).answers[0].response.draftText, "Remembered ATP")
            try submitPractice(db: db, attemptId: id, answers: [:])
            let second = try startPractice(db: db, lectureId: "lecture")
            XCTAssertNotEqual(id, second)
            XCTAssertTrue(try practiceSnapshot(db: db, attemptId: second).answers.contains { $0.question.id == "q3" })
        }
    }

    func testSubmissionBlankZeroAndDuplicateSubmissionAndLateDraft() throws {
        let database = try fixture()
        try database.writer.write { db in
            let id = try startPractice(db: db, lectureId: "lecture")
            let snapshot = try practiceSnapshot(db: db, attemptId: id)
            XCTAssertThrowsError(try submitPractice(db: db, attemptId: id, answers: [:]))
            XCTAssertEqual(try Job.fetchCount(db), 0)
            let responseId = snapshot.answers[0].id
            try submitPractice(db: db, attemptId: id, answers: [responseId: "An answer"])
            try submitPractice(db: db, attemptId: id, answers: [responseId: "Changed answer"])
            XCTAssertEqual(try Job.fetchCount(db), 1)
            let result = try practiceSnapshot(db: db, attemptId: id)
            XCTAssertEqual(result.answers[0].response.answerText, "An answer")
            XCTAssertEqual(result.answers[1].response.mark, 0)
            XCTAssertThrowsError(try savePracticeDraft(db: db, responseId: result.answers[1].id, text: "Too late"))
            XCTAssertEqual(result.jobs[0].priority, jobPriority(.mark))
            XCTAssertNil(result.attempt.geometricMean)
        }
    }

    func testManualMarksScoreScheduleAndNotes() throws {
        let database = try fixture(manual: true)
        try database.writer.write { db in
            let id = try startPractice(db: db, lectureId: "lecture")
            let snapshot = try practiceSnapshot(db: db, attemptId: id)
            XCTAssertThrowsError(try practiceMarkingPrompt(snapshot))
            try submitPractice(db: db, attemptId: id, answers: Dictionary(uniqueKeysWithValues: snapshot.answers.map { ($0.id, "Answer") }))
            XCTAssertEqual(try Job.fetchCount(db), 0)
            let prompt = try practiceMarkingPrompt(practiceSnapshot(db: db, attemptId: id))
            XCTAssertTrue(prompt.contains("ATP supplies energy"))
            XCTAssertTrue(prompt.contains("**My answer**\nAnswer"))
            XCTAssertEqual(try savePracticePaste(db: db, attemptId: id, text: "LAQ 1: 8/10\n- Missed: ATP supplies energy"), 1)
            XCTAssertNil(try Attempt.fetchOne(db, key: id)?.geometricMean)
            try savePracticePaste(db: db, attemptId: id, text: "LAQ 2: 8/10\n- Wrong: ATP supplies energy.")
            let result = try practiceSnapshot(db: db, attemptId: id)
            XCTAssertEqual(result.attempt.geometricMean ?? 0, 8, accuracy: 0.001)
            XCTAssertEqual(result.review.intervalDays, 3)
            XCTAssertEqual(practiceNotes(result).count, 1)
            XCTAssertTrue(practiceNotes(result).plain.contains("ATP supplies energy"))
        }
    }

    func testRejectsUnknownScoresBeforeWritingAndDoesNotOverwriteBlank() throws {
        let database = try fixture(manual: true)
        try database.writer.write { db in
            let id = try startPractice(db: db, lectureId: "lecture")
            let snapshot = try practiceSnapshot(db: db, attemptId: id)
            try submitPractice(db: db, attemptId: id, answers: [snapshot.answers[0].id: "answer"])
            XCTAssertThrowsError(try savePracticePaste(db: db, attemptId: id, text: "LAQ 1: 7/10\nLAQ 99: 9/10"))
            XCTAssertNil(try Response.fetchOne(db, key: snapshot.answers[0].id)?.mark)
            XCTAssertThrowsError(try savePracticePaste(db: db, attemptId: id, text: "LAQ 2: 5/10"))
            XCTAssertEqual(practiceNotes(try practiceSnapshot(db: db, attemptId: id)).plain.contains("ATP supplies energy"), true)
        }
    }

    func testPastedSummaryQuestionsAndExternalScores() throws {
        let database = try fixture()
        try database.writer.write { db in
            try saveLecturePaste(db: db, lectureId: "lecture", kind: .summary, text: "# Revised\n\nNew facts")
            XCTAssertEqual(try Lecture.fetchOne(db, key: "lecture")?.summaryModel, pastedModelLabel)
            try saveLecturePaste(db: db, lectureId: "lecture", kind: .laqs, text: "### LAQ 4 (10 marks)\nExplain ATP.\n\n**Marking guide**\n- Energy (10 marks)\n\n**Model answer**\nATP supplies energy.")
            XCTAssertEqual(try Question.fetchCount(db), 4)
            try saveLecturePaste(db: db, lectureId: "lecture", kind: .scores, text: "LAQ 4: 9/10\n- Missed: ADP is recycled")
            let attempt = try XCTUnwrap(Attempt.fetchOne(db))
            XCTAssertEqual(attempt.source, .pasted)
            let notes = practiceNotes(try practiceSnapshot(db: db, attemptId: attempt.id))
            XCTAssertTrue(notes.plain.contains("ADP is recycled"))
            XCTAssertFalse(notes.plain.contains("Left blank"))
        }
    }

    func testExportEscapesMetadataAndIncludesGlossaryAndOmitsEmptySummaries() throws {
        let database = try fixture()
        try database.writer.write { db in
            var term = GlossaryTerm(lectureId: "lecture", term: "<ATP>", explanation: "Energy & transport")
            try term.insert(db)
            var empty = Lecture(id: "empty", courseId: "course", title: "Empty", deliveredOn: Date())
            try empty.insert(db)
        }
        let result = try studyExportDocument(database: database, lectureIds: ["lecture", "empty"], options: .init(), renderer: SlideRenderer())
        XCTAssertEqual(result.count, 1); XCTAssertEqual(result.omitted, 1)
        XCTAssertTrue(result.html.contains("&lt;ATP&gt;"))
        XCTAssertTrue(result.html.contains("Energy &amp; transport"))
        XCTAssertTrue(result.html.contains("color-scheme: light"))
        XCTAssertThrowsError(try studyExportDocument(database: database, lectureIds: ["empty"], options: .init(), renderer: SlideRenderer()))
    }
}
