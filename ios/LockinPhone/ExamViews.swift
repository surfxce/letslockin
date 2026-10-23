import LockinKit
import SwiftUI

private let letters = ["A", "B", "C", "D", "E"]

/// Exams on the phone: set one from your lectures, sit it, see how it went.
struct ExamTab: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            List {
                if let draft = model.examDraft {
                    Section {
                        NavigationLink(value: Route.examSitting) {
                            let left = draft.unanswered
                            Label("Continue \(draft.title) · \(draft.items.count - left.mcqs - left.laqs) of \(draft.items.count) answered",
                                  systemImage: "pencil.and.list.clipboard")
                        }
                    }
                }
                Section {
                    NavigationLink(value: Route.examSetup) {
                        Label("New exam", systemImage: "plus.circle")
                    }
                } footer: {
                    Text("Mixed questions from the lectures you choose, timed if you like. Multiple choice is marked straight away; long answers are marked like any sitting and count towards each lecture's drill score.")
                }
                Section {
                    if let viva = model.vivaDraft {
                        NavigationLink(value: Route.vivaRoom) {
                            Label("Continue \(viva.title) · question \(min(viva.current + 1, viva.plan.count)) of \(viva.plan.count)",
                                  systemImage: "mic.circle")
                        }
                    }
                    NavigationLink(value: Route.vivaSetup) {
                        Label("New viva", systemImage: "mic")
                    }
                    ForEach(model.vivaHistory.prefix(10)) { viva in
                        NavigationLink(value: Route.vivaResult(viva.id)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(viva.title)
                                Text(viva.submittedAt.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Viva")
                } footer: {
                    Text("An oral exam: answer out loud, and the examiner follows up on what you left out. Marked like any sitting.")
                }
                if !model.examHistory.isEmpty {
                    Section("Past exams") {
                        ForEach(model.examHistory) { exam in
                            NavigationLink(value: Route.examResult(exam.id)) {
                                ExamRow(exam: exam)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Exam")
            .refreshable { await model.sync() }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { SyncBadge() } }
            .lockinRoutes()
        }
    }
}

private struct ExamRow: View {
    @Environment(AppModel.self) private var model
    let exam: PhoneExam

    var body: some View {
        let score = exam.mcqScore(model.snapshot?.mcqs ?? [])
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(exam.title)
                Text(exam.submittedAt.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if score.total > 0 {
                Text("\(Int((Double(score.right) / Double(score.total) * 100).rounded()))%")
                    .font(.callout.monospacedDigit().weight(.semibold))
            }
        }
    }
}

/// Choosing what an exam covers and how long it is.
struct ExamSetupView: View {
    @Environment(AppModel.self) private var model
    @State private var chosen: Set<String>?
    @State private var mcqs = 10
    @State private var laqs = 3
    @State private var timed = true
    @State private var minutes: Int?
    @State private var focus = ExamFocus.mixed
    @State private var started = false
    @State private var nothing = false

    var body: some View {
        if started {
            ExamSittingView()
        } else if let source = model.examSource {
            let usable = model.courses.flatMap { model.lectures(in: $0.id) }.filter { !source.laqs(of: $0).isEmpty || !source.mcqs(of: $0.id).isEmpty }
            let selected = chosen ?? Set(usable.map(\.id))
            let pool = (
                mcqs: usable.filter { selected.contains($0.id) }.reduce(0) { $0 + source.mcqs(of: $1.id).count },
                laqs: usable.filter { selected.contains($0.id) }.reduce(0) { $0 + source.laqs(of: $1).count } + source.linking(selected).count
            )
            Form {
                Section {
                    Stepper("Multiple choice: \(mcqs)", value: $mcqs, in: 0...40)
                    Stepper("Long answers: \(laqs)", value: $laqs, in: 0...10)
                    Picker("Which questions", selection: $focus) {
                        ForEach(ExamFocus.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Questions")
                } footer: {
                    Text(pool.mcqs + pool.laqs == 0
                        ? "The lectures chosen have nothing to ask yet."
                        : "\(pool.mcqs) multiple choice and \(pool.laqs) long answers to choose from. \(focus == .weak ? "Questions you did worst on, and your weakest lectures, come first." : "Spread across every lecture chosen, like the real exam.")")
                }
                Section("Time") {
                    Toggle("Timed", isOn: $timed)
                    if timed {
                        Stepper("\(minutes ?? suggested(pool)) minutes",
                                value: Binding(get: { minutes ?? suggested(pool) }, set: { minutes = $0 }),
                                in: 5...300, step: 5)
                    }
                }
                ForEach(model.courses) { course in
                    let lectures = model.lectures(in: course.id).filter { lecture in usable.contains { $0.id == lecture.id } }
                    if !lectures.isEmpty {
                        Section {
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
                                        Text("\(source.laqs(of: lecture).count) LAQs · \(source.mcqs(of: lecture.id).count) MCQs")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        } header: {
                            Text(course.code)
                        }
                    }
                }
                Section {
                    Button {
                        let ok = model.startExam(lectureIds: selected, mcqs: mcqs, laqs: laqs, focus: focus,
                                                 timeLimitMin: timed ? (minutes ?? suggested(pool)) : nil)
                        if ok { started = true } else { nothing = true }
                    } label: {
                        Label("Start exam", systemImage: "play.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selected.isEmpty || pool.mcqs + pool.laqs == 0 || mcqs + laqs == 0)
                } footer: {
                    Text("Closed book. Multiple choice first, then long answers.")
                }
            }
            .navigationTitle("New exam")
            .navigationBarTitleDisplayMode(.inline)
            .alert("Nothing to ask", isPresented: $nothing) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("The lectures you chose have no questions of the kinds asked for yet.")
            }
        } else {
            ContentUnavailableView("Sync first", systemImage: "arrow.triangle.2.circlepath",
                                   description: Text("Exams are set from your lectures as last synced."))
        }
    }

    private func suggested(_ pool: (mcqs: Int, laqs: Int)) -> Int {
        suggestedExamMinutes(mcqs: min(mcqs, pool.mcqs), laqs: min(laqs, pool.laqs))
    }
}

/// Sitting an exam: multiple choice, then long answers, with the time left at the top.
struct ExamSittingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var submitted: String?
    @State private var confirming = false
    @FocusState private var focused: String?

    var body: some View {
        if let submitted {
            ExamResultView(examId: submitted)
        } else if let draft = model.examDraft {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 26) {
                    if !draft.mcqs.isEmpty {
                        Text("Section A · Multiple choice").font(.title3.weight(.semibold))
                        ForEach(Array(draft.mcqs.enumerated()), id: \.element.id) { index, item in
                            if let mcq = item.mcqId.flatMap({ model.mcq($0) }) {
                                McqQuestion(number: index + 1, mcq: mcq, choice: item.choice) { model.setExamChoice(item.id, $0) }
                            }
                        }
                    }
                    if !draft.laqs.isEmpty {
                        Text("Section \(draft.mcqs.isEmpty ? "A" : "B") · Long answers").font(.title3.weight(.semibold))
                        ForEach(Array(draft.laqs.enumerated()), id: \.element.id) { index, item in
                            let question = model.lecture(item.lectureId)?.questions.first { $0.id == item.questionId }
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Question \(index + 1)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                Text(question?.stem ?? "This question isn't on the phone any more.")
                                    .font(.body.weight(.medium))
                                    .fixedSize(horizontal: false, vertical: true)
                                TextField("Your answer", text: Binding(get: { model.examAnswer(item.id) }, set: { model.setExamAnswer(item.id, $0) }),
                                          axis: .vertical)
                                    .lineLimit(6...40)
                                    .focused($focused, equals: item.id)
                                    .padding(10)
                                    .background(RoundedRectangle(cornerRadius: 10).fill(Color(.secondarySystemBackground)))
                            }
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
            .navigationTitle(draft.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { ExamClock(startedAt: draft.startedAt, limitMin: draft.timeLimitMin) }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focused = nil }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Discard this exam", role: .destructive) {
                            model.discardExam()
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
                    submitted = model.handInExam()
                }
                Button("Keep going", role: .cancel) {}
            } message: {
                Text(model.markingNote)
            }
        } else {
            ContentUnavailableView("No exam in progress", systemImage: "checklist")
        }
    }

    private func handInTitle(_ draft: ExamDraft) -> String {
        let left = draft.unanswered
        var parts: [String] = []
        if left.mcqs > 0 { parts.append("\(left.mcqs) multiple choice unanswered") }
        if left.laqs > 0 { parts.append("\(left.laqs) long answer\(left.laqs == 1 ? "" : "s") blank (scored 0)") }
        return parts.isEmpty ? "Hand in your exam?" : "Hand in with \(parts.joined(separator: " and "))?"
    }
}

/// Time left, or taken when untimed; past the limit it counts on in red.
private struct ExamClock: View {
    let startedAt: Date
    let limitMin: Int?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let elapsed = context.date.timeIntervalSince(startedAt)
            if let limitMin {
                let left = Double(limitMin * 60) - elapsed
                Text(left >= 0 ? "\(clock(left)) left" : "\(clock(-left)) over")
                    .font(.callout.monospacedDigit().weight(.semibold))
                    .foregroundStyle(left < 0 ? Color.red : left < 300 ? Color.orange : Color.primary)
            } else {
                Text(clock(elapsed)).font(.callout.monospacedDigit().weight(.semibold))
            }
        }
    }

    private func clock(_ seconds: TimeInterval) -> String {
        let s = Int(seconds)
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s % 3600 / 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }
}

private struct McqQuestion: View {
    let number: Int
    let mcq: Mcq
    let choice: Int?
    let choose: (Int?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Question \(number)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(mcq.stem).font(.body.weight(.medium)).fixedSize(horizontal: false, vertical: true)
            ForEach(Array(mcq.options.enumerated()), id: \.offset) { index, option in
                Button {
                    choose(choice == index ? nil : index)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(letters[min(index, letters.count - 1)])
                            .font(.caption.weight(.bold))
                            .frame(width: 24, height: 24)
                            .background(Circle().fill(choice == index ? Color.accentColor : Color(.tertiarySystemFill)))
                            .foregroundStyle(choice == index ? Color.white : Color.secondary)
                        Text(option).frame(maxWidth: .infinity, alignment: .leading).multilineTextAlignment(.leading)
                    }
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10).stroke(choice == index ? Color.accentColor : Color(.separator)))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(choice == index ? .isSelected : [])
            }
        }
    }
}

/// How an exam went: multiple choice at once, long answers as they're marked.
struct ExamResultView: View {
    @Environment(AppModel.self) private var model
    let examId: String

    var body: some View {
        if let exam = model.pastExam(examId) {
            let mcqs = model.snapshot?.mcqs ?? []
            let score = exam.mcqScore(mcqs)
            let answers = laqAnswers(exam)
            let marks = answers.compactMap { $0.answer?.mark }
            List {
                Section {
                    if score.total > 0 {
                        LabeledContent("Multiple choice", value: "\(score.right) of \(score.total) · \(Int((Double(score.right) / Double(score.total) * 100).rounded()))%")
                    }
                    if !answers.isEmpty {
                        LabeledContent("Long answers") {
                            if marks.count == answers.count, let mean = geometricMean(marks) {
                                Text(String(format: "%.1f / 10", mean)).monospacedDigit()
                            } else {
                                Text("\(marks.count) of \(answers.count) marked").foregroundStyle(.secondary)
                            }
                        }
                    }
                    LabeledContent("Took", value: Duration.seconds(exam.submittedAt.timeIntervalSince(exam.startedAt)).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated)))
                } header: {
                    Text(exam.submittedAt.formatted(date: .abbreviated, time: .shortened))
                }
                let mcqItems = exam.items.filter { $0.kind == "MCQ" }
                if !mcqItems.isEmpty {
                    Section("Multiple choice") {
                        ForEach(Array(mcqItems.enumerated()), id: \.element.id) { index, item in
                            if let mcq = mcqs.first(where: { $0.id == item.mcqId }) {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        Text("Question \(index + 1)").font(.caption.weight(.semibold))
                                        Spacer()
                                        Label(item.choice == mcq.answer ? "Right" : item.choice == nil ? "Not answered" : "Wrong",
                                              systemImage: item.choice == mcq.answer ? "checkmark.circle.fill" : "xmark.circle.fill")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(item.choice == mcq.answer ? Color.green : Color.red)
                                    }
                                    Text(mcq.stem).font(.callout.weight(.medium))
                                    Text("Answer: \(letters[min(mcq.answer, 4)]). \(mcq.options[mcq.answer])").font(.callout)
                                    if let choice = item.choice, choice != mcq.answer, choice < mcq.options.count {
                                        Text("You chose \(letters[min(choice, 4)]). \(mcq.options[choice])").font(.callout).foregroundStyle(.red)
                                    }
                                    Text(mcq.explanation).font(.caption).foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }
                }
                if !answers.isEmpty {
                    ForEach(Array(answers.enumerated()), id: \.offset) { index, entry in
                        Section {
                            if let question = entry.question { Text(question.stem).font(.body.weight(.medium)) }
                            if let answer = entry.answer {
                                Text(answer.answerText.isEmpty ? "Left blank." : answer.answerText)
                                    .foregroundStyle(answer.answerText.isEmpty ? .secondary : .primary)
                                    .textSelection(.enabled)
                                AnswerStatus(answer: answer, computer: model.pairing?.computer ?? "your computer",
                                             marking: entry.sittingId.map { model.marking.contains($0) } ?? false)
                                ForEach(Array(answer.feedback.enumerated()), id: \.offset) { _, item in
                                    FeedbackRow(item: item)
                                }
                            }
                        } header: {
                            HStack {
                                Text("Long answer \(index + 1)")
                                Spacer()
                                if let mark = entry.answer?.mark { Text("\(formatMark(mark)) / 10").monospacedDigit() }
                            }
                        }
                    }
                }
            }
            .navigationTitle(exam.title)
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await model.sync() }
        } else {
            ContentUnavailableView("This exam isn't here any more", systemImage: "questionmark.folder")
        }
    }

    /// Each long answer as the lecture's sittings now show it: marked, waiting, or on its way.
    private func laqAnswers(_ exam: PhoneExam) -> [(question: Question?, answer: SittingRecord.Answer?, sittingId: String?)] {
        exam.items.filter { $0.kind == "LAQ" }.map { item in
            guard let responseId = item.responseId,
                  let sitting = exam.sittings.first(where: { s in s.responses.contains { $0.id == responseId } })
            else { return (nil, nil, nil) }
            let question = model.lecture(sitting.lectureId)?.questions.first { $0.id == item.questionId }
            let record = model.sittings(for: sitting.lectureId).first { $0.id == sitting.id }
            return (question, record?.answers.first { $0.id == responseId }, sitting.id)
        }
    }
}
