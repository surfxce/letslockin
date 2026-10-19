import SwiftUI
import Sparkle
import LockinCore

// Chunk 13: updates through Sparkle. The updater starts with the app, so automatic
// checks run in the background; the Settings section shows the version, the switch and
// a check-now button. Updates are signed with the project's own EdDSA key (no Apple
// developer account needed): the appcast and its signatures are made by the swift-dmg
// workflow, and the public key sits in the Info.plist (project.yml).

@MainActor
final class LockinUpdater: ObservableObject {
    static let shared = LockinUpdater()

    let updater: SPUUpdater
    private var started = false

    private init() {
        let driver = SPUStandardUserDriver(hostBundle: Bundle.main, delegate: nil)
        updater = SPUUpdater(hostBundle: Bundle.main, applicationBundle: Bundle.main, userDriver: driver, delegate: nil)
    }

    /// Starts the background checks. Called once, when the app launches.
    func start() {
        guard !started else { return }
        started = true
        do {
            try updater.start()
        } catch {
            // Without the updater, "Check for updates" says so rather than doing nothing.
            NSLog("Sparkle failed to start: \(messageOf(error))")
        }
    }
}

/// The Settings window's Updates section (AppUpdate.tsx, on Sparkle's rails).
struct UpdatesSection: View {
    @Bindable var store: AppStore
    @ObservedObject private var holder = LockinUpdater.shared
    @State private var automatic: Bool = true

    private var versionLine: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0.1.0"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "Lockin \(version) (build \(build))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(versionLine)
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack {
                Button("Check for updates") {
                    holder.updater.checkForUpdates()
                }
                Toggle(isOn: Binding(
                    get: { automatic },
                    set: { on in
                        automatic = on
                        holder.updater.automaticallyChecksForUpdates = on
                    }
                )) {
                    Text("Check automatically")
                }
                .toggleStyle(.switch)
            }
            Text("Updates are checked against the latest build published on GitHub, and download in the background. Installing restarts Lockin.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
        .onAppear {
            automatic = holder.updater.automaticallyChecksForUpdates
        }
    }
}
