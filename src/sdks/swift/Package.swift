// swift-tools-version: 6.0

import PackageDescription
import Foundation

let nativeBindings = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent(".build/native-bindings")

let package = Package(
    name: "Oliphaunt",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "COliphaunt", targets: ["COliphaunt"]),
        .library(name: "Oliphaunt", targets: ["Oliphaunt"]),
        .library(name: "OliphauntExtensionSupport", targets: ["OliphauntExtensionSupport"])
    ],
    targets: [
        .systemLibrary(
            name: "OliphauntNativeBindingsFFI",
            path: ".build/native-bindings/ffi"
        ),
        .target(
            name: "OliphauntNativeBindings",
            dependencies: ["OliphauntNativeBindingsFFI"],
            path: ".build/native-bindings/swift",
            linkerSettings: [.unsafeFlags([
                nativeBindings.appendingPathComponent("liboliphaunt_mobile_bindings.a").path
            ])]
        ),
        .target(
            name: "COliphaunt",
            publicHeadersPath: "include"
        ),
        .target(
            name: "Oliphaunt",
            dependencies: ["COliphaunt", "OliphauntNativeBindings"]
        ),
        .target(
            name: "OliphauntExtensionSupport",
            dependencies: ["COliphaunt", "Oliphaunt"]
        ),
        .testTarget(
            name: "OliphauntTests",
            dependencies: ["Oliphaunt"]
        )
    ]
)
