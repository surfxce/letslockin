// swift-tools-version: 5.9
// What the Lockin iPhone app knows, apart from its screens: talking to the computer,
// the flashcard scheduler, and marking answers with an API key. Tested on a Mac with
// `swift test`; the app (../LockinPhone) builds on top of it.
import PackageDescription

let package = Package(
    name: "LockinKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "LockinKit", targets: ["LockinKit"]),
    ],
    targets: [
        .target(name: "LockinKit"),
        .testTarget(
            name: "LockinKitTests",
            dependencies: ["LockinKit"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
