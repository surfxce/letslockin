import Foundation

/// Turns a versioned prompt file and a call's input into the text a model sees (port of
/// `lib/llm/prompts.ts`). Shared by every provider, so a cloud AI and an offline model are
/// asked exactly the same thing and their rows carry the same prompt version.

public enum PromptName: String, CaseIterable, Sendable {
    case digestLecture = "digest-lecture"
    case generateQuestions = "generate-questions"
    case mark = "mark"
    case parsePastPaper = "parse-past-paper"
    case sortFiles = "sort-files"
    case answerQuestion = "answer-question"
    case breakDown = "break-down"
    case leftOut = "left-out"
}

/// A prompt file's text and its version ("1.2.0").
public struct LoadedPrompt: Equatable, Sendable {
    public var text: String
    public var version: String

    public init(text: String, version: String) {
        self.text = text
        self.version = version
    }
}

/// A prompt filled in, and the version stamped onto every row its reply produces
/// ("digest-lecture@1.2.0").
public struct RenderedPrompt: Equatable, Sendable {
    public var text: String
    public var version: String

    public init(text: String, version: String) {
        self.text = text
        self.version = version
    }
}

/// `prompts/<name>.<semver>.md`, the newest version.
public func loadPrompt(_ name: String, directory: URL = LockinPaths.promptsDirectory) throws -> LoadedPrompt {
    let files: [String]
    do {
        files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    } catch {
        throw LockinError("ENOENT: no such file or directory, scandir '\(directory.path)'")
    }
    let matches = files
        .filter { $0.hasPrefix("\(name).") && $0.hasSuffix(".md") }
        .sorted { compareSemver(promptFileVersion(file: $0, name: name), promptFileVersion(file: $1, name: name)) > 0 }
    guard let file = matches.first else {
        throw LockinError("no prompt file for \"\(name)\" in \(directory.path)")
    }
    let url = directory.appendingPathComponent(file, isDirectory: false)
    let text: String
    do {
        text = try String(contentsOf: url, encoding: .utf8)
    } catch {
        throw LockinError("could not read \(url.path): \(messageOf(error))")
    }
    return LoadedPrompt(text: text, version: promptFileVersion(file: file, name: name))
}

/// `file.slice(name.length + 1, -".md".length)`.
func promptFileVersion(file: String, name: String) -> String {
    let ns = file as NSString
    let start = (name as NSString).length + 1
    let end = ns.length - 3
    guard end > start else { return "" }
    return ns.substring(with: NSRange(location: start, length: end - start))
}

/// Compares two versions part by part, numerically; a missing part counts as 0.
/// Negative when `a` is older, positive when newer.
public func compareSemver(_ a: String, _ b: String) -> Int {
    let pa = a.components(separatedBy: ".").map { Int($0) ?? 0 }
    let pb = b.components(separatedBy: ".").map { Int($0) ?? 0 }
    for i in 0..<max(pa.count, pb.count) {
        let left = i < pa.count ? pa[i] : 0
        let right = i < pb.count ? pb[i] : 0
        if left != right {
            return left - right
        }
    }
    return 0
}

private let placeholderRe = Regex.compile(#"\{\{([A-Za-z0-9_]+)\}\}"#)

/// `fill(template, vars)`: every `{{name}}` becomes its value, or nothing when there is none.
public func fillPrompt(_ template: String, vars: [String: String]) -> String {
    let ns = template as NSString
    var out = ""
    var last = 0
    for match in Regex.allMatches(placeholderRe, in: template) {
        out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
        let key = ns.substring(with: match.range(at: 1))
        out += vars[key] ?? ""
        last = match.range.location + match.range.length
    }
    out += ns.substring(from: last)
    return out
}

public func renderPrompt(
    _ name: PromptName,
    vars: [String: String],
    directory: URL = LockinPaths.promptsDirectory
) throws -> RenderedPrompt {
    let loaded = try loadPrompt(name.rawValue, directory: directory)
    return RenderedPrompt(text: fillPrompt(loaded.text, vars: vars), version: "\(name.rawValue)@\(loaded.version)")
}

// MARK: - What fills each prompt

public func conceptTable(_ concepts: [ConceptRef]) -> String {
    if concepts.isEmpty {
        return "(none yet)"
    }
    return concepts.map { "- \($0.id) :: \($0.name) — \($0.definition)" }.joined(separator: "\n")
}

/// Said when the slides are shared with other lectures; "" when they are not.
public func sharedNote(_ titles: [String]?, _ what: String) -> String {
    guard let titles, !titles.isEmpty else { return "" }
    let who = titles.count == 1 ? "another lecture" : "other lectures"
    let quoted = titles.map { "\"\($0)\"" }.joined(separator: ", ")
    return "\nThese slides are shared with \(who): \(quoted). This lecture is only the part its transcript covers — "
        + "\(what) only that part, and leave out slides that belong to the other lecture.\n"
}

/// `visual` is set by a provider that shows the model the slides themselves; only then
/// can it describe what is on them.
public func digestVars(_ input: DigestInput, visual: Bool = false) -> [String: String] {
    let pictured = input.slides?.hasPicturedDeck ?? false
    var vars: [String: String] = [:]
    vars["slidesNote"] = sharedNote(input.slides?.sharedWith, "summarise and extract concepts for")
    if pictured {
        let note: String = "\nWhere a slide's figure, diagram, graph, table or photo would help someone revise — a pathway, a "
            + "labelled structure, a graph with a trend — show it: put `![<what it shows>](slide:<number>)` on a line "
            + "of its own, right where it belongs, using the slide numbers from the \"--- Slide N ---\" markers. Choose "
            + "the few that teach something, about four per hour of lecture at most — never a title slide, a slide of "
            + "plain text, a logo or a decorative picture.\n"
        vars["picturesNote"] = note
    } else {
        vars["picturesNote"] = ""
    }
    if visual {
        let step: String = "For every slide this lecture covers, write one or two sentences in `slideNotes`: the words on it, "
            + "including any inside pictures, and what any figure shows (\"Graph: plasma ghrelin peaks just before each "
            + "meal and falls after eating\"). The steps that write and mark exam questions cannot see the slides and "
            + "work from these. Skip title slides, aims and housekeeping, and slides that belong to another lecture."
        vars["slideNotesStep"] = step
    } else {
        vars["slideNotesStep"] = "Leave `slideNotes` as an empty list."
    }
    vars["currentTitle"] = input.currentTitle
    vars["titleNote"] = input.titleIsPlaceholder
        ? "(That title was made from a filename and is only a placeholder — replace it.)"
        : "(The student chose that title. Return it unchanged unless it is plainly wrong.)"
    vars["durationHours"] = jsNumberString(input.durationHours)
    vars["lowerBound"] = jsNumberString(jsMathRound(8 * input.durationHours))
    vars["upperBound"] = jsNumberString(jsMathRound(20 * input.durationHours))
    vars["transcript"] = input.transcript
    vars["slidesText"] = input.slidesText ?? "(no slides supplied)"
    vars["existingConcepts"] = conceptTable(input.existingConcepts)
    if input.alreadySkipped.isEmpty {
        vars["alreadySkipped"] = ""
    } else {
        let lines = input.alreadySkipped.map { "- \($0.what) (\($0.where))" }.joined(separator: "\n")
        vars["alreadySkipped"] = "\nThese slides were already removed before you saw them and are recorded, so do not list them again:\n"
            + lines
    }
    return vars
}

public func generateVars(_ input: GenerateQuestionsInput) -> [String: String] {
    let allocation = input.allocation
        .filter { $0.count > 0 }
        .map { "- \($0.conceptId): \($0.count)" }
        .joined(separator: "\n")
    return [
        "scopeNote": sharedNote(input.sharedWith, "ask about"),
        "styleNote": laqStyleNote(input.style),
        "lectureTitle": input.lectureTitle,
        "type": input.type.rawValue,
        "transcript": input.transcript,
        "slidesText": input.slidesText ?? "(no slides supplied)",
        "concepts": conceptTable(input.concepts),
        "allocation": allocation.isEmpty ? "(none)" : allocation,
        "total": String(input.total),
    ]
}

public func markVars(_ input: MarkInput) -> [String: String] {
    [
        "questionStem": input.questionStem,
        "rubric": input.rubric.stringified(indent: 2),
        "answerText": input.answerText,
        "concepts": conceptTable(input.concepts),
    ]
}

public func paperVars(_ input: ParsePastPaperInput) -> [String: String] {
    ["paperText": input.paperText, "concepts": conceptTable(input.concepts)]
}

public func sortVars(_ input: SortFilesInput) -> [String: String] {
    ["files": formatSortFilesVar(input.files)]
}

/// Which prompt a quick question uses, and what fills it.
public func askVars(_ input: AskInput) -> (prompt: PromptName, vars: [String: String]) {
    switch input {
    case .question(let ask):
        let headings = ask.headings.isEmpty
            ? "(the summary has no headings)"
            : ask.headings.map { "- \($0)" }.joined(separator: "\n")
        return (
            prompt: .answerQuestion,
            vars: [
                "lectureTitle": ask.lectureTitle,
                "summary": ask.summary,
                "question": ask.question,
                "headings": headings,
            ]
        )
    case .breakdown(let ask):
        return (
            prompt: .breakDown,
            vars: ["lectureTitle": ask.lectureTitle, "summary": ask.summary, "selection": ask.selection]
        )
    case .leftout(let ask):
        return (
            prompt: .leftOut,
            vars: [
                "lectureTitle": ask.lectureTitle,
                "what": ask.what,
                "where": ask.where.isEmpty ? "place not recorded" : ask.where,
                "transcript": ask.transcript,
                "slidesText": ask.slidesText ?? "(no slides supplied)",
            ]
        )
    }
}

public func renderAskPrompt(_ input: AskInput, directory: URL = LockinPaths.promptsDirectory) throws -> RenderedPrompt {
    let (name, vars) = askVars(input)
    return try renderPrompt(name, vars: vars, directory: directory)
}

