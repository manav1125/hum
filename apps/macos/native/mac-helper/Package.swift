// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MacHelper",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .executable(name: "cue-mac-helper", targets: ["MacHelperExecutable"]),
    ],
    targets: [
        .target(name: "MacHelperCore"),
        .executableTarget(
            name: "MacHelperExecutable",
            dependencies: ["MacHelperCore"],
            // ComputerUse/ and AppControl/ hold the WS-H computer-use + app-control
            // port (source copied from clients/macos/vellum-assistant, then adapted:
            // VellumAssistantShared severed, Combine overlay proxy dropped, logger
            // subsystem pinned to a literal — see PORT-NOTES.md). The two JSON-RPC
            // methods (computeruse.perform / appcontrol.perform) are registered in
            // main.swift via an async @MainActor dispatch.
            exclude: ["Info.plist"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Carbon"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ImageIO"),
                .linkedFramework("IOKit"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("Speech"),
                .linkedFramework("UniformTypeIdentifiers"),
            ]
        ),
        .testTarget(
            name: "MacHelperCoreTests",
            dependencies: ["MacHelperCore"]
        ),
        // Tests for the WS-H computer-use port. `ActionVerifier` (the safety
        // gate) has no app/AX/CGEvent dependencies, so it unit-tests cleanly by
        // @testable-importing the executable target.
        .testTarget(
            name: "MacHelperExecutableTests",
            dependencies: ["MacHelperExecutable"]
        ),
    ]
)
