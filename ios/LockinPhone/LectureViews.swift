import LockinKit
import SwiftUI

struct LectureRow: View {
    @Environment(AppModel.self) private var model
    let lecture: Lecture

    var body: some View {
        let standing = model.standing(of: lecture)
        let waiting = model.sittings(for: lecture.id).first.map { $0.waiting > 0 } ?? false
        let due = model.dueCount(for: lecture.id)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("L\(lecture.ordinal)")
                .font(.caption.monospacedDigit().weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(minWidth: 28, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(lecture.title).lineLimit(2)
                HStack(spacing: 8) {
                    if let module = lecture.module { Text(module).lineLimit(1) }
                    if lecture.summaryHtml == nil { Text("No summary yet") }
                    if standing.drills > 0 { Text("\(standing.drills)× drilled") }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 4) {
                if let score = standing.score {
                    ScorePill(score: score)
                } else if waiting {
                    Image(systemName: "hourglass").font(.caption).foregroundStyle(.secondary)
                }
                if due > 0 {
                    Text("\(due) due").font(.caption2.weight(.medium)).foregroundStyle(.tint)
                }
            }
        }
    }
}

struct ScorePill: View {
    let score: Double

    var body: some View {
        Text(String(format: "%.1f", score))
            .font(.caption.monospacedDigit().weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(tone.opacity(0.16)))
            .foregroundStyle(tone)
    }

    private var tone: Color {
        score >= 7 ? .green : score >= 5 ? .orange : .red
    }
}

/// A small sync indicator for toolbars: spinning while syncing, a dot when work waits to send.
struct SyncBadge: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.syncing {
            ProgressView()
        } else {
            Button {
                Task { await model.sync() }
            } label: {
                Image(systemName: model.syncError != nil ? "exclamationmark.arrow.triangle.2.circlepath" : "arrow.triangle.2.circlepath")
                    .overlay(alignment: .topTrailing) {
                        if model.unsentCount > 0 { Circle().fill(.orange).frame(width: 7, height: 7).offset(x: 3, y: -3) }
                    }
            }
            .accessibilityLabel("Sync now")
        }
    }
}

/// One lecture: its summary, its LAQs and its AK deck.
struct LectureView: View {
    @Environment(AppModel.self) private var model
    let lectureId: String
    @State private var tab = Tab.summary

    enum Tab: String, CaseIterable, Identifiable {
        case summary = "Summary"
        case laqs = "LAQs"
        case ak = "AK"
        var id: String { rawValue }
    }

    var body: some View {
        if let lecture = model.lecture(lectureId) {
            VStack(spacing: 0) {
                Picker("Show", selection: $tab) {
                    ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 8)
                switch tab {
                case .summary:
                    if let html = lecture.summaryHtml {
                        HTMLView(html: html, images: model.images)
                    } else {
                        ContentUnavailableView("No summary yet", systemImage: "doc.text",
                                               description: Text("Prepare this lecture on your computer, then sync."))
                    }
                case .laqs:
                    LAQList(lecture: lecture)
                case .ak:
                    DeckSummary(lecture: lecture)
                }
            }
            .navigationTitle("L\(lecture.ordinal) · \(lecture.title)")
            .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("This lecture isn't here any more", systemImage: "questionmark.folder")
        }
    }
}

/// A lecture's sittings: start or continue one, and the marks of the ones before.
struct LAQList: View {
    @Environment(AppModel.self) private var model
    let lecture: Lecture

    var body: some View {
        List {
            Section {
                if !lecture.questions.contains(where: \.isOwn) {
                    Text("No LAQs yet. Write them on your computer, then sync.").foregroundStyle(.secondary)
                } else if let draft = model.draft(for: lecture.id) {
                    NavigationLink(value: Route.sitting(lectureId: lecture.id)) {
                        Label("Continue your sitting · \(draft.answers.values.filter { !$0.isEmpty }.count) of \(draft.questionIds.count) answered",
                              systemImage: "pencil.and.list.clipboard")
                    }
                } else {
                    let count = lecture.nextSitting.isEmpty ? lecture.questions.filter(\.isOwn).count : lecture.nextSitting.count
                    NavigationLink(value: Route.sitting(lectureId: lecture.id)) {
                        Label("Start a sitting · \(count) question\(count == 1 ? "" : "s"), closed book", systemImage: "pencil.line")
                    }
                }
            } footer: {
                Text(model.markingNote)
            }
            let sittings = model.sittings(for: lecture.id)
            if !sittings.isEmpty {
                Section("Sittings") {
                    ForEach(sittings) { sitting in
                        NavigationLink(value: Route.result(lectureId: lecture.id, sittingId: sitting.id)) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(sitting.date.formatted(date: .abbreviated, time: .shortened))
                                    Text(status(of: sitting)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if let score = sitting.score { ScorePill(score: score) }
                            }
                        }
                    }
                }
            }
        }
    }

    private func status(of sitting: SittingRecord) -> String {
        let n = sitting.answers.count
        let answered = "\(n) question\(n == 1 ? "" : "s")"
        if model.marking.contains(sitting.id) { return "\(answered) · marking…" }
        if sitting.waiting == 0 { return answered }
        return sitting.synced ? "\(answered) · \(sitting.waiting) waiting for marks" : "\(answered) · not synced yet"
    }
}
