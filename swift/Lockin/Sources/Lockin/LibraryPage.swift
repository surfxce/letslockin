import SwiftUI
import LockinCore

// The lecture library and the lecture page, ported to the web app's design (app/
// globals.css): a page canvas, a due strip of shadowed cards, and the "database" table
// with hairline rules — replacing the native sidebar/table look.

// MARK: - The library page

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
        PageContainer {
            VStack(alignment: .leading, spacing: 0) {
                header
                if let notice = store.lastImportNotice {
                    importNotice(notice)
                }
                if !due.isEmpty {
                    dueStrip
                        .padding(.bottom, 26)
                }
                toolbar
                table
                foot
            }
        }
    }

    // MARK: header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            PageTitle(text: activeCourse?.title ?? "Lectures")
            HStack(spacing: 6) {
                if let active = activeCourse {
                    TagBadge(text: active.code, tone: tagTone(active.code))
                    Text("· \(plural(rows.count, "lecture"))")
                        .font(.system(size: 14))
                        .foregroundStyle(L.textSoft)
                    if let exam = active.examDate {
                        let d = daysUntil(exam)
                        Text(d >= 0 ? "· exam in \(plural(d, "day"))" : "· exam has passed")
                            .font(.system(size: 14))
                            .foregroundStyle(L.textSoft)
                    }
                    // Course choice lives in the header, as the web app's grouping does.
                    Menu {
                        Button("All courses") { store.selection = .allLectures }
                        ForEach(store.courses) { course in
                            Button("\(course.code) — \(course.title)") { store.selection = .course(course.id) }
                        }
                    } label: {
                        Label("Change course", systemImage: "chevron.down")
                            .font(.lockinSmall)
                            .foregroundStyle(L.textSoft)
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                } else {
                    Text("Every lecture across \(plural(store.courses.count, "course")), with how you are doing on each.")
                        .font(.system(size: 14))
                        .foregroundStyle(L.textSoft)
                    if store.courses.count > 1 {
                        Menu {
                            ForEach(store.courses) { course in
                                Button("\(course.code) — \(course.title)") { store.selection = .course(course.id) }
                            }
                        } label: {
                            Label("Filter by course", systemImage: "chevron.down")
                                .font(.lockinSmall)
                                .foregroundStyle(L.textSoft)
                        }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                    }
                }
            }
            .padding(.bottom, 8)
        }
        .padding(.bottom, 10)
    }

    private func importNotice(_ notice: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(L.strong[.blue] ?? .blue)
            Text(notice)
                .font(.system(size: 14.5))
                .foregroundStyle(L.text)
            Spacer()
            Button {
                store.lastImportNotice = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(L.tagPalettes[.blue]!.bg)
        .foregroundStyle(L.tagPalettes[.blue]!.fg)
        .cornerRadius(6)
        .padding(.bottom, 20)
    }

    // MARK: due strip (`.due-strip`, `.due-card`)

    private var dueStrip: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Label("Due for LAQs", systemImage: "bell.fill")
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(L.text)
                Text("\(due.count)")
                    .font(.system(size: 12))
                    .padding(.horizontal, 6)
                    .frame(height: 18)
                    .background(L.bgSunk)
                    .foregroundStyle(L.textFaint)
                    .clipShape(Capsule())
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 10)], spacing: 10) {
                ForEach(due.prefix(8)) { row in
                    Button {
                        store.selectedLectureId = row.id
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(row.title)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(L.text)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            HStack(spacing: 6) {
                                let lbl = dueLabel(row.dueAt)
                                TagBadge(text: lbl.text, tone: lbl.tone)
                                if activeCourse == nil {
                                    TagBadge(text: row.courseCode, tone: tagTone(row.courseCode))
                                }
                                Text("L\(row.ordinal)")
                                    .font(.lockinMono)
                                    .foregroundStyle(L.textFaint)
                                if let s = row.lastScore {
                                    ScoreTagView(score: s)
                                }
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(L.bg)
                        .cornerRadius(8)
                        .modifier(DueCardShadow())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: toolbar (`.toolbar`, `.chip-btn`)

    private var toolbar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 4) {
                toolbarActions.fixedSize(horizontal: true, vertical: false)
                Spacer(minLength: 12)
                toolbarFilters.fixedSize(horizontal: true, vertical: false)
            }
            VStack(alignment: .leading, spacing: 8) {
                toolbarActions
                toolbarFilters
            }
        }
        .padding(.vertical, 6)
        .padding(.bottom, 8)
    }

    private var toolbarActions: some View {
        HStack(spacing: 4) {
            if let active = activeCourse {
                Button {
                    store.importingCourseId = active.id
                } label: {
                    Label("Import folder", systemImage: "folder.badge.plus")
                }
                .buttonStyle(.lockinPrimary)

                Button {
                    onNewLecture(active.id)
                } label: {
                    Label("New lecture", systemImage: "plus")
                }
                .buttonStyle(.lockin)
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
                .buttonStyle(.lockin)
            }

            if store.mode != "manual" && !toPrepareIds.isEmpty {
                Button {
                    store.prepareLectures(toPrepareIds)
                } label: {
                    Label("Prepare \(plural(toPrepareIds.count, "lecture"))", systemImage: "sparkles")
                }
                .buttonStyle(.lockin)
            }

        }
    }

    private var toolbarFilters: some View {
        HStack(spacing: 4) {
            Menu {
                Button("Lecture date — first to last") { updateView { $0.sort = .date; $0.dir = .asc } }
                Button("Lecture date — latest first") { updateView { $0.sort = .date; $0.dir = .desc } }
                Button("Weakest first") { updateView { $0.sort = .score; $0.dir = .asc } }
                Button("Strongest first") { updateView { $0.sort = .score; $0.dir = .desc } }
                Button("Due soonest") { updateView { $0.sort = .due; $0.dir = .asc } }
                Button("Name A–Z") { updateView { $0.sort = .name; $0.dir = .asc } }
            } label: {
                chipLabel("Sort: \(viewConfig.sort.rawValue.capitalized) \(viewConfig.dir == .asc ? "↑" : "↓")", icon: "arrow.up.arrow.down")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()

            Menu {
                ForEach(LectureGroupKey.allCases, id: \.self) { g in
                    if activeCourse == nil || g != .course {
                        Button(g.label) { updateView { $0.group = g } }
                    }
                }
            } label: {
                chipLabel(
                    viewConfig.group == .none ? "Group" : "Grouped by \(viewConfig.group.label.lowercased())",
                    icon: "square.grid.2x2"
                )
            }
            .menuStyle(.borderlessButton)
            .fixedSize()

            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 12))
                TextField("Search lectures", text: $searchQuery)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .frame(width: 140)
            }
            .padding(.horizontal, 8)
            .frame(height: 28)
            .background(searchQuery.isEmpty ? Color.clear : L.hover)
            .cornerRadius(5)
            .overlay(
                RoundedRectangle(cornerRadius: 5)
                    .strokeBorder(searchQuery.isEmpty ? Color.clear : L.ruleStrong, lineWidth: 1)
            )
        }
    }

    private func chipLabel(_ text: String, icon: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.system(size: 12))
            Text(text).font(.system(size: 14))
        }
        .foregroundStyle(L.textSoft)
        .padding(.horizontal, 8)
        .frame(height: 28)
        .contentShape(Rectangle())
    }

    // MARK: the table (`.db`)

    private var table: some View {
        ScrollView(.horizontal) {
            tableContents.containerRelativeFrame(.horizontal) { width, _ in
                max(width, activeCourse == nil ? 1040 : 950)
            }
        }
    }

    private var tableContents: some View {
        VStack(spacing: 0) {
            if rows.isEmpty {
                emptyState
            } else {
                tableHeader
                LazyVStack(spacing: 0) {
                    ForEach(groups) { group in
                        if viewConfig.group != .none {
                            groupHead(group)
                        }
                        ForEach(group.rows) { row in
                            tableRow(row)
                            Rectangle().fill(L.rule).frame(height: 1)
                        }
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "folder.badge.plus")
                .font(.system(size: 32))
                .foregroundStyle(L.textFaint)
            Text("No lectures in \(activeCourse?.code ?? "any course") yet.")
                .font(.lockinBody)
                .foregroundStyle(L.textSoft)
            if let active = activeCourse {
                Button {
                    store.importingCourseId = active.id
                } label: {
                    Label("Import a folder of lectures", systemImage: "folder")
                }
                .buttonStyle(.lockinPrimary)
                .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }

    private func tableHeaderCell(_ key: LectureSortKey, _ label: String, width: CGFloat?) -> some View {
        Button {
            updateView { $0.toggleSort(key) }
        } label: {
            HStack(spacing: 4) {
                Text(label)
                    .font(.system(size: 13.5, weight: .regular))
                    .foregroundStyle(viewConfig.sort == key ? L.accentText : L.textSoft)
                if viewConfig.sort == key {
                    Image(systemName: viewConfig.dir == .asc ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(L.accentText)
                }
            }
            .frame(minWidth: width, maxWidth: width ?? .infinity, alignment: .leading)
            .padding(.horizontal, width == nil ? 0 : 9)
        }
        .buttonStyle(.plain)
    }

    private var tableHeader: some View {
        HStack(spacing: 0) {
            tableHeaderCell(.name, "Lecture", width: nil).padding(.leading, 9)
            if activeCourse == nil {
                tableHeaderCell(.course, "Course", width: 90).cellRule()
            }
            tableHeaderCell(.module, "Module", width: 140).cellRule()
            tableHeaderCell(.date, "Date", width: 100).cellRule()
            tableHeaderCell(.status, "Status", width: 120).cellRule()
            tableHeaderCell(.laqs, "LAQs", width: 55).cellRule()
            tableHeaderCell(.score, "Score", width: 90).cellRule()
            tableHeaderCell(.due, "Next review", width: 110).cellRule()
        }
        .frame(height: 34)
        .background(alignment: .bottom) { Rectangle().fill(L.rule).frame(height: 1) }
    }

    private func groupHead(_ group: LectureGroup) -> some View {
        HStack(spacing: 8) {
            TagBadge(text: group.name, tone: tagTone(group.name))
            Text("\(group.rows.count)")
                .font(.system(size: 14))
                .foregroundStyle(L.textFaint)
            if let avg = group.avg {
                Text("average")
                    .font(.system(size: 14))
                    .foregroundStyle(L.textSoft)
                TagBadge(text: formatScore(avg), tone: scoreTone(avg), score: true)
            }
            Spacer()
        }
        .padding(.top, 18)
        .padding(.bottom, 8)
        .padding(.leading, 9)
    }

    @ViewBuilder
    private func tableRow(_ row: LectureRow) -> some View {
        let lbl = dueLabel(row.dueAt)
        HStack(spacing: 0) {
            // Name: ordinal + title, the one cell that wraps.
            HStack(spacing: 8) {
                Text("L\(row.ordinal)")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(L.textFaint)
                Text(row.title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(L.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.leading, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cellRule()

            if activeCourse == nil {
                cell(width: 90) { TagBadge(text: row.courseCode, tone: tagTone(row.courseCode)) }
            }

            cell(width: 140) {
                if let mod = row.moduleTitle {
                    TagBadge(text: mod, tone: tagTone(mod))
                } else {
                    Text("—").font(.lockinSmall).foregroundStyle(L.textFaint)
                }
            }

            cell(width: 100) {
                Text(shortDate(row.deliveredOn)).font(.lockinSmall).foregroundStyle(L.textSoft)
            }

            cell(width: 120) {
                StatusTagView(
                    status: row.status,
                    stageLabel: row.stageLabel,
                    queuePosition: row.queuePosition,
                    error: row.error
                )
            }

            cell(width: 55) {
                Text(row.laqCount > 0 ? "\(row.laqCount)" : "—")
                    .font(.system(size: 13).monospacedDigit())
                    .foregroundStyle(row.laqCount > 0 ? L.textSoft : L.textFaint)
            }

            cell(width: 90) { ScoreTagView(score: row.lastScore, prev: row.prevScore) }

            cell(width: 110) {
                if row.dueAt != nil {
                    TagBadge(text: lbl.text, tone: lbl.tone)
                } else {
                    Text("—").font(.lockinSmall).foregroundStyle(L.textFaint)
                }
            }
        }
        .frame(minHeight: 38)
        .contentShape(Rectangle())
        .modifier(RowHover())
        .onTapGesture { store.selectedLectureId = row.id }
    }

    private func cell<Content: View>(width: CGFloat, @ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(width: width, alignment: .leading)
            .padding(.horizontal, 9)
            .cellRule()
    }

    private var foot: some View {
        HStack {
            if activeCourse != nil {
                Button {
                    onNewLecture(activeCourse!.id)
                } label: {
                    Label("New lecture", systemImage: "plus")
                        .font(.lockinSmall)
                }
                .buttonStyle(.lockinQuiet)
                .font(.lockinSmall)
            }
            Spacer()
            Text("\(totalFilteredCount) of \(plural(rows.count, "lecture"))")
                .font(.lockinSmall)
                .foregroundStyle(L.textFaint)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 9)
    }
}

/// The vertical hairline between table cells (`.db td { border-right }`).
private extension View {
    func cellRule() -> some View {
        overlay(alignment: .trailing) {
            Rectangle().fill(L.rule).frame(width: 1)
        }
    }
}

/// `.due-card:hover` reads as a slightly sunk card; here the shadow stays and the
/// background warms.
private struct DueCardShadow: ViewModifier {
    func body(content: Content) -> some View {
        L.cardShadow(content)
    }
}

// MARK: - The lecture page

struct LectureDetailView: View {
    @Bindable var store: AppStore
    let detail: LectureDetailSnapshot
    let onBack: () -> Void

    @State private var selectedTab: LectureTab = .summary
    @State private var showingModelInfo = false
    @State private var practice: PracticeDestination?
    @State private var showingPaste = false
    @State private var showingExport = false

    @State private var editTitle: String = ""
    @State private var editModule: String = ""
    @State private var editDate: Date = Date()
    @State private var editHours: Double = 1.0

    var body: some View {
        PageContainer {
            VStack(alignment: .leading, spacing: 0) {
                Crumbs(parts: {
                    var parts: [(String, () -> Void)] = [
                        ("Lectures", onBack),
                        (detail.course.code, {
                            store.selection = .course(detail.course.id)
                            onBack()
                        }),
                    ]
                    if let module = detail.module {
                        parts.append((module.title, {}))
                    }
                    return parts
                }())
                .padding(.bottom, 14)

                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("L\(detail.row.ordinal)")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(L.textFaint)
                    Button {
                        showingModelInfo.toggle()
                    } label: {
                        Image(systemName: "info.circle")
                            .font(.system(size: 12))
                            .foregroundStyle(L.textFaint)
                    }
                    .buttonStyle(.plain)
                    .popover(isPresented: $showingModelInfo) {
                        ModelInfoPopoverView(info: detail.modelInfo)
                    }
                }
                .padding(.bottom, 2)

                Text(detail.lecture.title)
                    .font(.system(size: 34, weight: .bold))
                    .tracking(-0.5)
                    .foregroundStyle(L.text)
                    .padding(.bottom, 8)

                properties
                    .padding(.bottom, 20)

                HStack(spacing: 8) {
                    Button("Start / resume sitting") {
                        do {
                            if let database = store.database {
                                let id = try database.writer.write { db in try startPractice(db: db, lectureId: detail.lecture.id) }
                                practice = PracticeDestination(id: id)
                            }
                        } catch { store.errorMessage = error.localizedDescription }
                    }
                    .buttonStyle(.lockinPrimary)
                    .disabled(detail.questions.isEmpty)

                    Button("Copy & paste…") { showingPaste = true }
                        .buttonStyle(.lockin)

                    Button("Export PDF…") { showingExport = true }
                        .buttonStyle(.lockin)
                        .disabled(detail.lecture.summaryMd?.isEmpty != false)
                }
                .sheet(item: $practice) { destination in PracticeSheet(store: store, attemptId: destination.id) }
                .sheet(isPresented: $showingPaste) { LecturePasteSheet(store: store, lectureId: detail.lecture.id) }
                .sheet(isPresented: $showingExport) { StudyExportSheet(store: store, initialLectureIds: [detail.lecture.id]) }
                .padding(.bottom, 8)

                UnderlineTabs(
                    selection: $selectedTab,
                    tabs: [
                        (.summary, "Summary", nil),
                        (.laqs, "LAQs", detail.questions.count),
                        (.scores, "Scores", detail.attempts.count),
                        (.details, "Details & files", detail.materials.count),
                    ]
                )
                .padding(.bottom, 20)

                switch selectedTab {
                case .summary:
                    SummaryTabView(store: store, detail: detail)

                case .laqs:
                    if detail.questions.isEmpty {
                        Text("No LAQs yet.")
                            .font(.lockinBody)
                            .foregroundStyle(L.textSoft)
                    } else {
                        VStack(spacing: 12) {
                            ForEach(detail.questions) { q in
                                // `.laq`: a shadowed card with a mono number column.
                                HStack(alignment: .top, spacing: 12) {
                                    Text("LAQ \(detail.questionNumbers[q.id] ?? 0)")
                                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                                        .foregroundStyle(L.textSoft)
                                        .frame(width: 46, alignment: .leading)
                                        .padding(.top, 3)
                                    Text(q.stem)
                                        .font(.system(size: 15.5))
                                        .lineSpacing(4)
                                        .foregroundStyle(L.text)
                                }
                                .padding(.horizontal, 18)
                                .padding(.vertical, 16)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(L.bg)
                                .cornerRadius(8)
                                .modifier(DueCardShadow())
                            }
                        }
                    }

                case .scores:
                    if detail.attempts.isEmpty {
                        Text("No sittings yet.")
                            .font(.lockinBody)
                            .foregroundStyle(L.textSoft)
                    } else {
                        VStack(spacing: 14) {
                            ForEach(detail.attempts) { a in
                                HStack(spacing: 14) {
                                    if let gm = a.geometricMean {
                                        Text(formatScore(gm))
                                            .font(.system(size: 30, weight: .semibold, design: .monospaced))
                                            .foregroundStyle(L.strong[scoreTone(gm)] ?? L.text)
                                            .padding(.horizontal, 12)
                                            .padding(.vertical, 8)
                                            .background(L.tagPalettes[scoreTone(gm)]?.bg ?? L.bgSoft)
                                            .cornerRadius(8)
                                    } else {
                                        TagBadge(text: "In progress", tone: .blue)
                                    }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("\(shortDate(a.sittingDate)) · \(clockTime(a.sittingDate))")
                                            .font(.system(size: 15, weight: .medium))
                                            .foregroundStyle(L.text)
                                        Text(a.source == .pasted ? "Pasted marks" : "In Lockin")
                                            .font(.lockinSmall)
                                            .foregroundStyle(L.textSoft)
                                    }
                                    Spacer()
                                    Button("Open sitting") { practice = PracticeDestination(id: a.id) }
                                        .buttonStyle(.lockin)
                                }
                                .padding(.horizontal, 20)
                                .padding(.vertical, 18)
                                .background(L.bg)
                                .cornerRadius(8)
                                .modifier(DueCardShadow())
                            }
                        }
                    }

                case .details:
                    detailsTab
                }
            }
        }
    }

    // MARK: properties (`.props`)

    private var properties: some View {
        VStack(alignment: .leading, spacing: 0) {
            propRow("Date") { Text(longDate(detail.lecture.deliveredOn)).font(.lockinBody) }
            propRow("Module") {
                if let mod = detail.module {
                    TagBadge(text: mod.title, tone: tagTone(mod.title))
                } else {
                    Text("None").font(.lockinBody).foregroundStyle(L.textFaint)
                }
            }
            propRow("Length") {
                Text("\(formatHours(detail.lecture.durationHours)) · \(plural(detail.sittingBudget, "LAQ")) per sitting")
                    .font(.lockinBody)
            }
            propRow("Status") {
                StatusTagView(
                    status: detail.row.status,
                    stageLabel: detail.row.stageLabel,
                    queuePosition: detail.row.queuePosition,
                    error: detail.row.error
                )
            }
            propRow("Last score") {
                HStack(spacing: 6) {
                    ScoreTagView(score: detail.row.lastScore, prev: detail.row.prevScore)
                    if detail.row.sittings > 0, let best = detail.row.bestScore {
                        Text("· best \(formatScore(best)) · \(plural(detail.row.sittings, "sitting"))")
                            .font(.lockinSmall)
                            .foregroundStyle(L.textSoft)
                    }
                }
            }
            propRow("Next review") {
                let lbl = dueLabel(detail.row.dueAt)
                if detail.row.dueAt != nil {
                    TagBadge(text: lbl.text, tone: lbl.tone)
                } else {
                    Text(detail.questions.isEmpty ? "once it has LAQs" : "—")
                        .font(.lockinBody)
                        .foregroundStyle(L.textFaint)
                }
            }
            if !detail.skipped.isEmpty {
                propRow("Left out") {
                    Text(detail.skipped.map { "\($0.what)\($0.where.isEmpty ? "" : " (\($0.where))")" }.joined(separator: ", "))
                        .font(.lockinSmall)
                        .foregroundStyle(L.textSoft)
                }
            }
        }
    }

    @ViewBuilder
    private func propRow<Content: View>(_ key: String, @ViewBuilder value: () -> Content) -> some View {
        HStack(alignment: .center, spacing: 0) {
            Text(key)
                .font(.lockinBody)
                .foregroundStyle(L.textSoft)
                .frame(minWidth: 130, maxWidth: 170, alignment: .leading)
                .padding(.horizontal, 6)
            value()
                .padding(.horizontal, 6)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 32)
    }

    // MARK: details & files tab

    private var detailsTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 12) {
                LockinField(label: "Title") {
                    TextField("", text: $editTitle)
                }
                LockinField(label: "Module") {
                    TextField("", text: $editModule)
                }
                HStack(alignment: .top, spacing: 12) {
                    LockinField(label: "Delivered on") {
                        DatePicker("", selection: $editDate, displayedComponents: .date)
                            .labelsHidden()
                    }
                    LockinField(label: "Hours") {
                        Stepper("\(formatHours(editHours))", value: $editHours, in: 0.5...8.0, step: 0.5)
                            .font(.lockinBody)
                    }
                }
                Button("Save") {
                    store.updateLectureDetails(
                        lectureId: detail.lecture.id,
                        title: editTitle,
                        moduleTitle: editModule,
                        deliveredOn: editDate,
                        durationHours: editHours
                    )
                }
                .buttonStyle(.lockin)
            }
            .onAppear {
                editTitle = detail.lecture.title
                editModule = detail.module?.title ?? ""
                editDate = detail.lecture.deliveredOn
                editHours = detail.lecture.durationHours
            }

            Text("Files")
                .font(.lockinH3)
                .foregroundStyle(L.text)
            if detail.materials.isEmpty {
                Text("None yet.")
                    .font(.lockinBody)
                    .foregroundStyle(L.textSoft)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(detail.materials) { m in
                        HStack(spacing: 12) {
                            Image(systemName: "doc.text")
                                .foregroundStyle(L.textSoft)
                            Text(m.originalName)
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(L.text)
                            TagBadge(
                                text: m.kind.rawValue.lowercased(),
                                tone: m.kind == .transcript ? .blue : .gray
                            )
                            if let pages = m.pageCount {
                                Text("\(plural(pages, "page"))")
                                    .font(.lockinSmall)
                                    .foregroundStyle(L.textSoft)
                            }
                            Spacer()
                        }
                        .padding(.vertical, 12)
                        .background(alignment: .bottom) { Rectangle().fill(L.rule).frame(height: 1) }
                    }
                }
            }
        }
    }
}

/// A form field in the web app's dress: a soft label over a soft-filled box with a
/// strong rule border.
struct LockinField<Field: View>: View {
    let label: String
    @ViewBuilder var field: () -> Field

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(L.textSoft)
            field()
                .font(.system(size: 14))
                .foregroundStyle(L.text)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(L.bgSoft)
                .cornerRadius(6)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(L.ruleStrong, lineWidth: 1)
                )
        }
    }
}

// MARK: - Model info popover

struct ModelInfoPopoverView: View {
    let info: ModelInfoData

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if info.isEmpty {
                Text("No AI has worked on this lecture yet.")
                    .font(.system(size: 14))
                    .foregroundStyle(L.textSoft)
            } else {
                if let summary = info.summary {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Summary")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(L.textSoft)
                        Text(summary.isEmpty ? "written before Lockin recorded the model" : summary)
                            .font(.system(size: 14))
                            .foregroundStyle(L.text)
                    }
                }
                if !info.laqs.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("LAQs")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(L.textSoft)
                        ForEach(info.laqs, id: \.model) { item in
                            Text("\(item.count) by \(item.model)")
                                .font(.system(size: 14))
                                .foregroundStyle(L.text)
                        }
                    }
                }
                if let run = info.lastRun {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Last run")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(L.textSoft)
                        let modelText = run.model.map { " on \($0)" } ?? ""
                        let durText = run.durationMs.map { ", took \(duration($0))" } ?? ""
                        Text("\(run.what)\(modelText)\(durText)")
                            .font(.system(size: 14))
                            .foregroundStyle(L.text)
                        Text("\(shortDate(run.finishedAt)) · \(clockTime(run.finishedAt))")
                            .font(.lockinSmall)
                            .foregroundStyle(L.textSoft)
                        if let fb = run.fellBack {
                            Text("The cloud AI failed, so the offline model did it: \(fb)")
                                .font(.lockinSmall)
                                .foregroundStyle(L.strong[.orange] ?? .orange)
                        }
                    }
                }
            }
            Text("Choose the AI and its model in Settings.")
                .font(.system(size: 11))
                .foregroundStyle(L.textFaint)
        }
        .padding(12)
        .frame(width: 300, alignment: .leading)
        .background(L.bg)
    }
}
