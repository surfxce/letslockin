import AppKit
import Combine
import Foundation
import GRDB
import LockinCore
import SwiftUI

// MARK: - Sidebar Selection

enum SidebarItem: Hashable {
    case allLectures
    case course(String)
}

// MARK: - View Model / Store

struct LectureSummaryItem: Identifiable, Equatable {
    var id: String { lecture.id }
    var lecture: Lecture
    var courseCode: String
    var moduleTitle: String?
    var ordinal: Int
    var questionCount: Int
    var lastScore: Double?
    var review: ScheduledReview
    var due: DueStatus
}

@MainActor
final class AppStore: ObservableObject {
    let database: LockinDatabase
    @Published var courses: [Course] = []
    @Published var lectures: [LectureSummaryItem] = []
    @Published var runningJob: Job? = nil
    @Published var selection: SidebarItem? = nil
    @Published var selectedLectureId: String? = nil
    @Published var errorMessage: String? = nil

    private var cancellable: AnyDatabaseCancellable?

    init(database: LockinDatabase) {
        self.database = database
        startObserving()
    }

    private func startObserving() {
        let observation = ValueObservation.tracking { db -> ([Course], [LectureSummaryItem], Job?) in
            let courses = try Course.order(Column("createdAt").asc).fetchAll(db)
            let courseById = Dictionary(uniqueKeysWithValues: courses.map { ($0.id, $0) })
            let modules = try Module.fetchAll(db)
            let moduleById = Dictionary(uniqueKeysWithValues: modules.map { ($0.id, $0) })
            let rawLectures = try Lecture.order(Column("deliveredOn").asc, Column("createdAt").asc).fetchAll(db)
            let questions = try Question.fetchAll(db)
            let attempts = try Attempt.fetchAll(db)
            let running = try Job
                .filter(Column("status") == JobStatus.running.rawValue)
                .order(Column("startedAt").desc)
                .fetchOne(db)

            let questionsByLecture = Dictionary(grouping: questions, by: \.lectureId)
            let attemptsByLecture = Dictionary(grouping: attempts, by: \.lectureId)

            var ordinalsByCourse: [String: Int] = [:]
            let now = Date()

            let items: [LectureSummaryItem] = rawLectures.map { lec in
                let ord = (ordinalsByCourse[lec.courseId] ?? 0) + 1
                ordinalsByCourse[lec.courseId] = ord

                let course = courseById[lec.courseId]
                let mod = lec.moduleId.flatMap { moduleById[$0] }
                let qs = questionsByLecture[lec.id] ?? []
                let completedAttempts = (attemptsByLecture[lec.id] ?? [])
                    .compactMap { att -> Sitting? in
                        guard let score = att.geometricMean else { return nil }
                        return Sitting(at: att.completedAt ?? att.sittingDate, score: score)
                    }
                    .sorted { $0.at < $1.at }

                let readySince = qs.map(\.createdAt).min()
                let rev = nextReview(
                    sittings: completedAttempts,
                    readySince: readySince,
                    examDate: course?.examDate
                )
                let due = dueState(dueAt: rev.dueAt, now: now)

                return LectureSummaryItem(
                    lecture: lec,
                    courseCode: course?.code ?? "COURSE",
                    moduleTitle: mod?.title,
                    ordinal: ord,
                    questionCount: qs.count,
                    lastScore: completedAttempts.last?.score,
                    review: rev,
                    due: due
                )
            }

            return (courses, items, running)
        }

        cancellable = observation.start(
            in: database.reader,
            onError: { [weak self] err in
                Task { @MainActor in
                    self?.errorMessage = err.localizedDescription
                }
            },
            onChange: { [weak self] (courses, items, running) in
                Task { @MainActor in
                    guard let self else { return }
                    self.courses = courses
                    self.lectures = items
                    self.runningJob = running
                    if self.selection == nil {
                        if courses.count == 1, let only = courses.first {
                            self.selection = .course(only.id)
                        } else if !courses.isEmpty {
                            self.selection = .allLectures
                        }
                    }
                }
            }
        )
    }

    func createCourse(code: String, title: String, examDate: Date?) {
        let cleanCode = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanCode.isEmpty, !cleanTitle.isEmpty else { return }
        do {
            var course = Course(code: cleanCode, title: cleanTitle, examDate: examDate)
            try database.writer.write { db in
                try course.insert(db)
            }
            selection = .course(course.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - App Entry

@main
struct LockinApp: App {
    @StateObject private var store: AppStore

    init() {
        let db = (try? LockinDatabase()) ?? (try! LockinDatabase.inMemory())
        _store = StateObject(wrappedValue: AppStore(database: db))
    }

    var body: some Scene {
        WindowGroup("Lockin") {
            RootView(store: store)
                .frame(minWidth: 880, minHeight: 580)
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("Open Data Folder") {
                    NSWorkspace.shared.open(LockinPaths.dataDirectory)
                }
                .keyboardShortcut("O", modifiers: [.command, .shift])
            }
        }
    }
}

// MARK: - Root Skeleton & Empty States

struct RootView: View {
    @ObservedObject var store: AppStore
    @State private var showingNewCourse = false

    var body: some View {
        Group {
            if store.courses.isEmpty {
                WelcomeEmptyStateView(onAddCourse: { showingNewCourse = true })
            } else {
                NavigationSplitView {
                    SidebarView(store: store, onAddCourse: { showingNewCourse = true })
                        .navigationSplitViewColumnWidth(min: 210, ideal: 240, max: 300)
                } detail: {
                    CourseDetailSkeletonView(store: store)
                }
            }
        }
        .sheet(isPresented: $showingNewCourse) {
            NewCourseSheet(onSave: { code, title, examDate in
                store.createCourse(code: code, title: title, examDate: examDate)
            })
        }
    }
}

struct SidebarView: View {
    @ObservedObject var store: AppStore
    var onAddCourse: () -> Void

    var body: some View {
        List(selection: $store.selection) {
            if store.courses.count > 1 {
                Label("All Lectures", systemImage: "tray.full")
                    .tag(SidebarItem.allLectures)
            }

            Section("Courses") {
                ForEach(store.courses) { course in
                    let count = store.lectures.filter { $0.lecture.courseId == course.id }.count
                    HStack {
                        Text(course.code)
                            .font(.system(.subheadline, weight: .semibold))
                        Text(course.title)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer()
                        if count > 0 {
                            Text("\(count)")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .tag(SidebarItem.course(course.id))
                }

                Button(action: onAddCourse) {
                    Label("New Course…", systemImage: "plus")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 4) {
                Divider()
                if let job = store.runningJob {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                        Text(job.stage.flatMap(Stage.init(rawValue:))?.label ?? job.kind.rawValue)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
                }
                Text(URL(fileURLWithPath: store.database.path).lastPathComponent)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .help(store.database.path)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
        }
    }
}

struct WelcomeEmptyStateView: View {
    var onAddCourse: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("📚")
                .font(.system(size: 40))
            Text("Welcome to Lockin")
                .font(.system(size: 28, weight: .bold))
            Text("Lockin turns your lecture recordings and slides into a summary and long-answer questions for each lecture, marks your answers, and reminds you when each lecture is due again.")
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 10) {
                StepRow(number: "1", text: "Add a course, then point it at the folder your lecture files are in.")
                StepRow(number: "2", text: "Each lecture gets a summary and LAQs — automatically, or by copy and paste with any AI chat.")
                StepRow(number: "3", text: "Answer closed book, get marked, and come back when it is due.")
            }
            .padding(16)
            .background(Color.primary.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 8))

            HStack(spacing: 12) {
                Button(action: onAddCourse) {
                    Label("Add your first course", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
        }
        .frame(maxWidth: 540)
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct StepRow: View {
    let number: String
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(number)
                .font(.system(.callout, design: .rounded, weight: .bold))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.callout)
        }
    }
}

struct CourseDetailSkeletonView: View {
    @ObservedObject var store: AppStore

    private var activeCourse: Course? {
        if case .course(let id) = store.selection {
            return store.courses.first { $0.id == id }
        }
        return store.courses.count == 1 ? store.courses.first : nil
    }

    private var visibleLectures: [LectureSummaryItem] {
        if let active = activeCourse {
            return store.lectures.filter { $0.lecture.courseId == active.id }
        }
        return store.lectures
    }

    private var dueLectures: [LectureSummaryItem] {
        visibleLectures.filter { $0.due.state == .overdue || $0.due.state == .today }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            VStack(alignment: .leading, spacing: 6) {
                Text(activeCourse?.title ?? "Lectures")
                    .font(.system(size: 26, weight: .bold))
                HStack(spacing: 8) {
                    if let active = activeCourse {
                        Text(active.code)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.14))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                    Text("\(visibleLectures.count) \(visibleLectures.count == 1 ? "lecture" : "lectures")")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let exam = activeCourse?.examDate {
                        let status = dueState(dueAt: exam)
                        if let days = status.days {
                            Text(days >= 0 ? "· exam in \(days) \(days == 1 ? "day" : "days")" : "· exam has passed")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 18)

            Divider()

            if visibleLectures.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "folder.badge.plus")
                        .font(.system(size: 32))
                        .foregroundStyle(.tertiary)
                    Text("No lectures in \(activeCourse?.code ?? "any course") yet.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(visibleLectures) { item in
                    HStack(spacing: 12) {
                        Text("L\(item.ordinal)")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(width: 32, alignment: .leading)

                        if activeCourse == nil {
                            Text(item.courseCode)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(Color.secondary.opacity(0.15))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.lecture.title)
                                .font(.body.weight(.medium))
                            if let mod = item.moduleTitle {
                                Text(mod)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        Spacer()

                        if let score = item.lastScore {
                            Text(String(format: "%.1f", roundMark(score, dp: 1)))
                                .font(.system(.caption, design: .monospaced, weight: .semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(scoreColor(score).opacity(0.16))
                                .foregroundStyle(scoreColor(score))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }

                        statusBadge(for: item)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    @ViewBuilder
    private func statusBadge(for item: LectureSummaryItem) -> some View {
        switch item.due.state {
        case .overdue:
            Text("Overdue")
                .font(.caption)
                .foregroundStyle(.red)
        case .today:
            Text("Due today")
                .font(.caption)
                .foregroundStyle(.orange)
        case .soon:
            if let d = item.due.days {
                Text("In \(d)d")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .later:
            if let d = item.due.days {
                Text("In \(d)d")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        case .none:
            Text(item.lecture.summaryMd != nil ? "Summary ready" : "To prepare")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private func scoreColor(_ score: Double) -> Color {
        if score >= 7 { return .green }
        if score >= 5 { return .orange }
        return .red
    }
}

struct NewCourseSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var title = ""
    @State private var hasExamDate = false
    @State private var examDate = Date().addingTimeInterval(30 * 86_400)

    var onSave: (String, String, Date?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("New Course")
                .font(.headline)

            Form {
                TextField("Code (e.g. BIOL3010)", text: $code)
                TextField("Title (e.g. Molecular Genetics)", text: $title)
                Toggle("Has exam date", isOn: $hasExamDate)
                if hasExamDate {
                    DatePicker("Exam date", selection: $examDate, displayedComponents: .date)
                }
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Add Course") {
                    onSave(code, title, hasExamDate ? examDate : nil)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty || title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 380)
    }
}
