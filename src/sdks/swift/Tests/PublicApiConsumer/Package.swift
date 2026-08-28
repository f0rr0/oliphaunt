// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "OliphauntPublicApiConsumer",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    dependencies: [
        .package(name: "OliphauntSDK", path: "../..")
    ],
    targets: [
        .executableTarget(
            name: "OliphauntPublicApiConsumer",
            dependencies: [
                .product(name: "Oliphaunt", package: "OliphauntSDK")
            ]
        )
    ]
)
