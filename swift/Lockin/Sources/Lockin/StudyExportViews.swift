import AppKit
import SwiftUI
import WebKit
import LockinCore
import UniformTypeIdentifiers

struct LibraryExportButton: View {
    let store: AppStore
    let lectureIds: [String]
    @State private var showing = false
    var body: some View {
        Button("Export summaries…") { showing = true }
            .disabled(lectureIds.isEmpty)
            .sheet(isPresented: $showing) { StudyExportSheet(store: store, initialLectureIds: lectureIds) }
    }
}

struct StudyExportSheet: View {
    @Bindable var store: AppStore
    let initialLectureIds: [String]
    @Environment(\.dismiss) private var dismiss
    @State private var selected = Set<String>()
    @State private var paper: StudyPaper = .a4
    @State private var glossary = true
    @State private var contents = true
    @State private var newPage = true
    @State private var document: StudyExportDocument?
    @State private var error: String?
    @State private var ready = false
    @State private var exporting = false
    @State private var webView: WKWebView?
    @State private var courseId = ""
    @State private var moduleId = ""

    private var choices: [LectureRow] {
        store.lectureRows.filter { (courseId.isEmpty || $0.courseId == courseId) && (moduleId.isEmpty || $0.moduleId == moduleId) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("Export summaries").font(.title2.bold()); Spacer(); Button("Done") { dismiss() } }
            HStack(alignment: .top, spacing: 20) {
                VStack(alignment: .leading, spacing: 10) {
                    Picker("Course", selection: $courseId) {
                        Text("All courses").tag("")
                        ForEach(store.courses) { Text($0.code).tag($0.id) }
                    }
                    Picker("Module", selection: $moduleId) {
                        Text("All modules").tag("")
                        ForEach(store.modules.filter { courseId.isEmpty || $0.courseId == courseId }) { Text($0.title).tag($0.id) }
                    }
                    HStack {
                        Button("Select shown") { selected.formUnion(choices.map(\.id)); invalidate() }
                        Button("Clear") { selected.removeAll(); invalidate() }
                    }
                    ScrollView {
                        VStack(alignment: .leading) {
                            ForEach(choices) { row in
                                Toggle(row.title, isOn: Binding(get: { selected.contains(row.id) }, set: { on in
                                    if on { selected.insert(row.id) } else { selected.remove(row.id) }
                                    invalidate()
                                }))
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Text("\(selected.count) selected across all filters").font(.caption)
                    Picker("Paper", selection: $paper) { ForEach(StudyPaper.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                    Toggle("Include glossary", isOn: $glossary)
                    Toggle("Contents page", isOn: $contents)
                    Toggle("New page per lecture", isOn: $newPage)
                    Button("Preview") { preview() }.disabled(selected.isEmpty)
                }.frame(width: 270)
                if let document {
                    ExportWebPreview(store: store, html: document.html, onReady: { view, problem in
                        webView = view; ready = problem == nil; error = problem
                    }).frame(minWidth: 480)
                } else {
                    ContentUnavailableView("Choose summaries", systemImage: "doc.richtext", description: Text("Select lectures, then preview your document."))
                        .frame(minWidth: 480)
                }
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                if let document { Text("\(document.count) summaries · \(document.omitted) without summaries omitted").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("Save PDF…") { savePDF() }.buttonStyle(.borderedProminent).disabled(!ready || document == nil)
            }
        }.padding(24).frame(width: 920, height: 720)
        .disabled(exporting)
        .overlay { if exporting { ProgressView("Creating PDF…").padding(20).background(.regularMaterial).clipShape(RoundedRectangle(cornerRadius: 12)) } }
        .interactiveDismissDisabled(exporting)
        .onAppear { selected = Set(initialLectureIds); preview() }
        .onChange(of: courseId) { _, _ in moduleId = "" }
        .onChange(of: paper) { _, _ in invalidate() }
        .onChange(of: glossary) { _, _ in invalidate() }
        .onChange(of: contents) { _, _ in invalidate() }
        .onChange(of: newPage) { _, _ in invalidate() }
    }
    private func invalidate() { document = nil; ready = false; webView = nil; error = nil }
    private func preview() {
        do {
            guard let database = store.database else { return }
            ready = false; error = nil
            document = try studyExportDocument(database: database, lectureIds: Array(selected), options: .init(paper: paper, glossary: glossary, contents: contents, newPagePerLecture: newPage), renderer: store.slideRenderer)
        } catch { self.error = error.localizedDescription }
    }
    private func savePDF() {
        guard let webView, let document, ready else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        panel.nameFieldStringValue = safeStudyFileName(document.title) + ".pdf"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        exporting = true
        Task { @MainActor in
            defer { exporting = false }
            do {
                let data = try await createStudyPDF(webView: webView, paper: paper)
                try data.write(to: url, options: .atomic)
            } catch { self.error = error.localizedDescription }
        }
    }
}

struct ExportWebPreview: NSViewRepresentable {
    let store: AppStore
    let html: String
    let onReady: (WKWebView, String?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(SlideURLSchemeHandler(database: store.database, renderer: store.slideRenderer), forURLScheme: SlideURLSchemeHandler.scheme)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.loaded != html {
            context.coordinator.loaded = html
            view.loadHTMLString(html, baseURL: nil)
        }
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: ExportWebPreview
        var loaded = ""
        init(_ parent: ExportWebPreview) { self.parent = parent }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // didFinish follows resource loading. Refuse silent PDFs with missing slides.
            webView.evaluateJavaScript("Array.from(document.images).filter(i => !i.complete || i.naturalWidth === 0).length") { value, error in
                let missing = value as? Int ?? 0
                self.parent.onReady(webView, error?.localizedDescription ?? (missing > 0 ? "\(missing) slide images could not load. Restore the slide files and preview again." : nil))
            }
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { parent.onReady(webView, error.localizedDescription) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { parent.onReady(webView, error.localizedDescription) }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.navigationType == .linkActivated ? .cancel : .allow)
        }
    }
}
