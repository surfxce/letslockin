import Foundation
import GRDB
import Observation

public enum SidebarItem: Hashable, Sendable {
    case allLectures
    case course(String)
}

public enum LectureTab: String, CaseIterable, Sendable {
    case summary = "Summary"
    case laqs = "LAQs"
    case scores = "Scores"
    case details = "Details & files"
}

public struct LectureDetailSnapshot: Sendable {
    public var lecture: Lecture
    public var row: LectureRow
    public var course: Course
    public var module: Module?
    public var courseModules: [Module]
    public var materials: [Material]
    public var questions: [Question]
    public var questionNumbers: [String: Int]
    public var attempts: [Attempt]
    public var modelInfo: ModelInfoData
    public var skipped: [Skipped]
    public var sittingBudget: Int
    public var slidesInfo: SlidesInfo
    public var glossaryTerms: [GlossaryEntry]
    public var askHistory: [AskHistoryItem]
    public var askJobs: [Job]
}

@Observable
@MainActor
public final class AppStore {
    public private(set) var database: LockinDatabase?
    public var databaseOpenError: String?
    public var databasePath: String

    public let slideRenderer = SlideRenderer()
    @ObservationIgnored public private(set) var jobQueue: JobQueue?

    public var courses: [Course] = []
    public var modules: [Module] = []
    public var lectureRows: [LectureRow] = []
    public var dueRows: [LectureRow] = []
    public var runningJob: Job? = nil
    public var queueActivity: QueueActivity? = nil
    public var settings: LockinSettings = .defaults
    public var mode: String = "local"
    /// Whether the settings have been read once — before that, defaults are on show, so
    /// the first-run tour must not open for someone who has already been round it.
    public var settingsLoaded: Bool = false
    /// Incremented whenever database observation fires, so detail views re-read smoothly.
    public var dbRevision: Int = 0

    public var selection: SidebarItem? = nil
    public var selectedLectureId: String? = nil
    public var importingCourseId: String? = nil
    public var lastImportNotice: String? = nil
    public var errorMessage: String? = nil

    private var viewConfigs: [String: LectureTableViewConfig] = [:]
    @ObservationIgnored private var cancellable: AnyDatabaseCancellable?

    public init(database: LockinDatabase, startQueue: Bool = true) {
        self.database = database
        self.databasePath = database.path
        self.databaseOpenError = nil
        startObserving(database: database, startQueue: startQueue)
    }

    public init(openError: Error, path: String = LockinPaths.databaseFile.path) {
        self.database = nil
        self.databasePath = path
        self.databaseOpenError = openError.localizedDescription
    }

    public static func openDefault() -> AppStore {
        let path = LockinPaths.databaseFile.path
        do {
            let db = try LockinDatabase(path: path)
            return AppStore(database: db)
        } catch {
            return AppStore(openError: error, path: path)
        }
    }

    public func retryOpenDatabase() {
        do {
            let db = try LockinDatabase(path: databasePath)
            self.database = db
            self.databaseOpenError = nil
            self.errorMessage = nil
            startObserving(database: db, startQueue: true)
        } catch {
            self.database = nil
            self.databaseOpenError = error.localizedDescription
        }
    }

    private func startObserving(database: LockinDatabase, startQueue: Bool) {
        cancellable?.cancel()
        if let oldQueue = jobQueue {
            Task { await oldQueue.stop() }
            jobQueue = nil
        }
        if startQueue {
            let services = LockinServices(
                renderer: slideRenderer,
                textReader: SlideOCR(),
                engine: MLXEngine.shared
            )
            let q = JobQueue(database: database, services: services)
            self.jobQueue = q
            Task { await q.start() }
        }

        let observation = ValueObservation.tracking { db -> ([Course], [Module], [LectureRow], [LectureRow], Job?, QueueActivity, LockinSettings) in
            let courses = try Course.order(Column("createdAt").asc).fetchAll(db)
            let modules = try Module.order(Column("position").asc).fetchAll(db)
            let rows = try LockinCore.lectureRows(db: db)
            let due = try LockinCore.dueLectures(db: db)
            let running = try Job
                .filter(Column("status") == JobStatus.running.rawValue)
                .order(Column("startedAt").desc)
                .fetchOne(db)
            let activity = try LockinCore.loadActivity(db: db)
            let settings = try LockinCore.getSettings(db: db)
            return (courses, modules, rows, due, running, activity, settings)
        }

        cancellable = observation.start(
            in: database.reader,
            onError: { [weak self] err in
                Task { @MainActor in
                    self?.errorMessage = err.localizedDescription
                }
            },
            onChange: { [weak self] (courses, modules, rows, due, running, activity, settings) in
                Task { @MainActor in
                    guard let self else { return }
                    self.courses = courses
                    self.modules = modules
                    self.lectureRows = rows
                    self.dueRows = due
                    self.runningJob = running
                    self.queueActivity = activity
                    self.settings = settings
                    self.mode = settings.mode.rawValue
                    self.settingsLoaded = true
                    self.dbRevision &+= 1
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

    // MARK: - Active Course & Filtered Rows

    public var activeCourse: Course? {
        if case .course(let id) = selection {
            return courses.first { $0.id == id }
        }
        return courses.count == 1 ? courses.first : nil
    }

    public var visibleLectureRows: [LectureRow] {
        if let active = activeCourse {
            return lectureRows.filter { $0.courseId == active.id }
        }
        return lectureRows
    }

    public var visibleDueRows: [LectureRow] {
        if let active = activeCourse {
            return dueRows.filter { $0.courseId == active.id }
        }
        return dueRows
    }

    // MARK: - Remembered View Config per Course

    public func viewConfig(for storageKey: String) -> LectureTableViewConfig {
        if let cached = viewConfigs[storageKey] {
            return cached
        }
        if let data = UserDefaults.standard.data(forKey: "lockin.view.\(storageKey)"),
           let decoded = try? JSONDecoder().decode(LectureTableViewConfig.self, from: data) {
            return decoded
        }
        return .default
    }

    public func setViewConfig(_ config: LectureTableViewConfig, for storageKey: String) {
        viewConfigs[storageKey] = config
        if let data = try? JSONEncoder().encode(config) {
            UserDefaults.standard.set(data, forKey: "lockin.view.\(storageKey)")
        }
    }

    // MARK: - Actions

    public func createCourse(code: String, title: String, examDate: Date?) {
        guard let database else { return }
        let cleanCode = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanCode.isEmpty, !cleanTitle.isEmpty else {
            errorMessage = "Give the course a code and a name."
            return
        }
        do {
            var course = Course(code: cleanCode, title: cleanTitle, examDate: examDate)
            try database.writer.write { db in
                if try Course.filter(Column("code") == cleanCode).fetchOne(db) != nil {
                    throw ScanFolderError.message("\(cleanCode) is already here.")
                }
                try course.insert(db)
            }
            selection = .course(course.id)
            selectedLectureId = nil
            importingCourseId = course.id
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func createSingleLecture(
        courseId: String,
        title: String,
        moduleTitle: String,
        deliveredOn: Date,
        durationHours: Double,
        fileURLs: [URL],
        pastedTranscript: String
    ) {
        guard let database else { return }
        let typed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let pasted = pastedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.isEmpty && fileURLs.isEmpty && pasted.isEmpty {
            errorMessage = "Give it a title, a file, or some transcript text."
            return
        }
        do {
            let fromFile = fileURLs.map { titleFromFilename($0.lastPathComponent) }.first { !$0.isEmpty }
            let finalTitle = !typed.isEmpty ? typed : (fromFile ?? "Untitled lecture")
            let hours = (durationHours.isFinite && durationHours > 0) ? durationHours : 1.0

            let createdId = try database.writer.write { db -> String in
                var modId: String? = nil
                let cleanMod = moduleTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                if !cleanMod.isEmpty {
                    if let existing = try Module.filter(Column("courseId") == courseId && Column("title") == cleanMod).fetchOne(db) {
                        modId = existing.id
                    } else {
                        let count = try Module.filter(Column("courseId") == courseId).fetchCount(db)
                        var mod = Module(courseId: courseId, title: cleanMod, position: count)
                        try mod.insert(db)
                        modId = mod.id
                    }
                }

                var lecture = Lecture(
                    courseId: courseId,
                    moduleId: modId,
                    title: finalTitle,
                    deliveredOn: deliveredOn,
                    durationHours: hours,
                    autoTitle: typed.isEmpty
                )
                try lecture.insert(db)

                for url in fileURLs {
                    let data = try Data(contentsOf: url)
                    _ = try ingestFile(db: db, filename: url.lastPathComponent, data: data, lectureId: lecture.id)
                }
                if !pasted.isEmpty {
                    let data = Data(pasted.utf8)
                    _ = try ingestFile(
                        db: db,
                        filename: "pasted-transcript.txt",
                        data: data,
                        lectureId: lecture.id,
                        kind: .transcript
                    )
                }
                if self.mode != "manual" && (!fileURLs.isEmpty || !pasted.isEmpty) {
                    _ = try queuePrepare(db: db, lectureIds: [lecture.id])
                }
                return lecture.id
            }
            selectedLectureId = createdId
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func updateLectureDetails(
        lectureId: String,
        title: String,
        moduleTitle: String,
        deliveredOn: Date,
        durationHours: Double
    ) {
        guard let database else { return }
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanTitle.isEmpty else { return }
        do {
            try database.writer.write { db in
                guard var lecture = try Lecture.fetchOne(db, key: lectureId) else { return }
                let cleanMod = moduleTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                if cleanMod.isEmpty {
                    lecture.moduleId = nil
                } else if let existing = try Module.filter(Column("courseId") == lecture.courseId && Column("title") == cleanMod).fetchOne(db) {
                    lecture.moduleId = existing.id
                } else {
                    let count = try Module.filter(Column("courseId") == lecture.courseId).fetchCount(db)
                    var mod = Module(courseId: lecture.courseId, title: cleanMod, position: count)
                    try mod.insert(db)
                    lecture.moduleId = mod.id
                }
                if cleanTitle != lecture.title {
                    lecture.title = cleanTitle
                    lecture.autoTitle = false
                }
                lecture.deliveredOn = deliveredOn
                lecture.durationHours = (durationHours.isFinite && durationHours > 0) ? durationHours : 1.0
                try lecture.update(db)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func prepareLectures(_ lectureIds: [String], redo: Bool = false) {
        guard let database else { return }
        do {
            try database.writer.write { db in
                _ = try queuePrepare(db: db, lectureIds: lectureIds, redo: redo)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Queue Panel Actions (Chunk 6)

    public func cancelQueueJob(_ jobId: String) {
        if let queue = jobQueue {
            Task {
                try? await queue.cancel(jobId: jobId)
            }
        } else if let database {
            _ = try? database.writer.write { db in
                try cancelJob(db: db, jobId: jobId)
            }
        }
    }

    public func retryQueueJob(_ jobId: String) {
        if let queue = jobQueue {
            Task {
                try? await queue.retry(jobId: jobId)
            }
        } else if let database {
            try? database.writer.write { db in
                try retryJob(db: db, jobId: jobId)
            }
        }
    }

    public func clearPendingQueue(lectureId: String? = nil) {
        guard let database else { return }
        _ = try? database.writer.write { db in
            try clearQueue(db: db, lectureId: lectureId)
        }
    }

    // MARK: - Summary Reader & Editor Actions (Chunks 7, 8 & 9)

    public func saveSummary(
        lectureId: String,
        markdown: String,
        base: String,
        force: Bool = false
    ) -> EditOutcome {
        guard let database else {
            return EditOutcome(ok: false, message: "Database is not open.")
        }
        do {
            return try saveSummaryEdit(
                database: database,
                lectureId: lectureId,
                markdown: markdown,
                base: base,
                force: force
            )
        } catch {
            return EditOutcome(ok: false, message: messageOf(error))
        }
    }

    public func addBlockToSummary(
        lectureId: String,
        markdown: String,
        place: SummaryPlacement
    ) -> EditOutcome {
        guard let database else {
            return EditOutcome(ok: false, message: "Database is not open.")
        }
        return addToSummary(
            database: database,
            lectureId: lectureId,
            markdown: markdown,
            place: place
        )
    }

    public func addLeftOutPart(lectureId: String, what: String) -> EditOutcome {
        guard let database else {
            return EditOutcome(ok: false, message: "Database is not open.")
        }
        do {
            return try addLeftOutToSummary(database: database, lectureId: lectureId, what: what)
        } catch {
            return EditOutcome(ok: false, message: messageOf(error))
        }
    }

    public func cropSlideFigure(
        lectureId: String,
        figure: Int,
        slide: Int,
        crop: Crop?
    ) -> EditOutcome {
        guard let database else {
            return EditOutcome(ok: false, message: "Database is not open.")
        }
        do {
            return try setSlideCrop(
                database: database,
                lectureId: lectureId,
                figure: figure,
                slide: slide,
                crop: crop
            )
        } catch {
            return EditOutcome(ok: false, message: messageOf(error))
        }
    }

    public func saveGlossaryTerm(
        lectureId: String,
        term: String,
        explanation: String
    ) -> Result<GlossaryEntry, LockinError> {
        guard let database else {
            return .failure(LockinError("Database is not open."))
        }
        do {
            return try addGlossaryTerm(
                database: database,
                lectureId: lectureId,
                term: term,
                explanation: explanation
            )
        } catch {
            return .failure(LockinError(messageOf(error)))
        }
    }

    public func deleteGlossaryTerm(id: String) {
        guard let database else { return }
        try? removeGlossaryTerm(database: database, id: id)
    }

    public func askAboutLecture(payload: AskPayload) -> AskStartOutcome {
        guard let database else {
            return .error("Database is not open.")
        }
        do {
            return try startAsk(database: database, payload: payload)
        } catch {
            return .error(messageOf(error))
        }
    }

    public func loadLectureDetail(id: String) -> LectureDetailSnapshot? {
        guard let database else { return nil }
        let decks = (try? lectureDecks(database: database, lectureId: id, renderer: slideRenderer)) ?? []
        let slidesInfo = SlidesInfo(lectureId: id, decks: decks)
        let askHistory = (try? fetchAskHistory(database: database, lectureId: id)) ?? []
        return try? database.reader.read { db in
            guard let lecture = try Lecture.fetchOne(db, key: id),
                  let course = try Course.fetchOne(db, key: lecture.courseId),
                  let row = try LockinCore.lectureRows(db: db, ids: [id]).first else {
                return nil
            }
            let module = try lecture.moduleId.flatMap { try Module.fetchOne(db, key: $0) }
            let courseModules = try Module
                .filter(Column("courseId") == course.id)
                .order(Column("position").asc)
                .fetchAll(db)
            let materials = try Material
                .filter(Column("lectureId") == id)
                .order(Column("createdAt").asc)
                .fetchAll(db)
            let questions = try Question
                .filter(Column("lectureId") == id)
                .order(Column("createdAt").asc, Column("id").asc)
                .fetchAll(db)
            let qNumbers = try LockinCore.questionNumbers(db: db, lectureId: id)
            let attempts = try Attempt
                .filter(Column("lectureId") == id)
                .order(Column("sittingDate").desc)
                .fetchAll(db)
            let lastRun = try Job
                .filter(
                    Column("lectureId") == id &&
                        [JobKind.prepare.rawValue, JobKind.generate.rawValue].contains(Column("kind")) &&
                        Column("status") == JobStatus.done.rawValue
                )
                .order(Column("finishedAt").desc)
                .fetchOne(db)
            let modelInfo = describeModels(lecture: lecture, questions: questions, lastRun: lastRun)

            let skippedItems = readSkipped(lecture.skipped)

            let sittingPerHourRaw = try Setting.fetchOne(db, key: "sittingPerHour")?.value ?? "2"
            let sittingPerHour = Double(sittingPerHourRaw) ?? 2.0
            let sittingBudget = questionBudget(durationHours: lecture.durationHours, perHour: sittingPerHour)

            let glossaryRows = try GlossaryTerm
                .filter(Column("lectureId") == id)
                .order(Column("createdAt").asc)
                .fetchAll(db)
            let glossaryTerms = glossaryRows.map {
                GlossaryEntry(id: $0.id, term: $0.term, explanation: $0.explanation)
            }

            let askJobs = try Job
                .filter(Column("lectureId") == id && Column("kind") == JobKind.ask.rawValue)
                .order(Column("createdAt").desc)
                .limit(20)
                .fetchAll(db)

            return LectureDetailSnapshot(
                lecture: lecture,
                row: row,
                course: course,
                module: module,
                courseModules: courseModules,
                materials: materials,
                questions: questions,
                questionNumbers: qNumbers,
                attempts: attempts,
                modelInfo: modelInfo,
                skipped: skippedItems,
                sittingBudget: sittingBudget,
                slidesInfo: slidesInfo,
                glossaryTerms: glossaryTerms,
                askHistory: askHistory,
                askJobs: askJobs
            )
        }
    }
}
