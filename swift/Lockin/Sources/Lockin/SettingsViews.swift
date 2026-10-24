import AppKit
import SwiftUI
import UserNotifications
import LockinCore

// The Settings window as the web app's settings page (app/settings/page.tsx and its
// parts): a narrow page of section headings and `.setting` rows — title and description
// on the left, the control on the right, a hairline under each — with the `.seg`
// segmented choice and `.stepper` controls. No save button: every change writes as it
// is made.

// MARK: - Shared pieces of the design

/// `.setting`: a row with what it does on the left and its control on the right.
struct SettingRow<Control: View>: View {
    let title: String
    var detail: String?
    @ViewBuilder var control: () -> Control

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(L.text)
                if let detail {
                    Text(detail)
                        .font(.system(size: 13.5))
                        .foregroundStyle(L.textSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 16)
            control()
        }
        .padding(.vertical, 14)
        .background(alignment: .bottom) { Rectangle().fill(L.rule).frame(height: 1) }
    }
}

/// `.seg`: a sunk pill of choices; the selected one sits on the canvas with the shadow.
struct SegButtons<Option: Hashable>: View {
    @Binding var selection: Option
    let options: [(option: Option, label: String)]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.option) { item in
                let on = item.option == selection
                Button {
                    selection = item.option
                } label: {
                    Text(item.label)
                        .font(.system(size: 13.5, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? L.text : L.textSoft)
                        .padding(.horizontal, 11)
                        .frame(height: 28)
                        .background(on ? L.bg : Color.clear)
                        .cornerRadius(5)
                        .shadow(color: on ? Color.black.opacity(0.06) : .clear, radius: 0.5, y: 1)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(L.bgSunk)
        .cornerRadius(7)
    }
}

/// `.stepper`: − value +, with the count between rules.
struct NumberStepper: View {
    @Binding var value: Int
    var range: ClosedRange<Int>

    var body: some View {
        HStack(spacing: 0) {
            stepButton("−", disabled: value <= range.lowerBound) { value -= 1 }
            Text("\(value)")
                .font(.system(size: 14, weight: .semibold).monospacedDigit())
                .foregroundStyle(L.text)
                .frame(minWidth: 34)
                .frame(height: 30)
                .background(alignment: .leading) { Rectangle().fill(L.rule).frame(width: 1).offset(x: 0) }
                .background(alignment: .trailing) { Rectangle().fill(L.rule).frame(width: 1) }
            stepButton("+", disabled: value >= range.upperBound) { value += 1 }
        }
        .overlay(
            RoundedRectangle(cornerRadius: 7)
                .strokeBorder(L.ruleStrong, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }

    private func stepButton(_ glyph: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(glyph)
                .font(.system(size: 16))
                .foregroundStyle(disabled ? L.textFaint : L.text)
                .frame(width: 32, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }
}

/// `.choice`: a bordered card with a radio circle; checked, it turns blue and soft.
struct ChoiceRow<Option: Hashable>: View {
    let option: Option
    @Binding var selection: Option
    let title: String
    var tag: TagBadge?
    let detail: String

    var body: some View {
        let on = option == selection
        Button {
            selection = option
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: on ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 14))
                    .foregroundStyle(on ? L.accent : L.textFaint)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(L.text)
                        if let tag {
                            tag
                        }
                    }
                    Text(detail)
                        .font(.system(size: 13.5))
                        .foregroundStyle(L.textSoft)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(on ? L.accentSoft : Color.clear)
            .cornerRadius(8)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(on ? L.accent : L.ruleStrong, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

/// `.engine-panel`: the chosen cloud AI's own settings, in a soft box.
struct EnginePanel<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            content()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(L.bgSoft)
        .cornerRadius(8)
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
            HStack(spacing: 10) {
                Text(label)
                    .font(.lockinSmall)
                    .foregroundStyle(L.textSoft)
                    .frame(width: 64, alignment: .leading)
                TextField(placeholder, text: $value)
                    .textFieldStyle(.plain)
                    .onSubmit(commit)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(L.bg)
                    .cornerRadius(6)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(L.ruleStrong, lineWidth: 1)
                    )
            }
            Text(hint)
                .font(.system(size: 12.5))
                .foregroundStyle(L.textFaint)
        }
        .onDisappear(perform: commit)
    }

    private func commit() {
        guard value.trimmingCharacters(in: .whitespaces) != saved.trimmingCharacters(in: .whitespaces) else { return }
        saved = value
        onSave(value)
    }
}

// MARK: - The window

struct SettingsScreen: View {
    @Bindable var store: AppStore
    @State private var detection: AppStore.AiDetection?
    @State private var showingOnboarding = false

    var body: some View {
        PageContainer(narrow: true) {
            VStack(alignment: .leading, spacing: 0) {
                PageTitle(text: "Settings")
                Text("Everything stays on this computer.")
                    .font(.system(size: 14))
                    .foregroundStyle(L.textSoft)
                    .padding(.bottom, 24)

                SectionHeading(text: "Summaries and LAQs")
                    .padding(.bottom, 8)
                ModePickerSection(store: store, detection: detection)
                if store.settings.mode.usesAi {
                    WorkerStatusLine(store: store)
                }

                if store.settings.mode == .auto {
                    SectionHeading(text: "Cloud AI")
                        .padding(.top, 26)
                        .padding(.bottom, 8)
                    CloudSettingsSection(store: store, detection: detection)
                }

                SectionHeading(text: "LAQs")
                    .padding(.top, 26)
                    .padding(.bottom, 8)
                LaqSettingsSection(store: store)

                SectionHeading(text: "Offline AI on this computer")
                    .padding(.top, 26)
                    .padding(.bottom, 4)
                Text("Download a model once and Lockin works with no internet. The middle one is chosen for this computer; downloading any of them switches Lockin to it when it finishes.")
                    .font(.system(size: 13.5))
                    .foregroundStyle(L.textSoft)
                    .padding(.bottom, 12)
                ModelPickerSection(store: store)

                SectionHeading(text: "Getting started")
                    .padding(.top, 26)
                    .padding(.bottom, 8)
                SettingRow(
                    title: "Onboarding",
                    detail: "The walkthrough from the first time you opened Lockin: adding lectures, choosing the AI, practising and reminders."
                ) {
                    Button {
                        showingOnboarding = true
                    } label: {
                        Label("Repeat onboarding", systemImage: "arrow.counterclockwise")
                    }
                    .buttonStyle(.lockin)
                }

                SectionHeading(text: "Reminders")
                    .padding(.top, 26)
                    .padding(.bottom, 8)
                RemindersSection(store: store)

                SectionHeading(text: "Courses")
                    .padding(.top, 26)
                    .padding(.bottom, 8)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(store.courses) { course in
                        HStack(spacing: 10) {
                            TagBadge(text: course.code, tone: tagTone(course.code))
                            Text(course.title)
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(L.text)
                            Text("· \(plural(store.lectureRows.filter { $0.courseId == course.id }.count, "lecture"))")
                                .font(.lockinSmall)
                                .foregroundStyle(L.textSoft)
                            Spacer()
                        }
                        .padding(.vertical, 12)
                        .background(alignment: .bottom) { Rectangle().fill(L.rule).frame(height: 1) }
                    }
                }

                SectionHeading(text: "Updates")
                    .padding(.top, 26)
                    .padding(.bottom, 8)
                UpdatesSection(store: store)
            }
        }
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
    let detection: AppStore.AiDetection?
    @State private var selection: AppMode?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ChoiceRow(
                option: AppMode.auto,
                selection: Binding(get: { store.settings.mode }, set: { mode in
                    store.updateSettings { $0.mode = mode }
                }),
                title: "Automatic",
                tag: TagBadge(
                    text: {
                        guard let status = detection?.claude else { return "Claude Code" }
                        return status.found
                            ? "Claude Code\(status.version.map { " · \($0)" } ?? "")"
                            : "Claude Code not found on this computer"
                    }(),
                    tone: (detection?.claude.found ?? true) ? .green : .red
                ),
                detail: "Lockin prepares lectures itself with a cloud AI — Claude Code, ChatGPT Codex, Google Antigravity or an API key, chosen below — one lecture at a time, and marks your answers."
            )
            ChoiceRow(
                option: AppMode.local,
                selection: Binding(get: { store.settings.mode }, set: { mode in
                    store.updateSettings { $0.mode = mode }
                }),
                title: "On this computer",
                tag: TagBadge(text: store.modelsSnapshot().installedInfo(forModel: store.settings.localModel ?? "")?.name ?? "no model yet", tone: store.settings.localModel != nil ? .green : .gray),
                detail: "A model downloaded to this computer does the work: fully offline, private and free, a little slower. Pick one below."
            )
            ChoiceRow(
                option: AppMode.manual,
                selection: Binding(get: { store.settings.mode }, set: { mode in
                    store.updateSettings { $0.mode = mode }
                }),
                title: "Copy & paste",
                tag: nil,
                detail: "No AI runs here. Each lecture has Copy prompt buttons for any AI chat, and boxes that format what you paste back."
            )
        }
    }
}

/// The heartbeat line the web page shows under the mode (`beat?.alive`).
private struct WorkerStatusLine: View {
    @Bindable var store: AppStore

    var body: some View {
        SettingRow(title: "AI worker", detail: {
            let alive = store.queueActivity?.worker?.alive ?? false
            return alive
                ? "Running — prepares one lecture at a time, and marks answers first."
                : "Not running, so nothing queued will start. It runs with this app."
        }()) {
            TagBadge(
                text: (store.queueActivity?.worker?.alive ?? false) ? "Running" : "Stopped",
                tone: (store.queueActivity?.worker?.alive ?? false) ? .green : .orange
            )
        }
    }
}

// MARK: - The cloud AI (CloudSettings)

private struct CloudSettingsSection: View {
    @Bindable var store: AppStore
    let detection: AppStore.AiDetection?

    @State private var apiKeyDraft = ""
    @State private var keyNote: String?
    @State private var test: AppStore.ActionResult?
    @State private var testing = false

    var body: some View {
        SettingRow(title: "Cloud AI", detail: "Which AI prepares lectures, writes LAQs and marks. Each uses your own sign-in or key.") {
            SegButtons(
                selection: Binding(
                    get: { store.settings.cloudEngine },
                    set: { engine in store.updateSettings { $0.cloudEngine = engine } }
                ),
                options: CloudEngine.allCases.map { ($0, $0.label) }
            )
        }

        EnginePanel {
            enginePanel
        }
        .padding(.bottom, 6)

        SettingRow(title: "If the cloud AI fails, use the offline model", detail: {
            let offline = store.modelsSnapshot().installedInfo(forModel: store.settings.localModel ?? "")?.name
            return offline != nil
                ? "When \(store.settings.cloudEngine.label) can't do a job — signed out, over a usage limit, offline — \(offline!) on this computer does it instead. The cloud AI is always tried first."
                : "Download an offline model below and Lockin uses it whenever \(store.settings.cloudEngine.label) can't do a job — signed out, over a usage limit, offline. The cloud AI is always tried first."
        }()) {
            Toggle("", isOn: Binding(
                get: { store.settings.fallbackLocal },
                set: { on in store.updateSettings { $0.fallbackLocal = on } }
            ))
            .toggleStyle(.switch)
            .tint(L.accent)
            .labelsHidden()
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
            Text(cloudModelBlurb)
                .font(.system(size: 13.5))
                .foregroundStyle(L.textSoft)
            SettingRow(title: "Claude model", detail: nil) {
                SegButtons(
                    selection: Binding(
                        get: { store.settings.cloudModel },
                        set: { model in store.updateSettings { $0.cloudModel = model } }
                    ),
                    options: [
                        (.sonnet, "Sonnet · default"), (.opus, "Opus"), (.haiku, "Haiku"),
                    ]
                )
            }
        case .codex:
            toolStatus(
                found: status?.codex.found ?? true,
                version: status?.codex.version,
                name: "Codex",
                install: "Install it with npm i -g @openai/codex, then run codex login once to sign in with your ChatGPT plan."
            )
            Text("Uses your ChatGPT plan. It sees the slides as pictures.")
                .font(.system(size: 13.5))
                .foregroundStyle(L.textSoft)
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
                .font(.system(size: 13.5))
                .foregroundStyle(L.textSoft)
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
        SettingRow(title: "Service", detail: nil) {
            Picker("", selection: Binding(
                get: { store.settings.apiService },
                set: { service in store.updateSettings { $0.apiService = service } }
            )) {
                ForEach(ApiService.allCases, id: \.self) { service in
                    Text(service.info.label).tag(service)
                }
            }
            .labelsHidden()
            .frame(width: 220)
        }

        if store.settings.apiService == .anthropic {
            Text("Billed per use to your Anthropic account. \(cloudModelBlurb)")
                .font(.system(size: 13.5))
                .foregroundStyle(L.textSoft)
            SettingRow(title: "Claude model", detail: nil) {
                SegButtons(
                    selection: Binding(
                        get: { store.settings.cloudModel },
                        set: { model in store.updateSettings { $0.cloudModel = model } }
                    ),
                    options: [(.sonnet, "Sonnet · default"), (.opus, "Opus"), (.haiku, "Haiku")]
                )
            }
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
                Text("This model can see images — it is shown the slides as pictures.")
                    .font(.system(size: 13.5))
                    .foregroundStyle(L.textSoft)
            }
            .tint(L.accent)
        }

        keyRow
    }

    private var keyRow: some View {
        let saved = store.savedApiKeySuffix
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Text("API key")
                    .font(.lockinSmall)
                    .foregroundStyle(L.textSoft)
                    .frame(width: 64, alignment: .leading)
                SecureField(
                    saved != nil ? "Saved (\(saved!)) — paste a new one to replace it" : "Paste your key",
                    text: $apiKeyDraft
                )
                .textFieldStyle(.plain)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(L.bg)
                .cornerRadius(6)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(L.ruleStrong, lineWidth: 1)
                )
                Button("Save key") {
                    store.setApiKeySetting(apiKeyDraft)
                    keyNote = "Saved. It stays on this computer, in Lockin's own database."
                    apiKeyDraft = ""
                }
                .buttonStyle(.lockin(size: .small))
                .disabled(apiKeyDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                if saved != nil {
                    Button("Remove") {
                        store.setApiKeySetting(nil)
                        keyNote = "Removed."
                    }
                    .buttonStyle(.lockin(.quiet, size: .small))
                }
            }
            HStack(spacing: 6) {
                Text("It stays on this computer, in Lockin's own database.")
                    .font(.system(size: 12.5))
                    .foregroundStyle(L.textFaint)
                if let note = keyNote {
                    Text(note)
                        .font(.system(size: 12.5))
                        .foregroundStyle(L.textSoft)
                }
            }
        }
    }

    private var testRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
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
                .buttonStyle(.lockin(size: .small))
                .disabled(testing)
                if test == nil {
                    Text("Sends one tiny question, to check it is set up.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(L.textFaint)
                }
            }
            if let test {
                Text(test.message ?? (test.ok ? "Working." : "It did not work."))
                    .font(.system(size: 13))
                    .foregroundStyle(test.ok ? L.strong[.green] ?? .green : L.danger)
            }
        }
        .padding(.top, 6)
    }

    private var cloudModelBlurb: String {
        switch store.settings.cloudModel {
        case .sonnet: return "Fast and thorough — the right size for summaries, LAQs and marking."
        case .opus: return "The most thorough, and the slowest: a lecture takes noticeably longer."
        case .haiku: return "The quickest and lightest. Fine for short lectures; less depth in summaries."
        }
    }

    @ViewBuilder
    private func toolStatus(found: Bool, version: String?, name: String, install: String) -> some View {
        HStack(spacing: 8) {
            TagBadge(text: found ? "Found" : "Not found", tone: found ? .green : .red)
            if found, let version {
                Text(version)
                    .font(.lockinSmall)
                    .foregroundStyle(L.textSoft)
            }
        }
        if !found {
            Text(install)
                .font(.system(size: 13.5))
                .foregroundStyle(L.textSoft)
        }
    }
}

// MARK: - LAQs (LaqSettings)

private struct LaqSettingsSection: View {
    @Bindable var store: AppStore

    var body: some View {
        SettingRow(
            title: "LAQs written per lecture hour",
            detail: "When a lecture is prepared, and each time you press Write new LAQs — a 2-hour lecture gets \(store.settings.laqsPerHour * 2)."
        ) {
            NumberStepper(
                value: Binding(
                    get: { store.settings.laqsPerHour },
                    set: { n in store.updateSettings { $0.laqsPerHour = n } }
                ),
                range: 1...maxPerHour
            )
        }

        SettingRow(
            title: "LAQs per sitting, per lecture hour",
            detail: "How many a sitting asks, closed book — your weakest concepts first, so more written means more variety from one sitting to the next."
        ) {
            NumberStepper(
                value: Binding(
                    get: { store.settings.sittingPerHour },
                    set: { n in store.updateSettings { $0.sittingPerHour = n } }
                ),
                range: 1...maxPerHour
            )
        }

        SettingRow(
            title: "Question style",
            detail: styleExample(store.settings.laqStyle) + "  Applies to LAQs written from now on."
        ) {
            SegButtons(
                selection: Binding(
                    get: { store.settings.laqStyle },
                    set: { style in store.updateSettings { $0.laqStyle = style } }
                ),
                options: [(.mixed, "Mixed"), (.story, "Story"), (.facts, "Facts")]
            )
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
        SettingRow(
            title: "Remind me when LAQs are due",
            detail: note ?? "One notification a day per due lecture, between 8am and 10pm — even with Lockin's window closed."
        ) {
            HStack(spacing: 8) {
                if store.settings.notify {
                    Button("Test") { sendTest() }
                        .buttonStyle(.lockin(size: .small))
                }
                Toggle("", isOn: Binding(
                    get: { store.settings.notify },
                    set: { on in setNotify(on) }
                ))
                .toggleStyle(.switch)
                .tint(L.accent)
                .labelsHidden()
            }
        }
    }

    private func setNotify(_ on: Bool) {
        note = nil
        guard on else {
            store.updateSettings { $0.notify = false }
            return
        }
        guard ReminderDaemon.notificationsAvailable else {
            store.updateSettings { next in next.notify = true }
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
        guard ReminderDaemon.notificationsAvailable else { return }
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
