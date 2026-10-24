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
        // Updates: the appcast is signed with the project's own EdDSA key (no Apple
        // developer account needed).
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
    ],
    targets: [
        .target(
            name: "LockinCore",
            dependencies: [
                .product(name: "GRDB", package: "GRDB.swift"),
            ],
            path: "Sources/LockinCore"
        ),
        .executableTarget(
            name: "Lockin",
            dependencies: [
                "LockinCore",
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            path: "Sources/Lockin"
        ),
        .testTarget(
            name: "LockinTests",
            dependencies: ["LockinCore"],
            path: "Tests/LockinTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
