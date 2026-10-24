import LockinKit
import SwiftUI
import VisionKit

/// Before pairing: what the app is, and how to connect it to the computer.
struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    @State private var scanning = false
    @State private var pasted = ""
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.system(size: 54, weight: .light))
                        .foregroundStyle(.tint)
                        .padding(.top, 24)
                    Text("Lockin, on the go")
                        .font(.largeTitle.bold())
                    Text("Read your summaries with their slides, answer LAQs and review AK cards anywhere. Your phone syncs straight with Lockin on your computer over Wi-Fi — no account and no cloud.")
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 10) {
                        step(1, "On your computer, open Lockin → Settings → iPhone, and choose **Pair an iPhone**.")
                        step(2, "Scan the code it shows. Keep both on the same Wi-Fi.")
                    }
                    Button {
                        scanning = true
                    } label: {
                        Label("Scan the pairing code", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(working)

                    DisclosureGroup("Or paste the pairing link") {
                        VStack(alignment: .leading) {
                            TextField("lockin://pair?d=…", text: $pasted, axis: .vertical)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .font(.callout.monospaced())
                            Button("Pair") { pair(pasted) }
                                .disabled(pasted.isEmpty || working)
                        }
                        .padding(.top, 6)
                    }
                    if working { ProgressView("Connecting…") }
                    if let problem {
                        Text(problem).foregroundStyle(.red).font(.callout)
                    }
                }
                .padding(24)
            }
            .sheet(isPresented: $scanning) {
                ScannerSheet { code in
                    scanning = false
                    pair(code)
                }
            }
        }
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(n)").font(.callout.bold()).frame(width: 22, height: 22).background(Circle().fill(.tint.opacity(0.15)))
            Text(text)
        }
    }

    private func pair(_ code: String) {
        working = true
        problem = nil
        Task {
            problem = await model.pair(with: code)
            working = false
        }
    }
}

/// The camera, reading QR codes, with a way out when it isn't available.
struct ScannerSheet: View {
    let found: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if DataScannerViewController.isSupported {
                    QRScanner(found: found)
                        .ignoresSafeArea(edges: .bottom)
                        .overlay(alignment: .bottom) {
                            Text("Point at the code in Lockin's Settings on your computer.")
                                .font(.callout)
                                .padding(12)
                                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                                .padding(.bottom, 40)
                        }
                } else {
                    ContentUnavailableView(
                        "This iPhone can't scan here",
                        systemImage: "camera",
                        description: Text("Point the Camera app at the code instead, or paste the pairing link.")
                    )
                }
            }
            .navigationTitle("Scan pairing code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}

struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let found: (String) -> Void
        private var done = false

        init(found: @escaping (String) -> Void) {
            self.found = found
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in items {
                guard !done, case .barcode(let code) = item, let text = code.payloadStringValue,
                      text.lowercased().hasPrefix("lockin://pair") else { continue }
                done = true
                found(text)
            }
        }
    }
}
