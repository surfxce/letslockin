import Foundation
import GRDB

public enum StudyPaper: String, CaseIterable, Sendable {
    case a4 = "A4", letter = "Letter"
    public var width: Double { self == .a4 ? 595.28 : 612 }
    public var height: Double { self == .a4 ? 841.89 : 792 }
}

public struct StudyExportOptions: Sendable {
    public var paper: StudyPaper
    public var glossary: Bool
    public var contents: Bool
    public var newPagePerLecture: Bool
    public init(paper: StudyPaper = .a4, glossary: Bool = true, contents: Bool = true, newPagePerLecture: Bool = true) {
        self.paper = paper; self.glossary = glossary; self.contents = contents; self.newPagePerLecture = newPagePerLecture
    }
}

public struct StudyExportDocument: Sendable {
    public var title: String
    public var html: String
    public var count: Int
    public var omitted: Int
}

public func studyExportDocument(database: LockinDatabase, lectureIds: [String], options: StudyExportOptions, renderer: any SlideRendering) throws -> StudyExportDocument {
    let ids = Set(lectureIds)
    let lectures = try database.reader.read { db in
        try Lecture.filter(ids.contains(Column("id"))).order(Column("deliveredOn"), Column("createdAt"), Column("id")).fetchAll(db)
    }
    let ready = lectures.filter { !($0.summaryMd ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    guard !ready.isEmpty else { throw LockinError("Choose at least one lecture with a summary.") }
    let title = ready.count == 1 ? ready[0].title : "Lockin — \(ready.count) lecture summaries"
    var sections: [String] = []
    for (index, lecture) in ready.enumerated() {
        let decks = try lectureDecks(database: database, lectureId: lecture.id, renderer: renderer)
        let info = try database.reader.read { db in
            (try Course.fetchOne(db, key: lecture.courseId),
             try GlossaryTerm.filter(Column("lectureId") == lecture.id).order(Column("term")).fetchAll(db))
        }
        let slides = SlideImages(base: "lockin-slide://lectures/\(lecture.id)/slides", ranges: decks.filter(\.isPictured).map { ($0.first, $0.last) }, print: true)
        let summary = renderMarkdown(lecture.summaryMd ?? "", slides: slides).replacingOccurrences(of: "<h1>", with: "<h2>").replacingOccurrences(of: "</h1>", with: "</h2>")
        let glossary = options.glossary && !info.1.isEmpty ? "<section class='glossary'><h2>Glossary</h2><dl>" + info.1.map { "<dt>\(exportEscape($0.term))</dt><dd>\(exportEscape($0.explanation))</dd>" }.joined() + "</dl></section>" : ""
        sections.append("<section class='lecture' id='lecture-\(index)'><p class='meta'>\(exportEscape(info.0?.code ?? "")) · \(exportEscape(longDate(lecture.deliveredOn)))</p><h1>\(exportEscape(lecture.title))</h1>\(summary)\(glossary)</section>")
    }
    let contents = options.contents && ready.count > 1 ? "<section class='cover'><h1>\(exportEscape(title))</h1><h2>Contents</h2><ol>" + ready.enumerated().map { "<li><a href='#lecture-\($0.offset)'>\(exportEscape($0.element.title))</a></li>" }.joined() + "</ol></section>" : ""
    let html = """
    <!doctype html><html><head><meta charset="utf-8"><title>\(exportEscape(title))</title>
    <style>
    @page { size: \(options.paper.rawValue); margin: 45pt; }
    :root { color-scheme: light; }
    body { font: 11pt/1.5 -apple-system, sans-serif; color: #202124; background: white; margin: 0; padding: 24px; overflow-wrap: anywhere; }
    h1 { font-size: 23pt; line-height: 1.2; } h2 { font-size: 15pt; } h3 { font-size: 12pt; }
    h1,h2,h3,h4 { break-after: avoid; } p,li { orphans: 3; widows: 3; }
    a { color: inherit; } .meta, figcaption { color: #555; font-size: 9pt; }
    .lecture + .lecture { \(options.newPagePerLecture ? "break-before: page;" : "margin-top: 30pt;") }
    .cover { break-after: page; } .cover li { margin: 10pt 0; }
    figure { margin: 14pt 0; break-inside: avoid; } figure img { max-width: 100%; max-height: 490pt; object-fit: contain; }
    figure.multi img { max-width: 48%; } figcaption { margin-top: 4pt; }
    pre { white-space: pre-wrap; background: #f4f4f4; padding: 8pt; } code { font: 10pt Menlo, monospace; }
    blockquote { border-left: 2pt solid #bbb; margin-left: 0; padding-left: 10pt; }
    dt { font-weight: bold; } dd { margin: 0 0 8pt; } table { border-collapse: collapse; width: 100%; } td,th { border: 1px solid #ddd; padding: 4pt; }
    @media print { body { padding: 0; } }
    </style></head><body>\(contents)\(sections.joined())</body></html>
    """
    return StudyExportDocument(title: title, html: html, count: ready.count, omitted: lectures.count - ready.count)
}

private func exportEscape(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
}
