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
            // port (source copied from clients/macos/vellum-assistant). They are
            // EXCLUDED from the build until the transport adaptation is finished
            // on-device — see PORT-NOTES.md. They still reference the retiring
            // VellumAssistantShared module + a Combine overlay proxy, so compiling
            // them now would break the helper build. When the port is finished,
            // remove them from this `exclude` list and register the two JSON-RPC
            // methods (computeruse.perform / appcontrol.perform) in main.swift.
            exclude: ["Info.plist", "ComputerUse", "AppControl"],
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
    ]
)
