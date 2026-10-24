import LockinKit
import SwiftUI

/// The paired computer: syncing, what's waiting to be sent, and pairing again.
struct ComputerTab: View {
    @Environment(AppModel.self) private var model
    @State private var scanning = false
    @State private var confirmUnpair = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Computer", value: model.pairing?.computer ?? "—")
                    LabeledContent("Last synced") {
                        if let last = model.lastSyncAt {
                            Text(last, format: .relative(presentation: .named))
                        } else {
                            Text("Never")
                        }
                    }
                    if model.syncing {
                        HStack {
                            ProgressView()
                            Text(model.syncStatus ?? "Syncing…").foregroundStyle(.secondary)
                            if let pictures = model.pictures {
                                Spacer()
                                Text("\(pictures.done)/\(pictures.total)").monospacedDigit().foregroundStyle(.secondary)
                            }
                        }
                    } else {
                        Button {
                            Task { await model.sync() }
                        } label: {
                            Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
                        }
                    }
                    if let error = model.syncError {
                        Text(error).font(.callout).foregroundStyle(.red)
                    }
                } footer: {
                    Text("Syncs over your Wi-Fi when Lockin is open on the computer, every time you open this app. Encrypted with a key only the two of them have.")
                }

                Section("Waiting to send") {
                    LabeledContent("Sittings", value: "\(model.outboxSittings.count)")
                    LabeledContent("AK reviews", value: "\(model.outboxReviews.count)")
                }

                Section("Marking") {
                    Text(model.markingNote)
                }

                Section {
                    Button("Pair with another computer") { scanning = true }
                    Button("Unpair", role: .destructive) { confirmUnpair = true }
                    if let problem { Text(problem).font(.callout).foregroundStyle(.red) }
                }
            }
            .navigationTitle(model.pairing?.computer ?? "Computer")
            .refreshable { await model.sync() }
            .sheet(isPresented: $scanning) {
                ScannerSheet { code in
                    scanning = false
                    Task { problem = await model.pair(with: code) }
                }
            }
            .confirmationDialog("Unpair this phone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) { model.unpair() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(model.unsentCount > 0
                     ? "\(model.unsentCount) sitting\(model.unsentCount == 1 ? "" : "s") or review\(model.unsentCount == 1 ? "" : "s") haven't been sent yet and will be lost. Sync first to keep them."
                     : "Everything on this phone is deleted. Your library stays on the computer.")
            }
        }
    }
}
