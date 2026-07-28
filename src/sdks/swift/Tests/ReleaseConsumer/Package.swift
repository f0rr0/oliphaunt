// swift-tools-version: 6.0

import Foundation
import PackageDescription

func requiredReleasePackage() -> String {
    guard let value = ProcessInfo.processInfo.environment["OLIPHAUNT_SWIFT_RELEASE_PACKAGE"],
          !value.isEmpty
    else {
        fatalError("OLIPHAUNT_SWIFT_RELEASE_PACKAGE must name the reconstructed exact-candidate package")
    }
    return value
}

let releasePackage = requiredReleasePackage()

let package = Package(
    name: "OliphauntSwiftReleaseConsumer",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: releasePackage)],
    targets: [
        .executableTarget(
            name: "OliphauntReleaseSmoke",
            dependencies: [
                .product(name: "Oliphaunt", package: "oliphaunt"),
                .product(name: "OliphauntICU", package: "oliphaunt")
            ]
        )
    ]
)
