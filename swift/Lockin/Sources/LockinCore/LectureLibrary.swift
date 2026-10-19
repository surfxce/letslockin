import Foundation
import GRDB

public enum LectureStatus: String, CaseIterable, Codable, Sendable {
    case empty
    case todo
    case queued
    case working
    case failed
    case summary
    case ready
    case practised

    public var label: String {
        switch self {
        case .empty: return "No material"
        case .todo: return "Not prepared"
        case .queued: return "Queued"
        case .working: return "Preparing"
        case .failed: return "Failed"
        case .summary: return "Needs LAQs"
        case .ready: return "Ready"
        case .practised: return "Practised"
        }
    }

    public static let statusOrder: [LectureStatus] = [
        .failed, .working, .queued, .todo, .summary, .ready, .practised, .empty,
    ]
}

public struct LectureRow: Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var ordinal: Int
    public var courseId: String
    public var courseCode: String
    public var moduleId: String?
    public var moduleTitle: String?
    public var deliveredOn: Date
    public var durationHours: Double
    public var hasSummary: Bool
    public var laqCount: Int
    public var fileCount: Int
    public var sittings: Int
    public var lastScore: Double?
    public var prevScore: Double?
    public var bestScore: Double?
    public var lastSatOn: Date?
    public var dueAt: Date?
    public var status: LectureStatus
    public var stageLabel: String?
    public var queuePosition: Int?
    public var error: String?

    public init(
        id: String,
        title: String,
        ordinal: Int,
        courseId: String,
        courseCode: String,
        moduleId: String?,
        moduleTitle: String?,
        deliveredOn: Date,
        durationHours: Double,
        hasSummary: Bool,
        laqCount: Int,
        fileCount: Int,
        sittings: Int,
        lastScore: Double?,
        prevScore: Double?,
        bestScore: Double?,
        lastSatOn: Date?,
        dueAt: Date?,
        status: LectureStatus,
        stageLabel: String?,
        queuePosition: Int?,
        error: String?
    ) {
        self.id = id
        self.title = title
        self.ordinal = ordinal
        self.courseId = courseId
        self.courseCode = courseCode
        self.moduleId = moduleId
        self.moduleTitle = moduleTitle
        self.deliveredOn = deliveredOn
        self.durationHours = durationHours
        self.hasSummary = hasSummary
        self.laqCount = laqCount
        self.fileCount = fileCount
        self.sittings = sittings
        self.lastScore = lastScore
        self.prevScore = prevScore
        self.bestScore = bestScore
        self.lastSatOn = lastSatOn
        self.dueAt = dueAt
        self.status = status
        self.stageLabel = stageLabel
        self.queuePosition = queuePosition
        self.error = error
    }
}

// Avoid loading payloads/token buffers and observing every progress write merely to
// show a lecture's status in the library.
private struct LibraryJob: FetchableRecord, Decodable {
    var id: String
    var lectureId: String?
    var status: JobStatus
    var stage: String?
    var error: String?
}

public func lectureRows(
    db: Database,
    courseId: String? = nil,
    ids: [String]? = nil
) throws -> [LectureRow] {
    var request = Lecture.order(Column("deliveredOn").asc, Column("createdAt").asc)
    if let courseId {
        request = request.filter(Column("courseId") == courseId)
    }
    if let ids {
        request = request.filter(ids.contains(Column("id")))
    }
    let lectures = try request.fetchAll(db)
    if lectures.isEmpty { return [] }

    let courses = try Course.fetchAll(db)
    let courseById = Dictionary(uniqueKeysWithValues: courses.map { ($0.id, $0) })

    let modules = try Module.fetchAll(db)
    let moduleById = Dictionary(uniqueKeysWithValues: modules.map { ($0.id, $0) })

    // Places in the queue lectures wait in; side lanes (downloads, sorts, asks) run beside it.
    let pendingIds = try String.fetchAll(db, sql: """
        SELECT id FROM Job WHERE status = 'PENDING' AND kind NOT IN ('DOWNLOAD', 'SORT', 'ASK')
        ORDER BY priority DESC, createdAt ASC
        """)
    let positionById = Dictionary(uniqueKeysWithValues: pendingIds.enumerated().map { ($0.element, $0.offset + 1) })

    // L-numbers count within a course, so they need the whole course even when filtered.
    let courseIds = Array(Set(lectures.map(\.courseId)))
    let siblings = try Lecture
        .filter(courseIds.contains(Column("courseId")))
        .order(Column("deliveredOn").asc, Column("createdAt").asc)
        .fetchAll(db)
    var ordinals: [String: Int] = [:]
    var counters: [String: Int] = [:]
    for s in siblings {
        let next = (counters[s.courseId] ?? 0) + 1
        counters[s.courseId] = next
        ordinals[s.id] = next
    }

    let lectureIds = lectures.map(\.id)
    let questions = try Question
        .filter(lectureIds.contains(Column("lectureId")))
        .order(Column("createdAt").asc)
        .fetchAll(db)
    let questionsByLecture = Dictionary(grouping: questions, by: \.lectureId)

    let materials = try Material
        .filter(lectureIds.contains(Column("lectureId")))
        .fetchAll(db)
    var materialCountByLecture: [String: Int] = [:]
    for m in materials {
        if let lid = m.lectureId {
            materialCountByLecture[lid, default: 0] += 1
        }
    }

    let attempts = try Attempt
        .filter(lectureIds.contains(Column("lectureId")) && Column("geometricMean") != nil)
        .order(Column("sittingDate").asc)
        .fetchAll(db)
    let attemptsByLecture = Dictionary(grouping: attempts, by: \.lectureId)

    let prepJobs = try Job
        .select(Column("id"), Column("lectureId"), Column("status"), Column("stage"), Column("error"), Column("createdAt"))
        .filter(
            lectureIds.contains(Column("lectureId")) &&
                [JobKind.prepare.rawValue, JobKind.generate.rawValue].contains(Column("kind"))
        )
        .order(Column("createdAt").desc)
        .asRequest(of: LibraryJob.self)
        .fetchAll(db)
    var latestJobByLecture: [String: LibraryJob] = [:]
    for j in prepJobs {
        if let lid = j.lectureId, latestJobByLecture[lid] == nil {
            latestJobByLecture[lid] = j
        }
    }

    return lectures.map { l in
        let course = courseById[l.courseId]
        let mod = l.moduleId.flatMap { moduleById[$0] }
        let lQuestions = questionsByLecture[l.id] ?? []
        let lAttempts = attemptsByLecture[l.id] ?? []
        let scores = lAttempts.compactMap(\.geometricMean)
        let sittings = lAttempts.compactMap { a -> Sitting? in
            guard let score = a.geometricMean else { return nil }
            return Sitting(at: a.completedAt ?? a.sittingDate, score: score)
        }
        let review = nextReview(
            sittings: sittings,
            readySince: lQuestions.first?.createdAt,
            examDate: course?.examDate
        )
        let job = latestJobByLecture[l.id]
        let laqCount = lQuestions.count
        let fileCount = materialCountByLecture[l.id] ?? 0
        let hasSummary = !(l.summaryMd ?? "").isEmpty

        let status: LectureStatus
        if job?.status == .running {
            status = .working
        } else if job?.status == .pending {
            status = .queued
        } else if !scores.isEmpty {
            status = .practised
        } else if laqCount > 0 {
            status = .ready
        } else if job?.status == .failed {
            status = .failed
        } else if hasSummary {
            status = .summary
        } else if fileCount == 0 {
            status = .empty
        } else {
            status = .todo
        }

        let stageLabel: String? = (status == .working && job?.stage != nil)
            ? Stage(rawValue: job!.stage!)?.label
            : nil
        let queuePos: Int? = (status == .queued && job != nil)
            ? positionById[job!.id]
            : nil
        let errText: String? = status == .failed ? job?.error : nil

        return LectureRow(
            id: l.id,
            title: l.title,
            ordinal: ordinals[l.id] ?? 0,
            courseId: l.courseId,
            courseCode: course?.code ?? "",
            moduleId: mod?.id,
            moduleTitle: mod?.title,
            deliveredOn: l.deliveredOn,
            durationHours: l.durationHours,
            hasSummary: hasSummary,
            laqCount: laqCount,
            fileCount: fileCount,
            sittings: scores.count,
            lastScore: scores.last,
            prevScore: scores.count >= 2 ? scores[scores.count - 2] : nil,
            bestScore: scores.max(),
            lastSatOn: sittings.last?.at,
            dueAt: laqCount > 0 ? review.dueAt : nil,
            status: status,
            stageLabel: stageLabel,
            queuePosition: queuePos,
            error: errText
        )
    }
}

/// Lectures whose LAQs are due today or overdue, most overdue first.
public func dueLectures(
    db: Database,
    now: Date = Date(),
    calendar: Calendar = .gregorian
) throws -> [LectureRow] {
    dueLectures(rows: try lectureRows(db: db), now: now, calendar: calendar)
}

/// Reuses the library snapshot instead of querying and scoring every lecture twice.
public func dueLectures(
    rows: [LectureRow],
    now: Date = Date(),
    calendar: Calendar = .gregorian
) -> [LectureRow] {
    let startOfToday = calendar.startOfDay(for: now)
    let endOfToday = calendar.date(byAdding: .day, value: 1, to: startOfToday) ?? startOfToday.addingTimeInterval(86_400)
    return rows
        .filter { row in
            guard let dueAt = row.dueAt else { return false }
            return dueAt < endOfToday
        }
        .sorted { ($0.dueAt ?? .distantFuture) < ($1.dueAt ?? .distantFuture) }
}

/// Stable "LAQ n" numbers within a lecture, by creation order.
public func questionNumbers(db: Database, lectureId: String) throws -> [String: Int] {
    let questions = try Question
        .filter(Column("lectureId") == lectureId)
        .order(Column("createdAt").asc, Column("id").asc)
        .fetchAll(db)
    var map: [String: Int] = [:]
    for (idx, q) in questions.enumerated() {
        map[q.id] = idx + 1
    }
    return map
}

// MARK: - Sorting, Grouping, and Filtering (port of LectureTable.tsx)

public enum LectureSortKey: String, CaseIterable, Codable, Sendable {
    case date
    case name
    case score
    case due
    case status
    case laqs
    case module
    case course
}

public enum SortDirection: String, CaseIterable, Codable, Sendable {
    case asc
    case desc
}

public enum LectureGroupKey: String, CaseIterable, Codable, Sendable {
    case none
    case module
    case status
    case course

    public var label: String {
        switch self {
        case .none: return "No grouping"
        case .module: return "Module"
        case .status: return "Status"
        case .course: return "Course"
        }
    }
}

public struct LectureTableViewConfig: Equatable, Codable, Sendable {
    public var sort: LectureSortKey
    public var dir: SortDirection
    public var group: LectureGroupKey

    public static let `default` = LectureTableViewConfig(sort: .date, dir: .asc, group: .none)

    public init(sort: LectureSortKey = .date, dir: SortDirection = .asc, group: LectureGroupKey = .none) {
        self.sort = sort
        self.dir = dir
        self.group = group
    }

    public mutating func toggleSort(_ key: LectureSortKey) {
        if sort == key {
            dir = (dir == .asc) ? .desc : .asc
        } else {
            sort = key
            dir = (key == .laqs) ? .desc : .asc
        }
    }
}

public struct LectureGroup: Identifiable, Equatable, Sendable {
    public var id: String { name.isEmpty ? "__all__" : name }
    public var name: String
    public var rows: [LectureRow]
    public var avg: Double?

    public init(name: String, rows: [LectureRow], avg: Double?) {
        self.name = name
        self.rows = rows
        self.avg = avg
    }
}

/// Nulls always sink, whichever way the column is sorted.
public func compareLectureRows(
    _ a: LectureRow,
    _ b: LectureRow,
    key: LectureSortKey,
    dir: SortDirection
) -> Int {
    let sign = (dir == .asc) ? 1 : -1

    func nullsLastComparable<T: Comparable>(_ x: T?, _ y: T?) -> Int {
        if x == nil && y == nil { return 0 }
        if x == nil { return 1 }
        if y == nil { return -1 }
        if x! < y! { return -1 * sign }
        if x! > y! { return 1 * sign }
        return 0
    }

    switch key {
    case .date:
        let cmp = nullsLastComparable(a.deliveredOn, b.deliveredOn)
        return cmp != 0 ? cmp : (a.ordinal - b.ordinal)
    case .name:
        let cmp = a.title.localizedCaseInsensitiveCompare(b.title)
        if cmp == .orderedAscending { return -1 * sign }
        if cmp == .orderedDescending { return 1 * sign }
        return 0
    case .score:
        let cmp = nullsLastComparable(a.lastScore, b.lastScore)
        return cmp != 0 ? cmp : nullsLastComparable(a.deliveredOn, b.deliveredOn)
    case .due:
        let cmp = nullsLastComparable(a.dueAt, b.dueAt)
        return cmp != 0 ? cmp : nullsLastComparable(a.lastScore, b.lastScore)
    case .status:
        let idxA = LectureStatus.statusOrder.firstIndex(of: a.status) ?? 0
        let idxB = LectureStatus.statusOrder.firstIndex(of: b.status) ?? 0
        return (idxA - idxB) * sign
    case .laqs:
        return (a.laqCount - b.laqCount) * sign
    case .module:
        let cmp = nullsLastComparable(a.moduleTitle, b.moduleTitle)
        return cmp != 0 ? cmp : (a.ordinal - b.ordinal)
    case .course:
        let cmp = a.courseCode.localizedCaseInsensitiveCompare(b.courseCode)
        if cmp == .orderedAscending { return -1 * sign }
        if cmp == .orderedDescending { return 1 * sign }
        return a.ordinal - b.ordinal
    }
}

public func averageLectureScore(_ rows: [LectureRow]) -> Double? {
    let scored = rows.compactMap(\.lastScore)
    guard !scored.isEmpty else { return nil }
    return scored.reduce(0, +) / Double(scored.count)
}

public func filterAndSortLectures(
    _ rows: [LectureRow],
    query: String = "",
    view: LectureTableViewConfig = .default
) -> [LectureRow] {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let hits: [LectureRow]
    if q.isEmpty {
        hits = rows
    } else {
        hits = rows.filter { r in
            [r.title, r.moduleTitle ?? "", r.courseCode, "l\(r.ordinal)"]
                .contains { $0.lowercased().contains(q) }
        }
    }
    return hits.sorted { compareLectureRows($0, $1, key: view.sort, dir: view.dir) < 0 }
}

public func groupLectures(
    _ rows: [LectureRow],
    query: String = "",
    view: LectureTableViewConfig = .default
) -> [LectureGroup] {
    let filtered = filterAndSortLectures(rows, query: query, view: view)
    if view.group == .none {
        return [LectureGroup(name: "", rows: filtered, avg: averageLectureScore(filtered))]
    }

    var order: [String] = []
    var groupsByKey: [String: [LectureRow]] = [:]
    for r in filtered {
        let g: String
        switch view.group {
        case .module: g = r.moduleTitle ?? "No module"
        case .status: g = r.status.label
        case .course: g = r.courseCode
        case .none: g = ""
        }
        if groupsByKey[g] == nil {
            order.append(g)
            groupsByKey[g] = []
        }
        groupsByKey[g]?.append(r)
    }

    var list = order.map { name -> LectureGroup in
        let groupRows = groupsByKey[name] ?? []
        return LectureGroup(name: name, rows: groupRows, avg: averageLectureScore(groupRows))
    }

    if view.group == .status {
        list.sort { a, b in
            let idxA = a.rows.first.flatMap { LectureStatus.statusOrder.firstIndex(of: $0.status) } ?? 0
            let idxB = b.rows.first.flatMap { LectureStatus.statusOrder.firstIndex(of: $0.status) } ?? 0
            return idxA < idxB
        }
    } else if view.sort == .score {
        let sign = (view.dir == .asc) ? 1.0 : -1.0
        list.sort { a, b in
            if a.avg == nil && b.avg == nil { return false }
            if a.avg == nil { return false }
            if b.avg == nil { return true }
            return (a.avg! - b.avg!) * sign < 0
        }
    }

    return list
}

// MARK: - ModelInfo (port of ModelInfo.tsx & describeModels)

public struct ModelInfoData: Equatable, Sendable {
    public struct LaqModelCount: Equatable, Sendable {
        public var model: String
        public var count: Int

        public init(model: String, count: Int) {
            self.model = model
            self.count = count
        }
    }

    public struct LastRunInfo: Equatable, Sendable {
        public var what: String
        public var model: String?
        public var durationMs: Int?
        public var finishedAt: Date
        public var fellBack: String?

        public init(what: String, model: String?, durationMs: Int?, finishedAt: Date, fellBack: String?) {
            self.what = what
            self.model = model
            self.durationMs = durationMs
            self.finishedAt = finishedAt
            self.fellBack = fellBack
        }
    }

    /// Nil when there is no summary; "" when it was written before Lockin kept track.
    public var summary: String?
    public var laqs: [LaqModelCount]
    public var lastRun: LastRunInfo?

    public var isEmpty: Bool {
        summary == nil && laqs.isEmpty && lastRun == nil
    }

    public init(summary: String?, laqs: [LaqModelCount], lastRun: LastRunInfo?) {
        self.summary = summary
        self.laqs = laqs
        self.lastRun = lastRun
    }
}

public func describeModels(
    lecture: Lecture,
    questions: [Question],
    lastRun: Job?
) -> ModelInfoData {
    var laqOrder: [String] = []
    var laqCounts: [String: Int] = [:]
    for q in questions {
        let by = q.model ?? (q.promptVersion == "pasted" ? "Pasted from an AI chat" : "a model Lockin didn't record")
        if laqCounts[by] == nil {
            laqOrder.append(by)
        }
        laqCounts[by, default: 0] += 1
    }

    var fellBack: String? = nil
    if let rawResult = lastRun?.result,
       let data = rawResult.data(using: .utf8),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let fb = json["fellBack"] as? String {
        fellBack = fb
    }

    let lastRunInfo: ModelInfoData.LastRunInfo?
    if let lastRun, let finishedAt = lastRun.finishedAt {
        lastRunInfo = ModelInfoData.LastRunInfo(
            what: lastRun.kind == .prepare ? "Prepared" : "Wrote new LAQs",
            model: lastRun.model,
            durationMs: lastRun.durationMs,
            finishedAt: finishedAt,
            fellBack: fellBack
        )
    } else {
        lastRunInfo = nil
    }

    let hasSummary = !(lecture.summaryMd ?? "").isEmpty
    return ModelInfoData(
        summary: hasSummary ? (lecture.summaryModel ?? "") : nil,
        laqs: laqOrder.map { ModelInfoData.LaqModelCount(model: $0, count: laqCounts[$0] ?? 0) },
        lastRun: lastRunInfo
    )
}
