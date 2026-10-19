import AppKit
import Foundation
import GRDB
import LockinCore
import Observation
import SwiftUI

@main
struct LockinApp: App {
    @State private var store = AppStore.openDefault()

    init() {
        // The notification click handler must be in place before launch finishes.
        ReminderClickHandler.store = store
        // Updates are checked in the background from here on (Settings can ask again).
        LockinUpdater.shared.start()
    }

    var body: some Scene {
        WindowGroup("Lockin") {
            RootView(store: store)
                .frame(minWidth: 960, minHeight: 620)
        }
        .windowStyle(.hiddenTitleBar)
        Settings {
            SettingsScreen(store: store)
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

// MARK: - Status Tag

struct StatusTagView: View {
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
    @State private var reminders: ReminderDaemon?
    @State private var showingOnboarding = false

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
                VStack(spacing: 0) {
                    TopBarView(store: store)
                    Rectangle().fill(L.rule).frame(height: 1)

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
                .background(L.bg)
            }
        }
        .onAppear {
            let daemon = ReminderDaemon(store: store)
            daemon.start()
            reminders = daemon
        }
        // Any change in the database may move the due set: the badge follows it at once,
        // and the notification check does not wait out its five minutes.
        .onChange(of: store.dbRevision) {
            reminders?.check()
        }
        .onChange(of: store.settingsLoaded) {
            // The tour opens by itself once (`firstRun` in Onboarding.tsx).
            if store.settingsLoaded && !store.settings.onboarded {
                showingOnboarding = true
            }
        }
        .sheet(isPresented: $showingOnboarding) {
            OnboardingSheet(
                store: store,
                hasCourses: !store.courses.isEmpty,
                detection: nil,
                onAddFirstCourse: { showingNewCourse = true }
            )
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
            .background(L.hover)
            .clipShape(RoundedRectangle(cornerRadius: 8))

            HStack(spacing: 12) {
                Button(action: onRetry) {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.lockinPrimary)
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

// MARK: - Top Bar (the web app's shell: brand, nav, activity)

/// `.topbar` — 46px, the brand, the nav, and the queue activity at the end. Dragging
/// the window works anywhere the bar isn't a control (`movableByWindowBackground`).
struct TopBarView: View {
    @Bindable var store: AppStore

    var body: some View {
        HStack(spacing: 10) {
            // The 84px the web app leaves for the traffic lights, which now float here.
            Color.clear.frame(width: 64)

            HStack(spacing: 7) {
                Text("L")
                    .font(.system(size: 12, weight: .heavy))
                    .frame(width: 20, height: 20)
                    .background(L.text)
                    .foregroundStyle(L.bg)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                Text("Lockin")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(L.text)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)

            HStack(spacing: 2) {
                Button {
                    store.selectedLectureId = nil
                    store.importingCourseId = nil
                    store.selection = store.courses.count > 1 ? .allLectures : (store.courses.first.map { .course($0.id) } ?? .allLectures)
                } label: {
                    Label("Lectures", systemImage: "tablecells")
                        .font(.system(size: 14))
                        .foregroundStyle(onLecturesPage ? L.text : L.textSoft)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(onLecturesPage ? L.hover : Color.clear)
                        .cornerRadius(5)
                }
                .buttonStyle(.plain)
            }

            Spacer()

            QueuePanelButton(store: store)

            SettingsLink {
                Image(systemName: "gearshape")
                    .font(.system(size: 14))
                    .foregroundStyle(L.textSoft)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .help("Settings")

            Color.clear.frame(width: 10)
        }
        .frame(height: 46)
        .background(DragBackground())
        .background(L.bg)
    }

    private var onLecturesPage: Bool {
        store.selectedLectureId == nil && store.importingCourseId == nil
    }
}

/// Makes the window draggable from its background, as `-webkit-app-region: drag` does
/// for the top bar; interactive controls still take their own clicks.
private struct DragBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            view.window?.isMovableByWindowBackground = true
        }
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

// MARK: - Welcome Empty State

struct WelcomeEmptyStateView: View {
    var onAddCourse: () -> Void

    var body: some View {
        PageContainer(narrow: true) {
            VStack(alignment: .leading, spacing: 20) {
                Text("📚")
                    .font(.system(size: 44))
                PageTitle(text: "Welcome to Lockin")
                Text("Lockin turns your lecture recordings and slides into a summary and long-answer questions for each lecture, marks your answers, and reminds you when each lecture is due again.")
                    .font(.lockinBody)
                    .foregroundStyle(L.textSoft)
                    .fixedSize(horizontal: false, vertical: true)

                VStack(alignment: .leading, spacing: 10) {
                    StepRow(number: "1", text: "Add a course, then point it at the folder your lecture files are in.")
                    StepRow(number: "2", text: "Each lecture gets a summary and LAQs — automatically, or by copy and paste with any AI chat.")
                    StepRow(number: "3", text: "Answer closed book, get marked, and come back when it is due.")
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(L.bgSoft)
                .cornerRadius(8)

                HStack(spacing: 12) {
                    Button(action: onAddCourse) {
                        Label("Add your first course", systemImage: "plus")
                    }
                    .buttonStyle(.lockinPrimary)
                    .controlSize(.large)
                }
            }
            .padding(.top, 40)
        }
    }
}

private struct StepRow: View {
    let number: String
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(number)
                .font(.system(.callout, design: .rounded, weight: .bold))
                .foregroundStyle(L.textSoft)
            Text(text)
                .font(.lockinBody)
                .foregroundStyle(L.text)
        }
    }
}


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
                    .buttonStyle(.lockinPrimary)
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
                            .background(row.included ? L.bgSoft : Color.clear)
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
                        .buttonStyle(.lockinPrimary)
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
