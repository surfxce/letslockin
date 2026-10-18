import CoreGraphics
import Foundation
import GRDB
import ImageIO
import XCTest
@testable import LockinCore

final class SlideRendererTests: XCTestCase {
    // MARK: Drawing pages

    func testDrawsEachPageAtThePictureWidthLikePdfJs() throws {
        let folder = try makeSlideTestFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("deck.pdf")
        try slideTestPDF(pages: [CGSize(width: 720, height: 540), CGSize(width: 612, height: 792)]).write(to: file)
        let renderer = SlideRenderer(materialsDirectory: folder)

        XCTAssertEqual(renderer.pageCount(file: file.path), 2)

        let first = try renderer.renderPage(file: file.path, page: 1)
        XCTAssertEqual(Array(first.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        // unpdf: 1280 wide, 540 × 1280/720 = 960 high.
        XCTAssertEqual(try slideTestSize(first), [1280, 960])
        XCTAssertTrue(slideTestIsRed(try slideTestPixel(first, x: 20, y: 940)), "the red square sits at the bottom left")
        XCTAssertTrue(slideTestIsBlue(try slideTestPixel(first, x: 1260, y: 20)), "the blue square sits at the top right")
        XCTAssertTrue(slideTestIsWhite(try slideTestPixel(first, x: 640, y: 480)), "the page is drawn on white")

        // 792 × 1280/612 = 1656.47…, cut to 1656 as the canvas is.
        let second = try renderer.renderPage(file: file.path, page: 2)
        XCTAssertEqual(try slideTestSize(second), [1280, 1656])
        XCTAssertTrue(slideTestIsRed(try slideTestPixel(second, x: 20, y: 1636)))
        XCTAssertTrue(slideTestIsBlue(try slideTestPixel(second, x: 1260, y: 20)))
    }

    func testRefusesPagesItCannotDraw() throws {
        let folder = try makeSlideTestFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("deck.pdf")
        try slideTestPDF(pages: [CGSize(width: 720, height: 540), CGSize(width: 720, height: 540)]).write(to: file)
        let renderer = SlideRenderer(materialsDirectory: folder)

        XCTAssertThrowsError(try renderer.renderPage(file: file.path, page: 3)) { error in
            XCTAssertEqual(error as? LockinError, LockinError("Invalid page number. Must be between 1 and 2."))
        }
        XCTAssertThrowsError(try renderer.renderPage(file: file.path, page: 0)) { error in
            XCTAssertEqual(error as? LockinError, LockinError("Invalid page number. Must be between 1 and 2."))
        }

        let missing = folder.appendingPathComponent("gone.pdf").path
        XCTAssertNil(renderer.pageCount(file: missing))
        XCTAssertThrowsError(try renderer.renderPage(file: missing, page: 1)) { error in
            XCTAssertEqual(messageOf(error), "ENOENT: no such file or directory, open '\(missing)'")
        }

        let notPDF = folder.appendingPathComponent("notes.pdf")
        try Data("just some words".utf8).write(to: notPDF)
        XCTAssertNil(renderer.pageCount(file: notPDF.path))
        XCTAssertThrowsError(try renderer.renderPage(file: notPDF.path, page: 1))
        XCTAssertEqual(renderer.openFiles, [file.path], "a file that fails to open is not kept")
    }

    func testTurnsRotatedPagesUprightLikePdfJs() throws {
        let folder = try makeSlideTestFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let renderer = SlideRenderer(materialsDirectory: folder)

        // What unpdf + @napi-rs/canvas draw for a 720 × 540 page with a red square at the
        // bottom left of its own space and a blue one at the top right.
        let upright = folder.appendingPathComponent("upright.pdf")
        try handwrittenSlidePDF(width: 720, height: 540, rotate: 0).write(to: upright)
        let flat = try renderer.renderPage(file: upright.path, page: 1)
        XCTAssertEqual(try slideTestSize(flat), [1280, 960])
        XCTAssertTrue(slideTestIsRed(try slideTestPixel(flat, x: 20, y: 940)))
        XCTAssertTrue(slideTestIsBlue(try slideTestPixel(flat, x: 1260, y: 20)))
        XCTAssertTrue(slideTestIsWhite(try slideTestPixel(flat, x: 20, y: 20)))

        let quarter = folder.appendingPathComponent("quarter.pdf")
        try handwrittenSlidePDF(width: 720, height: 540, rotate: 90).write(to: quarter)
        let turned = try renderer.renderPage(file: quarter.path, page: 1)
        // 720 × 1280/540 = 1706.67, cut to 1706.
        XCTAssertEqual(try slideTestSize(turned), [1280, 1706])
        XCTAssertTrue(slideTestIsRed(try slideTestPixel(turned, x: 20, y: 20)))
        XCTAssertTrue(slideTestIsBlue(try slideTestPixel(turned, x: 1260, y: 1686)))
        XCTAssertTrue(slideTestIsWhite(try slideTestPixel(turned, x: 20, y: 1686)))
        XCTAssertTrue(slideTestIsWhite(try slideTestPixel(turned, x: 1260, y: 20)))

        let threeQuarter = folder.appendingPathComponent("three-quarter.pdf")
        try handwrittenSlidePDF(width: 720, height: 540, rotate: 270).write(to: threeQuarter)
        let back = try renderer.renderPage(file: threeQuarter.path, page: 1)
        XCTAssertEqual(try slideTestSize(back), [1280, 1706])
        XCTAssertTrue(slideTestIsBlue(try slideTestPixel(back, x: 20, y: 20)))
        XCTAssertTrue(slideTestIsRed(try slideTestPixel(back, x: 1260, y: 1686)))
    }

    // MARK: Cropping

    func testCropMathsMatchesCropPng() {
        // Expected values from lib/slides.ts cropPng's arithmetic, run in node.
        func pixels(_ width: Int, _ height: Int, _ x: Double, _ y: Double, _ w: Double, _ h: Double) -> [Int]? {
            slideCropPixels(width: width, height: height, crop: Crop(x: x, y: y, w: w, h: h)).map { [$0.x, $0.y, $0.width, $0.height] }
        }
        XCTAssertEqual(pixels(1280, 960, 0.333, 0.333, 0.9, 0.9), [426, 320, 854, 640])
        XCTAssertEqual(pixels(1280, 960, 0.25, 0.5, 0.5, 0.5), [320, 480, 640, 480])
        XCTAssertEqual(pixels(1280, 1656, 0.1, 0.2, 0.3, 0.4), [128, 331, 384, 662])
        XCTAssertEqual(pixels(200, 100, 0.9999, 0, 0.0001, 0.004), [200, 0, 1, 1])
        XCTAssertEqual(pixels(1280, 960, 0.0005, 0.0005, 0.5, 0.5), [1, 0, 640, 480])
        XCTAssertEqual(pixels(101, 51, 0.5, 0.5, 0.5, 0.5), [51, 26, 50, 25])
        XCTAssertEqual(pixels(200, 100, -0.1, 0, 0.5, 1), [-20, 0, 100, 100])
        XCTAssertNil(pixels(200, 100, .nan, 0, 0.5, 0.5))
    }

    func testCropsAPictureToItsPixels() throws {
        let folder = try makeSlideTestFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("deck.pdf")
        try slideTestPDF(pages: [CGSize(width: 720, height: 540)]).write(to: file)
        let renderer = SlideRenderer(materialsDirectory: folder)
        let whole = try renderer.renderPage(file: file.path, page: 1)

        let bottomLeft = try renderer.cropPNG(whole, crop: Crop(x: 0, y: 0.5, w: 0.5, h: 0.5))
        XCTAssertEqual(try slideTestSize(bottomLeft), [640, 480])
        XCTAssertTrue(slideTestIsRed(try slideTestPixel(bottomLeft, x: 20, y: 460)))
        XCTAssertTrue(slideTestIsWhite(try slideTestPixel(bottomLeft, x: 20, y: 20)))

        let topRight = try renderer.cropPNG(whole, crop: Crop(x: 0.5, y: 0, w: 0.5, h: 0.5))
        XCTAssertEqual(try slideTestSize(topRight), [640, 480])
        XCTAssertTrue(slideTestIsBlue(try slideTestPixel(topRight, x: 620, y: 20)))
        XCTAssertTrue(slideTestIsWhite(try slideTestPixel(topRight, x: 20, y: 460)))

        // Hanging off the left edge: the canvas leaves what isn't there transparent.
        let offEdge = try renderer.cropPNG(whole, crop: Crop(x: -0.1, y: 0, w: 0.5, h: 1))
        XCTAssertEqual(try slideTestSize(offEdge), [640, 960])
        XCTAssertEqual(try slideTestPixel(offEdge, x: 10, y: 940)[3], 0)
        XCTAssertTrue(slideTestIsRed(try slideTestPixel(offEdge, x: 150, y: 940)))
    }

    // MARK: A lecture's decks

    func testNumbersSlidesAcrossDecksAndRemembersPageCounts() throws {
        let folder = try makeSlideTestFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let database = try LockinDatabase.inMemory()
        try seedSlideTestLecture(database, folder: folder)
        let renderer = SlideRenderer(materialsDirectory: folder)

        let decks = try lectureDecks(database: database, lectureId: "l1", renderer: renderer, materialsDirectory: folder)
        XCTAssertEqual(decks.map(\.materialId), ["mA", "mB", "mC"])
        XCTAssertEqual(decks.map(\.first), [1, 3, 6])
        XCTAssertEqual(decks.map(\.pages), [2, 3, 4])
        XCTAssertEqual(decks.map(\.pdf), [true, false, true], "only a .pdf (any case) is a PDF")
        XCTAssertEqual(decks.map(\.name), ["Week 1.pdf", "Notes.pptx", "Week 2.PDF"])
        XCTAssertEqual(decks[0].file, folder.appendingPathComponent("l1/deckA.pdf", isDirectory: false).path)

        // Counted once (the PDF's pages, the other's highest marker) and remembered.
        let counts = try database.reader.read { db in
            try Row.fetchAll(db, sql: #"SELECT "id", "pageCount" FROM "Material" WHERE "lectureId" = 'l1' ORDER BY "id""#)
                .map { row -> String in
                    let id: String = row["id"]
                    let pages: Int? = row["pageCount"]
                    return "\(id):\(pages.map { String($0) } ?? "nil")"
                }
        }
        XCTAssertEqual(counts, ["mA:2", "mB:3", "mC:4", "mT:nil"])

        XCTAssertEqual(locateSlide(decks, slide: 1)?.deck.materialId, "mA")
        XCTAssertEqual(locateSlide(decks, slide: 4)?.deck.materialId, "mB")
        XCTAssertEqual(locateSlide(decks, slide: 4)?.page, 2)
        XCTAssertEqual(locateSlide(decks, slide: 6)?.page, 1)
        XCTAssertEqual(locateSlide(decks, slide: 9)?.deck.materialId, "mC")
        XCTAssertEqual(locateSlide(decks, slide: 9)?.page, 4)
        XCTAssertNil(locateSlide(decks, slide: 10))
        XCTAssertNil(locateSlide(decks, slide: 0))
        XCTAssertEqual(picturedRanges(decks), [1...2, 6...9])

        // The remembered count is used from now on, even with the file gone.
        try FileManager.default.removeItem(at: folder.appendingPathComponent("l1/deckA.pdf"))
        let again = try lectureDecks(database: database, lectureId: "l1", renderer: SlideRenderer(materialsDirectory: folder), materialsDirectory: folder)
        XCTAssertEqual(again.map(\.pages), [2, 3, 4])
    }

    func testCountsInsideAReadWithoutRemembering() throws {
        let folder = try makeSlideTestFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let database = try LockinDatabase.inMemory()
        try seedSlideTestLecture(database, folder: folder)
        let renderer = SlideRenderer(materialsDirectory: folder)

        let read = try database.reader.read { db in
            try lectureDecks(db: db, lectureId: "l1", renderer: renderer, materialsDirectory: folder)
        }
        XCTAssertEqual(read.map(\.pages), [2, 3, 4])
        let unremembered = try database.reader.read { db in
            try Int.fetchOne(db, sql: #"SELECT "pageCount" FROM "Material" WHERE "id" = 'mA'"#)
        }
        XCTAssertNil(unremembered)

        let written = try database.writer.write { db in
            try lectureDecks(db: db, lectureId: "l1", renderer: renderer, materialsDirectory: folder)
        }
        XCTAssertEqual(written.map(\.first), [1, 3, 6])
        let remembered = try database.reader.read { db in
            try Int.fetchOne(db, sql: #"SELECT "pageCount" FROM "Material" WHERE "id" = 'mA'"#)
        }
        XCTAssertEqual(remembered, 2)
    }

    func testListsSharedDecksByDeliveryDate() throws {
        let database = try LockinDatabase.inMemory()
        let day = 86_400.0
        let base = Date(timeIntervalSince1970: 1_790_000_000)
        try database.writer.write { db in
            var course = Course(id: "c1", code: "PHYS2010", title: "Physiology", createdAt: base)
            try course.insert(db)
            var other = Course(id: "c2", code: "PHYS9999", title: "Elsewhere", createdAt: base)
            try other.insert(db)
            let lectures: [(String, String, String, Double)] = [
                ("l1", "c1", "Appetite", 5), ("l2", "c1", "Hunger", 2), ("l3", "c1", "Satiety", 1),
                ("l4", "c1", "Thirst", 3), ("l5", "c2", "Elsewhere", 0), ("l6", "c1", "No slides", 4),
            ]
            for (id, courseId, title, days) in lectures {
                var lecture = Lecture(id: id, courseId: courseId, title: title, deliveredOn: base.addingTimeInterval(days * day), createdAt: base)
                try lecture.insert(db)
            }
            let materials: [(String, String, MaterialKind, String)] = [
                ("m1", "l1", .slides, "k1"), ("m2", "l1", .slides, "k2"),
                ("m3", "l2", .slides, "k1"),
                ("m4", "l3", .slides, "k2"), ("m5", "l3", .slides, "k1"),
                ("m6", "l4", .transcript, "k1"),
                ("m7", "l5", .slides, "k1"),
                ("m8", "l6", .transcript, "k9"),
            ]
            for (id, lectureId, kind, checksum) in materials {
                var material = Material(id: id, lectureId: lectureId, kind: kind, path: "\(lectureId)/\(id)", originalName: "\(id).pdf", checksum: checksum, createdAt: base)
                try material.insert(db)
            }
        }

        let lecture = try XCTUnwrap(database.reader.read { db in try Lecture.fetchOne(db, key: "l1") })
        let shared = try database.reader.read { db in try sharedDecks(db: db, lecture: lecture) }
        XCTAssertEqual(shared["k1"], [SharedLectureRef(id: "l3", title: "Satiety"), SharedLectureRef(id: "l2", title: "Hunger")])
        XCTAssertEqual(shared["k2"], [SharedLectureRef(id: "l3", title: "Satiety")])
        XCTAssertEqual(shared.count, 2)
        // Map order: the deck met first (Satiety's k2, delivered earliest), then k1.
        XCTAssertEqual(try database.reader.read { db in try sharingTitles(db: db, lecture: lecture) }, ["Satiety", "Hunger"])

        let elsewhere = try XCTUnwrap(database.reader.read { db in try Lecture.fetchOne(db, key: "l5") })
        XCTAssertEqual(try database.reader.read { db in try sharingTitles(db: db, lecture: elsewhere) }, [])
        let noSlides = try XCTUnwrap(database.reader.read { db in try Lecture.fetchOne(db, key: "l6") })
        XCTAssertEqual(try database.reader.read { db in try sharedDecks(db: db, lecture: noSlides) }, [:])
    }

    // MARK: One slide's picture

    func testDrawsASlideOnceThenServesItFromTheCache() throws {
        let folder = try makeSlideTestFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let database = try LockinDatabase.inMemory()
        try seedSlideTestLecture(database, folder: folder)
        let renderer = SlideRenderer(materialsDirectory: folder)

        // Slide 2 is the second page of the first deck (612 × 792).
        let drawn = try XCTUnwrap(slidePNG(database: database, lectureId: "l1", slide: 2, renderer: renderer))
        XCTAssertEqual(try slideTestSize(drawn), [1280, 1656])
        let cached = slidePNGPath(materialsDirectory: folder, lectureId: "l1", materialId: "mA", page: 2)
        XCTAssertEqual(cached.path, folder.path + "/l1/slides/mA/2.png")
        XCTAssertEqual(try Data(contentsOf: cached), drawn)

        // A kept picture is served as it is, never drawn again.
        let sentinel = Data("kept picture".utf8)
        try sentinel.write(to: cached)
        XCTAssertEqual(try slidePNG(database: database, lectureId: "l1", slide: 2, renderer: renderer), sentinel)
        let deck = try XCTUnwrap(lectureDecks(database: database, lectureId: "l1", renderer: renderer, materialsDirectory: folder).first)
        XCTAssertEqual(try renderer.pagePNGFile(lectureId: "l1", deck: deck, page: 2), cached.path)
        XCTAssertEqual(try Data(contentsOf: cached), sentinel)

        // A page never drawn is drawn into its file.
        let firstFile = try renderer.pagePNGFile(lectureId: "l1", deck: deck, page: 1)
        XCTAssertEqual(firstFile, slidePNGPath(materialsDirectory: folder, lectureId: "l1", materialId: "mA", page: 1).path)
        XCTAssertEqual(try slideTestSize(try Data(contentsOf: URL(fileURLWithPath: firstFile))), [1280, 960])

        // Slides of a deck that isn't a PDF, and slides past the end, have no picture.
        XCTAssertNil(try slidePNG(database: database, lectureId: "l1", slide: 3, renderer: renderer))
        XCTAssertNil(try slidePNG(database: database, lectureId: "l1", slide: 99, renderer: renderer))
        XCTAssertNil(try slidePNG(database: database, lectureId: "nope", slide: 1, renderer: renderer))
    }

    func testSlideImageCropsLikeTheRoute() throws {
        let folder = try makeSlideTestFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let database = try LockinDatabase.inMemory()
        try seedSlideTestLecture(database, folder: folder)
        let renderer = SlideRenderer(materialsDirectory: folder)

        let whole = try XCTUnwrap(slideImage(database: database, lectureId: "l1", slide: 1, crop: nil, renderer: renderer))
        XCTAssertEqual(try slideTestSize(whole), [1280, 960])
        let half = try XCTUnwrap(slideImage(database: database, lectureId: "l1", slide: 1, crop: Crop(x: 0, y: 0, w: 0.5, h: 0.5), renderer: renderer))
        XCTAssertEqual(try slideTestSize(half), [640, 480])
        // Too small to keep, as parseCrop says: the whole slide.
        let tiny = try XCTUnwrap(slideImage(database: database, lectureId: "l1", slide: 1, crop: Crop(x: 0, y: 0, w: 0.01, h: 0.5), renderer: renderer))
        XCTAssertEqual(try slideTestSize(tiny), [1280, 960])
        XCTAssertNil(try slideImage(database: database, lectureId: "l1", slide: 0, crop: nil, renderer: renderer))
    }

    func testSlideImageResponseAnswersLikeTheRoute() throws {
        let folder = try makeSlideTestFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let database = try LockinDatabase.inMemory()
        try seedSlideTestLecture(database, folder: folder)
        let renderer = SlideRenderer(materialsDirectory: folder)
        func answer(_ n: String, crop: String? = nil) -> SlideImageResponse {
            slideImageResponse(database: database, lectureId: "l1", slide: n, crop: crop, renderer: renderer)
        }

        for bad in ["abc", "0", "-1", "1.5", ""] {
            let response = answer(bad)
            XCTAssertEqual(response.status, 404, bad)
            XCTAssertEqual(response.bodyText, "No such slide.", bad)
            XCTAssertEqual(response.headers["content-type"], "text/plain;charset=UTF-8", bad)
        }
        XCTAssertEqual(answer("99").status, 404)
        XCTAssertEqual(answer("99").bodyText, "No picture of that slide.")
        XCTAssertEqual(answer("3").bodyText, "No picture of that slide.", "the .pptx deck has no pictures")

        let ok = answer("1")
        XCTAssertEqual(ok.status, 200)
        XCTAssertEqual(ok.headers, ["content-type": "image/png", "cache-control": "private, max-age=86400"])
        XCTAssertNil(ok.bodyText)
        XCTAssertEqual(try slideTestSize(ok.body), [1280, 960])
        XCTAssertEqual(try slideTestSize(answer("1", crop: "0,0,0.5,0.5").body), [640, 480])
        XCTAssertEqual(try slideTestSize(answer("1", crop: "nonsense").body), [1280, 960])
        // Number(" 2 ") is 2.
        XCTAssertEqual(try slideTestSize(answer(" 2 ").body), [1280, 1656])

        // The second PDF deck's file is missing: it can't be drawn.
        let broken = answer("6")
        XCTAssertEqual(broken.status, 500)
        XCTAssertEqual(broken.bodyText, "That slide could not be drawn.")
    }

    func testKeepsTheLastFourPDFsOpen() throws {
        let folder = try makeSlideTestFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let renderer = SlideRenderer(materialsDirectory: folder)
        var files: [String] = []
        for index in 1...5 {
            let file = folder.appendingPathComponent("deck\(index).pdf")
            try slideTestPDF(pages: [CGSize(width: 720, height: 540)]).write(to: file)
            files.append(file.path)
        }
        for file in files.prefix(4) {
            XCTAssertEqual(renderer.pageCount(file: file), 1)
        }
        XCTAssertEqual(renderer.openFiles, Array(files.prefix(4)))
        // Reading an open one doesn't move it (a Map keeps insertion order).
        XCTAssertEqual(renderer.pageCount(file: files[1]), 1)
        XCTAssertEqual(renderer.openFiles, Array(files.prefix(4)))
        XCTAssertEqual(renderer.pageCount(file: files[4]), 1)
        XCTAssertEqual(renderer.openFiles, [files[1], files[2], files[3], files[4]])
        XCTAssertEqual(renderer.pageCount(file: files[0]), 1)
        XCTAssertEqual(renderer.openFiles, [files[2], files[3], files[4], files[0]])
    }

    // MARK: Helpers

    private func makeSlideTestFolder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("lockin-slides-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    /// Lecture l1 with three decks, saved out of order: a 2-page PDF never counted, a
    /// .pptx never counted (three slides by its markers), and a 4-page PDF whose file is
    /// missing; plus a transcript and another lecture's deck.
    private func seedSlideTestLecture(_ database: LockinDatabase, folder: URL) throws {
        let lectureFolder = folder.appendingPathComponent("l1", isDirectory: true)
        try FileManager.default.createDirectory(at: lectureFolder, withIntermediateDirectories: true)
        try slideTestPDF(pages: [CGSize(width: 720, height: 540), CGSize(width: 612, height: 792)])
            .write(to: lectureFolder.appendingPathComponent("deckA.pdf"))
        let base = Date(timeIntervalSince1970: 1_790_000_000)
        try database.writer.write { db in
            var course = Course(id: "c1", code: "BIOL3010", title: "Genetics", createdAt: base)
            try course.insert(db)
            var lecture = Lecture(id: "l1", courseId: "c1", title: "Lac operon", deliveredOn: base, createdAt: base)
            try lecture.insert(db)
            var other = Lecture(id: "l2", courseId: "c1", title: "Trp operon", deliveredOn: base, createdAt: base)
            try other.insert(db)

            var later = Material(
                id: "mC", lectureId: "l1", kind: .slides, path: "l1/deckC.pdf", originalName: "Week 2.PDF",
                pageCount: 4, checksum: "kc", createdAt: base.addingTimeInterval(20)
            )
            try later.insert(db)
            var notes = Material(
                id: "mB", lectureId: "l1", kind: .slides, path: "l1/notes.pptx", originalName: "Notes.pptx",
                extractedText: "--- Slide 1 ---\nIntro\n--- Slide 3 ---\nEnd", checksum: "kb",
                createdAt: base.addingTimeInterval(10)
            )
            try notes.insert(db)
            var first = Material(
                id: "mA", lectureId: "l1", kind: .slides, path: "l1/deckA.pdf", originalName: "Week 1.pdf",
                checksum: "ka", createdAt: base
            )
            try first.insert(db)
            var transcript = Material(
                id: "mT", lectureId: "l1", kind: .transcript, path: "l1/talk.txt", originalName: "talk.pdf",
                extractedText: "words", checksum: "kt", createdAt: base
            )
            try transcript.insert(db)
            var elsewhere = Material(
                id: "mZ", lectureId: "l2", kind: .slides, path: "l2/deck.pdf", originalName: "Other.pdf",
                pageCount: 9, checksum: "kz", createdAt: base
            )
            try elsewhere.insert(db)
        }
    }
}

// MARK: - File-scope helpers

/// A PDF drawn with CoreGraphics: each page a red square at the bottom left of its own
/// space and a blue one at the top right, on nothing (white once drawn).
private func slideTestPDF(pages: [CGSize]) throws -> Data {
    let data = NSMutableData()
    let consumer = try XCTUnwrap(CGDataConsumer(data: data as CFMutableData))
    var media = CGRect(x: 0, y: 0, width: 720, height: 540)
    let context = try XCTUnwrap(CGContext(consumer: consumer, mediaBox: &media, nil))
    for size in pages {
        var box = CGRect(origin: .zero, size: size)
        let boxData = Data(bytes: &box, count: MemoryLayout<CGRect>.size)
        let info: [String: Any] = [kCGPDFContextMediaBox as String: boxData]
        context.beginPDFPage(info as CFDictionary)
        context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
        context.setFillColor(red: 0, green: 0, blue: 1, alpha: 1)
        context.fill(CGRect(x: size.width - 100, y: size.height - 100, width: 100, height: 100))
        context.endPDFPage()
    }
    context.closePDF()
    return data as Data
}

/// A one-page PDF written by hand, for a page with a /Rotate entry: the same squares as
/// `slideTestPDF`, in DeviceRGB.
private func handwrittenSlidePDF(width: Int, height: Int, rotate: Int) -> Data {
    let content = "1 0 0 rg 0 0 100 100 re f 0 0 1 rg \(width - 100) \(height - 100) 100 100 re f"
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 \(width) \(height)] /Rotate \(rotate) /Contents 4 0 R >>",
        "<< /Length \(content.utf8.count) >>\nstream\n\(content)\nendstream",
    ]
    var out = "%PDF-1.4\n"
    var offsets: [Int] = []
    for (index, object) in objects.enumerated() {
        offsets.append(out.utf8.count)
        out += "\(index + 1) 0 obj\n\(object)\nendobj\n"
    }
    let xref = out.utf8.count
    out += "xref\n0 \(objects.count + 1)\n0000000000 65535 f \n"
    for offset in offsets {
        let digits = String(offset)
        out += String(repeating: "0", count: max(0, 10 - digits.count)) + digits + " 00000 n \n"
    }
    out += "trailer\n<< /Size \(objects.count + 1) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n"
    return Data(out.utf8)
}

private func slideTestImage(_ png: Data) throws -> CGImage {
    let source = try XCTUnwrap(CGImageSourceCreateWithData(png as CFData, nil))
    return try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
}

private func slideTestSize(_ png: Data) throws -> [Int] {
    let image = try slideTestImage(png)
    return [image.width, image.height]
}

/// RGBA of one pixel, counted from the top left.
private func slideTestPixel(_ png: Data, x: Int, y: Int) throws -> [Int] {
    let image = try slideTestImage(png)
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let context = try XCTUnwrap(
        CGContext(
            data: nil,
            width: image.width,
            height: image.height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    )
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let base = try XCTUnwrap(context.data)
    let offset = y * context.bytesPerRow + x * 4
    return (0..<4).map { Int(base.load(fromByteOffset: offset + $0, as: UInt8.self)) }
}

private func slideTestIsRed(_ pixel: [Int]) -> Bool {
    pixel[0] > 200 && pixel[1] < 100 && pixel[2] < 100 && pixel[3] == 255
}

private func slideTestIsBlue(_ pixel: [Int]) -> Bool {
    pixel[2] > 180 && pixel[0] < 100 && pixel[3] == 255
}

private func slideTestIsWhite(_ pixel: [Int]) -> Bool {
    pixel[0] > 240 && pixel[1] > 240 && pixel[2] > 240 && pixel[3] == 255
}
