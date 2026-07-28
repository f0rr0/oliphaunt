// swift-tools-version: 6.0

import PackageDescription

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
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-docc-plugin", from: "1.4.0")
    ],
    targets: [
        .target(
            name: "COliphaunt",
            publicHeadersPath: "include"
        ),
        .target(
            name: "Oliphaunt",
            dependencies: ["COliphaunt"]
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
