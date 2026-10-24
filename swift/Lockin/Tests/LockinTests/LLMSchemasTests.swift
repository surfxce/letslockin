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

/// A cloud engine that answers from a script, recording what it was sent.
private final class ScriptedProvider: PromptProvider, @unchecked Sendable {
    let name = "scripted"
    let seesSlides: Bool
    let report = ProviderReport()
    let promptsDirectory: URL = repoPrompts
    let repairsAnyFailure: Bool
    private let lock = NSLock()
    private var replies: [Result<Reply, Error>]
    private var sent: [(prompt: String, options: CallOptions)] = []

    init(seesSlides: Bool = false, repairsAnyFailure: Bool = false, replies: [Result<Reply, Error>]) {
        self.seesSlides = seesSlides
        self.repairsAnyFailure = repairsAnyFailure
        self.replies = replies
        report.lastModel = label(model: nil)
    }

    var prompts: [String] {
        lock.lock()
        defer { lock.unlock() }
        return sent.map { $0.prompt }
    }

    var options: [CallOptions] {
        lock.lock()
        defer { lock.unlock() }
        return sent.map { $0.options }
    }

    func label(model: String?) -> String {
        "Scripted · \(model ?? "default")"
    }

    private func next(_ prompt: String, _ options: CallOptions) -> Result<Reply, Error> {
        lock.lock()
        defer { lock.unlock() }
        sent.append((prompt: prompt, options: options))
        if replies.isEmpty {
            return .failure(CloudError("no more replies"))
        }
        return replies.removeFirst()
    }

    func complete(_ prompt: String, options: CallOptions) async throws -> Reply {
        try next(prompt, options).get()
    }
}

private let concept = ConceptRef(id: "c1", name: "Ghrelin", definition: "A hunger hormone.")

final class LLMSchemasTests: XCTestCase {
    // MARK: Parsing replies as zod does

    func testDigestTakesZodDefaults() throws {
        let reply = try JSONValue.parse(#"{"title":"T","summaryMd":"S","concepts":[{"name":"N","definition":"D"}],"skipped":[{"what":"W"}],"extra":1}"#)
        let digest = try LectureDigest.parse(reply)
        XCTAssertEqual(digest.skipped, [DigestSkip(what: "W", where: "", about: "")])
        XCTAssertEqual(digest.concepts, [DigestConcept(existingId: nil, name: "N", definition: "D", sourceRef: nil)])
        XCTAssertEqual(digest.slideNotes, [])
        // What zod's parse returned, as JSON.stringify writes it: defaults filled in, extras dropped.
        XCTAssertEqual(
            digest.json.stringified(),
            #"{"title":"T","skipped":[{"what":"W","where":"","about":""}],"summaryMd":"S","concepts":[{"existingId":null,"name":"N","definition":"D","sourceRef":null}],"slideNotes":[]}"#
        )
        XCTAssertNoThrow(try digest.validate())
    }

    func testIssuesReadExactlyAsZodPrintsThem() throws {
        let cases: [(String, String, String)] = [
        ("question", #"{"questions":[{"stem":"","type":"X","conceptIds":[],"rubric":{"modelAnswer":"m","criteria":[{"point":"p","marks":11}],"totalMarks":9}}]}"#, #"""
            [
              {
                "origin": "string",
                "code": "too_small",
                "minimum": 1,
                "inclusive": true,
                "path": [
                  "questions",
                  0,
                  "stem"
                ],
                "message": "Too small: expected string to have >=1 characters"
              },
              {
                "code": "invalid_value",
                "values": [
                  "LAQ",
                  "SAQ"
                ],
                "path": [
                  "questions",
                  0,
                  "type"
                ],
                "message": "Invalid option: expected one of \"LAQ\"|\"SAQ\""
              },
              {
                "origin": "array",
                "code": "too_small",
                "minimum": 1,
                "inclusive": true,
                "path": [
                  "questions",
                  0,
                  "conceptIds"
                ],
                "message": "Too small: expected array to have >=1 items"
              },
              {
                "origin": "number",
                "code": "too_big",
                "maximum": 10,
                "inclusive": true,
                "path": [
                  "questions",
                  0,
                  "rubric",
                  "criteria",
                  0,
                  "marks"
                ],
                "message": "Too big: expected number to be <=10"
              },
              {
                "code": "invalid_value",
                "values": [
                  10
                ],
                "path": [
                  "questions",
                  0,
                  "rubric",
                  "totalMarks"
                ],
                "message": "Invalid input: expected 10"
              }
            ]
            """#),
        ("marking", #"{"mark":11,"criteria":[{"point":"p","awarded":-1,"outOf":4}],"gaps":[{"conceptId":"c","type":"Y","text":""}]}"#, #"""
            [
              {
                "origin": "number",
                "code": "too_big",
                "maximum": 10,
                "inclusive": true,
                "path": [
                  "mark"
                ],
                "message": "Too big: expected number to be <=10"
              },
              {
                "origin": "number",
                "code": "too_small",
                "minimum": 0,
                "inclusive": true,
                "path": [
                  "criteria",
                  0,
                  "awarded"
                ],
                "message": "Too small: expected number to be >=0"
              },
              {
                "code": "invalid_value",
                "values": [
                  "MISSED",
                  "WRONG"
                ],
                "path": [
                  "gaps",
                  0,
                  "type"
                ],
                "message": "Invalid option: expected one of \"MISSED\"|\"WRONG\""
              },
              {
                "origin": "string",
                "code": "too_small",
                "minimum": 1,
                "inclusive": true,
                "path": [
                  "gaps",
                  0,
                  "text"
                ],
                "message": "Too small: expected string to have >=1 characters"
              }
            ]
            """#),
        ("digest", #"{"title":5,"summaryMd":"S","concepts":"x","slideNotes":[{"slide":0.5,"notes":"n"}]}"#, #"""
            [
              {
                "expected": "string",
                "code": "invalid_type",
                "path": [
                  "title"
                ],
                "message": "Invalid input: expected string, received number"
              },
              {
                "expected": "array",
                "code": "invalid_type",
                "path": [
                  "concepts"
                ],
                "message": "Invalid input: expected array, received string"
              },
              {
                "expected": "int",
                "format": "safeint",
                "code": "invalid_type",
                "path": [
                  "slideNotes",
                  0,
                  "slide"
                ],
                "message": "Invalid input: expected int, received number"
              }
            ]
            """#),
        ("folder", #"{"lectures":[{"title":"L","files":[0,2]}],"setAside":null}"#, #"""
            [
              {
                "origin": "number",
                "code": "too_small",
                "minimum": 1,
                "inclusive": true,
                "path": [
                  "lectures",
                  0,
                  "files",
                  0
                ],
                "message": "Too small: expected number to be >=1"
              },
              {
                "expected": "array",
                "code": "invalid_type",
                "path": [
                  "setAside"
                ],
                "message": "Invalid input: expected array, received null"
              }
            ]
            """#),
        ("notObject", #"[1]"#, #"""
            [
              {
                "expected": "object",
                "code": "invalid_type",
                "path": [],
                "message": "Invalid input: expected object, received array"
              }
            ]
            """#),
        ]
        for (name, input, expected) in cases {
            let value = try JSONValue.parse(input)
            let thrown: Error?
            do {
                switch name {
                case "question": _ = try QuestionSet.parse(value)
                case "marking": _ = try Marking.parse(value)
                case "folder": _ = try FolderSort.parse(value)
                default: _ = try LectureDigest.parse(value)
                }
                thrown = nil
            } catch {
                thrown = error
            }
            guard let failure = thrown as? LLMValidationError else {
                XCTFail("\(name): expected a validation error, got \(String(describing: thrown))")
                continue
            }
            XCTAssertEqual(failure.message, expected, name)
            XCTAssertEqual(messageOf(failure), expected, name)
        }
    }

    func testNumbersJavaScriptCannotHoldReadAsZodSaysThem() throws {
        // 1e20 is past the safe integers; JSON.parse reads 1e400 as Infinity.
        let files = try JSONValue.parse(#"{"lectures":[{"title":"L","files":[0.5,1e20,-1e20]}]}"#)
        XCTAssertThrowsError(try FolderSort.parse(files)) { error in
            XCTAssertEqual(
                (error as? LLMValidationError)?.message,
                #"""
                [
                  {
                    "expected": "int",
                    "format": "safeint",
                    "code": "invalid_type",
                    "path": [
                      "lectures",
                      0,
                      "files",
                      0
                    ],
                    "message": "Invalid input: expected int, received number"
                  },
                  {
                    "code": "too_big",
                    "maximum": 9007199254740991,
                    "note": "Integers must be within the safe integer range.",
                    "origin": "int",
                    "inclusive": true,
                    "path": [
                      "lectures",
                      0,
                      "files",
                      1
                    ],
                    "message": "Too big: expected int to be <=9007199254740991"
                  },
                  {
                    "code": "too_small",
                    "minimum": -9007199254740991,
                    "note": "Integers must be within the safe integer range.",
                    "origin": "int",
                    "inclusive": true,
                    "path": [
                      "lectures",
                      0,
                      "files",
                      2
                    ],
                    "message": "Too small: expected int to be >=-9007199254740991"
                  },
                  {
                    "origin": "number",
                    "code": "too_small",
                    "minimum": 1,
                    "inclusive": true,
                    "path": [
                      "lectures",
                      0,
                      "files",
                      2
                    ],
                    "message": "Too small: expected number to be >=1"
                  }
                ]
                """#
            )
        }

        let huge = try JSONValue.parse(#"{"mark":1e400,"criteria":[],"gaps":[]}"#)
        XCTAssertThrowsError(try Marking.parse(huge)) { error in
            XCTAssertEqual(
                (error as? LLMValidationError)?.message,
                #"""
                [
                  {
                    "expected": "number",
                    "code": "invalid_type",
                    "received": "Infinity",
                    "path": [
                      "mark"
                    ],
                    "message": "Invalid input: expected number, received Infinity"
                  }
                ]
                """#
            )
        }
    }

    func testKeyPathsNameTheWrongPartsAsTheOfflineProviderDoes() throws {
        let value = try JSONValue.parse(#"{"questions":[{"stem":"","type":"X","conceptIds":[],"rubric":{"modelAnswer":"m","criteria":[{"point":"p","marks":11}],"totalMarks":9}}]}"#)
        let expected: [String] = [
            "questions.stem", "questions.type", "questions.conceptIds", "questions.rubric.criteria.marks", "questions.rubric.totalMarks",
        ]
        XCTAssertThrowsError(try QuestionSet.parse(value)) { error in
            XCTAssertEqual((error as? LLMValidationError)?.keyPaths, expected)
        }
    }

    func testRepliesDecodeAndEncodeThroughCodable() throws {
        let marking = try JSONDecoder().decode(Marking.self, from: Data(#"{"mark":7.5,"criteria":[{"point":"p","awarded":3,"outOf":4}],"gaps":[]}"#.utf8))
        XCTAssertEqual(marking, Marking(mark: 7.5, criteria: [MarkingCriterion(point: "p", awarded: 3, outOf: 4, note: nil)], gaps: []))
        XCTAssertEqual(marking.json.stringified(), #"{"mark":7.5,"criteria":[{"point":"p","awarded":3,"outOf":4,"note":null}],"gaps":[]}"#)
        XCTAssertThrowsError(try JSONDecoder().decode(Answer.self, from: Data(#"{"answer":""}"#.utf8)))

        let rubric = Rubric(modelAnswer: "M", criteria: [RubricCriterion(point: "P", marks: 4)])
        XCTAssertEqual(rubric.json.stringified(), #"{"modelAnswer":"M","criteria":[{"point":"P","marks":4}],"totalMarks":10}"#)
        XCTAssertEqual(try Rubric.parse(rubric.json), rubric)
    }

    // MARK: Pulling JSON out of a reply

    func testExtractJson() throws {
        let expectedObject: JSONValue = ["a": 1]
        let expectedArray: JSONValue = ["a": [1]]
        XCTAssertEqual(try extractJson("Here:\n```json\n{\"a\":1}\n```\nThanks"), expectedObject)
        XCTAssertEqual(try extractJson("Sure! {\"a\": [1]} hope that helps"), expectedArray)
        XCTAssertEqual(try extractJson("  {\"a\":1}  "), expectedObject)

        XCTAssertThrowsError(try extractJson("no json here")) { error in
            XCTAssertEqual(error as? CloudError, CloudError("no JSON found in reply: no json here"))
            XCTAssertTrue((error as? CloudError)?.isUnusableReply == true)
        }
        XCTAssertThrowsError(try extractJson("] then [")) { error in
            XCTAssertEqual(error as? CloudError, CloudError("unbalanced JSON in reply: ] then ["))
        }
        XCTAssertThrowsError(try extractJson("{ not json }")) { error in
            XCTAssertTrue(error is JSONParseError)
            XCTAssertEqual(messageOf(error), "Expected property name or '}' in JSON at position 2 (line 1 column 3)")
            XCTAssertTrue(isCloudFailure(error))
        }
        XCTAssertThrowsError(try extractJson(#"Sure: {"answer": "yes", } hope that helps"#)) { error in
            XCTAssertEqual(messageOf(error), "Expected double-quoted property name in JSON at position 18 (line 1 column 19)")
        }
    }

    func testWhatCountsAsTheCloudFailing() {
        XCTAssertTrue(isCloudFailure(CloudError("signed out")))
        XCTAssertTrue(isCloudFailure(LLMValidationError(issues: [])))
        XCTAssertTrue(isCloudFailure(JSONParseError("Unexpected end of JSON input")))
        XCTAssertFalse(isCloudFailure(LockinError("this lecture has no concepts yet — prepare it first")))
        XCTAssertFalse(isCloudFailure(CancellationError()))
        XCTAssertEqual(messageOf(CancellationError()), "Cancelled")
    }

    // MARK: The shared prompt flow (lib/llm/base.ts)

    func testAnUnusableReplyGetsOneRepairPass() async throws {
        let provider = ScriptedProvider(replies: [
            .success(Reply(text: "not json at all")),
            .success(Reply(text: #"{"answer":"Yes","section":null}"#, model: "m2")),
        ])
        let answer = try await provider.ask(.breakdown(AskBreakdown(lectureTitle: "T", summary: "S", selection: "X")))
        XCTAssertEqual(answer, Answer(answer: "Yes", section: nil))
        XCTAssertEqual(provider.lastPromptVersion, "break-down@1.0.0")
        XCTAssertEqual(provider.lastModel, "Scripted · m2")
        let prompts = provider.prompts
        XCTAssertEqual(prompts.count, 2)
        XCTAssertTrue(prompts[1].hasPrefix(prompts[0]))
        XCTAssertTrue(prompts[1].hasSuffix(
            "\n\nYour previous reply could not be used: no JSON found in reply: not json at all\n"
                + "Reply again with valid JSON matching the schema exactly. No prose, no code fences."
        ))
        XCTAssertEqual(provider.options.map { $0.task }, [.ask, .ask])
    }

    func testAReplyThatFailsTheSchemaGetsARepairPassToo() async throws {
        let provider = ScriptedProvider(replies: [
            .success(Reply(text: #"{"answer":""}"#)),
            .success(Reply(text: #"{"answer":"Fixed"}"#)),
        ])
        let answer = try await provider.ask(.question(AskQuestion(lectureTitle: "T", summary: "S", question: "Q", headings: [])))
        XCTAssertEqual(answer.answer, "Fixed")
        XCTAssertTrue(provider.prompts[1].contains("Too small: expected string to have >=1 characters"))
    }

    func testAFailureToReachTheEngineIsNotAskedAgain() async {
        let provider = ScriptedProvider(replies: [.failure(CloudError("Codex isn't signed in"))])
        do {
            _ = try await provider.mark(MarkInput(questionStem: "Q", rubric: ["totalMarks": 10], answerText: "A", concepts: [concept]))
            XCTFail("expected the failure to come through")
        } catch {
            XCTAssertEqual(error as? CloudError, CloudError("Codex isn't signed in"))
        }
        XCTAssertEqual(provider.prompts.count, 1)
        XCTAssertEqual(provider.lastPromptVersion, "mark@1.0.0")

        let claude = ScriptedProvider(repairsAnyFailure: true, replies: [
            .failure(CloudError("claude timed out after 600000ms")),
            .success(Reply(text: #"{"mark":5,"criteria":[],"gaps":[]}"#)),
        ])
        let marking = try? await claude.mark(MarkInput(questionStem: "Q", rubric: ["totalMarks": 10], answerText: "A", concepts: [concept]))
        XCTAssertEqual(marking?.mark, 5)
        XCTAssertEqual(claude.prompts.count, 2)
    }

    func testOnlyAnEngineThatSeesSlidesIsGivenThem() async throws {
        let deck = SlideDeck(materialId: "m1", name: "deck.pdf", file: "/tmp/deck.pdf", pdf: true, pages: 2, first: 1)
        let input = DigestInput(
            currentTitle: "T",
            titleIsPlaceholder: false,
            durationHours: 1,
            transcript: "Words.",
            slides: SlidesInfo(lectureId: "l1", decks: [deck])
        )
        let reply = Reply(text: #"{"title":"T","summaryMd":"S","concepts":[]}"#)

        let seeing = ScriptedProvider(seesSlides: true, replies: [.success(reply)])
        _ = try await seeing.digest(input)
        XCTAssertEqual(seeing.options.first?.slides?.lectureId, "l1")
        XCTAssertTrue(seeing.prompts.first?.contains("For every slide this lecture covers") == true)

        let blind = ScriptedProvider(seesSlides: false, replies: [.success(reply)])
        _ = try await blind.digest(input)
        XCTAssertNil(blind.options.first?.slides)
        XCTAssertTrue(blind.prompts.first?.contains("Leave `slideNotes` as an empty list.") == true)
        XCTAssertEqual(blind.lastPromptVersion, "digest-lecture@1.2.0")
    }

    func testAMisconfiguredEngineSaysWhatIsMissing() async {
        let provider = MisconfiguredProvider(what: "Anthropic API", problem: "Add your Anthropic API key in Settings")
        XCTAssertEqual(provider.lastModel, "Anthropic API")
        do {
            _ = try await provider.complete("Sort these.", options: CallOptions(task: .sort))
            XCTFail("expected the problem to come through")
        } catch {
            XCTAssertEqual(messageOf(error), "Add your Anthropic API key in Settings")
            XCTAssertTrue(isCloudFailure(error))
        }
    }

    func testNotesForSlidesGivenAsPicturesOrPDFs() {
        XCTAssertEqual(picturesNote([], total: 3), "")
        let note = picturesNote([SlidePicture(slide: 1, file: "/a.png"), SlidePicture(slide: 2, file: "/b.png")], total: 5)
        XCTAssertTrue(note.hasPrefix("\n\n---\n\nThe slides are attached as 2 pictures, in order: the first is slide 1, the last slide 2 (the rest are only in the slide text above). The slide text"))
        let decks = SlidesInfo(lectureId: "l", decks: [
            SlideDeck(materialId: "a", name: "One.pdf", file: "/one.pdf", pdf: true, pages: 3, first: 1),
            SlideDeck(materialId: "b", name: "Two.pptx", file: "/two.pptx", pdf: false, pages: 4, first: 4),
        ])
        XCTAssertTrue(decksNote(decks).contains("listed:\n\n- One.pdf: slides 1–3\n\nUse those numbers"))
        XCTAssertEqual(pdfSlideCount(decks), 3)
    }

    // MARK: The fake provider (lib/llm/fake.ts)

    func testFakeProviderLiftsItsOutputFromTheText() async throws {
        let fake = FakeProvider(delayMs: 0)
        XCTAssertEqual(fake.lastModel, "Fake (development)")
        XCTAssertEqual(fake.lastPromptVersion, "fake@0")

        let transcript = "[00:01] Insulin resistance develops when muscle cells stop responding to insulin signals. "
            + "Insulin resistance raises blood glucose over many years in most adults. "
            + "The pancreas then makes more insulin to keep blood glucose normal for a while."
        let digest = try await fake.digest(DigestInput(currentTitle: "file", titleIsPlaceholder: true, durationHours: 1, transcript: transcript))
        XCTAssertEqual(digest.title, "Insulin resistance & Blood glucose")
        XCTAssertEqual(digest.concepts.count, 6)
        XCTAssertEqual(digest.concepts.first?.name, "Insulin resistance")
        XCTAssertEqual(digest.concepts.first?.definition, "Insulin resistance develops when muscle cells stop responding to insulin signals.")
        XCTAssertTrue(digest.summaryMd.hasPrefix("## Key points\n- Insulin resistance develops"))

        let marking = try await fake.mark(MarkInput(
            questionStem: "Q",
            rubric: ["totalMarks": 10],
            answerText: "one two three four five six seven eight nine ten eleven twelve",
            concepts: [concept]
        ))
        XCTAssertEqual(marking.mark, 2)
        XCTAssertEqual(marking.criteria.map { $0.awarded }, [1, 1])
        XCTAssertEqual(marking.gaps, [MarkingGap(conceptId: "c1", type: .missed, text: "A hunger hormone.")])

        let questions = try await fake.generateQuestions(GenerateQuestionsInput(
            lectureTitle: "T",
            transcript: "",
            concepts: [concept],
            allocation: [Allocation(conceptId: "c1", count: 2), Allocation(conceptId: "gone", count: 1)]
        ))
        XCTAssertEqual(questions.questions.map { $0.stem }, [
            "Explain Ghrelin and why it matters in this lecture.",
            "Using an example, describe how Ghrelin would change under different conditions.",
        ])
        XCTAssertNoThrow(try questions.validate())

        let answer = try await fake.ask(.question(AskQuestion(
            lectureTitle: "T",
            summary: "## Ghrelin\n- Ghrelin rises before each meal and falls after.\n- Leptin signals long-term energy stores.",
            question: "When does ghrelin rise?",
            headings: ["Ghrelin"]
        )))
        XCTAssertEqual(answer, Answer(answer: "- Ghrelin rises before each meal and falls after.", section: "Ghrelin"))

        let leftOut = try await fake.ask(.leftout(AskLeftOut(lectureTitle: "T", what: "Aims", where: "", transcript: "")))
        XCTAssertEqual(leftOut.answer, "What the lecture said under \"Aims\" (somewhere).")

        let files = [
            SortFile(number: 1, path: "Week 1/Lecture 1.vtt", detail: "transcript, 50 min", excerpt: "Hello"),
            SortFile(number: 2, path: "Week 1/Lecture 1.pdf", detail: "slides, 20 pages", excerpt: "Title"),
        ]
        let sorted = try await fake.sortFiles(SortFilesInput(files: files))
        XCTAssertEqual(Set(sorted.lectures.flatMap { $0.files } + sorted.setAside.map { $0.file }), [1, 2])
    }

    func testFakeProviderStopsWhenCancelled() async {
        let fake = FakeProvider(delayMs: 5_000)
        let task = Task { try await fake.parsePastPaper(ParsePastPaperInput(paperText: "", concepts: [])) }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected a cancel")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
    }
}
