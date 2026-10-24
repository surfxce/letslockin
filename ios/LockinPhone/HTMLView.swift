import SwiftUI
import WebKit

/// A summary or card, rendered by the computer as HTML, shown with the slide pictures
/// this phone downloaded: lockin-slide://<lecture>/<n>[?crop=…] is served from them.
struct HTMLView: UIViewRepresentable {
    let html: String
    let images: ImageStore
    var scrolls = true

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SlideSchemeHandler(images: images), forURLScheme: "lockin-slide")
        // The pages are model-written text: nothing in them needs to run.
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = scrolls
        view.navigationDelegate = context.coordinator
        load(view, context: context)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        view.scrollView.isScrollEnabled = scrolls
        if context.coordinator.loaded != html { load(view, context: context) }
    }

    private func load(_ view: WKWebView, context: Context) {
        context.coordinator.loaded = html
        view.loadHTMLString(Self.page(html), baseURL: nil)
    }

    static func page(_ body: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>\(css)</style></head><body>\(wrapTables(body))</body></html>
        """
    }

    /// Each table in a box of its own that scrolls sideways, so a wide one doesn't widen the page.
    static func wrapTables(_ html: String) -> String {
        html.replacingOccurrences(of: "<table", with: "<div class=\"table-scroll\"><table")
            .replacingOccurrences(of: "</table>", with: "</table></div>")
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var loaded: String?

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            // Links open in Safari; the page itself never navigates away.
            guard action.navigationType == .linkActivated else { return .allow }
            if let url = action.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                _ = await UIApplication.shared.open(url)
            }
            return .cancel
        }
    }

    /// Lockin's reading style, as on the computer, in light and dark.
    static let css = """
    :root { color-scheme: light dark; --text: #37352f; --soft: #787774; --rule: rgba(55,53,47,.12); --accent: #2383e2; --code: rgba(135,131,120,.15); }
    @media (prefers-color-scheme: dark) { :root { --text: #e6e5e3; --soft: #9b9a97; --rule: rgba(255,255,255,.12); --accent: #529cca; } }
    html { -webkit-text-size-adjust: 100%; }
    body { font: -apple-system-body; color: var(--text); background: transparent; margin: 0; padding: 4px 18px 48px; line-height: 1.55; overflow-wrap: anywhere; }
    h1, h2, h3, h4 { line-height: 1.25; margin: 1.25em 0 .4em; font-weight: 650; }
    h1 { font-size: 1.45em; } h2 { font-size: 1.25em; } h3 { font-size: 1.08em; }
    body > :first-child { margin-top: .6em; }
    p, ul, ol, table, blockquote { margin: .55em 0; }
    ul, ol { padding-left: 1.35em; } li { margin: .22em 0; } li > ul, li > ol { margin: .2em 0; }
    strong { font-weight: 650; }
    a { color: var(--accent); }
    hr { border: 0; border-top: 1px solid var(--rule); margin: 1.4em 0; }
    blockquote { border-left: 3px solid var(--rule); padding-left: .8em; color: var(--soft); }
    code { font: .88em ui-monospace, Menlo, monospace; background: var(--code); padding: .1em .3em; border-radius: 4px; }
    pre { overflow-x: auto; background: var(--code); padding: 10px; border-radius: 8px; } pre code { background: none; padding: 0; }
    /* Tables keep their words whole and scroll sideways, not squash into a column of letters. */
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: .55em -18px; padding: 0 18px; }
    table { border-collapse: collapse; font-size: .92em; width: max-content; min-width: 100%; }
    th, td { border: 1px solid var(--rule); padding: 6px 9px; text-align: left; vertical-align: top;
             overflow-wrap: normal; word-break: normal; min-width: 5.5em; max-width: 17em; }
    th { font-weight: 600; }
    figure.slide-fig { margin: 16px 0; }
    figure.slide-fig img { display: block; width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--rule); background: #fff; margin: 0 0 8px; }
    figcaption { font-size: .82em; color: var(--soft); line-height: 1.4; }
    figcaption span { opacity: .85; }
    figure.missing { border: 1px dashed var(--rule); border-radius: 8px; padding: 8px 10px; }
    .ak-answer { border-top: 1px solid var(--rule); margin-top: 18px; padding-top: 6px; }
    .eyebrow { font-size: .72em; letter-spacing: .06em; text-transform: uppercase; color: var(--soft); font-weight: 600; margin: 14px 0 4px; }
    """
}

final class SlideSchemeHandler: NSObject, WKURLSchemeHandler {
    let images: ImageStore

    init(images: ImageStore) {
        self.images = images
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let lectureId = url.host else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        var ref = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if let query = url.query, !query.isEmpty { ref += "?" + query }
        guard let data = images.data(lectureId: lectureId, ref: ref) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        task.didReceive(URLResponse(url: url, mimeType: "image/jpeg", expectedContentLength: data.count, textEncodingName: nil))
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
