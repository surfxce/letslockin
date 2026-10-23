import Foundation
import LockinKit
import Observation
import UIKit

/// A sitting being answered on the phone: saved as it is typed, until it is submitted.
struct Draft: Codable, Hashable, Identifiable {
    var id: String
    var lectureId: String
    var questionIds: [String]
    var startedAt: Date
    var answers: [String: String]
}

/// Everything the app knows and does: the paired computer, its library as last synced,
/// and what was done here since (sittings, card reviews) waiting to be sent.
@MainActor
@Observable
final class AppModel {
    private(set) var pairing: Pairing?
    private(set) var snapshot: Snapshot?
    private(set) var outboxSittings: [PhoneSitting] = []
    private(set) var outboxReviews: [CardReview] = []
    private(set) var drafts: [Draft] = []
    private(set) var lastSyncAt: Date?

    private(set) var syncing = false
    private(set) var syncStatus: String?
    private(set) var syncError: String?
    private(set) var pictures: (done: Int, total: Int)?
    /// Sittings being marked on the phone right now.
    private(set) var marking: Set<String> = []

    let images = ImageStore()
    @ObservationIgnored private var client: SyncClient?
    @ObservationIgnored private var draftSave: Task<Void, Never>?

    init() {
        load()
    }

    // MARK: - What the screens read

    var courses: [Course] { snapshot?.courses ?? [] }

    func lectures(in courseId: String) -> [Lecture] {
        (snapshot?.lectures ?? []).filter { $0.courseId == courseId }.sorted { $0.ordinal > $1.ordinal }
    }

    func lecture(_ id: String) -> Lecture? { snapshot?.lectures.first { $0.id == id } }

    func course(_ id: String) -> Course? { snapshot?.courses.first { $0.id == id } }

    func cards(for lectureId: String?) -> [Card] {
        (snapshot?.cards ?? []).filter { lectureId == nil || $0.lectureId == lectureId }
    }

    func dueCount(for lectureId: String? = nil, now: Date = Date()) -> Int {
        dueCards(cards(for: lectureId), now: now).count
    }

    func sittings(for lectureId: String) -> [SittingRecord] {
        sittingRecords(lectureId: lectureId, snapshot: snapshot, outbox: outboxSittings)
    }

    func draft(for lectureId: String) -> Draft? { drafts.first { $0.lectureId == lectureId } }

    func draft(id: String) -> Draft? { drafts.first { $0.id == id } }

    var unsentCount: Int { outboxSittings.count + outboxReviews.count }

    /// Who marks answers: this phone with the API key, or the computer at the next sync.
    var markingNote: String {
        if let marking = snapshot?.marking { return "Answers are marked on this phone with \(marking.label)." }
        let computer = pairing?.computer ?? "your computer"
        if let marker = snapshot?.computerMarker {
            return "Answers are saved here and marked on \(computer) with \(marker) after you sync."
        }
        return "Answers are saved here and sent to \(computer) when you sync. Lockin is in copy & paste mode there, so mark them on the computer."
    }

    // MARK: - Pairing

    /// Pairs with the computer in a scanned or pasted code. Nil on success, else why not.
    func pair(with text: String) async -> String? {
        guard let found = Pairing.parse(text) else {
            return "That isn't a Lockin pairing code. On your computer, open Lockin → Settings → iPhone → Pair an iPhone."
        }
        guard let client = SyncClient(pairing: found, device: device) else { return "That pairing code is damaged. Show a new one." }
        do {
            try await client.hello()
        } catch {
            return error.localizedDescription
        }
        let newComputer = pairing?.id != found.id
        if newComputer {
            // Another computer's library: start afresh. Unsent work stays and is offered to it.
            snapshot = nil
            images.removeAll()
            lastSyncAt = nil
        }
        pairing = client.pairing
        self.client = client
        client.onHostChange = { [weak self] host in Task { @MainActor in self?.rememberHost(host) } }
        savePairing()
        saveState()
        await sync()
        return nil
    }

    func unpair() {
        pairing = nil
        client = nil
        snapshot = nil
        outboxSittings = []
        outboxReviews = []
        drafts = []
        lastSyncAt = nil
        syncError = nil
        Keychain.delete("pairing")
        Keychain.delete("marking")
        images.removeAll()
        saveState()
        saveOutbox()
        saveDrafts()
    }

    private func rememberHost(_ host: String) {
        pairing?.lastHost = host
        savePairing()
    }

    private var device: Device {
        let info = Bundle.main.infoDictionary
        let version = "\(info?["CFBundleShortVersionString"] as? String ?? "1.0") (\(info?["CFBundleVersion"] as? String ?? "1"))"
        return Device(name: UIDevice.current.name, app: version)
    }

    private func makeClient() -> SyncClient? {
        if let client { return client }
        guard let pairing, let made = SyncClient(pairing: pairing, device: device) else { return nil }
        made.onHostChange = { [weak self] host in Task { @MainActor in self?.rememberHost(host) } }
        client = made
        return made
    }

    // MARK: - Sync

    /// When the app comes to the front: sync if it has been a while or there's work to send.
    func syncIfStale() async {
        guard pairing != nil, !syncing else { return }
        if unsentCount > 0 || lastSyncAt.map({ Date().timeIntervalSince($0) > 60 }) ?? true {
            await sync()
        }
    }

    func sync() async {
        guard pairing != nil, !syncing, let client = makeClient() else { return }
        syncing = true
        syncError = nil
        syncStatus = "Connecting to \(client.pairing.computer)…"
        defer {
            syncing = false
            syncStatus = nil
        }
        do {
            try await client.hello()
            syncStatus = "Syncing…"
            let reply = try await client.sync(SyncRequest(device: device, sittings: outboxSittings, reviews: outboxReviews))
            let sentSittings = Set(reply.accepted.sittings)
            let sentReviews = Set(reply.accepted.reviews)
            // Anything done while the sync was on its way stays to be sent next time.
            outboxSittings.removeAll { sentSittings.contains($0.id) }
            outboxReviews.removeAll { sentReviews.contains($0.id) }
            var fresh = reply.snapshot
            applyPendingReviews(to: &fresh)
            snapshot = fresh
            lastSyncAt = Date()
            saveState()
            saveOutbox()
            if let problems = reply.problems, !problems.isEmpty { syncError = problems.joined(separator: "\n") }
            await downloadPictures(client)
        } catch {
            syncError = error.localizedDescription
        }
    }

    /// Reviews made here that the computer hasn't had yet, shown on its fresh copy of the cards.
    private func applyPendingReviews(to snapshot: inout Snapshot) {
        for review in outboxReviews.sorted(by: { $0.reviewedAt < $1.reviewedAt }) {
            guard let rating = Rating(rawValue: review.rating),
                  let index = snapshot.cards.firstIndex(where: { $0.id == review.cardId && $0.version == review.version })
            else { continue }
            snapshot.cards[index] = snapshot.cards[index].reviewed(rating, now: review.reviewedAt).card
        }
    }

    private func downloadPictures(_ client: SyncClient) async {
        guard let snapshot else { return }
        let wanted = snapshot.lectures.flatMap { lecture in lecture.images.map { (lectureId: lecture.id, ref: $0) } }
        images.prune(keeping: wanted)
        var queue = wanted.filter { !images.has(lectureId: $0.lectureId, ref: $0.ref) }[...]
        let total = queue.count
        guard total > 0 else { return }
        pictures = (0, total)
        syncStatus = "Downloading slide pictures…"
        let store = images
        var done = 0
        var failed = 0
        await withTaskGroup(of: Bool.self) { group in
            for _ in 0..<min(4, queue.count) {
                let item = queue.removeFirst()
                group.addTask { await Self.fetch(item.lectureId, item.ref, client: client, store: store) }
            }
            while let ok = await group.next() {
                done += 1
                if !ok { failed += 1 }
                pictures = (done, total)
                if !queue.isEmpty {
                    let item = queue.removeFirst()
                    group.addTask { await Self.fetch(item.lectureId, item.ref, client: client, store: store) }
                }
            }
        }
        pictures = nil
        if failed > 0 {
            syncError = "\(failed) slide picture\(failed == 1 ? "" : "s") couldn't be downloaded. They'll be tried at the next sync."
        }
    }

    nonisolated private static func fetch(_ lectureId: String, _ ref: String, client: SyncClient, store: ImageStore) async -> Bool {
        guard let data = try? await client.slide(lectureId: lectureId, ref: ref) else { return false }
        store.write(data, lectureId: lectureId, ref: ref)
        return true
    }

    // MARK: - Sittings

    func startSitting(_ lecture: Lecture) -> Draft {
        if let open = draft(for: lecture.id) { return open }
        let picked = lecture.nextSitting.filter { id in lecture.questions.contains { $0.id == id } }
        let draft = Draft(
            id: LockinID.make(prefix: "s"),
            lectureId: lecture.id,
            questionIds: picked.isEmpty ? lecture.questions.map(\.id) : picked,
            startedAt: Date(),
            answers: [:]
        )
        drafts.append(draft)
        saveDrafts()
        return draft
    }

    func answer(_ draftId: String, _ questionId: String) -> String {
        draft(id: draftId)?.answers[questionId] ?? ""
    }

    func setAnswer(_ text: String, draftId: String, questionId: String) {
        guard let index = drafts.firstIndex(where: { $0.id == draftId }) else { return }
        drafts[index].answers[questionId] = text
        // Saved a moment after typing stops, not on every key.
        draftSave?.cancel()
        draftSave = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            self?.saveDrafts()
        }
    }

    func discardDraft(_ draftId: String) {
        drafts.removeAll { $0.id == draftId }
        saveDrafts()
    }

    /// Hands the sitting in: marked here when the computer marks with an API key, else
    /// kept for the computer. Returns the sitting's id.
    @discardableResult
    func submit(_ draftId: String) -> String? {
        guard let draft = draft(id: draftId) else { return nil }
        let sitting = PhoneSitting(
            id: draft.id,
            lectureId: draft.lectureId,
            startedAt: draft.startedAt,
            submittedAt: Date(),
            responses: draft.questionIds.map { questionId in
                PhoneResponse(id: LockinID.make(prefix: "a"), questionId: questionId,
                              answerText: (draft.answers[questionId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
            }
        )
        drafts.removeAll { $0.id == draftId }
        outboxSittings.append(sitting)
        saveDrafts()
        saveOutbox()
        Task {
            await markOnPhone(sitting.id)
            await sync()
        }
        return sitting.id
    }

    private func markOnPhone(_ sittingId: String) async {
        guard let template = snapshot?.marking,
              let sitting = outboxSittings.first(where: { $0.id == sittingId }),
              let lecture = lecture(sitting.lectureId)
        else { return }
        let jobs: [(responseId: String, question: Question, answer: String)] = sitting.responses.compactMap { r in
            guard !r.answerText.isEmpty, r.marking == nil, let q = lecture.questions.first(where: { $0.id == r.questionId }) else { return nil }
            return (r.id, q, r.answerText)
        }
        guard !jobs.isEmpty else { return }
        marking.insert(sittingId)
        defer { marking.remove(sittingId) }
        let results = await withTaskGroup(of: (String, Result<Marking, Error>).self, returning: [(String, Result<Marking, Error>)].self) { group in
            for job in jobs {
                group.addTask {
                    do {
                        return (job.responseId, .success(try await markAnswer(job.answer, question: job.question, template: template)))
                    } catch {
                        return (job.responseId, .failure(error))
                    }
                }
            }
            var out: [(String, Result<Marking, Error>)] = []
            for await result in group { out.append(result) }
            return out
        }
        // The sitting may have been sent meanwhile: then the computer marks what's missing.
        guard let index = outboxSittings.firstIndex(where: { $0.id == sittingId }) else { return }
        for (responseId, result) in results {
            guard let r = outboxSittings[index].responses.firstIndex(where: { $0.id == responseId }) else { continue }
            switch result {
            case .success(let marking): outboxSittings[index].responses[r].marking = marking
            case .failure(let error):
                outboxSittings[index].responses[r].markingError =
                    "\(error.localizedDescription) Your computer will mark it after you sync."
            }
        }
        saveOutbox()
    }

    // MARK: - AK

    func review(_ card: Card, _ rating: Rating) {
        guard var snapshot, let index = snapshot.cards.firstIndex(where: { $0.id == card.id }) else { return }
        let (updated, review) = snapshot.cards[index].reviewed(rating)
        snapshot.cards[index] = updated
        self.snapshot = snapshot
        outboxReviews.append(review)
        saveOutbox()
        saveState()
    }

    // MARK: - Storage

    private var folder: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = support.appendingPathComponent("Lockin", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private struct Library: Codable {
        var snapshot: Snapshot?
        var lastSyncAt: Date?
    }

    private struct Outbox: Codable {
        var sittings: [PhoneSitting]
        var reviews: [CardReview]
    }

    private func load() {
        let decoder = LockinJSON.decoder()
        if let data = Keychain.get("pairing") { pairing = try? JSONDecoder().decode(Pairing.self, from: data) }
        if let data = try? Data(contentsOf: folder.appendingPathComponent("library.json")),
           let library = try? decoder.decode(Library.self, from: data) {
            snapshot = library.snapshot
            lastSyncAt = library.lastSyncAt
            // Kept apart because it can hold an API key.
            if let data = Keychain.get("marking") { snapshot?.marking = try? decoder.decode(MarkingTemplate.self, from: data) }
        }
        if let data = try? Data(contentsOf: folder.appendingPathComponent("outbox.json")),
           let outbox = try? decoder.decode(Outbox.self, from: data) {
            outboxSittings = outbox.sittings
            outboxReviews = outbox.reviews
        }
        if let data = try? Data(contentsOf: folder.appendingPathComponent("drafts.json")) {
            drafts = (try? decoder.decode([Draft].self, from: data)) ?? []
        }
    }

    private func write<T: Encodable>(_ value: T, to name: String) {
        let encoder = LockinJSON.encoder()
        encoder.userInfo[.lockinStorage] = true
        guard let data = try? encoder.encode(value) else { return }
        try? data.write(to: folder.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func savePairing() {
        guard let pairing, let data = try? JSONEncoder().encode(pairing) else { return }
        Keychain.set(data, for: "pairing")
    }

    private func saveState() {
        var stored = snapshot
        if let marking = stored?.marking, let data = try? LockinJSON.encoder().encode(marking) {
            Keychain.set(data, for: "marking")
        } else {
            Keychain.delete("marking")
        }
        stored?.marking = nil
        write(Library(snapshot: stored, lastSyncAt: lastSyncAt), to: "library.json")
    }

    private func saveOutbox() {
        write(Outbox(sittings: outboxSittings, reviews: outboxReviews), to: "outbox.json")
    }

    private func saveDrafts() {
        write(drafts, to: "drafts.json")
    }
}
