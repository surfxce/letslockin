import XCTest
@testable import LockinCore

final class MarkdownTests: XCTestCase {
    private let slides = SlideImages(base: "/api/lectures/abc/slides", ranges: [(1, 5)])

    func testReadsWaysModelsActuallyWriteSlideMarkers() {
        for src in ["Slide:2", "slides:2", "slide-2", "p2", "slide: 2", "slide 2", "page 2", "slide#2"] {
            XCTAssertEqual(slideNumbers(src), [2], "Failed for \(src)")
        }
        XCTAssertEqual(slideNumbers("slide:3-4"), [3, 4])
        XCTAssertEqual(slideNumbers("diagram.png"), nil)
    }

    func testCropsReadAndValidateCorrectly() {
        let crop = Crop(x: 0.1, y: 0.2, w: 0.5, h: 0.4)
        XCTAssertEqual(slideNumbers("slide:7#crop=7:0.1,0.2,0.5,0.4"), [7])
        XCTAssertEqual(slideNumbers("slide:7-8#crop=8:0,0,0.5,0.5"), [7, 8])
        XCTAssertEqual(slideNumbers("slide#7"), [7])
        XCTAssertEqual(
            markerCrops("slide:7-8#crop=7:0.1,0.2,0.5,0.4;8:0,0,1,0.5"),
            [
                7: crop,
                8: Crop(x: 0, y: 0, w: 1, h: 0.5),
            ]
        )

        XCTAssertEqual(cleanCrop(x: 0.9, y: -1, w: 0.5, h: 2), Crop(x: 0.9, y: 0, w: 0.1, h: 1))
        XCTAssertNil(cleanCrop(x: 0.5, y: 0.5, w: 0.01, h: 0.5))
        XCTAssertNil(cleanCrop(x: .nan, y: 0, w: 1, h: 1))
        XCTAssertEqual(
            slidePictureUrl(base: slides.base, slide: 2, crop: crop),
            "/api/lectures/abc/slides/2?crop=0.1,0.2,0.5,0.4"
        )
    }

    func testWritesCropIntoRightMarkerAndTakesItOutAgain() throws {
        let crop = Crop(x: 0.1, y: 0.2, w: 0.5, h: 0.4)
        let md = "Intro `![not this](slide:1)`\n\n![A](Slide 2)\n\n```\n![code](slide:2)\n```\n\n![B](slide:2 \"T\")"
        let once = try XCTUnwrap(setFigureCrop(md: md, figure: 1, slide: 2, crop: crop))
        XCTAssertTrue(once.contains("![A](Slide 2)"))
        XCTAssertTrue(once.contains(#"![B](slide:2#crop=2:0.1,0.2,0.5,0.4 "T")"#))
        XCTAssertTrue(once.contains("```\n![code](slide:2)\n```"))
        let cleared = try XCTUnwrap(setFigureCrop(md: once, figure: 1, slide: 2, crop: nil))
        XCTAssertTrue(cleared.contains(#"![B](slide:2 "T")"#))
        XCTAssertNil(setFigureCrop(md: md, figure: 1, slide: 9, crop: crop))
        XCTAssertNil(setFigureCrop(md: md, figure: 5, slide: 2, crop: crop))
        XCTAssertEqual(setFigureCrop(md: once, figure: 1, slide: 2, crop: crop), once)
    }

    func testCropsOneSlideOfPair() throws {
        let crop = Crop(x: 0.1, y: 0.2, w: 0.5, h: 0.4)
        let md = try XCTUnwrap(setFigureCrop(md: "![One](slide:1)\n\n![Pair](slide:3-4)", figure: 1, slide: 4, crop: crop))
        XCTAssertTrue(md.contains("![Pair](slide:3-4#crop=4:0.1,0.2,0.5,0.4)"))
        XCTAssertEqual(markerCrops("slide:3-4#crop=4:0.1,0.2,0.5,0.4"), [4: crop])
    }
}
