// swift-tools-version: 6.0
// Lockin for macOS — native SwiftUI app and core engines over the existing lockin.db.
import PackageDescription

let package = Package(
    name: "Lockin",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "LockinCore", targets: ["LockinCore"]),
        .executable(name: "Lockin", targets: ["Lockin"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift", from: "7.0.0"),
    ],
    targets: [
        .target(
            name: "LockinCore",
            dependencies: [
                .product(name: "GRDB", package: "GRDB.swift"),
            ],
            path: "Sources/LockinCore",
            // WIP-CHUNKS-6-7: chunks 6 and 7 are being written; left out of the build until they compile.
            exclude: ["LLM", "Queue", "Slides", "Settings.swift"]
        ),
        .executableTarget(
            name: "Lockin",
            dependencies: ["LockinCore"],
            path: "Sources/Lockin"
        ),
        .testTarget(
            name: "LockinTests",
            dependencies: ["LockinCore"],
            path: "Tests/LockinTests",
            // WIP-CHUNKS-6-7
            exclude: [
                "JSONSchemasTests.swift", "JobQueueTests.swift", "JobSupportTests.swift", "LLMSchemasTests.swift",
                "PipelineTests.swift", "PromptsTests.swift", "SettingsTests.swift",
                "APIProvidersTests.swift", "CLIProvidersTests.swift", "MLXProviderTests.swift",
                "ModelCatalogTests.swift", "SlideRendererTests.swift",
            ]
        ),
    ],
    swiftLanguageModes: [.v5]
)
