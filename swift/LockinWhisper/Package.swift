// swift-tools-version: 6.0
// Lockin's transcription helper: turns a lecture recording into text with Whisper on
// Apple Silicon (WhisperKit, Core ML), and cuts its sound into small parts for an AI
// that listens to audio itself. Built by .github/workflows/mac-app.yml.
import PackageDescription

let package = Package(
    name: "LockinWhisper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "lockin-whisper", targets: ["LockinWhisper"])
    ],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/WhisperKit", exact: "1.1.1")
    ],
    targets: [
        .executableTarget(
            name: "LockinWhisper",
            dependencies: [.product(name: "WhisperKit", package: "WhisperKit")],
            path: "Sources/LockinWhisper"
        )
    ],
    swiftLanguageModes: [.v5]
)
