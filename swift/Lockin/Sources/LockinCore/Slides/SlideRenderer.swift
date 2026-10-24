import CoreGraphics
import Foundation
import GRDB
import ImageIO
import os
import PDFKit
import UniformTypeIdentifiers

/// A lecture's slides as pictures (lib/slides.ts) and the slide picture route
/// (app/api/lectures/[id]/slides/[n]/route.ts). Slides are numbered across the lecture —
/// a second deck carries on where the first ends — and that number is what summaries cite
/// ("![The ghrelin pathway](slide:12)") and what models are told.
///
/// Pages are drawn the first time something asks for them and kept beside the lecture's
/// files, at the same paths the Electron app uses, so either app can draw a page and both
/// show it.

// MARK: - Drawing pages

/// Draws PDF pages with PDFKit (replaces unpdf + @napi-rs/canvas). A page is drawn the way
/// pdf.js draws it for `renderPageAsImage(…, { width: 1280 })`: scaled to 1280 px wide, the
/// height cut to whole pixels, on white, page rotation and crop box applied, as an RGBA PNG.
public final class SlideRenderer: SlideRendering, @unchecked Sendable {
    /// Width of a rendered slide: sharp on a laptop screen, ~30–80 KB a page (`WIDTH`).
    public static let pictureWidth: CGFloat = 1280

    /// Opening a PDF parses the whole file; the last few stay open for the next page.
    static let openDocumentLimit = 4

    /// Where lectures' files are kept: decks' pictures go in `<lecture>/slides/<material>/<page>.png`.
    public let materialsDirectory: URL

    private let lock = NSLock()
    private var openDocuments: [String: OpenSlideDocument] = [:]
    /// Opened first, closed first (a JS Map's order: reading one does not move it).
    private var openOrder: [String] = []

    public init(materialsDirectory: URL = LockinPaths.materialsDirectory) {
        self.materialsDirectory = materialsDirectory
    }

    /// Pages in a PDF on disk; nil when it can't be opened (`countPdfPages`).
    public func pageCount(file: String) -> Int? {
        guard let opened = try? openDocument(file) else { return nil }
        return opened.use { $0.pageCount }
    }

    /// One page (1-based) drawn as a PNG (`renderPage`).
    public func renderPage(file: String, page: Int) throws -> Data {
        let opened = try openDocument(file)
        let image = try opened.use { document -> CGImage in
            let count = document.pageCount
            guard page >= 1, page <= count, let pdfPage = document.page(at: page - 1) else {
                throw LockinError("Invalid page number. Must be between 1 and \(count).")
            }
            return try autoreleasepool {
                try drawSlidePage(pdfPage, width: Double(SlideRenderer.pictureWidth), page: page)
            }
        }
        return try encodeSlidePNG(image)
    }

    /// A page's picture: from the cache, or drawn and kept there (`pagePng`).
    public func pagePNG(lectureId: String, deck: SlideDeck, page: Int) throws -> Data {
        let cached = slidePNGPath(materialsDirectory: materialsDirectory, lectureId: lectureId, materialId: deck.materialId, page: page)
        if let hit = try? Data(contentsOf: cached) {
            return hit
        }
        let png = try renderPage(file: deck.file, page: page)
        try FileManager.default.createDirectory(at: cached.deletingLastPathComponent(), withIntermediateDirectories: true)
        try png.write(to: cached, options: .atomic)
        return png
    }

    /// A page's picture as a file, drawn first if it never was — for engines that take
    /// image files (`pagePngFile`). Returns its absolute path.
    public func pagePNGFile(lectureId: String, deck: SlideDeck, page: Int) throws -> String {
        let file = slidePNGPath(materialsDirectory: materialsDirectory, lectureId: lectureId, materialId: deck.materialId, page: page)
        var isDirectory: ObjCBool = false
        let readable = FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory)
            && !isDirectory.boolValue
            && FileManager.default.isReadableFile(atPath: file.path)
        if !readable {
            let png = try renderPage(file: deck.file, page: page)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try png.write(to: file, options: .atomic)
        }
        return file.path
    }

    /// Part of a slide's picture, for a summary that shows only the bit that matters (`cropPng`).
    public func cropPNG(_ png: Data, crop: Crop) throws -> Data {
        try cropSlidePicture(png, crop: crop)
    }

    /// The PDFs open right now, oldest first (for tests).
    var openFiles: [String] {
        lock.lock()
        defer { lock.unlock() }
        return openOrder
    }

    private func openDocument(_ file: String) throws -> OpenSlideDocument {
        lock.lock()
        defer { lock.unlock() }
        if let hit = openDocuments[file] {
            return hit
        }
        // A file that fails to open is not kept, so the next ask tries again.
        let opened = try OpenSlideDocument.open(file)
        openDocuments[file] = opened
        openOrder.append(file)
        while openOrder.count > SlideRenderer.openDocumentLimit {
            let oldest = openOrder.removeFirst()
            openDocuments[oldest] = nil
        }
        return opened
    }
}

/// One open PDF. PDFKit is not thread-safe, so every use of the document holds its lock.
private final class OpenSlideDocument: @unchecked Sendable {
    private let document: PDFDocument
    private let lock = NSLock()

    private init(document: PDFDocument) {
        self.document = document
    }

    static func open(_ file: String) throws -> OpenSlideDocument {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file, isDirectory: &isDirectory), !isDirectory.boolValue else {
            throw LockinError("ENOENT: no such file or directory, open '\(file)'")
        }
        guard let document = PDFDocument(url: URL(fileURLWithPath: file)) else {
            throw LockinError("Invalid PDF structure.")
        }
        if document.isLocked && !document.unlock(withPassword: "") {
            throw LockinError("No password given")
        }
        return OpenSlideDocument(document: document)
    }

    func use<T>(_ body: (PDFDocument) throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body(document)
    }
}

/// Larger than this a picture can't be drawn (a page far taller than it is wide).
private let maxSlideCanvasSide = 32_767

/// Draws one page the way pdf.js does for a given width. The viewport is the page's crop
/// box (pdf.js: crop box ∩ media box), turned by its rotation; the scale makes it `width`
/// wide; the canvas is the viewport cut to whole pixels (toward zero), so a fraction of a
/// pixel can be lost at the right and bottom, never the top.
private func drawSlidePage(_ pdfPage: PDFPage, width: Double, page number: Int) throws -> CGImage {
    let box = pdfPage.bounds(for: .cropBox)
    var rotation = ((pdfPage.rotation % 360) + 360) % 360
    if rotation % 90 != 0 {
        rotation = 0
    }
    let quarterTurn = rotation == 90 || rotation == 270
    let boxWidth = Double(quarterTurn ? box.height : box.width)
    let boxHeight = Double(quarterTurn ? box.width : box.height)
    guard boxWidth > 0, boxHeight > 0, boxWidth.isFinite, boxHeight.isFinite else {
        throw LockinError("Invalid canvas size")
    }
    // The same arithmetic as unpdf + PageViewport: scale = width / (box width), then
    // viewport size = box size * scale.
    let scale = width / boxWidth
    let viewWidth = boxWidth * scale
    let viewHeight = boxHeight * scale
    let cutWidth = viewWidth.rounded(.towardZero)
    let cutHeight = viewHeight.rounded(.towardZero)
    guard cutWidth >= 1, cutHeight >= 1,
          cutWidth <= Double(maxSlideCanvasSide), cutHeight <= Double(maxSlideCanvasSide) else {
        throw LockinError("Invalid canvas size")
    }
    let pixelWidth = Int(cutWidth)
    let pixelHeight = Int(cutHeight)

    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
              data: nil,
              width: pixelWidth,
              height: pixelHeight,
              bitsPerComponent: 8,
              bytesPerRow: 0,
              space: space,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else {
        throw LockinError("slide \(number) could not be drawn")
    }
    // pdf.js paints the page white before drawing it.
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight))
    context.interpolationQuality = .high
    // Top-left of the page at the top-left of the picture: what the cut loses is at the bottom.
    context.translateBy(x: 0, y: CGFloat(Double(pixelHeight) - viewHeight))
    context.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    // PDFKit applies the page's rotation and draws relative to (and clipped to) the box.
    pdfPage.draw(with: .cropBox, to: context)
    guard let image = context.makeImage() else {
        throw LockinError("slide \(number) could not be drawn")
    }
    return image
}

private func encodeSlidePNG(_ image: CGImage) throws -> Data {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.png.identifier as CFString, 1, nil) else {
        throw LockinError("could not make a PNG")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw LockinError("could not make a PNG")
    }
    return data as Data
}

private func slidePictureColorSpace(_ image: CGImage) -> CGColorSpace? {
    if let own = image.colorSpace, own.model == .rgb, own.supportsOutput {
        return own
    }
    return CGColorSpace(name: CGColorSpace.sRGB)
}

private func decodeSlidePNG(_ png: Data) throws -> CGImage {
    guard let source = CGImageSourceCreateWithData(png as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw LockinError("Unsupported image type")
    }
    return image
}

/// The pixels `cropPng` takes from a `width` × `height` picture: the crop's fractions
/// rounded with `Math.round`, cut at the picture's right and bottom edges, at least 1 px.
/// Nil when a fraction isn't a finite number.
func slideCropPixels(width: Int, height: Int, crop: Crop) -> (x: Int, y: Int, width: Int, height: Int)? {
    guard crop.x.isFinite, crop.y.isFinite, crop.w.isFinite, crop.h.isFinite else {
        return nil
    }
    func pixels(_ value: Double) -> Int {
        // Bounded so a wild fraction can't overflow; any real crop is far inside.
        let limit = 1_000_000_000_000.0
        return Int(min(max(jsMathRound(value), -limit), limit))
    }
    let sx = pixels(crop.x * Double(width))
    let sy = pixels(crop.y * Double(height))
    let sw = max(1, min(width - sx, pixels(crop.w * Double(width))))
    let sh = max(1, min(height - sy, pixels(crop.h * Double(height))))
    return (x: sx, y: sy, width: sw, height: sh)
}

/// `cropPng`: copies the cropped pixels one to one into a picture of their size. Anything
/// outside the source picture stays transparent, as on a canvas.
private func cropSlidePicture(_ png: Data, crop: Crop) throws -> Data {
    let image = try decodeSlidePNG(png)
    guard let rect = slideCropPixels(width: image.width, height: image.height, crop: crop),
          rect.width <= maxSlideCanvasSide, rect.height <= maxSlideCanvasSide else {
        throw LockinError("Invalid canvas size")
    }
    // Drawn in the picture's own colours, so no pixel changes on the way through.
    guard let space = slidePictureColorSpace(image),
          let context = CGContext(
              data: nil,
              width: rect.width,
              height: rect.height,
              bitsPerComponent: 8,
              bytesPerRow: 0,
              space: space,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          ) else {
        throw LockinError("could not crop the slide")
    }
    context.interpolationQuality = .none
    // Row `rect.y` (from the top) of the source lands on the top row of the crop.
    context.draw(
        image,
        in: CGRect(x: -rect.x, y: rect.height - image.height + rect.y, width: image.width, height: image.height)
    )
    guard let cropped = context.makeImage() else {
        throw LockinError("could not crop the slide")
    }
    return try encodeSlidePNG(cropped)
}

// MARK: - A lecture's decks

/// Only a PDF can be shown as pages and read as pages by a model (`/\.pdf$/i`).
private func hasPDFExtension(_ name: String) -> Bool {
    let tail = Array(name.utf16.suffix(4))
    guard tail.count == 4 else { return false }
    // JS's `i` flag folds only ASCII letters onto ASCII letters.
    let lowered: [UInt16] = tail.map { unit in
        unit >= 0x41 && unit <= 0x5A ? unit + 0x20 : unit
    }
    return lowered == Array(".pdf".utf16)
}

private func slideMaterials(db: Database, lectureId: String) throws -> [Material] {
    try Material
        .filter(Column("lectureId") == lectureId && Column("kind") == MaterialKind.slides.rawValue)
        .fetchAll(db)
}

private struct LectureDeckPlan {
    var decks: [SlideDeck]
    /// Decks imported before page counts were kept: counted now, to remember.
    var counted: [(materialId: String, pages: Int)]
}

private func planLectureDecks(_ materials: [Material], renderer: any SlideRendering, materialsDirectory: URL) -> LectureDeckPlan {
    var decks: [SlideDeck] = []
    var counted: [(materialId: String, pages: Int)] = []
    var next = 1
    for material in materials.sorted(by: slideOrder) {
        let file = materialsDirectory.appendingPathComponent(material.path, isDirectory: false).path
        let pdf = hasPDFExtension(material.originalName)
        let pages: Int
        if let known = material.pageCount {
            pages = known
        } else {
            // Imported before page counts were kept: count once and remember.
            pages = pdf ? (renderer.pageCount(file: file) ?? deckPages(material)) : deckPages(material)
            counted.append((materialId: material.id, pages: pages))
        }
        decks.append(SlideDeck(materialId: material.id, name: material.originalName, file: file, pdf: pdf, pages: pages, first: next))
        next += pages
    }
    return LectureDeckPlan(decks: decks, counted: counted)
}

/// `prisma.material.update({ where: { id }, data: { pageCount } })`.
private func rememberPageCount(db: Database, materialId: String, pages: Int) throws {
    try db.execute(sql: #"UPDATE "Material" SET "pageCount" = ? WHERE "id" = ?"#, arguments: [pages, materialId])
    if db.changesCount == 0 {
        throw LockinError(prismaRecordNotFound)
    }
}

/// A lecture's slide decks in slide order, each with the lecture-wide number of its first
/// slide (`lectureDecks`). A deck imported before page counts were kept is counted once
/// and the count written back, so call this inside a write; inside a read the decks are
/// still right, the count just isn't remembered.
public func lectureDecks(
    db: Database,
    lectureId: String,
    renderer: any SlideRendering,
    materialsDirectory: URL = LockinPaths.materialsDirectory
) throws -> [SlideDeck] {
    let materials = try slideMaterials(db: db, lectureId: lectureId)
    let plan = planLectureDecks(materials, renderer: renderer, materialsDirectory: materialsDirectory)
    do {
        for entry in plan.counted {
            try rememberPageCount(db: db, materialId: entry.materialId, pages: entry.pages)
        }
    } catch let error as DatabaseError where error.resultCode == .SQLITE_READONLY {
        // Asked from a read: counted again next time.
    }
    return plan.decks
}

/// `lectureDecks` on its own: reads, counts any uncounted deck outside the database, then
/// writes the counts. Never call it from inside a read or write.
public func lectureDecks(
    database: LockinDatabase,
    lectureId: String,
    renderer: any SlideRendering,
    materialsDirectory: URL = LockinPaths.materialsDirectory
) throws -> [SlideDeck] {
    let materials = try database.reader.read { db in
        try slideMaterials(db: db, lectureId: lectureId)
    }
    let plan = planLectureDecks(materials, renderer: renderer, materialsDirectory: materialsDirectory)
    let counted = plan.counted
    if !counted.isEmpty {
        try database.writer.write { db in
            for entry in counted {
                try rememberPageCount(db: db, materialId: entry.materialId, pages: entry.pages)
            }
        }
    }
    return plan.decks
}

/// Another lecture holding the same deck.
public struct SharedLectureRef: Equatable, Sendable {
    public var id: String
    public var title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

/// `sharedDecks` in the order its Map is built: checksums as first met, each with its
/// lectures by delivery date.
private func sharedDeckList(db: Database, lecture: Lecture) throws -> [(checksum: String, lectures: [SharedLectureRef])] {
    let checksums = try String.fetchAll(
        db,
        sql: #"SELECT "checksum" FROM "Material" WHERE "lectureId" = ? AND "kind" = ?"#,
        arguments: [lecture.id, MaterialKind.slides.rawValue]
    )
    if checksums.isEmpty {
        return []
    }
    let placeholders = Array(repeating: "?", count: checksums.count).joined(separator: ",")
    let rows = try Row.fetchAll(
        db,
        sql: """
        SELECT m."checksum" AS checksum, l."id" AS id, l."title" AS title, l."deliveredOn" AS deliveredOn
        FROM "Material" m
        JOIN "Lecture" l ON l."id" = m."lectureId"
        WHERE m."kind" = ? AND l."courseId" = ? AND l."id" <> ? AND m."checksum" IN (\(placeholders))
        ORDER BY m.rowid
        """,
        arguments: StatementArguments([MaterialKind.slides.rawValue, lecture.courseId, lecture.id] + checksums)
    )

    struct Copy {
        var checksum: String
        var lecture: SharedLectureRef
        var time: Double
        var index: Int
    }
    var copies: [Copy] = []
    for (index, row) in rows.enumerated() {
        let checksum: String = row["checksum"]
        let id: String = row["id"]
        let title: String = row["title"]
        let delivered: DatabaseValue = row["deliveredOn"]
        let time = PrismaDate.decode(delivered)?.timeIntervalSince1970 ?? 0
        copies.append(Copy(checksum: checksum, lecture: SharedLectureRef(id: id, title: title), time: time, index: index))
    }
    // Array.prototype.sort is stable: copies delivered together keep the order they came in.
    copies.sort { a, b in
        a.time != b.time ? a.time < b.time : a.index < b.index
    }

    var order: [String] = []
    var by: [String: [SharedLectureRef]] = [:]
    for copy in copies {
        var list = by[copy.checksum] ?? []
        if by[copy.checksum] == nil {
            order.append(copy.checksum)
        }
        if !list.contains(where: { $0.id == copy.lecture.id }) {
            list.append(copy.lecture)
        }
        by[copy.checksum] = list
    }
    return order.map { (checksum: $0, lectures: by[$0] ?? []) }
}

/// The other lectures in the course holding one of this lecture's decks — a deck that
/// covers two lectures is copied into each — keyed by the deck's checksum, each list in
/// delivery order (`sharedDecks`).
public func sharedDecks(db: Database, lecture: Lecture) throws -> [String: [SharedLectureRef]] {
    var by: [String: [SharedLectureRef]] = [:]
    for entry in try sharedDeckList(db: db, lecture: lecture) {
        by[entry.checksum] = entry.lectures
    }
    return by
}

/// Titles of the lectures sharing any of this lecture's decks, for the prompts (`sharingTitles`).
public func sharingTitles(db: Database, lecture: Lecture) throws -> [String] {
    var seen = Set<String>()
    var titles: [String] = []
    for entry in try sharedDeckList(db: db, lecture: lecture) {
        for shared in entry.lectures where !seen.contains(shared.title) {
            seen.insert(shared.title)
            titles.append(shared.title)
        }
    }
    return titles
}

/// Which deck and page (1-based) a lecture-wide slide number is (`locate`).
public func locateSlide(_ decks: [SlideDeck], slide: Int) -> (deck: SlideDeck, page: Int)? {
    guard let deck = decks.first(where: { slide >= $0.first && slide < $0.first + $0.pages }) else {
        return nil
    }
    return (deck: deck, page: slide - deck.first + 1)
}

/// The slide numbers that can be shown as pictures, as first...last ranges (`pictured`).
public func picturedRanges(_ decks: [SlideDeck]) -> [ClosedRange<Int>] {
    decks.filter { $0.pdf && $0.pages > 0 }.map { $0.first...($0.first + $0.pages - 1) }
}

// MARK: - One slide's picture

/// Where decks' files are when the caller doesn't say: the renderer's own folder.
private func slidesMaterialsDirectory(_ given: URL?, renderer: any SlideRendering) -> URL {
    if let given {
        return given
    }
    if let own = renderer as? SlideRenderer {
        return own.materialsDirectory
    }
    return LockinPaths.materialsDirectory
}

/// One slide as a PNG, drawn on first request and cached (`slidePng`). Nil when it can't be
/// shown: no such slide, or its deck isn't a PDF. Never call it from inside a read or write.
/// `materialsDirectory` defaults to the renderer's when it is a `SlideRenderer`.
public func slidePNG(
    database: LockinDatabase,
    lectureId: String,
    slide: Int,
    renderer: any SlideRendering,
    materialsDirectory: URL? = nil
) throws -> Data? {
    let decks = try lectureDecks(
        database: database,
        lectureId: lectureId,
        renderer: renderer,
        materialsDirectory: slidesMaterialsDirectory(materialsDirectory, renderer: renderer)
    )
    guard let at = locateSlide(decks, slide: slide), at.deck.pdf else {
        return nil
    }
    return try renderer.pagePNG(lectureId: lectureId, deck: at.deck, page: at.page)
}

/// A slide's picture as the slide route serves it, for the reader: the whole slide, or the
/// part a summary cropped it to (`crop`, fractions of the slide, cleaned as `parseCrop`
/// cleans them — a crop too small to keep shows the whole slide). Nil when there is no
/// picture of that slide.
public func slideImage(
    database: LockinDatabase,
    lectureId: String,
    slide: Int,
    crop: Crop?,
    renderer: any SlideRendering,
    materialsDirectory: URL? = nil
) throws -> Data? {
    guard slide >= 1 else {
        return nil
    }
    guard let png = try slidePNG(
        database: database,
        lectureId: lectureId,
        slide: slide,
        renderer: renderer,
        materialsDirectory: materialsDirectory
    ) else {
        return nil
    }
    if let crop = cleanCrop(crop) {
        return try renderer.cropPNG(png, crop: crop)
    }
    return png
}

/// What `GET /api/lectures/<id>/slides/<n>?crop=x,y,w,h` answers, for a reader that serves
/// slide pictures itself (a WKURLSchemeHandler). Same statuses, texts and headers.
public struct SlideImageResponse: Equatable, Sendable {
    public var status: Int
    public var body: Data
    public var headers: [String: String]

    public init(status: Int, body: Data, headers: [String: String]) {
        self.status = status
        self.body = body
        self.headers = headers
    }

    /// A slide never changes under the same lecture and number unless decks are added, so
    /// a day's caching is safe and makes a long summary scroll smoothly.
    public static func picture(_ png: Data) -> SlideImageResponse {
        SlideImageResponse(
            status: 200,
            body: png,
            headers: ["content-type": "image/png", "cache-control": "private, max-age=86400"]
        )
    }

    /// `new Response(text, { status })`.
    public static func text(_ message: String, status: Int) -> SlideImageResponse {
        SlideImageResponse(status: status, body: Data(message.utf8), headers: ["content-type": "text/plain;charset=UTF-8"])
    }

    /// The body as text, for an answer that isn't a picture.
    public var bodyText: String? {
        headers["content-type"] == "image/png" ? nil : String(data: body, encoding: .utf8)
    }
}

private let slidesLog = os.Logger(subsystem: "app.lockin", category: "slides")

/// The slide picture route: `slide` is the `[n]` path segment, `crop` the `?crop=` value.
public func slideImageResponse(
    database: LockinDatabase,
    lectureId: String,
    slide n: String,
    crop: String?,
    renderer: any SlideRendering,
    materialsDirectory: URL? = nil
) -> SlideImageResponse {
    let number = jsNumberValue(.string(n))
    guard number.isFinite, number == number.rounded(.towardZero), number >= 1 else {
        return .text("No such slide.", status: 404)
    }
    // Beyond any deck: still looked up (and so still "No picture"), without overflowing Int.
    let slide = number < 9.0e15 ? Int(number) : Int.max
    var drawn: Data?
    do {
        drawn = try slidePNG(database: database, lectureId: lectureId, slide: slide, renderer: renderer, materialsDirectory: materialsDirectory)
        // ?crop=x,y,w,h — the part the student cropped it to, as fractions of the slide.
        if let whole = drawn, let cleaned = parseCrop(crop) {
            drawn = try renderer.cropPNG(whole, crop: cleaned)
        }
    } catch {
        slidesLog.error("slide \(jsNumberString(number), privacy: .public) of lecture \(lectureId, privacy: .public) could not be drawn: \(messageOf(error), privacy: .public)")
        return .text("That slide could not be drawn.", status: 500)
    }
    guard let png = drawn else {
        return .text("No picture of that slide.", status: 404)
    }
    return .picture(png)
}
