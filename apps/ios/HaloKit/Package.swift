// swift-tools-version: 5.9
import PackageDescription

/// Halo's visual language, as a package rather than files in the app target.
///
/// E5's contract is "one hero, everywhere — the sun path": an Island stub, the
/// Today tile's edge, the Day cover, the recap, the share card, and a watch
/// complication later. Those live in four different binaries (app, widget
/// extension, share renderer, watch app), so the arc can only be *one drawing*
/// if it lives somewhere all of them can import. A file in the app target
/// would be copied within a week and the sizes would drift apart.
///
/// It also means the geometry and the formatting are testable from the command
/// line, with no simulator and no app build.
let package = Package(
    name: "HaloKit",
    // iOS 15 because the app supports it. Dropping those devices to get one
    // nicer numeric transition would be a product decision, not a package's
    // to make — the two places that want iOS 16 APIs gate them instead.
    platforms: [.iOS(.v15), .macOS(.v13), .watchOS(.v9)],
    products: [
        .library(name: "HaloKit", targets: ["HaloKit"])
    ],
    targets: [
        .target(name: "HaloKit"),
        .testTarget(name: "HaloKitTests", dependencies: ["HaloKit"])
    ]
)
