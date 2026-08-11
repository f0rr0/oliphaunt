// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Oliphaunt",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "COliphaunt", targets: ["COliphaunt"]),
        .library(name: "OliphauntBrokerProtocol", targets: ["OliphauntBrokerProtocol"]),
        .library(name: "OliphauntBrokerXPC", targets: ["OliphauntBrokerXPC"]),
        .library(name: "OliphauntIOSBroker", targets: ["OliphauntIOSBroker"]),
        .library(name: "OliphauntBrokerExtension", targets: ["OliphauntBrokerExtension"]),
        .library(name: "Oliphaunt", targets: ["Oliphaunt"]),
        .library(name: "OliphauntExtensionSupport", targets: ["OliphauntExtensionSupport"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-docc-plugin", from: "1.4.0")
    ],
    targets: [
        .target(
            name: "COliphaunt",
            publicHeadersPath: "include"
        ),
        .target(name: "OliphauntBrokerProtocol"),
        .target(
            name: "OliphauntBrokerXPC",
            dependencies: ["OliphauntBrokerProtocol"]
        ),
        .target(
            name: "Oliphaunt",
            dependencies: ["COliphaunt"]
        ),
        .target(
            name: "OliphauntIOSBroker",
            dependencies: ["Oliphaunt", "OliphauntBrokerProtocol", "OliphauntBrokerXPC"]
        ),
        .target(
            name: "OliphauntBrokerExtension",
            dependencies: ["COliphaunt", "Oliphaunt", "OliphauntBrokerProtocol"]
        ),
        .target(
            name: "OliphauntExtensionSupport",
            dependencies: ["COliphaunt", "Oliphaunt"]
        ),
        .testTarget(
            name: "OliphauntTests",
            dependencies: ["Oliphaunt"]
        ),
        .testTarget(
            name: "OliphauntBrokerProtocolTests",
            dependencies: ["OliphauntBrokerProtocol"]
        ),
        .testTarget(
            name: "OliphauntBrokerXPCTests",
            dependencies: ["OliphauntBrokerProtocol", "OliphauntBrokerXPC"]
        ),
        .testTarget(
            name: "OliphauntBrokerExtensionTests",
            dependencies: [
                "Oliphaunt",
                "OliphauntBrokerExtension",
                "OliphauntBrokerProtocol",
            ]
        ),
        .testTarget(
            name: "OliphauntIOSBrokerTests",
            dependencies: [
                "Oliphaunt",
                "OliphauntBrokerProtocol",
                "OliphauntBrokerXPC",
                "OliphauntIOSBroker",
            ]
        ),
    ]
)
