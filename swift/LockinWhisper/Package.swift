// swift-tools-version: 6.0
// Lockin's speech helper: turns a lecture recording into text with Whisper on Apple
// Silicon (WhisperKit, Core ML), cuts its sound into small parts for an AI that listens
// to audio itself, and speaks the viva examiner's lines in a natural voice (TTSKit,
// Qwen3-TTS). Built by .github/workflows/mac-app.yml.
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
            dependencies: [
                .product(name: "WhisperKit", package: "WhisperKit"),
                .product(name: "TTSKit", package: "WhisperKit"),
            ],
            path: "Sources/LockinWhisper"
        )
    ],
    swiftLanguageModes: [.v5]
)
