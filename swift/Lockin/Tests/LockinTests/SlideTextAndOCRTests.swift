import AppKit
import CoreGraphics
import Foundation
import GRDB
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import LockinCore

final class SlideTextAndOCRTests: XCTestCase {
    // MARK: - SlideText (lib/slidetext.test.ts)

    func testFindsThePagesThatArePicturesNobodyHasRead() {
        let deck = "--- Page 1 ---\nAppetite and Satiety\n\n--- Page 3 ---\nLeptin"
        XCTAssertEqual(blankPages(deck, pages: 4), [2, 4])
        XCTAssertEqual(blankPages("", pages: 2), [1, 2])
        XCTAssertEqual(blankPages(deck, pages: 0), [])
    }

    func testKeepsTheWordsAndDropsTheSymbolsShapesAreReadAs() {
        XCTAssertEqual(
            cleanOcr("Ghrelin rises before meals\nand acts on the arcuate @®\n—  ©\n"),
            "Ghrelin rises before meals\nand acts on the arcuate"
        )
    }

    func testPutsReadPagesBackInOrderMarkingOnesWithNoWordsSoTheyAreNotReadAgain() {
        let deck = "--- Page 1 ---\nAppetite and Satiety\n\n--- Page 3 ---\nLeptin"
        let merged = mergePages(deck, read: [
            ReadPage(page: 4, text: ""),
            ReadPage(page: 2, text: "Ghrelin rises before meals"),
        ])
        XCTAssertEqual(
            merged,
            "--- Page 1 ---\nAppetite and Satiety\n\n"
                + "--- Page 2 ---\n(words read from the slide's picture)\nGhrelin rises before meals\n\n"
                + "--- Page 3 ---\nLeptin\n\n"
                + "--- Page 4 ---\n\(noWordsText)"
        )
        XCTAssertEqual(blankPages(merged, pages: 4), [])
    }

    // MARK: - SlideOCR (Sources/LockinCore/Slides/SlideOCR.swift)

    func testSlideOCRRecognizesPrintedEnglishWordsAndRejectsInvalidPNG() async throws {
        let ocr = SlideOCR()
        let png = try makeSlidePNGWithText("Ghrelin rises before meals")
        let recognized = try await ocr.recognizeText(png: png)
        XCTAssertTrue(recognized.lowercased().contains("ghrelin"), "Expected 'ghrelin' in OCR output: \(recognized)")
        XCTAssertTrue(recognized.lowercased().contains("meals"), "Expected 'meals' in OCR output: \(recognized)")

        do {
            _ = try await ocr.recognizeText(png: Data("not a png".utf8))
            XCTFail("Expected invalid PNG to fail")
        } catch {
            XCTAssertEqual(error as? LockinError, LockinError("Error attempting to read image."))
        }
    }

    func testReadSlidePicturesReadsOnlyBlankPagesAndStoresResults() async throws {
        let database = try LockinDatabase.inMemory()
        let lectureId = "lec-ocr-1"
        let materialId = "mat-ocr-1"
        try await database.writer.write { db in
            var course = Course(id: "c-ocr-1", code: "BIOL1001", title: "Biology")
            try course.insert(db)
            var lecture = Lecture(id: lectureId, courseId: course.id, title: "Appetite")
            try lecture.insert(db)
            var material = Material(
                id: materialId,
                lectureId: lectureId,
                kind: .slides,
                path: "deck.pdf",
                originalName: "deck.pdf",
                extractedText: "--- Page 1 ---\nTitle slide",
                pageCount: 3,
                checksum: "abc"
            )
            try material.insert(db)
        }

        let renderer = FakeSlideRenderer(pages: [
            1: Data("page1".utf8),
            2: Data("Ghrelin rises before meals".utf8),
            3: Data("".utf8),
        ])
        let reader = FakeTextReader { data in
            String(decoding: data, as: UTF8.self)
        }
        let services = LockinServices(
            renderer: renderer,
            textReader: reader,
            engine: UnusedEngine(),
            environment: [:]
        )

        let collector = ProgressCollector()
        let firstRead = try await readSlidePictures(
            database: database,
            lectureId: lectureId,
            services: services,
            onStart: { collector.startedCount += 1 },
            onProgress: { collector.messages.append($0) }
        )

        XCTAssertEqual(collector.startedCount, 1)
        XCTAssertEqual(firstRead, SlidePicturesRead(pages: 2, withWords: 1))
        XCTAssertEqual(collector.messages, [
            "reading words in slide pictures — slide 2 (1 of 2)",
            "reading words in slide pictures — slide 3 (2 of 2)",
        ])

        let stored = try await database.reader.read { db in
            try Material.fetchOne(db, key: materialId)?.extractedText
        }
        XCTAssertEqual(
            stored,
            "--- Page 1 ---\nTitle slide\n\n"
                + "--- Page 2 ---\n(words read from the slide's picture)\nGhrelin rises before meals\n\n"
                + "--- Page 3 ---\n\(noWordsText)"
        )

        // Reading again finds no blank pages left.
        let secondRead = try await readSlidePictures(
            database: database,
            lectureId: lectureId,
            services: services,
            onStart: { collector.startedCount += 1 },
            onProgress: { collector.messages.append($0) }
        )
        XCTAssertEqual(collector.startedCount, 1)
        XCTAssertEqual(secondRead, SlidePicturesRead(pages: 0, withWords: 0))
    }

    // MARK: - VisionPass (Sources/LockinCore/Slides/VisionPass.swift)

    func testLookAtSlidesMlxPassesEachSlidePictureToTheEngine() async throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("lockin-vision-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }

        let renderer = FakeSlideRenderer(pages: [
            1: Data("png1".utf8),
            2: Data("png2".utf8),
        ], cacheFolder: folder)
        let engine = FakeVisionEngine(replies: ["  A hunger hormone diagram. \n", "   "])
        let deck = SlideDeck(materialId: "m1", name: "Appetite.pdf", file: "/tmp/Appetite.pdf", pdf: true, pages: 2, first: 1)
        let slides = SlidesInfo(lectureId: "l1", decks: [deck])

        let collector = ProgressCollector()
        let notes = try await lookAtSlidesMlx(
            modelDirectory: "/models/mlx/gemma-4",
            slides: slides,
            renderer: renderer,
            engine: engine,
            onProgress: { collector.messages.append($0) }
        )

        XCTAssertEqual(notes, [SlideNote(slide: 1, notes: "A hunger hormone diagram.")])
        XCTAssertEqual(collector.messages, [
            "looking at slide 1 of 2",
            "looking at slide 2 of 2",
        ])
        XCTAssertEqual(engine.seenPrompts, [visionPrompt, visionPrompt])
        XCTAssertEqual(engine.seenImageCounts, [1, 1])
    }
}

private final class ProgressCollector: @unchecked Sendable {
    var startedCount = 0
    var messages: [String] = []
}

// MARK: - Test Doubles & Helpers

private func makeSlidePNGWithText(_ text: String) throws -> Data {
    let width = 800
    let height = 200
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw LockinError("Could not create bitmap context")
    }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))

    let nsContext = NSGraphicsContext(cgContext: context, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = nsContext
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.boldSystemFont(ofSize: 42),
        .foregroundColor: NSColor.black,
    ]
    (text as NSString).draw(at: NSPoint(x: 32, y: 72), withAttributes: attrs)
    NSGraphicsContext.restoreGraphicsState()

    guard let cgImage = context.makeImage() else {
        throw LockinError("Could not make CGImage")
    }
    let mutable = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(mutable, UTType.png.identifier as CFString, 1, nil) else {
        throw LockinError("Could not create PNG destination")
    }
    CGImageDestinationAddImage(dest, cgImage, nil)
    guard CGImageDestinationFinalize(dest) else {
        throw LockinError("Could not finalize PNG")
    }
    return mutable as Data
}

private final class FakeSlideRenderer: SlideRendering, @unchecked Sendable {
    let pages: [Int: Data]
    let cacheFolder: URL

    init(pages: [Int: Data], cacheFolder: URL = FileManager.default.temporaryDirectory) {
        self.pages = pages
        self.cacheFolder = cacheFolder
    }

    func pageCount(file: String) -> Int? {
        pages.count
    }

    func renderPage(file: String, page: Int) throws -> Data {
        pages[page] ?? Data()
    }

    func pagePNG(lectureId: String, deck: SlideDeck, page: Int) throws -> Data {
        pages[page] ?? Data()
    }

    func pagePNGFile(lectureId: String, deck: SlideDeck, page: Int) throws -> String {
        let url = cacheFolder.appendingPathComponent("\(deck.materialId)-\(page).png")
        try (pages[page] ?? Data()).write(to: url)
        return url.path
    }

    func cropPNG(_ png: Data, crop: Crop) throws -> Data {
        png
    }
}

private struct FakeTextReader: SlideTextReading {
    let handler: @Sendable (Data) async throws -> String

    func recognizeText(png: Data) async throws -> String {
        try await handler(png)
    }
}

private final class UnusedEngine: EngineGenerating, @unchecked Sendable {
    func generate(
        model: String,
        prompt: String,
        images: [String],
        schema: JSONValue?,
        maxTokens: Int,
        temperature: Double,
        onTokens: (@Sendable (Int) -> Void)?
    ) async throws -> String {
        ""
    }

    func stop() async {}
}

private final class FakeVisionEngine: EngineGenerating, @unchecked Sendable {
    var replies: [String]
    var seenPrompts: [String] = []
    var seenImageCounts: [Int] = []

    init(replies: [String]) {
        self.replies = replies
    }

    func generate(
        model: String,
        prompt: String,
        images: [String],
        schema: JSONValue?,
        maxTokens: Int,
        temperature: Double,
        onTokens: (@Sendable (Int) -> Void)?
    ) async throws -> String {
        seenPrompts.append(prompt)
        seenImageCounts.append(images.count)
        return replies.isEmpty ? "" : replies.removeFirst()
    }

    func stop() async {}
}
