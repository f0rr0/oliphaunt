// swift-tools-version: 6.0

import PackageDescription

// SwiftPM is the public Apple SDK entrypoint. Release automation tags this
// root package and pairs it with checksum-covered liboliphaunt-native-v assets.
let package = Package(
    name: "Oliphaunt",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "Oliphaunt", targets: ["Oliphaunt"])
    ],
    targets: [
        .target(
            name: "COliphaunt",
            path: "src/sdks/swift/Sources/COliphaunt",
            publicHeadersPath: "include"
        ),
        .target(
            name: "Oliphaunt",
            dependencies: ["COliphaunt"],
            path: "src/sdks/swift/Sources/Oliphaunt"
        ),
        .testTarget(
            name: "OliphauntTests",
            dependencies: ["Oliphaunt"],
            path: "src/sdks/swift/Tests/OliphauntTests"
        )
    ]
)
