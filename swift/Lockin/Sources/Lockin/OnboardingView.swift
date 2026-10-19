import SwiftUI
import UserNotifications
import LockinCore

// Port of app/ui/Onboarding.tsx: the first-run walkthrough — what Lockin does, end to
// end. Opens by itself once, and again from Settings ("Repeat onboarding"). Choosing to
// run the AI on this computer adds a step for picking and downloading its model.

private enum OnboardingStep: String, CaseIterable {
    case intro
    case add
    case mode
    case model
    case practise
    case remind
}

struct OnboardingSheet: View {
    @Bindable var store: AppStore
    let hasCourses: Bool
    /// What the tools look like, for the Automatic choice's tag.
    var detection: AppStore.AiDetection?
    /// Called on "Add my first course", so the main window opens the new-course sheet.
    var onAddFirstCourse: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var step = 0
    @State private var mode: AppMode
    @State private var notify: Bool

    init(store: AppStore, hasCourses: Bool, detection: AppStore.AiDetection?, onAddFirstCourse: @escaping () -> Void = {}) {
        self.store = store
        self.hasCourses = hasCourses
        self.detection = detection
        self.onAddFirstCourse = onAddFirstCourse
        // First run with no Claude Code on the computer starts in copy-and-paste mode,
        // as the web tour does.
        _mode = State(initialValue: store.settings.onboarded ? store.settings.mode : (detection?.claude.found == false ? .manual : store.settings.mode))
        _notify = State(initialValue: store.settings.notify)
    }

    /// The steps, with the model one only when local mode is chosen.
    private var keys: [OnboardingStep] {
        mode == .local ? [.intro, .add, .mode, .model, .practise, .remind] : [.intro, .add, .mode, .practise, .remind]
    }

    private var key: OnboardingStep {
        keys[min(step, keys.count - 1)]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                switch key {
                case .intro: introStep
                case .add: addStep
                case .mode: modeStep
                case .model:
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            kicker("2b · Your offline model")
                            Text("Pick a model for this \(store.modelsSnapshot().specs.kind)")
                                .font(.title2.weight(.bold))
                            Text("We recommend the one in the middle for this computer's memory and processor. Go left for speed, right for quality. It downloads in the background — carry on with the tour — and links up by itself when it's done.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            ModelPickerSection(store: store)
                        }
                    }
                case .practise: practiseStep
                case .remind: remindStep
                }
            }
            .padding(24)

            Spacer(minLength: 0)

            HStack {
                HStack(spacing: 6) {
                    ForEach(keys.indices, id: \.self) { index in
                        Capsule()
                            .fill(index == step ? L.accent : L.ruleStrong)
                            .frame(width: 18, height: 4)
                    }
                }
                Spacer()
                if step > 0 {
                    Button("Back") { step -= 1 }
                        .keyboardShortcut(.cancelAction)
                }
                if step < keys.count - 1 {
                    Button {
                        step += 1
                    } label: {
                        Label("Next", systemImage: "arrow.right")
                    }
                    .keyboardShortcut(.defaultAction)
                } else {
                    Button(hasCourses ? "Done" : "Add my first course") {
                        store.finishOnboarding(mode: mode, notify: notify)
                        dismiss()
                        if !hasCourses {
                            onAddFirstCourse()
                        }
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(20)
        }
        .frame(width: 560, height: 560)
    }

    // MARK: The steps

    private var introStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            kicker("How Lockin works")
            Text("Lectures in, exam practice out")
                .font(.title.weight(.bold))
            Text("Lockin turns each lecture into a summary and a set of long-answer questions (LAQs), marks your answers, and tells you when to come back to each lecture. Five steps, and you only do two of them.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                flowNode("folder", "Lecture files")
                Text("→").foregroundStyle(.tertiary)
                flowNode("book", "Summary")
                Text("→").foregroundStyle(.tertiary)
                flowNode("pencil", "LAQs")
                Text("→").foregroundStyle(.tertiary)
                flowNode("target", "Score")
                Text("→").foregroundStyle(.tertiary)
                flowNode("bell", "Reminder")
            }
            .font(.caption)
        }
    }

    private var addStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            kicker("1 · Add your lectures")
            Text("Point it at a folder")
                .font(.title.weight(.bold))
            Text("Choose the folder your transcripts and slides are already in, however messy. Lockin pairs each transcript with its slides by lecture number, date or name — instantly, on your computer — and shows you the list to check before anything is imported.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Text("You can also add a single lecture by dropping in its files or pasting the transcript text.")
                .font(.callout)
            Label {
                Text("Each lecture is read on its own. **Module aims, learning objectives and housekeeping are left out** of its title, summary and questions — and the lecture page shows you exactly what was skipped.")
                    .font(.callout)
            } icon: {
                Image(systemName: "scissors")
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(L.tagPalettes[.yellow]!.bg)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var modeStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            kicker("2 · Summary and LAQs")
            Text("Choose how the AI part happens")
                .font(.title.weight(.bold))
            modeChoice(
                .auto,
                title: "Automatic",
                tag: detection?.claude.found ?? true
                    ? TagBadge(text: "Claude Code found", tone: .green)
                    : TagBadge(text: "Claude Code not found on this computer", tone: .gray),
                detail: "Lockin uses Claude Code to work through your lectures one at a time — summary first, then LAQs — and the top-right corner always says what it's on and how long it's been."
            )
            modeChoice(
                .local,
                title: "On this computer — works fully offline",
                tag: TagBadge(text: "Private · free", tone: .blue),
                detail: "Download a free AI model once and everything runs on your own Mac, with no internet and no account. A little slower than Claude; next you'll pick a model that suits this machine."
            )
            modeChoice(
                .manual,
                title: "Copy & paste — works with any AI chat",
                tag: nil,
                detail: "Nothing to install. Each lecture has a Copy prompt button: paste it into ChatGPT, Claude or Gemini, then paste the reply into the box. Summaries, LAQs and scores are formatted for you."
            )
            Text("You can switch any time in Settings.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private var practiseStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            kicker("3 · Practise")
            Text("Read once, then answer closed book")
                .font(.title.weight(.bold))
            Text("Read a lecture's summary, then — ideally the next day — answer its LAQs from memory. The summary is out of sight while you answer: recalling it is what makes it stick.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Text("Each answer is marked out of 10 against a fixed marking guide, with what you got right, what you missed and what you got wrong. A sitting is scored with the **geometric mean**: 9 and 4 gives 6.0, not 6.5, because one weak answer costs you in the exam too.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                TagBadge(text: "0–3.9", tone: .red)
                TagBadge(text: "4–5.9", tone: .orange)
                TagBadge(text: "6–7.9", tone: .yellow)
                TagBadge(text: "8–10", tone: .green)
                Text("— sort the table by “Weakest first” to see where to focus.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var remindStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            kicker("4 · Come back")
            Text("Redo each lecture's LAQs when it's due")
                .font(.title.weight(.bold))
            Text("Score 7 or more and the gap before the next sitting grows. Between 5 and 7 it holds. Under 5, the lecture is back tomorrow. Everything is pulled in before your exam date.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .bottom, spacing: 10) {
                ForEach([1, 3, 7, 14, 30].indices, id: \.self) { index in
                    let days = [1, 3, 7, 14, 30][index]
                    VStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(L.accent.opacity(0.5))
                            .frame(width: 18, height: CGFloat(12 + index * 12))
                        Text("\(days)d")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Toggle(isOn: Binding(
                get: { notify },
                set: { on in askNotify(on) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Remind me when LAQs are due")
                    Text("A notification once a day per lecture, never between 10pm and 8am.")
                        .font(.callout.weight(.regular))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: Pieces

    private func kicker(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.caption.weight(.bold))
            .foregroundStyle(.secondary)
            .kerning(0.6)
    }

    private func flowNode(_ icon: String, _ label: String) -> some View {
        Label(label, systemImage: icon)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(L.hover)
            .clipShape(Capsule())
    }

    @ViewBuilder
    private func modeChoice(_ choice: AppMode, title: String, tag: TagBadge?, detail: String) -> some View {
        Button {
            mode = choice
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: mode == choice ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(mode == choice ? L.accent : L.textFaint)
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(title)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(.primary)
                        if let tag {
                            tag
                        }
                    }
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(mode == choice ? L.accentSoft : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }

    /// Turning reminders on asks macOS once (`askNotify`): granted is remembered, refused
    /// leaves the toggle off.
    private func askNotify(_ on: Bool) {
        guard on else {
            notify = false
            return
        }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            Task { @MainActor in
                notify = granted
            }
        }
    }
}
