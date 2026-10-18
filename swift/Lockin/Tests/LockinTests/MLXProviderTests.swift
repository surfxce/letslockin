import Foundation
import XCTest
@testable import LockinCore

/// The repository's prompts/ folder, found from this file so it works from any directory.
private let repoPrompts = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("prompts", isDirectory: true)

/// One request as the provider made it.
private struct EngineCall: Equatable {
    var model: String
    var prompt: String
    var images: [String]
    var schema: JSONValue?
    var maxTokens: Int
    var temperature: Double
}

/// An engine that records each request, reports the given token counts, and replies with
/// canned text (or fails).
private final class RecordingEngine: EngineGenerating, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [EngineCall] = []
    private let reply: String
    private let tokens: [Int]
    private let failure: Error?

    init(reply: String, tokens: [Int] = [], failure: Error? = nil) {
        self.reply = reply
        self.tokens = tokens
        self.failure = failure
    }

    var calls: [EngineCall] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    private func record(_ call: EngineCall) {
        lock.lock()
        recorded.append(call)
        lock.unlock()
    }

    func generate(
        model: String,
        prompt: String,
        images: [String],
        schema: JSONValue?,
        maxTokens: Int,
        temperature: Double,
        onTokens: (@Sendable (Int) -> Void)?
    ) async throws -> String {
        record(EngineCall(model: model, prompt: prompt, images: images, schema: schema, maxTokens: maxTokens, temperature: temperature))
        for count in tokens {
            onTokens?(count)
        }
        if let failure {
            throw failure
        }
        return reply
    }

    func stop() async {}
}

/// Whatever was reported, in order, from any thread.
private final class Recorded<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Value] = []

    func add(_ item: Value) {
        lock.lock()
        items.append(item)
        lock.unlock()
    }

    var values: [Value] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}

private let ghrelin = ConceptRef(id: "c1", name: "Ghrelin", definition: "A hunger hormone.")
private let leptin = ConceptRef(id: "c2", name: "Leptin", definition: "A satiety hormone.")

private let sampleMark = MarkInput(
    questionStem: "Explain what ghrelin does.",
    rubric: ["modelAnswer": "Ghrelin rises before meals.", "criteria": [], "totalMarks": 10],
    answerText: "It rises before meals and makes you hungry.",
    concepts: [ghrelin]
)

private func provider(_ engine: any EngineGenerating) -> MLXProvider {
    MLXProvider(
        modelPath: "/models/mlx/gemma-4-e4b",
        modelName: "Gemma 4 E4B",
        modelId: "gemma-4-e4b",
        engine: engine,
        promptsDirectory: repoPrompts
    )
}

/// A stand-in `lockin-engine`: a shell script run from its own folder.
private func engineScript(_ body: String) throws -> (folder: URL, binary: URL) {
    let folder = FileManager.default.temporaryDirectory
        .appendingPathComponent("lockin-engine-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let binary = folder.appendingPathComponent("lockin-engine")
    try ("#!/bin/sh\n" + body).write(to: binary, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
    return (folder, binary)
}

/// Reads the request id the way a script can: `{"id":"12",…` → 12.
private let scriptReadId = #"id=$(printf '%s\n' "$line" | sed -n 's/^{"id":"\([0-9]*\)".*$/\1/p')"#

/// Answers every request: chatter, a broken line, progress, a line for another request,
/// more progress, then the reply. Logs each start and each request in its folder.
private let answeringScript = #"""
echo started >> starts.log
while IFS= read -r line; do
  printf '%s\n' "$line" >> requests.log
  \#(scriptReadId)
  echo 'loading weights (not JSON)'
  printf '{"id":"%s","progr\n' "$id"
  printf '{"id":"%s","progress":{"tokens":40}}\n' "$id"
  printf '{"id":"999","text":"for someone else"}\n'
  printf '{"id":"%s","progress":{"tokens":2000}}\n' "$id"
  printf '{"id":"%s","text":"{\\"mark\\":7}"}\n' "$id"
done
"""#

/// Answers only a request whose prompt is "answer me"; anything else it keeps thinking about.
private let thinkingScript = #"""
echo started >> starts.log
while IFS= read -r line; do
  printf '%s\n' "$line" >> requests.log
  \#(scriptReadId)
  case "$line" in
    *'"prompt":"answer me"'*) printf '{"id":"%s","text":"ok"}\n' "$id" ;;
  esac
done
"""#

private func contents(_ url: URL) -> String {
    (try? String(contentsOf: url, encoding: .utf8)) ?? ""
}

private func lineCount(_ url: URL) -> Int {
    contents(url).split(separator: "\n").count
}

/// Waits for something a script does, failing the test after `timeout` seconds.
private func waitUntil(timeout: TimeInterval = 10, _ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > deadline {
            XCTFail("timed out waiting for the engine")
            return
        }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
}

final class MLXProviderTests: XCTestCase {
    // MARK: - The provider (lib/llm/local.ts, runOnMlx)

    func testMarkHoldsTheReplyToItsSchemaAndSaysWhatItIsDoing() async throws {
        let engine = RecordingEngine(
            reply: #"{"mark":7.5,"criteria":[{"point":"Names ghrelin","awarded":4,"outOf":4}],"gaps":[]}"#,
            tokens: [2000]
        )
        let model = provider(engine)
        let progress = Recorded<String?>()
        model.onProgress = { progress.add($0) }

        let marking = try await model.mark(sampleMark)

        XCTAssertEqual(
            marking,
            Marking(mark: 7.5, criteria: [MarkingCriterion(point: "Names ghrelin", awarded: 4, outOf: 4, note: nil)], gaps: [])
        )
        XCTAssertEqual(engine.calls.count, 1)
        let call = try XCTUnwrap(engine.calls.first)
        XCTAssertEqual(call.model, "/models/mlx/gemma-4-e4b")
        XCTAssertEqual(call.prompt, try renderPrompt(.mark, vars: markVars(sampleMark), directory: repoPrompts).text)
        XCTAssertEqual(call.images, [])
        XCTAssertEqual(call.schema?.stringified(), strictSchema(OfflineSchemas.marking(conceptIds: ["c1"])).stringified())
        XCTAssertEqual(call.maxTokens, 1500)
        XCTAssertEqual(call.temperature, 0)
        XCTAssertEqual(progress.values, ["loading Gemma 4 E4B on MLX", "writing — about 1,500 words so far", nil])

        XCTAssertEqual(model.name, "local:Gemma 4 E4B")
        XCTAssertEqual(model.lastModel, "Offline · Gemma 4 E4B (MLX)")
        XCTAssertEqual(model.lastPromptVersion, "mark@1.0.0")
        XCTAssertFalse(model.seesSlides)
        XCTAssertEqual(model.modelId, "gemma-4-e4b")
        XCTAssertEqual(model.modelName, "Gemma 4 E4B")
        XCTAssertEqual(model.modelPath, "/models/mlx/gemma-4-e4b")
    }

    func testDigestGetsMoreRoomForALongerLectureAndNeverSeesTheSlides() async throws {
        let engine = RecordingEngine(
            reply: #"{"title":"Appetite","summaryMd":"## Ghrelin","concepts":[{"name":"Ghrelin","definition":"A hunger hormone."}]}"#
        )
        let model = provider(engine)
        let deck = SlideDeck(materialId: "m1", name: "Appetite.pdf", file: "/tmp/lockin/Appetite.pdf", pdf: true, pages: 3, first: 1)
        let input = DigestInput(
            currentTitle: "appetite-lecture",
            titleIsPlaceholder: true,
            durationHours: 1.5,
            transcript: "[00:01] Ghrelin rises before meals.",
            slidesText: "--- Slide 1 ---\nGhrelin",
            existingConcepts: [ghrelin],
            slides: SlidesInfo(lectureId: "l1", decks: [deck])
        )

        let digest = try await model.digest(input)

        XCTAssertEqual(digest.title, "Appetite")
        XCTAssertEqual(digest.concepts, [DigestConcept(existingId: nil, name: "Ghrelin", definition: "A hunger hormone.", sourceRef: nil)])
        let call = try XCTUnwrap(engine.calls.first)
        // The prompt a model that cannot see the slides gets: no slide notes asked for.
        XCTAssertEqual(call.prompt, try renderPrompt(.digestLecture, vars: digestVars(input), directory: repoPrompts).text)
        XCTAssertEqual(call.schema?.stringified(), strictSchema(OfflineSchemas.digest(existingIds: ["c1"])).stringified())
        XCTAssertEqual(call.maxTokens, 4300)
        XCTAssertEqual(call.temperature, 0.3)
        XCTAssertEqual(model.lastPromptVersion, "digest-lecture@1.2.0")

        var short = input
        short.durationHours = 0.7
        let shortEngine = RecordingEngine(reply: #"{"title":"Appetite","summaryMd":"## Ghrelin","concepts":[]}"#)
        _ = try await provider(shortEngine).digest(short)
        XCTAssertEqual(shortEngine.calls.first?.maxTokens, 3340)
    }

    func testQuestionsAreWrittenFromTheSummaryWhenThereIsOne() async throws {
        let engine = RecordingEngine(
            reply: #"""
            {"questions":[{"stem":"Explain ghrelin.","type":"LAQ","conceptIds":["c1"],"rubric":{"modelAnswer":"Ghrelin rises before meals.","criteria":[{"point":"Rises before meals","marks":5},{"point":"Makes you hungry","marks":5}],"totalMarks":10}}]}
            """#
        )
        let model = provider(engine)
        let input = GenerateQuestionsInput(
            lectureTitle: "Appetite",
            transcript: "TRANSCRIPT-TEXT",
            slidesText: "SLIDES-TEXT",
            summary: "  ## Ghrelin\nRises before meals.\n",
            concepts: [ghrelin, leptin],
            allocation: [Allocation(conceptId: "c1", count: 2), Allocation(conceptId: "c2", count: 1)]
        )

        let questionSet = try await model.generateQuestions(input)

        XCTAssertEqual(questionSet.questions.count, 1)
        XCTAssertEqual(questionSet.questions.first?.rubric.totalMarks, 10)
        var fromSummary = input
        fromSummary.transcript = "(This is the lecture's revision summary, written from its transcript and slides. "
            + "Write the questions and marking guides from it.)\n\n## Ghrelin\nRises before meals."
        fromSummary.slidesText = "(already covered in the summary above)"
        let call = try XCTUnwrap(engine.calls.first)
        XCTAssertEqual(call.prompt, try renderPrompt(.generateQuestions, vars: generateVars(fromSummary), directory: repoPrompts).text)
        XCTAssertFalse(call.prompt.contains("TRANSCRIPT-TEXT"))
        XCTAssertFalse(call.prompt.contains("SLIDES-TEXT"))
        XCTAssertEqual(
            call.schema?.stringified(),
            strictSchema(OfflineSchemas.questions(conceptIds: ["c1", "c2"], type: .laq, total: 3)).stringified()
        )
        XCTAssertEqual(call.maxTokens, 2000 * 3 + 300)
        XCTAssertEqual(call.temperature, 0.5)
        XCTAssertEqual(model.lastPromptVersion, "generate-questions@1.3.0")
    }

    func testQuestionsAreWrittenFromTheTranscriptWithoutASummary() async throws {
        let engine = RecordingEngine(reply: #"{"questions":[]}"#)
        let input = GenerateQuestionsInput(
            lectureTitle: "Appetite",
            transcript: "TRANSCRIPT-TEXT",
            slidesText: nil,
            summary: " \n\t",
            concepts: [ghrelin],
            allocation: []
        )

        _ = try await provider(engine).generateQuestions(input)

        let call = try XCTUnwrap(engine.calls.first)
        XCTAssertEqual(call.prompt, try renderPrompt(.generateQuestions, vars: generateVars(input), directory: repoPrompts).text)
        XCTAssertTrue(call.prompt.contains("TRANSCRIPT-TEXT"))
        // Nothing allocated still leaves room for one question.
        XCTAssertEqual(call.maxTokens, 2300)
    }

    func testPapersAreReadWithTheirOwnBudget() async throws {
        let engine = RecordingEngine(reply: #"{"items":[{"stem":"Explain ghrelin.","questionNumber":"1a"}]}"#)
        let input = ParsePastPaperInput(paperText: "1a. Explain ghrelin. (10 marks)", concepts: [ghrelin])

        let paper = try await provider(engine).parsePastPaper(input)

        XCTAssertEqual(paper.items, [ParsedPaperItem(questionNumber: "1a", stem: "Explain ghrelin.", marksAllocated: nil, conceptIds: [])])
        let call = try XCTUnwrap(engine.calls.first)
        XCTAssertEqual(call.prompt, try renderPrompt(.parsePastPaper, vars: paperVars(input), directory: repoPrompts).text)
        XCTAssertEqual(call.schema?.stringified(), strictSchema(OfflineSchemas.paper).stringified())
        XCTAssertEqual(call.maxTokens, 4000)
        XCTAssertEqual(call.temperature, 0)
    }

    func testSortingAndQuickQuestionsKeepQuietBesideAPreparingLecture() async throws {
        let progress = Recorded<String?>()

        let sortEngine = RecordingEngine(reply: #"{"lectures":[{"title":"Lecture 1","module":null,"files":[1,2]}]}"#, tokens: [400])
        let sorter = provider(sortEngine)
        sorter.onProgress = { progress.add($0) }
        let files = SortFilesInput(files: [
            SortFile(number: 1, path: "Appetite/Lecture 1.pdf", detail: "slides, 20 pages", excerpt: "Appetite"),
            SortFile(number: 2, path: "Appetite/Lecture 1.txt", detail: "transcript, 50 minutes", excerpt: "Welcome"),
        ])
        let sorted = try await sorter.sortFiles(files)
        XCTAssertEqual(sorted, FolderSort(lectures: [FolderSortLecture(title: "Lecture 1", module: nil, files: [1, 2])], setAside: []))
        let sortCall = try XCTUnwrap(sortEngine.calls.first)
        XCTAssertEqual(sortCall.prompt, try renderPrompt(.sortFiles, vars: sortVars(files), directory: repoPrompts).text)
        XCTAssertEqual(sortCall.schema?.stringified(), strictSchema(OfflineSchemas.sort(fileCount: 2)).stringified())
        XCTAssertEqual(sortCall.maxTokens, 240)
        XCTAssertEqual(sortCall.temperature, 0)

        let question = AskInput.question(
            AskQuestion(lectureTitle: "Appetite", summary: "## Ghrelin\nIt rises.", question: "Why do I get hungry?", headings: ["Ghrelin"])
        )
        let askEngine = RecordingEngine(reply: #"{"answer":"Ghrelin rises.","section":"Ghrelin"}"#, tokens: [10])
        let asker = provider(askEngine)
        asker.onProgress = { progress.add($0) }
        let answer = try await asker.ask(question)
        XCTAssertEqual(answer, Answer(answer: "Ghrelin rises.", section: "Ghrelin"))
        let askCall = try XCTUnwrap(askEngine.calls.first)
        XCTAssertEqual(askCall.prompt, try renderPrompt(.answerQuestion, vars: askVars(question).vars, directory: repoPrompts).text)
        XCTAssertEqual(
            askCall.schema?.stringified(),
            strictSchema(OfflineSchemas.answer(headings: ["Ghrelin"], maxLength: 2400)).stringified()
        )
        XCTAssertEqual(askCall.maxTokens, 700)
        XCTAssertEqual(askCall.temperature, 0.3)
        XCTAssertEqual(asker.lastPromptVersion, "answer-question@1.0.0")

        let breakdown = AskInput.breakdown(AskBreakdown(lectureTitle: "Appetite", summary: "## Ghrelin", selection: "ghrelin"))
        let breakdownEngine = RecordingEngine(reply: #"{"answer":"In short: hunger.","section":null}"#)
        _ = try await provider(breakdownEngine).ask(breakdown)
        let breakdownCall = try XCTUnwrap(breakdownEngine.calls.first)
        XCTAssertEqual(breakdownCall.schema?.stringified(), strictSchema(OfflineSchemas.answer(headings: [], maxLength: 900)).stringified())
        XCTAssertEqual(breakdownCall.maxTokens, 300)

        let leftOut = AskInput.leftout(
            AskLeftOut(lectureTitle: "Appetite", what: "Module aims", where: "slide 2", transcript: "[00:01] Today's aims.")
        )
        let leftOutEngine = RecordingEngine(reply: #"{"answer":"The aims.","section":null}"#)
        let leftOutModel = provider(leftOutEngine)
        _ = try await leftOutModel.ask(leftOut)
        let leftOutCall = try XCTUnwrap(leftOutEngine.calls.first)
        XCTAssertEqual(leftOutCall.prompt, try renderPrompt(.leftOut, vars: askVars(leftOut).vars, directory: repoPrompts).text)
        XCTAssertEqual(leftOutCall.maxTokens, 300)
        XCTAssertEqual(leftOutModel.lastPromptVersion, "left-out@1.0.0")

        XCTAssertEqual(progress.values.count, 0)
    }

    func testAnUnfinishedReplySaysTheModelStoppedEarly() async throws {
        let model = provider(RecordingEngine(reply: #"{"mark":7,"criteria":[{"point":"#))
        do {
            _ = try await model.mark(sampleMark)
            XCTFail("an unfinished reply was accepted")
        } catch {
            XCTAssertEqual(
                error as? LockinError,
                LockinError("the offline model stopped before finishing its answer — try a smaller model, or close other apps to free memory")
            )
        }
    }

    func testAReplyMissingPartsNamesUpToThreeOfThem() async throws {
        // Expected texts from local.ts `checked` against zod 4, run in node.
        let cases: [(String, String)] = [
            (#"{"mark":5}"#, "the offline model's answer was missing parts (criteria, gaps) — try again, or use a larger model"),
            (
                #"{"mark":12,"criteria":[{"point":1,"awarded":-1,"outOf":2}],"gaps":[{"conceptId":"c1","type":"OOPS","text":""}]}"#,
                "the offline model's answer was missing parts (mark, criteria.point, criteria.awarded) — try again, or use a larger model"
            ),
            ("[]", "the offline model's answer was missing parts — try again, or use a larger model"),
        ]
        for (reply, expected) in cases {
            do {
                _ = try await provider(RecordingEngine(reply: reply)).mark(sampleMark)
                XCTFail("\(reply) was accepted")
            } catch {
                XCTAssertEqual(error as? LockinError, LockinError(expected), reply)
            }
        }

        let breakdown = AskInput.breakdown(AskBreakdown(lectureTitle: "Appetite", summary: "## Ghrelin", selection: "ghrelin"))
        do {
            _ = try await provider(RecordingEngine(reply: #"{"answer":""}"#)).ask(breakdown)
            XCTFail("an empty answer was accepted")
        } catch {
            XCTAssertEqual(
                error as? LockinError,
                LockinError("the offline model's answer was missing parts (answer) — try again, or use a larger model")
            )
        }

        let files = SortFilesInput(files: [SortFile(number: 1, path: "a.pdf", detail: "slides", excerpt: "")])
        do {
            _ = try await provider(RecordingEngine(reply: #"{"lectures":[{"title":"A","files":[0]}]}"#)).sortFiles(files)
            XCTFail("file 0 was accepted")
        } catch {
            XCTAssertEqual(
                error as? LockinError,
                LockinError("the offline model's answer was missing parts (lectures.files) — try again, or use a larger model")
            )
        }
    }

    func testACancelledJobStopsTheCall() async throws {
        let model = provider(RecordingEngine(reply: "{}", failure: CancellationError()))
        do {
            _ = try await model.mark(sampleMark)
            XCTFail("a cancelled call went on")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
    }

    func testWordsSoFarAreRoundedAndGroupedTheEnglishWay() {
        // Math.round(tokens * 0.75).toLocaleString("en"), from node.
        let expected: [(Int, String)] = [
            (0, "0"), (1, "1"), (2, "2"), (3, "2"), (1333, "1,000"), (1334, "1,001"), (2000, "1,500"), (4000, "3,000"),
            (13_333_334, "10,000,001"),
        ]
        for (tokens, words) in expected {
            XCTAssertEqual(mlxWordsSoFar(tokens), words, "\(tokens) tokens")
        }
    }

    // MARK: - The engine (lib/llm/mlx.ts)

    func testARequestIsTheLineTheWorkerWrites() throws {
        // JSON.stringify({ id, op: "generate", ...body }), from node.
        let schema: JSONValue = [
            "type": "object",
            "properties": ["answer": ["type": "string", "minLength": 1]],
            "required": ["answer"],
            "additionalProperties": false,
        ]
        let looking = MLXEngine.requestLine(
            id: "7",
            model: "/Users/me/models/mlx/gemma-4-e4b",
            prompt: "Say \"hi\" — then stop.\n</end>\t",
            images: ["/tmp/slides/1.png"],
            schema: schema,
            maxTokens: 350,
            temperature: 0.1
        )
        XCTAssertEqual(
            looking,
            #"{"id":"7","op":"generate","model":"/Users/me/models/mlx/gemma-4-e4b","prompt":"Say \"hi\" — then stop.\n</end>\t","images":["/tmp/slides/1.png"],"schema":{"type":"object","properties":{"answer":{"type":"string","minLength":1}},"required":["answer"],"additionalProperties":false},"maxTokens":350,"temperature":0.1}"#
                + "\n"
        )

        let marking = MLXEngine.requestLine(
            id: "1",
            model: "/m",
            prompt: "Mark this.",
            images: [],
            schema: nil,
            maxTokens: 1500,
            temperature: 0
        )
        XCTAssertEqual(marking, #"{"id":"1","op":"generate","model":"/m","prompt":"Mark this.","maxTokens":1500,"temperature":0}"# + "\n")
    }

    func testARequestKeepsToOneLineWhateverThePromptHolds() throws {
        let prompt = "a\u{2028}b\u{2029}c\u{0085}d\r\ne"
        let line = MLXEngine.requestLine(id: "1", model: "/m", prompt: prompt, images: [], schema: nil, maxTokens: 10, temperature: 0)
        XCTAssertTrue(line.hasSuffix("\n"))
        let body = String(line.dropLast())
        let breaks: Set<Unicode.Scalar> = ["\n", "\r", "\u{2028}", "\u{2029}", "\u{0085}"]
        XCTAssertFalse(body.unicodeScalars.contains { breaks.contains($0) }, "a raw line break in the request")
        XCTAssertTrue(body.contains(#"a b c\u0085d\r\ne"#))
        XCTAssertEqual(try JSONValue.parse(body)["prompt"], JSONValue.string(prompt))
    }

    func testGuidedGenerationErrorsAreSaidPlainly() {
        XCTAssertEqual(
            mlxPlainly("The operation couldn’t be completed. (MLXGuidedGeneration.GuidedGenerationError error 0.)"),
            "the model ran out of room before finishing its answer — try again, or a larger model"
        )
        XCTAssertEqual(
            mlxPlainly("MLXGuidedGeneration.GuidedGenerationError error 1."),
            "the model stopped before finishing its answer — try again"
        )
        XCTAssertEqual(mlxPlainly("no model at /models/x"), "no model at /models/x")
    }

    func testTheEngineAnswersOverLinesOfJSON() async throws {
        let (folder, binary) = try engineScript(answeringScript)
        defer { try? FileManager.default.removeItem(at: folder) }
        let engine = MLXEngine(binary: binary, idleTimeout: 60)
        let tokens = Recorded<Int>()

        let text = try await engine.generate(
            model: "/m",
            prompt: "Mark this.",
            images: [],
            schema: nil,
            maxTokens: 1500,
            temperature: 0,
            onTokens: { tokens.add($0) }
        )

        XCTAssertEqual(text, #"{"mark":7}"#)
        // Progress comes before the answer it belongs to; other requests' lines are not ours.
        XCTAssertEqual(tokens.values, [40, 2000])
        XCTAssertEqual(
            contents(folder.appendingPathComponent("requests.log")),
            #"{"id":"1","op":"generate","model":"/m","prompt":"Mark this.","maxTokens":1500,"temperature":0}"# + "\n"
        )

        // The same engine, still loaded, takes the next request.
        let again = try await engine.generate(
            model: "/m",
            prompt: "Again.",
            images: ["/tmp/slide.png"],
            schema: nil,
            maxTokens: 350,
            temperature: 0.1,
            onTokens: nil
        )
        XCTAssertEqual(again, #"{"mark":7}"#)
        XCTAssertEqual(lineCount(folder.appendingPathComponent("starts.log")), 1)
        XCTAssertTrue(contents(folder.appendingPathComponent("requests.log")).contains(#"{"id":"2","op":"generate","model":"/m","prompt":"Again.","images":["/tmp/slide.png"],"maxTokens":350"#))

        await engine.stop()
    }

    func testTheEnginesErrorsAreWordedPlainly() async throws {
        let (folder, binary) = try engineScript(#"""
        while IFS= read -r line; do
          \#(scriptReadId)
          printf '{"id":"%s","error":"The operation couldn’t be completed. (MLXGuidedGeneration.GuidedGenerationError error 0.)"}\n' "$id"
        done
        """#)
        defer { try? FileManager.default.removeItem(at: folder) }
        let engine = MLXEngine(binary: binary, idleTimeout: 60)

        do {
            _ = try await engine.generate(model: "/m", prompt: "p", images: [], schema: nil, maxTokens: 10, temperature: 0, onTokens: nil)
            XCTFail("an error was taken for an answer")
        } catch {
            XCTAssertEqual(
                error as? LockinError,
                LockinError("MLX: the model ran out of room before finishing its answer — try again, or a larger model")
            )
        }

        await engine.stop()
    }

    func testAnEngineThatStopsFailsWithItsLastWords() async throws {
        let (folder, binary) = try engineScript(#"""
        while IFS= read -r line; do
          echo 'loading the model' >&2
          echo 'fatal: out of memory' >&2
          exit 3
        done
        """#)
        defer { try? FileManager.default.removeItem(at: folder) }
        let engine = MLXEngine(binary: binary, idleTimeout: 60)

        do {
            _ = try await engine.generate(model: "/m", prompt: "p", images: [], schema: nil, maxTokens: 10, temperature: 0, onTokens: nil)
            XCTFail("a stopped engine answered")
        } catch {
            XCTAssertEqual(error as? LockinError, LockinError("the MLX engine stopped (exit 3): fatal: out of memory"))
        }

        await engine.stop()
    }

    func testCancellingEndsTheEngineAndTheNextRequestStartsItAgain() async throws {
        let (folder, binary) = try engineScript(thinkingScript)
        defer { try? FileManager.default.removeItem(at: folder) }
        let engine = MLXEngine(binary: binary, idleTimeout: 60)
        let requests = folder.appendingPathComponent("requests.log")

        let thinking = Task {
            try await engine.generate(model: "/m", prompt: "think forever", images: [], schema: nil, maxTokens: 10, temperature: 0, onTokens: nil)
        }
        try await waitUntil { contents(requests).contains("think forever") }
        thinking.cancel()
        do {
            _ = try await thinking.value
            XCTFail("a cancelled request answered")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }

        let answer = try await engine.generate(model: "/m", prompt: "answer me", images: [], schema: nil, maxTokens: 10, temperature: 0, onTokens: nil)
        XCTAssertEqual(answer, "ok")
        XCTAssertEqual(lineCount(folder.appendingPathComponent("starts.log")), 2)

        await engine.stop()
    }

    func testStoppingTheEngineFailsWhatItWasDoing() async throws {
        let (folder, binary) = try engineScript(thinkingScript)
        defer { try? FileManager.default.removeItem(at: folder) }
        let engine = MLXEngine(binary: binary, idleTimeout: 60)
        let requests = folder.appendingPathComponent("requests.log")

        let thinking = Task {
            try await engine.generate(model: "/m", prompt: "think forever", images: [], schema: nil, maxTokens: 10, temperature: 0, onTokens: nil)
        }
        try await waitUntil { contents(requests).contains("think forever") }
        await engine.stop()
        do {
            _ = try await thinking.value
            XCTFail("a stopped engine answered")
        } catch {
            XCTAssertEqual(error as? LockinError, LockinError("the MLX engine stopped (SIGKILL)"))
        }
    }

    func testAnIdleEngineIsLetGo() async throws {
        let (folder, binary) = try engineScript(answeringScript)
        defer { try? FileManager.default.removeItem(at: folder) }
        let engine = MLXEngine(binary: binary, idleTimeout: 0.2)
        let starts = folder.appendingPathComponent("starts.log")

        _ = try await engine.generate(model: "/m", prompt: "one", images: [], schema: nil, maxTokens: 10, temperature: 0, onTokens: nil)
        XCTAssertEqual(lineCount(starts), 1)
        try await Task.sleep(nanoseconds: 1_500_000_000)
        _ = try await engine.generate(model: "/m", prompt: "two", images: [], schema: nil, maxTokens: 10, temperature: 0, onTokens: nil)
        XCTAssertEqual(lineCount(starts), 2)

        await engine.stop()
    }

    func testAnEngineThatWillNotStartSaysSo() async throws {
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("lockin-no-engine-\(UUID().uuidString)")
            .appendingPathComponent("lockin-engine")
        let engine = MLXEngine(binary: missing, idleTimeout: 60)
        do {
            _ = try await engine.generate(model: "/m", prompt: "p", images: [], schema: nil, maxTokens: 10, temperature: 0, onTokens: nil)
            XCTFail("a missing engine answered")
        } catch {
            let message = (error as? LockinError)?.message ?? "\(error)"
            XCTAssertTrue(message.hasPrefix("the MLX engine couldn't start: "), message)
        }
    }
}
