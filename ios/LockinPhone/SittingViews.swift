import LockinKit
import SwiftUI

/// A closed-book sitting: each question with a box to answer it in. What's typed is
/// kept as it's typed, so leaving and coming back loses nothing.
struct SittingView: View {
    @Environment(AppModel.self) private var model
    let lectureId: String
    @State private var draftId: String?
    @State private var submitted: String?
    @State private var confirming = false
    @FocusState private var focused: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if let submitted {
            SittingResultView(lectureId: lectureId, sittingId: submitted)
        } else if let lecture = model.lecture(lectureId), let draftId, let draft = model.draft(id: draftId) {
            let questions = draft.questionIds.compactMap { id in lecture.questions.first { $0.id == id } }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 26) {
                    Text("Closed book. Answer as you would in the exam: dot points and abbreviations are fine. A blank answer scores 0.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    ForEach(Array(questions.enumerated()), id: \.element.id) { index, question in
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Question \(index + 1) of \(questions.count)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(question.stem)
                                .font(.body.weight(.medium))
                                .fixedSize(horizontal: false, vertical: true)
                            TextField("Your answer", text: binding(draftId, question.id), axis: .vertical)
                                .lineLimit(6...40)
                                .focused($focused, equals: question.id)
                                .padding(10)
                                .background(RoundedRectangle(cornerRadius: 10).fill(Color(.secondarySystemBackground)))
                        }
                    }
                    Button {
                        confirming = true
                    } label: {
                        Text("Hand in").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("L\(lecture.ordinal) sitting")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focused = nil }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Discard this sitting", role: .destructive) {
                            model.discardDraft(draftId)
                            dismiss()
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .confirmationDialog(handInTitle(draft), isPresented: $confirming, titleVisibility: .visible) {
                Button("Hand in") {
                    focused = nil
                    submitted = model.submit(draftId)
                }
                Button("Keep answering", role: .cancel) {}
            } message: {
                Text(model.markingNote)
            }
        } else if let lecture = model.lecture(lectureId), !lecture.questions.isEmpty {
            ProgressView().onAppear { draftId = model.startSitting(lecture).id }
        } else {
            ContentUnavailableView("No LAQs to answer", systemImage: "pencil.slash")
        }
    }

    private func binding(_ draftId: String, _ questionId: String) -> Binding<String> {
        Binding(
            get: { model.answer(draftId, questionId) },
            set: { model.setAnswer($0, draftId: draftId, questionId: questionId) }
        )
    }

    private func handInTitle(_ draft: Draft) -> String {
        let blank = draft.questionIds.filter { (draft.answers[$0] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.count
        return blank == 0 ? "Hand in this sitting?" : "Hand in with \(blank) blank answer\(blank == 1 ? "" : "s")? They score 0."
    }
}

/// A handed-in sitting: each answer with its mark and what to fix, or what it waits for.
struct SittingResultView: View {
    @Environment(AppModel.self) private var model
    let lectureId: String
    let sittingId: String

    var body: some View {
        let lecture = model.lecture(lectureId)
        if let sitting = model.sittings(for: lectureId).first(where: { $0.id == sittingId }) {
            List {
                Section {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(sitting.date.formatted(date: .abbreviated, time: .shortened)).font(.headline)
                            Text(headline(sitting)).font(.callout).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if model.marking.contains(sitting.id) {
                            ProgressView()
                        } else if let score = sitting.score {
                            VStack(alignment: .trailing) {
                                Text(String(format: "%.1f", score)).font(.title.monospacedDigit().bold())
                                Text("out of 10").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                ForEach(Array(sitting.answers.enumerated()), id: \.element.id) { index, answer in
                    let question = lecture?.questions.first { $0.id == answer.questionId }
                    Section {
                        if let question { Text(question.stem).font(.body.weight(.medium)) }
                        Text(answer.answerText.isEmpty ? "Left blank." : answer.answerText)
                            .foregroundStyle(answer.answerText.isEmpty ? .secondary : .primary)
                            .textSelection(.enabled)
                        AnswerStatus(answer: answer, computer: model.pairing?.computer ?? "your computer",
                                     marking: model.marking.contains(sitting.id))
                        ForEach(Array(answer.feedback.enumerated()), id: \.offset) { _, item in
                            FeedbackRow(item: item)
                        }
                        if let question, answer.mark != nil, question.modelAnswer != nil || !question.criteria.isEmpty {
                            DisclosureGroup("Model answer") {
                                VStack(alignment: .leading, spacing: 8) {
                                    if let modelAnswer = question.modelAnswer { Text(modelAnswer).textSelection(.enabled) }
                                    ForEach(Array(question.criteria.enumerated()), id: \.offset) { _, c in
                                        HStack(alignment: .firstTextBaseline) {
                                            Text("•")
                                            Text(c.point)
                                            Spacer()
                                            if let marks = c.marks { Text(formatMark(marks)).foregroundStyle(.secondary) }
                                        }
                                        .font(.callout)
                                    }
                                }
                                .padding(.top, 4)
                            }
                        }
                    } header: {
                        HStack {
                            Text("Question \(index + 1)")
                            Spacer()
                            if let mark = answer.mark { Text("\(formatMark(mark)) / 10").monospacedDigit() }
                        }
                    }
                }
            }
            .navigationTitle(lecture.map { "L\($0.ordinal) sitting" } ?? "Sitting")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await model.sync() }
        } else {
            ContentUnavailableView("This sitting isn't here any more", systemImage: "questionmark.folder")
        }
    }

    private func headline(_ sitting: SittingRecord) -> String {
        if model.marking.contains(sitting.id) { return "Marking on this phone…" }
        if sitting.waiting == 0 { return "Marked" }
        if !sitting.synced { return "Saved on this phone · sync to send it to \(model.pairing?.computer ?? "your computer")" }
        return "\(sitting.waiting) answer\(sitting.waiting == 1 ? "" : "s") waiting to be marked"
    }
}

private struct AnswerStatus: View {
    let answer: SittingRecord.Answer
    let computer: String
    let marking: Bool

    var body: some View {
        if let note = answer.note, answer.mark == nil {
            Label(note, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
        } else if answer.mark == nil {
            switch answer.status {
            case .waitingToSync where marking:
                Label("Marking…", systemImage: "hourglass").font(.caption).foregroundStyle(.secondary)
            case .waitingToSync:
                Label("\(computer) marks this after you sync.", systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption).foregroundStyle(.secondary)
            case .markingOnComputer:
                Label("In \(computer)'s queue to be marked. Sync again to see the mark.", systemImage: "hourglass")
                    .font(.caption).foregroundStyle(.secondary)
            case .unmarked, .marked:
                Label("Not marked: Lockin on \(computer) is in copy & paste mode.", systemImage: "doc.on.clipboard")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct FeedbackRow: View {
    let item: FeedbackItem

    var body: some View {
        Label {
            Text(item.text).font(.callout).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: icon).foregroundStyle(color)
        }
    }

    private var icon: String {
        switch item.kind {
        case "good": return "checkmark.circle.fill"
        case "wrong": return "xmark.circle.fill"
        case "missed": return "circle.dashed"
        default: return "text.bubble"
        }
    }

    private var color: Color {
        switch item.kind {
        case "good": return .green
        case "wrong": return .red
        case "missed": return .orange
        default: return .secondary
        }
    }
}
