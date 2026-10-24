import Foundation
import GRDB
import os

// The queue's job handlers (`handlers` in worker/index.ts), `lookLocally`, and the bodies
// of the side lanes' `sortOne` and `askOne`. JobQueue.swift claims a job, picks its
// handler, runs it on the provider (falling back to the offline model when the cloud
// fails) and records the result; the handlers only do the work and say which stage
// they are at.

private let handlersLog = Logger(subsystem: "app.lockin", category: "queue")

/// One main-lane job: its parsed payload, its context and the provider to run on; the
/// result is stored in `Job.result`.
public typealias JobHandler = @Sendable (JSONValue, JobContext, any LLMProvider) async throws -> JSONValue

/// The handler for a main-lane kind (PREPARE, GENERATE, MARK); nil for any other.
public func mainLaneHandler(for kind: JobKind) -> JobHandler? {
    if kind == .prepare {
        return { payload, context, provider in try await handlePrepare(payload, context, provider) }
    }
    if kind == .generate {
        return { payload, context, provider in try await handleGenerate(payload, context, provider) }
    }
    if kind == .mark {
        return { payload, context, provider in try await handleMark(payload, context, provider) }
    }
    return nil
}

/// `String(payload.<key>)`: "undefined" when the key is missing.
private func payloadString(_ payload: JSONValue, _ key: String) -> String {
    guard let value = payload[key] else { return "undefined" }
    return jsString(value)
}

// MARK: - PREPARE

private struct PrepareState: Sendable {
    var summaryMd: String?
    var questions: Int
    /// Live (not merged-away) concepts.
    var concepts: Int
}

private func prepareState(database: LockinDatabase, lectureId: String) throws -> PrepareState {
    try database.reader.read { db -> PrepareState in
        guard let row = try Row.fetchOne(db, sql: #"SELECT "summaryMd" FROM "Lecture" WHERE "id" = ?"#, arguments: [lectureId]) else {
            throw LockinError(prismaRecordNotFound)
        }
        let summaryMd: String? = row["summaryMd"]
        let questions = try Int.fetchOne(
            db,
            sql: #"SELECT COUNT(*) FROM "Question" WHERE "lectureId" = ?"#,
            arguments: [lectureId]
        ) ?? 0
        let concepts = try liveConceptCount(db: db, lectureId: lectureId)
        return PrepareState(summaryMd: summaryMd, questions: questions, concepts: concepts)
    }
}

private func liveConceptCount(db: Database, lectureId: String) throws -> Int {
    try Int.fetchOne(
        db,
        sql: #"SELECT COUNT(*) FROM "Concept" WHERE "lectureId" = ? AND "mergedIntoId" IS NULL"#,
        arguments: [lectureId]
    ) ?? 0
}

private func liveConceptCount(database: LockinDatabase, lectureId: String) throws -> Int {
    try database.reader.read { db -> Int in
        try liveConceptCount(db: db, lectureId: lectureId)
    }
}

/// Files → title, summary, concepts → first LAQs. Skips whatever is already done.
///
/// The result's keys, in order: `slidesSeen`, `slideReader`, `visionFailed` (the offline
/// model looking at the slides), `slidePictures` (words read from slide pictures),
/// `digest`, `questions`.
public func handlePrepare(_ payload: JSONValue, _ context: JobContext, _ provider: any LLMProvider) async throws -> JSONValue {
    let lectureId = payloadString(payload, "lectureId")
    let redo = payload["redo"]?.boolValue == true
    let state = try prepareState(database: context.database, lectureId: lectureId)

    var result = JSONObject()
    if redo || (state.summaryMd ?? "").isEmpty || state.concepts == 0 {
        var visionNotes: [SlideNote]? = nil
        if !provider.seesSlides {
            // An offline model with its vision part is shown each slide first.
            visionNotes = try await lookLocally(lectureId: lectureId, context: context, provider: provider, result: &result)
            // Otherwise the words on picture-only slides are read out. Only pages never
            // read before take any time.
            if visionNotes?.isEmpty ?? true {
                let read = try await readSlidePictures(
                    database: context.database,
                    lectureId: lectureId,
                    services: context.services,
                    onStart: { try context.enterStage(.slides) },
                    onProgress: { detail in context.setDetail(detail) }
                )
                if read.pages > 0 {
                    result["slidePictures"] = read.json
                }
            }
        }
        try context.enterStage(.digest)
        // A pasted summary is the student's; keep it unless they asked for a redo.
        let digest = try await digestLecture(
            database: context.database,
            lectureId: lectureId,
            keepSummary: !redo,
            visionNotes: visionNotes,
            provider: provider,
            renderer: context.services.renderer
        )
        result["digest"] = digest.json
    }
    if state.questions == 0 {
        try context.enterStage(.questions)
        let questions = try await writeQuestions(database: context.database, lectureId: lectureId, provider: provider)
        result["questions"] = questions.json
    }
    return .object(result)
}

/// Shows an offline model the lecture's slides, when it can see. A failure is noted in
/// the result and preparing carries on without: text recognition reads the slides instead.
/// On MLX a pair's eye (the slide reader) looks for the writer; else the writer looks itself.
private func lookLocally(
    lectureId: String,
    context: JobContext,
    provider: any LLMProvider,
    result: inout JSONObject
) async throws -> [SlideNote]? {
    guard let offline = provider as? any OfflineModelProvider else { return nil }
    let reader = try activeSlideReader(database: context.database)
    let mlx = reader != nil || findModel(offline.modelId)?.vision == true
    let decks = try lectureDecks(database: context.database, lectureId: lectureId, renderer: context.services.renderer)
        .filter { $0.isPictured }
    if !mlx || decks.isEmpty {
        return nil
    }
    try context.enterStage(.vision)
    let slides = SlidesInfo(lectureId: lectureId, decks: decks, sharedWith: [])
    do {
        let notes = try await lookAtSlidesMlx(
            modelDirectory: reader?.path ?? offline.modelPath,
            slides: slides,
            renderer: context.services.renderer,
            engine: context.services.engine,
            onProgress: { detail in context.setDetail(detail) }
        )
        result["slidesSeen"] = .int(notes.count)
        if let reader {
            result["slideReader"] = .string(reader.model.name)
        }
        return notes
    } catch {
        // Cancelled on purpose: the job stops here.
        if Task.isCancelled {
            throw CancellationError()
        }
        if error is CancellationError {
            throw error
        }
        let message = messageOf(error)
        handlersLog.warning("couldn't show the slides to the offline model on MLX (\(message, privacy: .public)); reading them as text instead")
        result["visionFailed"] = .string(message)
        return nil
    }
}

// MARK: - GENERATE and MARK

/// Fresh LAQs aimed at weak concepts. Digests first if the lecture never was.
public func handleGenerate(_ payload: JSONValue, _ context: JobContext, _ provider: any LLMProvider) async throws -> JSONValue {
    let lectureId = payloadString(payload, "lectureId")
    let concepts = try liveConceptCount(database: context.database, lectureId: lectureId)
    if concepts == 0 {
        try context.enterStage(.digest)
        _ = try await digestLecture(
            database: context.database,
            lectureId: lectureId,
            keepSummary: true,
            visionNotes: nil,
            provider: provider,
            renderer: context.services.renderer
        )
    }
    try context.enterStage(.questions)
    return try await writeQuestions(database: context.database, lectureId: lectureId, provider: provider).json
}

public func handleMark(_ payload: JSONValue, _ context: JobContext, _ provider: any LLMProvider) async throws -> JSONValue {
    try context.enterStage(.marking)
    let responseId = payloadString(payload, "responseId")
    return try await markResponse(database: context.database, responseId: responseId, provider: provider).json
}

// MARK: - SORT (sortOne)

/// The files listed in a SORT payload (`{root, files}`, written by `enqueueSortJob`).
private func sortFilesOf(_ payload: JSONValue) throws -> [SortFile] {
    guard let value = payload["files"] else {
        throw LockinError("Cannot read properties of undefined (reading 'map')")
    }
    guard case .array(let items) = value else {
        if value.isNull {
            throw LockinError("Cannot read properties of null (reading 'map')")
        }
        throw LockinError("files.map is not a function")
    }
    func text(_ field: JSONValue?) -> String {
        guard let field, !field.isNull else { return "" }
        return field.stringValue ?? jsString(field)
    }
    return items.enumerated().map { index, item in
        SortFile(
            number: item["number"]?.intValue ?? index + 1,
            path: text(item["path"]),
            detail: text(item["detail"]),
            excerpt: text(item["excerpt"])
        )
    }
}

/// Sorts a folder's files into lectures. The model answers in file numbers; the import
/// screen knows files by path, so numbers become paths and unknown ones are dropped.
public func handleSort(_ payload: JSONValue, provider: any LLMProvider) async throws -> SortedFolder {
    let files = try sortFilesOf(payload)
    let sorted = try await provider.sortFiles(SortFilesInput(files: files))
    // `files[n - 1]?.path`, kept only when it is a path.
    func pathOf(_ number: Int) -> String? {
        guard number >= 1, number <= files.count else { return nil }
        let path = files[number - 1].path
        return path.isEmpty ? nil : path
    }
    let lectures = sorted.lectures.map { lecture -> SortedFolder.LectureItem in
        SortedFolder.LectureItem(title: lecture.title, module: lecture.module, files: lecture.files.compactMap { pathOf($0) })
    }
    let setAside = sorted.setAside.compactMap { item -> SortedFolder.SetAsideItem? in
        guard let file = pathOf(item.file) else { return nil }
        return SortedFolder.SetAsideItem(file: file, reason: item.reason)
    }
    return SortedFolder(lectures: lectures, setAside: setAside)
}

/// A sorted folder as the SORT job's result: `JSON.stringify(result)` of
/// `{lectures:[{title,module,files}], setAside:[{file,reason}]}`.
public func sortedFolderJSON(_ folder: SortedFolder) -> JSONValue {
    let lectures = folder.lectures.map { lecture -> JSONValue in
        ["title": .string(lecture.title), "module": .orNull(lecture.module), "files": .strings(lecture.files)]
    }
    let setAside = folder.setAside.map { item -> JSONValue in
        ["file": .string(item.file), "reason": .string(item.reason)]
    }
    return ["lectures": .array(lectures), "setAside": .array(setAside)]
}

// MARK: - ASK (askOne)

/// Answers a question asked on a lecture page (`runAsk(payload, provider)`); the queue
/// adds who answered (`model`) before storing the result.
public func handleAsk(_ payload: JSONValue, database: LockinDatabase, provider: any LLMProvider) async throws -> AskResult {
    let parsed = try AskPayload.parse(payload)
    return try await runAsk(database: database, payload: parsed, provider: provider)
}
