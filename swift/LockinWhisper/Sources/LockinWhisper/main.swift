import AudioToolbox
import AVFoundation
import Foundation
import TTSKit
import WhisperKit

// lockin-whisper: one command per run, JSON lines out.
//
//   lockin-whisper audio <recording> <out-dir> [--part-minutes 20]
//     The recording's sound as small AAC parts, cut where it's quiet:
//     {"parts":[{"path":…,"start":seconds,"duration":seconds}],"duration":seconds}
//
//   lockin-whisper transcribe <recording> --model <variant> --models <dir> [--prompt <words>] [--language en]
//     What was said, with times: {"segments":[{"start":…,"end":…,"text":…}],"duration":…,"model":…}
//
//   lockin-whisper voice-download --models <dir> [--variant 0.6b|1.7b]
//     Downloads a natural voice (Qwen3-TTS CustomVoice: 0.6B about 1 GB, 1.7B about
//     2.2 GB) and its tokenizer once: {"folder":…}
//
//   lockin-whisper speak --models <dir> [--variant 0.6b|1.7b]
//     Stays running: each line in, {"id":…,"text":…,"voice":"aiden","instruction":…}, is
//     spoken into a WAV file: {"id":…,"path":…,"duration":…} or {"id":…,"error":…}. Says
//     {"ready":true} first. Only the 1.7B model follows a speaking-style instruction.
//
// Along the way: {"stage":"download"|"load"|"read"|"transcribe","progress":0…1}.
// On failure: {"error":"…"} and exit code 1.

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

let rate = 16_000

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

var lastProgress: [String: Double] = [:]
/// Progress, at most every whole percent per stage.
func progress(_ stage: String, _ fraction: Double) {
    let rounded = (min(1, max(0, fraction)) * 100).rounded() / 100
    if lastProgress[stage] == rounded { return }
    lastProgress[stage] = rounded
    emit(["stage": stage, "progress": rounded])
}

/// The recording's sound as 16 kHz mono samples, from any file AVFoundation opens: a
/// video's sound track as readily as an audio file.
func readSound(_ url: URL) async throws -> [Float] {
    let asset = AVURLAsset(url: url)
    let tracks = try await asset.loadTracks(withMediaType: .audio)
    guard let track = tracks.first else { throw Failure("This file has no sound in it.") }
    let duration = try await asset.load(.duration).seconds
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: rate,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ])
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw Failure("Couldn't read this file's sound.") }
    reader.add(output)
    guard reader.startReading() else {
        throw Failure("Couldn't read this file's sound: \(reader.error?.localizedDescription ?? "unknown reason").")
    }
    var samples: [Float] = []
    if duration.isFinite, duration > 0 { samples.reserveCapacity(Int(duration * Double(rate)) + rate) }
    while let buffer = output.copyNextSampleBuffer() {
        guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
        let length = CMBlockBufferGetDataLength(block)
        let count = length / MemoryLayout<Float>.size
        guard count > 0 else { continue }
        let start = samples.count
        samples.append(contentsOf: repeatElement(0, count: count))
        samples.withUnsafeMutableBytes { raw in
            _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: count * MemoryLayout<Float>.size,
                                           destination: raw.baseAddress!.advanced(by: start * MemoryLayout<Float>.size))
        }
        if duration.isFinite, duration > 0 { progress("read", Double(samples.count) / (duration * Double(rate))) }
    }
    if reader.status == .failed {
        throw Failure("Couldn't read this file's sound: \(reader.error?.localizedDescription ?? "unknown reason").")
    }
    guard !samples.isEmpty else { throw Failure("This file has no sound in it.") }
    progress("read", 1)
    return samples
}

/// Where to cut the sound into parts of about `seconds` each: at the quietest tenth of a
/// second within fifteen seconds of each mark, so no word is cut in half.
func cuts(_ samples: [Float], every seconds: Double) -> [Int] {
    let step = Int(seconds * Double(rate))
    let frame = rate / 10
    let reach = 15 * rate
    var result = [0]
    var target = step
    // A last part shorter than a minute joins the one before it.
    while target + rate * 60 < samples.count {
        let low = max(result.last! + rate * 60, target - reach)
        let high = min(samples.count - frame, target + reach)
        var best = target
        var quietest = Float.greatestFiniteMagnitude
        var i = low
        while i < high {
            var energy: Float = 0
            for s in samples[i..<(i + frame)] { energy += s * s }
            if energy < quietest {
                quietest = energy
                best = i + frame / 2
            }
            i += frame
        }
        result.append(best)
        target = best + step
    }
    return result
}

/// Writes samples as an AAC file with ADTS headers (".aac"), which audio AIs accept.
func writeAAC(_ samples: ArraySlice<Float>, to url: URL) throws {
    var fileFormat = AudioStreamBasicDescription(
        mSampleRate: Float64(rate), mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0, mBytesPerPacket: 0,
        mFramesPerPacket: 1024, mBytesPerFrame: 0, mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
    var clientFormat = AudioStreamBasicDescription(
        mSampleRate: Float64(rate), mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 4,
        mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
    var file: ExtAudioFileRef?
    var status = ExtAudioFileCreateWithURL(url as CFURL, kAudioFileAAC_ADTSType, &fileFormat, nil,
                                           AudioFileFlags.eraseFile.rawValue, &file)
    guard status == noErr, let file else { throw Failure("Couldn't write the sound out (\(status)).") }
    defer { ExtAudioFileDispose(file) }
    status = ExtAudioFileSetProperty(file, kExtAudioFileProperty_ClientDataFormat,
                                     UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &clientFormat)
    guard status == noErr else { throw Failure("Couldn't write the sound out (\(status)).") }
    // Speech needs little: about 32 kbps keeps an hour near 15 MB. Best effort.
    var converter: AudioConverterRef?
    var size = UInt32(MemoryLayout<AudioConverterRef?>.size)
    if ExtAudioFileGetProperty(file, kExtAudioFileProperty_AudioConverter, &size, &converter) == noErr, let converter {
        var bitrate: UInt32 = 32_000
        if AudioConverterSetProperty(converter, kAudioConverterEncodeBitRate, UInt32(MemoryLayout<UInt32>.size), &bitrate) == noErr {
            var config: CFPropertyList?
            _ = ExtAudioFileSetProperty(file, kExtAudioFileProperty_ConverterConfig,
                                        UInt32(MemoryLayout<CFPropertyList?>.size), &config)
        }
    }
    var index = samples.startIndex
    while index < samples.endIndex {
        let end = min(index + rate, samples.endIndex)
        var chunk = Array(samples[index..<end])
        let frames = UInt32(chunk.count)
        let written: OSStatus = chunk.withUnsafeMutableBytes { raw in
            var list = AudioBufferList(
                mNumberBuffers: 1,
                mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: frames * 4, mData: raw.baseAddress))
            return ExtAudioFileWrite(file, frames, &list)
        }
        guard written == noErr else { throw Failure("Couldn't write the sound out (\(written)).") }
        index = end
    }
}

func audio(_ input: URL, _ outDir: URL, partMinutes: Double) async throws {
    let samples = try await readSound(input)
    try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    let starts = cuts(samples, every: partMinutes * 60)
    var parts: [[String: Any]] = []
    for (n, start) in starts.enumerated() {
        let end = n + 1 < starts.count ? starts[n + 1] : samples.count
        let url = outDir.appendingPathComponent("part-\(n + 1).aac")
        try writeAAC(samples[start..<end], to: url)
        parts.append(["path": url.path, "start": Double(start) / Double(rate), "duration": Double(end - start) / Double(rate)])
        progress("write", Double(n + 1) / Double(starts.count))
    }
    emit(["parts": parts, "duration": Double(samples.count) / Double(rate)])
}

/// The model's folder, downloaded the first time (about 0.2–0.6 GB) and found on disk after.
func modelFolder(_ variant: String, _ models: URL) async throws -> URL {
    let local = models.appendingPathComponent("models/argmaxinc/whisperkit-coreml/\(variant)")
    if FileManager.default.fileExists(atPath: local.appendingPathComponent("TextDecoder.mlmodelc").path),
       FileManager.default.fileExists(atPath: local.appendingPathComponent("AudioEncoder.mlmodelc").path) {
        return local
    }
    progress("download", 0)
    let folder = try await WhisperKit.download(variant: variant, downloadBase: models) { p in
        progress("download", p.fractionCompleted)
    }
    progress("download", 1)
    return folder
}

func transcribe(_ input: URL, variant: String, models: URL, prompt: String?, language: String) async throws {
    let folder = try await modelFolder(variant, models)
    progress("load", 0)
    let config = WhisperKitConfig(modelFolder: folder.path, tokenizerFolder: models, verbose: false, logLevel: .error,
                                  prewarm: false, load: true, download: false)
    let whisper = try await WhisperKit(config)
    progress("load", 1)
    let samples = try await readSound(input)

    var options = DecodingOptions()
    options.language = language
    options.chunkingStrategy = .vad
    // A few words from the slides help it spell the technical ones.
    if let prompt, !prompt.isEmpty, let tokenizer = whisper.tokenizer {
        let tokens = tokenizer.encode(text: " " + prompt).filter { $0 < tokenizer.specialTokens.specialTokenBegin }
        if !tokens.isEmpty { options.promptTokens = Array(tokens.suffix(120)) }
    }

    // Five minutes at a time, cut where it's quiet, so progress can be told as it goes.
    let starts = cuts(samples, every: 300)
    var segments: [[String: Any]] = []
    progress("transcribe", 0)
    for (n, start) in starts.enumerated() {
        let end = n + 1 < starts.count ? starts[n + 1] : samples.count
        let offset = Double(start) / Double(rate)
        let results = try await whisper.transcribe(audioArray: Array(samples[start..<end]), decodeOptions: options)
        for result in results {
            for segment in result.segments {
                let text = cleanSegment(segment.text)
                if text.isEmpty { continue }
                segments.append(["start": offset + Double(segment.start), "end": offset + Double(segment.end), "text": text])
            }
        }
        progress("transcribe", Double(end) / Double(samples.count))
    }
    emit(["segments": segments, "duration": Double(samples.count) / Double(rate), "model": variant])
}

/// Whisper's own markers ("<|0.00|>", "[BLANK_AUDIO]") are not speech.
func cleanSegment(_ text: String) -> String {
    var out = text.replacingOccurrences(of: #"<\|[^|]*\|>"#, with: "", options: .regularExpression)
    out = out.replacingOccurrences(of: #"\[(BLANK_AUDIO|MUSIC|NO_SPEECH)\]"#, with: "", options: [.regularExpression, .caseInsensitive])
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Which Qwen3-TTS model: 0.6B unless 1.7B is asked for.
func voiceVariant(_ args: [String]) -> TTSModelVariant {
    option(args, "--variant") == "1.7b" ? .qwen3TTS_1_7b : .qwen3TTS_0_6b
}

/// Where a natural voice's model went, once downloaded: the 0.6B keeps the name it
/// always had, so a voice downloaded before still counts.
func voiceMarker(_ models: URL, _ variant: TTSModelVariant) -> URL {
    models.appendingPathComponent(variant == .qwen3TTS_0_6b ? "ready.json" : "ready-\(variant.rawValue).json")
}

/// The voice model's tokenizer, kept beside it. TTSKit looks for tokenizer.json in the
/// folder it's given; without one it takes the folder for a Hugging Face repo name and
/// fails, so the files are fetched here once instead.
func ensureTokenizer(_ models: URL) async throws -> URL {
    let folder = models.appendingPathComponent("tokenizer", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    for name in ["tokenizer.json", "tokenizer_config.json", "config.json"] {
        let file = folder.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: file.path) { continue }
        guard let url = URL(string: "https://huggingface.co/Qwen/Qwen3-0.6B/resolve/main/\(name)") else { continue }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else {
            throw Failure("Couldn't download the natural voice's \(name) (\((response as? HTTPURLResponse)?.statusCode ?? 0)).")
        }
        try data.write(to: file, options: .atomic)
    }
    return folder
}

func voiceDownload(_ models: URL, _ variant: TTSModelVariant) async throws {
    try FileManager.default.createDirectory(at: models, withIntermediateDirectories: true)
    progress("download", 0)
    let folder = try await TTSKit.download(variant: variant, downloadBase: models) { p in
        progress("download", p.fractionCompleted * 0.98)
    }
    let tokenizer = try await ensureTokenizer(models)
    progress("download", 1)
    let marker = try JSONSerialization.data(withJSONObject: ["folder": folder.path, "tokenizer": tokenizer.path])
    try marker.write(to: voiceMarker(models, variant), options: .atomic)
    emit(["folder": folder.path])
}

func speakServer(_ models: URL, _ variant: TTSModelVariant) async throws {
    guard let data = try? Data(contentsOf: voiceMarker(models, variant)),
          let marker = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let path = marker["folder"] as? String
    else { throw Failure("The natural voice hasn't been downloaded yet.") }
    guard FileManager.default.fileExists(atPath: path) else {
        throw Failure("The natural voice's files are missing — download it again in Settings → Viva voice.")
    }
    progress("load", 0)
    // A voice downloaded before the tokenizer was kept with it fetches it now, once.
    let tokenizer = try await ensureTokenizer(models)
    let config = TTSKitConfig(model: variant, modelFolder: URL(fileURLWithPath: path), downloadBase: models,
                              tokenizerFolder: tokenizer, verbose: false, logLevel: .error, download: false)
    let tts: TTSKit
    do {
        tts = try await SteadyTTS(config)
    } catch {
        throw Failure("The natural voice couldn't load: \(error.localizedDescription)")
    }
    // A first, short line warms it up, so the examiner's first question isn't slow.
    _ = try? await tts.generate(text: "Ready.", speaker: .aiden, language: .english, options: steadyOptions())
    progress("load", 1)
    emit(["ready": true])
    let out = FileManager.default.temporaryDirectory.appendingPathComponent("lockin-voice", isDirectory: true)
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    while let line = readLine() {
        guard let request = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let id = request["id"] as? String, let text = request["text"] as? String
        else { continue }
        let speaker = Qwen3Speaker(rawValue: (request["voice"] as? String) ?? "aiden") ?? .aiden
        var options = steadyOptions()
        if variant.supportsVoiceDirection, let style = request["instruction"] as? String, !style.isEmpty {
            options.instruction = String(style.prefix(300))
        }
        do {
            let result = try await tts.generate(text: String(text.prefix(2000)), speaker: speaker, language: .english, options: options)
            let file = try await AudioOutput.saveAudio(result.audio, toFolder: out, filename: "say-\(id)", sampleRate: result.sampleRate, format: .wav)
            emit(["id": id, "path": file.path, "duration": result.audioDuration])
        } catch {
            emit(["id": id, "error": error.localizedDescription])
        }
    }
}

func option(_ args: [String], _ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let args = Array(CommandLine.arguments.dropFirst())
do {
    switch args.first {
    case "audio" where args.count >= 3:
        let minutes = Double(option(args, "--part-minutes") ?? "") ?? 20
        try await audio(URL(fileURLWithPath: args[1]), URL(fileURLWithPath: args[2]), partMinutes: max(1, minutes))
    case "transcribe" where args.count >= 2:
        guard let variant = option(args, "--model"), let models = option(args, "--models") else {
            throw Failure("transcribe needs --model and --models")
        }
        try await transcribe(URL(fileURLWithPath: args[1]), variant: variant, models: URL(fileURLWithPath: models),
                             prompt: option(args, "--prompt"), language: option(args, "--language") ?? "en")
    case "voice-download":
        guard let models = option(args, "--models") else { throw Failure("voice-download needs --models") }
        try await voiceDownload(URL(fileURLWithPath: models), voiceVariant(args))
    case "speak":
        guard let models = option(args, "--models") else { throw Failure("speak needs --models") }
        try await speakServer(URL(fileURLWithPath: models), voiceVariant(args))
    case "version":
        emit(["version": 4, "voice": true, "variants": ["0.6b", "1.7b"], "steady": true])
    default:
        throw Failure("usage: lockin-whisper audio <recording> <out-dir> | transcribe <recording> --model <variant> --models <dir>")
    }
    exit(0)
} catch {
    emit(["error": (error as? Failure)?.description ?? error.localizedDescription])
    exit(1)
}
