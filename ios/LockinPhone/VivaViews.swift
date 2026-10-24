import AVFoundation
import LockinKit
import Speech
import SwiftUI

/// Speech to text with Apple's recogniser, on the phone where it can be, with the lecture's
/// technical words as hints.
@MainActor
@Observable
final class Dictation {
    private(set) var listening = false
    /// What has been heard so far in this go.
    private(set) var text = ""
    private(set) var problem: String?
    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-GB")) ?? SFSpeechRecognizer()

    func start(hints: [String]) async {
        problem = nil
        let speech = await withCheckedContinuation { (done: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
        }
        guard speech == .authorized else {
            problem = "Lockin isn't allowed to recognise speech. Turn it on in Settings → Lockin."
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            problem = "Lockin isn't allowed to use the microphone. Turn it on in Settings → Lockin."
            return
        }
        guard let recognizer, recognizer.isAvailable else {
            problem = "Speech recognition isn't available right now. Type your answer instead."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            problem = "The microphone couldn't be opened."
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.contextualStrings = Array(hints.prefix(100))
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        self.request = request
        text = ""
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0), block: Self.feed(request))
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            problem = "The microphone couldn't be opened."
            return
        }
        listening = true
        task = recognizer.recognitionTask(with: request, resultHandler: Self.listener(self))
    }

    // Built outside the main actor: the audio and the results arrive on other threads.
    private nonisolated static func feed(_ request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        { buffer, _ in request.append(buffer) }
    }

    private nonisolated static func listener(_ owner: Dictation) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { [weak owner] result, error in
            let heard = result?.bestTranscription.formattedString
            let over = error != nil || (result?.isFinal ?? false)
            guard let owner else { return }
            Task { @MainActor in owner.heard(heard, over: over) }
        }
    }

    private func heard(_ words: String?, over: Bool) {
        if let words { text = words }
        if over { stopAudio() }
    }

    /// Stops listening; the last words still arrive in `text`.
    func stop() {
        request?.endAudio()
        stopAudio()
    }

    private func stopAudio() {
        guard listening else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        listening = false
    }
}

/// Choosing which lectures a viva asks about, and how many questions.
struct VivaSetupView: View {
    @Environment(AppModel.self) private var model
    @State private var chosen: Set<String>?
    @State private var count = 5
    @State private var focus = ExamFocus.mixed
    @State private var started = false

    var body: some View {
        if started {
            VivaRoomView()
        } else if let source = model.examSource {
            let usable = model.courses.flatMap { model.lectures(in: $0.id) }.filter { !source.laqs(of: $0).isEmpty }
            let selected = chosen ?? Set(usable.map(\.id))
            Form {
                Section {
                    Picker("Questions", selection: $count) {
                        ForEach([3, 5, 8], id: \.self) { Text("\($0)").tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Picker("Which questions", selection: $focus) {
                        ForEach(ExamFocus.allCases) { Text($0.label).tag($0) }
                    }
                } footer: {
                    Text("The examiner asks one of your LAQs, listens, and follows up on anything you left out — then moves on. About \(count * 4)–\(count * 6) minutes.")
                }
                ForEach(model.courses) { course in
                    let lectures = model.lectures(in: course.id).filter { lecture in usable.contains { $0.id == lecture.id } }
                    if !lectures.isEmpty {
                        Section(course.code) {
                            Toggle(isOn: Binding(
                                get: { lectures.allSatisfy { selected.contains($0.id) } },
                                set: { on in
                                    var next = selected
                                    for l in lectures { if on { next.insert(l.id) } else { next.remove(l.id) } }
                                    chosen = next
                                }
                            )) {
                                Text("All of \(course.code)").font(.body.weight(.semibold))
                            }
                            ForEach(lectures) { lecture in
                                Toggle(isOn: Binding(
                                    get: { selected.contains(lecture.id) },
                                    set: { on in
                                        var next = selected
                                        if on { next.insert(lecture.id) } else { next.remove(lecture.id) }
                                        chosen = next
                                    }
                                )) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("L\(lecture.ordinal) · \(lecture.title)").lineLimit(2)
                                        Text("\(source.laqs(of: lecture).count) LAQs").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
                Section {
                    Button {
                        if model.startViva(lectureIds: selected, questions: count, focus: focus) { started = true }
                    } label: {
                        Label("Start the viva", systemImage: "mic.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selected.isEmpty)
                } footer: {
                    Text(model.examinerNote)
                }
            }
            .navigationTitle("New viva")
            .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("Sync first", systemImage: "arrow.triangle.2.circlepath",
                                   description: Text("Vivas are set from your lectures as last synced."))
        }
    }
}

private struct VivaBubble: View {
    let line: VivaLine
    let replay: (String) -> Void

    var body: some View {
        let examiner = line.role == "examiner"
        HStack {
            if !examiner { Spacer(minLength: 40) }
            VStack(alignment: examiner ? .leading : .trailing, spacing: 3) {
                Text(examiner ? "Examiner" : "You").font(.caption2).foregroundStyle(.secondary)
                HStack(alignment: .top, spacing: 6) {
                    Text(line.text).font(.body)
                    if examiner {
                        Button { replay(line.text) } label: { Image(systemName: "speaker.wave.2") }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Hear it again")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(examiner ? Color(.secondarySystemBackground) : Color.lockinAccent.opacity(0.15),
                            in: RoundedRectangle(cornerRadius: 14))
            }
            if examiner { Spacer(minLength: 40) }
        }
    }
}

/// The viva itself: the examiner's lines, read aloud, and your answers, spoken or typed.
struct VivaRoomView: View {
    @Environment(AppModel.self) private var model
    @State private var answer = ""
    @State private var before = ""
    @State private var dictation = Dictation()
    @AppStorage("vivaReadAloud") private var readAloud = true
    @State private var finished: String?
    @State private var confirmingEnd = false
    @State private var spoken = 0
    @FocusState private var typing: Bool

    var body: some View {
        Group {
            if let finished {
                VivaResultView(vivaId: finished)
            } else if let draft = model.vivaDraft {
                room(draft)
            } else {
                ContentUnavailableView("No viva open", systemImage: "mic.slash", description: Text("Start one from the Exam tab."))
            }
        }
        .onChange(of: model.vivaDraft?.id) { old, new in
            if let old, new == nil, model.pastViva(old) != nil { finished = old }
        }
        .onDisappear {
            model.reader.stop()
            dictation.stop()
        }
    }

    private func hints(_ draft: VivaDraft) -> [String] {
        guard let item = draft.item, let question = model.question(item.questionId) else { return [] }
        let words = (question.stem + " " + (question.modelAnswer ?? "") + " " + question.criteria.map(\.point).joined(separator: " "))
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "-" })
            .map(String.init)
            .filter { $0.count >= 6 || $0.contains(where: \.isNumber) || $0.dropFirst().contains(where: \.isUppercase) }
        var seen = Set<String>()
        return words.filter { seen.insert($0.lowercased()).inserted }
    }

    /// Reads out what the examiner has just said — all of it, when a case's findings and
    /// its next question come together.
    private func speakNew(_ draft: VivaDraft) {
        defer { spoken = draft.turns.count }
        guard readAloud, draft.turns.count > spoken, let last = draft.turns.last, last.role == "examiner" else { return }
        let fresh = draft.turns.suffix(from: min(spoken, draft.turns.count))
        let from = fresh.lastIndex { $0.role == "student" }.map { $0 + 1 } ?? fresh.startIndex
        model.reader.say(draft.turns[from...].map(\.text).joined(separator: " "))
    }

    private func heading(_ draft: VivaDraft) -> String {
        let n = min(draft.current + 1, draft.plan.count)
        guard draft.caseId != nil else { return "Question \(n) of \(draft.plan.count)" }
        return "Stage \(n) of \(draft.plan.count)" + (draft.step.map { " · \(stageLabel($0.kind))" } ?? "")
    }

    private func room(_ draft: VivaDraft) -> some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(draft.turns.enumerated()), id: \.offset) { _, line in
                            VivaBubble(line: line) { model.reader.say($0) }
                        }
                        if model.examinerThinking {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("The examiner is thinking…").font(.callout).foregroundStyle(.secondary)
                            }
                        }
                        if let note = model.vivaNote {
                            Text(note).font(.caption).foregroundStyle(.secondary)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding()
                }
                .onChange(of: draft.turns.count) {
                    withAnimation { proxy.scrollTo("end") }
                    speakNew(draft)
                }
                .onChange(of: model.examinerThinking) { withAnimation { proxy.scrollTo("end") } }
                .onAppear {
                    proxy.scrollTo("end")
                    speakNew(draft)
                }
            }
            Divider()
            VStack(spacing: 10) {
                TextField(dictation.listening ? "Listening…" : "Your answer…", text: $answer, axis: .vertical)
                    .lineLimit(2...6)
                    .textFieldStyle(.roundedBorder)
                    .focused($typing)
                    .disabled(model.examinerThinking)
                if let problem = dictation.problem {
                    Text(problem).font(.caption).foregroundStyle(.red)
                }
                HStack(spacing: 12) {
                    Button {
                        if dictation.listening {
                            dictation.stop()
                        } else {
                            model.reader.stop()
                            typing = false
                            before = answer
                            Task { await dictation.start(hints: hints(draft)) }
                        }
                    } label: {
                        Image(systemName: dictation.listening ? "stop.fill" : "mic.fill")
                            .font(.title2)
                            .frame(width: 56, height: 56)
                            .foregroundStyle(dictation.listening ? .white : .primary)
                            .background(dictation.listening ? Color.red : Color(.secondarySystemBackground), in: Circle())
                    }
                    .disabled(model.examinerThinking)
                    .accessibilityLabel(dictation.listening ? "Stop listening" : "Answer out loud")
                    Button("Send") {
                        dictation.stop()
                        let text = answer
                        answer = ""
                        before = ""
                        Task { await model.answerViva(text) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.examinerThinking || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Spacer()
                    Button(draft.item.map { item in draft.exchange(item.questionId).contains { $0.role == "student" } } == true ? "Move on" : "Skip") {
                        dictation.stop()
                        answer = ""
                        before = ""
                        model.skipVivaQuestion()
                    }
                    .disabled(model.examinerThinking)
                }
            }
            .padding()
            .onChange(of: dictation.text) { _, heard in
                answer = [before.trimmingCharacters(in: .whitespacesAndNewlines), heard].filter { !$0.isEmpty }.joined(separator: " ")
            }
        }
        .navigationTitle(heading(draft))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    readAloud.toggle()
                    if !readAloud { model.reader.stop() }
                } label: {
                    Image(systemName: readAloud ? "speaker.wave.2.fill" : "speaker.slash")
                }
                .accessibilityLabel(readAloud ? "Reading aloud" : "Not reading aloud")
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack {
                    VoiceMenu().labelStyle(.iconOnly)
                    Button("End") { confirmingEnd = true }
                }
            }
        }
        .confirmationDialog(draft.caseId == nil ? "End the viva now?" : "End the case now?", isPresented: $confirmingEnd, titleVisibility: .visible) {
            Button("End and mark what I answered") {
                dictation.stop()
                model.reader.stop()
                model.endViva()
            }
            Button("Discard it", role: .destructive) {
                dictation.stop()
                model.reader.stop()
                model.discardViva()
            }
        }
    }
}

/// A viva held on the phone: what was said, and each answer's mark once marked.
struct VivaResultView: View {
    @Environment(AppModel.self) private var model
    let vivaId: String

    var body: some View {
        if let viva = model.pastViva(vivaId) {
            List {
                ForEach(Array(viva.plan.enumerated()), id: \.offset) { index, item in
                    let mark = mark(of: item, in: viva)
                    let stage = caseStage(item, in: viva)
                    Section {
                        if let stage {
                            Text(stage.ask).font(.body.weight(.medium))
                        } else if let question = model.question(item.questionId) {
                            Text(question.stem).font(.body.weight(.medium))
                        }
                        ForEach(Array(viva.turns.filter { $0.questionId == item.questionId }.dropFirst().enumerated()), id: \.offset) { _, line in
                            Text("\(line.role == "examiner" ? "Examiner" : "You"): \(line.text)")
                                .font(.callout)
                                .foregroundStyle(line.role == "examiner" ? .secondary : .primary)
                        }
                    } header: {
                        HStack {
                            Text(verbatim: header(index, stage: stage, isCase: viva.caseId != nil))
                            Spacer()
                            if let mark {
                                Text("\(formatMark(mark)) / 10").monospacedDigit()
                            } else {
                                Text("Marking…")
                            }
                        }
                    }
                }
            }
            .navigationTitle(viva.title)
            .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("Not on this phone", systemImage: "mic.slash")
        }
    }

    private func caseStage(_ item: VivaPlanItem, in viva: PhoneViva) -> PhoneCaseStage? {
        guard let caseId = viva.caseId, let found = model.clinicalCase(caseId) else { return nil }
        return found.stages.first(where: { $0.question.id == item.questionId })
    }

    private func header(_ index: Int, stage: PhoneCaseStage?, isCase: Bool) -> String {
        guard isCase else { return "Question \(index + 1)" }
        guard let stage else { return "Stage \(index + 1)" }
        return "Stage \(index + 1) · \(stageLabel(stage.kind))"
    }

    private func mark(of item: VivaPlanItem, in viva: PhoneViva) -> Double? {
        guard let responseId = item.responseId,
              let sitting = viva.sittings.first(where: { s in s.responses.contains { $0.id == responseId } })
        else { return nil }
        if sitting.responses.first(where: { $0.id == responseId })?.answerText.isEmpty == true { return 0 }
        return model.sittings(for: sitting.lectureId).first { $0.id == sitting.id }?.answers.first { $0.id == responseId }?.mark
    }
}

/// A clinical case: what it is, and a button to start it — or the run already open.
struct CaseStartView: View {
    @Environment(AppModel.self) private var model
    let caseId: String
    @State private var started = false

    var body: some View {
        if started || model.vivaDraft?.caseId == caseId {
            VivaRoomView()
        } else if let found = model.clinicalCase(caseId) {
            Form {
                Section {
                    Text(found.title).font(.headline)
                    Text(found.stages.map { stageLabel($0.kind) }.joined(separator: " → "))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } footer: {
                    Text("The examiner presents the patient, then asks you a stage at a time, telling you what each stage found before the next. Answer out loud or type; each stage is marked like an LAQ.")
                }
                Section {
                    Button {
                        if model.startCase(caseId) { started = true }
                    } label: {
                        Label("Start the case", systemImage: "stethoscope").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                } footer: {
                    Text(model.vivaDraft == nil ? model.examinerNote : "This replaces the viva you haven't finished. \(model.examinerNote)")
                }
            }
            .navigationTitle("Clinical case")
            .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("This case isn't here any more", systemImage: "stethoscope",
                                   description: Text("It was deleted on your computer."))
        }
    }
}
