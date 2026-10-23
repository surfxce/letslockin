import AVFoundation
import LockinKit
import MediaPlayer
import SwiftUI

/// The English voices on this iPhone worth listening to, best first. Novelty voices
/// (the joke ones) are never offered; Premium and Enhanced voices, which can be
/// downloaded free in iOS Settings, come before the built-in compact ones.
enum Voices {
    static let chosenKey = "voiceIdentifier"

    static func english() -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") && !$0.voiceTraits.contains(.isNoveltyVoice) }
            .sorted { a, b in
                a.quality.rawValue != b.quality.rawValue ? a.quality.rawValue > b.quality.rawValue : a.name < b.name
            }
    }

    /// The voice chosen, if it's still installed, else the best English one, this region's first.
    static func current() -> AVSpeechSynthesisVoice? {
        if let id = UserDefaults.standard.string(forKey: chosenKey), let voice = AVSpeechSynthesisVoice(identifier: id) { return voice }
        let voices = english()
        guard let top = voices.first?.quality else { return AVSpeechSynthesisVoice(language: "en-GB") }
        let region = Locale.current.region?.identifier ?? ""
        return voices.first { $0.quality == top && $0.language.hasSuffix(region) } ?? voices.first
    }

    static func label(_ voice: AVSpeechSynthesisVoice) -> String {
        let quality = voice.quality == .premium ? " · Premium" : voice.quality == .enhanced ? " · Enhanced" : ""
        return "\(voice.name) (\(voice.language))\(quality)"
    }
}

/// Reads aloud: one line at a time for the viva examiner, or a summary section by section
/// for listening — on, with the screen locked, with the lock screen's controls.
@MainActor
@Observable
final class Reader: NSObject, AVSpeechSynthesizerDelegate {
    /// What's being read, by section, and from which lecture.
    private(set) var sections: [ReadableSection] = []
    private(set) var title = ""
    private(set) var source: String?
    private(set) var index = 0
    private(set) var playing = false
    /// 1 is normal speed.
    private(set) var speed: Double = UserDefaults.standard.object(forKey: "readingSpeed") as? Double ?? 1

    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var current: ObjectIdentifier?
    @ObservationIgnored private var commandsReady = false

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    private func utterance(_ text: String) -> AVSpeechUtterance {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Voices.current()
        // The rate scale isn't linear in speed; this keeps 1.5x listenable rather than a gabble.
        utterance.rate = Float(min(Double(AVSpeechUtteranceMaximumSpeechRate), Double(AVSpeechUtteranceDefaultSpeechRate) * (0.7 + 0.3 * speed)))
        utterance.postUtteranceDelay = 0.25
        return utterance
    }

    /// One line, said now: what the viva examiner says. Stops any listening.
    func say(_ text: String) {
        stop()
        try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let line = utterance(text)
        current = ObjectIdentifier(line)
        synthesizer.speak(line)
    }

    /// Reads a summary from a section on.
    func read(_ sections: [ReadableSection], title: String, source: String, from start: Int = 0) {
        stop()
        guard !sections.isEmpty else { return }
        self.sections = sections
        self.title = title
        self.source = source
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        setUpCommands()
        speak(min(max(0, start), sections.count - 1))
    }

    private func speak(_ i: Int) {
        index = i
        synthesizer.stopSpeaking(at: .immediate)
        let section = sections[i]
        let line = utterance("\(section.heading). \(section.text)")
        current = ObjectIdentifier(line)
        synthesizer.speak(line)
        playing = true
        updateNowPlaying()
    }

    func toggle() {
        if synthesizer.isPaused {
            synthesizer.continueSpeaking()
            playing = true
        } else if synthesizer.isSpeaking {
            synthesizer.pauseSpeaking(at: .word)
            playing = false
        } else if !sections.isEmpty {
            speak(index)
        }
        updateNowPlaying()
    }

    func next() { if index + 1 < sections.count { speak(index + 1) } }

    /// Back to the start of this section, or the one before if it's only just begun.
    func previous() { speak(max(0, index - 1)) }

    /// A new speed, kept for next time; the section being read starts again at it.
    func setSpeed(_ value: Double) {
        speed = value
        UserDefaults.standard.set(value, forKey: "readingSpeed")
        if playing { speak(index) }
    }

    func stop() {
        current = nil
        synthesizer.stopSpeaking(at: .immediate)
        playing = false
        sections = []
        source = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func finished(_ id: ObjectIdentifier) {
        guard id == current, !sections.isEmpty else { return }
        if index + 1 < sections.count {
            speak(index + 1)
        } else {
            playing = false
            current = nil
            updateNowPlaying()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor in self.finished(id) }
    }

    private func updateNowPlaying() {
        guard !sections.isEmpty else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: sections[index].heading,
            MPMediaItemPropertyArtist: title,
            MPMediaItemPropertyAlbumTitle: "Lockin",
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyChapterNumber: index,
            MPNowPlayingInfoPropertyChapterCount: sections.count,
        ]
    }

    private func setUpCommands() {
        guard !commandsReady else { return }
        commandsReady = true
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in if self?.playing == false { self?.toggle() } }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in if self?.playing == true { self?.toggle() } }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.toggle() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.next() }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.previous() }
            return .success
        }
    }
}

/// Choosing the voice, with where to get better ones.
struct VoiceMenu: View {
    @AppStorage(Voices.chosenKey) private var chosen = ""

    var body: some View {
        Menu {
            Picker("Voice", selection: $chosen) {
                Text("Best available").tag("")
                ForEach(Voices.english(), id: \.identifier) { voice in
                    Text(Voices.label(voice)).tag(voice.identifier)
                }
            }
            Divider()
            Text("Better voices: Settings → Accessibility → Spoken Content → Voices → English → download a Premium one")
        } label: {
            Label("Voice", systemImage: "person.wave.2")
        }
    }
}

/// Listening to a lecture's summary: the section being read, and the controls.
struct ListenBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let reader = model.reader
        if !reader.sections.isEmpty {
            VStack(spacing: 8) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(reader.sections[reader.index].heading).font(.callout.weight(.semibold)).lineLimit(1)
                        Text("Part \(reader.index + 1) of \(reader.sections.count)").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { reader.stop() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Stop listening")
                }
                HStack(spacing: 28) {
                    Menu {
                        Picker("Speed", selection: Binding(get: { reader.speed }, set: { reader.setSpeed($0) })) {
                            ForEach([0.8, 1.0, 1.25, 1.5, 1.75], id: \.self) { Text(String(format: "%gx", $0)).tag($0) }
                        }
                    } label: {
                        Text(String(format: "%gx", reader.speed)).font(.callout.monospacedDigit())
                    }
                    Button { reader.previous() } label: { Image(systemName: "backward.fill") }
                        .accessibilityLabel("Previous part")
                    Button { reader.toggle() } label: {
                        Image(systemName: reader.playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 40))
                    }
                    .accessibilityLabel(reader.playing ? "Pause" : "Play")
                    Button { reader.next() } label: { Image(systemName: "forward.fill") }
                        .accessibilityLabel("Next part")
                    VoiceMenu().labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
            }
            .padding()
            .background(.bar)
        }
    }
}
