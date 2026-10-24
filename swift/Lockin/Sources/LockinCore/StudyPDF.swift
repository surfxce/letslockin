import Foundation
import WebKit
import PDFKit

/// CSS columns lay out real paper pages before createPDF captures each page. Capturing
/// the full scrolling document would produce one very tall page; AppKit's synchronous
/// print operation can hang in WebKit on macOS. This path is asynchronous throughout.
@MainActor
public func createStudyPDF(webView: WKWebView, paper: StudyPaper) async throws -> Data {
    let width = paper.width, height = paper.height
    let prepare = """
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload = resolve; image.onerror = resolve; })));
    if (Array.from(document.images).some(image => !image.naturalWidth)) throw new Error('A slide image could not load.');
    const style = document.createElement('style'); style.id = 'pdf-layout';
    style.textContent = `html,body { margin:0!important; padding:0!important; width:\(width)px!important; height:\(height)px!important; background:white!important; }
    #pdf-pages { position:absolute; left:45px; top:45px; width:\(width - 90)px; height:\(height - 90)px; column-width:\(width - 90)px; column-gap:90px; column-fill:auto; font-size:11px; line-height:1.5; }
    #pdf-pages h1 { font-size:23px; } #pdf-pages h2 { font-size:15px; } #pdf-pages h3 { font-size:12px; }
    #pdf-pages code { font-size:10px; } #pdf-pages .meta, #pdf-pages figcaption { font-size:9px; }
    #pdf-pages .cover { break-after:column; }
    #pdf-pages section { display:flow-root; }
    #pdf-pages section > :first-child { margin-top:0; }
    #pdf-pages .lecture { break-before:auto; }
    #pdf-pages .lecture + .lecture { break-before:var(--lecture-break,auto); }
    #pdf-pages figure { break-inside:avoid; } #pdf-pages figure img { max-height:\(height - 180)px; }
    #pdf-pages h1,#pdf-pages h2,#pdf-pages h3 { break-after:avoid; }
    `;
    const firstLecture = document.querySelector('.lecture + .lecture');
    const separate = firstLecture && getComputedStyle(firstLecture).breakBefore === 'page';
    document.head.append(style);
    const pages = document.createElement('div'); pages.id = 'pdf-pages';
    pages.style.setProperty('--lecture-break', separate ? 'column' : 'auto');
    while (document.body.firstChild) pages.append(document.body.firstChild);
    document.body.append(pages);
    return Math.max(1, Math.ceil((pages.scrollWidth + 89) / \(width)));
    """
    do {
        let value = try await webView.callAsyncJavaScript(prepare, arguments: [:], in: nil, contentWorld: .page)
        guard let count = value as? Int, count > 0, count <= 1000 else { throw LockinError("The export is too large. Choose fewer lectures.") }
        let document = PDFDocument()
        for index in 0..<count {
            try Task.checkCancellation()
            let configuration = WKPDFConfiguration()
            configuration.rect = CGRect(x: Double(index) * width, y: 0, width: width, height: height)
            let data = try await webView.pdf(configuration: configuration)
            guard let page = PDFDocument(data: data)?.page(at: 0) else { throw LockinError("WebKit could not create a PDF page.") }
            document.insert(page, at: document.pageCount)
        }
        guard let data = document.dataRepresentation() else { throw LockinError("Could not assemble the PDF.") }
        await restore(webView)
        return data
    } catch {
        await restore(webView)
        throw error
    }
}

@MainActor
private func restore(_ webView: WKWebView) async {
    _ = try? await webView.evaluateJavaScript("""
    (() => { const pages = document.getElementById('pdf-pages');
    if (pages) { while (pages.firstChild) document.body.insertBefore(pages.firstChild, pages); pages.remove(); }
    document.getElementById('pdf-layout')?.remove(); return true; })()
    """)
}
