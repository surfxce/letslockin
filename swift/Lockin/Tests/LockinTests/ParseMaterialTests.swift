import AppKit
import Compression
import Foundation
import PDFKit
import XCTest
@testable import LockinCore

final class ParseMaterialTests: XCTestCase {
    func testParsesVttAndSrtCaptionsWithHoursAndDedupesLiveRepeats() throws {
        let vtt = """
        WEBVTT

        1
        00:00:05.000 --> 00:00:10.000
        <v Lecturer>welcome welcome welcome to lecture one.</v>

        2
        01:15:30.000 --> 01:15:40.000
        Now in the second hour we cover ghrelin.
        """
        let parsed = try parseMaterial(filename: "L1.vtt", data: Data(vtt.utf8))
        XCTAssertTrue(parsed.warnings.isEmpty)
        XCTAssertEqual(
            parsed.text,
            "[00:05] welcome welcome to lecture one.\n\n[1:15:30] Now in the second hour we cover ghrelin."
        )
        XCTAssertEqual(measureHours(parsed.text), 1.5)
        XCTAssertEqual(guessKind(filename: "L1.vtt", text: parsed.text), .transcript)
    }

    func testGuessesKindFromFilenameAndContent() {
        XCTAssertEqual(guessKind(filename: "deck.pptx"), .slides)
        XCTAssertEqual(guessKind(filename: "captions.srt"), .transcript)
        XCTAssertEqual(guessKind(filename: "notes.txt", text: "--- Slide 1 ---\nIntro"), .slides)
        XCTAssertEqual(guessKind(filename: "export.pdf", text: "[00:12] Good morning"), .transcript)
        XCTAssertEqual(guessKind(filename: "handout.pdf", text: "Plain text on page"), .slides)
    }

    func testParsesPdfAndWarnsOnEmptyPages() throws {
        let pdf = PDFDocument()
        let pageWithText = PDFPage()
        pdf.insert(pageWithText, at: 0)
        let data = try XCTUnwrap(pdf.dataRepresentation())

        let parsed = try parseMaterial(filename: "slides.pdf", data: data)
        XCTAssertEqual(parsed.pages, 1)
        XCTAssertEqual(parsed.warnings.count, 1)
        XCTAssertTrue(parsed.warnings[0].contains("1 of 1 pages have no selectable text"))
    }

    func testParsesPptxZipArchiveAndWarnsOnDiagramOnlySlides() throws {
        let slide1 = #"<p:sld><a:t>Lac &amp; Trp Operons</a:t><a:t>Overview</a:t></p:sld>"#
        let slide2 = #"<p:sld></p:sld>"#
        let zipData = makeUncompressedZip(entries: [
            ("ppt/slides/slide2.xml", Data(slide2.utf8)),
            ("ppt/slides/slide1.xml", Data(slide1.utf8)),
        ])

        let parsed = try parseMaterial(filename: "deck.pptx", data: zipData)
        XCTAssertEqual(parsed.pages, 2)
        XCTAssertEqual(
            parsed.text,
            "--- Slide 1 ---\nLac & Trp Operons Overview\n\n--- Slide 2 ---\n(no text — image or diagram only)"
        )
        XCTAssertEqual(parsed.warnings.count, 1)
        XCTAssertTrue(parsed.warnings[0].contains("slide 2 carry no text"))
    }

    private func makeUncompressedZip(entries: [(String, Data)]) -> Data {
        var out = Data()
        var centralDir = Data()

        func appendU16(_ d: inout Data, _ v: UInt16) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { d.append(contentsOf: $0) }
        }
        func appendU32(_ d: inout Data, _ v: UInt32) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { d.append(contentsOf: $0) }
        }

        for (name, content) in entries {
            let localOffset = UInt32(out.count)
            let nameData = Data(name.utf8)

            // Local file header (0x04034b50)
            appendU32(&out, 0x0403_4b50)
            appendU16(&out, 20)
            appendU16(&out, 0)
            appendU16(&out, 0) // store (method 0)
            appendU16(&out, 0)
            appendU16(&out, 0)
            appendU32(&out, 0)
            appendU32(&out, UInt32(content.count))
            appendU32(&out, UInt32(content.count))
            appendU16(&out, UInt16(nameData.count))
            appendU16(&out, 0)
            out.append(nameData)
            out.append(content)

            // Central directory header (0x02014b50)
            appendU32(&centralDir, 0x0201_4b50)
            appendU16(&centralDir, 20)
            appendU16(&centralDir, 20)
            appendU16(&centralDir, 0)
            appendU16(&centralDir, 0)
            appendU16(&centralDir, 0)
            appendU16(&centralDir, 0)
            appendU32(&centralDir, 0)
            appendU32(&centralDir, UInt32(content.count))
            appendU32(&centralDir, UInt32(content.count))
            appendU16(&centralDir, UInt16(nameData.count))
            appendU16(&centralDir, 0)
            appendU16(&centralDir, 0)
            appendU16(&centralDir, 0)
            appendU16(&centralDir, 0)
            appendU32(&centralDir, 0)
            appendU32(&centralDir, localOffset)
            centralDir.append(nameData)
        }

        let cdOffset = UInt32(out.count)
        out.append(centralDir)

        // End of central directory (0x06054b50)
        appendU32(&out, 0x0605_4b50)
        appendU16(&out, 0)
        appendU16(&out, 0)
        appendU16(&out, UInt16(entries.count))
        appendU16(&out, UInt16(entries.count))
        appendU32(&out, UInt32(centralDir.count))
        appendU32(&out, cdOffset)
        appendU16(&out, 0)
        return out
    }
}
