import Foundation
import XCTest
@testable import LockinCore

final class JSONSchemasTests: XCTestCase {
    // MARK: strictSchema (lib/llm/strict-schema.test.ts)

    func testStrictSchemaMakesEveryPropertyRequiredAndNoOthersAllowedAllTheWayDown() {
        let noteObject: JSONValue = ["type": "object", "properties": ["text": ["type": "string"]]]
        let noneType: JSONValue = ["type": "null"]
        let rubric: JSONValue = ["type": "object", "properties": ["totalMarks": ["const": 10]]]
        let itemProperties: JSONValue = [
            "stem": ["type": "string"],
            "rubric": rubric,
            "note": ["oneOf": .array([noteObject, noneType])],
        ]
        let item: JSONValue = ["type": "object", "properties": itemProperties]
        let questions: JSONValue = ["type": "array", "items": item]
        let schema: JSONValue = ["type": "object", "properties": ["questions": questions]]

        let strict = strictSchema(schema)
        XCTAssertEqual(strict["required"], JSONValue.strings(["questions"]))
        XCTAssertEqual(strict["additionalProperties"], JSONValue.bool(false))
        let strictItem = strict["properties"]?["questions"]?["items"]
        XCTAssertEqual(strictItem?["required"], JSONValue.strings(["stem", "rubric", "note"]))
        XCTAssertEqual(strictItem?["additionalProperties"], JSONValue.bool(false))
        XCTAssertEqual(strictItem?["properties"]?["rubric"]?["required"], JSONValue.strings(["totalMarks"]))
        XCTAssertEqual(strictItem?["properties"]?["note"]?["oneOf"]?[0]?["required"], JSONValue.strings(["text"]))
        XCTAssertEqual(strictItem?["properties"]?["note"]?["oneOf"]?[1], noneType)
        // The original is left as it was.
        XCTAssertNil(schema["required"])
    }

    func testStrictSchemaKeepsExtraPropertiesWhereTheSchemaAllowsThem() {
        let schema: JSONValue = [
            "type": "object",
            "properties": ["a": ["type": "string"]],
            "additionalProperties": ["type": "number"],
        ]
        let strict = strictSchema(schema)
        XCTAssertEqual(strict["required"], JSONValue.strings(["a"]))
        let numbers: JSONValue = ["type": "number"]
        XCTAssertEqual(strict["additionalProperties"], numbers)
        // Keys keep their places; the new ones come last, as in JavaScript.
        let order: [String] = ["type", "properties", "additionalProperties", "required"]
        XCTAssertEqual(strict.objectValue?.keys, order)
    }

    // MARK: JSON.stringify

    func testStringifyMatchesJavaScript() {
        let value: JSONValue = [
            "b": 1,
            "a": ["x", .null, true, 2.5],
            "path": "a/b \"q\" \\ \n\t\u{01} é 😀",
            "empty": [:],
            "none": [],
        ]
        XCTAssertEqual(
            value.stringified(),
            #"{"b":1,"a":["x",null,true,2.5],"path":"a/b \"q\" \\ \n\t\u0001 é 😀","empty":{},"none":[]}"#
        )
        XCTAssertEqual(
            value.stringified(indent: 2),
            #"""
            {
              "b": 1,
              "a": [
                "x",
                null,
                true,
                2.5
              ],
              "path": "a/b \"q\" \\ \n\t\u0001 é 😀",
              "empty": {},
              "none": []
            }
            """#
        )
    }

    func testNumbersAreWrittenAsJavaScriptWritesThem() {
        XCTAssertEqual(jsNumberString(10), "10")
        XCTAssertEqual(jsNumberString(-0.0), "0")
        XCTAssertEqual(jsNumberString(2.5), "2.5")
        XCTAssertEqual(jsNumberString(-1.5), "-1.5")
        XCTAssertEqual(jsNumberString(0.1), "0.1")
        XCTAssertEqual(jsNumberString(0.5), "0.5")
        XCTAssertEqual(jsNumberString(0.00001), "0.00001")
        XCTAssertEqual(jsNumberString(0.0000001), "1e-7")
        XCTAssertEqual(jsNumberString(1.5e-7), "1.5e-7")
        XCTAssertEqual(jsNumberString(123_456_789_012_345_680), "123456789012345680")
        XCTAssertEqual(jsNumberString(1e21), "1e+21")
        XCTAssertEqual(jsNumberString(1e300), "1e+300")
        XCTAssertEqual(jsNumberString(1_700_000_000_000), "1700000000000")
        XCTAssertEqual(JSONValue.number(.infinity).stringified(), "null")
        XCTAssertEqual(jsMathRound(2.5), 3)
        XCTAssertEqual(jsMathRound(-2.5), -2)
        XCTAssertEqual(jsMathRound(2.4), 2)
    }

    // MARK: JSON.parse

    func testParseKeepsKeyOrderAndReadsEscapes() throws {
        let parsed = try JSONValue.parse(#" {"z": 1, "a": {"k": [1, -0.5e2, "é😀\/"]}, "z": 2} "#)
        let order: [String] = ["z", "a"]
        XCTAssertEqual(parsed.objectValue?.keys, order)
        XCTAssertEqual(parsed["z"], JSONValue.number(2))
        XCTAssertEqual(parsed["a"]?["k"]?[1], JSONValue.number(-50))
        XCTAssertEqual(parsed["a"]?["k"]?[2], JSONValue.string("é😀/"))
        XCTAssertEqual(parsed.stringified(), #"{"z":2,"a":{"k":[1,-50,"é😀/"]}}"#)
    }

    func testParseRejectsWhatJSONParseRejects() {
        for bad in ["", "{", "[1,]", "{\"a\":1,}", "01", "'x'", "tru", "{\"a\" 1}", "[1] 2", "\"tab\there\""] {
            XCTAssertThrowsError(try JSONValue.parse(bad), bad) { error in
                XCTAssertTrue(error is JSONParseError, bad)
            }
        }
        XCTAssertEqual(try JSONValue.parse("  null "), JSONValue.null)
        XCTAssertEqual(try JSONValue.parse("[]"), JSONValue.array([]))
    }

    func testParseErrorsReadAsV8WritesThem() {
        // Each message is what `JSON.parse` says in Node 22 (V8): the repair pass quotes it to
        // the model, and a job that fails twice shows it.
        let cases: [(String, String)] = [
            ("", "Unexpected end of JSON input"),
            ("{", "Expected property name or '}' in JSON at position 1 (line 1 column 2)"),
            ("[1,]", "Unexpected token ']', \"[1,]\" is not valid JSON"),
            (#"{"a":1,}"#, "Expected double-quoted property name in JSON at position 7 (line 1 column 8)"),
            ("01", "Unexpected number in JSON at position 1 (line 1 column 2)"),
            ("x", "Unexpected token 'x', \"x\" is not valid JSON"),
            ("tru", "Unexpected end of JSON input"),
            (#"{"a" 1}"#, "Expected ':' after property name in JSON at position 5 (line 1 column 6)"),
            ("[1] 2", "Unexpected non-whitespace character after JSON at position 4 (line 1 column 5)"),
            ("\"tab\there\"", "Bad control character in string literal in JSON at position 4 (line 1 column 5)"),
            (#"{"a":1 "b":2}"#, "Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)"),
            ("[1 2]", "Expected ',' or ']' after array element in JSON at position 3 (line 1 column 4)"),
            (#""\x""#, "Bad escaped character in JSON at position 2 (line 1 column 3)"),
            (#""\u12""#, "Bad Unicode escape in JSON at position 5 (line 1 column 6)"),
            ("-", "No number after minus sign in JSON at position 1 (line 1 column 2)"),
            ("1.", "Unterminated fractional number in JSON at position 2 (line 1 column 3)"),
            ("1e", "Exponent part is missing a number in JSON at position 2 (line 1 column 3)"),
            ("\"abc", "Unterminated string in JSON at position 4 (line 1 column 5)"),
            ("NaN", "\"NaN\" is not valid JSON"),
            ("nult", "Unexpected token 't', \"nult\" is not valid JSON"),
            ("tr1e", "Unexpected number in JSON at position 2 (line 1 column 3)"),
            (#"{"a":1"#, "Expected ',' or '}' after property value in JSON at position 6 (line 1 column 7)"),
            ("{\r\n\"a\":1\r\n,}", "Expected double-quoted property name in JSON at position 11 (line 3 column 2)"),
            (#"{"key": “quoted”}"#, #"Unexpected token '“', "{"key": “quoted”}" is not valid JSON"#),
            ("Here is the answer you asked for: { not json at all here }", #"Unexpected token 'H', "Here is th"... is not valid JSON"#),
            (#"{"a":[1,2],"b":{"c":nope}} and more text"#, #"Unexpected token 'o', ...""b":{"c":nope}} and "... is not valid JSON"#),
            ("[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,x]", #"Unexpected token 'x', ...",13,14,15,x]" is not valid JSON"#),
            (#"{"a":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]  x }"#, "Expected ',' or '}' after property value in JSON at position 44 (line 1 column 45)"),
            // Positions count UTF-16 units, as JavaScript does: an emoji is two.
            (#"{"😀":1 2}"#, "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)"),
            (#"["😀😀😀😀😀😀😀😀😀😀😀😀", 1 2]"#, "Expected ',' or ']' after array element in JSON at position 31 (line 1 column 32)"),
        ]
        for (input, expected) in cases {
            XCTAssertThrowsError(try JSONValue.parse(input), input) { error in
                XCTAssertEqual((error as? JSONParseError)?.message, expected, input)
                XCTAssertEqual(messageOf(error), expected, input)
            }
        }
    }

    func testIntegerKeysComeFirstAsInJavaScript() throws {
        let parsed = try JSONValue.parse(#"{"b":1,"2":2,"1":3,"01":4,"4294967295":5,"4294967294":6,"b":7}"#)
        let order: [String] = ["1", "2", "4294967294", "b", "01", "4294967295"]
        XCTAssertEqual(parsed.objectValue?.keys, order)
        XCTAssertEqual(parsed.stringified(), #"{"1":3,"2":2,"4294967294":6,"b":7,"01":4,"4294967295":5}"#)
        let escaped = try JSONValue.parse(#"{"a":"é😀"}"#)
        XCTAssertEqual(escaped["a"], JSONValue.string("é😀"))
    }

    func testNumberConvertsAsJavaScriptDoes() {
        let fromStrings: [(String, Double)] = [
            ("", 0), (" 4 ", 4), ("0x10", 16), ("0b11", 3), ("0o7", 7), ("1e3", 1000), (".5", 0.5), ("5.", 5),
            ("+5", 5), ("Infinity", Double.infinity), ("-Infinity", -Double.infinity), ("1e400", Double.infinity),
            ("\u{00A0}4\u{FEFF}", 4),
        ]
        for (text, expected) in fromStrings {
            XCTAssertEqual(jsNumberValue(.string(text)), expected, text)
        }
        for text in ["-0x10", "inf", "nan", "1_0", "\u{0085}4", "12px", "0x"] {
            XCTAssertTrue(jsNumberValue(.string(text)).isNaN, text)
        }
        let one: JSONValue = [5]
        let quoted: JSONValue = ["5"]
        let nested: JSONValue = [[3]]
        let holdsNull: JSONValue = [.null]
        let pair: JSONValue = [1, 2]
        let flag: JSONValue = [true]
        let empty: JSONValue = []
        let object: JSONValue = [:]
        XCTAssertEqual(jsNumberValue(one), 5)
        XCTAssertEqual(jsNumberValue(quoted), 5)
        XCTAssertEqual(jsNumberValue(nested), 3)
        XCTAssertEqual(jsNumberValue(holdsNull), 0)
        XCTAssertEqual(jsNumberValue(empty), 0)
        XCTAssertEqual(jsNumberValue(.null), 0)
        XCTAssertEqual(jsNumberValue(.bool(true)), 1)
        XCTAssertTrue(jsNumberValue(pair).isNaN)
        XCTAssertTrue(jsNumberValue(flag).isNaN)
        XCTAssertTrue(jsNumberValue(object).isNaN)
        XCTAssertTrue(jsNumberValue(nil).isNaN)
    }

    func testJSONValueRoundTripsThroughCodable() throws {
        let value: JSONValue = ["a": [2, "two", false, .null], "b": ["c": 3.25]]
        let data = try JSONEncoder().encode(value)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded, value)
    }

    // MARK: The offline schemas (lib/llm/local.ts)

    func testOfflineSchemasMatchLocalTs() {
        XCTAssertEqual(
            OfflineSchemas.marks.stringified(),
            #"{"enum":[0,0.5,1,1.5,2,2.5,3,3.5,4,4.5,5,5.5,6,6.5,7,7.5,8,8.5,9,9.5,10]}"#
        )
        XCTAssertEqual(OfflineSchemas.text(80).stringified(), #"{"type":"string","minLength":1,"maxLength":80}"#)
        XCTAssertEqual(OfflineSchemas.text(0).stringified(), #"{"type":"string","minLength":1}"#)
        XCTAssertEqual(OfflineSchemas.idOf([]).stringified(), #"{"type":"null"}"#)
        XCTAssertEqual(
            OfflineSchemas.answer(headings: ["Ghrelin"], maxLength: 900).stringified(),
            #"{"type":"object","properties":{"answer":{"type":"string","minLength":1,"maxLength":900},"#
                + #""section":{"oneOf":[{"enum":["Ghrelin"]},{"type":"null"}]}}}"#
        )
        let nullType: JSONValue = ["type": "null"]
        let fileNumbers: JSONValue = ["enum": [1, 2]]
        let laqOnly: JSONValue = ["const": "LAQ"]
        let noGaps: JSONValue = ["type": "array", "maxItems": 0]
        XCTAssertEqual(OfflineSchemas.digest(existingIds: [])["properties"]?["concepts"]?["items"]?["properties"]?["existingId"], nullType)
        XCTAssertEqual(OfflineSchemas.sort(fileCount: 2)["properties"]?["lectures"]?["items"]?["properties"]?["files"]?["items"], fileNumbers)

        let questions = OfflineSchemas.questions(conceptIds: ["c1"], type: .laq, total: 3)
        XCTAssertEqual(questions["properties"]?["questions"]?["minItems"], JSONValue.number(3))
        XCTAssertEqual(questions["properties"]?["questions"]?["items"]?["properties"]?["type"], laqOnly)

        let marking = strictSchema(OfflineSchemas.marking(conceptIds: []))
        XCTAssertEqual(marking["required"], JSONValue.strings(["mark", "criteria", "gaps"]))
        XCTAssertEqual(marking["properties"]?["gaps"], noGaps)
        XCTAssertEqual(
            marking["properties"]?["criteria"]?["items"]?["required"],
            JSONValue.strings(["point", "awarded", "outOf", "note"])
        )
    }
}
