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

private let placeholderPattern = try! NSRegularExpression(pattern: #"\{\{([A-Za-z0-9_]+)\}\}"#)

private func placeholders(in text: String) -> Set<String> {
    let ns = text as NSString
    let matches = placeholderPattern.matches(in: text, range: NSRange(location: 0, length: ns.length))
    return Set(matches.map { ns.substring(with: $0.range(at: 1)) })
}

private let sampleDeck = SlideDeck(materialId: "m1", name: "Appetite.pdf", file: "/tmp/lockin/Appetite.pdf", pdf: true, pages: 3, first: 1)

private let sampleDigest = DigestInput(
    currentTitle: "appetite-lecture",
    titleIsPlaceholder: true,
    durationHours: 1.5,
    transcript: "[00:01] Ghrelin rises before meals.",
    slidesText: "--- Slide 1 ---\nGhrelin",
    alreadySkipped: [Skipped(what: "Module aims", where: "slide 2")],
    existingConcepts: [ConceptRef(id: "c1", name: "Ghrelin", definition: "A hunger hormone.")],
    slides: SlidesInfo(lectureId: "l1", decks: [sampleDeck], sharedWith: ["Satiety"])
)

private let sampleGenerate = GenerateQuestionsInput(
    lectureTitle: "Appetite",
    transcript: "Ghrelin rises before meals.",
    slidesText: nil,
    summary: "## Ghrelin",
    concepts: [ConceptRef(id: "c1", name: "Ghrelin", definition: "A hunger hormone.")],
    allocation: [Allocation(conceptId: "c1", count: 2), Allocation(conceptId: "c2", count: 0)],
    type: .laq,
    style: .story,
    sharedWith: []
)

private let sampleRubric: JSONValue = [
    "modelAnswer": "Ghrelin signals hunger.",
    "criteria": [["point": "Names ghrelin", "marks": 4]],
    "totalMarks": 10,
]

private let sampleMark = MarkInput(
    questionStem: "Explain ghrelin.",
    rubric: sampleRubric,
    answerText: "It makes you hungry.",
    concepts: [ConceptRef(id: "c1", name: "Ghrelin", definition: "A hunger hormone.")]
)

final class PromptsTests: XCTestCase {
    func testFillReplacesEveryPlaceholderAndBlanksUnknownOnes() {
        XCTAssertEqual(fillPrompt("Hi {{name}}, {{missing}}!", vars: ["name": "Sam"]), "Hi Sam, !")
        XCTAssertEqual(fillPrompt("{{a}}{{a}} {b} {{ a }}", vars: ["a": "x"]), "xx {b} {{ a }}")
        // A value is put in as it is: no placeholder inside it is filled in turn.
        XCTAssertEqual(fillPrompt("{{a}}", vars: ["a": "{{b}} $1 \\n", "b": "no"]), "{{b}} $1 \\n")
    }

    func testCompareSemverIsNumericPartByPart() {
        XCTAssertGreaterThan(compareSemver("1.10.0", "1.9.0"), 0)
        XCTAssertLessThan(compareSemver("1.2.0", "1.3.0"), 0)
        XCTAssertEqual(compareSemver("1.2", "1.2.0"), 0)
        XCTAssertGreaterThan(compareSemver("2.0.0", "1.99.99"), 0)
    }

    func testLoadsTheNewestVersionOfEachPrompt() throws {
        XCTAssertEqual(try loadPrompt("digest-lecture", directory: repoPrompts).version, "1.2.0")
        XCTAssertEqual(try loadPrompt("generate-questions", directory: repoPrompts).version, "1.3.0")
        XCTAssertEqual(try loadPrompt("mark", directory: repoPrompts).version, "1.0.0")
    }

    func testPicksVersionsNumericallyAndSaysWhenThereIsNone() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("lockin-prompts-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try "old".write(to: dir.appendingPathComponent("x.1.9.0.md"), atomically: true, encoding: .utf8)
        try "new".write(to: dir.appendingPathComponent("x.1.10.0.md"), atomically: true, encoding: .utf8)
        try "other".write(to: dir.appendingPathComponent("xy.9.0.0.md"), atomically: true, encoding: .utf8)
        try "notes".write(to: dir.appendingPathComponent("x.2.0.0.txt"), atomically: true, encoding: .utf8)

        let loaded = try loadPrompt("x", directory: dir)
        XCTAssertEqual(loaded, LoadedPrompt(text: "new", version: "1.10.0"))

        XCTAssertThrowsError(try loadPrompt("missing", directory: dir)) { error in
            XCTAssertEqual(messageOf(error), "no prompt file for \"missing\" in \(dir.path)")
        }
    }

    func testRenderStampsNameAndVersion() throws {
        let rendered = try renderPrompt(.sortFiles, vars: sortVars(SortFilesInput(files: [])), directory: repoPrompts)
        XCTAssertEqual(rendered.version, "sort-files@1.0.0")
    }

    func testEveryPromptGetsEveryVariableItUses() throws {
        let question = AskInput.question(AskQuestion(lectureTitle: "Appetite", summary: "## Ghrelin\nIt rises.", question: "Why?", headings: ["Ghrelin"]))
        let breakdown = AskInput.breakdown(AskBreakdown(lectureTitle: "Appetite", summary: "## Ghrelin", selection: "It rises."))
        let leftOut = AskInput.leftout(AskLeftOut(lectureTitle: "Appetite", what: "Module aims", where: "slide 2", transcript: "…"))
        let files = [SortFile(number: 1, path: "week1/lecture.vtt", detail: "transcript, 52 min", excerpt: "Good  morning\n everyone")]
        let cases: [(PromptName, [String: String])] = [
            (.digestLecture, digestVars(sampleDigest, visual: true)),
            (.generateQuestions, generateVars(sampleGenerate)),
            (.mark, markVars(sampleMark)),
            (.parsePastPaper, paperVars(ParsePastPaperInput(paperText: "Q1. Explain ghrelin.", concepts: []))),
            (.sortFiles, sortVars(SortFilesInput(files: files))),
            (.answerQuestion, askVars(question).vars),
            (.breakDown, askVars(breakdown).vars),
            (.leftOut, askVars(leftOut).vars),
        ]
        XCTAssertEqual(Set(cases.map { $0.0 }), Set(PromptName.allCases))
        for (name, vars) in cases {
            let template = try loadPrompt(name.rawValue, directory: repoPrompts)
            let needed = placeholders(in: template.text)
            XCTAssertFalse(needed.isEmpty, "\(name.rawValue) has no variables")
            XCTAssertTrue(needed.isSubset(of: Set(vars.keys)), "\(name.rawValue) needs \(needed.subtracting(vars.keys).sorted())")
            let rendered = try renderPrompt(name, vars: vars, directory: repoPrompts)
            XCTAssertTrue(placeholders(in: rendered.text).isEmpty, "\(name.rawValue) left a placeholder")
            XCTAssertEqual(rendered.version, "\(name.rawValue)@\(template.version)")
        }
    }

    func testDigestVars() {
        let vars = digestVars(sampleDigest)
        XCTAssertEqual(vars["durationHours"], "1.5")
        XCTAssertEqual(vars["lowerBound"], "12")
        XCTAssertEqual(vars["upperBound"], "30")
        XCTAssertEqual(vars["currentTitle"], "appetite-lecture")
        XCTAssertEqual(vars["titleNote"], "(That title was made from a filename and is only a placeholder — replace it.)")
        XCTAssertEqual(vars["slideNotesStep"], "Leave `slideNotes` as an empty list.")
        XCTAssertEqual(vars["existingConcepts"], "- c1 :: Ghrelin — A hunger hormone.")
        XCTAssertEqual(
            vars["slidesNote"],
            "\nThese slides are shared with another lecture: \"Satiety\". This lecture is only the part its transcript covers — "
                + "summarise and extract concepts for only that part, and leave out slides that belong to the other lecture.\n"
        )
        XCTAssertEqual(
            vars["alreadySkipped"],
            "\nThese slides were already removed before you saw them and are recorded, so do not list them again:\n- Module aims (slide 2)"
        )
        XCTAssertTrue(vars["picturesNote"]?.hasPrefix("\nWhere a slide's figure") == true)
        XCTAssertTrue(digestVars(sampleDigest, visual: true)["slideNotesStep"]?.hasPrefix("For every slide this lecture covers") == true)

        var plain = sampleDigest
        plain.slides = nil
        plain.slidesText = nil
        plain.alreadySkipped = []
        plain.existingConcepts = []
        plain.titleIsPlaceholder = false
        plain.durationHours = 0.3125
        let other = digestVars(plain)
        XCTAssertEqual(other["picturesNote"], "")
        XCTAssertEqual(other["slidesNote"], "")
        XCTAssertEqual(other["alreadySkipped"], "")
        XCTAssertEqual(other["slidesText"], "(no slides supplied)")
        XCTAssertEqual(other["existingConcepts"], "(none yet)")
        XCTAssertEqual(other["titleNote"], "(The student chose that title. Return it unchanged unless it is plainly wrong.)")
        // Math.round: 2.5 rounds up, 6.25 down.
        XCTAssertEqual(other["lowerBound"], "3")
        XCTAssertEqual(other["upperBound"], "6")
        XCTAssertEqual(other["durationHours"], "0.3125")
    }

    func testGenerateVars() {
        let vars = generateVars(sampleGenerate)
        XCTAssertEqual(vars["allocation"], "- c1: 2")
        XCTAssertEqual(vars["total"], "2")
        XCTAssertEqual(vars["type"], "LAQ")
        XCTAssertEqual(vars["scopeNote"], "")
        XCTAssertEqual(vars["slidesText"], "(no slides supplied)")
        XCTAssertTrue(vars["styleNote"]?.hasPrefix("\nSet every question in a short scenario") == true)

        var none = sampleGenerate
        none.allocation = []
        none.style = .mixed
        none.sharedWith = ["Satiety", "Hunger"]
        let other = generateVars(none)
        XCTAssertEqual(other["allocation"], "(none)")
        XCTAssertEqual(other["total"], "0")
        XCTAssertEqual(other["styleNote"], "")
        XCTAssertEqual(
            other["scopeNote"],
            "\nThese slides are shared with other lectures: \"Satiety\", \"Hunger\". This lecture is only the part its transcript covers — "
                + "ask about only that part, and leave out slides that belong to the other lecture.\n"
        )
    }

    func testMarkVarsPrintTheRubricAsJSONStringifyDoes() {
        let vars = markVars(sampleMark)
        XCTAssertEqual(
            vars["rubric"],
            """
            {
              "modelAnswer": "Ghrelin signals hunger.",
              "criteria": [
                {
                  "point": "Names ghrelin",
                  "marks": 4
                }
              ],
              "totalMarks": 10
            }
            """
        )
        XCTAssertEqual(vars["concepts"], "- c1 :: Ghrelin — A hunger hormone.")
    }

    func testSortAndAskVars() {
        let files = [
            SortFile(number: 1, path: "a.vtt", detail: "transcript, 52 min", excerpt: "Good  morning\n everyone "),
            SortFile(number: 2, path: "b.pdf", detail: "slides, 3 pages", excerpt: "   "),
        ]
        XCTAssertEqual(
            sortVars(SortFilesInput(files: files))["files"],
            "[1] a.vtt — transcript, 52 min\n    Good morning everyone\n[2] b.pdf — slides, 3 pages\n    (no text)"
        )

        let question = askVars(.question(AskQuestion(lectureTitle: "T", summary: "S", question: "Q", headings: [])))
        XCTAssertEqual(question.prompt, .answerQuestion)
        XCTAssertEqual(question.vars["headings"], "(the summary has no headings)")
        let withHeadings = askVars(.question(AskQuestion(lectureTitle: "T", summary: "S", question: "Q", headings: ["A", "B"])))
        XCTAssertEqual(withHeadings.vars["headings"], "- A\n- B")

        let breakdown = askVars(.breakdown(AskBreakdown(lectureTitle: "T", summary: "S", selection: "X")))
        XCTAssertEqual(breakdown.prompt, .breakDown)
        XCTAssertEqual(breakdown.vars, ["lectureTitle": "T", "summary": "S", "selection": "X"])

        let leftOut = askVars(.leftout(AskLeftOut(lectureTitle: "T", what: "Aims", where: "", transcript: "tx")))
        XCTAssertEqual(leftOut.prompt, .leftOut)
        XCTAssertEqual(leftOut.vars["where"], "place not recorded")
        XCTAssertEqual(leftOut.vars["slidesText"], "(no slides supplied)")
    }
}
