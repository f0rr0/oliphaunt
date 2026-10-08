import Foundation
@testable import Oliphaunt
@testable import OliphauntCore
import Testing

#if os(iOS) || os(macOS) || os(tvOS) || os(watchOS) || os(visionOS)
@Suite
struct ApplePlatformTests {
    @Test
    func discoversPackagedRuntimeResourcesBeforeTheyAreLoaded() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("oliphaunt-swift-bundle-discovery-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let bundleRoot = root.appendingPathComponent("OliphauntReactNativeResources.bundle", isDirectory: true)
        let runtimeRoot = bundleRoot.appendingPathComponent("oliphaunt", isDirectory: true)
        try FileManager.default.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)
        try Data(
            """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0"><dict>
              <key>CFBundleIdentifier</key><string>dev.oliphaunt.test.resources</string>
              <key>CFBundleName</key><string>OliphauntReactNativeResources</string>
              <key>CFBundlePackageType</key><string>BNDL</string>
            </dict></plist>
            """.utf8
        ).write(to: bundleRoot.appendingPathComponent("Info.plist"))

        let frameworkRoot = root.appendingPathComponent("liboliphaunt.framework", isDirectory: true)
        let frameworkRuntimeRoot = frameworkRoot.appendingPathComponent("Resources/oliphaunt", isDirectory: true)
        try FileManager.default.createDirectory(
            at: frameworkRuntimeRoot,
            withIntermediateDirectories: true
        )
        try Data(
            """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0"><dict>
              <key>CFBundleIdentifier</key><string>dev.oliphaunt.test.framework</string>
              <key>CFBundleName</key><string>liboliphaunt</string>
              <key>CFBundlePackageType</key><string>FMWK</string>
            </dict></plist>
            """.utf8
        ).write(to: frameworkRoot.appendingPathComponent("Info.plist"))

        let linkedRoot = root.deletingLastPathComponent().appendingPathComponent(
            "\(root.lastPathComponent)-link",
            isDirectory: true
        )
        try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: root)
        defer { try? FileManager.default.removeItem(at: linkedRoot) }

        let urls = bundleResourceURLs([], discoveringChildBundlesAt: linkedRoot)
        #expect(urls.map(\.standardizedFileURL).contains(bundleRoot.standardizedFileURL))
        #expect(
            urls.map(\.standardizedFileURL).contains(
                frameworkRoot.appendingPathComponent("Resources", isDirectory: true).standardizedFileURL
            )
        )
    }
}
#endif
