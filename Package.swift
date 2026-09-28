// swift-tools-version: 6.0

import PackageDescription
import Foundation

let nativeBindings = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("src/native/sdks/swift/.build/native-bindings")

let package = Package(
    name: "Oliphaunt",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "COliphaunt", targets: ["COliphaunt"]),
        .library(name: "Oliphaunt", targets: ["Oliphaunt"]),
        .library(name: "OliphauntCore", targets: ["OliphauntCore"]),
        .library(name: "OliphauntBroker", targets: ["OliphauntBroker"]),
        .library(name: "OliphauntBrokerExtension", targets: ["OliphauntBrokerExtension"]),
        .library(name: "OliphauntExtensionSupport", targets: ["OliphauntExtensionSupport"])
    ],
    targets: [
        .systemLibrary(
            name: "OliphauntNativeBindingsFFI",
            path: "src/native/sdks/swift/.build/native-bindings/ffi"
        ),
        .target(
            name: "OliphauntNativeBindings",
            dependencies: ["OliphauntNativeBindingsFFI"],
            path: "src/native/sdks/swift/.build/native-bindings/swift",
            linkerSettings: [.unsafeFlags([
                nativeBindings.appendingPathComponent("liboliphaunt_mobile_bindings.a").path
            ])]
        ),
        .target(
            name: "COliphaunt",
            path: "src/native/sdks/swift/Sources/COliphaunt",
            publicHeadersPath: "include"
        ),
        .target(name: "OliphauntCore", dependencies: ["OliphauntNativeBindings"], path: "src/native/sdks/swift/Sources/OliphauntCore"),
        .target(name: "OliphauntBroker", dependencies: ["OliphauntCore", "OliphauntNativeBindings"], path: "src/native/sdks/swift/Sources/OliphauntBroker"),
        .target(name: "OliphauntBrokerExtension", dependencies: ["Oliphaunt", "OliphauntCore", "OliphauntNativeBindings"], path: "src/native/sdks/swift/Sources/OliphauntBrokerExtension"),
        .target(
            name: "Oliphaunt",
            dependencies: ["COliphaunt", "OliphauntCore", "OliphauntNativeBindings"],
            path: "src/native/sdks/swift/Sources/Oliphaunt"
        ),
        .target(
            name: "OliphauntExtensionSupport",
            dependencies: ["COliphaunt", "Oliphaunt"],
            path: "src/native/sdks/swift/Sources/OliphauntExtensionSupport"
        ),
        .testTarget(
            name: "OliphauntTests",
            dependencies: ["Oliphaunt", "OliphauntCore"],
            path: "src/native/sdks/swift/Tests/OliphauntTests"
        )
    ]
)
