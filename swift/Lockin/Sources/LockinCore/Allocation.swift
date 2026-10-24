import Foundation
import GRDB

public struct ConceptMastery: Equatable, Sendable {
    public var conceptId: String
    /// Geometric mean of every mark this concept has ever earned, 0-10. 0 = untested.
    public var mastery: Double
    /// Exam likelihood, 0-1. Without past papers everything sits at the 0.5 default.
    public var yield: Double

    public init(conceptId: String, mastery: Double, yield: Double = 0.5) {
        self.conceptId = conceptId
        self.mastery = mastery
        self.yield = yield
    }
}

public struct Allocation: Equatable, Sendable {
    public var conceptId: String
    public var count: Int

    public init(conceptId: String, count: Int) {
        self.conceptId = conceptId
        self.count = count
    }
}

/// How much attention a concept has earned: the "ten minus your score" rule,
/// weighted by how likely the thing is to be examined.
public func priority(_ c: ConceptMastery) -> Double {
    (10.0 - c.mastery) * (0.5 + c.yield)
}

/// Turns priorities into an actual question list capped by the lecture's budget.
public func allocate(_ concepts: [ConceptMastery], budget: Int) -> [Allocation] {
    guard budget > 0, !concepts.isEmpty else { return [] }

    let ranked = concepts
        .map { (conceptId: $0.conceptId, weight: priority($0)) }
        .filter { $0.weight > 0 }
        .sorted { a, b in
            if b.weight != a.weight { return b.weight < a.weight }
            return a.conceptId.localizedCompare(b.conceptId) == .orderedAscending
        }
    guard !ranked.isEmpty else { return [] }

    var order: [String] = []
    var counts: [String: Int] = [:]
    for i in 0..<budget {
        let c = ranked[i % ranked.count]
        if counts[c.conceptId] == nil {
            order.append(c.conceptId)
        }
        counts[c.conceptId, default: 0] += 1
    }
    return order.map { Allocation(conceptId: $0, count: counts[$0]!) }
}

/// Questions per lecture hour — two unless Settings says otherwise.
public func questionBudget(durationHours: Double, perHour: Double = 2) -> Int {
    max(1, Int((durationHours * perHour).rounded()))
}

/// A concept's mastery is the geometric mean of every mark it has ever earned.
public func conceptMastery(_ db: Database, conceptIds: [String]) throws -> [ConceptMastery] {
    guard !conceptIds.isEmpty else { return [] }

    let placeholders = Array(repeating: "?", count: conceptIds.count).joined(separator: ",")
    let rows = try Row.fetchAll(
        db,
        sql: """
        SELECT qc."conceptId" AS conceptId, r."mark" AS mark
        FROM "QuestionConcept" qc
        JOIN "Response" r ON r."questionId" = qc."questionId"
        WHERE qc."conceptId" IN (\(placeholders)) AND r."mark" IS NOT NULL
        """,
        arguments: StatementArguments(conceptIds)
    )

    var marks: [String: [Double]] = [:]
    for row in rows {
        let cid: String = row["conceptId"]
        if let mark: Double = row["mark"] {
            marks[cid, default: []].append(mark)
        }
    }

    return try conceptIds.map { cid in
        let list = marks[cid] ?? []
        return ConceptMastery(
            conceptId: cid,
            mastery: list.isEmpty ? 0 : try geometricMean(list),
            yield: 0.5
        )
    }
}

/// Chooses what a sitting asks about: concepts ranked by priority, then the least-used
/// question covering each (`lib/engines/attempt.ts`).
public func pickQuestions(_ db: Database, lectureId: String, sittingPerHour: Double = 2) throws -> [String] {
    guard let lecture = try Lecture.fetchOne(db, key: lectureId) else { return [] }

    let conceptIds = try String.fetchAll(
        db,
        sql: #"SELECT "id" FROM "Concept" WHERE "lectureId" = ? AND "mergedIntoId" IS NULL"#,
        arguments: [lectureId]
    )

    struct QuestionMeta {
        var id: String
        var conceptIds: Set<String>
        var responseCount: Int
    }

    let questionRows = try Row.fetchAll(
        db,
        sql: """
        SELECT q."id" AS id,
               (SELECT COUNT(*) FROM "Response" r WHERE r."questionId" = q."id") AS responseCount
        FROM "Question" q
        WHERE q."lectureId" = ?
        """,
        arguments: [lectureId]
    )
    guard !questionRows.isEmpty else { return [] }

    let linkRows = try Row.fetchAll(
        db,
        sql: """
        SELECT qc."questionId" AS questionId, qc."conceptId" AS conceptId
        FROM "QuestionConcept" qc
        JOIN "Question" q ON q."id" = qc."questionId"
        WHERE q."lectureId" = ?
        """,
        arguments: [lectureId]
    )
    var conceptsByQuestion: [String: Set<String>] = [:]
    for row in linkRows {
        let qid: String = row["questionId"]
        let cid: String = row["conceptId"]
        conceptsByQuestion[qid, default: []].insert(cid)
    }

    let questions: [QuestionMeta] = questionRows.map { row in
        let id: String = row["id"]
        let count: Int = row["responseCount"]
        return QuestionMeta(id: id, conceptIds: conceptsByQuestion[id] ?? [], responseCount: count)
    }

    let budget = questionBudget(durationHours: lecture.durationHours, perHour: sittingPerHour)
    let mastery = try conceptMastery(db, conceptIds: conceptIds)
    let ranked = allocate(mastery, budget: budget)

    let leastUsedFirst = questions.sorted { a, b in
        if a.responseCount != b.responseCount { return a.responseCount < b.responseCount }
        return a.id.localizedCompare(b.id) == .orderedAscending
    }

    var picked: [String] = []
    func take(_ id: String) {
        if !picked.contains(id) && picked.count < budget {
            picked.append(id)
        }
    }

    for item in ranked {
        let covering = leastUsedFirst.filter { $0.conceptIds.contains(item.conceptId) }
        for q in covering.prefix(item.count) {
            take(q.id)
        }
    }
    for q in leastUsedFirst {
        take(q.id)
    }
    return picked
}
