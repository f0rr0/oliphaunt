import Foundation
@testable import Oliphaunt
import Testing

#if os(iOS) || os(macOS) || os(tvOS) || os(watchOS) || os(visionOS)
@Suite
struct ApplePlatformTests {
    @Test
    func discoversCocoaPodsRuntimeResourceBundlesBeforeTheyAreLoaded() throws {
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

        let urls = bundleResourceURLs([], discoveringChildBundlesAt: root)
        #expect(urls.map(\.standardizedFileURL).contains(bundleRoot.standardizedFileURL))
    }
}
#endif
