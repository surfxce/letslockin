import XCTest
import AppKit
import WebKit
import PDFKit
@testable import LockinCore

@MainActor
final class SummaryWebTests: XCTestCase {
    private final class Bridge: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let loaded: XCTestExpectation
        var messages: [[String: Any]] = []
        var didLoad = false
        var window: NSWindow?
        init(_ loaded: XCTestExpectation) { self.loaded = loaded }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { didLoad = true; loaded.fulfill() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            XCTFail(error.localizedDescription); loaded.fulfill()
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if let value = message.body as? [String: Any] { messages.append(value) }
        }
    }
    private func load(_ html: String) async throws -> (WKWebView, Bridge) {
        _ = NSApplication.shared
        let loaded = expectation(description: "WebKit document loaded")
        let bridge = Bridge(loaded)
        let config = WKWebViewConfiguration()
        config.userContentController.add(bridge, name: "lockinReader")
        config.userContentController.add(bridge, name: "lockinEditor")
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 740, height: 800), configuration: config)
        let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = web
        bridge.window = window
        web.navigationDelegate = bridge
        web.loadHTMLString(html, baseURL: nil)
        await fulfillment(of: [loaded], timeout: 15)
        guard bridge.didLoad else { throw LockinError("WebKit did not load the test document in 15 seconds.") }
        return (web, bridge)
    }

    func testEditorPreservesMultipleSlidesCropsAndCodeWhileChangingSelection() async throws {
        let markdown = "# First\n\nSecond paragraph\n\n![Pathway](slide:2-3#crop=2:0.1,0.2,0.5,0.4)\n\n```swift\nlet answer = 42\n```\n"
        let (web, bridge) = try await load(buildEditorDocumentHTML(bodyHTML: renderMarkdown(markdown, preserveSlideSource: true)))
        let before = try await web.evaluateJavaScript("serializeEditor()") as? String
        XCTAssertTrue(before?.contains("![Pathway](slide:2-3#crop=2:0.1,0.2,0.5,0.4)") == true)
        XCTAssertTrue(before?.contains("```swift\nlet answer = 42\n```") == true)
        _ = try await web.evaluateJavaScript("""
        (() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#editor p'));
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange')); window.setLineKind('h2'); return true; })()
        """)
        let after = try await web.evaluateJavaScript("serializeEditor()") as? String
        XCTAssertTrue(after?.hasPrefix("# First\n\n## Second paragraph") == true)
        XCTAssertTrue(after?.contains("slide:2-3#crop=2:0.1,0.2,0.5,0.4") == true)
        let editable = try await web.evaluateJavaScript("document.querySelector('figure').contentEditable") as? String
        XCTAssertEqual(editable, "false")
        _ = bridge
    }

    func testReaderHighlightsEveryOccurrenceAndEmitsCorrectCropMessage() async throws {
        let body = renderMarkdown("# ATP\n\nATP supplies ATP; ADP is recycled.\n\n![Pathway](slide:2#crop=2:0.1,0.2,0.5,0.4)", slides: .init(base: "missing://lectures/a/slides", ranges: [(1, 3)], croppable: true))
        let terms = #"[{"id":"atp","term":"ATP","explanation":"Energy"},{"id":"adp","term":"ADP","explanation":"Product"}]"#
        let (web, bridge) = try await load(buildReaderDocumentHTML(bodyHTML: body, termsJSON: terms, savedScroll: 0))
        let count = try await web.evaluateJavaScript("document.querySelectorAll('mark.glossary-term').length") as? Int
        XCTAssertEqual(count, 4)
        _ = try await web.evaluateJavaScript("document.querySelector('button.slide-crop').click()")
        let crop = bridge.messages.first { $0["type"] as? String == "crop" }
        XCTAssertEqual(crop?["figure"] as? Int, 0)
        XCTAssertEqual(crop?["slide"] as? Int, 2)
        XCTAssertEqual(crop?["crop"] as? String, "0.1,0.2,0.5,0.4")
        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            web.appearance = NSAppearance(named: appearance)
            let image = try await web.takeSnapshot(configuration: nil)
            if ProcessInfo.processInfo.environment["LOCKIN_CAPTURE_WEB_TESTS"] == "1", let tiff = image.tiffRepresentation,
               let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) {
                try png.write(to: URL(fileURLWithPath: "/tmp/lockin-reader-\(name).png"))
            }
        }
    }

    func testGlossaryCannotBreakOutOfScript() async throws {
        let terms: JSONValue = .array([["id": "safe", "term": "ATP", "explanation": "</script><script>window.injected=true</script>"]])
        let (web, bridge) = try await load(buildReaderDocumentHTML(bodyHTML: "<p>ATP ATP</p>", termsJSON: terms.stringified(), savedScroll: 0))
        let injected = try await web.evaluateJavaScript("Boolean(window.injected)") as? Bool
        XCTAssertEqual(injected, false)
        let count = try await web.evaluateJavaScript("document.querySelectorAll('mark').length") as? Int
        XCTAssertEqual(count, 2)
        _ = bridge
    }

    func testPrintExportHasPaperPagesAndCompleteText() async throws {
        let database = try LockinDatabase.inMemory()
        try await database.writer.write { db in
            var course = Course(id: "export-course", code: "BIO", title: "Biology")
            try course.insert(db)
            for i in 1...2 {
                let points = (1...28).map { "- Point \($0): Cells use ATP to transfer energy between reactions." }.joined(separator: "\n")
                var lecture = Lecture(id: "export-\(i)", courseId: course.id, title: "Cell biology \(i)", deliveredOn: Date(), summaryMd: "## Energy transfer\n\n\(points)\n\nFinal fact \(i).")
                try lecture.insert(db)
            }
        }
        let document = try studyExportDocument(database: database, lectureIds: ["export-1", "export-2"], options: .init(), renderer: SlideRenderer())
        let (web, bridge) = try await load(document.html)
        let url = URL(fileURLWithPath: "/tmp/lockin-export-smoke.pdf")
        let data = try await createStudyPDF(webView: web, paper: .a4)
        try data.write(to: url)
        let pdf = try XCTUnwrap(PDFDocument(url: url))
        XCTAssertEqual(pdf.pageCount, 3)
        XCTAssertTrue(pdf.string?.contains("Final fact 1.") == true)
        XCTAssertTrue(pdf.string?.contains("Final fact 2.") == true)
        let page = try XCTUnwrap(pdf.page(at: 0))
        XCTAssertEqual(page.bounds(for: .mediaBox).width, StudyPaper.a4.width, accuracy: 1)
        _ = bridge
    }
}
