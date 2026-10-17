import Foundation
import GRDB

// Port of lib/pipeline.ts: the steps the queue runs. Each reads what it needs fresh from
// the database and writes its result before returning, so a job that fails half-way
// leaves every finished step in place and a retry picks up from the first unfinished one.
//
// Every step reads, then awaits the model, then writes: no transaction spans a model call.
// The reads and writes are synchronous helpers (GRDB's blocking `read`/`write`), called
// from the async steps between awaits.

// MARK: - Results (stored in Job.result)

/// What `digestLecture` did: `{"title","reused","minted","skipped","slideNotes"}`.
public struct DigestOutcome: Equatable, Sendable {
    public var title: String
    public var reused: Int
    public var minted: Int
    public var skipped: Int
    public var slideNotes: Int

    public init(title: String, reused: Int, minted: Int, skipped: Int, slideNotes: Int) {
        self.title = title
        self.reused = reused
        self.minted = minted
        self.skipped = skipped
        self.slideNotes = slideNotes
    }

    public var json: JSONValue {
        [
            "title": .string(title),
            "reused": .int(reused),
            "minted": .int(minted),
            "skipped": .int(skipped),
            "slideNotes": .int(slideNotes),
        ]
    }
}

/// What `writeQuestions` did: `{"generated","budget","targeted"}`, or
/// `{"generated":0,"budget","note"}` when every concept is already mastered.
public struct WriteQuestionsOutcome: Equatable, Sendable {
    public var generated: Int
    public var budget: Int
    public var targeted: Int?
    public var note: String?

    public init(generated: Int, budget: Int, targeted: Int? = nil, note: String? = nil) {
        self.generated = generated
        self.budget = budget
        self.targeted = targeted
        self.note = note
    }

    public var json: JSONValue {
        var object = JSONObject()
        object["generated"] = .int(generated)
        object["budget"] = .int(budget)
        if let targeted {
            object["targeted"] = .int(targeted)
        }
        if let note {
            object["note"] = .string(note)
        }
        return .object(object)
    }
}

/// What `markResponse` did: `{"mark","gaps"}` (every gap the model named).
public struct MarkOutcome: Equatable, Sendable {
    public var mark: Double
    public var gaps: Int

    public init(mark: Double, gaps: Int) {
        self.mark = mark
        self.gaps = gaps
    }

    public var json: JSONValue {
        ["mark": .number(mark), "gaps": .int(gaps)]
    }
}

// MARK: - Shared reads

/// `findUniqueOrThrow` for a lecture.
private func pipelineLecture(db: Database, lectureId: String) throws -> Lecture {
    guard let lecture = try Lecture.fetchOne(db, key: lectureId) else {
        throw LockinError(prismaRecordNotFound)
    }
    return lecture
}

/// `include: { materials: true }`.
private func pipelineMaterials(db: Database, lectureId: String) throws -> [Material] {
    try Material.fetchAll(db, sql: #"SELECT * FROM "Material" WHERE "lectureId" = ?"#, arguments: [lectureId])
}

private func pipelineRowExists(db: Database, table: String, id: String) throws -> Bool {
    try String.fetchOne(db, sql: "SELECT \"id\" FROM \"\(table)\" WHERE \"id\" = ?", arguments: [id]) != nil
}

private func pipelineConceptRefs(_ concepts: [Concept]) -> [ConceptRef] {
    concepts.map { ConceptRef(id: $0.id, name: $0.name, definition: $0.definition) }
}

// MARK: - Digest

private struct DigestSource: Sendable {
    var lecture: Lecture
    var materials: [Material]
    var sharedWith: [String]
    /// The whole course's live concepts.
    var existing: [Concept]
}

private func loadDigestSource(database: LockinDatabase, lectureId: String) throws -> DigestSource {
    try database.reader.read { db -> DigestSource in
        let lecture = try pipelineLecture(db: db, lectureId: lectureId)
        let materials = try pipelineMaterials(db: db, lectureId: lectureId)
        let sharedWith = try sharingTitles(db: db, lecture: lecture)
        // Merged-away concepts are excluded — they are dead ids.
        let existing = try Concept.fetchAll(
            db,
            sql: #"SELECT * FROM "Concept" WHERE "courseId" = ? AND "mergedIntoId" IS NULL"#,
            arguments: [lecture.courseId]
        )
        return DigestSource(lecture: lecture, materials: materials, sharedWith: sharedWith, existing: existing)
    }
}

private struct DigestWrite: Sendable {
    var lectureId: String
    var concepts: [Concept]
    /// The new title when the old one was a filename placeholder; nil keeps the title.
    var title: String?
    var summaryMd: String?
    /// Whether `summaryModel` is written (not when the student's summary is kept).
    var setsSummaryModel: Bool
    var summaryModel: String
    var skipped: String
    var slideNotes: String?
}

private func saveDigest(database: LockinDatabase, _ change: DigestWrite) throws {
    try database.writer.write { db in
        guard try pipelineRowExists(db: db, table: "Lecture", id: change.lectureId) else {
            throw LockinError(prismaRecordNotFound)
        }
        for var concept in change.concepts {
            try concept.insert(db)
        }
        if let title = change.title {
            try db.execute(
                sql: #"UPDATE "Lecture" SET "title" = ?, "autoTitle" = 0 WHERE "id" = ?"#,
                arguments: [title, change.lectureId]
            )
        }
        try db.execute(
            sql: #"UPDATE "Lecture" SET "summaryMd" = ?, "skipped" = ?, "slideNotes" = ? WHERE "id" = ?"#,
            arguments: [change.summaryMd, change.skipped, change.slideNotes, change.lectureId]
        )
        if change.setsSummaryModel {
            try db.execute(
                sql: #"UPDATE "Lecture" SET "summaryModel" = ? WHERE "id" = ?"#,
                arguments: [change.summaryModel, change.lectureId]
            )
        }
    }
}

/// Title, set-aside sections, summary and concepts for one lecture, in one model call.
/// `visionNotes` is what an offline model saw on each slide, looked at just before.
public func digestLecture(
    database: LockinDatabase,
    lectureId: String,
    keepSummary: Bool,
    visionNotes: [SlideNote]?,
    provider: any LLMProvider,
    renderer: any SlideRendering
) async throws -> DigestOutcome {
    // Decks first: it counts the pages of any deck imported before page counts were kept.
    let decks = try lectureDecks(database: database, lectureId: lectureId, renderer: renderer)
    let source = try loadDigestSource(database: database, lectureId: lectureId)
    let lecture = source.lecture
    let sources = try lectureSources(source.materials)

    let slidesText: String?
    if let visionNotes, !visionNotes.isEmpty {
        slidesText = withSlideNotes(sources.slidesText, visionNotes)
    } else {
        slidesText = sources.slidesText
    }

    // The whole course's concepts go in, so the model reuses an id rather than
    // minting a synonym.
    let digest = try await provider.digest(
        DigestInput(
            currentTitle: lecture.title,
            titleIsPlaceholder: lecture.autoTitle,
            durationHours: lecture.durationHours,
            transcript: sources.transcript,
            slidesText: slidesText,
            alreadySkipped: sources.skipped,
            existingConcepts: pipelineConceptRefs(source.existing),
            slides: decks.isEmpty ? nil : SlidesInfo(lectureId: lectureId, decks: decks, sharedWith: source.sharedWith)
        )
    )
    let lastSlide = decks.reduce(0) { $0 + $1.pages }
    // A model that saw the slides writes its own notes; an offline one had them written for it.
    let offered = digest.slideNotes.isEmpty ? (visionNotes ?? []) : digest.slideNotes
    let slideNotes = offered.filter { $0.slide >= 1 && $0.slide <= lastSlide }

    let knownIds = Set(source.existing.map { $0.id })
    let ownIds = Set(source.existing.filter { $0.lectureId == lectureId }.map { $0.id })
    func isReuse(_ id: String?) -> Bool {
        guard let id, !id.isEmpty else { return false }
        return knownIds.contains(id)
    }
    // A reused concept stays with the lecture that introduced it. If every one is a
    // reuse (a recap lecture), this lecture would own nothing to be asked about — so
    // then they become its own.
    let keepsOne = digest.concepts.contains { concept in
        if !isReuse(concept.existingId) {
            return true
        }
        guard let id = concept.existingId else { return false }
        return ownIds.contains(id)
    }
    var reused = 0
    var minted: [Concept] = []
    for concept in digest.concepts {
        if keepsOne && isReuse(concept.existingId) {
            // Reuse means "this lecture also covers it" — never overwrite the original
            // wording, or the id stops meaning one stable thing.
            reused += 1
            continue
        }
        minted.append(
            Concept(
                courseId: lecture.courseId,
                lectureId: lectureId,
                name: concept.name,
                definition: concept.definition,
                sourceRef: concept.sourceRef
            )
        )
    }

    let keep = keepSummary && !(lecture.summaryMd ?? "").isEmpty
    let skipped = mergeSkipped(sources.skipped + digest.skipped.map { $0.asSkipped })
    try saveDigest(
        database: database,
        DigestWrite(
            lectureId: lectureId,
            concepts: minted,
            // A title the student typed is theirs; only a filename placeholder is replaced.
            title: lecture.autoTitle ? pipelineTrim(digest.title) : nil,
            summaryMd: keep ? lecture.summaryMd : digest.summaryMd,
            setsSummaryModel: !keep,
            summaryModel: provider.lastModel,
            skipped: skippedJSON(skipped).stringified(),
            // Notes from a model that saw this set of slides; a model that didn't leaves none,
            // and old notes for a set of slides that has since changed are not kept.
            slideNotes: slideNotes.isEmpty ? nil : JSONValue.array(slideNotes.map { $0.json }).stringified()
        )
    )
    return DigestOutcome(
        title: digest.title,
        reused: reused,
        minted: minted.count,
        skipped: digest.skipped.count + sources.skipped.count,
        slideNotes: slideNotes.count
    )
}

// MARK: - Questions

private struct QuestionSource: Sendable {
    var lecture: Lecture
    var materials: [Material]
    /// The lecture's own live concepts.
    var concepts: [Concept]
}

private func loadQuestionSource(database: LockinDatabase, lectureId: String) throws -> QuestionSource {
    try database.reader.read { db -> QuestionSource in
        let lecture = try pipelineLecture(db: db, lectureId: lectureId)
        let materials = try pipelineMaterials(db: db, lectureId: lectureId)
        let concepts = try Concept.fetchAll(
            db,
            sql: #"SELECT * FROM "Concept" WHERE "lectureId" = ? AND "mergedIntoId" IS NULL"#,
            arguments: [lectureId]
        )
        return QuestionSource(lecture: lecture, materials: materials, concepts: concepts)
    }
}

private func readMastery(database: LockinDatabase, conceptIds: [String]) throws -> [ConceptMastery] {
    try database.reader.read { db -> [ConceptMastery] in
        try conceptMastery(db, conceptIds: conceptIds)
    }
}

private func readSharingTitles(database: LockinDatabase, lecture: Lecture) throws -> [String] {
    try database.reader.read { db -> [String] in
        try sharingTitles(db: db, lecture: lecture)
    }
}

private struct NewQuestion: Sendable {
    var question: Question
    var conceptIds: [String]
}

private func saveQuestions(database: LockinDatabase, lectureId: String, _ questions: [NewQuestion]) throws {
    try database.writer.write { db in
        guard try pipelineRowExists(db: db, table: "Lecture", id: lectureId) else {
            throw LockinError(prismaRecordNotFound)
        }
        for item in questions {
            var question = item.question
            try question.insert(db)
            for conceptId in item.conceptIds {
                var link = QuestionConcept(questionId: question.id, conceptId: conceptId)
                try link.insert(db)
            }
        }
    }
}

/// Writes LAQs for a lecture. The allocation is adaptive: concepts never asked about, or
/// that keep scoring badly, get the questions.
public func writeQuestions(
    database: LockinDatabase,
    lectureId: String,
    provider: any LLMProvider
) async throws -> WriteQuestionsOutcome {
    let source = try loadQuestionSource(database: database, lectureId: lectureId)
    let lecture = source.lecture
    if source.concepts.isEmpty {
        throw LockinError("this lecture has no concepts yet — prepare it first")
    }
    let sources = try lectureSources(source.materials)

    let mastery = try readMastery(database: database, conceptIds: source.concepts.map { $0.id })
    let settings = try getSettings(database: database)
    let budget = questionBudget(durationHours: lecture.durationHours, perHour: Double(settings.laqsPerHour))
    let allocation = allocate(mastery, budget: budget)
    if allocation.isEmpty {
        return WriteQuestionsOutcome(generated: 0, budget: budget, note: "every concept in this lecture is already at 10/10")
    }

    // Notes written by a model that saw the slides beat text extracted from them: they
    // include words inside pictures and what each figure shows.
    let notes = readSlideNotes(lecture.slideNotes)
    let sharedWith = try readSharingTitles(database: database, lecture: lecture)
    let written = try await provider.generateQuestions(
        GenerateQuestionsInput(
            lectureTitle: lecture.title,
            transcript: sources.transcript,
            slidesText: notes.isEmpty ? sources.slidesText : slideNotesText(notes),
            summary: lecture.summaryMd,
            concepts: pipelineConceptRefs(source.concepts),
            allocation: allocation,
            type: .laq,
            style: settings.laqStyle,
            sharedWith: sharedWith
        )
    )

    let known = Set(source.concepts.map { $0.id })
    let promptVersion = provider.lastPromptVersion
    let model = provider.lastModel
    var rows: [NewQuestion] = []
    for item in written.questions {
        // Deduplicated: a model can cite one concept twice, and the link table's key forbids it.
        var seen = Set<String>()
        var conceptIds: [String] = []
        for id in item.conceptIds where !seen.contains(id) {
            seen.insert(id)
            if known.contains(id) {
                conceptIds.append(id)
            }
        }
        // A question about nothing cannot be scored.
        if conceptIds.isEmpty {
            continue
        }
        rows.append(
            NewQuestion(
                question: Question(
                    lectureId: lectureId,
                    stem: item.stem,
                    type: item.type,
                    rubric: item.rubric.json.stringified(),
                    promptVersion: promptVersion,
                    model: model
                ),
                conceptIds: conceptIds
            )
        )
    }
    try saveQuestions(database: database, lectureId: lectureId, rows)
    return WriteQuestionsOutcome(generated: rows.count, budget: budget, targeted: allocation.count)
}

// MARK: - Marking

private struct MarkSource: Sendable {
    var response: Response
    var question: Question
    /// Only the concepts this question covers — gaps must cite one of these ids.
    var concepts: [ConceptRef]
}

private func loadMarkSource(database: LockinDatabase, responseId: String) throws -> MarkSource {
    try database.reader.read { db -> MarkSource in
        guard let response = try Response.fetchOne(db, key: responseId),
              let question = try Question.fetchOne(db, key: response.questionId) else {
            throw LockinError(prismaRecordNotFound)
        }
        let links = try QuestionConcept.fetchAll(
            db,
            sql: #"SELECT * FROM "QuestionConcept" WHERE "questionId" = ?"#,
            arguments: [question.id]
        )
        var concepts: [ConceptRef] = []
        for link in links {
            if let concept = try Concept.fetchOne(db, key: link.conceptId) {
                concepts.append(ConceptRef(id: concept.id, name: concept.name, definition: concept.definition))
            }
        }
        return MarkSource(response: response, question: question, concepts: concepts)
    }
}

private struct MarkWrite: Sendable {
    var responseId: String
    var mark: Double
    var rubricVersion: String
    var rawMarkingJson: String
    var gaps: [MarkingGap]
    var markedAt: Date
}

private func saveMarking(database: LockinDatabase, _ change: MarkWrite) throws {
    try database.writer.write { db in
        try db.execute(
            sql: #"""
            UPDATE "Response" SET "mark" = ?, "rubricVersion" = ?, "rawMarkingJson" = ?, "markedAt" = ?
            WHERE "id" = ?
            """#,
            arguments: [change.mark, change.rubricVersion, change.rawMarkingJson, PrismaDate.encode(change.markedAt), change.responseId]
        )
        if db.changesCount == 0 {
            throw LockinError(prismaRecordNotFound)
        }
        try db.execute(sql: #"DELETE FROM "Gap" WHERE "responseId" = ?"#, arguments: [change.responseId])
        for gap in change.gaps {
            var row = Gap(responseId: change.responseId, conceptId: gap.conceptId, type: gap.type, text: gap.text)
            try row.insert(db)
        }
    }
}

private func scoreAttempt(database: LockinDatabase, attemptId: String) throws -> Double? {
    try database.writer.write { db -> Double? in
        try scoreAttemptIfMarked(db: db, attemptId: attemptId)
    }
}

/// Marks one answer against the rubric frozen when its question was written, records the
/// gaps, and scores the sitting once every answer in it has a mark.
public func markResponse(
    database: LockinDatabase,
    responseId: String,
    provider: any LLMProvider
) async throws -> MarkOutcome {
    let source = try loadMarkSource(database: database, responseId: responseId)
    if pipelineTrim(source.response.answerText).isEmpty {
        throw LockinError("nothing was written for this question")
    }

    let marking = try await provider.mark(
        MarkInput(
            questionStem: source.question.stem,
            // The rubric was frozen when the question was written. Marking applies it.
            rubric: try JSONValue.parse(source.question.rubric),
            answerText: source.response.answerText,
            concepts: source.concepts
        )
    )

    // A gap must cite a concept this question covers, or recurrence counting breaks.
    let allowed = Set(source.concepts.map { $0.id })
    try saveMarking(
        database: database,
        MarkWrite(
            responseId: responseId,
            mark: marking.mark,
            rubricVersion: source.question.promptVersion,
            rawMarkingJson: marking.json.stringified(),
            gaps: marking.gaps.filter { allowed.contains($0.conceptId) },
            markedAt: Date()
        )
    )

    _ = try scoreAttempt(database: database, attemptId: source.response.attemptId)
    return MarkOutcome(mark: marking.mark, gaps: marking.gaps.count)
}

/// An attempt is scored only once every answered question in it has a mark: the geometric
/// mean of its marks, and the time it was completed. Nil when it isn't scored yet.
@discardableResult
public func scoreAttemptIfMarked(db: Database, attemptId: String, now: Date = Date()) throws -> Double? {
    let rows = try Row.fetchAll(db, sql: #"SELECT "mark" FROM "Response" WHERE "attemptId" = ?"#, arguments: [attemptId])
    var marks: [Double] = []
    for row in rows {
        let value: Double? = row["mark"]
        guard let mark = value else { return nil }
        marks.append(mark)
    }
    if marks.isEmpty {
        return nil
    }
    let score = try geometricMean(marks)
    try db.execute(
        sql: #"UPDATE "Attempt" SET "geometricMean" = ?, "completedAt" = ? WHERE "id" = ?"#,
        arguments: [score, PrismaDate.encode(now), attemptId]
    )
    if db.changesCount == 0 {
        throw LockinError(prismaRecordNotFound)
    }
    return score
}
