// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Oliphaunt",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "Oliphaunt", targets: ["Oliphaunt"])
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
        .testTarget(
            name: "OliphauntTests",
            dependencies: ["Oliphaunt"]
        )
    ]
)
