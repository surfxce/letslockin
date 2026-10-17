import XCTest
@testable import LockinCore

final class AllocationTests: XCTestCase {
    private func c(_ conceptId: String, _ mastery: Double, _ y: Double = 0.5) -> ConceptMastery {
        ConceptMastery(conceptId: conceptId, mastery: mastery, yield: y)
    }

    func testPriorityGivesUntestedConceptFullWeight() {
        XCTAssertEqual(priority(c("a", 0)), 10)
    }

    func testPriorityDropsMasteredConceptOutEntirely() {
        XCTAssertEqual(priority(c("a", 10)), 0)
    }

    func testPriorityKeepsLowYieldWeaknessAboveZeroBecauseOfFloor() {
        XCTAssertGreaterThan(priority(c("a", 2, 0)), 0)
    }

    func testPriorityPrefersWeakerOfTwoEquallyLikelyConcepts() {
        XCTAssertGreaterThan(priority(c("weak", 3)), priority(c("strong", 8)))
    }

    func testPriorityPrefersMoreExaminableOfTwoEquallyWeakConcepts() {
        XCTAssertGreaterThan(priority(c("hot", 4, 1)), priority(c("cold", 4, 0)))
    }

    func testAllocateSpendsBudgetOnHighestPriorityConceptsFirst() {
        let out = allocate([c("weak", 1), c("mid", 5), c("strong", 9)], budget: 2)
        XCTAssertEqual(out.map(\.conceptId), ["weak", "mid"])
        XCTAssertTrue(out.allSatisfy { $0.count == 1 })
    }

    func testAllocateOnlyDoublesUpOnceEveryConceptHasAQuestion() {
        let out = allocate([c("weak", 1), c("mid", 5)], budget: 3)
        XCTAssertEqual(out.reduce(0) { $0 + $1.count }, 3)
        XCTAssertEqual(out.first { $0.conceptId == "weak" }?.count, 2)
    }

    func testAllocateNeverAsksAboutAConceptAlreadyAtTen() {
        XCTAssertEqual(
            allocate([c("done", 10), c("weak", 2)], budget: 4).map(\.conceptId),
            ["weak"]
        )
    }

    func testAllocateReturnsNothingWhenNoBudgetOrNothingToAsk() {
        XCTAssertEqual(allocate([c("a", 0)], budget: 0), [])
        XCTAssertEqual(allocate([], budget: 4), [])
    }

    func testQuestionBudgetAndConceptMasteryFromDatabase() throws {
        XCTAssertEqual(questionBudget(durationHours: 1), 2)
        XCTAssertEqual(questionBudget(durationHours: 1.5, perHour: 2), 3)
        XCTAssertEqual(questionBudget(durationHours: 0.2, perHour: 2), 1)

        let db = try LockinDatabase.inMemory()
        try db.writer.write { conn in
            var course = Course(id: "c1", code: "BIOL", title: "Bio")
            try course.insert(conn)
            var lecture = Lecture(id: "l1", courseId: "c1", title: "L1", deliveredOn: Date(), durationHours: 1)
            try lecture.insert(conn)
            var conA = Concept(id: "conA", courseId: "c1", lectureId: "l1", name: "A", definition: "Def A")
            var conB = Concept(id: "conB", courseId: "c1", lectureId: "l1", name: "B", definition: "Def B")
            try conA.insert(conn)
            try conB.insert(conn)
            var q1 = Question(id: "q1", lectureId: "l1", stem: "Q1", type: .laq, rubric: "{}", promptVersion: "1.0.0")
            var q2 = Question(id: "q2", lectureId: "l1", stem: "Q2", type: .laq, rubric: "{}", promptVersion: "1.0.0")
            try q1.insert(conn)
            try q2.insert(conn)
            var qc1 = QuestionConcept(questionId: "q1", conceptId: "conA")
            var qc2 = QuestionConcept(questionId: "q2", conceptId: "conB")
            try qc1.insert(conn)
            try qc2.insert(conn)
            var att = Attempt(id: "a1", lectureId: "l1")
            try att.insert(conn)
            var r1 = Response(id: "r1", attemptId: "a1", questionId: "q1", answerText: "ans", mark: 4)
            var r2 = Response(id: "r2", attemptId: "a1", questionId: "q1", answerText: "ans2", mark: 9)
            try r1.insert(conn)
            try r2.insert(conn)
        }

        try db.reader.read { conn in
            let masteries = try conceptMastery(conn, conceptIds: ["conA", "conB"])
            XCTAssertEqual(masteries.count, 2)
            XCTAssertEqual(masteries[0].conceptId, "conA")
            XCTAssertEqual(masteries[0].mastery, 6)
            XCTAssertEqual(masteries[1].conceptId, "conB")
            XCTAssertEqual(masteries[1].mastery, 0)

            let picked = try pickQuestions(conn, lectureId: "l1", sittingPerHour: 2)
            // conB is untested (mastery 0 > conA mastery 6), so q2 comes first, then q1.
            XCTAssertEqual(picked, ["q2", "q1"])
        }
    }
}
