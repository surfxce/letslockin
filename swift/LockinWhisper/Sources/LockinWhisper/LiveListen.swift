import Foundation
import WhisperKit

// lockin-whisper listen --model <variant> --models <dir> [--language en]
//   Stays running and hears spoken answers while they're said, one at a time (a new one
//   replaces any before it). Lines in:
//     {"id":…,"start":true,"prompt":"words from the slides"}
//     {"id":…,"audio":"<base64 of 16 kHz mono 16-bit little-endian PCM>"}
//     {"id":…,"end":true}
//   Lines out: {"ready":true} once Whisper is loaded; as the answer goes on,
//   {"id":…,"confirmed":…,"tentative":…} — confirmed words stay put, the tentative end may
//   still change — and after its end {"id":…,"text":…,"final":true} (or {"id":…,"error":…}).

// The same 16 kHz as main.swift's `rate`, kept apart from that file's top-level globals.
private let speechRate = WhisperKit.sampleRate

/// 16-bit little-endian PCM as samples from -1 to 1.
func pcm16(_ data: Data) -> [Float] {
    let count = data.count / 2
    var out = [Float](repeating: 0, count: count)
    data.withUnsafeBytes { raw in
        for i in 0..<count {
            out[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768
        }
    }
    return out
}

/// The answer being heard, filled from stdin on a thread of its own, so no sound is lost
/// while Whisper is busy or still loading.
final class LiveInbox: @unchecked Sendable {
    struct Answer {
        let id: String
        let prompt: String?
        var samples: [Float] = []
        var ended = false
    }

    struct Look {
        let id: String
        let prompt: String?
        let count: Int
        let ended: Bool
    }

    private let lock = NSLock()
    private var answer: Answer?
    private var closed = false

    /// Reads stdin until it closes.
    func read() {
        while let line = readLine() {
            guard let message = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let id = message["id"] as? String
            else { continue }
            let sound = (message["audio"] as? String).flatMap { Data(base64Encoded: $0) }.map(pcm16) ?? []
            lock.lock()
            if message["start"] as? Bool == true { answer = Answer(id: id, prompt: message["prompt"] as? String) }
            if answer?.id == id {
                answer!.samples.append(contentsOf: sound)
                if message["end"] as? Bool == true { answer!.ended = true }
            }
            lock.unlock()
        }
        lock.lock()
        closed = true
        lock.unlock()
    }

    /// The answer as it stands (without its sound, which isn't free to copy), and whether
    /// stdin has closed.
    func look() -> (answer: Look?, closed: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (answer.map { Look(id: $0.id, prompt: $0.prompt, count: $0.samples.count, ended: $0.ended) }, closed)
    }

    func samples(_ id: String) -> [Float]? {
        lock.lock()
        defer { lock.unlock() }
        return answer?.id == id ? answer!.samples : nil
    }

    /// Forgets an answer once it's been told, unless another has started since.
    func done(_ id: String) {
        lock.lock()
        if answer?.id == id { answer = nil }
        lock.unlock()
    }
}

/// What Whisper has made of one answer so far. Each look hears again everything after the
/// words already settled; all but the last two segments it finds are then settled too, as
/// WhisperKit's own AudioStreamTranscriber does, so what's shown early rarely changes.
struct LiveHearing {
    let id: String
    let options: DecodingOptions
    var confirmed: [String] = []
    var tentative: [String] = []
    /// Seconds into the answer the settled words reach.
    var settledTo: Float = 0
    /// How much sound there was at the last look.
    var looked = 0
    /// The quietest tenth of a second so far: the room rather than the speaker.
    var floor: Float = 1e-3

    init(id: String, language: String, prompt: [Int]?) {
        self.id = id
        var options = DecodingOptions()
        options.language = language
        options.promptTokens = prompt
        self.options = options
    }

    /// Hears the answer again with what's new; false when nothing new was said.
    mutating func update(_ samples: [Float], _ whisper: WhisperKit) async throws -> Bool {
        let from = looked
        looked = samples.count
        guard lastVoice(samples, from: from) != nil else { return false }
        let segments = try await hear(samples, whisper)
        let settle = max(0, segments.count - 2)
        if settle > 0, segments[settle - 1].end > settledTo {
            settledTo = segments[settle - 1].end
            confirmed += words(segments[..<settle])
            tentative = words(segments[settle...])
        } else {
            tentative = words(segments[...])
        }
        return true
    }

    /// The whole answer once it's over: what follows the settled words, heard once more up
    /// to the last of the speaking (silence after it is where Whisper invents things).
    mutating func finish(_ samples: [Float], _ whisper: WhisperKit) async throws -> String {
        let start = min(samples.count, Int(settledTo * Float(speechRate)))
        var rest = samples
        if let last = lastVoice(samples, from: start) { rest = Array(samples[..<min(samples.count, last + speechRate / 2)]) }
        if rest.count - start > speechRate / 4 {
            let heard = try await hear(rest, whisper)
            confirmed += words(heard[...])
        }
        tentative = []
        return confirmed.joined(separator: " ")
    }

    private func hear(_ samples: [Float], _ whisper: WhisperKit) async throws -> [TranscriptionSegment] {
        var options = self.options
        options.clipTimestamps = [settledTo]
        return try await whisper.transcribe(audioArray: samples, decodeOptions: options).flatMap(\.segments)
    }

    private func words(_ segments: ArraySlice<TranscriptionSegment>) -> [String] {
        segments.map { cleanSegment($0.text) }.filter { !$0.isEmpty }
    }

    /// Where the last tenth of a second with someone speaking in it ends, from `start` on:
    /// a tenth well above the quietest so far (WhisperKit's own measure and threshold).
    private mutating func lastVoice(_ samples: [Float], from start: Int) -> Int? {
        let frame = speechRate / 10
        var at = max(0, start)
        var last: Int?
        while at + frame <= samples.count {
            let energy = AudioProcessor.calculateAverageEnergy(of: Array(samples[at..<(at + frame)]))
            floor = max(1e-4, min(floor, energy))
            let level = 20 * log10(max(energy, 1e-8))
            let room = 20 * log10(floor)
            if (level - room) / -room > 0.3 { last = at + frame }
            at += frame
        }
        return last
    }
}

func listenServer(variant: String, models: URL, language: String) async throws {
    let inbox = LiveInbox()
    Thread { inbox.read() }.start()
    let folder = try await modelFolder(variant, models)
    progress("load", 0)
    let config = WhisperKitConfig(modelFolder: folder.path, tokenizerFolder: models, verbose: false, logLevel: .error,
                                  prewarm: false, load: true, download: false)
    let whisper = try await WhisperKit(config)
    progress("load", 1)
    emit(["ready": true])

    var hearing: LiveHearing?
    while true {
        let (look, closed) = inbox.look()
        guard let answer = look, !(closed && !answer.ended) else {
            if closed { return }
            try await Task.sleep(nanoseconds: 100_000_000)
            continue
        }
        if hearing?.id != answer.id {
            hearing = LiveHearing(id: answer.id, language: language, prompt: promptTokens(answer.prompt, whisper))
        }
        if answer.ended {
            do {
                let text = try await hearing!.finish(inbox.samples(answer.id) ?? [], whisper)
                emit(["id": answer.id, "text": text, "final": true])
            } catch {
                emit(["id": answer.id, "error": error.localizedDescription])
            }
            inbox.done(answer.id)
            hearing = nil
            continue
        }
        // Another look once there's a second more to hear, as AudioStreamTranscriber does.
        guard answer.count - hearing!.looked >= speechRate, let samples = inbox.samples(answer.id) else {
            try await Task.sleep(nanoseconds: 100_000_000)
            continue
        }
        do {
            if try await hearing!.update(samples, whisper) {
                emit(["id": answer.id, "confirmed": hearing!.confirmed.joined(separator: " "),
                      "tentative": hearing!.tentative.joined(separator: " ")])
            }
        } catch {
            emit(["id": answer.id, "error": error.localizedDescription])
        }
    }
}
