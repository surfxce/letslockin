import CoreGraphics
import Foundation
import GRDB
import ImageIO
import Vision

/// Reading the words on slides that are pictures — scanned decks, slides exported as
/// images — with text recognition that runs on this computer, and keeping them in the
/// deck's stored text (lib/ocr.ts). For models that can't look at images (the offline
/// ones); Claude reads the pages itself. Each page is read once: one with no words is
/// marked so.
///
/// The Electron app reads them with tesseract.js; this app uses Apple's Vision framework.
/// Either app's reading is kept in the same place, `Material.extractedText`, in the same
/// form (`mergePages`), so neither reads a page the other already has.

// MARK: - Vision

/// Reads a slide picture with Vision's text recognition: the accurate recogniser with
/// language correction, in English — what tesseract's `eng` LSTM model did.
public struct SlideOCR: SlideTextReading {
    public init() {}

    /// The recognised lines of one PNG, top to bottom as Vision reads them, joined with
    /// "\n" (before `cleanOcr`). Cancelling the calling task stops the recognition and
    /// throws `CancellationError`.
    public func recognizeText(png: Data) async throws -> String {
        try Task.checkCancellation()
        guard let source = CGImageSourceCreateWithData(png as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            // tesseract.js's words for a picture it can't open.
            throw LockinError("Error attempting to read image.")
        }
        let recognition = SlideTextRecognition(image: image)
        return try await withTaskCancellationHandler {
            try await recognition.run()
        } onCancel: {
            recognition.cancel()
        }
    }
}

/// One picture being read. Vision works synchronously, so the work runs on a global queue
/// and the caller waits without holding a thread of the cooperative pool.
private final class SlideTextRecognition: @unchecked Sendable {
    private let image: CGImage
    private let request: VNRecognizeTextRequest
    private let lock = NSLock()
    private var cancelled = false

    init(image: CGImage) {
        self.image = image
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = ["en-US"]
        // Vision skips text shorter than 1/32 of the picture unless told otherwise; a
        // slide's footnotes are smaller than that, and tesseract read them.
        request.minimumTextHeight = 1.0 / 96.0
        self.request = request
    }

    private var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
        request.cancel()
    }

    func run() async throws -> String {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(with: self.perform())
            }
        }
    }

    private func perform() -> Result<String, Error> {
        if isCancelled {
            return .failure(CancellationError())
        }
        do {
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            try handler.perform([request])
            if isCancelled {
                return .failure(CancellationError())
            }
            let observations: [VNRecognizedTextObservation] = request.results ?? []
            var lines: [String] = []
            for observation in observations {
                if let best = observation.topCandidates(1).first {
                    lines.append(best.string)
                }
            }
            return .success(lines.joined(separator: "\n"))
        } catch {
            return .failure(isCancelled ? CancellationError() : error)
        }
    }
}

// MARK: - Reading a lecture's slide pictures

/// Where the renderer keeps decks' files: its own folder when it is a `SlideRenderer`.
private func slideReadingMaterialsDirectory(_ renderer: any SlideRendering) -> URL {
    if let own = renderer as? SlideRenderer {
        return own.materialsDirectory
    }
    return LockinPaths.materialsDirectory
}

/// `prisma.material.findUnique({ where: { id }, select: { extractedText: true } })`:
/// a deck's stored text, "" when it has none or is gone.
private func storedDeckText(database: LockinDatabase, materialId: String) throws -> String {
    try database.reader.read { db -> String in
        try Material.fetchOne(db, key: materialId)?.extractedText ?? ""
    }
}

/// `prisma.material.update({ where: { id }, data: { extractedText } })`.
private func storeDeckText(database: LockinDatabase, materialId: String, text: String) throws {
    try database.writer.write { db -> Void in
        try db.execute(
            sql: #"UPDATE "Material" SET "extractedText" = ? WHERE "id" = ?"#,
            arguments: [text, materialId]
        )
        if db.changesCount == 0 {
            throw LockinError(prismaRecordNotFound)
        }
    }
}

/// Reads the words on a lecture's picture-only slide pages, the ones no reading has
/// covered yet (`blankPages`), and keeps them in each deck's stored text
/// (`readSlidePictures` in lib/ocr.ts). Only PDF decks with pages are read.
///
/// `onStart` is called once, before the first page is read, and never when there is
/// nothing to read. `onProgress` says which slide is being read. Returns how many pages
/// were read and how many had words.
///
/// Cancelling stops between pages and throws `CancellationError`; the pages of the deck
/// read by then are kept first, so they are not read again.
public func readSlidePictures(
    database: LockinDatabase,
    lectureId: String,
    services: LockinServices,
    onStart: @Sendable () throws -> Void,
    onProgress: @Sendable (String) -> Void
) async throws -> SlidePicturesRead {
    let renderer = services.renderer
    let reader = services.textReader
    let decks = try lectureDecks(
        database: database,
        lectureId: lectureId,
        renderer: renderer,
        materialsDirectory: slideReadingMaterialsDirectory(renderer)
    ).filter { $0.pdf && $0.pages > 0 }

    var started = false
    var pages = 0
    var withWords = 0
    for deck in decks {
        let text = try storedDeckText(database: database, materialId: deck.materialId)
        let blank = blankPages(text, pages: deck.pages)
        if blank.isEmpty {
            continue
        }
        if !started {
            try onStart()
            started = true
        }
        var read: [ReadPage] = []
        do {
            for (index, page) in blank.enumerated() {
                try Task.checkCancellation()
                onProgress("reading words in slide pictures — slide \(deck.first + page - 1) (\(index + 1) of \(blank.count))")
                let png = try renderer.pagePNG(lectureId: lectureId, deck: deck, page: page)
                let raw = try await reader.recognizeText(png: png)
                read.append(ReadPage(page: page, text: cleanOcr(raw)))
            }
        } catch {
            if !read.isEmpty && (error is CancellationError || Task.isCancelled) {
                // What was read before the cancel is kept, as it would have been had the
                // deck finished.
                try? storeDeckText(database: database, materialId: deck.materialId, text: mergePages(text, read: read))
            }
            throw error
        }
        try storeDeckText(database: database, materialId: deck.materialId, text: mergePages(text, read: read))
        pages += read.count
        withWords += read.filter { !$0.text.isEmpty }.count
    }
    return SlidePicturesRead(pages: pages, withWords: withWords)
}
