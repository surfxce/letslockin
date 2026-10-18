import Foundation
import XCTest
@testable import LockinCore

// Expected values marked "TS" were captured by running lib/llm/cli.ts, codex.ts and
// antigravity.ts (with tsx) against fake command-line tools that record their arguments
// and stdin.

/// The repository's prompts/ folder, found from this file so it works from any directory.
private let cliRepoPrompts = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("prompts", isDirectory: true)

/// Decks of the Claude Code capture: D has no pages yet, C is not a PDF.
private let claudeDecks = [
    SlideDeck(materialId: "A", name: "A.pdf", file: "/data/materials/l1/A.pdf", pdf: true, pages: 1, first: 1),
    SlideDeck(materialId: "B", name: "B.pdf", file: "/data/materials/l1/B.pdf", pdf: true, pages: 12, first: 2),
    SlideDeck(materialId: "C", name: "C.pptx", file: "/data/other/C.pptx", pdf: false, pages: 3, first: 14),
    SlideDeck(materialId: "D", name: "D.pdf", file: "/data/other/D.pdf", pdf: true, pages: 0, first: 17),
]

/// Decks of the Antigravity capture: D has two pages, in another folder.
private let agyDecks = [
    SlideDeck(materialId: "A", name: "A.pdf", file: "/data/materials/l1/A.pdf", pdf: true, pages: 1, first: 1),
    SlideDeck(materialId: "B", name: "B.pdf", file: "/data/materials/l1/B.pdf", pdf: true, pages: 12, first: 2),
    SlideDeck(materialId: "C", name: "C.pptx", file: "/data/other/C.pptx", pdf: false, pages: 3, first: 14),
    SlideDeck(materialId: "D", name: "D.pdf", file: "/data/other/D.pdf", pdf: true, pages: 2, first: 17),
]

/// TS: what Claude Code is told after the digest prompt about the decks it may open.
private let tsReadDecksNote = "\n\n---\n\nThe slide decks are attached as PDF files you can open with the Read tool. The slide text above was extracted from them and misses everything inside pictures, diagrams, tables and photos, so look at every page yourself before writing anything — up to 20 pages per Read call (pages \"1-20\", then \"21-40\", and so on):\n\n- /data/materials/l1/A.pdf — 1 page, slides 1–1\n- /data/materials/l1/B.pdf — 12 pages, slides 2–13\n\nSlides are numbered across the decks as listed: use those numbers for slide pictures and slideNotes. Read nothing else. Then reply with the JSON described above."

/// TS: Antigravity's stdin for the prompt "PROMPT" with `agyDecks`.
private let tsAgyStdin = "PROMPT\n\n---\n\nThe slide decks are attached as PDF files. The slide text above was extracted from them and misses everything inside pictures, diagrams, tables and photos, so look at every page yourself before writing anything. Slides are numbered across the decks as listed:\n\n- A.pdf: slides 1–1\n- B.pdf: slides 2–13\n- D.pdf: slides 17–18\n\nUse those numbers for slide pictures and slideNotes. Then reply with the JSON described above."

private let sampleAsk = AskInput.question(
    AskQuestion(lectureTitle: "Appetite", summary: "## Hunger\nGhrelin.", question: "What rises before meals?", headings: ["Hunger"])
)

/// Slide pictures at made-up paths: nothing is drawn.
private struct PathOnlyRenderer: SlideRendering {
    func pageCount(file: String) -> Int? { nil }
    func renderPage(file: String, page: Int) throws -> Data { throw LockinError("not drawn in these tests") }
    func pagePNG(lectureId: String, deck: SlideDeck, page: Int) throws -> Data { throw LockinError("not drawn in these tests") }
    func pagePNGFile(lectureId: String, deck: SlideDeck, page: Int) throws -> String {
        "/pictures/\(lectureId)/\(deck.materialId)/\(page).png"
    }
    func cropPNG(_ png: Data, crop: Crop) throws -> Data { png }
}

private func scratchFolder() throws -> URL {
    let folder = FileManager.default.temporaryDirectory
        .appendingPathComponent("lockin-cli-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    return folder
}

/// A `/bin/sh` script, executable, in `folder`. Returns its absolute path.
@discardableResult
private func writeScript(_ folder: URL, _ name: String, _ body: String, executable: Bool = true) throws -> String {
    let file = folder.appendingPathComponent(name, isDirectory: false)
    try ("#!/bin/sh\n" + body + "\n").write(to: file, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: executable ? 0o755 : 0o644], ofItemAtPath: file.path)
    return file.path
}

private func readText(_ url: URL) -> String {
    (try? String(contentsOf: url, encoding: .utf8)) ?? ""
}

/// The arguments a fake tool wrote with `printf '%s\n' "$@"`.
private func recordedArguments(_ url: URL) -> [String] {
    var parts = readText(url).components(separatedBy: "\n")
    if parts.last == "" {
        parts.removeLast()
    }
    return parts
}

/// The error `work` throws, if any.
private func failure(of work: () async throws -> Void) async -> Error? {
    do {
        try await work()
        return nil
    } catch {
        return error
    }
}

private func claudeConfig(binary: String = "claude", timeout: TimeInterval = 60) -> ClaudeCodeConfig {
    ClaudeCodeConfig(
        binary: binary,
        model: "sonnet",
        sortModel: "haiku",
        askModel: "sonnet",
        effort: "medium",
        timeout: timeout,
        extraArgs: []
    )
}

final class CLIProvidersTests: XCTestCase {
    override func setUp() {
        super.setUp()
        CLIDetect.clearCache()
    }

    // MARK: - Claude Code: settings and arguments

    func testClaudeConfigDefaults() {
        XCTAssertEqual(
            ClaudeCodeConfig.fromEnvironment([:]),
            ClaudeCodeConfig(
                binary: "claude",
                model: "sonnet",
                sortModel: "haiku",
                askModel: "sonnet",
                effort: "medium",
                timeout: 600,
                extraArgs: []
            )
        )
    }

    func testClaudeConfigFromEnvironment() {
        let config = ClaudeCodeConfig.fromEnvironment([
            "LOCKIN_CLAUDE_BIN": "/Applications/Claude.app/claude",
            "LOCKIN_MODEL": "opus",
            "LOCKIN_SORT_MODEL": "sonnet",
            "LOCKIN_ASK_MODEL": "haiku",
            "LOCKIN_EFFORT": "default",
            "LOCKIN_CLI_TIMEOUT_MS": "1500",
            "LOCKIN_CLI_FLAGS": "  --verbose  --setting-sources user ",
        ])
        XCTAssertEqual(config.binary, "/Applications/Claude.app/claude")
        XCTAssertEqual(config.model, "opus")
        XCTAssertEqual(config.sortModel, "sonnet")
        XCTAssertEqual(config.askModel, "haiku")
        XCTAssertNil(config.effort)
        XCTAssertEqual(config.timeout, 1.5, accuracy: 1e-9)
        XCTAssertEqual(config.extraArgs, ["--verbose", "--setting-sources", "user"])
        XCTAssertEqual(ClaudeCodeConfig.fromEnvironment(["LOCKIN_EFFORT": "high"]).effort, "high")
    }

    func testClaudeArgumentsForEachTask() {
        let config = claudeConfig()
        let denyAll = "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task"
        XCTAssertEqual(
            ClaudeCodeCall(config: config, options: CallOptions(task: .mark)).arguments,
            ["-p", "--output-format", "json", "--model", "sonnet", "--effort", "medium", "--disallowed-tools", denyAll]
        )
        let sort = ClaudeCodeCall(config: config, options: CallOptions(task: .sort))
        XCTAssertEqual(sort.model, "haiku")
        XCTAssertEqual(sort.arguments, ["-p", "--output-format", "json", "--model", "haiku", "--effort", "low", "--disallowed-tools", denyAll])
        let ask = ClaudeCodeCall(config: config, options: CallOptions(task: .ask))
        XCTAssertEqual(ask.arguments, ["-p", "--output-format", "json", "--model", "sonnet", "--effort", "low", "--disallowed-tools", denyAll])

        // Someone chose Haiku to be quick: questions stay on it too.
        var haiku = config
        haiku.model = "haiku"
        haiku.askModel = "opus"
        XCTAssertEqual(ClaudeCodeCall(config: haiku, options: CallOptions(task: .ask)).model, "haiku")
        var opus = config
        opus.model = "opus"
        opus.askModel = "sonnet"
        XCTAssertEqual(ClaudeCodeCall(config: opus, options: CallOptions(task: .ask)).model, "sonnet")
        XCTAssertEqual(ClaudeCodeCall(config: opus, options: CallOptions(task: .questions)).model, "opus")

        // No effort, or an empty one, leaves --effort out; extra flags go last.
        var plain = config
        plain.effort = nil
        plain.extraArgs = ["--verbose"]
        XCTAssertEqual(
            ClaudeCodeCall(config: plain, options: CallOptions(task: .digest)).arguments,
            ["-p", "--output-format", "json", "--model", "sonnet", "--disallowed-tools", denyAll, "--verbose"]
        )
        plain.effort = ""
        XCTAssertFalse(ClaudeCodeCall(config: plain, options: CallOptions(task: .paper)).arguments.contains("--effort"))
    }

    func testClaudeArgumentsReadOnlyTheDeckFolders() {
        let call = ClaudeCodeCall(
            config: claudeConfig(),
            options: CallOptions(task: .digest, slides: SlidesInfo(lectureId: "l1", decks: claudeDecks))
        )
        XCTAssertEqual(call.readDirs, ["/data/materials/l1"])
        // TS
        XCTAssertEqual(call.arguments, [
            "-p", "--output-format", "json", "--model", "sonnet", "--effort", "medium",
            "--allowed-tools", "Read", "--add-dir", "/data/materials/l1",
            "--disallowed-tools", "Bash,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task",
        ])
        let twoFolders = ClaudeCodeCall(
            config: claudeConfig(),
            options: CallOptions(task: .digest, slides: SlidesInfo(lectureId: "l1", decks: agyDecks))
        )
        XCTAssertEqual(twoFolders.readDirs, ["/data/materials/l1", "/data/other"])
    }

    func testReadDecksNoteMatchesTypeScript() {
        let pdfs = picturedDecks(SlidesInfo(lectureId: "l1", decks: claudeDecks))
        XCTAssertEqual(pdfs.map(\.materialId), ["A", "B"])
        XCTAssertEqual(ClaudeCodeProvider.readDecksNote(pdfs), tsReadDecksNote)
    }

    func testLabelsAndNames() {
        let claude = ClaudeCodeProvider(config: claudeConfig(), promptsDirectory: cliRepoPrompts)
        XCTAssertEqual(claude.name, "claude-code-cli")
        XCTAssertTrue(claude.seesSlides)
        XCTAssertTrue(claude.repairsAnyFailure)
        XCTAssertEqual(claude.lastModel, "Claude Code · sonnet")
        XCTAssertEqual(claude.lastPromptVersion, "")
        XCTAssertEqual(claude.label(model: nil), "Claude Code · sonnet")
        XCTAssertEqual(claude.label(model: "claude-opus-4-1"), "Claude Code · claude-opus-4-1")

        let codex = CodexProvider(binary: "codex", model: "", renderer: PathOnlyRenderer())
        XCTAssertEqual(codex.name, "codex-cli")
        XCTAssertTrue(codex.seesSlides)
        XCTAssertFalse(codex.repairsAnyFailure)
        XCTAssertEqual(codex.lastModel, "ChatGPT Codex · default model")
        // TS
        XCTAssertEqual(CodexProvider(binary: "codex", model: "gpt-5.5", renderer: PathOnlyRenderer()).lastModel, "ChatGPT Codex · gpt-5.5")
        XCTAssertEqual(codex.label(model: ""), "ChatGPT Codex · default model")
        XCTAssertEqual(codex.label(model: "gpt-5.5-codex"), "ChatGPT Codex · gpt-5.5-codex")

        let agy = AntigravityProvider(binary: "agy", model: "")
        XCTAssertEqual(agy.name, "antigravity-cli")
        XCTAssertTrue(agy.seesSlides)
        // TS
        XCTAssertEqual(agy.lastModel, "Antigravity · auto")
        XCTAssertEqual(AntigravityProvider(binary: "/usr/local/bin/gemini-cli", model: "gemini-3-pro").lastModel, "Gemini CLI · gemini-3-pro")
        XCTAssertEqual(agy.label(model: "gemini-2.5-pro"), "Antigravity · gemini-2.5-pro")
    }

    // MARK: - Claude Code: replies

    func testUnwrapEnvelope() throws {
        XCTAssertEqual(try unwrapEnvelope(#"{"type":"result","is_error":false,"result":"{\"a\":1}"}"#), #"{"a":1}"#)
        XCTAssertEqual(try unwrapEnvelope(#"  "just text"  "#), "just text")
        // TS
        XCTAssertEqual(try unwrapEnvelope(#"{"content":[{"type":"text","text":"a"},{"type":"tool_use"},null,{"type":"text","text":"b"}]}"#), "ab")
        XCTAssertEqual(try unwrapEnvelope("  [1,2]  "), "[1,2]")
        XCTAssertEqual(try unwrapEnvelope("\nHere is the JSON: {\"a\": 1}\n"), "Here is the JSON: {\"a\": 1}")
        XCTAssertEqual(try unwrapEnvelope(#"{"type":"result","subtype":"success"}"#), #"{"type":"result","subtype":"success"}"#)

        let reported: [(String, String)] = [
            (#"{"is_error":true,"result":"Not logged in · Please run /login"}"#, "claude reported an error: Not logged in · Please run /login"),
            // TS
            (#"{"is_error":true,"error":{"a":1}}"#, "claude reported an error: [object Object]"),
            (#"{"is_error":true,"result":null,"error":"rate"}"#, "claude reported an error: rate"),
            (#"{"is_error":1}"#, "claude reported an error: "),
        ]
        for (stdout, message) in reported {
            XCTAssertThrowsError(try unwrapEnvelope(stdout)) { error in
                XCTAssertEqual((error as? CloudError)?.message, message)
            }
        }
        XCTAssertThrowsError(try unwrapEnvelope(" \n\t ")) { error in
            XCTAssertEqual((error as? CloudError)?.message, "claude returned nothing on stdout")
        }
    }

    func testModelOfPicksTheModelThatWroteMost() {
        // TS: equal counts keep the first.
        XCTAssertEqual(modelOf(#"{"modelUsage":{"a":{"outputTokens":3},"b":{"outputTokens":9},"c":{"outputTokens":9}}}"#), "b")
        XCTAssertEqual(modelOf(#"{"modelUsage":{"x":{}, "y": null}}"#), "x")
        XCTAssertEqual(
            modelOf(#"{"result":"ok","modelUsage":{"claude-haiku-4-5":{"outputTokens":12},"claude-sonnet-4-5":{"outputTokens":840}}}"#),
            "claude-sonnet-4-5"
        )
        XCTAssertNil(modelOf("not json"))
        XCTAssertNil(modelOf(#"{"result":"ok"}"#))
        XCTAssertNil(modelOf(#"{"modelUsage":{}}"#))
        XCTAssertNil(modelOf(#"{"modelUsage":"sonnet"}"#))
        XCTAssertNil(modelOf("[1]"))
        XCTAssertNil(modelOf("null"))
    }

    func testClaudeReplyReadsTheEnvelopeBeforeTheExitCode() throws {
        let envelope = #"{"result":"{}","modelUsage":{"claude-sonnet-4-5":{"outputTokens":5}}}"#
        XCTAssertEqual(
            try claudeReply(ProcessResult(stdout: envelope, stderr: "", code: 0), callModel: "sonnet"),
            Reply(text: "{}", model: "claude-sonnet-4-5")
        )
        // No usage reported: the model the call asked for.
        XCTAssertEqual(
            try claudeReply(ProcessResult(stdout: #"{"result":"{}"}"#, stderr: "", code: 0), callModel: "haiku"),
            Reply(text: "{}", model: "haiku")
        )
        // A failed exit with a usable reply still answers.
        XCTAssertEqual(try claudeReply(ProcessResult(stdout: "{}", stderr: "warning", code: 1), callModel: "sonnet").text, "{}")

        XCTAssertThrowsError(try claudeReply(ProcessResult(stdout: "", stderr: "  Invalid API key \n", code: 1), callModel: "sonnet")) { error in
            let cloud = error as? CloudError
            XCTAssertEqual(cloud?.message, "claude exited 1: Invalid API key")
            XCTAssertEqual(cloud?.stderr, "  Invalid API key \n")
            XCTAssertEqual(cloud?.code, 1)
        }
        XCTAssertThrowsError(try claudeReply(ProcessResult(stdout: "", stderr: "", code: nil), callModel: "sonnet")) { error in
            XCTAssertEqual((error as? CloudError)?.message, "claude exited null")
        }
        XCTAssertThrowsError(
            try claudeReply(ProcessResult(stdout: #"{"is_error":true,"result":"Not logged in"}"#, stderr: "boom", code: 1), callModel: "sonnet")
        ) { error in
            XCTAssertEqual((error as? CloudError)?.message, "claude reported an error: Not logged in")
        }
        XCTAssertThrowsError(try claudeReply(ProcessResult(stdout: "", stderr: "", code: 0), callModel: "sonnet")) { error in
            XCTAssertEqual((error as? CloudError)?.message, "claude returned nothing on stdout")
        }
    }

    func testClaudeTimeoutText() {
        XCTAssertEqual(claudeTimeoutText(600), "600000")
        XCTAssertEqual(claudeTimeoutText(1.1), "1100")
        XCTAssertEqual(claudeTimeoutText(0.3), "300")
        XCTAssertEqual(claudeTimeoutText(.nan), "NaN")
    }

    // MARK: - Codex and Antigravity: arguments and replies

    func testCodexArguments() {
        // TS (sort, model gpt-5.5)
        XCTAssertEqual(
            CodexProvider.arguments(model: "gpt-5.5", task: .sort, work: "/tmp/lockin-codex-vbHL9A", out: "/tmp/lockin-codex-vbHL9A/reply.txt", pictures: []),
            [
                "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only",
                "--cd", "/tmp/lockin-codex-vbHL9A", "--output-last-message", "/tmp/lockin-codex-vbHL9A/reply.txt",
                "-c", "model_reasoning_effort=\"low\"", "--model", "gpt-5.5", "-",
            ]
        )
        let pictures = [SlidePicture(slide: 1, file: "/p/1.png"), SlidePicture(slide: 2, file: "/p/2.png")]
        XCTAssertEqual(
            CodexProvider.arguments(model: "", task: .digest, work: "/w", out: "/w/reply.txt", pictures: pictures),
            [
                "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only",
                "--cd", "/w", "--output-last-message", "/w/reply.txt",
                "-c", "model_reasoning_effort=\"medium\"", "--image", "/p/1.png", "--image", "/p/2.png", "-",
            ]
        )
    }

    func testAntigravityArguments() {
        // TS
        XCTAssertEqual(
            AntigravityProvider.arguments(model: "", slides: nil),
            ["--output-format", "json", "--skip-trust", "--prompt", "Follow the instructions above."]
        )
        XCTAssertEqual(
            AntigravityProvider.arguments(model: "", slides: SlidesInfo(lectureId: "l1", decks: agyDecks)),
            [
                "--output-format", "json", "--skip-trust",
                "--include-directories", "/data/materials/l1", "--include-directories", "/data/other",
                "--prompt",
                "The slide decks: @/data/materials/l1/A.pdf @/data/materials/l1/B.pdf @/data/other/D.pdf — read every page, then follow the instructions above.",
            ]
        )
        XCTAssertEqual(
            AntigravityProvider.arguments(model: "gemini-3-pro", slides: nil),
            ["--output-format", "json", "--skip-trust", "--model", "gemini-3-pro", "--prompt", "Follow the instructions above."]
        )
    }

    func testAntigravityReply() throws {
        // TS
        XCTAssertEqual(
            try antigravityReply(ProcessResult(
                stdout: #"{"response":"{\"answer\":\"From Gemini\",\"section\":null}","stats":{"models":{"gemini-2.5-pro":{"tokens":{}}}}}"# + "\n",
                stderr: "",
                code: 0
            )),
            Reply(text: #"{"answer":"From Gemini","section":null}"#, model: "gemini-2.5-pro")
        )
        XCTAssertEqual(try antigravityReply(ProcessResult(stdout: #"{"response":"hi"}"#, stderr: "", code: 0)), Reply(text: "hi", model: nil))

        let failures: [(ProcessResult, String)] = [
            (ProcessResult(stdout: #"{"error":"Quota exceeded"}"#, stderr: "", code: 1), "Antigravity couldn't answer: Quota exceeded"),
            (ProcessResult(stdout: #"{"error":{"message":"Sign in first"},"response":"x"}"#, stderr: "", code: 1), "Antigravity couldn't answer: Sign in first"),
            (ProcessResult(stdout: #"{"error":{}}"#, stderr: "", code: 1), "Antigravity couldn't answer: no reply"),
            (ProcessResult(stdout: #"{"response":42}"#, stderr: "", code: 0), "Antigravity couldn't answer: no reply"),
            (ProcessResult(stdout: #"{"error":"","response":null}"#, stderr: "", code: 0), "Antigravity couldn't answer: "),
            (ProcessResult(stdout: "Loading…\nnot json", stderr: "Error: not signed in\n\n", code: 1), "Antigravity couldn't answer: Error: not signed in"),
            (ProcessResult(stdout: "Loading…\nstill loading  \n", stderr: "", code: 1), "Antigravity couldn't answer: still loading"),
            (ProcessResult(stdout: "", stderr: "", code: 2), "Antigravity couldn't answer: exit code 2"),
            (ProcessResult(stdout: "", stderr: "", code: nil), "Antigravity couldn't answer: exit code null"),
        ]
        for (run, message) in failures {
            XCTAssertThrowsError(try antigravityReply(run)) { error in
                XCTAssertEqual((error as? CloudError)?.message, message)
            }
        }
        XCTAssertThrowsError(try antigravityReply(ProcessResult(stdout: "null", stderr: "", code: 0))) { error in
            XCTAssertEqual(error as? LockinError, LockinError("Cannot read properties of null (reading 'error')"))
        }
    }

    func testLastLine() {
        // TS
        XCTAssertEqual(ProcessRunner.lastLine("  first\r\n\n  second line  \n\n"), "second line")
        XCTAssertEqual(ProcessRunner.lastLine(""), "")
        XCTAssertEqual(ProcessRunner.lastLine("\n \n"), "")
        XCTAssertEqual(ProcessRunner.lastLine("x\n" + String(repeating: "é", count: 500) + "\n").utf16.count, 400)
    }

    func testNodePathHelpers() {
        // Node's path.posix.dirname / basename.
        let cases: [(String, String, String)] = [
            ("/a/b/c.pdf", "/a/b", "c.pdf"),
            ("/c.pdf", "/", "c.pdf"),
            ("c.pdf", ".", "c.pdf"),
            ("/a/b/", "/a", "b"),
            ("//x", "//", "x"),
            ("/", "/", ""),
            ("", ".", ""),
            ("a/b", "a", "b"),
            ("///a//b//", "///a/", "b"),
        ]
        for (path, dirname, basename) in cases {
            XCTAssertEqual(nodeDirname(path), dirname, path)
            XCTAssertEqual(nodeBasename(path), basename, path)
        }
    }

    // MARK: - Running a command

    func testSearchPathPutsTheUsualFoldersFirst() {
        XCTAssertEqual(
            ProcessRunner.searchPath(environment: ["PATH": "/usr/bin:/custom/bin::/opt/homebrew/bin", "HOME": "/Users/test"]),
            [
                "/opt/homebrew/bin", "/usr/local/bin", "/Users/test/.local/bin", "/Users/test/.bun/bin",
                "/Users/test/.npm-global/bin", "/usr/bin", "/custom/bin", "/bin", "/Users/test/.claude/local",
            ]
        )
    }

    func testTimerDelayFollowsSetTimeout() {
        XCTAssertEqual(ProcessRunner.timerDelay(600), 600)
        XCTAssertEqual(ProcessRunner.timerDelay(0), 0.001)
        XCTAssertEqual(ProcessRunner.timerDelay(.nan), 0.001)
        XCTAssertEqual(ProcessRunner.timerDelay(3_000_000), 0.001)
    }

    func testResolveExecutableOnAFakePath() throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let name = "lockin-tool-\(UUID().uuidString)"
        let script = try writeScript(folder, name, "exit 0")
        try writeScript(folder, name + "-plain", "exit 0", executable: false)
        try FileManager.default.createDirectory(at: folder.appendingPathComponent(name + "-folder"), withIntermediateDirectories: true)
        let environment = ["PATH": folder.path, "HOME": folder.path]

        XCTAssertEqual(ProcessRunner.resolveExecutable(name, environment: environment), script)
        XCTAssertEqual(ProcessRunner.resolveExecutable(script, environment: [:]), script)
        XCTAssertNil(ProcessRunner.resolveExecutable(name + "-plain", environment: environment))
        XCTAssertNil(ProcessRunner.resolveExecutable(name + "-folder", environment: environment))
        XCTAssertNil(ProcessRunner.resolveExecutable(name, environment: ["PATH": "/nowhere", "HOME": folder.path]))
        XCTAssertNil(ProcessRunner.resolveExecutable("", environment: environment))
    }

    func testRunPassesInputAndCollectsOutput() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "echo-tool", "cat\necho \"warning: slow\" >&2\nexit 3")
        let input = "Ghrelin — rises before meals ü 🎓\nline two"
        let result = try await ProcessRunner.run(script, arguments: [], input: input, timeout: 30, what: "Echo", install: "")
        XCTAssertEqual(result, ProcessResult(stdout: input, stderr: "warning: slow\n", code: 3))
    }

    func testRunStreamsALongInput() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "cat-tool", "exec cat")
        let input = String(repeating: "transcript line\n", count: 150_000)
        let result = try await ProcessRunner.run(script, arguments: [], input: input, timeout: 60, what: "Cat", install: "")
        XCTAssertEqual(result.code, 0)
        XCTAssertEqual(result.stdout.utf8.count, input.utf8.count)
    }

    func testRunPassesArgumentsAsTheyAre() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "args-tool", "printf '%s\\n' \"$@\"")
        let arguments = ["--prompt", "it's \"quoted\" $HOME; rm -rf /", "two words", ""]
        let result = try await ProcessRunner.run(script, arguments: arguments, input: "", timeout: 30, what: "Args", install: "")
        XCTAssertEqual(result.stdout, arguments.map { $0 + "\n" }.joined())
    }

    func testRunGivesTheCommandTheSearchPath() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "path-tool", "printf '%s' \"$PATH\"")
        let environment = ["PATH": "/custom/bin", "HOME": "/Users/test"]
        let result = try await ProcessRunner.run(script, arguments: [], input: "", timeout: 30, what: "Path", install: "", environment: environment)
        XCTAssertEqual(result.stdout, ProcessRunner.searchPath(environment: environment).joined(separator: ":"))
        XCTAssertTrue(result.stdout.hasPrefix("/opt/homebrew/bin:/usr/local/bin:/Users/test/.local/bin"))
    }

    func testRunReportsAKilledCommandWithNoExitCode() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "self-kill", "kill -9 $$")
        let result = try await ProcessRunner.run(script, arguments: [], input: "", timeout: 30, what: "Tool", install: "")
        XCTAssertNil(result.code)
    }

    func testRunExplainsAMissingCommand() async {
        let name = "lockin-missing-\(UUID().uuidString)"
        let error = await failure {
            _ = try await ProcessRunner.run(name, arguments: [], input: "x", timeout: 30, what: "Tool", install: "Install it.")
        }
        XCTAssertEqual((error as? CloudError)?.message, "could not run \"\(name)\" (spawn \(name) ENOENT). Install it.")
    }

    func testRunExplainsAFileThatCannotRun() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = try writeScript(folder, "not-executable", "exit 0", executable: false)
        let error = await failure {
            _ = try await ProcessRunner.run(file, arguments: [], input: "", timeout: 30, what: "Tool", install: "Install it.")
        }
        XCTAssertEqual((error as? CloudError)?.message, "could not run \"\(file)\" (spawn \(file) EACCES). Install it.")
    }

    func testRunGivesUpAfterTheTimeout() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "slow-tool", "exec sleep 30")
        let started = Date()
        let error = await failure {
            _ = try await ProcessRunner.run(script, arguments: [], input: "", timeout: 0.3, what: "Slow tool", install: "")
        }
        XCTAssertEqual((error as? CloudError)?.message, "Slow tool gave no answer after 0s")
        XCTAssertLessThan(Date().timeIntervalSince(started), 10)
    }

    func testRunKillsTheCommandWhenCancelled() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "slow-tool", "exec sleep 30")
        let started = Date()
        let task = Task {
            try await ProcessRunner.run(script, arguments: [], input: "", timeout: 60, what: "Slow tool", install: "")
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        task.cancel()
        let error = await failure { _ = try await task.value }
        XCTAssertTrue(error is CancellationError, "\(String(describing: error))")
        XCTAssertLessThan(Date().timeIntervalSince(started), 10)
    }

    func testRunAlreadyCancelledStartsNothing() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let marker = folder.appendingPathComponent("ran.txt")
        let script = try writeScript(folder, "marker-tool", "touch \"\(marker.path)\"")
        let task = Task { () async throws -> ProcessResult in
            _ = withUnsafeCurrentTask { $0?.cancel() }
            return try await ProcessRunner.run(script, arguments: [], input: "", timeout: 30, what: "Tool", install: "")
        }
        let error = await failure { _ = try await task.value }
        XCTAssertTrue(error is CancellationError, "\(String(describing: error))")
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
    }

    // MARK: - Detecting the tools

    func testDetectFindsAToolOnTheSearchPath() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let name = "lockin-claude-\(UUID().uuidString)"
        try writeScript(folder, name, "echo '2.1.0 (Claude Code)'\necho 'more'")
        let status = await CLIDetect.claude(environment: ["PATH": folder.path, "HOME": folder.path, "LOCKIN_CLAUDE_BIN": name])
        XCTAssertEqual(status, CLIStatus(found: true, version: "2.1.0 (Claude Code)", binary: name))
    }

    func testDetectMissingOrFailingTools() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let missing = "lockin-missing-\(UUID().uuidString)"
        let codex = await CLIDetect.codex(environment: ["PATH": folder.path, "HOME": folder.path, "LOCKIN_CODEX_BIN": missing])
        XCTAssertEqual(codex, CLIStatus(found: false, version: nil, binary: missing))

        let failing = "lockin-failing-\(UUID().uuidString)"
        try writeScript(folder, failing, "echo 'oops' >&2\nexit 1")
        let status = await CLIDetect.codex(environment: ["PATH": folder.path, "HOME": folder.path, "LOCKIN_CODEX_BIN": failing])
        XCTAssertEqual(status, CLIStatus(found: false, version: nil, binary: failing))

        let silent = "lockin-silent-\(UUID().uuidString)"
        try writeScript(folder, silent, "exit 0")
        let quiet = await CLIDetect.codex(environment: ["PATH": folder.path, "HOME": folder.path, "LOCKIN_CODEX_BIN": silent])
        XCTAssertEqual(quiet, CLIStatus(found: true, version: nil, binary: silent))
    }

    func testDetectUnderTheFakeProvider() async {
        let fake = CLIStatus(found: true, version: "fake provider", binary: "fake")
        let environment = ["LOCKIN_PROVIDER": "fake", "PATH": "/nowhere", "HOME": "/nowhere"]
        let claude = await CLIDetect.claude(environment: environment)
        let codex = await CLIDetect.codex(environment: environment)
        let agy = await CLIDetect.antigravity(environment: environment)
        var forced = environment
        forced["LOCKIN_AGY_BIN"] = "agy-nightly"
        let agyForced = await CLIDetect.antigravity(environment: forced)
        XCTAssertEqual([claude, codex, agy, agyForced], [fake, fake, fake, fake])
    }

    func testDetectAntigravityForcedOrGemini() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let forced = "lockin-agy-\(UUID().uuidString)"
        try writeScript(folder, forced, "echo '1.0.0'")
        let environment = ["PATH": folder.path, "HOME": folder.path]
        var withForced = environment
        withForced["LOCKIN_AGY_BIN"] = forced
        let forcedStatus = await CLIDetect.antigravity(environment: withForced)
        XCTAssertEqual(forcedStatus, CLIStatus(found: true, version: "1.0.0", binary: forced))

        try XCTSkipIf(ProcessRunner.resolveExecutable("agy", environment: environment) != nil, "agy is installed on this machine")
        try XCTSkipIf(ProcessRunner.resolveExecutable("gemini", environment: environment) != nil, "gemini is installed on this machine")
        let nothing = await CLIDetect.antigravity(environment: environment)
        XCTAssertEqual(nothing, CLIStatus(found: false, version: nil, binary: "agy"))

        try writeScript(folder, "gemini", "echo '0.9.0'")
        CLIDetect.clearCache()
        let gemini = await CLIDetect.antigravity(environment: environment)
        XCTAssertEqual(gemini, CLIStatus(found: true, version: "0.9.0", binary: "gemini"))
    }

    func testDetectRemembersTheAnswerForAMinute() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let name = "lockin-codex-\(UUID().uuidString)"
        let script = try writeScript(folder, name, "echo 'codex-cli 0.50.0'")
        let environment = ["PATH": folder.path, "HOME": folder.path, "LOCKIN_CODEX_BIN": name]
        let first = await CLIDetect.codex(environment: environment)
        XCTAssertTrue(first.found)
        try FileManager.default.removeItem(atPath: script)
        let cached = await CLIDetect.codex(environment: environment)
        XCTAssertEqual(cached, first)
        CLIDetect.clearCache()
        let fresh = await CLIDetect.codex(environment: environment)
        XCTAssertFalse(fresh.found)
    }

    // MARK: - Providers against fake tools

    func testClaudeCodeAnswersAQuestion() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "claude", #"""
        printf '%s\n' "$@" > "\#(folder.path)/args.txt"
        cat > "\#(folder.path)/stdin.txt"
        cat <<'JSON'
        {"type":"result","is_error":false,"result":"```json\n{\"answer\":\"Ghrelin rises before meals.\",\"section\":\"Hunger\"}\n```","modelUsage":{"claude-haiku-4-5":{"outputTokens":3},"claude-sonnet-4-5":{"outputTokens":42}}}
        JSON
        """#)
        let provider = ClaudeCodeProvider(config: claudeConfig(binary: script), promptsDirectory: cliRepoPrompts)
        let answer = try await provider.ask(sampleAsk)
        XCTAssertEqual(answer, Answer(answer: "Ghrelin rises before meals.", section: "Hunger"))
        XCTAssertEqual(provider.lastModel, "Claude Code · claude-sonnet-4-5")
        XCTAssertEqual(provider.lastPromptVersion, "answer-question@1.0.0")
        XCTAssertEqual(
            recordedArguments(folder.appendingPathComponent("args.txt")),
            ["-p", "--output-format", "json", "--model", "sonnet", "--effort", "low",
             "--disallowed-tools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task"]
        )
        XCTAssertTrue(readText(folder.appendingPathComponent("stdin.txt")).contains("What rises before meals?"))
    }

    func testClaudeCodeDigestOpensThePicturedDecks() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "claude", #"""
        printf '%s\n' "$@" > "\#(folder.path)/args.txt"
        cat > "\#(folder.path)/stdin.txt"
        cat <<'JSON'
        {"type":"result","is_error":false,"result":"{\"title\":\"T\",\"summaryMd\":\"## A\",\"concepts\":[]}","modelUsage":{"claude-sonnet-4-5":{"outputTokens":42}}}
        JSON
        """#)
        let provider = ClaudeCodeProvider(config: claudeConfig(binary: script), promptsDirectory: cliRepoPrompts)
        let input = DigestInput(
            currentTitle: "appetite",
            titleIsPlaceholder: true,
            durationHours: 1,
            transcript: "Ghrelin rises before meals.",
            slidesText: "--- Slide 1 ---\nGhrelin",
            slides: SlidesInfo(lectureId: "l1", decks: claudeDecks)
        )
        let digest = try await provider.digest(input)
        // TS
        XCTAssertEqual(digest, LectureDigest(title: "T", summaryMd: "## A", concepts: []))
        XCTAssertEqual(provider.lastModel, "Claude Code · claude-sonnet-4-5")
        XCTAssertEqual(provider.lastPromptVersion, "digest-lecture@1.2.0")
        XCTAssertEqual(recordedArguments(folder.appendingPathComponent("args.txt")), [
            "-p", "--output-format", "json", "--model", "sonnet", "--effort", "medium",
            "--allowed-tools", "Read", "--add-dir", "/data/materials/l1",
            "--disallowed-tools", "Bash,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task",
        ])
        XCTAssertTrue(readText(folder.appendingPathComponent("stdin.txt")).hasSuffix(tsReadDecksNote))
    }

    func testClaudeCodeRepairsOnceThenSaysWhyItFailed() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "claude", #"""
        echo run >> "\#(folder.path)/runs.txt"
        cat > /dev/null
        echo "Invalid API key · Please run /login" >&2
        exit 1
        """#)
        let provider = ClaudeCodeProvider(config: claudeConfig(binary: script), promptsDirectory: cliRepoPrompts)
        let error = await failure { _ = try await provider.sortFiles(SortFilesInput(files: [])) }
        XCTAssertEqual((error as? CloudError)?.message, "claude exited 1: Invalid API key · Please run /login")
        XCTAssertEqual(recordedArguments(folder.appendingPathComponent("runs.txt")), ["run", "run"])
    }

    func testClaudeCodeTimesOut() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "claude", "exec sleep 30")
        let provider = ClaudeCodeProvider(config: claudeConfig(binary: script, timeout: 0.3), promptsDirectory: cliRepoPrompts)
        let error = await failure { _ = try await provider.ask(sampleAsk) }
        XCTAssertEqual((error as? CloudError)?.message, "claude timed out after 300ms")
    }

    func testClaudeCodeExplainsAMissingCli() async {
        let name = "lockin-missing-\(UUID().uuidString)"
        let provider = ClaudeCodeProvider(config: claudeConfig(binary: name), promptsDirectory: cliRepoPrompts)
        let error = await failure { _ = try await provider.ask(sampleAsk) }
        XCTAssertEqual(
            (error as? CloudError)?.message,
            "could not run \"\(name)\" (spawn \(name) ENOENT). Install it with `npm i -g @anthropic-ai/claude-code` and run `claude` once to log in."
        )
    }

    /// A Codex stand-in: signed in, writes the reply where --output-last-message says.
    private func fakeCodex(_ folder: URL, signedIn: Bool = true, reply: String = #"{"answer":"From Codex","section":null}"#) throws -> String {
        let login = signedIn ? "echo 'Logged in using ChatGPT'; exit 0" : "echo 'Not logged in' >&2; exit 1"
        return try writeScript(folder, "codex", #"""
        if [ "$1" = "login" ]; then
          echo login >> "\#(folder.path)/logins.txt"
          \#(login)
        fi
        printf '%s\n' "$@" > "\#(folder.path)/args.txt"
        out=""
        while [ $# -gt 0 ]; do
          if [ "$1" = "--output-last-message" ]; then shift; out="$1"; fi
          shift
        done
        cat > "\#(folder.path)/stdin.txt"
        printf '%s' '\#(reply)' > "$out"
        """#)
    }

    func testCodexAnswersFromItsOwnFolder() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let binary = try fakeCodex(folder)
        let provider = CodexProvider(binary: binary, model: "gpt-5.5", renderer: PathOnlyRenderer(), promptsDirectory: cliRepoPrompts)
        let answer = try await provider.ask(sampleAsk)
        XCTAssertEqual(answer, Answer(answer: "From Codex", section: nil))
        XCTAssertEqual(provider.lastModel, "ChatGPT Codex · gpt-5.5")
        XCTAssertEqual(provider.lastPromptVersion, "answer-question@1.0.0")

        let args = recordedArguments(folder.appendingPathComponent("args.txt"))
        XCTAssertEqual(args.count, 14)
        guard args.count == 14 else { return }
        let work = args[6]
        XCTAssertTrue(URL(fileURLWithPath: work).lastPathComponent.hasPrefix("lockin-codex-"))
        XCTAssertEqual(args[8], work + "/reply.txt")
        // TS
        XCTAssertEqual(args, [
            "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only",
            "--cd", work, "--output-last-message", work + "/reply.txt",
            "-c", "model_reasoning_effort=\"low\"", "--model", "gpt-5.5", "-",
        ])
        XCTAssertFalse(FileManager.default.fileExists(atPath: work), "the work folder is removed")
        let stdin = readText(folder.appendingPathComponent("stdin.txt"))
        XCTAssertTrue(stdin.hasPrefix("Answer from the text below alone: do not run any commands or open any files.\n\n"))
        XCTAssertTrue(stdin.contains("What rises before meals?"))

        // The sign-in is asked once, then trusted for five minutes.
        _ = try await provider.ask(sampleAsk)
        XCTAssertEqual(recordedArguments(folder.appendingPathComponent("logins.txt")), ["login"])
    }

    func testCodexAttachesTheSlidePictures() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let binary = try fakeCodex(folder)
        let provider = CodexProvider(binary: binary, model: "", renderer: PathOnlyRenderer(), promptsDirectory: cliRepoPrompts)
        let slides = SlidesInfo(lectureId: "l1", decks: agyDecks)
        let reply = try await provider.complete("PROMPT", options: CallOptions(task: .digest, slides: slides))
        XCTAssertEqual(reply, Reply(text: #"{"answer":"From Codex","section":null}"#))

        let expected = (1...15).map { slide -> SlidePicture in
            if slide == 1 { return SlidePicture(slide: 1, file: "/pictures/l1/A/1.png") }
            if slide <= 13 { return SlidePicture(slide: slide, file: "/pictures/l1/B/\(slide - 1).png") }
            return SlidePicture(slide: slide + 3, file: "/pictures/l1/D/\(slide - 13).png")
        }
        let args = recordedArguments(folder.appendingPathComponent("args.txt"))
        XCTAssertEqual(Array(args.suffix(31)), expected.flatMap { ["--image", $0.file] } + ["-"])
        XCTAssertTrue(args.contains("model_reasoning_effort=\"medium\""))
        XCTAssertFalse(args.contains("--model"))
        XCTAssertEqual(
            readText(folder.appendingPathComponent("stdin.txt")),
            "Answer from the text below alone: do not run any commands or open any files.\n\nPROMPT"
                + picturesNote(expected, total: 15)
        )
    }

    func testCodexSignedOut() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let binary = try fakeCodex(folder, signedIn: false)
        let provider = CodexProvider(binary: binary, model: "", renderer: PathOnlyRenderer(), promptsDirectory: cliRepoPrompts)
        let error = await failure { _ = try await provider.ask(sampleAsk) }
        XCTAssertEqual((error as? CloudError)?.message, "Codex isn't signed in — run `codex login` in a terminal, then try again")
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("args.txt").path))
    }

    func testCodexFailureQuotesItsLastLine() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "codex", #"""
        if [ "$1" = "login" ]; then exit 0; fi
        echo run >> "\#(folder.path)/runs.txt"
        cat > /dev/null
        printf 'starting\nerror: usage limit reached  \n\n' >&2
        exit 2
        """#)
        let provider = CodexProvider(binary: script, model: "", renderer: PathOnlyRenderer(), promptsDirectory: cliRepoPrompts)
        let error = await failure { _ = try await provider.ask(sampleAsk) }
        XCTAssertEqual((error as? CloudError)?.message, "Codex couldn't answer: error: usage limit reached")
        // Not a reply that could be repaired: asked once.
        XCTAssertEqual(recordedArguments(folder.appendingPathComponent("runs.txt")), ["run"])
    }

    func testAntigravityAttachesTheDecks() async throws {
        let folder = try scratchFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let script = try writeScript(folder, "gemini", #"""
        printf '%s\n' "$@" > "\#(folder.path)/args.txt"
        cat > "\#(folder.path)/stdin.txt"
        cat <<'JSON'
        {"response":"{\"answer\":\"From Gemini\",\"section\":null}","stats":{"models":{"gemini-2.5-pro":{"tokens":{}}}}}
        JSON
        """#)
        let provider = AntigravityProvider(binary: script, model: "", promptsDirectory: cliRepoPrompts)
        XCTAssertEqual(provider.lastModel, "Gemini CLI · auto")
        let answer = try await provider.ask(sampleAsk)
        // TS
        XCTAssertEqual(answer, Answer(answer: "From Gemini", section: nil))
        XCTAssertEqual(provider.lastModel, "Gemini CLI · gemini-2.5-pro")
        XCTAssertEqual(
            recordedArguments(folder.appendingPathComponent("args.txt")),
            ["--output-format", "json", "--skip-trust", "--prompt", "Follow the instructions above."]
        )

        let reply = try await provider.complete("PROMPT", options: CallOptions(task: .digest, slides: SlidesInfo(lectureId: "l1", decks: agyDecks)))
        XCTAssertEqual(reply, Reply(text: #"{"answer":"From Gemini","section":null}"#, model: "gemini-2.5-pro"))
        XCTAssertEqual(recordedArguments(folder.appendingPathComponent("args.txt")), [
            "--output-format", "json", "--skip-trust",
            "--include-directories", "/data/materials/l1", "--include-directories", "/data/other",
            "--prompt",
            "The slide decks: @/data/materials/l1/A.pdf @/data/materials/l1/B.pdf @/data/other/D.pdf — read every page, then follow the instructions above.",
        ])
        XCTAssertEqual(readText(folder.appendingPathComponent("stdin.txt")), tsAgyStdin)
    }
}
