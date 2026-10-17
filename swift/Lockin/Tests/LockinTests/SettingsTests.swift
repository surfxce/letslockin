import Foundation
import GRDB
import XCTest
@testable import LockinCore

final class SettingsTests: XCTestCase {
    func testDefaultsWhenNothingIsSet() throws {
        let db = try LockinDatabase.inMemory()
        let settings = try getSettings(database: db)
        XCTAssertEqual(settings, LockinSettings.defaults)
        XCTAssertEqual(settings.mode, .auto)
        XCTAssertEqual(settings.laqsPerHour, 2)
        XCTAssertEqual(settings.cloudModel, .sonnet)
        XCTAssertTrue(settings.fallbackLocal)
        XCTAssertTrue(settings.apiVision)
        XCTAssertNil(settings.localModel)
    }

    func testValuesAreCheckedAsGetSettingsChecksThem() throws {
        let db = try LockinDatabase.inMemory()
        try db.writer.write { conn in
            try setSetting(db: conn, key: "mode", value: "manual")
            try setSetting(db: conn, key: "laqsPerHour", value: "3")
            try setSetting(db: conn, key: "sittingPerHour", value: 20)
            try setSetting(db: conn, key: "laqStyle", value: "poems")
            try setSetting(db: conn, key: "cloudModel", value: "opus")
            try setSetting(db: conn, key: "fallbackLocal", value: .null)
            try setSetting(db: conn, key: "apiVision", value: false)
            try setSetting(db: conn, key: "slideReader", value: 5)
            try setSetting(db: conn, key: "codexModel", value: 5)
            try setSetting(db: conn, key: "agyModel", value: "gemini-3")
            try setSetting(db: conn, key: "localModel", value: "gemma-4-e4b")
            try setSetting(db: conn, key: "notify", value: 1)
            // A half-written value falls back to the default.
            var broken = Setting(key: "cloudEngine", value: "{not json")
            try broken.save(conn)
        }
        let settings = try getSettings(database: db)
        XCTAssertEqual(settings.mode, .manual)
        XCTAssertEqual(settings.laqsPerHour, 3)
        XCTAssertEqual(settings.sittingPerHour, 8)
        XCTAssertEqual(settings.laqStyle, .mixed)
        XCTAssertEqual(settings.cloudModel, .opus)
        XCTAssertTrue(settings.fallbackLocal)
        XCTAssertFalse(settings.apiVision)
        XCTAssertNil(settings.slideReader)
        XCTAssertEqual(settings.codexModel, "")
        XCTAssertEqual(settings.agyModel, "gemini-3")
        XCTAssertEqual(settings.localModel, "gemma-4-e4b")
        XCTAssertTrue(settings.notify)
        XCTAssertEqual(settings.cloudEngine, .claude)

        // Stored as JSON, as the Electron app stores it.
        let stored = try db.reader.read { conn in try Setting.fetchOne(conn, key: "mode")?.value }
        XCTAssertEqual(stored, "\"manual\"")
    }

    func testPerHourIsAWholeNumberFromOneToEight() {
        XCTAssertEqual(perHour(JSONValue.number(2.5)), 3)
        XCTAssertEqual(perHour(JSONValue.string(" 4 ")), 4)
        XCTAssertEqual(perHour(JSONValue.number(0), fallback: 5), 5)
        XCTAssertEqual(perHour(JSONValue.null, fallback: 5), 5)
        XCTAssertEqual(perHour(JSONValue.string("lots"), fallback: 5), 5)
        XCTAssertEqual(perHour(JSONValue.number(99)), 8)
        XCTAssertEqual(perHour(nil, fallback: 6), 6)
    }

    func testTheApiKeyIsKeptApart() throws {
        let db = try LockinDatabase.inMemory()
        try db.writer.write { conn in
            XCTAssertNil(try getApiKey(db: conn))
            try setApiKey(db: conn, "sk-test")
            XCTAssertEqual(try getApiKey(db: conn), "sk-test")
            try setApiKey(db: conn, nil)
            XCTAssertNil(try getApiKey(db: conn))
        }
    }

    func testHeartbeatsAndWhoOwnsTheQueue() throws {
        let db = try LockinDatabase.inMemory()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try db.writer.write { conn in
            XCTAssertNil(try readHeartbeat(db: conn, now: now))
            XCTAssertEqual(queueOwnership(try readHeartbeat(db: conn, now: now), pid: 42), .free)

            // The Electron worker's heartbeat, as it writes it.
            let electron = Heartbeat(at: jsISOString(now), pid: 7, provider: "Claude Code")
            try setSetting(db: conn, key: heartbeatKey, value: electron.json)
            let stored = try Setting.fetchOne(conn, key: heartbeatKey)?.value
            XCTAssertEqual(stored, #"{"at":"2027-01-15T08:00:00.000Z","pid":7,"provider":"Claude Code"}"#)

            let fresh = try readHeartbeat(db: conn, now: now.addingTimeInterval(19))
            XCTAssertEqual(fresh?.alive, true)
            XCTAssertEqual(queueOwnership(fresh, pid: 42), .taken(electron))

            let stale = try readHeartbeat(db: conn, now: now.addingTimeInterval(21))
            XCTAssertEqual(stale?.alive, false)
            XCTAssertEqual(queueOwnership(stale, pid: 42), .free)

            // This app's own heartbeat is its own, even gone stale (a Mac asleep).
            try writeHeartbeat(db: conn, Heartbeat.current(now: now, pid: 42, provider: "On this computer"))
            let mine = try readHeartbeat(db: conn, now: now.addingTimeInterval(600))
            XCTAssertEqual(mine?.heartbeat.app, "swift")
            XCTAssertEqual(queueOwnership(mine, pid: 42), .ours)
            XCTAssertEqual(queueOwnership(mine, pid: 43), .free)

            // Only this app's own row is deleted on a clean stop.
            try deleteHeartbeat(db: conn, onlyIfPid: 43)
            XCTAssertNotNil(try readHeartbeat(db: conn))
            try deleteHeartbeat(db: conn, onlyIfPid: 42)
            XCTAssertNil(try readHeartbeat(db: conn))
        }
    }

    func testHeartbeatLabels() {
        var settings = LockinSettings()
        settings.cloudEngine = .codex
        XCTAssertEqual(heartbeatProviderLabel(settings), "ChatGPT Codex")
        settings.mode = .local
        XCTAssertEqual(heartbeatProviderLabel(settings), "On this computer")
        settings.mode = AppMode(rawValue: "future") ?? .auto
        XCTAssertNil(heartbeatProviderLabel(settings))
        XCTAssertNil(Heartbeat.parse("5"))
        XCTAssertEqual(Heartbeat.parse(#"{"pid":3}"#)?.isAlive(), false)
    }
}
