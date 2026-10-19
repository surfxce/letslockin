import AppKit
import SwiftUI
import UserNotifications
import LockinCore

// Port of app/settings/page.tsx and its parts (controls.tsx, CloudSettings.tsx,
// ModelPicker.tsx): the Settings window, reached from the app menu and from the sidebar's
// gear. Like the web page there is no save button — every change is written as it is
// made.

// MARK: - The window

struct SettingsScreen: View {
    @Bindable var store: AppStore
    @State private var detection: AppStore.AiDetection?
    @State private var showingOnboarding = false

    var body: some View {
        Form {
            Section("Summaries and LAQs") {
                ModePickerSection(store: store)
                if store.settings.mode.usesAi {
                    WorkerStatusLine(store: store)
                }
            }

            if store.settings.mode == .auto {
                CloudSettingsSection(store: store, detection: detection)
            }

            Section("LAQs") {
                LaqSettingsSection(store: store)
            }

            Section {
                ModelPickerSection(store: store)
            } header: {
                Text("Offline AI on this computer")
            } footer: {
                Text("Download a model once and Lockin works with no internet. The middle one is chosen for this computer; downloading any of them switches Lockin to it when it finishes.")
            }

            Section("Getting started") {
                Button {
                    showingOnboarding = true
                } label: {
                    Label("Repeat onboarding", systemImage: "arrow.counterclockwise")
                }
            }

            Section("Reminders") {
                RemindersSection(store: store)
            }

            Section("Courses") {
                ForEach(store.courses) { course in
                    HStack {
                        TagBadge(text: course.code, tone: tagTone(course.code))
                        Text(course.title)
                        Spacer()
                        Text("· \(plural(store.lectureRows.filter { $0.courseId == course.id }.count, "lecture"))")
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Updates") {
                UpdatesSection(store: store)
            }
        }
        .formStyle(.grouped)
        .frame(width: 620, height: 680)
        .task {
            detection = await store.detectAiTools()
        }
        .sheet(isPresented: $showingOnboarding) {
            OnboardingSheet(store: store, hasCourses: !store.courses.isEmpty, detection: detection)
        }
    }
}

// MARK: - Choosing a mode (ModePicker)

private struct ModePickerSection: View {
    @Bindable var store: AppStore
    @State private var detection: AppStore.AiDetection?

    var body: some View {
        Picker("How the AI part happens", selection: Binding(
            get: { store.settings.mode },
            set: { mode in store.updateSettings { $0.mode = mode } }
        )) {
            Text(modeTitle(.auto)).tag(AppMode.auto)
            Text(modeTitle(.local)).tag(AppMode.local)
            Text(modeTitle(.manual)).tag(AppMode.manual)
        }
        .pickerStyle(.radioGroup)
        .labelsHidden()

        ForEach(AppMode.allKnown, id: \.rawValue) { mode in
            if mode == store.settings.mode {
                Text(modeDescription(mode))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 20)
            }
        }
    }

    /// "Automatic — Claude Code" with whether it is ready, as the web page's tag says it.
    private func modeTitle(_ mode: AppMode) -> String {
        switch mode {
        case .auto:
            let ready = detection?.claude.found ?? true
            return "Automatic — \(ready ? "Claude Code" : "Claude Code not found on this computer")"
        case .local:
            let model = store.modelsSnapshot().installedInfo(forModel: store.settings.localModel ?? "")
            return "On this computer — \(model?.name ?? "no model yet")"
        case .manual:
            return "Copy & paste"
        default:
            return mode.label ?? mode.rawValue
        }
    }

    private func modeDescription(_ mode: AppMode) -> String {
        switch mode {
        case .auto:
            return "Lockin prepares lectures itself with a cloud AI — Claude Code, ChatGPT Codex, Google Antigravity or an API key, chosen below — one lecture at a time, and marks your answers."
        case .local:
            return "A model downloaded to this computer does the work: fully offline, private and free, a little slower. Pick one below."
        case .manual:
            return "No AI runs here. Each lecture has Copy prompt buttons for any AI chat, and boxes that format what you paste back."
        default:
            return ""
        }
    }
}

/// The heartbeat line the web page shows under the mode (`beat?.alive`).
private struct WorkerStatusLine: View {
    @Bindable var store: AppStore

    var body: some View {
        let alive = store.queueActivity?.worker?.alive ?? false
        HStack(alignment: .firstTextBaseline) {
            Text("AI worker")
                .font(.callout.weight(.semibold))
            Spacer()
            TagBadge(text: alive ? "Running" : "Stopped", tone: alive ? .green : .orange)
        }
        Text(alive
            ? "Running — prepares one lecture at a time, and marks answers first."
            : "Not running, so nothing queued will start. It runs with this app.")
            .font(.callout)
            .foregroundStyle(.secondary)
    }
}

// MARK: - The cloud AI (CloudSettings)

private struct CloudSettingsSection: View {
    @Bindable var store: AppStore
    let detection: AppStore.AiDetection?

    @State private var codexModel: String = ""
    @State private var agyModel: String = ""
    @State private var apiBaseUrl: String = ""
    @State private var apiModel: String = ""
    @State private var apiKeyDraft = ""
    @State private var keyNote: String?
    @State private var test: AppStore.ActionResult?
    @State private var testing = false

    var body: some View {
        Picker("Cloud AI", selection: Binding(
            get: { store.settings.cloudEngine },
            set: { engine in store.updateSettings { $0.cloudEngine = engine } }
        )) {
            ForEach(CloudEngine.allCases, id: \.self) { engine in
                Text(engine.label).tag(engine)
            }
        }
        .pickerStyle(.radioGroup)

        enginePanel

        if store.settings.mode == .auto {
            fallbackRow
        }
    }

    @ViewBuilder
    private var enginePanel: some View {
        let status = detection
        switch store.settings.cloudEngine {
        case .claude:
            toolStatus(
                found: status?.claude.found ?? true,
                version: status?.claude.version,
                name: "Claude Code",
                install: "Install it with npm i -g @anthropic-ai/claude-code, then run claude once to sign in with your Claude plan."
            )
            modelBlurb
            Picker("Claude model", selection: Binding(
                get: { store.settings.cloudModel },
                set: { model in store.updateSettings { $0.cloudModel = model } }
            )) {
                Text("Sonnet · default").tag(CloudModel.sonnet)
                Text("Opus").tag(CloudModel.opus)
                Text("Haiku").tag(CloudModel.haiku)
            }
            .pickerStyle(.segmented)
        case .codex:
            toolStatus(
                found: status?.codex.found ?? true,
                version: status?.codex.version,
                name: "Codex",
                install: "Install it with npm i -g @openai/codex, then run codex login once to sign in with your ChatGPT plan."
            )
            Text("Uses your ChatGPT plan. It sees the slides as pictures.")
                .font(.callout)
                .foregroundStyle(.secondary)
            TextSettingRow(label: "Model", initial: store.settings.codexModel, placeholder: "Codex's default", hint: "Leave empty for the model Codex is set to use.") { newValue in
                store.updateSettings { $0.codexModel = newValue }
            }
        case .antigravity:
            toolStatus(
                found: status?.antigravity.found ?? true,
                version: status?.antigravity.version,
                name: status?.antigravity.binary == "gemini" ? "Gemini CLI" : "Antigravity CLI",
                install: "Install the Antigravity CLI from antigravity.google/cli, then run agy once to sign in with your Google account. The older Gemini CLI (gemini) works too."
            )
            Text("Uses your Google account. Gemini reads the slide PDFs itself.")
                .font(.callout)
                .foregroundStyle(.secondary)
            TextSettingRow(label: "Model", initial: store.settings.agyModel, placeholder: "auto", hint: "Leave empty to let it choose.") { newValue in
                store.updateSettings { $0.agyModel = newValue }
            }
        case .api:
            apiPanel
        }

        testRow
    }

    @ViewBuilder
    private var apiPanel: some View {
        Picker("Service", selection: Binding(
            get: { store.settings.apiService },
            set: { service in store.updateSettings { $0.apiService = service } }
        )) {
            ForEach(ApiService.allCases, id: \.self) { service in
                Text(service.info.label).tag(service)
            }
        }

        if store.settings.apiService == .anthropic {
            Text("Billed per use to your Anthropic account. \(cloudModelBlurb)")
                .font(.callout)
                .foregroundStyle(.secondary)
            Picker("Claude model", selection: Binding(
                get: { store.settings.cloudModel },
                set: { model in store.updateSettings { $0.cloudModel = model } }
            )) {
                Text("Sonnet · default").tag(CloudModel.sonnet)
                Text("Opus").tag(CloudModel.opus)
                Text("Haiku").tag(CloudModel.haiku)
            }
            .pickerStyle(.segmented)
        } else {
            if store.settings.apiService == .custom {
                TextSettingRow(label: "Address", initial: store.settings.apiBaseUrl, placeholder: "http://localhost:11434/v1", hint: "Any service that speaks OpenAI's chat format — Ollama, LM Studio, a company endpoint.") { newValue in
                    store.updateSettings { $0.apiBaseUrl = newValue }
                }
            }
            TextSettingRow(label: "Model", initial: store.settings.apiModel, placeholder: "model name", hint: "Required: \(store.settings.apiService.info.modelHint).") { newValue in
                store.updateSettings { $0.apiModel = newValue }
            }
            Toggle(isOn: Binding(
                get: { store.settings.apiVision },
                set: { on in store.updateSettings { $0.apiVision = on } }
            )) {
                Text("This model can see images — it is shown the slides as pictures. Untick it for a text-only model.")
            }
        }

        keyRow
    }

    private var keyRow: some View {
        let saved = store.savedApiKeySuffix
        return HStack {
            Text("API key")
            SecureField(
                saved != nil ? "Saved (\(saved!)) — paste a new one to replace it" : "Paste your key",
                text: $apiKeyDraft
            )
            Button("Save key") {
                store.setApiKeySetting(apiKeyDraft)
                keyNote = saved == nil ? "Saved. It stays on this computer, in Lockin's own database." : "Replaced."
                apiKeyDraft = ""
            }
            .disabled(apiKeyDraft.trimmingCharacters(in: .whitespaces).isEmpty)
            if saved != nil {
                Button("Remove") {
                    store.setApiKeySetting(nil)
                    keyNote = "Removed."
                }
            }
        }
        HStack {
            Text("It stays on this computer, in Lockin's own database.")
                .font(.caption)
                .foregroundStyle(.tertiary)
            if let note = keyNote {
                Text(note).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var testRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Button {
                    testing = true
                    test = nil
                    Task {
                        let result = await store.testCloudEngine()
                        test = result
                        testing = false
                    }
                } label: {
                    Label(testing ? "Asking…" : "Test it", systemImage: "bolt")
                }
                .disabled(testing)
                if test == nil {
                    Text("Sends one tiny question, to check it is set up.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            if let test {
                Text(test.message ?? (test.ok ? "Working." : "It did not work."))
                    .font(.callout)
                    .foregroundStyle(test.ok ? Color.green : Color.red)
            }
        }
    }

    private var fallbackRow: some View {
        Toggle(isOn: Binding(
            get: { store.settings.fallbackLocal },
            set: { on in store.updateSettings { $0.fallbackLocal = on } }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text("If the cloud AI fails, use the offline model")
                let offline = store.modelsSnapshot().installedInfo(forModel: store.settings.localModel ?? "")?.name
                Text(offline != nil
                    ? "When \(store.settings.cloudEngine.label) can't do a job — signed out, over a usage limit, offline — \(offline!) on this computer does it instead. The cloud AI is always tried first."
                    : "Download an offline model below and Lockin uses it whenever \(store.settings.cloudEngine.label) can't do a job — signed out, over a usage limit, offline. The cloud AI is always tried first.")
                    .font(.callout.weight(.regular))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var cloudModelBlurb: String {
        switch store.settings.cloudModel {
        case .sonnet: return "Fast and thorough — the right size for summaries, LAQs and marking."
        case .opus: return "The most thorough, and the slowest: a lecture takes noticeably longer."
        case .haiku: return "The quickest and lightest. Fine for short lectures; less depth in summaries."
        }
    }

    @ViewBuilder
    private var modelBlurb: some View {
        Text(cloudModelBlurb)
            .font(.callout)
            .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private func toolStatus(found: Bool, version: String?, name: String, install: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            TagBadge(text: found ? "Found" : "Not found", tone: found ? .green : .red)
            if found, let version {
                Text(version)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        if !found {
            Text(install)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }
}

/// A text box that saves when you leave it or press Enter (`TextSetting`).
private struct TextSettingRow: View {
    let label: String
    let initial: String
    let placeholder: String
    let hint: String
    let onSave: (String) -> Void

    @State private var value: String
    @State private var saved: String

    init(label: String, initial: String, placeholder: String, hint: String, onSave: @escaping (String) -> Void) {
        self.label = label
        self.initial = initial
        self.placeholder = placeholder
        self.hint = hint
        self.onSave = onSave
        _value = State(initialValue: initial)
        _saved = State(initialValue: initial)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(label).frame(width: 64, alignment: .leading)
                TextField(placeholder, text: $value)
                    .onSubmit(commit)
            }
            Text(hint)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .onDisappear(perform: commit)
    }

    private func commit() {
        guard value.trimmingCharacters(in: .whitespaces) != saved.trimmingCharacters(in: .whitespaces) else { return }
        saved = value
        onSave(value)
    }
}

// MARK: - LAQs (LaqSettings)

private struct LaqSettingsSection: View {
    @Bindable var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            stepperRow(
                title: "LAQs written per lecture hour",
                detail: "When a lecture is prepared, and each time you press Write new LAQs — a 2-hour lecture gets \(store.settings.laqsPerHour * 2).",
                value: store.settings.laqsPerHour
            ) { n in
                store.updateSettings { $0.laqsPerHour = n }
            }
            stepperRow(
                title: "LAQs per sitting, per lecture hour",
                detail: "How many a sitting asks, closed book — your weakest concepts first, so more written means more variety from one sitting to the next.",
                value: store.settings.sittingPerHour
            ) { n in
                store.updateSettings { $0.sittingPerHour = n }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Question style")
                    .font(.callout.weight(.semibold))
                Text(styleExample(store.settings.laqStyle))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text("Applies to LAQs written from now on.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                Picker("Question style", selection: Binding(
                    get: { store.settings.laqStyle },
                    set: { style in store.updateSettings { $0.laqStyle = style } }
                )) {
                    Text("Mixed").tag(LaqStyle.mixed)
                    Text("Story").tag(LaqStyle.story)
                    Text("Facts").tag(LaqStyle.facts)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 260)
            }
        }
        .padding(.vertical, 2)
    }

    private func stepperRow(title: String, detail: String, value: Int, onChange: @escaping (Int) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                    .font(.callout.weight(.semibold))
                Spacer()
                Stepper("\(value)", value: Binding(
                    get: { value },
                    set: { onChange($0) }
                ), in: 1...maxPerHour)
                .fixedSize()
            }
            Text(detail)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func styleExample(_ style: LaqStyle) -> String {
        switch style {
        case .mixed:
            return "Whatever suits each concept — mostly direct questions, some set in a scenario."
        case .story:
            return "“Jane eats porridge at 7am, skips lunch and runs 5 km at 5pm. Explain how insulin and glucagon coordinate her energy storage and release…”"
        case .facts:
            return "“Describe how insulin is synthesised and how it promotes glucose uptake into skeletal muscle. Compare GLUT4 with GLUT1 and GLUT3…”"
        }
    }
}

// MARK: - Reminders (NotifyToggle)

private struct RemindersSection: View {
    @Bindable var store: AppStore
    @State private var note: String?

    var body: some View {
        Toggle(isOn: Binding(
            get: { store.settings.notify },
            set: { on in setNotify(on) }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Remind me when LAQs are due")
                Text("One notification a day per due lecture, between 8am and 10pm — even with Lockin's window closed.")
                    .font(.callout.weight(.regular))
                    .foregroundStyle(.secondary)
                if let note {
                    Text(note)
                        .font(.callout.weight(.regular))
                        .foregroundStyle(.red)
                }
            }
        }
        if store.settings.notify {
            Button("Send a test reminder") {
                sendTest()
            }
        }
    }

    private func setNotify(_ on: Bool) {
        note = nil
        guard on else {
            store.updateSettings { $0.notify = false }
            return
        }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            Task { @MainActor in
                if let error {
                    note = messageOf(error)
                } else if granted {
                    store.updateSettings { $0.notify = true }
                } else {
                    note = "Notifications are not allowed for Lockin — turn them on in System Settings → Notifications."
                }
            }
        }
    }

    private func sendTest() {
        let content = UNMutableNotificationContent()
        content.title = "Time to redo your LAQs"
        content.body = "This is what a Lockin reminder looks like."
        let request = UNNotificationRequest(identifier: "lockin.test", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                Task { @MainActor in note = messageOf(error) }
            }
        }
    }
}
