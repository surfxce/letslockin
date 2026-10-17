import AppKit
import Foundation
import GRDB
import LockinCore
import Observation
import SwiftUI

@main
struct LockinApp: App {
    @State private var store = AppStore.openDefault()

    var body: some Scene {
        WindowGroup("Lockin") {
            RootView(store: store)
                .frame(minWidth: 960, minHeight: 620)
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

// MARK: - Tone Color Helper

private func toneSwiftUIColor(_ tone: Tone) -> Color {
    switch tone {
    case .gray: return .secondary
    case .brown: return .brown
    case .orange: return .orange
    case .yellow: return Color(red: 0.78, green: 0.58, blue: 0.05)
    case .green: return .green
    case .blue: return .blue
    case .purple: return .purple
    case .pink: return .pink
    case .red: return .red
    }
}

private struct TagBadge: View {
    let text: String
    var tone: Tone = .gray

    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(toneSwiftUIColor(tone).opacity(0.15))
            .foregroundStyle(toneSwiftUIColor(tone))
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }
}

private struct ScoreTagView: View {
    let score: Double?
    var prev: Double? = nil

    var body: some View {
        if let score {
            HStack(spacing: 4) {
                TagBadge(text: formatScore(score), tone: scoreTone(score))
                if let prev {
                    let diff = score - prev
                    if abs(diff) >= 0.05 {
                        Text(String(format: "%@%.1f", diff > 0 ? "+" : "", diff))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(diff > 0 ? .green : .red)
                    }
                }
            }
        } else {
            Text("—")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }
}

private struct StatusTagView: View {
    let status: LectureStatus
    var stageLabel: String? = nil
    var queuePosition: Int? = nil
    var error: String? = nil

    private var tone: Tone {
        switch status {
        case .empty, .todo: return .gray
        case .queued: return .blue
        case .working: return .purple
        case .failed: return .red
        case .summary: return .yellow
        case .ready: return .blue
        case .practised: return .green
        }
    }

    private var displayText: String {
        if status == .working, let stageLabel {
            return stageLabel
        }
        if status == .queued, let queuePosition {
            return "Queued #\(queuePosition)"
        }
        return status.label
    }

    var body: some View {
        TagBadge(text: displayText, tone: tone)
            .help(error ?? displayText)
    }
}

// MARK: - Root View & Database Error Screen

struct RootView: View {
    @Bindable var store: AppStore
    @State private var showingNewCourse = false
    @State private var newLectureCourseId: String? = nil

    var body: some View {
        Group {
            if let openErr = store.databaseOpenError {
                DatabaseErrorView(
                    path: store.databasePath,
                    errorMessage: openErr,
                    onRetry: { store.retryOpenDatabase() }
                )
            } else if store.courses.isEmpty {
                WelcomeEmptyStateView(onAddCourse: { showingNewCourse = true })
            } else {
                NavigationSplitView {
                    SidebarView(store: store, onAddCourse: { showingNewCourse = true })
                        .navigationSplitViewColumnWidth(min: 210, ideal: 240, max: 300)
                } detail: {
                    if let importCourseId = store.importingCourseId,
                       let course = store.courses.first(where: { $0.id == importCourseId }) {
                        ImportFolderView(
                            store: store,
                            course: course,
                            onDone: { store.importingCourseId = nil }
                        )
                    } else if let lectureId = store.selectedLectureId,
                              let detail = store.loadLectureDetail(id: lectureId) {
                        LectureDetailView(
                            store: store,
                            detail: detail,
                            onBack: { store.selectedLectureId = nil }
                        )
                    } else {
                        LectureLibraryView(
                            store: store,
                            onNewLecture: { courseId in newLectureCourseId = courseId }
                        )
                    }
                }
            }
        }
        .sheet(isPresented: $showingNewCourse) {
            NewCourseSheet { code, title, examDate in
                store.createCourse(code: code, title: title, examDate: examDate)
            }
        }
        .sheet(
            isPresented: Binding(
                get: { newLectureCourseId != nil },
                set: { if !$0 { newLectureCourseId = nil } }
            )
        ) {
            if let cid = newLectureCourseId {
                NewLectureSheet(store: store, courseId: cid)
            }
        }
    }
}

struct DatabaseErrorView: View {
    let path: String
    let errorMessage: String
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Could not open Lockin's database", systemImage: "exclamationmark.triangle.fill")
                .font(.title2.weight(.bold))
                .foregroundStyle(.red)

            Text("Lockin stopped instead of opening a temporary database, so your existing courses and lectures are never overwritten or lost.")
                .font(.body)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 6) {
                Text("Database file")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(path)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                Text(errorMessage)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .padding(.top, 4)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 8))

            HStack(spacing: 12) {
                Button(action: onRetry) {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button("Show in Finder") {
                    NSWorkspace.shared.selectFile(path, inFileViewerRootedAtPath: (path as NSString).deletingLastPathComponent)
                }
                .controlSize(.large)
            }
        }
        .frame(maxWidth: 540)
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Sidebar

struct SidebarView: View {
    @Bindable var store: AppStore
    var onAddCourse: () -> Void

    var body: some View {
        List(selection: Binding(
            get: { store.selection },
            set: { newValue in
                store.selection = newValue
                store.selectedLectureId = nil
                store.importingCourseId = nil
            }
        )) {
            if store.courses.count > 1 {
                Label("All Lectures", systemImage: "tray.full")
                    .tag(SidebarItem.allLectures)
            }

            Section("Courses") {
                ForEach(store.courses) { course in
                    let count = store.lectureRows.filter { $0.courseId == course.id }.count
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
                        Text(job.stage.flatMap { Stage(rawValue: $0)?.label } ?? job.kind.rawValue)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
                }
                Text(URL(fileURLWithPath: store.databasePath).lastPathComponent)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .help(store.databasePath)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
        }
    }
}

// MARK: - Welcome Empty State

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

// MARK: - Chunk 4: Lecture Library View

struct LectureLibraryView: View {
    @Bindable var store: AppStore
    var onNewLecture: (String) -> Void

    @State private var searchQuery = ""

    private var activeCourse: Course? { store.activeCourse }
    private var rows: [LectureRow] { store.visibleLectureRows }
    private var due: [LectureRow] { store.visibleDueRows }
    private var storageKey: String { activeCourse?.id ?? "all" }

    private var viewConfig: LectureTableViewConfig {
        store.viewConfig(for: storageKey)
    }

    private func updateView(_ transform: (inout LectureTableViewConfig) -> Void) {
        var next = viewConfig
        transform(&next)
        store.setViewConfig(next, for: storageKey)
    }

    private var toPrepareIds: [String] {
        rows.filter { $0.status == .todo || $0.status == .failed || $0.status == .summary }.map(\.id)
    }

    private var weakestPractised: LectureRow? {
        let practised = rows.filter { $0.lastScore != nil }
        guard practised.count > 1 else { return nil }
        return practised.min { ($0.lastScore ?? 10) < ($1.lastScore ?? 10) }
    }

    private var groups: [LectureGroup] {
        groupLectures(rows, query: searchQuery, view: viewConfig)
    }

    private var totalFilteredCount: Int {
        groups.reduce(0) { $0 + $1.rows.count }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(activeCourse?.title ?? "Lectures")
                            .font(.system(size: 26, weight: .bold))
                        HStack(spacing: 6) {
                            if let active = activeCourse {
                                TagBadge(text: active.code, tone: tagTone(active.code))
                                Text("· \(plural(rows.count, "lecture"))")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                if let exam = active.examDate {
                                    let d = daysUntil(exam)
                                    Text(d >= 0 ? "· exam in \(plural(d, "day"))" : "· exam has passed")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            } else {
                                Text("Every lecture across \(plural(store.courses.count, "course")), with how you are doing on each.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Spacer()
                    if let weakest = weakestPractised {
                        Button {
                            store.selectedLectureId = weakest.id
                        } label: {
                            HStack(spacing: 6) {
                                Text("Weakest: L\(weakest.ordinal)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                ScoreTagView(score: weakest.lastScore)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }

                if let notice = store.lastImportNotice {
                    HStack {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.blue)
                        Text(notice)
                            .font(.callout)
                        Spacer()
                        Button {
                            store.lastImportNotice = nil
                        } label: {
                            Image(systemName: "xmark")
                                .font(.caption)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(10)
                    .background(Color.blue.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }

                // Due for LAQs strip
                if !due.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Due for LAQs", systemImage: "bell.fill")
                            .font(.subheadline.weight(.semibold))
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(due.prefix(8)) { d in
                                    Button {
                                        store.selectedLectureId = d.id
                                    } label: {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(d.title)
                                                .font(.callout.weight(.medium))
                                                .lineLimit(1)
                                            HStack(spacing: 6) {
                                                let lbl = dueLabel(d.dueAt)
                                                TagBadge(text: lbl.text, tone: lbl.tone)
                                                if activeCourse == nil {
                                                    Text(d.courseCode)
                                                        .font(.caption)
                                                        .foregroundStyle(.secondary)
                                                }
                                                Text("L\(d.ordinal)")
                                                    .font(.caption.monospacedDigit())
                                                    .foregroundStyle(.secondary)
                                                if let s = d.lastScore {
                                                    ScoreTagView(score: s)
                                                }
                                            }
                                        }
                                        .padding(10)
                                        .background(Color.primary.opacity(0.04))
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }

                // Action Row + Toolbar
                HStack(spacing: 8) {
                    if let active = activeCourse {
                        Button {
                            store.importingCourseId = active.id
                        } label: {
                            Label("Import folder", systemImage: "folder.badge.plus")
                        }
                        .buttonStyle(.borderedProminent)

                        Button {
                            onNewLecture(active.id)
                        } label: {
                            Label("New lecture", systemImage: "plus")
                        }
                    } else if !store.courses.isEmpty {
                        Menu {
                            ForEach(store.courses) { c in
                                Button("Import into \(c.code) — \(c.title)") {
                                    store.importingCourseId = c.id
                                }
                            }
                        } label: {
                            Label("Import folder", systemImage: "folder.badge.plus")
                        }
                    }

                    if store.mode != "manual" && !toPrepareIds.isEmpty {
                        Button {
                            store.prepareLectures(toPrepareIds)
                        } label: {
                            Label("Prepare \(plural(toPrepareIds.count, "lecture"))", systemImage: "sparkles")
                        }
                    }

                    Spacer()

                    // Sort Preset Menu
                    Menu {
                        Button("Lecture date — first to last") { updateView { $0.sort = .date; $0.dir = .asc } }
                        Button("Lecture date — latest first") { updateView { $0.sort = .date; $0.dir = .desc } }
                        Button("Weakest first") { updateView { $0.sort = .score; $0.dir = .asc } }
                        Button("Strongest first") { updateView { $0.sort = .score; $0.dir = .desc } }
                        Button("Due soonest") { updateView { $0.sort = .due; $0.dir = .asc } }
                        Button("Name A–Z") { updateView { $0.sort = .name; $0.dir = .asc } }
                    } label: {
                        Label("Sort: \(viewConfig.sort.rawValue.capitalized) \(viewConfig.dir == .asc ? "↑" : "↓")", systemImage: "arrow.up.arrow.down")
                    }
                    .frame(width: 150)

                    // Group Menu
                    Menu {
                        ForEach(LectureGroupKey.allCases, id: \.self) { g in
                            if activeCourse == nil || g != .course {
                                Button(g.label) { updateView { $0.group = g } }
                            }
                        }
                    } label: {
                        Label(
                            viewConfig.group == .none ? "Group" : "Grouped by \(viewConfig.group.label.lowercased())",
                            systemImage: "square.grid.2x2"
                        )
                    }
                    .frame(width: 150)

                    TextField("Search lectures", text: $searchQuery)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 180)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)

            Divider()

            if rows.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "folder.badge.plus")
                        .font(.system(size: 32))
                        .foregroundStyle(.tertiary)
                    Text("No lectures in \(activeCourse?.code ?? "any course") yet.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                    if let active = activeCourse {
                        Button {
                            store.importingCourseId = active.id
                        } label: {
                            Label("Import a folder of lectures", systemImage: "folder")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // Table Header
                HStack(spacing: 10) {
                    sortHeader(.name, "Lecture", width: nil)
                    if activeCourse == nil {
                        sortHeader(.course, "Course", width: 85)
                    }
                    sortHeader(.module, "Module", width: 140)
                    sortHeader(.date, "Date", width: 100)
                    sortHeader(.status, "Status", width: 120)
                    sortHeader(.laqs, "LAQs", width: 55)
                    sortHeader(.score, "Score", width: 90)
                    sortHeader(.due, "Next review", width: 110)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .background(Color.primary.opacity(0.03))

                Divider()

                List {
                    ForEach(groups) { group in
                        if viewConfig.group != .none {
                            Section {
                                ForEach(group.rows) { row in
                                    lectureRowView(row)
                                }
                            } header: {
                                HStack(spacing: 8) {
                                    TagBadge(text: group.name, tone: tagTone(group.name))
                                    Text("\(group.rows.count)")
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                    if let avg = group.avg {
                                        Text("average")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                        TagBadge(text: formatScore(avg), tone: scoreTone(avg))
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        } else {
                            ForEach(group.rows) { row in
                                lectureRowView(row)
                            }
                        }
                    }
                }
                .listStyle(.inset)

                Divider()
                HStack {
                    if let active = activeCourse {
                        Button {
                            onNewLecture(active.id)
                        } label: {
                            Label("New lecture", systemImage: "plus")
                                .font(.caption)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("\(totalFilteredCount) of \(plural(rows.count, "lecture"))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
            }
        }
    }

    @ViewBuilder
    private func sortHeader(_ key: LectureSortKey, _ label: String, width: CGFloat?) -> some View {
        Button {
            updateView { $0.toggleSort(key) }
        } label: {
            HStack(spacing: 4) {
                Text(label)
                    .font(.caption.weight(viewConfig.sort == key ? .bold : .medium))
                    .foregroundStyle(viewConfig.sort == key ? .primary : .secondary)
                if viewConfig.sort == key {
                    Text(viewConfig.dir == .asc ? "↑" : "↓")
                        .font(.caption2.weight(.bold))
                }
            }
            .frame(maxWidth: width == nil ? .infinity : width, alignment: .leading)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func lectureRowView(_ row: LectureRow) -> some View {
        Button {
            store.selectedLectureId = row.id
        } label: {
            HStack(spacing: 10) {
                HStack(spacing: 8) {
                    Text("L\(row.ordinal)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, alignment: .leading)
                    Text(row.title)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if activeCourse == nil {
                    TagBadge(text: row.courseCode, tone: tagTone(row.courseCode))
                        .frame(width: 85, alignment: .leading)
                }

                Group {
                    if let mod = row.moduleTitle {
                        TagBadge(text: mod, tone: tagTone(mod))
                    } else {
                        Text("—").font(.caption).foregroundStyle(.tertiary)
                    }
                }
                .frame(width: 140, alignment: .leading)

                Text(shortDate(row.deliveredOn))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 100, alignment: .leading)

                StatusTagView(
                    status: row.status,
                    stageLabel: row.stageLabel,
                    queuePosition: row.queuePosition,
                    error: row.error
                )
                .frame(width: 120, alignment: .leading)

                Text(row.laqCount > 0 ? "\(row.laqCount)" : "—")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(row.laqCount > 0 ? .primary : .tertiary)
                    .frame(width: 55, alignment: .leading)

                ScoreTagView(score: row.lastScore, prev: row.prevScore)
                    .frame(width: 90, alignment: .leading)

                Group {
                    let lbl = dueLabel(row.dueAt)
                    if row.dueAt != nil {
                        TagBadge(text: lbl.text, tone: lbl.tone)
                    } else {
                        Text("—").font(.caption).foregroundStyle(.tertiary)
                    }
                }
                .frame(width: 110, alignment: .leading)
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Chunk 4: Lecture Page View & ModelInfo Popover

struct LectureDetailView: View {
    @Bindable var store: AppStore
    let detail: LectureDetailSnapshot
    let onBack: () -> Void

    @State private var selectedTab: LectureTab = .summary
    @State private var showingModelInfo = false

    @State private var editTitle: String = ""
    @State private var editModule: String = ""
    @State private var editDate: Date = Date()
    @State private var editHours: Double = 1.0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                // Breadcrumbs
                HStack(spacing: 6) {
                    Button("Lectures", action: onBack)
                        .buttonStyle(.link)
                    Text("/").foregroundStyle(.tertiary)
                    Button(detail.course.code) {
                        store.selection = .course(detail.course.id)
                        onBack()
                    }
                    .buttonStyle(.link)
                    if let mod = detail.module {
                        Text("/").foregroundStyle(.tertiary)
                        Text(mod.title).foregroundStyle(.secondary)
                    }
                }
                .font(.subheadline)

                // L-ordinal + ModelInfo (i) popover
                HStack(spacing: 6) {
                    Text("L\(detail.row.ordinal)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                    Button {
                        showingModelInfo.toggle()
                    } label: {
                        Image(systemName: "info.circle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .popover(isPresented: $showingModelInfo) {
                        ModelInfoPopoverView(info: detail.modelInfo)
                    }
                }

                Text(detail.lecture.title)
                    .font(.system(size: 28, weight: .bold))

                // Properties Grid
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                    GridRow {
                        Text("Date").foregroundStyle(.secondary)
                        Text(longDate(detail.lecture.deliveredOn))
                    }
                    GridRow {
                        Text("Module").foregroundStyle(.secondary)
                        if let mod = detail.module {
                            TagBadge(text: mod.title, tone: tagTone(mod.title))
                        } else {
                            Text("None").foregroundStyle(.tertiary)
                        }
                    }
                    GridRow {
                        Text("Length").foregroundStyle(.secondary)
                        Text("\(formatHours(detail.lecture.durationHours)) · \(plural(detail.sittingBudget, "LAQ")) per sitting")
                    }
                    GridRow {
                        Text("Status").foregroundStyle(.secondary)
                        StatusTagView(
                            status: detail.row.status,
                            stageLabel: detail.row.stageLabel,
                            queuePosition: detail.row.queuePosition,
                            error: detail.row.error
                        )
                    }
                    GridRow {
                        Text("Last score").foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            ScoreTagView(score: detail.row.lastScore, prev: detail.row.prevScore)
                            if detail.row.sittings > 0, let best = detail.row.bestScore {
                                Text("· best \(formatScore(best)) · \(plural(detail.row.sittings, "sitting"))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    GridRow {
                        Text("Next review").foregroundStyle(.secondary)
                        let lbl = dueLabel(detail.row.dueAt)
                        if detail.row.dueAt != nil {
                            TagBadge(text: lbl.text, tone: lbl.tone)
                        } else {
                            Text(detail.questions.isEmpty ? "once it has LAQs" : "—")
                                .foregroundStyle(.tertiary)
                        }
                    }
                    if !detail.skipped.isEmpty {
                        GridRow {
                            Text("Left out").foregroundStyle(.secondary)
                            Text(detail.skipped.map { "\($0.what)\($0.where.isEmpty ? "" : " (\($0.where))")" }.joined(separator: ", "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .font(.callout)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.03))
                .clipShape(RoundedRectangle(cornerRadius: 8))

                // Tabs
                Picker("", selection: $selectedTab) {
                    ForEach(LectureTab.allCases, id: \.self) { t in
                        switch t {
                        case .summary:
                            Text("Summary").tag(t)
                        case .laqs:
                            Text("LAQs (\(detail.questions.count))").tag(t)
                        case .scores:
                            Text("Scores (\(detail.attempts.count))").tag(t)
                        case .details:
                            Text("Details & files (\(detail.materials.count))").tag(t)
                        }
                    }
                }
                .pickerStyle(.segmented)

                switch selectedTab {
                case .summary:
                    if let md = detail.lecture.summaryMd, !md.isEmpty {
                        Text(md)
                            .font(.body)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if detail.materials.isEmpty {
                        Text("This lecture has no transcript or slides yet. Add them in Details & files first.")
                            .foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("No summary yet.")
                                .foregroundStyle(.secondary)
                            if store.mode != "manual" {
                                Button {
                                    store.prepareLectures([detail.lecture.id])
                                } label: {
                                    Label("Prepare with AI", systemImage: "sparkles")
                                }
                                .buttonStyle(.borderedProminent)
                            }
                        }
                    }

                case .laqs:
                    if detail.questions.isEmpty {
                        Text("No LAQs yet.")
                            .foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(detail.questions) { q in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("LAQ \(detail.questionNumbers[q.id] ?? 0)")
                                        .font(.caption.monospacedDigit().weight(.semibold))
                                        .foregroundStyle(.secondary)
                                    Text(q.stem)
                                        .font(.body.weight(.medium))
                                }
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.primary.opacity(0.04))
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                        }
                    }

                case .scores:
                    if detail.attempts.isEmpty {
                        Text("No sittings yet.")
                            .foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(detail.attempts) { a in
                                HStack {
                                    if let gm = a.geometricMean {
                                        TagBadge(text: "\(formatScore(gm)) / 10", tone: scoreTone(gm))
                                    } else {
                                        TagBadge(text: "In progress", tone: .blue)
                                    }
                                    Text("\(shortDate(a.sittingDate)) · \(clockTime(a.sittingDate))")
                                        .font(.callout)
                                    Spacer()
                                    Text(a.source == .pasted ? "Pasted" : "In Lockin")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(10)
                                .background(Color.primary.opacity(0.04))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                        }
                    }

                case .details:
                    VStack(alignment: .leading, spacing: 16) {
                        Form {
                            TextField("Title", text: $editTitle)
                            TextField("Module", text: $editModule)
                            DatePicker("Delivered on", selection: $editDate, displayedComponents: .date)
                            Stepper(
                                "Hours: \(formatHours(editHours))",
                                value: $editHours,
                                in: 0.5...8.0,
                                step: 0.5
                            )
                            Button("Save") {
                                store.updateLectureDetails(
                                    lectureId: detail.lecture.id,
                                    title: editTitle,
                                    moduleTitle: editModule,
                                    deliveredOn: editDate,
                                    durationHours: editHours
                                )
                            }
                        }
                        .onAppear {
                            editTitle = detail.lecture.title
                            editModule = detail.module?.title ?? ""
                            editDate = detail.lecture.deliveredOn
                            editHours = detail.lecture.durationHours
                        }

                        Divider()
                        Text("Files")
                            .font(.headline)
                        if detail.materials.isEmpty {
                            Text("None yet.").foregroundStyle(.secondary)
                        } else {
                            ForEach(detail.materials) { m in
                                HStack {
                                    Image(systemName: "doc.text")
                                    Text(m.originalName)
                                        .font(.body.weight(.medium))
                                    TagBadge(
                                        text: m.kind.rawValue.lowercased(),
                                        tone: m.kind == .transcript ? .blue : .gray
                                    )
                                    if let pages = m.pageCount {
                                        Text("\(plural(pages, "page"))")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                }
                                .padding(8)
                                .background(Color.primary.opacity(0.04))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                        }
                    }
                }
            }
            .padding(24)
        }
    }
}

struct ModelInfoPopoverView: View {
    let info: ModelInfoData

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if info.isEmpty {
                Text("No AI has worked on this lecture yet.")
                    .font(.callout)
            } else {
                if let summary = info.summary {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Summary").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        Text(summary.isEmpty ? "written before Lockin recorded the model" : summary)
                            .font(.callout)
                    }
                }
                if !info.laqs.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("LAQs").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(info.laqs, id: \.model) { item in
                            Text("\(item.count) by \(item.model)")
                                .font(.callout)
                        }
                    }
                }
                if let run = info.lastRun {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Last run").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        let modelText = run.model.map { " on \($0)" } ?? ""
                        let durText = run.durationMs.map { ", took \(duration($0))" } ?? ""
                        Text("\(run.what)\(modelText)\(durText)")
                            .font(.callout)
                        Text("\(shortDate(run.finishedAt)) · \(clockTime(run.finishedAt))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let fb = run.fellBack {
                            Text("The cloud AI failed, so the offline model did it: \(fb)")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                    }
                }
            }
            Text("Choose the AI and its model in Settings.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(14)
        .frame(width: 280, alignment: .leading)
    }
}

// MARK: - Chunk 5: Import Folder View

struct ImportFolderView: View {
    @Bindable var store: AppStore
    let course: Course
    let onDone: () -> Void

    @State private var folderPath: String = ""
    @State private var scanError: String? = nil
    @State private var scannedFiles: [ScannedFile] = []
    @State private var skippedItems: [SkippedScanItem] = []
    @State private var inLectures: [Int: [ExistingLectureRef]] = [:]
    @State private var reviewRows: [ImportReviewRow] = []
    @State private var sortMethod: String = "names"
    @State private var sortJobId: String? = nil
    @State private var sortError: String? = nil
    @State private var prepareAfterImport: Bool = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 6) {
                    Button("Lectures", action: onDone)
                        .buttonStyle(.link)
                    Text("/").foregroundStyle(.tertiary)
                    Button(course.code, action: onDone)
                        .buttonStyle(.link)
                    Text("/").foregroundStyle(.tertiary)
                    Text("Import").foregroundStyle(.secondary)
                }
                .font(.subheadline)

                Text("Import a folder into \(course.code)")
                    .font(.system(size: 26, weight: .bold))
                Text("Choose the folder your transcripts and slides are in — subfolders too. Lockin pairs each transcript with its slides by lecture number, date or name, right here on your computer, and lists what it found for you to check. Nothing is imported until you say so.")
                    .font(.callout)
                    .foregroundStyle(.secondary)

                HStack(spacing: 8) {
                    TextField("Folder path (e.g. ~/Downloads/BIOL3010)", text: $folderPath)
                        .textFieldStyle(.roundedBorder)
                    Button("Browse…") {
                        pickFolder()
                    }
                    Button(scannedFiles.isEmpty ? "Scan folder" : "Scan again") {
                        runScan()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(folderPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if let err = scanError {
                    HStack {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                        Text(err)
                            .foregroundStyle(.red)
                    }
                    .padding(10)
                    .background(Color.red.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }

                if !scannedFiles.isEmpty {
                    Divider()

                    // Grouping method choice
                    VStack(alignment: .leading, spacing: 8) {
                        Text("How should these become lectures?")
                            .font(.headline)
                        Picker("", selection: $sortMethod) {
                            Text("Sorted already (by filenames, numbers & dates)").tag("names")
                            Text("Sort with AI (reads the opening of each file)").tag("ai")
                        }
                        .pickerStyle(.radioGroup)
                        .onChange(of: sortMethod) { _, newValue in
                            if newValue == "names" {
                                let proposed = groupFiles(scannedFiles.map(\.groupInput))
                                reviewRows = buildImportReviewRows(
                                    lectures: proposed,
                                    files: scannedFiles,
                                    inLectures: inLectures
                                )
                            } else if newValue == "ai" {
                                startAiSort()
                            }
                        }

                        if let sErr = sortError {
                            Text(sErr)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }

                    // Review Table
                    let lectureCount = reviewRows.filter { $0.proposed.setAside == nil }.count
                    let haveCount = reviewRows.filter { $0.status == .have }.count
                    let addsCount = reviewRows.filter { $0.status == .adds }.count
                    let includedCount = reviewRows.filter(\.included).count

                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(plural(lectureCount, "lecture")) in \(plural(scannedFiles.count, "file"))")
                            .font(.headline)
                        if haveCount > 0 {
                            Text("· \(haveCount) already imported")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        if addsCount > 0 {
                            Text("· \(addsCount) with new files")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(includedCount == reviewRows.count ? "Untick all" : "Tick all") {
                            let target = includedCount < reviewRows.count
                            for i in reviewRows.indices {
                                reviewRows[i].included = target
                            }
                        }
                        .font(.caption)
                    }

                    VStack(spacing: 8) {
                        ForEach($reviewRows) { $row in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack(spacing: 10) {
                                    Toggle("", isOn: $row.included)
                                        .labelsHidden()

                                    if let label = row.proposed.label {
                                        Text(label)
                                            .font(.system(.caption, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                    }

                                    if row.status != .new, let home = row.home {
                                        Text(home.title)
                                            .font(.body.weight(.semibold))
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    } else {
                                        TextField("Lecture title", text: $row.title)
                                            .textFieldStyle(.roundedBorder)
                                    }

                                    if row.status == .have {
                                        TagBadge(text: "already imported", tone: .gray)
                                    } else if row.status == .adds {
                                        TagBadge(text: "adds \(plural(row.freshFileIndexes.count, "file"))", tone: .green)
                                    }
                                    if let aside = row.proposed.setAside {
                                        TagBadge(text: aside, tone: .yellow)
                                    }

                                    TextField("No module", text: $row.moduleTitle)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(width: 150)
                                        .disabled(row.status != .new)

                                    TextField("YYYY-MM-DD", text: $row.deliveredOn)
                                        .textFieldStyle(.roundedBorder)
                                        .frame(width: 110)
                                        .disabled(row.status != .new)

                                    Stepper(
                                        "\(formatHours(row.durationHours))",
                                        value: $row.durationHours,
                                        in: 0.5...8.0,
                                        step: 0.5
                                    )
                                    .frame(width: 130)
                                    .disabled(row.status != .new)
                                }

                                // Files in this lecture row
                                VStack(alignment: .leading, spacing: 4) {
                                    ForEach(row.proposed.fileIndexes, id: \.self) { fileIdx in
                                        if fileIdx >= 0 && fileIdx < scannedFiles.count {
                                            let file = scannedFiles[fileIdx]
                                            let isDropped = row.droppedFileIndexes.contains(fileIdx)
                                            let otherRows = reviewRows.filter { $0.index != row.index && $0.proposed.fileIndexes.contains(fileIdx) }

                                            HStack(spacing: 6) {
                                                TagBadge(
                                                    text: file.kindGuess == .transcript ? "transcript" : file.kindGuess.rawValue.lowercased(),
                                                    tone: file.kindGuess == .transcript ? .blue : .gray
                                                )
                                                Text(file.relativePath)
                                                    .font(.caption)
                                                    .strikethrough(isDropped)
                                                    .foregroundStyle(isDropped ? .tertiary : .secondary)

                                                if !otherRows.isEmpty {
                                                    let names = otherRows.map { $0.proposed.label ?? $0.title }.joined(separator: ", ")
                                                    TagBadge(text: "shared with \(names)", tone: .purple)
                                                }

                                                if !file.warnings.isEmpty {
                                                    Image(systemName: "exclamationmark.triangle.fill")
                                                        .font(.caption)
                                                        .foregroundStyle(.orange)
                                                        .help(file.warnings.joined(separator: " "))
                                                }

                                                if row.proposed.fileIndexes.count > 1 {
                                                    Button {
                                                        row.toggleDropFile(fileIdx)
                                                    } label: {
                                                        Image(systemName: isDropped ? "arrow.uturn.backward" : "xmark")
                                                            .font(.caption2)
                                                    }
                                                    .buttonStyle(.plain)
                                                    .help(isDropped ? "Put file back" : "Leave this file out of this lecture")
                                                }

                                                if reviewRows.count > 1 {
                                                    Menu {
                                                        ForEach(reviewRows) { target in
                                                            if target.index != row.index {
                                                                Button("Move to \(target.proposed.label ?? target.title)") {
                                                                    moveFileInReviewRows(
                                                                        &reviewRows,
                                                                        fileIndex: fileIdx,
                                                                        fromRow: row.index,
                                                                        toRow: target.index,
                                                                        files: scannedFiles,
                                                                        inLectures: inLectures
                                                                    )
                                                                }
                                                            }
                                                        }
                                                    } label: {
                                                        Image(systemName: "arrow.right.arrow.left")
                                                            .font(.caption2)
                                                            .foregroundStyle(.secondary)
                                                    }
                                                    .menuStyle(.borderlessButton)
                                                    .frame(width: 24)
                                                }
                                            }
                                            .padding(.leading, 28)
                                        }
                                    }
                                }
                            }
                            .padding(10)
                            .background(Color.primary.opacity(row.included ? 0.04 : 0.015))
                            .opacity(row.included ? 1.0 : 0.6)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }

                    if !skippedItems.isEmpty {
                        DisclosureGroup("\(plural(skippedItems.count, "file")) not read") {
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(skippedItems, id: \.path) { item in
                                    Text("\(item.path) — \(item.why)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.top, 4)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }

                    Divider()

                    HStack {
                        if store.mode != "manual" {
                            Toggle(
                                "Then prepare them with AI, one lecture at a time — summary and LAQs for each, in order",
                                isOn: $prepareAfterImport
                            )
                            .font(.callout)
                        }
                        Spacer()
                        Button("Cancel", action: onDone)
                        Button("Import \(plural(includedCount, "lecture"))") {
                            commitImport()
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(includedCount == 0)
                    }
                }
            }
            .padding(24)
        }
    }

    private func pickFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose Folder"
        if panel.runModal() == .OK, let url = panel.url {
            folderPath = url.path
            runScan()
        }
    }

    private func runScan() {
        guard let db = store.database else { return }
        scanError = nil
        sortError = nil
        do {
            let result = try scanFolder(root: folderPath)
            if result.files.isEmpty {
                scanError = "Nothing readable in \(folderPath). Lockin reads .vtt .srt .txt .md .pdf and .pptx."
                scannedFiles = []
                reviewRows = []
                return
            }
            let held = try db.reader.read { conn in
                try existingFilesInCourse(db: conn, courseId: course.id, scannedFiles: result.files)
            }
            let proposed = groupFiles(result.files.map(\.groupInput))
            scannedFiles = result.files
            skippedItems = result.skipped
            inLectures = held
            sortMethod = "names"
            reviewRows = buildImportReviewRows(lectures: proposed, files: result.files, inLectures: held)
        } catch {
            scanError = error.localizedDescription
        }
    }

    private func startAiSort() {
        guard let db = store.database else { return }
        sortError = nil
        do {
            let rootURL = URL(fileURLWithPath: (folderPath as NSString).expandingTildeInPath).standardizedFileURL
            let budget = store.mode == "local" ? 260 : 600
            let job = try db.writer.write { conn in
                try enqueueSortJob(
                    db: conn,
                    root: rootURL.path,
                    relPaths: scannedFiles.map(\.relativePath),
                    budget: budget
                )
            }
            sortJobId = job.id
        } catch {
            sortError = error.localizedDescription
            sortMethod = "names"
        }
    }

    private func commitImport() {
        guard let db = store.database else { return }
        scanError = nil
        do {
            let rootURL = URL(fileURLWithPath: (folderPath as NSString).expandingTildeInPath).standardizedFileURL
            let summary = try db.writer.write { conn in
                try importReviewedLectures(
                    db: conn,
                    courseId: course.id,
                    root: rootURL.path,
                    rows: reviewRows,
                    files: scannedFiles,
                    prepareWithAi: prepareAfterImport && store.mode != "manual"
                )
            }
            var parts: [String] = []
            if !summary.createdLectureIds.isEmpty || summary.updatedLectureIds.isEmpty {
                parts.append("Imported \(plural(summary.createdLectureIds.count, "lecture"))")
            }
            if !summary.updatedLectureIds.isEmpty {
                parts.append("added new files to \(plural(summary.updatedLectureIds.count, "existing lecture"))")
            }
            store.lastImportNotice = parts.joined(separator: " and ") + "."
            onDone()
        } catch {
            scanError = error.localizedDescription
        }
    }
}

// MARK: - Sheets (New Course & New Single Lecture)

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

struct NewLectureSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: AppStore
    let courseId: String

    @State private var title = ""
    @State private var moduleTitle = ""
    @State private var deliveredOn = Date()
    @State private var durationHours = 1.0
    @State private var selectedFiles: [URL] = []
    @State private var pastedTranscript = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("New Lecture")
                .font(.headline)

            Form {
                TextField("Title (optional if adding a file)", text: $title)
                TextField("Module (optional)", text: $moduleTitle)
                DatePicker("Delivered on", selection: $deliveredOn, displayedComponents: .date)
                Stepper("Hours: \(formatHours(durationHours))", value: $durationHours, in: 0.5...8.0, step: 0.5)

                HStack {
                    Button("Choose files…") {
                        let panel = NSOpenPanel()
                        panel.canChooseFiles = true
                        panel.canChooseDirectories = false
                        panel.allowsMultipleSelection = true
                        if panel.runModal() == .OK {
                            selectedFiles = panel.urls
                        }
                    }
                    if !selectedFiles.isEmpty {
                        Text(selectedFiles.map(\.lastPathComponent).joined(separator: ", "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                TextField("Or paste transcript text…", text: $pastedTranscript, axis: .vertical)
                    .lineLimit(3...6)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Create Lecture") {
                    store.createSingleLecture(
                        courseId: courseId,
                        title: title,
                        moduleTitle: moduleTitle,
                        deliveredOn: deliveredOn,
                        durationHours: durationHours,
                        fileURLs: selectedFiles,
                        pastedTranscript: pastedTranscript
                    )
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                        selectedFiles.isEmpty &&
                        pastedTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}
