// swift-tools-version: 6.0

import PackageDescription

// SwiftPM is the public Apple SDK entrypoint. Release automation tags this
// root package and pairs it with checksum-covered liboliphaunt-native-v assets.
let package = Package(
    name: "Oliphaunt",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "OliphauntBrokerProtocol", targets: ["OliphauntBrokerProtocol"]),
        .library(name: "OliphauntBrokerXPC", targets: ["OliphauntBrokerXPC"]),
        .library(name: "OliphauntIOSBroker", targets: ["OliphauntIOSBroker"]),
        .library(name: "OliphauntBrokerExtension", targets: ["OliphauntBrokerExtension"]),
        .library(name: "Oliphaunt", targets: ["Oliphaunt"]),
    ],
    targets: [
        .target(
            name: "COliphaunt",
            path: "src/sdks/swift/Sources/COliphaunt",
            publicHeadersPath: "include"
        ),
        .target(
            name: "OliphauntBrokerProtocol",
            path: "src/sdks/swift/Sources/OliphauntBrokerProtocol"
        ),
        .target(
            name: "OliphauntBrokerXPC",
            dependencies: ["OliphauntBrokerProtocol"],
            path: "src/sdks/swift/Sources/OliphauntBrokerXPC"
        ),
        .target(
            name: "Oliphaunt",
            dependencies: ["COliphaunt"],
            path: "src/sdks/swift/Sources/Oliphaunt"
        ),
        .target(
            name: "OliphauntIOSBroker",
            dependencies: ["Oliphaunt", "OliphauntBrokerProtocol", "OliphauntBrokerXPC"],
            path: "src/sdks/swift/Sources/OliphauntIOSBroker"
        ),
        .target(
            name: "OliphauntBrokerExtension",
            dependencies: ["COliphaunt", "Oliphaunt", "OliphauntBrokerProtocol"],
            path: "src/sdks/swift/Sources/OliphauntBrokerExtension"
        ),
        .testTarget(
            name: "OliphauntTests",
            dependencies: ["Oliphaunt"],
            path: "src/sdks/swift/Tests/OliphauntTests"
        ),
        .testTarget(
            name: "OliphauntBrokerProtocolTests",
            dependencies: ["OliphauntBrokerProtocol"],
            path: "src/sdks/swift/Tests/OliphauntBrokerProtocolTests"
        ),
        .testTarget(
            name: "OliphauntBrokerXPCTests",
            dependencies: ["OliphauntBrokerProtocol", "OliphauntBrokerXPC"],
            path: "src/sdks/swift/Tests/OliphauntBrokerXPCTests"
        ),
        .testTarget(
            name: "OliphauntBrokerExtensionTests",
            dependencies: [
                "Oliphaunt",
                "OliphauntBrokerExtension",
                "OliphauntBrokerProtocol",
            ],
            path: "src/sdks/swift/Tests/OliphauntBrokerExtensionTests"
        ),
        .testTarget(
            name: "OliphauntIOSBrokerTests",
            dependencies: [
                "Oliphaunt",
                "OliphauntBrokerProtocol",
                "OliphauntBrokerXPC",
                "OliphauntIOSBroker",
            ],
            path: "src/sdks/swift/Tests/OliphauntIOSBrokerTests"
        ),
    ]
)
