import XCTest
@testable import LockinKit

final class ListeningTests: XCTestCase {
    func testReadsASummaryBySection() {
        let html = """
        <p>Opening line &amp; context.</p>
        <h2>Mechanism</h2>
        <p>Gd-IgA1 &rarr; immune complexes</p>
        <figure><img src="lockin-slide://l/3"><figcaption>Slide 3</figcaption></figure>
        <ul><li>Complement ↑</li><li>GFR ↓, e.g. in crescents</li></ul>
        <span class="slide-tools"><button>Crop</button></span>
        <h3>Empty heading</h3>
        <h3>Treatment</h3><p>ACE inhibitors&#8212;first line</p>
        """
        let sections = readableSections(html: html, title: "IgA nephropathy")
        XCTAssertEqual(sections.map(\.heading), ["IgA nephropathy", "Mechanism", "Treatment"])
        XCTAssertEqual(sections[0].text, "Opening line and context.")
        XCTAssertEqual(sections[1].text, "Gd-IgA1 leads to immune complexes. Complement increased. GFR decreased, for example in crescents.")
        XCTAssertEqual(sections[2].text, "ACE inhibitors—first line.")
        XCTAssertFalse(sections.contains { $0.text.contains("Crop") || $0.text.contains("Slide 3") })
    }

    func testDecodesEntities() {
        XCTAssertEqual(decodeEntities("&lt;5 &amp;&amp; &#x2192; &#8805;"), "<5 && → ≥")
    }
}
