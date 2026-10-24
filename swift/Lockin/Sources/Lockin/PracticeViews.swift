import AppKit
import SwiftUI
import WebKit
import LockinCore
import UniformTypeIdentifiers

func copyStudyText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

struct PracticeDestination: Identifiable { let id: String }

struct PracticeSheet: View {
    @Bindable var store: AppStore
    let attemptId: String
    @Environment(\.dismiss) private var dismiss
    @State private var snapshot: PracticeSnapshot?
    @State private var drafts: [String: String] = [:]
    @State private var error: String?
    @State private var paste = ""
    @State private var notice = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(snapshot?.lecture.title ?? "Sitting").font(.title2.bold())
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let snapshot {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if snapshot.submitted {
                            results(snapshot)
                        } else {
                            Text("Closed book — answer from memory. Your drafts save as you type.").foregroundStyle(.secondary)
                            ForEach(snapshot.answers) { item in
                                VStack(alignment: .leading) {
                                    Text("LAQ \(item.number)").font(.headline)
                                    Text(item.question.stem).textSelection(.enabled)
                                    TextEditor(text: Binding(get: { drafts[item.id] ?? "" }, set: { text in
                                        drafts[item.id] = text
                                        do {
                                            try store.database?.writer.write { db in try savePracticeDraft(db: db, responseId: item.id, text: text) }
                                            error = nil
                                        } catch { self.error = "Draft could not be saved: \(error.localizedDescription)" }
                                    }))
                                    .font(.body).frame(minHeight: 160).border(Color.secondary.opacity(0.25))
                                    .accessibilityLabel("Answer to LAQ \(item.number)")
                                }
                            }
                            Button("Submit for marking") {
                                do {
                                    try store.database?.writer.write { db in try submitPractice(db: db, attemptId: attemptId, answers: drafts) }
                                    error = nil
                                    reload()
                                } catch { self.error = error.localizedDescription }
                            }.buttonStyle(.borderedProminent)
                            Text("Unanswered questions score zero. Submitted answers cannot be edited.").font(.caption).foregroundStyle(.secondary)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                }
            } else { ProgressView() }
        }
        .padding(24).frame(minWidth: 760, idealWidth: 850, minHeight: 620, idealHeight: 780)
        .onAppear { reload() }
        .onChange(of: store.dbRevision) { _, _ in reload() }
    }

    @ViewBuilder private func results(_ snapshot: PracticeSnapshot) -> some View {
        if let score = snapshot.attempt.geometricMean {
            Text("\(formatScore(score)) / 10").font(.largeTitle.bold())
            Text("Geometric mean of \(snapshot.answers.count) answers · Next sitting: \(dueLabel(snapshot.review.dueAt).text)")
                .foregroundStyle(.secondary)
        } else {
            Text("\(snapshot.answers.filter { $0.response.mark == nil }.count) answers awaiting marking").font(.headline)
        }
        ForEach(snapshot.jobs.filter { $0.status == .failed }) { job in
            HStack {
                Text(job.error ?? "Marking failed").foregroundStyle(.red)
                Button("Retry marking") { store.retryQueueJob(job.id) }
            }
        }
        DisclosureGroup("Copy & paste marking") {
            VStack(alignment: .leading) {
                Button("Copy marking prompt") {
                    do { copyStudyText(try practiceMarkingPrompt(snapshot)); notice = "Marking prompt copied." }
                    catch { self.error = error.localizedDescription }
                }
                TextEditor(text: $paste).frame(height: 120).border(Color.secondary.opacity(0.25))
                    .accessibilityLabel("Paste marking from an AI chat")
                Button("Save marks") {
                    do {
                        let count = try store.database?.writer.write { db in try savePracticePaste(db: db, attemptId: attemptId, text: paste) } ?? 0
                        notice = "Saved \(count) marks."; paste = ""; error = nil; reload()
                    } catch { self.error = error.localizedDescription }
                }.disabled(paste.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if !notice.isEmpty { Text(notice).font(.caption) }
            }.padding(.vertical, 8)
        }
        let notes = practiceNotes(snapshot)
        GroupBox("Notes to copy down") {
            VStack(alignment: .leading, spacing: 10) {
                if notes.count > 0 {
                    Text(notes.plain).textSelection(.enabled)
                    HStack {
                        Button("Copy Markdown") { copyStudyText(notes.markdown) }
                        Button("Copy plain text") { copyStudyText(notes.plain) }
                        Button("Save .md…") {
                            let panel = NSSavePanel()
                            panel.nameFieldStringValue = "\(safeStudyFileName(snapshot.lecture.title)) — notes.md"
                            panel.allowedContentTypes = [.plainText]
                            if panel.runModal() == .OK, let url = panel.url {
                                do { try notes.markdown.write(to: url, atomically: true, encoding: .utf8) }
                                catch { self.error = error.localizedDescription }
                            }
                        }
                    }
                } else { Text("Corrections and missed points appear here as marking finishes.").foregroundStyle(.secondary) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        ForEach(snapshot.answers) { item in
            GroupBox("LAQ \(item.number) · \(item.response.mark.map { formatScore($0) + " / 10" } ?? "Awaiting marking")") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(item.feedback.enumerated()), id: \.offset) { _, feedback in
                        Text("\(feedback.kind.rawValue.capitalized): \(feedback.text)").textSelection(.enabled)
                    }
                    DisclosureGroup("Question, your answer and marking guide") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(item.question.stem).font(.headline)
                            Text(item.response.answerText.isEmpty ? "(Left blank)" : item.response.answerText)
                            Divider()
                            ForEach(Array(item.guide.enumerated()), id: \.offset) { _, point in Text("• \(point)") }
                        }.textSelection(.enabled)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func reload() {
        do {
            guard let database = store.database else { return }
            let latest = try database.reader.read { db in try practiceSnapshot(db: db, attemptId: attemptId) }
            if snapshot == nil { drafts = Dictionary(uniqueKeysWithValues: latest.answers.map { ($0.id, $0.response.draftText ?? "") }) }
            snapshot = latest
        } catch { self.error = error.localizedDescription }
    }
}

struct LecturePasteSheet: View {
    @Bindable var store: AppStore
    let lectureId: String
    @Environment(\.dismiss) private var dismiss
    @State private var kind: LecturePasteKind = .summary
    @State private var text = ""
    @State private var notice = ""
    @State private var error: String?
    @State private var replacingSummary = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { Text("Copy & paste with an AI chat").font(.title2.bold()); Spacer(); Button("Done") { dismiss() } }
            Toggle("Use copy & paste mode (pause automatic AI)", isOn: Binding(get: { store.mode == "manual" }, set: { enabled in
                do { try store.database?.writer.write { db in try setSetting(db: db, key: "mode", value: .string(enabled ? "manual" : "auto")) } }
                catch { self.error = error.localizedDescription }
            }))
            Picker("Paste", selection: $kind) { ForEach(LecturePasteKind.allCases, id: \.self) { Text($0.rawValue).tag($0) } }.pickerStyle(.segmented)
            Text(kind == .scores ? "Paste scores for questions answered outside Lockin. Numbers must match this lecture’s LAQs." : "Copy the prompt, attach any slide files it lists in your AI chat, then paste its reply here.")
            if kind != .scores {
                Button("Copy \(kind.rawValue.lowercased()) prompt") {
                    do {
                        guard let database = store.database else { return }
                        copyStudyText(try lectureCopyPrompt(database: database, lectureId: lectureId, kind: kind, renderer: store.slideRenderer))
                        notice = "Prompt copied."; error = nil
                    } catch { self.error = error.localizedDescription }
                }
            }
            TextEditor(text: $text).font(.system(.body, design: .monospaced)).border(Color.secondary.opacity(0.25))
            if let error { Text(error).foregroundStyle(.red) }
            Text(notice).font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Save \(kind.rawValue.lowercased())") {
                    if kind == .summary { replacingSummary = true } else { save() }
                }.buttonStyle(.borderedProminent).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 740, height: 600)
        .confirmationDialog("Replace this lecture’s summary with the pasted text?", isPresented: $replacingSummary) {
            Button("Save summary") { save() }
        }
        .onChange(of: kind) { _, _ in notice = ""; error = nil }
    }
    private func save() {
        do {
            notice = try store.database?.writer.write { db in try saveLecturePaste(db: db, lectureId: lectureId, kind: kind, text: text) } ?? ""
            text = ""; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

/// NSTextView exposes the real selection to the Markdown toolbar on macOS 14.
struct MarkdownSourceEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var selection: NSRange
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        let view = scroll.documentView as! NSTextView
        view.isRichText = false
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        view.string = text
        view.delegate = context.coordinator
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        let view = scroll.documentView as! NSTextView
        if view.string != text {
            view.string = text
            view.setSelectedRange(NSRange(location: min(selection.location, (text as NSString).length), length: 0))
        }
    }
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MarkdownSourceEditor
        init(_ parent: MarkdownSourceEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.text = view.string
            parent.selection = view.selectedRange()
        }
        func textViewDidChangeSelection(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.selection = view.selectedRange()
        }
    }
}

func safeStudyFileName(_ title: String) -> String {
    let safe = title.components(separatedBy: CharacterSet(charactersIn: "/\\:*?\"<>|\n\r")).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    return safe.isEmpty ? "Lecture" : String(safe.prefix(100))
}
