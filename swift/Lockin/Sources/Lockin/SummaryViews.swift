import AppKit
import Combine
import Dispatch
import Foundation
import LockinCore
import SwiftUI
import WebKit

private func heartbeatLabel(_ status: HeartbeatStatus?) -> String {
    guard let status else { return "AI worker offline" }
    if status.alive {
        return status.heartbeat.isSwift ? "Running in Lockin" : "Worker active"
    }
    return "AI worker offline"
}

// MARK: - Chunk 6: AI Queue Panel (port of app/ui/queue-panel.tsx)

struct QueuePanelButton: View {
    @Bindable var store: AppStore
    @State private var isPresented = false
    @State private var now = Date()

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var activity: QueueActivity? { store.queueActivity }
    private var running: ActivityJob? { activity?.running }
    private var queued: [ActivityJob] { activity?.queued ?? [] }
    private var recent: [ActivityJob] { activity?.recent ?? [] }

    private var totalActive: Int {
        (running != nil ? 1 : 0) + queued.count
    }

    private var recentFailed: Bool {
        totalActive == 0 && recent.first?.status == .failed
    }

    private var buttonLabel: String {
        if let r = running {
            let stage = r.stageLabel ?? jobKindTitle(r.kind)
            let extra = queued.isEmpty ? "" : " +\(queued.count)"
            return "\(stage)\(extra)"
        }
        if !queued.isEmpty {
            return "Queued (\(queued.count))"
        }
        return "AI"
    }

    public var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(running != nil ? Color.purple : ( !queued.isEmpty ? Color.blue : (recentFailed ? Color.red : Color.secondary.opacity(0.5))))
                    .frame(width: 7, height: 7)
                Text(buttonLabel)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.primary.opacity(0.06))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .popover(isPresented: $isPresented, arrowEdge: .bottom) {
            QueuePopoverContent(store: store, now: now, onSelectLecture: { id in
                store.selectedLectureId = id
                store.importingCourseId = nil
                isPresented = false
            })
        }
        .onReceive(timer) { tick in
            if running != nil || isPresented {
                now = tick
            }
        }
    }
}

private func jobKindTitle(_ kind: JobKind) -> String {
    switch kind {
    case .prepare: return "Prepare lecture"
    case .generate: return "Write LAQs"
    case .mark: return "Mark answer"
    case .download: return "Download model"
    case .sort: return "Sort folder"
    case .ask: return "Answer question"
    default: return kind.rawValue
    }
}

private struct QueuePopoverContent: View {
    @Bindable var store: AppStore
    let now: Date
    let onSelectLecture: (String) -> Void

    private var activity: QueueActivity? { store.queueActivity }
    private var running: ActivityJob? { activity?.running }
    private var queued: [ActivityJob] { activity?.queued ?? [] }
    private var recent: [ActivityJob] { activity?.recent ?? [] }

    private var workerLine: (text: String, ok: Bool) {
        if !store.settings.mode.usesAi {
            return ("Copy & paste mode — no AI runs here", true)
        }
        let label = heartbeatLabel(activity?.worker)
        if let w = activity?.worker, w.alive {
            return (label, true)
        }
        if !store.settings.mode.usesAi {
            return ("Copy & paste mode", true)
        }
        return (label, false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                Text("AI queue")
                    .font(.headline)
                Spacer()
                HStack(spacing: 5) {
                    Circle()
                        .fill(workerLine.ok ? Color.green : Color.orange)
                        .frame(width: 6, height: 6)
                    Text(workerLine.text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // Working on now
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Working on now")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)

                        if let r = running {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack(alignment: .firstTextBaseline) {
                                    if let lid = r.lectureId {
                                        Button {
                                            onSelectLecture(lid)
                                        } label: {
                                            Text("\(r.courseCode.map { "\($0) · " } ?? "")\(r.lectureTitle ?? "Lecture")")
                                                .font(.callout.weight(.semibold))
                                                .lineLimit(1)
                                        }
                                        .buttonStyle(.link)
                                    } else {
                                        Text(jobKindTitle(r.kind))
                                            .font(.callout.weight(.semibold))
                                    }
                                    Spacer()
                                    if let started = r.startedAt {
                                        let ms = max(0, Int(now.timeIntervalSince(started) * 1000))
                                        Text(duration(ms))
                                            .font(.caption.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                    }
                                    Button {
                                        store.cancelQueueJob(r.id)
                                    } label: {
                                        Image(systemName: "xmark")
                                            .font(.caption2.weight(.bold))
                                            .foregroundStyle(.secondary)
                                    }
                                    .buttonStyle(.plain)
                                    .help("Stop this job")
                                }

                                Text("\(jobKindTitle(r.kind))\(r.stageLabel.map { " — \($0)" } ?? "")\(r.attempts > 1 ? " · retry" : "")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)

                                if !r.steps.isEmpty {
                                    VStack(alignment: .leading, spacing: 4) {
                                        ForEach(Array(r.steps.enumerated()), id: \.offset) { _, step in
                                            let done = step.finishedAt != nil
                                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                                Text(done ? "✓" : "●")
                                                    .font(.caption2.monospaced())
                                                    .foregroundStyle(done ? .green : .purple)
                                                VStack(alignment: .leading, spacing: 1) {
                                                    Text(step.label)
                                                        .font(.caption)
                                                        .foregroundStyle(done ? .secondary : .primary)
                                                    if !done, let detail = step.detail, !detail.isEmpty {
                                                        Text(detail)
                                                            .font(.caption2)
                                                            .foregroundStyle(.secondary)
                                                    }
                                                }
                                                Spacer()
                                                if let start = step.startedDate {
                                                    let end = step.finishedDate ?? now
                                                    let ms = max(0, Int(end.timeIntervalSince(start) * 1000))
                                                    Text(duration(ms))
                                                        .font(.caption2.monospacedDigit())
                                                        .foregroundStyle(.tertiary)
                                                }
                                            }
                                        }
                                    }
                                    .padding(.top, 2)
                                }
                            }
                            .padding(10)
                            .background(Color.purple.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        } else {
                            Text("Nothing running.")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }

                    // In line
                    if !queued.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("In line · \(queued.count) \(queued.count == 1 ? "lecture" : "lectures")")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button("Clear") {
                                    store.clearPendingQueue()
                                }
                                .font(.caption)
                                .buttonStyle(.link)
                            }

                            ForEach(Array(queued.enumerated()), id: \.element.id) { idx, q in
                                HStack(spacing: 8) {
                                    Text("#\(idx + 1)")
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(.tertiary)
                                        .frame(width: 22, alignment: .leading)
                                    VStack(alignment: .leading, spacing: 1) {
                                        if let lid = q.lectureId {
                                            Button {
                                                onSelectLecture(lid)
                                            } label: {
                                                Text("\(q.courseCode.map { "\($0) · " } ?? "")\(q.lectureTitle ?? "Lecture")")
                                                    .font(.caption.weight(.medium))
                                                    .lineLimit(1)
                                            }
                                            .buttonStyle(.link)
                                        } else {
                                            Text(jobKindTitle(q.kind))
                                                .font(.caption.weight(.medium))
                                        }
                                        Text(jobKindTitle(q.kind))
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button {
                                        store.cancelQueueJob(q.id)
                                    } label: {
                                        Image(systemName: "xmark")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                    .buttonStyle(.plain)
                                    .help("Remove from queue")
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }

                    // Finished
                    if !recent.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Finished")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)

                            ForEach(recent) { j in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(j.status == .done ? "✓" : "!")
                                        .font(.caption.weight(.bold).monospaced())
                                        .foregroundStyle(j.status == .done ? .green : .red)
                                    VStack(alignment: .leading, spacing: 2) {
                                        if let lid = j.lectureId {
                                            Button {
                                                onSelectLecture(lid)
                                            } label: {
                                                Text("\(j.courseCode.map { "\($0) · " } ?? "")\(j.lectureTitle ?? "Lecture")")
                                                    .font(.caption.weight(.medium))
                                                    .lineLimit(1)
                                            }
                                            .buttonStyle(.link)
                                        } else {
                                            Text(jobKindTitle(j.kind))
                                                .font(.caption.weight(.medium))
                                        }
                                        Text("\(jobKindTitle(j.kind))\(j.durationMs.map { " · \(duration($0))" } ?? "")")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                        if j.status == .failed, let err = j.error {
                                            Text(err)
                                                .font(.caption2)
                                                .foregroundStyle(.red)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                    }
                                    Spacer()
                                    if j.status == .failed {
                                        Button("Retry") {
                                            store.retryQueueJob(j.id)
                                        }
                                        .font(.caption2)
                                        .buttonStyle(.bordered)
                                        .controlSize(.mini)
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }
                }
            }
            .frame(maxHeight: 360)

            Text("Lectures are prepared one at a time so your computer stays responsive. Marking jumps to the front.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(14)
        .frame(width: 360)
    }
}

// MARK: - Chunk 7: Custom WKURLSchemeHandler for lockin-slide://

// MARK: - Chunk 7: Slide Cropper Sheet (port of app/ui/slide-cropper.tsx)

struct SlideCropTarget: Identifiable, Equatable {
    let figure: Int
    let slide: Int
    let initialCrop: Crop?

    var id: String { "\(figure)-\(slide)" }
}

struct SlideCropperSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: AppStore
    let lectureId: String
    let target: SlideCropTarget

    @State private var nsImage: NSImage? = nil
    @State private var box: Crop
    @State private var dragStart: CGPoint? = nil
    @State private var errorText: String? = nil

    init(store: AppStore, lectureId: String, target: SlideCropTarget) {
        self.store = store
        self.lectureId = lectureId
        self.target = target
        _box = State(initialValue: target.initialCrop ?? Crop(x: 0.08, y: 0.12, w: 0.84, h: 0.76))
    }

    @State private var resizeStart: Crop?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Crop Slide \(target.slide)")
                        .font(.headline)
                    Text("Drag across the diagram to frame it, or drag inside the box to reposition.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }

            if let err = errorText {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            GeometryReader { geo in
                ZStack {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color.black.opacity(0.06))

                    if let img = nsImage {
                        let fitted = aspectFitRect(imageSize: img.size, in: geo.size)
                        ZStack(alignment: .topLeading) {
                            Image(nsImage: img)
                                .resizable()
                                .frame(width: fitted.width, height: fitted.height)

                            // Darkened backdrop outside crop
                            Path { path in
                                path.addRect(CGRect(origin: .zero, size: fitted.size))
                                path.addRect(CGRect(
                                    x: box.x * fitted.width,
                                    y: box.y * fitted.height,
                                    width: box.w * fitted.width,
                                    height: box.h * fitted.height
                                ))
                            }
                            .fill(Color.black.opacity(0.45), style: FillStyle(eoFill: true))

                            // Selection rectangle
                            Rectangle()
                                .strokeBorder(Color.white, lineWidth: 2)
                                .background(Color.white.opacity(0.04))
                                .frame(width: box.w * fitted.width, height: box.h * fitted.height)
                                .offset(x: box.x * fitted.width, y: box.y * fitted.height)
                            ForEach(0..<4, id: \.self) { corner in
                                Circle().fill(Color.white).overlay(Circle().stroke(Color.accentColor, lineWidth: 2))
                                    .frame(width: 14, height: 14)
                                    .offset(x: (box.x + (corner % 2 == 1 ? box.w : 0)) * fitted.width - 7,
                                            y: (box.y + (corner >= 2 ? box.h : 0)) * fitted.height - 7)
                                    .highPriorityGesture(DragGesture(minimumDistance: 0).onChanged { value in
                                        if resizeStart == nil { resizeStart = box }
                                        box = resizedSlideCrop(resizeStart ?? box, corner: corner,
                                                               dx: value.translation.width / fitted.width,
                                                               dy: value.translation.height / fitted.height)
                                    }.onEnded { _ in resizeStart = nil })
                                    .accessibilityLabel("Crop corner \(corner + 1)")
                            }

                        }
                        .frame(width: fitted.width, height: fitted.height)
                        .contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 2)
                                .onChanged { value in
                                    let startX = min(max(value.startLocation.x / fitted.width, 0), 1)
                                    let startY = min(max(value.startLocation.y / fitted.height, 0), 1)
                                    let curX = min(max(value.location.x / fitted.width, 0), 1)
                                    let curY = min(max(value.location.y / fitted.height, 0), 1)
                                    let x = min(startX, curX)
                                    let y = min(startY, curY)
                                    let w = max(0.05, abs(curX - startX))
                                    let h = max(0.05, abs(curY - startY))
                                    box = Crop(
                                        x: min(x, 1 - w),
                                        y: min(y, 1 - h),
                                        w: min(w, 1),
                                        h: min(h, 1)
                                    )
                                }
                        )
                    } else {
                        ProgressView("Loading slide \(target.slide)…")
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(height: 400)

            HStack {
                if target.initialCrop != nil {
                    Button("Show whole slide") {
                        save(crop: nil)
                    }
                }
                Spacer()
                Button("Cancel") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                Button("Save crop") {
                    save(crop: box)
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 680)
        .task {
            loadSlideImage()
        }
    }

    private func loadSlideImage() {
        guard let database = store.database else { return }
        let renderer = store.slideRenderer
        let lid = lectureId
        let slideNum = target.slide
        Task.detached {
            let data = try? slideImage(
                database: database,
                lectureId: lid,
                slide: slideNum,
                crop: nil,
                renderer: renderer
            )
            if let data, let img = NSImage(data: data) {
                await MainActor.run {
                    self.nsImage = img
                }
            } else {
                await MainActor.run {
                    self.errorText = "Could not load slide \(slideNum)."
                }
            }
        }
    }

    private func save(crop: Crop?) {
        let outcome = store.cropSlideFigure(
            lectureId: lectureId,
            figure: target.figure,
            slide: target.slide,
            crop: crop
        )
        if outcome.ok {
            dismiss()
        } else {
            errorText = outcome.message
        }
    }

    private func aspectFitRect(imageSize: CGSize, in container: CGSize) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0, container.width > 0, container.height > 0 else {
            return CGRect(origin: .zero, size: container)
        }
        let scale = min(container.width / imageSize.width, container.height / imageSize.height)
        let w = imageSize.width * scale
        let h = imageSize.height * scale
        return CGRect(x: (container.width - w) / 2, y: (container.height - h) / 2, width: w, height: h)
    }
}

// MARK: - Chunk 8: Left-Out Banner View (port of app/ui/left-out.tsx)

struct LeftOutBannerView: View {
    @Bindable var store: AppStore
    let detail: LectureDetailSnapshot

    @State private var isExpanded = false
    @State private var selectedPartIndex: Int? = nil
    @State private var pendingJobs: [String: String] = [:] // what -> jobId
    @State private var notFoundParts: Set<String> = []
    @State private var localAnswers: [String: String] = [:]
    @State private var errorMessages: [String: String] = [:]
    @State private var manualPasteText: String = ""
    @State private var copiedPrompt = false

    private var parts: [Skipped] { detail.skipped }
    private var canAsk: Bool { store.settings.mode.usesAi }

    var body: some View {
        if !parts.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) {
                            isExpanded.toggle()
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.secondary)
                            Text("Left out of summary · \(partsLabel(parts.count))")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)

                    if !isExpanded {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(Array(parts.enumerated()), id: \.offset) { idx, part in
                                    partChip(part: part, index: idx)
                                }
                            }
                        }
                    }
                    Spacer()
                }

                if isExpanded {
                    FlowLayoutChips(items: Array(parts.enumerated())) { idx, part in
                        partChip(part: part, index: idx)
                    }
                }
            }
            .padding(10)
            .background(Color.primary.opacity(0.035))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .onChange(of: detail.askJobs) { _, jobs in
                checkFinishedLeftOutJobs(jobs)
            }
        }
    }

    @ViewBuilder
    private func partChip(part: Skipped, index: Int) -> some View {
        let effectiveAbout = localAnswers[part.what] ?? part.about
        let busy = pendingJobs[part.what] != nil
        let ctx = LeftOutContext(canAsk: canAsk, busy: busy, notFound: notFoundParts.contains(part.what))
        let action = leftOutAction(about: effectiveAbout, added: part.added, ctx: ctx)

        Button {
            selectedPartIndex = index
            manualPasteText = ""
            copiedPrompt = false
        } label: {
            HStack(spacing: 4) {
                if busy {
                    ProgressView().controlSize(.mini)
                } else if part.added == true {
                    Text("✓").font(.caption2.weight(.bold)).foregroundStyle(.green)
                }
                Text(partLabel(part))
                    .font(.caption)
                    .lineLimit(1)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(part.added == true ? Color.green.opacity(0.12) : Color.primary.opacity(0.06))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(leftOutHint(action, ctx: ctx) ?? partLabel(part))
        .popover(
            isPresented: Binding(
                get: { selectedPartIndex == index },
                set: { if !$0 && selectedPartIndex == index { selectedPartIndex = nil } }
            ),
            arrowEdge: .bottom
        ) {
            leftOutCardPopover(part: part, effectiveAbout: effectiveAbout, action: action, ctx: ctx)
        }
    }

    @ViewBuilder
    private func leftOutCardPopover(
        part: Skipped,
        effectiveAbout: String?,
        action: LeftOutAction,
        ctx: LeftOutContext
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(part.what)
                    .font(.callout.weight(.semibold))
                Spacer()
                if !part.where.isEmpty {
                    Text(part.where)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let about = effectiveAbout, !about.isEmpty {
                ScrollView {
                    Text(about)
                        .font(.callout)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 200)
            } else if ctx.busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Checking the lecture for \(part.what)…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Not in the summary yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let err = errorMessages[part.what] {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if let hint = leftOutHint(action, ctx: ctx) {
                Text(hint)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            HStack {
                if let btnTitle = leftOutButton(action) {
                    Button(btnTitle) {
                        runLeftOutAction(part: part, action: action)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                }
                if !canAsk && (effectiveAbout == nil || effectiveAbout?.isEmpty == true) {
                    Button(copiedPrompt ? "✓ Copied prompt" : "Copy prompt") {
                        let sources = try? lectureSources(detail.materials)
                        if let p = try? renderAskPrompt(
                            .leftout(
                                AskLeftOut(
                                    lectureTitle: detail.lecture.title,
                                    what: part.what,
                                    where: part.where,
                                    transcript: sources?.transcript ?? "",
                                    slidesText: sources?.slidesText ?? ""
                                )
                            )
                        ) {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(p.text, forType: .string)
                            copiedPrompt = true
                        }
                    }
                    .controlSize(.small)
                }
            }

            if !canAsk && (effectiveAbout == nil || effectiveAbout?.isEmpty == true) {
                VStack(alignment: .leading, spacing: 6) {
                    TextField("Paste the AI's reply here…", text: $manualPasteText, axis: .vertical)
                        .lineLimit(3...6)
                        .textFieldStyle(.roundedBorder)
                    if !manualPasteText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Button("Save & add to summary") {
                            let clean = manualPasteText.trimmingCharacters(in: .whitespacesAndNewlines)
                            if let db = store.database {
                                try? saveLeftOut(database: db, lectureId: detail.lecture.id, what: part.what, about: clean)
                                _ = store.addLeftOutPart(lectureId: detail.lecture.id, what: part.what)
                                selectedPartIndex = nil
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    }
                }
            }
        }
        .padding(14)
        .frame(width: 340)
    }

    private func runLeftOutAction(part: Skipped, action: LeftOutAction) {
        errorMessages[part.what] = nil
        switch action {
        case .add:
            let outcome = store.addLeftOutPart(lectureId: detail.lecture.id, what: part.what)
            if !outcome.ok {
                errorMessages[part.what] = outcome.message
            } else {
                selectedPartIndex = nil
            }
        case .ask:
            let res = store.askAboutLecture(
                payload: AskPayload(
                    kind: .leftout,
                    lectureId: detail.lecture.id,
                    what: part.what,
                    where: part.where
                )
            )
            switch res {
            case .done(let askRes):
                localAnswers[part.what] = askRes.answer
                if askRes.found == false {
                    notFoundParts.insert(part.what)
                }
            case .job(let jid):
                pendingJobs[part.what] = jid
            case .error(let msg):
                errorMessages[part.what] = msg
            }
        default:
            break
        }
    }

    private func checkFinishedLeftOutJobs(_ jobs: [Job]) {
        for (what, jid) in pendingJobs {
            guard let job = jobs.first(where: { $0.id == jid }) else { continue }
            if job.status == .done {
                pendingJobs.removeValue(forKey: what)
                if let raw = job.result,
                   let val = try? JSONValue.parse(raw),
                   let res = AskResult.fromJSON(val) {
                    localAnswers[what] = res.answer
                    if res.found == false {
                        notFoundParts.insert(what)
                    }
                }
            } else if job.status == .failed {
                pendingJobs.removeValue(forKey: what)
                errorMessages[what] = job.error ?? "Could not check that part."
            }
        }
    }
}

private struct FlowLayoutChips<Item, Content: View>: View {
    let items: [(Int, Item)]
    let content: (Int, Item) -> Content

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items, id: \.0) { idx, item in
                    content(idx, item)
                }
            }
        }
    }
}

// MARK: - Chunks 8 & 9: Summary Tab (Reader, Selection Tools, Glossary, Editor, Ask Panel)

struct SummaryTabView: View {
    @Bindable var store: AppStore
    let detail: LectureDetailSnapshot

    @State private var isEditing = false
    @State private var cropTarget: SlideCropTarget? = nil
    @State private var selectedText: String = ""
    @State private var clickedTerm: GlossaryEntry? = nil
    @State private var showingAskPanel = false

    // Selection breakdown state
    @State private var showingBreakdownPopover = false
    @State private var breakdownAnswer: String = ""
    @State private var breakdownModel: String? = nil
    @State private var breakdownJobId: String? = nil
    @State private var breakdownError: String? = nil
    @State private var breakdownAdded = false
    @State private var breakdownUnderlined = false
    @State private var breakdownCopied = false

    var body: some View {
        let md = detail.lecture.summaryMd ?? ""
        ZStack(alignment: .bottomTrailing) {
            VStack(alignment: .leading, spacing: 12) {
                // Top bar: Left-out parts + Edit / Redo buttons
                HStack(alignment: .top, spacing: 12) {
                    LeftOutBannerView(store: store, detail: detail)
                    Spacer()
                    if !isEditing {
                        HStack(spacing: 8) {
                            Button {
                                showingAskPanel.toggle()
                            } label: {
                                Label("Ask", systemImage: "questionmark.circle")
                            }
                            .help("Ask a question about this lecture")

                            Button {
                                isEditing = true
                            } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                            .help("Edit this summary (or double-click any paragraph)")
                        }
                    }
                }

                // Floating selection bar when the student selects words in the summary
                if !isEditing && !selectedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    selectionToolbar(summaryMd: md)
                }

                // Clicked glossary underline popover bar
                if !isEditing, let term = clickedTerm {
                    glossaryTermBar(term: term)
                }

                if isEditing {
                    SummaryEditorContainerView(
                        store: store,
                        lectureId: detail.lecture.id,
                        summaryMd: md,
                        slidesInfo: detail.slidesInfo,
                        onDone: { isEditing = false }
                    )
                } else {
                    SummaryReaderWebView(
                        store: store,
                        lectureId: detail.lecture.id,
                        markdown: md,
                        slidesInfo: detail.slidesInfo,
                        glossaryTerms: detail.glossaryTerms,
                        onSelectionChanged: { sel in
                            selectedText = sel
                        },
                        onTermClicked: { entry in
                            clickedTerm = entry
                        },
                        onCropSlide: { fig, slide, crop in
                            cropTarget = SlideCropTarget(figure: fig, slide: slide, initialCrop: crop)
                        },
                        onDoubleClickEdit: {
                            isEditing = true
                        }
                    )
                    .frame(minHeight: 540)
                }
            }

            if !isEditing && showingAskPanel {
                AskFloatingPanelView(
                    store: store,
                    detail: detail,
                    onClose: { showingAskPanel = false }
                )
                .padding(12)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .sheet(item: $cropTarget) { target in
            SlideCropperSheet(store: store, lectureId: detail.lecture.id, target: target)
        }
        .onChange(of: detail.askJobs) { _, jobs in
            if let jid = breakdownJobId,
               let job = jobs.first(where: { $0.id == jid }) {
                if job.status == .done {
                    breakdownJobId = nil
                    if let raw = job.result,
                       let val = try? JSONValue.parse(raw),
                       let res = AskResult.fromJSON(val) {
                        breakdownAnswer = res.answer
                        breakdownModel = res.model ?? job.model
                    }
                } else if job.status == .failed {
                    breakdownJobId = nil
                    breakdownError = job.error ?? "Could not break that down."
                }
            }
        }
    }

    @ViewBuilder
    private func selectionToolbar(summaryMd: String) -> some View {
        let cleanSel = oneLine(selectedText)
        let termCandidate = cleanTerm(selectedText)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text("“\(shorten(cleanSel, max: 70))”")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                Spacer()

                if store.settings.mode.usesAi {
                    Button {
                        startBreakdown()
                    } label: {
                        Label("Break this down", systemImage: "sparkles")
                            .font(.caption.weight(.medium))
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(breakdownJobId != nil)
                } else {
                    Button(breakdownCopied ? "✓ Copied prompt" : "Copy break-down prompt") {
                        if let p = try? renderAskPrompt(
                            .breakdown(
                                AskBreakdown(
                                    lectureTitle: detail.lecture.title,
                                    summary: summaryMd,
                                    selection: selectedText.utf16Slice(0, selectionLimit)
                                )
                            )
                        ) {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(p.text, forType: .string)
                            breakdownCopied = true
                            showingBreakdownPopover = true
                        }
                    }
                    .controlSize(.small)
                }

                Button {
                    selectedText = ""
                    showingBreakdownPopover = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption2)
                }
                .buttonStyle(.plain)
            }

            if showingBreakdownPopover {
                Divider()
                if breakdownJobId != nil {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Breaking this down in plain steps…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else if let err = breakdownError {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                } else if !breakdownAnswer.isEmpty || !store.settings.mode.usesAi {
                    if !store.settings.mode.usesAi {
                        TextField("Paste the AI's explanation here…", text: $breakdownAnswer, axis: .vertical)
                            .lineLimit(3...6)
                            .textFieldStyle(.roundedBorder)
                    } else {
                        Text(breakdownAnswer)
                            .font(.callout)
                            .textSelection(.enabled)
                    }

                    if !breakdownAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        HStack(spacing: 8) {
                            Button(breakdownAdded ? "✓ Added under this line" : "Add under this line in summary") {
                                let outcome = store.addBlockToSummary(
                                    lectureId: detail.lecture.id,
                                    markdown: breakdownAnswer,
                                    place: .under(selectedText)
                                )
                                if outcome.ok {
                                    breakdownAdded = true
                                } else {
                                    breakdownError = outcome.message
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(breakdownAdded)

                            if !termCandidate.isEmpty && termCandidate.count <= 80 {
                                Button(breakdownUnderlined ? "✓ Underlined in summary" : "Keep as definition for “\(shorten(termCandidate, max: 32))”") {
                                    let res = store.saveGlossaryTerm(
                                        lectureId: detail.lecture.id,
                                        term: termCandidate,
                                        explanation: breakdownAnswer
                                    )
                                    switch res {
                                    case .success:
                                        breakdownUnderlined = true
                                    case .failure(let err):
                                        breakdownError = err.message
                                    }
                                }
                                .controlSize(.small)
                                .disabled(breakdownUnderlined)
                            }

                            if let model = breakdownModel {
                                Spacer()
                                Text(model)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
        }
        .padding(10)
        .background(Color.accentColor.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private func glossaryTermBar(term: GlossaryEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(term.term)
                    .font(.callout.weight(.semibold))
                Spacer()
                Button("Remove underline") {
                    store.deleteGlossaryTerm(id: term.id)
                    clickedTerm = nil
                }
                .font(.caption)
                .buttonStyle(.link)

                Button {
                    clickedTerm = nil
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption2)
                }
                .buttonStyle(.plain)
            }
            Text(term.explanation)
                .font(.callout)
                .textSelection(.enabled)
        }
        .padding(12)
        .background(Color.yellow.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func startBreakdown() {
        showingBreakdownPopover = true
        breakdownError = nil
        breakdownAnswer = ""
        breakdownAdded = false
        breakdownUnderlined = false
        let res = store.askAboutLecture(
            payload: AskPayload(
                kind: .breakdown,
                lectureId: detail.lecture.id,
                selection: selectedText.utf16Slice(0, selectionLimit)
            )
        )
        switch res {
        case .job(let jid):
            breakdownJobId = jid
        case .done(let out):
            breakdownAnswer = out.answer
            breakdownModel = out.model
        case .error(let msg):
            breakdownError = msg
        }
    }
}

// MARK: - Chunk 8: Ask Floating Panel View (port of app/ui/ask-panel.tsx)

struct AskFloatingPanelView: View {
    @Bindable var store: AppStore
    let detail: LectureDetailSnapshot
    let onClose: () -> Void

    @State private var question: String = ""
    @State private var currentQuestion: String = ""
    @State private var currentAnswer: String = ""
    @State private var suggestedSection: String? = nil
    @State private var pickedSection: String? = nil
    @State private var currentModel: String? = nil
    @State private var activeJobId: String? = nil
    @State private var errorText: String? = nil
    @State private var addedToSummary = false
    @State private var copiedPrompt = false
    @State private var sessionHistory: [AskHistoryItem] = []

    private var headings: [String] {
        summaryHeadings(detail.lecture.summaryMd ?? "")
    }

    private var targetSection: String {
        chosenSection(headings, suggested: suggestedSection, picked: pickedSection)
    }

    private var mergedHistory: [AskHistoryItem] {
        let showing = (!currentQuestion.isEmpty && !currentAnswer.isEmpty)
            ? (question: currentQuestion, answer: currentAnswer)
            : nil
        return mergeHistory([sessionHistory, detail.askHistory], showing: showing)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Ask about this lecture", systemImage: "questionmark.bubble.fill")
                    .font(.headline)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Ask anything about \(detail.lecture.title)…", text: $question, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: question) { _, newValue in
                        UserDefaults.standard.set(newValue, forKey: askDraftKey(detail.lecture.id))
                    }

                if store.settings.mode.usesAi {
                    Button("Ask") {
                        submitQuestion()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || activeJobId != nil)
                } else {
                    Button(copiedPrompt ? "✓ Copied" : "Copy prompt") {
                        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !q.isEmpty else { return }
                        if let p = try? renderAskPrompt(
                            .question(
                                AskQuestion(
                                    lectureTitle: detail.lecture.title,
                                    summary: detail.lecture.summaryMd ?? "",
                                    question: q,
                                    headings: headings
                                )
                            )
                        ) {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(p.text, forType: .string)
                            currentQuestion = q
                            copiedPrompt = true
                        }
                    }
                    .disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }

            if !store.settings.mode.usesAi && !currentQuestion.isEmpty {
                TextField("Paste the AI's answer here…", text: $currentAnswer, axis: .vertical)
                    .lineLimit(3...6)
                    .textFieldStyle(.roundedBorder)
            }

            if activeJobId != nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Thinking about “\(shorten(currentQuestion, max: 50))”…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let err = errorText {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if !currentAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    if !currentQuestion.isEmpty {
                        Text(currentQuestion)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    ScrollView {
                        Text(currentAnswer)
                            .font(.callout)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 180)

                    HStack(spacing: 8) {
                        Picker("File under", selection: Binding(
                            get: { targetSection },
                            set: { pickedSection = $0 }
                        )) {
                            ForEach(headings, id: \.self) { h in
                                Text(h).tag(h)
                            }
                            Text("End of summary").tag(endOfSummary)
                        }
                        .controlSize(.small)
                        .frame(maxWidth: 220)

                        Button(addedToSummary ? "✓ Added" : "Add to summary") {
                            let block = formatAnswer(currentQuestion, currentAnswer)
                            let place: SummaryPlacement = targetSection.isEmpty ? .section(nil) : .section(targetSection)
                            let outcome = store.addBlockToSummary(
                                lectureId: detail.lecture.id,
                                markdown: block,
                                place: place
                            )
                            if outcome.ok {
                                addedToSummary = true
                            } else {
                                errorText = outcome.message
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(addedToSummary)
                    }
                }
                .padding(10)
                .background(Color.primary.opacity(0.04))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            if !mergedHistory.isEmpty {
                Divider()
                Text("Earlier questions (\(mergedHistory.count))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(mergedHistory) { item in
                            Button {
                                currentQuestion = item.question
                                currentAnswer = item.answer
                                suggestedSection = item.section
                                pickedSection = nil
                                currentModel = item.model
                                addedToSummary = false
                                errorText = nil
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.question)
                                        .font(.caption.weight(.semibold))
                                        .lineLimit(1)
                                    Text(oneLine(item.answer))
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(6)
                                .background(Color.primary.opacity(0.035))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: 140)
            }
        }
        .padding(16)
        .frame(width: 420)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.18), radius: 12, x: 0, y: 4)
        .onAppear {
            question = UserDefaults.standard.string(forKey: askDraftKey(detail.lecture.id)) ?? ""
        }
        .onChange(of: detail.askJobs) { _, jobs in
            guard let jid = activeJobId,
                  let job = jobs.first(where: { $0.id == jid }) else { return }
            if job.status == .done {
                activeJobId = nil
                if let raw = job.result,
                   let val = try? JSONValue.parse(raw),
                   let res = AskResult.fromJSON(val) {
                    currentAnswer = res.answer
                    suggestedSection = res.section
                    pickedSection = nil
                    currentModel = res.model ?? job.model
                    addedToSummary = false
                    sessionHistory.insert(
                        AskHistoryItem(
                            id: job.id,
                            question: currentQuestion,
                            answer: res.answer,
                            section: res.section,
                            at: jsISOString(job.finishedAt ?? Date()),
                            model: currentModel
                        ),
                        at: 0
                    )
                }
            } else if job.status == .failed {
                activeJobId = nil
                errorText = job.error ?? "Could not answer that question."
            }
        }
    }

    private func submitQuestion() {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        errorText = nil
        currentQuestion = q
        currentAnswer = ""
        addedToSummary = false
        let outcome = store.askAboutLecture(
            payload: AskPayload(kind: .question, lectureId: detail.lecture.id, question: q)
        )
        switch outcome {
        case .job(let jid):
            activeJobId = jid
            question = ""
            UserDefaults.standard.removeObject(forKey: askDraftKey(detail.lecture.id))
        case .done(let res):
            currentAnswer = res.answer
            suggestedSection = res.section
            question = ""
            UserDefaults.standard.removeObject(forKey: askDraftKey(detail.lecture.id))
        case .error(let msg):
            errorText = msg
        }
    }
}

// MARK: - Chunk 8: Summary Reader WKWebView

struct SummaryReaderWebView: NSViewRepresentable {
    let store: AppStore
    let lectureId: String
    let markdown: String
    let slidesInfo: SlidesInfo
    let glossaryTerms: [GlossaryEntry]
    let onSelectionChanged: (String) -> Void
    let onTermClicked: (GlossaryEntry) -> Void
    let onCropSlide: (Int, Int, Crop?) -> Void
    let onDoubleClickEdit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let schemeHandler = SlideURLSchemeHandler(database: store.database, renderer: store.slideRenderer)
        config.setURLSchemeHandler(schemeHandler, forURLScheme: SlideURLSchemeHandler.scheme)

        let userContent = WKUserContentController()
        userContent.add(context.coordinator, name: "lockinReader")
        config.userContentController = userContent

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        context.coordinator.webView = webView
        context.coordinator.loadIfNeeded(
            lectureId: lectureId,
            markdown: markdown,
            slidesInfo: slidesInfo,
            glossaryTerms: glossaryTerms
        )
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.loadIfNeeded(
            lectureId: lectureId,
            markdown: markdown,
            slidesInfo: slidesInfo,
            glossaryTerms: glossaryTerms
        )
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        var parent: SummaryReaderWebView
        weak var webView: WKWebView?
        private var lastRenderedKey: String = ""

        init(parent: SummaryReaderWebView) {
            self.parent = parent
        }

        func loadIfNeeded(
            lectureId: String,
            markdown: String,
            slidesInfo: SlidesInfo,
            glossaryTerms: [GlossaryEntry]
        ) {
            let termsJSON = encodeGlossaryJSON(glossaryTerms)
            let key = "\(lectureId)|\(markdown)|\(slidesInfo.total)|\(termsJSON)"
            guard key != lastRenderedKey, let webView else { return }
            lastRenderedKey = key

            let ranges = slidesInfo.decks.filter { $0.isPictured }.map { ($0.first, $0.last) }
            let slides = SlideImages(
                base: "\(SlideURLSchemeHandler.scheme)://lectures/\(lectureId)/slides",
                ranges: ranges,
                croppable: true
            )
            let bodyHTML = renderMarkdown(markdown, slides: slides)
            let savedScroll = UserDefaults.standard.double(forKey: "lockin.readAt.\(lectureId)")
            let fullHTML = buildReaderDocumentHTML(
                bodyHTML: bodyHTML,
                termsJSON: termsJSON,
                savedScroll: savedScroll
            )
            webView.loadHTMLString(fullHTML, baseURL: URL(string: "\(SlideURLSchemeHandler.scheme)://lectures/\(lectureId)/"))
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let dict = message.body as? [String: Any],
                  let type = dict["type"] as? String else { return }
            switch type {
            case "selection":
                let text = dict["text"] as? String ?? ""
                parent.onSelectionChanged(text)
            case "term":
                if let id = dict["id"] as? String,
                   let entry = parent.glossaryTerms.first(where: { $0.id == id }) {
                    parent.onTermClicked(entry)
                }
            case "crop":
                if let fig = dict["figure"] as? Int,
                   let slide = dict["slide"] as? Int {
                    let cropRaw = dict["crop"] as? String
                    let parsed = cropRaw.flatMap { parseCrop($0) }
                    parent.onCropSlide(fig, slide, parsed)
                }
            case "scroll":
                if let y = dict["y"] as? Double {
                    UserDefaults.standard.set(y, forKey: "lockin.readAt.\(parent.lectureId)")
                }
            case "dblclickEdit":
                parent.onDoubleClickEdit()
            default:
                break
            }
        }
    }
}

private func encodeGlossaryJSON(_ entries: [GlossaryEntry]) -> String {
    guard let data = try? JSONEncoder().encode(entries),
          let str = String(data: data, encoding: .utf8) else {
        return "[]"
    }
    return str
}

// MARK: - Chunk 9: Summary Editor (Formatted + Markdown modes, Drafts, Conflict Resolution)

enum SummaryEditorMode: String, CaseIterable {
    case formatted = "Formatted"
    case markdown = "Markdown"
}

struct SummaryEditorContainerView: View {
    @Bindable var store: AppStore
    let lectureId: String
    let summaryMd: String
    let slidesInfo: SlidesInfo
    let onDone: () -> Void

    @State private var mode: SummaryEditorMode = .formatted
    @State private var draftMarkdown: String = ""
    @State private var baseMarkdown: String = ""
    @State private var restoredDraftAt: Double? = nil
    @State private var errorText: String? = nil
    @State private var hasConflict = false
    @State private var activeLineKind: LineKind? = .text
    @State private var editorWebView: WKWebView?
    @State private var rawSelection = NSRange(location: 0, length: 0)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Toolbar
            HStack(spacing: 8) {
                Picker("", selection: $mode) {
                    ForEach(SummaryEditorMode.allCases, id: \.self) { m in
                        Text(m.rawValue).tag(m)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 190)

                Divider().frame(height: 18)

                // Line Kind & Dot-point level buttons
                Group {
                    toolbarKindButton("Text", kind: .text)
                    toolbarKindButton("Heading", kind: .h2)
                    toolbarKindButton("Subheading", kind: .h3)
                    toolbarKindButton("• Point", kind: .bullet1)
                    toolbarKindButton("◦ Sub-point", kind: .bullet2)
                    toolbarKindButton("▪ Sub-sub-point", kind: .bullet3)
                }

                Spacer()
                Text(sameSummary(draftMarkdown, summaryMd) ? "Saved" : "Unsaved changes")
                    .font(.caption).foregroundStyle(.secondary)

                Button("Cancel") {
                    clearSavedDraft()
                    onDone()
                }
                .keyboardShortcut(.cancelAction)

                Button("Save") {
                    save(force: false)
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut("s", modifiers: [.command])
            }

            if let at = restoredDraftAt {
                HStack {
                    Text("Restored your unsaved edits from \(relativeTime(at)).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Discard draft") {
                        draftMarkdown = summaryMd
                        baseMarkdown = summaryMd
                        restoredDraftAt = nil
                        clearSavedDraft()
                    }
                    .font(.caption)
                    .buttonStyle(.link)
                    Spacer()
                }
                .padding(8)
                .background(Color.yellow.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }

            if hasConflict {
                VStack(alignment: .leading, spacing: 6) {
                    Text(errorText ?? "The summary changed since you started editing.")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.orange)
                    HStack(spacing: 8) {
                        Button("Overwrite with my edits") {
                            save(force: true)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)

                        Button("Use the newer summary") {
                            draftMarkdown = summaryMd
                            baseMarkdown = summaryMd
                            hasConflict = false
                            errorText = nil
                            clearSavedDraft()
                        }
                        .controlSize(.small)
                    }
                }
                .padding(10)
                .background(Color.orange.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            } else if let err = errorText {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if mode == .markdown {
                MarkdownSourceEditor(text: $draftMarkdown, selection: $rawSelection)
                    .font(.system(size: 14, design: .monospaced))
                    .frame(minHeight: 480)
                    .padding(6)
                    .background(Color.primary.opacity(0.03))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .onChange(of: draftMarkdown) { _, newValue in
                        persistDraft(newValue)
                    }
            } else {
                FormattedSummaryEditorWebView(
                    store: store,
                    lectureId: lectureId,
                    markdown: $draftMarkdown,
                    slidesInfo: slidesInfo,
                    onReady: { editorWebView = $0 },
                    onPersistDraft: { persistDraft($0) },
                    onSaveShortcut: { save(force: false) },
                    onCancelShortcut: {
                        clearSavedDraft()
                        onDone()
                    }
                )
                .frame(minHeight: 480)
                .background(Color.primary.opacity(0.02))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .onAppear {
            loadInitialDraft()
        }
    }

    @ViewBuilder
    private func toolbarKindButton(_ title: String, kind: LineKind) -> some View {
        Button(title) {
            if mode == .formatted {
                editorWebView?.evaluateJavaScript("window.setLineKind(\(JSONValue.string(kind.rawValue).stringified()))")
                return
            }
            let edited = setLineKind(draftMarkdown, rawSelection.location, NSMaxRange(rawSelection), kind)
            draftMarkdown = edited.text
            activeLineKind = kind
            persistDraft(edited.text)
        }
        .controlSize(.small)
        .buttonStyle(.bordered)
    }

    private func loadInitialDraft() {
        let key = summaryDraftKey(lectureId)
        if let raw = UserDefaults.standard.data(forKey: key),
           let saved = try? JSONDecoder().decode(SummaryDraft.self, from: raw),
           !sameSummary(saved.markdown, summaryMd) {
            draftMarkdown = saved.markdown
            baseMarkdown = saved.base
            restoredDraftAt = saved.at
        } else {
            draftMarkdown = summaryMd
            baseMarkdown = summaryMd
            restoredDraftAt = nil
        }
    }

    private func persistDraft(_ md: String) {
        let key = summaryDraftKey(lectureId)
        if sameSummary(md, summaryMd) {
            UserDefaults.standard.removeObject(forKey: key)
            return
        }
        let draft = SummaryDraft(
            markdown: md,
            base: baseMarkdown,
            at: Date().timeIntervalSince1970 * 1000
        )
        if let data = try? JSONEncoder().encode(draft) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    private func clearSavedDraft() {
        UserDefaults.standard.removeObject(forKey: summaryDraftKey(lectureId))
    }

    private func save(force: Bool) {
        errorText = nil
        hasConflict = false
        let outcome = store.saveSummary(
            lectureId: lectureId,
            markdown: draftMarkdown,
            base: baseMarkdown,
            force: force
        )
        if outcome.ok {
            clearSavedDraft()
            onDone()
        } else {
            errorText = outcome.message
            hasConflict = outcome.conflict
        }
    }
}

// MARK: - Chunk 9: Formatted Contenteditable WKWebView Editor

struct FormattedSummaryEditorWebView: NSViewRepresentable {
    let store: AppStore
    let lectureId: String
    @Binding var markdown: String
    let slidesInfo: SlidesInfo
    let onReady: (WKWebView) -> Void
    let onPersistDraft: (String) -> Void
    let onSaveShortcut: () -> Void
    let onCancelShortcut: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let schemeHandler = SlideURLSchemeHandler(database: store.database, renderer: store.slideRenderer)
        config.setURLSchemeHandler(schemeHandler, forURLScheme: SlideURLSchemeHandler.scheme)

        let userContent = WKUserContentController()
        userContent.add(context.coordinator, name: "lockinEditor")
        config.userContentController = userContent

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        context.coordinator.webView = webView
        DispatchQueue.main.async { onReady(webView) }
        context.coordinator.loadInitialHTML(
            lectureId: lectureId,
            markdown: markdown,
            slidesInfo: slidesInfo
        )
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.lastSyncedMarkdown != markdown {
            context.coordinator.loadInitialHTML(
                lectureId: lectureId,
                markdown: markdown,
                slidesInfo: slidesInfo
            )
        }
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        var parent: FormattedSummaryEditorWebView
        weak var webView: WKWebView?
        var lastSyncedMarkdown: String = ""

        init(parent: FormattedSummaryEditorWebView) {
            self.parent = parent
        }

        func loadInitialHTML(lectureId: String, markdown: String, slidesInfo: SlidesInfo) {
            guard let webView else { return }
            lastSyncedMarkdown = markdown
            let ranges = slidesInfo.decks.filter { $0.isPictured }.map { ($0.first, $0.last) }
            let slides = SlideImages(
                base: "\(SlideURLSchemeHandler.scheme)://lectures/\(lectureId)/slides",
                ranges: ranges,
                croppable: false
            )
            let bodyHTML = renderMarkdown(markdown, slides: slides, preserveSlideSource: true)
            let html = buildEditorDocumentHTML(bodyHTML: bodyHTML)
            webView.loadHTMLString(html, baseURL: URL(string: "\(SlideURLSchemeHandler.scheme)://lectures/\(lectureId)/"))
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let dict = message.body as? [String: Any],
                  let type = dict["type"] as? String else { return }
            switch type {
            case "change":
                if let md = dict["markdown"] as? String {
                    lastSyncedMarkdown = md
                    parent.markdown = md
                    parent.onPersistDraft(md)
                }
            case "save":
                parent.onSaveShortcut()
            case "cancel":
                parent.onCancelShortcut()
            default:
                break
            }
        }
    }
}
