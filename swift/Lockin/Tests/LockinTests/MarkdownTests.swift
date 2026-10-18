import XCTest
@testable import LockinCore

final class MarkdownTests: XCTestCase {
    private let slides = SlideImages(base: "/api/lectures/abc/slides", ranges: [(1, 5)])

    // MARK: - renderMarkdown (lib/markdown.test.ts)

    func testShowsACitedSlideAsItsPictureCaptionedOutsideAnyParagraph() {
        let html = renderMarkdown("Ghrelin rises before meals.\n\n![The ghrelin pathway](slide:2)\n", slides: slides)
        XCTAssertTrue(
            html.contains(
                #"<figure class="slide-fig"><a href="/api/lectures/abc/slides/2" target="_blank" rel="noopener">"#
                    + #"<img src="/api/lectures/abc/slides/2" alt="The ghrelin pathway" loading="lazy"></a>"#
                    + #"<figcaption>The ghrelin pathway <span>· slide 2</span></figcaption></figure>"#
            ),
            "Unexpected HTML: \(html)"
        )
        XCTAssertFalse(Regex.test(Regex.compile(#"<p>\s*<figure"#), in: html))
    }

    func testKeepsTheCaptionWithoutABrokenImageWhenSlideHasNoPicture() {
        XCTAssertTrue(
            renderMarkdown("![Vagal afferents](slide:9)", slides: slides)
                .contains(#"<figure class="slide-fig missing"><figcaption>Vagal afferents <span>· slide 9</span>"#)
        )
        XCTAssertTrue(
            renderMarkdown("![Vagal afferents](slide:2)").contains(#"class="slide-fig missing""#)
        )
    }

    func testReadsWaysModelsActuallyWriteSlideMarkers() {
        for src in ["Slide:2", "slides:2", "slide-2", "p2", "slide: 2", "slide 2", "page 2", "slide#2"] {
            XCTAssertEqual(slideNumbers(src), [2], "Failed for \(src)")
            XCTAssertTrue(
                renderMarkdown("![Fed state](\(src))", slides: slides)
                    .contains(#"<img src="/api/lectures/abc/slides/2""#),
                "Failed renderMarkdown for \(src)"
            )
        }
        XCTAssertEqual(slideNumbers("slide:3-4"), [3, 4])
        XCTAssertEqual(slideNumbers("diagram.png"), nil)
    }

    func testShowsARangeOfSlidesSideBySideWithOneCaption() {
        let html = renderMarkdown("![Fed and fasted](slide:3-4)", slides: slides)
        XCTAssertTrue(html.contains(#"<figure class="slide-fig multi">"#))
        XCTAssertEqual(Regex.allMatches(Regex.compile(#"<img "#), in: html).count, 2)
        XCTAssertTrue(html.contains("<figcaption>Fed and fasted <span>· slides 3–4</span>"))
    }

    func testNeverShowsABrokenImageForAPictureThatIsntASlideOrARealAddress() {
        let html = renderMarkdown("![A made-up diagram](diagram.png)", slides: slides)
        XCTAssertFalse(html.contains("<img"))
        XCTAssertTrue(html.contains(#"<figure class="slide-fig missing"><figcaption>A made-up diagram</figcaption>"#))
        XCTAssertTrue(
            renderMarkdown("![Real](https://example.com/a.png)", slides: slides)
                .contains(#"<img src="https://example.com/a.png""#)
        )
    }

    func testStillStripsAnythingThatCouldRun() {
        let html = renderMarkdown(
            #"<img src="x" onerror="alert(1)"><script>alert(2)</script>"#
                + "[a](javascript:alert(3)) [b](javascript&#58;alert(4)) [c](&#x6a;avascript:alert(5)) "
                + #"[d](javascript%3Aalert(6)) <a href="java&#x09;script:alert(7)">e</a>"#
        )
        XCTAssertFalse(
            Regex.test(Regex.compile(#"onerror|<script|javascript|alert\("#, options: [.caseInsensitive]), in: html),
            "Unexpected HTML: \(html)"
        )
    }

    func testStripsTagsThatCouldSendThePageElsewhere() {
        let html = renderMarkdown(
            "Fine.\n\n"
                + #"<meta http-equiv="refresh" content="0;url=https://example.com/"><base href="https://example.com/">"#
                + #"<link rel="stylesheet" href="https://example.com/x.css"><form action="https://example.com/">Hi</form>"#
        )
        XCTAssertFalse(Regex.test(Regex.compile(#"<meta|<base|<link|<form|<\/form"#, options: [.caseInsensitive]), in: html))
        XCTAssertTrue(html.contains("Fine."))
    }

    // MARK: - Crops

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

    func testShowsACroppedPictureWithACropButtonOnlyWhereAsked() {
        let md = "![Fed state](slide:2#crop=2:0.1,0.2,0.5,0.4)"
        XCTAssertTrue(renderMarkdown(md, slides: slides).contains(#"<img src="/api/lectures/abc/slides/2?crop=0.1,0.2,0.5,0.4""#))
        XCTAssertFalse(renderMarkdown(md, slides: slides).contains("slide-crop"))
        let croppableSlides = SlideImages(base: slides.base, ranges: slides.ranges, croppable: true)
        let html = renderMarkdown("\(md)\n\n![Fasting](slide:3)", slides: croppableSlides)
        XCTAssertTrue(html.contains(#"class="slide-crop" data-fig="0" data-slide="2" data-crop="0.1,0.2,0.5,0.4""#))
        XCTAssertTrue(html.contains(#"class="slide-crop" data-fig="1" data-slide="3" data-crop="""#))
    }

    func testPrintsPicturesAsPlainEagerlyLoadedImagesCropAndAll() {
        let printSlides = SlideImages(base: slides.base, ranges: slides.ranges, croppable: true, print: true)
        let html = renderMarkdown("![Fed state](slide:2#crop=2:0.1,0.2,0.5,0.4)", slides: printSlides)
        XCTAssertTrue(
            html.contains(#"<figure class="slide-fig"><img src="/api/lectures/abc/slides/2?crop=0.1,0.2,0.5,0.4" alt="Fed state">"#)
        )
        XCTAssertFalse(Regex.test(Regex.compile(#"<a |loading=|slide-crop"#), in: html))
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

    func testCropsOneSlideOfPairAndRendererCountsPicturesTheSameWay() throws {
        let crop = Crop(x: 0.1, y: 0.2, w: 0.5, h: 0.4)
        let md = try XCTUnwrap(setFigureCrop(md: "![One](slide:1)\n\n![Pair](slide:3-4)", figure: 1, slide: 4, crop: crop))
        XCTAssertTrue(md.contains("![Pair](slide:3-4#crop=4:0.1,0.2,0.5,0.4)"))
        let croppableSlides = SlideImages(base: slides.base, ranges: slides.ranges, croppable: true)
        let html = renderMarkdown(md, slides: croppableSlides)
        XCTAssertTrue(html.contains(#"<img src="/api/lectures/abc/slides/3""#))
        XCTAssertTrue(html.contains(#"<img src="/api/lectures/abc/slides/4?crop=0.1,0.2,0.5,0.4""#))
        XCTAssertTrue(html.contains(#"data-fig="1" data-slide="4""#))
    }
}
