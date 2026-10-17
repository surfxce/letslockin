import Foundation
import GRDB
import XCTest
@testable import LockinCore

// Ports lib/offline.test.ts ("lectureSources", "slide notes") and lib/llm/vision.test.ts
// ("withSlideNotes"), and covers lib/pipeline.ts and the worker's handlers against an
// in-memory database. Expected strings marked "node" were produced by running the
// TypeScript originals.

// MARK: - Stand-ins

private struct StubRenderer: SlideRendering {
    func pageCount(file: String) -> Int? { nil }
    func renderPage(file: String, page: Int) throws -> Data { throw LockinError("no PDFs in these tests") }
    func pagePNG(lectureId: String, deck: SlideDeck, page: Int) throws -> Data { throw LockinError("no PDFs in these tests") }
    func pagePNGFile(lectureId: String, deck: SlideDeck, page: Int) throws -> String { throw LockinError("no PDFs in these tests") }
    func cropPNG(_ png: Data, crop: Crop) throws -> Data { png }
}

private struct StubTextReader: SlideTextReading {
    func recognizeText(png: Data) async throws -> String { "" }
}

private struct StubEngine: EngineGenerating {
    func generate(
        model: String,
        prompt: String,
        images: [String],
        schema: JSONValue?,
        maxTokens: Int,
        temperature: Double,
        onTokens: (@Sendable (Int) -> Void)?
    ) async throws -> String {
        throw LockinError("no engine in these tests")
    }

    func stop() async {}
}

private func stubServices() -> LockinServices {
    LockinServices(renderer: StubRenderer(), textReader: StubTextReader(), engine: StubEngine(), environment: [:])
}

/// A provider that answers from a script and records what it was asked.
private class CannedProvider: LLMProvider, @unchecked Sendable {
    let name = "canned"
    let seesSlides: Bool
    let lastPromptVersion = "canned@1.0.0"
    let lastModel = "Canned · test"
    var onProgress: (@Sendable (String?) -> Void)?

    var digestReply: LectureDigest?
    var questionsReply = QuestionSet(questions: [])
    var markingReply = Marking(mark: 0, criteria: [], gaps: [])
    var sortReply = FolderSort(lectures: [])

    var digestInputs: [DigestInput] = []
    var questionInputs: [GenerateQuestionsInput] = []
    var markInputs: [MarkInput] = []
    var sortInputs: [SortFilesInput] = []

    init(seesSlides: Bool = false) {
        self.seesSlides = seesSlides
    }

    func digest(_ input: DigestInput) async throws -> LectureDigest {
        digestInputs.append(input)
        guard let reply = digestReply else { throw LockinError("no digest scripted") }
        return reply
    }

    func generateQuestions(_ input: GenerateQuestionsInput) async throws -> QuestionSet {
        questionInputs.append(input)
        return questionsReply
    }

    func mark(_ input: MarkInput) async throws -> Marking {
        markInputs.append(input)
        return markingReply
    }

    func parsePastPaper(_ input: ParsePastPaperInput) async throws -> PaperItems {
        PaperItems(items: [])
    }

    func sortFiles(_ input: SortFilesInput) async throws -> FolderSort {
        sortInputs.append(input)
        return sortReply
    }

    func ask(_ input: AskInput) async throws -> Answer {
        Answer(answer: "An answer.")
    }
}

/// The same, standing in for a model on this computer that the catalog doesn't know.
private final class OfflineCannedProvider: CannedProvider, OfflineModelProvider {
    let modelPath = "/nowhere/models/unknown"
    let modelId = "not-in-the-catalog"
    let modelName = "Unknown"
}

// MARK: - Helpers

private func material(
    _ kind: MaterialKind,
    _ text: String?,
    id: String = Cuid.generate(),
    pageCount: Int? = nil,
    createdAt: Date = Date(timeIntervalSince1970: 0)
) -> Material {
    Material(
        id: id,
        kind: kind,
        path: "\(id).txt",
        originalName: "\(id).txt",
        extractedText: text,
        pageCount: pageCount,
        checksum: id,
        createdAt: createdAt
    )
}

@discardableResult
private func syncWrite<T>(_ db: LockinDatabase, _ body: (Database) throws -> T) throws -> T {
    try db.writer.write { conn in try body(conn) }
}

private func syncRead<T>(_ db: LockinDatabase, _ body: (Database) throws -> T) throws -> T {
    try db.reader.read { conn in try body(conn) }
}

/// What an async call threw, as the job's error would say it; nil when it didn't throw.
private func thrownMessage(_ body: () async throws -> Void) async -> String? {
    do {
        try await body()
        return nil
    } catch {
        return messageOf(error)
    }
}

/// A course, a lecture with a transcript, and its job context for `kind`, claimed.
private func seedJob(_ db: LockinDatabase, kind: JobKind, payload: JSONValue, lectureId: String) throws -> JobContext {
    let job = try syncWrite(db) { conn -> Job in
        let queued = try enqueue(db: conn, kind: kind, payload: payload, lectureId: lectureId)
        XCTAssertTrue(try claimJob(db: conn, jobId: queued.id))
        guard let claimed = try Job.fetchOne(conn, key: queued.id) else { throw LockinError("job vanished") }
        return claimed
    }
    return JobContext(job: job, database: db, settings: LockinSettings(), services: stubServices())
}

private let fakeTranscript = """
[00:00] Ghrelin levels rise sharply before every meal in healthy adults. Ghrelin levels then fall \
quickly once the stomach stretches after eating. Leptin signals report long term energy stores to \
the hypothalamus, and the hypothalamus weighs ghrelin levels against leptin signals.
"""

final class PipelineTests: XCTestCase {
    // MARK: lectureSources (lib/offline.test.ts)

    func testLectureSourcesStripsAimsFromSlidesButLeavesTheTranscriptWhole() throws {
        let out = try lectureSources([
            material(.transcript, "[00:00] the aims of this module are…"),
            material(.slides, "--- Slide 1 ---\nLearning objectives\n\n--- Slide 2 ---\nlacZ"),
        ])
        XCTAssertTrue(out.transcript.contains("the aims of this module"))
        XCTAssertEqual(out.slidesText, "--- Slide 2 ---\nlacZ")
        XCTAssertEqual(out.skipped.map { $0.what }, ["Learning objectives"])
        XCTAssertEqual(out.skipped.first?.where, "slide 1")
    }

    func testLectureSourcesFallsBackToSlidesAloneAndRefusesALectureWithNoText() throws {
        XCTAssertTrue(try lectureSources([material(.slides, "--- Slide 2 ---\nlacZ")]).transcript.contains("lacZ"))
        XCTAssertNil(try lectureSources([material(.slides, "--- Slide 2 ---\nlacZ")]).slidesText)
        XCTAssertThrowsError(try lectureSources([material(.transcript, "  ")])) { error in
            XCTAssertEqual(messageOf(error), "this lecture has no transcript or slides with readable text yet")
        }
        XCTAssertThrowsError(try lectureSources([]))
    }

    func testLectureSourcesNumbersSlidesAcrossDecksInUploadOrder() throws {
        let out = try lectureSources([
            material(.transcript, "[00:00] hello"),
            material(.slides, "--- Page 1 ---\nSatiety", id: "b", pageCount: 2, createdAt: Date(timeIntervalSince1970: 0.002)),
            material(.slides, "--- Page 2 ---\nGhrelin", id: "a", pageCount: 3, createdAt: Date(timeIntervalSince1970: 0.001)),
        ])
        XCTAssertEqual(out.slidesText, "--- Slide 2 ---\nGhrelin\n\n--- Slide 4 ---\nSatiety")
    }

    func testLectureSourcesTakesADeckOfPicturesWithNoText() throws {
        let out = try lectureSources([material(.slides, "", pageCount: 12)])
        XCTAssertTrue(out.transcript.contains("work from the slides"))
        XCTAssertNil(out.slidesText)
    }

    func testLectureSourcesJoinsTranscriptsAndCountsUncountedDecksByTheirMarkers() throws {
        // node: the TypeScript lectureSources on the same materials.
        let out = try lectureSources([
            material(.transcript, "  [00:00] one  "),
            material(.transcript, "   "),
            material(.transcript, "[00:10] two"),
            material(
                .slides,
                "--- Page 1 ---\nSatiety\n--- Page 2 ---\nLearning objectives\nBy the end of this lecture you should be able to describe leptin",
                id: "b",
                createdAt: Date(timeIntervalSince1970: 0.002)
            ),
            material(.slides, "--- Page 2 ---\nGhrelin", id: "a", pageCount: 3, createdAt: Date(timeIntervalSince1970: 0.001)),
        ])
        XCTAssertEqual(out.transcript, "[00:00] one\n\n[00:10] two")
        XCTAssertEqual(out.slidesText, "--- Slide 2 ---\nGhrelin\n\n--- Slide 4 ---\nSatiety")
        XCTAssertEqual(
            skippedJSON(out.skipped).stringified(),
            #"[{"what":"Learning objectives","where":"slide 5","about":"Learning objectives\nBy the end of this lecture you should be able to describe leptin"}]"#
        )
    }

    // MARK: Slide notes (lib/offline.test.ts, lib/llm/vision.test.ts)

    func testReadSlideNotesReadsOnlyWellFormedNotes() {
        XCTAssertEqual(
            readSlideNotes(#"[{"slide":2,"notes":" Ghrelin "},{"slide":"x","notes":"no"},{"slide":3,"notes":""}]"#),
            [SlideNote(slide: 2, notes: "Ghrelin")]
        )
        XCTAssertEqual(readSlideNotes("not json"), [])
        XCTAssertEqual(readSlideNotes(nil), [])
        XCTAssertEqual(readSlideNotes(#"{"slide":1,"notes":"x"}"#), [])
        XCTAssertEqual(slideNotesText([SlideNote(slide: 2, notes: "Ghrelin")]), "--- Slide 2 ---\nGhrelin")
        // node
        XCTAssertEqual(
            readSlideNotes(#"[{"slide":2,"notes":" Ghrelin "},{"slide":"x","notes":"no"},{"slide":3,"notes":""},{"slide":2.5,"notes":"half"},{"slide":-1,"notes":"neg"}]"#),
            [SlideNote(slide: 2, notes: "Ghrelin"), SlideNote(slide: -1, notes: "neg")]
        )
    }

    func testWithSlideNotesWritesWhatWasSeenUnderEachSlideAndAddsSlidesThatHadNoText() {
        let text = "--- Slide 1 ---\nGlucose\n\n--- Slide 2 ---\nInsulin"
        let out = withSlideNotes(text, [
            SlideNote(slide: 2, notes: "A graph of insulin rising after a meal."),
            SlideNote(slide: 3, notes: "A diagram of a beta cell."),
        ]) ?? ""
        XCTAssertTrue(out.contains("--- Slide 1 ---\nGlucose\n"))
        XCTAssertTrue(out.contains("--- Slide 2 ---\nInsulin\n[On this slide: A graph of insulin rising after a meal.]"))
        XCTAssertTrue(out.contains("--- Slide 3 ---\nA diagram of a beta cell."))
    }

    func testWithSlideNotesStandsInForSlidesWithNoTextAtAll() {
        XCTAssertEqual(withSlideNotes(nil, [SlideNote(slide: 1, notes: "A title.")]), "--- Slide 1 ---\nA title.")
        XCTAssertEqual(withSlideNotes("  \n", [SlideNote(slide: 1, notes: "A title.")]), "--- Slide 1 ---\nA title.")
        XCTAssertEqual(withSlideNotes("--- Slide 1 ---\nx", []), "--- Slide 1 ---\nx")
        XCTAssertNil(withSlideNotes(nil, []))
    }

    func testWithSlideNotesMatchesTheTypeScriptExactly() {
        // node: a note goes in after the slide's first line, as the original's lazy match does.
        XCTAssertEqual(
            withSlideNotes("--- Slide 1 ---\nGlucose\nmore glucose\n\n--- Slide 2 ---\nInsulin", [
                SlideNote(slide: 2, notes: "A graph of insulin rising after a meal."),
                SlideNote(slide: 1, notes: "A sugar."),
                SlideNote(slide: 3, notes: "A diagram of a beta cell."),
            ]),
            "--- Slide 1 ---\nGlucose\n[On this slide: A sugar.]\n\nmore glucose\n\n--- Slide 2 ---\nInsulin\n"
                + "[On this slide: A graph of insulin rising after a meal.]\n\n--- Slide 3 ---\nA diagram of a beta cell."
        )
        XCTAssertEqual(
            withSlideNotes("--- Slide 1 ---\n\n--- Slide 2 ---\nx\n", [SlideNote(slide: 1, notes: "Seen"), SlideNote(slide: 2, notes: "")]),
            "--- Slide 1 ---\n[On this slide: Seen]\n\n--- Slide 2 ---\nx\n\n--- Slide 2 ---\n"
        )
    }

    // MARK: Lecture.skipped

    func testReadSkippedToleratesHandEditsAndWritesBackAsStringifyDoes() {
        // node
        let read = readSkipped(
            #"[{"what":"Aims","where":3,"about":"  a  ","added":true},{"what":"B"},{"what":5},null,"x",{"what":"C","where":null,"about":"   ","added":"yes"}]"#
        )
        XCTAssertEqual(read, [
            Skipped(what: "Aims", where: "3", about: "a", added: true),
            Skipped(what: "B", where: ""),
            Skipped(what: "C", where: ""),
        ])
        XCTAssertEqual(
            skippedJSON(read).stringified(),
            #"[{"what":"Aims","where":"3","about":"a","added":true},{"what":"B","where":""},{"what":"C","where":""}]"#
        )
        XCTAssertEqual(readSkipped(nil), [])
        XCTAssertEqual(readSkipped(""), [])
        XCTAssertEqual(readSkipped("{oops"), [])
        XCTAssertEqual(skippedJSON([]).stringified(), "[]")
    }

    func testSkippedJSONWritesMergedPartsAsTheWorkerDoes() {
        // node: JSON.stringify(mergeSkipped(…)).
        let merged = mergeSkipped([
            Skipped(what: "Learning objectives", where: "slide 1", about: "x"),
            Skipped(what: "Learning objectives", where: "slide 3"),
            DigestSkip(what: "Aims").asSkipped,
        ])
        XCTAssertEqual(
            skippedJSON(merged).stringified(),
            #"[{"what":"Learning objectives","where":"slides 1, 3","about":"x"},{"what":"Aims","where":""}]"#
        )
    }

    // MARK: digestLecture

    private func seedDigestLecture(_ db: LockinDatabase, title: String = "lecture-03.vtt", autoTitle: Bool = true, summaryMd: String? = nil, summaryModel: String? = nil) throws {
        try syncWrite(db) { conn in
            var course = Course(id: "course", code: "PHYS2001", title: "Physiology")
            try course.insert(conn)
            var lecture = Lecture(id: "lec", courseId: "course", title: title, summaryMd: summaryMd, autoTitle: autoTitle, summaryModel: summaryModel)
            try lecture.insert(conn)
            var other = Lecture(id: "other", courseId: "course", title: "Hunger")
            try other.insert(conn)
            var transcript = Material(
                lectureId: "lec",
                kind: .transcript,
                path: "lec/t.vtt",
                originalName: "t.vtt",
                extractedText: "Ghrelin rises before meals.",
                checksum: "t1"
            )
            try transcript.insert(conn)
            var own = Concept(id: "own", courseId: "course", lectureId: "lec", name: "Ghrelin", definition: "A hunger hormone.")
            try own.insert(conn)
            var theirs = Concept(id: "theirs", courseId: "course", lectureId: "other", name: "Leptin", definition: "A satiety hormone.")
            try theirs.insert(conn)
            var merged = Concept(id: "merged", courseId: "course", lectureId: "other", name: "Old", definition: "Gone.", mergedIntoId: "theirs")
            try merged.insert(conn)
        }
    }

    func testDigestReusesTheCoursesConceptsAndWritesTheLecture() async throws {
        let db = try LockinDatabase.inMemory()
        try seedDigestLecture(db)
        let provider = CannedProvider()
        provider.digestReply = LectureDigest(
            title: "  Appetite control  ",
            skipped: [DigestSkip(what: "Housekeeping", where: "start")],
            summaryMd: "## Summary\n- Ghrelin rises before meals.",
            concepts: [
                DigestConcept(existingId: "theirs", name: "Leptin", definition: "Reworded."),
                DigestConcept(existingId: "own", name: "Ghrelin", definition: "Reworded."),
                DigestConcept(name: "Satiety", definition: "Feeling full.", sourceRef: "slide 3"),
                DigestConcept(existingId: "merged", name: "Old", definition: "A dead id is minted afresh."),
            ]
        )

        let outcome = try await digestLecture(
            database: db,
            lectureId: "lec",
            keepSummary: true,
            visionNotes: nil,
            provider: provider,
            renderer: StubRenderer()
        )
        XCTAssertEqual(outcome.json.stringified(), #"{"title":"  Appetite control  ","reused":2,"minted":2,"skipped":1,"slideNotes":0}"#)

        let input = try XCTUnwrap(provider.digestInputs.first)
        XCTAssertEqual(input.currentTitle, "lecture-03.vtt")
        XCTAssertTrue(input.titleIsPlaceholder)
        XCTAssertEqual(input.transcript, "Ghrelin rises before meals.")
        XCTAssertNil(input.slidesText)
        XCTAssertNil(input.slides)
        XCTAssertEqual(Set(input.existingConcepts.map { $0.id }), ["own", "theirs"])

        let lecture = try XCTUnwrap(try syncRead(db) { conn in try Lecture.fetchOne(conn, key: "lec") })
        XCTAssertEqual(lecture.title, "Appetite control")
        XCTAssertFalse(lecture.autoTitle)
        XCTAssertEqual(lecture.summaryMd, "## Summary\n- Ghrelin rises before meals.")
        XCTAssertEqual(lecture.summaryModel, "Canned · test")
        XCTAssertEqual(lecture.skipped, #"[{"what":"Housekeeping","where":"start"}]"#)
        XCTAssertNil(lecture.slideNotes)

        let concepts = try syncRead(db) { conn in
            try Concept.fetchAll(conn, sql: #"SELECT * FROM "Concept" WHERE "lectureId" = 'lec'"#)
        }
        XCTAssertEqual(Set(concepts.map { $0.name }), ["Ghrelin", "Satiety", "Old"])
        let satiety = try XCTUnwrap(concepts.first { $0.name == "Satiety" })
        XCTAssertEqual(satiety.courseId, "course")
        XCTAssertEqual(satiety.sourceRef, "slide 3")
        XCTAssertNil(satiety.mergedIntoId)
        // The original wording of a reused concept is never overwritten.
        let theirs = try XCTUnwrap(try syncRead(db) { conn in try Concept.fetchOne(conn, key: "theirs") })
        XCTAssertEqual(theirs.definition, "A satiety hormone.")
        XCTAssertEqual(theirs.lectureId, "other")
    }

    func testARecapLectureOwnsTheConceptsItOnlyReused() async throws {
        let db = try LockinDatabase.inMemory()
        try seedDigestLecture(db)
        let provider = CannedProvider()
        provider.digestReply = LectureDigest(
            title: "Recap",
            summaryMd: "Recap.",
            concepts: [DigestConcept(existingId: "theirs", name: "Leptin", definition: "A satiety hormone.")]
        )
        let outcome = try await digestLecture(
            database: db,
            lectureId: "lec",
            keepSummary: false,
            visionNotes: nil,
            provider: provider,
            renderer: StubRenderer()
        )
        XCTAssertEqual(outcome.reused, 0)
        XCTAssertEqual(outcome.minted, 1)
        let names = try syncRead(db) { conn in
            try String.fetchAll(conn, sql: #"SELECT "name" FROM "Concept" WHERE "lectureId" = 'lec' ORDER BY "name""#)
        }
        XCTAssertEqual(names, ["Ghrelin", "Leptin"])
    }

    func testAStudentsSummaryAndTitleAreKeptUnlessRedone() async throws {
        let db = try LockinDatabase.inMemory()
        try seedDigestLecture(db, title: "Typed by me", autoTitle: false, summaryMd: "Mine.", summaryModel: "Pasted")
        let provider = CannedProvider()
        provider.digestReply = LectureDigest(title: "Model title", summaryMd: "The model's.", concepts: [])

        _ = try await digestLecture(database: db, lectureId: "lec", keepSummary: true, visionNotes: nil, provider: provider, renderer: StubRenderer())
        var lecture = try XCTUnwrap(try syncRead(db) { conn in try Lecture.fetchOne(conn, key: "lec") })
        XCTAssertEqual(lecture.title, "Typed by me")
        XCTAssertEqual(lecture.summaryMd, "Mine.")
        XCTAssertEqual(lecture.summaryModel, "Pasted")
        XCTAssertEqual(lecture.skipped, "[]")

        _ = try await digestLecture(database: db, lectureId: "lec", keepSummary: false, visionNotes: nil, provider: provider, renderer: StubRenderer())
        lecture = try XCTUnwrap(try syncRead(db) { conn in try Lecture.fetchOne(conn, key: "lec") })
        XCTAssertEqual(lecture.title, "Typed by me")
        XCTAssertEqual(lecture.summaryMd, "The model's.")
        XCTAssertEqual(lecture.summaryModel, "Canned · test")
    }

    func testSlideNotesAreWrittenIntoTheTextAndKeptOnlyForSlidesTheLectureHas() async throws {
        let db = try LockinDatabase.inMemory()
        try seedDigestLecture(db)
        try syncWrite(db) { conn in
            var deck = Material(
                lectureId: "lec",
                kind: .slides,
                path: "lec/deck.pptx",
                originalName: "deck.pptx",
                extractedText: "--- Slide 1 ---\nA\n--- Slide 2 ---\nB",
                pageCount: 3,
                checksum: "d1"
            )
            try deck.insert(conn)
        }
        let provider = CannedProvider()
        provider.digestReply = LectureDigest(title: "T", summaryMd: "S.", concepts: [])

        let outcome = try await digestLecture(
            database: db,
            lectureId: "lec",
            keepSummary: false,
            visionNotes: [SlideNote(slide: 1, notes: "seen 1"), SlideNote(slide: 5, notes: "out of range")],
            provider: provider,
            renderer: StubRenderer()
        )
        XCTAssertEqual(outcome.slideNotes, 1)
        let input = try XCTUnwrap(provider.digestInputs.first)
        // node
        XCTAssertEqual(
            input.slidesText,
            "--- Slide 1 ---\nA\n[On this slide: seen 1]\n\n\n--- Slide 2 ---\nB\n\n--- Slide 5 ---\nout of range"
        )
        XCTAssertEqual(input.slides?.lectureId, "lec")
        XCTAssertEqual(input.slides?.decks.map { $0.pages }, [3])
        XCTAssertEqual(input.slides?.decks.first?.pdf, false)
        var lecture = try XCTUnwrap(try syncRead(db) { conn in try Lecture.fetchOne(conn, key: "lec") })
        XCTAssertEqual(lecture.slideNotes, #"[{"slide":1,"notes":"seen 1"}]"#)

        // A model that saw the slides writes its own notes, which win over the offline ones.
        provider.digestReply = LectureDigest(
            title: "T",
            summaryMd: "S.",
            concepts: [],
            slideNotes: [SlideNote(slide: 2, notes: "model saw"), SlideNote(slide: 4, notes: "beyond")]
        )
        _ = try await digestLecture(
            database: db,
            lectureId: "lec",
            keepSummary: false,
            visionNotes: [SlideNote(slide: 1, notes: "seen 1")],
            provider: provider,
            renderer: StubRenderer()
        )
        lecture = try XCTUnwrap(try syncRead(db) { conn in try Lecture.fetchOne(conn, key: "lec") })
        XCTAssertEqual(lecture.slideNotes, #"[{"slide":2,"notes":"model saw"}]"#)
    }

    func testDigestingALectureThatIsGoneFailsAsPrismaDoes() async throws {
        let db = try LockinDatabase.inMemory()
        let provider = CannedProvider()
        let message = await thrownMessage {
            _ = try await digestLecture(database: db, lectureId: "gone", keepSummary: true, visionNotes: nil, provider: provider, renderer: StubRenderer())
        }
        XCTAssertEqual(message, prismaRecordNotFound)
        XCTAssertTrue(provider.digestInputs.isEmpty)
    }

    // MARK: writeQuestions

    private func seedQuestionLecture(_ db: LockinDatabase) throws {
        try syncWrite(db) { conn in
            var course = Course(id: "course", code: "PHYS2001", title: "Physiology")
            try course.insert(conn)
            var lecture = Lecture(
                id: "lec",
                courseId: "course",
                title: "Appetite",
                durationHours: 1,
                summaryMd: "Summary.",
                slideNotes: #"[{"slide":1,"notes":"Seen"}]"#
            )
            try lecture.insert(conn)
            var transcript = Material(lectureId: "lec", kind: .transcript, path: "lec/t.vtt", originalName: "t.vtt", extractedText: "Words.", checksum: "t1")
            try transcript.insert(conn)
            var k1 = Concept(id: "k1", courseId: "course", lectureId: "lec", name: "Ghrelin", definition: "Hunger hormone.")
            try k1.insert(conn)
            var k2 = Concept(id: "k2", courseId: "course", lectureId: "lec", name: "Leptin", definition: "Satiety hormone.")
            try k2.insert(conn)
            var k3 = Concept(id: "k3", courseId: "course", lectureId: "lec", name: "Dup", definition: "Merged.", mergedIntoId: "k1")
            try k3.insert(conn)
        }
    }

    private func rubric(_ answer: String) -> Rubric {
        Rubric(modelAnswer: answer, criteria: [RubricCriterion(point: "Rises before meals", marks: 10)])
    }

    func testWriteQuestionsAimsAtTheAllocationAndStoresEachQuestionOnce() async throws {
        let db = try LockinDatabase.inMemory()
        try seedQuestionLecture(db)
        let provider = CannedProvider()
        provider.questionsReply = QuestionSet(questions: [
            GeneratedQuestion(stem: "Explain ghrelin.", type: .laq, conceptIds: ["k1", "k1", "ghost"], rubric: rubric("It rises.")),
            GeneratedQuestion(stem: "About nothing.", type: .laq, conceptIds: ["ghost"], rubric: rubric("None.")),
            GeneratedQuestion(stem: "Compare them.", type: .laq, conceptIds: ["k2", "k1"], rubric: rubric("Both.")),
        ])

        let outcome = try await writeQuestions(database: db, lectureId: "lec", provider: provider)
        XCTAssertEqual(outcome.json.stringified(), #"{"generated":2,"budget":2,"targeted":2}"#)

        let input = try XCTUnwrap(provider.questionInputs.first)
        XCTAssertEqual(input.allocation, [Allocation(conceptId: "k1", count: 1), Allocation(conceptId: "k2", count: 1)])
        XCTAssertEqual(input.concepts.map { $0.id }, ["k1", "k2"])
        XCTAssertEqual(input.slidesText, "--- Slide 1 ---\nSeen")
        XCTAssertEqual(input.summary, "Summary.")
        XCTAssertEqual(input.transcript, "Words.")
        XCTAssertEqual(input.type, .laq)
        XCTAssertEqual(input.style, .mixed)
        XCTAssertEqual(input.sharedWith, [])

        let questions = try syncRead(db) { conn in
            try Question.fetchAll(conn, sql: #"SELECT * FROM "Question" WHERE "lectureId" = 'lec' ORDER BY "stem""#)
        }
        XCTAssertEqual(questions.map { $0.stem }, ["Compare them.", "Explain ghrelin."])
        guard questions.count == 2 else {
            return XCTFail("expected two questions, got \(questions.count)")
        }
        let explain = questions[1]
        XCTAssertEqual(explain.rubric, #"{"modelAnswer":"It rises.","criteria":[{"point":"Rises before meals","marks":10}],"totalMarks":10}"#)
        XCTAssertEqual(explain.promptVersion, "canned@1.0.0")
        XCTAssertEqual(explain.model, "Canned · test")
        XCTAssertEqual(explain.type, .laq)

        let links = try syncRead(db) { conn in try QuestionConcept.fetchAll(conn) }
        XCTAssertEqual(Set(links.filter { $0.questionId == explain.id }.map { $0.conceptId }), ["k1"])
        XCTAssertEqual(Set(links.filter { $0.questionId == questions[0].id }.map { $0.conceptId }), ["k1", "k2"])
        XCTAssertEqual(links.count, 3)
    }

    func testWriteQuestionsNeedsConcepts() async throws {
        let db = try LockinDatabase.inMemory()
        try syncWrite(db) { conn in
            var course = Course(id: "course", code: "PHYS2001", title: "Physiology")
            try course.insert(conn)
            var lecture = Lecture(id: "lec", courseId: "course", title: "Appetite")
            try lecture.insert(conn)
        }
        let provider = CannedProvider()
        let message = await thrownMessage {
            _ = try await writeQuestions(database: db, lectureId: "lec", provider: provider)
        }
        XCTAssertEqual(message, "this lecture has no concepts yet — prepare it first")
        let gone = await thrownMessage {
            _ = try await writeQuestions(database: db, lectureId: "gone", provider: provider)
        }
        XCTAssertEqual(gone, prismaRecordNotFound)
    }

    func testWriteQuestionsStopsWhenEveryConceptIsMastered() async throws {
        let db = try LockinDatabase.inMemory()
        try seedQuestionLecture(db)
        try syncWrite(db) { conn in
            for (id, concept) in [("q1", "k1"), ("q2", "k2")] {
                var question = Question(id: id, lectureId: "lec", stem: id, rubric: "{}", promptVersion: "v")
                try question.insert(conn)
                var link = QuestionConcept(questionId: id, conceptId: concept)
                try link.insert(conn)
            }
            var attempt = Attempt(id: "a1", lectureId: "lec")
            try attempt.insert(conn)
            var r1 = Response(id: "r1", attemptId: "a1", questionId: "q1", answerText: "x", mark: 10)
            try r1.insert(conn)
            var r2 = Response(id: "r2", attemptId: "a1", questionId: "q2", answerText: "y", mark: 10)
            try r2.insert(conn)
        }
        let provider = CannedProvider()
        let outcome = try await writeQuestions(database: db, lectureId: "lec", provider: provider)
        XCTAssertEqual(
            outcome.json.stringified(),
            #"{"generated":0,"budget":2,"note":"every concept in this lecture is already at 10/10"}"#
        )
        XCTAssertTrue(provider.questionInputs.isEmpty)
    }

    // MARK: markResponse

    private let storedRubric = #"{"modelAnswer":"It rises.","criteria":[{"point":"Rises","marks":10}],"totalMarks":10}"#

    private func seedMarking(_ db: LockinDatabase, answer: String = "Ghrelin rises before meals.", rubric: String? = nil) throws {
        let stored = rubric ?? storedRubric
        try syncWrite(db) { conn in
            var course = Course(id: "course", code: "PHYS2001", title: "Physiology")
            try course.insert(conn)
            var lecture = Lecture(id: "lec", courseId: "course", title: "Appetite")
            try lecture.insert(conn)
            var k1 = Concept(id: "k1", courseId: "course", lectureId: "lec", name: "Ghrelin", definition: "Hunger hormone.")
            try k1.insert(conn)
            var k2 = Concept(id: "k2", courseId: "course", lectureId: "lec", name: "Leptin", definition: "Satiety hormone.")
            try k2.insert(conn)
            var question = Question(id: "q1", lectureId: "lec", stem: "Explain ghrelin.", rubric: stored, promptVersion: "generate-questions@1.1.0")
            try question.insert(conn)
            var link = QuestionConcept(questionId: "q1", conceptId: "k1")
            try link.insert(conn)
            var attempt = Attempt(id: "a1", lectureId: "lec")
            try attempt.insert(conn)
            var r1 = Response(id: "r1", attemptId: "a1", questionId: "q1", answerText: answer)
            try r1.insert(conn)
            var r2 = Response(id: "r2", attemptId: "a1", questionId: "q1", answerText: "An earlier answer.", mark: 5)
            try r2.insert(conn)
            var old = Gap(responseId: "r1", conceptId: "k1", type: .wrong, text: "From an earlier marking.")
            try old.insert(conn)
        }
    }

    func testMarkingRecordsTheMarkAndGapsAndScoresTheSitting() async throws {
        let db = try LockinDatabase.inMemory()
        try seedMarking(db)
        let provider = CannedProvider()
        provider.markingReply = Marking(
            mark: 7,
            criteria: [MarkingCriterion(point: "Coverage", awarded: 4, outOf: 6)],
            gaps: [
                MarkingGap(conceptId: "k1", type: .missed, text: "Missed the timing."),
                MarkingGap(conceptId: "k2", type: .wrong, text: "Not this question's."),
            ]
        )

        let outcome = try await markResponse(database: db, responseId: "r1", provider: provider)
        XCTAssertEqual(outcome.json.stringified(), #"{"mark":7,"gaps":2}"#)

        let input = try XCTUnwrap(provider.markInputs.first)
        XCTAssertEqual(input.questionStem, "Explain ghrelin.")
        XCTAssertEqual(input.rubric, try JSONValue.parse(storedRubric))
        XCTAssertEqual(input.answerText, "Ghrelin rises before meals.")
        XCTAssertEqual(input.concepts, [ConceptRef(id: "k1", name: "Ghrelin", definition: "Hunger hormone.")])

        let response = try XCTUnwrap(try syncRead(db) { conn in try Response.fetchOne(conn, key: "r1") })
        XCTAssertEqual(response.mark, 7)
        XCTAssertEqual(response.rubricVersion, "generate-questions@1.1.0")
        XCTAssertEqual(
            response.rawMarkingJson,
            #"{"mark":7,"criteria":[{"point":"Coverage","awarded":4,"outOf":6,"note":null}],"gaps":["#
                + #"{"conceptId":"k1","type":"MISSED","text":"Missed the timing."},"#
                + #"{"conceptId":"k2","type":"WRONG","text":"Not this question's."}]}"#
        )
        XCTAssertNotNil(response.markedAt)

        // Only gaps about this question's concepts are kept; the earlier marking's are replaced.
        let gaps = try syncRead(db) { conn in
            try Gap.fetchAll(conn, sql: #"SELECT * FROM "Gap" WHERE "responseId" = 'r1'"#)
        }
        XCTAssertEqual(gaps.map { $0.conceptId }, ["k1"])
        XCTAssertEqual(gaps.first?.type, .missed)
        XCTAssertEqual(gaps.first?.text, "Missed the timing.")

        let attempt = try XCTUnwrap(try syncRead(db) { conn in try Attempt.fetchOne(conn, key: "a1") })
        XCTAssertEqual(attempt.geometricMean ?? 0, 5.916079783099616, accuracy: 1e-12)
        XCTAssertNotNil(attempt.completedAt)
    }

    func testMarkingRefusesAnEmptyAnswerAndABrokenRubric() async throws {
        let blank = try LockinDatabase.inMemory()
        try seedMarking(blank, answer: "   \n")
        let provider = CannedProvider()
        let empty = await thrownMessage {
            _ = try await markResponse(database: blank, responseId: "r1", provider: provider)
        }
        XCTAssertEqual(empty, "nothing was written for this question")

        let broken = try LockinDatabase.inMemory()
        try seedMarking(broken, rubric: "{oops")
        // node: JSON.parse's own words.
        let parse = await thrownMessage {
            _ = try await markResponse(database: broken, responseId: "r1", provider: provider)
        }
        XCTAssertEqual(parse, "Expected property name or '}' in JSON at position 1 (line 1 column 2)")
        XCTAssertTrue(provider.markInputs.isEmpty)

        let gone = await thrownMessage {
            _ = try await markResponse(database: broken, responseId: "nope", provider: provider)
        }
        XCTAssertEqual(gone, prismaRecordNotFound)
    }

    func testAnAttemptIsScoredOnlyOnceEveryAnswerHasAMark() throws {
        let db = try LockinDatabase.inMemory()
        try seedMarking(db)
        let score = try syncWrite(db) { conn in try scoreAttemptIfMarked(db: conn, attemptId: "a1") }
        XCTAssertNil(score)
        XCTAssertNil(try syncWrite(db) { conn in try scoreAttemptIfMarked(db: conn, attemptId: "no-such-attempt") })
        let attempt = try XCTUnwrap(try syncRead(db) { conn in try Attempt.fetchOne(conn, key: "a1") })
        XCTAssertNil(attempt.geometricMean)
        XCTAssertNil(attempt.completedAt)

        try syncWrite(db) { conn in
            try conn.execute(sql: #"UPDATE "Response" SET "mark" = 0 WHERE "id" = 'r1'"#)
        }
        let zero = try syncWrite(db) { conn in try scoreAttemptIfMarked(db: conn, attemptId: "a1") }
        XCTAssertEqual(zero, 0)
    }

    // MARK: SORT

    func testSortTurnsFileNumbersIntoPathsAndDropsUnknownOnes() async throws {
        let provider = CannedProvider()
        provider.sortReply = FolderSort(
            lectures: [
                FolderSortLecture(title: "L1 Appetite", module: "Gut", files: [1, 2, 9]),
                FolderSortLecture(title: "L2", files: [3]),
            ],
            setAside: [
                FolderSortSetAside(file: 4, reason: "a reading list"),
                FolderSortSetAside(file: 7, reason: "not listed"),
            ]
        )
        let files: [JSONValue] = [
            ["number": 1, "path": "wk1/L1.vtt", "detail": "transcript, 50 min", "excerpt": "Today, hunger."],
            ["number": 2, "path": "wk1/L1.pdf", "detail": "slides, 30 pages", "excerpt": "Appetite"],
            ["number": 3, "path": "wk2/L2.vtt", "detail": "transcript", "excerpt": ""],
            ["number": 4, "path": "reading.txt", "detail": "text", "excerpt": "Books"],
        ]
        let payload: JSONValue = ["root": "/Users/me/PHYS", "files": .array(files)]

        let folder = try await handleSort(payload, provider: provider)
        XCTAssertEqual(folder.lectures.map { $0.files }, [["wk1/L1.vtt", "wk1/L1.pdf"], ["wk2/L2.vtt"]])
        XCTAssertEqual(folder.setAside.map { $0.file }, ["reading.txt"])
        XCTAssertEqual(
            sortedFolderJSON(folder).stringified(),
            #"{"lectures":[{"title":"L1 Appetite","module":"Gut","files":["wk1/L1.vtt","wk1/L1.pdf"]},"#
                + #"{"title":"L2","module":null,"files":["wk2/L2.vtt"]}],"setAside":[{"file":"reading.txt","reason":"a reading list"}]}"#
        )
        XCTAssertEqual(provider.sortInputs.first?.files, [
            SortFile(number: 1, path: "wk1/L1.vtt", detail: "transcript, 50 min", excerpt: "Today, hunger."),
            SortFile(number: 2, path: "wk1/L1.pdf", detail: "slides, 30 pages", excerpt: "Appetite"),
            SortFile(number: 3, path: "wk2/L2.vtt", detail: "transcript", excerpt: ""),
            SortFile(number: 4, path: "reading.txt", detail: "text", excerpt: "Books"),
        ])

        let missing = await thrownMessage {
            _ = try await handleSort(["root": "/x"], provider: provider)
        }
        XCTAssertEqual(missing, "Cannot read properties of undefined (reading 'map')")
    }

    // MARK: Handlers

    func testOnlyTheMainLaneKindsHaveHandlers() {
        XCTAssertNotNil(mainLaneHandler(for: .prepare))
        XCTAssertNotNil(mainLaneHandler(for: .generate))
        XCTAssertNotNil(mainLaneHandler(for: .mark))
        XCTAssertNil(mainLaneHandler(for: .sort))
        XCTAssertNil(mainLaneHandler(for: .ask))
        XCTAssertNil(mainLaneHandler(for: .download))
        XCTAssertNil(mainLaneHandler(for: "SOMETHING_NEW"))
    }

    private func seedFakeLecture(_ db: LockinDatabase) throws {
        try syncWrite(db) { conn in
            var course = Course(id: "course", code: "PHYS2001", title: "Physiology")
            try course.insert(conn)
            var lecture = Lecture(id: "lec", courseId: "course", title: "lecture-07.vtt", durationHours: 1, autoTitle: true)
            try lecture.insert(conn)
            var transcript = Material(
                lectureId: "lec",
                kind: .transcript,
                path: "lec/t.vtt",
                originalName: "t.vtt",
                extractedText: fakeTranscript,
                checksum: "t1"
            )
            try transcript.insert(conn)
        }
    }

    func testPrepareDigestsThenWritesQuestionsAndSkipsWhatIsDone() async throws {
        let db = try LockinDatabase.inMemory()
        try seedFakeLecture(db)
        let payload: JSONValue = ["lectureId": "lec", "redo": false]
        let context = try seedJob(db, kind: .prepare, payload: payload, lectureId: "lec")
        let provider = FakeProvider(delayMs: 0)

        let result = try await handlePrepare(payload, context, provider)
        let object = try XCTUnwrap(result.objectValue)
        XCTAssertEqual(object.keys, ["digest", "questions"])
        XCTAssertGreaterThan(result["digest"]?["minted"]?.intValue ?? 0, 0)
        XCTAssertEqual(result["digest"]?["reused"], 0)
        XCTAssertEqual(result["questions"]?["generated"], 2)
        XCTAssertEqual(result["questions"]?["budget"], 2)

        let job = try XCTUnwrap(try syncRead(db) { conn in try Job.fetchOne(conn, key: context.jobId) })
        XCTAssertEqual(readSteps(job.steps).map { $0.stage }, [.digest, .questions])
        XCTAssertEqual(job.stage, "questions")

        let lecture = try XCTUnwrap(try syncRead(db) { conn in try Lecture.fetchOne(conn, key: "lec") })
        XCTAssertFalse(lecture.autoTitle)
        XCTAssertNotEqual(lecture.title, "lecture-07.vtt")
        XCTAssertEqual(lecture.summaryModel, "Fake (development)")
        let questions = try syncRead(db) { conn in try Question.fetchAll(conn) }
        XCTAssertEqual(questions.count, 2)
        XCTAssertEqual(questions.first?.promptVersion, "fake@0")

        // Run again: everything is done, so nothing is.
        let again = try await handlePrepare(payload, context, provider)
        XCTAssertEqual(again.stringified(), "{}")
    }

    func testPrepareOnAnOfflineModelWithNothingToLookAtGoesStraightToTheDigest() async throws {
        let db = try LockinDatabase.inMemory()
        try seedFakeLecture(db)
        let payload: JSONValue = ["lectureId": "lec"]
        let context = try seedJob(db, kind: .prepare, payload: payload, lectureId: "lec")
        let provider = OfflineCannedProvider()
        provider.digestReply = LectureDigest(
            title: "Appetite",
            summaryMd: "S.",
            concepts: [DigestConcept(name: "Ghrelin", definition: "Hunger hormone.")]
        )
        provider.questionsReply = QuestionSet(questions: [
            GeneratedQuestion(stem: "Explain.", type: .laq, conceptIds: [], rubric: rubric("A.")),
        ])

        let result = try await handlePrepare(payload, context, provider)
        XCTAssertEqual(result.objectValue?.keys, ["digest", "questions"])
        XCTAssertEqual(
            result.stringified(),
            #"{"digest":{"title":"Appetite","reused":0,"minted":1,"skipped":0,"slideNotes":0},"questions":{"generated":0,"budget":2,"targeted":1}}"#
        )
        let job = try XCTUnwrap(try syncRead(db) { conn in try Job.fetchOne(conn, key: context.jobId) })
        XCTAssertEqual(readSteps(job.steps).map { $0.stage }, [.digest, .questions])
    }

    func testGenerateDigestsALectureThatNeverWas() async throws {
        let db = try LockinDatabase.inMemory()
        try seedFakeLecture(db)
        let payload: JSONValue = ["lectureId": "lec"]
        let context = try seedJob(db, kind: .generate, payload: payload, lectureId: "lec")
        let handler = try XCTUnwrap(mainLaneHandler(for: .generate))

        let result = try await handler(payload, context, FakeProvider(delayMs: 0))
        XCTAssertEqual(result["generated"], 2)
        XCTAssertEqual(result["budget"], 2)
        XCTAssertNil(result["note"])
        let job = try XCTUnwrap(try syncRead(db) { conn in try Job.fetchOne(conn, key: context.jobId) })
        XCTAssertEqual(readSteps(job.steps).map { $0.stage }, [.digest, .questions])
    }

    func testMarkHandlerMarksTheResponseInItsOwnStage() async throws {
        let db = try LockinDatabase.inMemory()
        try seedMarking(db, answer: "Ghrelin rises before meals and falls after eating, signalling hunger to the brain.")
        let payload: JSONValue = ["responseId": "r1"]
        let context = try seedJob(db, kind: .mark, payload: payload, lectureId: "lec")

        let result = try await handleMark(payload, context, FakeProvider(delayMs: 0))
        // The fake marks by length: 13 words → 2, and names the first concept as a gap.
        XCTAssertEqual(result.stringified(), #"{"mark":2,"gaps":1}"#)
        let job = try XCTUnwrap(try syncRead(db) { conn in try Job.fetchOne(conn, key: context.jobId) })
        XCTAssertEqual(readSteps(job.steps).map { $0.stage }, [.marking])
        let response = try XCTUnwrap(try syncRead(db) { conn in try Response.fetchOne(conn, key: "r1") })
        XCTAssertEqual(response.mark, 2)
    }
}
