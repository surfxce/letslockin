import Combine
import SwiftUI
import LockinCore

// Port of app/ui/ModelPicker.tsx: three models chosen for this computer — faster on the
// left, the recommendation in the middle, better on the right — and the alternatives
// behind "See alternatives". Downloading one links it up when it finishes: it becomes the
// model Lockin uses, with nothing else to set. Progress is read from the DOWNLOAD job's
// row, which the queue keeps updated.

struct ModelPickerSection: View {
    @Bindable var store: AppStore
    @State private var snapshot: AppStore.ModelsSnapshot?
    @State private var error: String?
    @State private var showingAlternatives = false
    @State private var wasBusy = false
    @State private var tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let snapshot {
                pickerBody(snapshot)
            } else {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Looking at what this computer has…")
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }
        }
        .task { refresh() }
        .onReceive(tick) { _ in
            // Follow a download while one runs, as the web picker polls /api/models.
            if snapshot?.busy == true || wasBusy {
                refresh(progressOnly: true)
            }
        }
    }

    private func refresh(progressOnly: Bool = false) {
        if progressOnly, let previous = snapshot {
            snapshot = store.refreshingModelDownloads(previous)
        } else {
            snapshot = store.modelsSnapshot()
        }
        if snapshot?.busy == false && wasBusy {
            // The last download finished: the registry changed, so every view catches up.
            store.refreshAfterModelChange()
        }
        wasBusy = snapshot?.busy ?? false
    }

    @ViewBuilder
    private func pickerBody(_ data: AppStore.ModelsSnapshot) -> some View {
        let specs = data.specs
        Label {
            Text("Your \(specs.kind): \(jsNumberString(jsMathRound(specs.ramGb))) GB memory · \(specs.cores) cores\(specs.appleSilicon ? " · Apple Silicon" : "")")
                .font(.callout)
                .foregroundStyle(.secondary)
        } icon: {
            Image(systemName: "cpu")
        }

        HStack(alignment: .top, spacing: 10) {
            ModelCardView(
                store: store,
                role: "Performance",
                icon: "bolt",
                model: data.picks.performance,
                data: data
            )
            ModelCardView(
                store: store,
                role: "Recommended for you",
                icon: "checkmark",
                model: data.picks.recommended,
                data: data
            )
            ModelCardView(
                store: store,
                role: "Quality",
                icon: "sparkles",
                model: data.picks.quality,
                data: data
            )
        }

        Button("See alternatives") {
            showingAlternatives = true
        }
        .buttonStyle(.link)
        .sheet(isPresented: $showingAlternatives) {
            AlternativesSheet(store: store, data: snapshot ?? data)
        }

        Text(data.picks.why)
            .font(.callout)
            .foregroundStyle(.secondary)
        if let caution = data.picks.caution {
            Label(caution, systemImage: "exclamationmark.triangle")
                .font(.callout)
                .foregroundStyle(.orange)
        }
        if data.busy && !data.workerAlive {
            Text("The background worker isn't running, so the download can't start. It runs with this app.")
                .font(.callout)
                .foregroundStyle(.orange)
        }
        if let error {
            Text(error)
                .font(.callout)
                .foregroundStyle(.red)
        }

        installedList(data)
    }

    @ViewBuilder
    private func installedList(_ data: AppStore.ModelsSnapshot) -> some View {
        if !data.installed.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(data.installed) { installed in
                    HStack {
                        Image(systemName: "doc.fill")
                            .foregroundStyle(.secondary)
                        Text(installed.name)
                            .font(.body.weight(.medium))
                        Text("· \(installed.gbOnDisk) on disk")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if installed.isMLX {
                            TagBadge(text: "MLX", tone: .purple)
                                .help("Runs on Apple's MLX, faster on this Mac")
                        }
                        if installed.visionReady {
                            TagBadge(text: "Sees slides", tone: .blue)
                                .help("It is shown each slide before writing the summary")
                        }
                        if data.active == installed.id, let reader = data.slideReader, reader != installed.id {
                            Text("· slides read by \(findModel(reader)?.name ?? reader)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if data.active == installed.id {
                            TagBadge(text: "In use", tone: .green)
                        } else {
                            Button("Use") {
                                act { store.useModel(installed.id) }
                            }
                        }
                        Button("Delete", role: .destructive) {
                            let alert = NSAlert()
                            alert.messageText = "Delete \(installed.name)?"
                            alert.informativeText = "You can download it again later."
                            alert.addButton(withTitle: "Delete")
                            alert.addButton(withTitle: "Cancel")
                            if alert.runModal() == .alertFirstButtonReturn {
                                act { store.deleteModel(installed.id) }
                            }
                        }
                        .buttonStyle(.link)
                    }
                    .padding(8)
                    .background(L.bgSoft)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }
        }
    }

    /// An action that may say why it could not: its line shows under the picker.
    private func act(_ body: () -> AppStore.ActionResult) {
        let result = body()
        error = result.ok ? nil : (result.message ?? "Something went wrong.")
        refresh()
    }
}

/// `SPEED` in ModelPicker.tsx.
private func speedLabel(_ speed: Int) -> String {
    switch speed {
    case 5: return "Fastest"
    case 4: return "Fast"
    case 3: return "Steady"
    case 2: return "Slower"
    default: return "Slowest"
    }
}

private struct ModelCardView: View {
    var store: AppStore
    let role: String
    let icon: String
    let model: LocalModel
    let data: AppStore.ModelsSnapshot

    @State private var error: String?

    var body: some View {
        let installed = data.installedInfo(forModel: model.id)
        let active = data.active == model.id
        let download = data.download(forModel: model.id)
        let running = download?.isActive ?? false
        let otherBusy = data.busy && !(download?.isActive ?? false)

        VStack(alignment: .leading, spacing: 6) {
            Label(role, systemImage: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(model.name)
                .font(.body.weight(.semibold))
            Text("\(model.maker) · \(model.params)")
                .font(.caption)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(speedLabel(model.speed))
                Text("~\(jsNumberString(model.downloadGb)) GB download")
                Text("needs ~\(jsNumberString(model.needsRamGb)) GB memory")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if !model.blurb.isEmpty {
                Text(model.blurb)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            actionArea(installed: installed, active: active, download: download, running: running, otherBusy: otherBusy)

            if let failed = download, failed.failed, installed == nil {
                Text(failed.error ?? "The download failed.")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(active ? L.accentSoft : L.bgSoft)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private func actionArea(
        installed: AppStore.InstalledModelInfo?,
        active: Bool,
        download: DownloadState?,
        running: Bool,
        otherBusy: Bool
    ) -> some View {
        if active {
            Label("Linked — Lockin uses this", systemImage: "checkmark.circle.fill")
                .font(.caption.weight(.medium))
                .foregroundStyle(.green)
        } else if installed != nil {
            Button("Use this model") {
                let result = store.useModel(model.id)
                error = result.ok ? nil : result.message
                store.refreshAfterModelChange()
            }
        } else if running, let download {
            VStack(alignment: .leading, spacing: 4) {
                ProgressView(value: download.total > 0 ? Double(download.percent) / 100 : 0)
                    .progressViewStyle(.linear)
                HStack {
                    Text(download.total == 0 ? "Connecting…" : "\(download.percent)% · \(download.progressText)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel") {
                        store.stopDownload(download.jobId)
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                }
            }
        } else {
            Button {
                let result = store.downloadModel(model.id)
                error = result.ok ? nil : result.message
                store.refreshAfterModelChange()
            } label: {
                Label("Download", systemImage: "arrow.down.circle")
            }
            .disabled(otherBusy)
            .help(otherBusy ? "One download at a time" : "")
        }
    }
}

// MARK: - Alternatives (Alternatives in ModelPicker.tsx)

private struct AlternativesSheet: View {
    @Bindable var store: AppStore
    @State var data: AppStore.ModelsSnapshot
    @Environment(\.dismiss) private var dismiss
    @State private var showAll = false
    @State private var eyeId: String = ""
    @State private var writerId: String = ""
    @State private var tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var everything: [LocalModel] {
        (localModels + moreModels).sorted { parameterCount($0) < parameterCount($1) }
    }
    private var eyes: [LocalModel] {
        (localModels + moreModels).filter { $0.vision && $0.mlx != nil }
            .sorted { parameterCount($0) < parameterCount($1) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(showAll ? "Every model" : "Alternatives")
                .font(.headline)

            if !showAll {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Other models that see slides, beside each of the three picked for this \(data.specs.kind).")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        ForEach(
                            [
                                ("Performance", data.picks.performance),
                                ("Balanced", data.picks.recommended),
                                ("Quality", data.picks.quality),
                            ],
                            id: \.0
                        ) { role, main in
                            let options = moreModels.filter { $0.vision && $0.like == main.id }
                            VStack(alignment: .leading, spacing: 6) {
                                Text("\(role) — like \(main.name)")
                                    .font(.callout.weight(.semibold))
                                if options.isEmpty {
                                    Text("None at this size yet.")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                                ForEach(options, id: \.id) { model in
                                    alternativeRow(model)
                                }
                            }
                        }

                        Divider()
                        Text("Eye + writer")
                            .font(.callout.weight(.semibold))
                        Text("A small model looks at each slide and notes what's on it; a bigger one writes the summary and LAQs from those notes. They take turns, so the memory needed is the larger of the two.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        ForEach(data.pairs, id: \.eye) { pair in
                            pairRow(pair)
                        }

                        Divider()
                        Text("Separate eye and writer")
                            .font(.callout.weight(.semibold))
                        Text("Pick your own: any model that sees slides as the eye, any model as the writer.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        HStack {
                            Picker("Eye", selection: $eyeId) {
                                ForEach(eyes, id: \.id) { model in
                                    Text(label(model)).tag(model.id)
                                }
                            }
                            Picker("Writer", selection: $writerId) {
                                ForEach(everything, id: \.id) { model in
                                    Text(label(model) + (model.vision ? "" : " · text only")).tag(model.id)
                                }
                            }
                            pairAction(eyeId: eyeId, writerId: writerId)
                        }
                    }
                    .padding(.horizontal, 4)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(everything, id: \.id) { model in
                            HStack {
                                Text(model.name)
                                Text(model.params)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                if !model.vision {
                                    Text("text only")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                                Spacer()
                                action(model)
                            }
                        }
                    }
                    .padding(.horizontal, 4)
                }
            }

            HStack {
                Button(showAll ? "Back to alternatives" : "Show all") {
                    showAll.toggle()
                }
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 560, height: 620)
        .onAppear {
            if eyeId.isEmpty {
                eyeId = data.slideReader
                    ?? (data.active.flatMap { id in eyes.first(where: { $0.id == id }) }?.id)
                    ?? eyes.first?.id
                    ?? ""
            }
            if writerId.isEmpty {
                writerId = data.active ?? data.picks.recommended.id
            }
        }
        .onReceive(tick) { _ in
            if data.busy {
                data = store.refreshingModelDownloads(data)
            }
        }
    }

    private func label(_ model: LocalModel) -> String {
        model.name.contains(model.params) ? model.name : "\(model.name) · \(model.params)"
    }

    private func act(_ body: () -> AppStore.ActionResult) {
        _ = body()
        data = store.modelsSnapshot()
    }

    /// The Download / Use / In use button for one model, or why there is none to press.
    @ViewBuilder
    private func action(_ model: LocalModel) -> some View {
        if let download = data.download(forModel: model.id), download.isActive {
            Text("Downloading \(download.percent)%")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else if data.active == model.id {
            TagBadge(text: "In use", tone: .green)
        } else if data.installedInfo(forModel: model.id) != nil {
            Button("Use") { act { store.useModel(model.id) } }
        } else {
            let tooBig = model.needsRamGb > data.specs.ramGb * 1.25
            let why = !data.mlx ? "Runs on MLX only, on an Apple Silicon Mac" : (tooBig ? "Needs ~\(jsNumberString(model.needsRamGb)) GB of memory" : nil)
            Button {
                act { store.downloadModel(model.id) }
            } label: {
                Label(tooBig ? "Too big" : (!data.mlx ? "MLX only" : "Download"), systemImage: "arrow.down.circle")
            }
            .disabled(data.busy || why != nil)
            .help(why ?? "Download ~\(jsNumberString(model.downloadGb)) GB")
        }
    }

    @ViewBuilder
    private func alternativeRow(_ model: LocalModel) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(model.name)
                .font(.body.weight(.medium))
            Text("\(model.maker) · \(model.params) · ~\(jsNumberString(model.downloadGb)) GB")
                .font(.caption)
                .foregroundStyle(.secondary)
            if !model.blurb.isEmpty {
                Text(model.blurb)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            action(model)
        }
        .padding(.vertical, 2)
    }

    /// For an eye and a writer: in use, downloading, ready to use, or what downloading
    /// the missing ones costs (`pairAction`).
    @ViewBuilder
    private func pairAction(eyeId: String, writerId: String) -> some View {
        if let eye = eyes.first(where: { $0.id == eyeId }),
           let writer = everything.first(where: { $0.id == writerId }) {
            let same = eyeId == writerId
            let looking = data.slideReader ?? data.active
            if data.active == writerId && looking == eyeId {
                TagBadge(text: "In use", tone: .green)
            } else if let running = data.downloads.first(where: { ($0.modelId == eyeId || $0.modelId == writerId) && $0.isActive }) {
                Text("Downloading \(running.name) \(running.percent)%")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
            let haveEye = same || (data.installedInfo(forModel: eyeId)?.isMLX ?? false)
            let haveWriter = data.installedInfo(forModel: writerId) != nil
            let gbToGet = (haveEye ? 0 : eye.downloadGb) + (haveWriter ? 0 : writer.downloadGb)
            let need = max(eye.needsRamGb, writer.needsRamGb)
            let tooBig = need > data.specs.ramGb * 1.25
            let why = !same && !data.mlx ? "The eye runs on MLX, on an Apple Silicon Mac" : (tooBig ? "Needs ~\(jsNumberString(need)) GB of memory" : nil)
            Button {
                act { store.choosePair(eyeId: eyeId, writerId: writerId) }
            } label: {
                if why != nil {
                    Text(tooBig ? "Too big" : "MLX only")
                } else if gbToGet > 0 {
                    Label("Download ~\(jsNumberString((gbToGet * 10).rounded() / 10)) GB", systemImage: "arrow.down.circle")
                } else {
                    Text("Use")
                }
            }
            .disabled(data.busy && gbToGet > 0 || why != nil)
            .help(why ?? (gbToGet > 0 ? "Download about \(jsNumberString((gbToGet * 10).rounded() / 10)) GB" : ""))
            }
        }
    }

    @ViewBuilder
    private func pairRow(_ pair: ModelPair) -> some View {
        let eye = eyes.first(where: { $0.id == pair.eye })
        let writer = everything.first(where: { $0.id == pair.writer })
        VStack(alignment: .leading, spacing: 2) {
            Text("\(eye?.name ?? pair.eye) + \(writer?.name ?? pair.writer)")
                .font(.body.weight(.medium))
            Text("eye \(eye?.params ?? "?") · writer \(writer?.params ?? "?") · needs ~\(jsNumberString(max(eye?.needsRamGb ?? 0, writer?.needsRamGb ?? 0))) GB")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(pair.blurb)
                .font(.caption)
                .foregroundStyle(.secondary)
            pairAction(eyeId: pair.eye, writerId: pair.writer)
        }
        .padding(.vertical, 2)
    }
}
