import LockinKit
import PhotosUI
import SwiftUI
import VisionKit

/// Under an answer box: scan the pages of an answer written on paper, or choose photos
/// of them, and the AI — Claude, Gemini or whichever the computer uses, not the phone's
/// text recognition — types it out into the box to be checked before it's handed in.
struct HandwritingControl: View {
    @Environment(AppModel.self) private var model
    let questionId: String
    let question: String
    let apply: (HandwritingRead) -> Void

    @State private var scanning = false
    @State private var choosing = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var reading = false
    @State private var error: String?
    @State private var read: HandwritingRead?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Menu {
                if VNDocumentCameraViewController.isSupported {
                    Button { scanning = true } label: { Label("Scan pages", systemImage: "doc.viewfinder") }
                }
                Button { choosing = true } label: { Label("Choose photos", systemImage: "photo.on.rectangle") }
            } label: {
                if reading {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Reading your handwriting…")
                    }
                } else {
                    Label("Wrote it on paper?", systemImage: "pencil.and.scribble")
                }
            }
            .font(.subheadline)
            .disabled(reading)

            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if let read {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: typedNote(read))
                        if !read.unclear.isEmpty {
                            Text(verbatim: unsureNote(read)).fontWeight(.medium)
                        }
                    }
                    Spacer(minLength: 0)
                    Button {
                        self.read = nil
                    } label: {
                        Image(systemName: "xmark").font(.caption2.weight(.bold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss")
                }
                .font(.caption)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.yellow.opacity(0.18)))
            }
        }
        .fullScreenCover(isPresented: $scanning) {
            DocumentScanner { pages in
                scanning = false
                send(pages)
            } onCancel: {
                scanning = false
            }
            .ignoresSafeArea()
        }
        .photosPicker(isPresented: $choosing, selection: $picked, maxSelectionCount: maxHandwritingPages, matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await load(items) }
        }
    }

    private func typedNote(_ read: HandwritingRead) -> String {
        let who = read.model.map { " by \($0)" } ?? ""
        return "Typed out\(who). Check it against your page and fix anything misread before you hand in — it's marked as it stands."
    }

    private func unsureNote(_ read: HandwritingRead) -> String {
        "Not sure of: " + read.unclear.map { "“\($0)”" }.joined(separator: ", ")
    }

    private func load(_ items: [PhotosPickerItem]) async {
        var pages: [UIImage] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) { pages.append(image) }
        }
        if pages.isEmpty {
            error = "Those photos couldn't be opened."
        } else {
            send(pages)
        }
    }

    private func send(_ pages: [UIImage]) {
        let photos = pages.prefix(maxHandwritingPages).compactMap(jpegForReading)
        guard !photos.isEmpty else { return }
        reading = true
        error = nil
        Task {
            defer { reading = false }
            do {
                let typed = try await model.typeOutHandwriting(questionId: questionId, question: question, photos: photos)
                apply(typed)
                read = typed
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// A page as the AI is sent it: upright, no larger than it needs to be, as a JPEG.
func jpegForReading(_ image: UIImage) -> Data? {
    let longest = max(image.size.width, image.size.height)
    guard longest > 0 else { return nil }
    let scale = min(1, 2000 / longest)
    let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    // Drawing applies the photo's orientation, so the page arrives the right way up.
    let drawn = UIGraphicsImageRenderer(size: size, format: format).image { context in
        UIColor.white.setFill()
        context.fill(CGRect(origin: .zero, size: size))
        image.draw(in: CGRect(origin: .zero, size: size))
    }
    return drawn.jpegData(compressionQuality: 0.8)
}

/// The document camera: each page found, flattened and cropped as it's scanned.
struct DocumentScanner: UIViewControllerRepresentable {
    let onScan: ([UIImage]) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan, onCancel: onCancel) }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onScan: ([UIImage]) -> Void
        let onCancel: () -> Void

        init(onScan: @escaping ([UIImage]) -> Void, onCancel: @escaping () -> Void) {
            self.onScan = onScan
            self.onCancel = onCancel
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            onScan((0..<scan.pageCount).map { scan.imageOfPage(at: $0) })
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            onCancel()
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
            onCancel()
        }
    }
}
