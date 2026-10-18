import Foundation

/// A lecture's slides. Slides are numbered across the lecture — a second deck carries on
/// where the first ends — and that number is what summaries cite
/// ("![The ghrelin pathway](slide:12)") and what models are told.

/// One slide deck of a lecture (`Deck` in lib/slides.ts, a deck of `SlidesInfo` in
/// lib/llm/provider.ts — the same fields).
public struct SlideDeck: Equatable, Sendable, Identifiable {
    /// The deck's material, for its kept slide pictures.
    public var materialId: String
    public var name: String
    /// Absolute path of the stored file.
    public var file: String
    /// Only a PDF can be shown as pages and read as pages by a model.
    public var pdf: Bool
    public var pages: Int
    /// Lecture-wide number of its first slide.
    public var first: Int

    public init(materialId: String, name: String, file: String, pdf: Bool, pages: Int, first: Int) {
        self.materialId = materialId
        self.name = name
        self.file = file
        self.pdf = pdf
        self.pages = pages
        self.first = first
    }

    public var id: String { materialId }

    /// Lecture-wide number of its last slide.
    public var last: Int { first + pages - 1 }

    public var fileURL: URL { URL(fileURLWithPath: file) }

    /// Can be shown as pictures and read as pages.
    public var isPictured: Bool { pdf && pages > 0 }
}

/// A lecture's slide decks, for a model that can look at them and for the picture markers.
public struct SlidesInfo: Equatable, Sendable {
    /// The lecture they belong to: slide pictures are kept with it.
    public var lectureId: String
    public var decks: [SlideDeck]
    /// Other lectures using the same deck — this lecture covers only its own part.
    public var sharedWith: [String]

    public init(lectureId: String, decks: [SlideDeck], sharedWith: [String] = []) {
        self.lectureId = lectureId
        self.decks = decks
        self.sharedWith = sharedWith
    }

    /// Any deck that can be shown as pictures.
    public var hasPicturedDeck: Bool {
        decks.contains { $0.isPictured }
    }

    /// Total slides across all decks.
    public var total: Int {
        decks.map(\.pages).reduce(0, +)
    }
}

/// What a model saw on one slide (`SlideNote` in lib/sources.ts). Stored as JSON in
/// `Lecture.slideNotes`, keys `slide` then `notes`.
public struct SlideNote: Codable, Equatable, Sendable {
    public var slide: Int
    public var notes: String

    public init(slide: Int, notes: String) {
        self.slide = slide
        self.notes = notes
    }

    public var json: JSONValue {
        ["slide": .int(slide), "notes": .string(notes)]
    }
}

/// One slide drawn as a picture file, for engines that take images (`slidePictures`).
public struct SlidePicture: Equatable, Sendable {
    /// Lecture-wide slide number.
    public var slide: Int
    /// Absolute path of the PNG.
    public var file: String

    public init(slide: Int, file: String) {
        self.slide = slide
        self.file = file
    }
}

/// What text recognition did for a lecture (`readSlidePictures` in lib/ocr.ts):
/// pages read, and how many had words. Stored in a PREPARE job's result as `slidePictures`.
public struct SlidePicturesRead: Equatable, Sendable {
    public var pages: Int
    public var withWords: Int

    public init(pages: Int, withWords: Int) {
        self.pages = pages
        self.withWords = withWords
    }

    public var json: JSONValue {
        ["pages": .int(pages), "withWords": .int(withWords)]
    }
}

/// The slide pictures an engine looks at: no more than this many, in order.
public let maxSlidePictures = 80

// MARK: - What the slide modules provide

/// Drawing PDF pages (Slides/SlideRenderer.swift, PDFKit; replaces unpdf + canvas).
/// Pages are 1-based. Pictures are 1280 px wide and kept beside the lecture's files at
/// `slidePNGPath(…)`, the same place the Electron app keeps them.
public protocol SlideRendering: Sendable {
    /// Pages in a PDF on disk; nil when it can't be opened (`countPdfPages`).
    func pageCount(file: String) -> Int?
    /// One page drawn as a PNG (`renderPage`).
    func renderPage(file: String, page: Int) throws -> Data
    /// A page's picture: from the cache, or drawn and kept there (`pagePng`).
    func pagePNG(lectureId: String, deck: SlideDeck, page: Int) throws -> Data
    /// The same picture as a file, drawn first if it never was (`pagePngFile`). Returns its absolute path.
    func pagePNGFile(lectureId: String, deck: SlideDeck, page: Int) throws -> String
    /// Part of a slide's picture (`cropPng`); the crop is in fractions of the picture.
    func cropPNG(_ png: Data, crop: Crop) throws -> Data
}

/// Reading the words in a slide picture (Slides/SlideOCR.swift, the Vision framework;
/// replaces tesseract.js).
public protocol SlideTextReading: Sendable {
    /// The recognised text of one PNG, lines joined with "\n", before `cleanOcr`.
    func recognizeText(png: Data) async throws -> String
}

// MARK: - Shared helpers

/// Each PDF slide as a picture file (drawn once and kept), for engines that take images
/// (`slidePictures` in lib/llm/base.ts). At most `maxSlidePictures`, in order.
public func slidePictures(_ slides: SlidesInfo, renderer: any SlideRendering) throws -> [SlidePicture] {
    var out: [SlidePicture] = []
    for deck in slides.decks where deck.pdf {
        var page = 1
        while page <= deck.pages && out.count < maxSlidePictures {
            try Task.checkCancellation()
            let file = try renderer.pagePNGFile(lectureId: slides.lectureId, deck: deck, page: page)
            out.append(SlidePicture(slide: deck.first + page - 1, file: file))
            page += 1
        }
    }
    return out
}

/// Where a page's picture is kept once drawn: `materials/<lectureId>/slides/<materialId>/<page>.png`,
/// shared with the Electron app (`pngPath` in lib/slides.ts).
public func slidePNGPath(materialsDirectory: URL, lectureId: String, materialId: String, page: Int) -> URL {
    materialsDirectory
        .appendingPathComponent(lectureId, isDirectory: true)
        .appendingPathComponent("slides", isDirectory: true)
        .appendingPathComponent(materialId, isDirectory: true)
        .appendingPathComponent("\(page).png", isDirectory: false)
}

private let deckMarkerRe = Regex.compile(#"^-{3} (?:Page|Slide) (\d+) -{3}$"#, options: [.anchorsMatchLines])

/// How many slides a deck has: as counted at import, else its highest marked slide
/// (`deckPages` in lib/sources.ts).
public func deckPages(pageCount: Int?, extractedText: String?) -> Int {
    if let pageCount {
        return pageCount
    }
    let text = extractedText ?? ""
    var highest = 0
    for match in Regex.allMatches(deckMarkerRe, in: text) {
        if let number = Regex.group(match, at: 1, in: text).flatMap({ Int($0) }), number > highest {
            highest = number
        }
    }
    return highest
}

public func deckPages(_ material: Material) -> Int {
    deckPages(pageCount: material.pageCount, extractedText: material.extractedText)
}

/// Decks in the order their slides are numbered: as uploaded, then by id
/// (`slideOrder` in lib/sources.ts), for `sorted(by:)`.
public func slideOrder(_ a: Material, _ b: Material) -> Bool {
    if a.createdAt != b.createdAt {
        return a.createdAt < b.createdAt
    }
    return a.id.localizedCompare(b.id) == .orderedAscending
}
