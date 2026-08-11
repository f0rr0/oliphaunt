import Foundation
import Testing

@testable import OliphauntBrokerExtension

@Test
func recursiveDataProtectionAppliesToEveryDirectoryAndRegularFileRootFirst() throws {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory.appendingPathComponent(
        "oliphaunt-protection-apply-\(UUID().uuidString)",
        isDirectory: true
    )
    defer { try? fileManager.removeItem(at: root) }

    let runtime = root.appendingPathComponent("runtime-cache/runtime/files", isDirectory: true)
    let runtimeFile = runtime.appendingPathComponent("share/icu/icudt.dat", isDirectory: false)
    let relationDirectory = root.appendingPathComponent("pgdata/base/16384", isDirectory: true)
    let relationFile = relationDirectory.appendingPathComponent("32768", isDirectory: false)
    let walDirectory = root.appendingPathComponent("pgdata/pg_wal", isDirectory: true)
    let walFile = walDirectory.appendingPathComponent(
        "000000010000000000000001",
        isDirectory: false
    )
    let staging = root.appendingPathComponent("staging", isDirectory: true)
    let manifest = root.appendingPathComponent("manifest.json", isDirectory: false)

    try fileManager.createDirectory(
        at: runtimeFile.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try fileManager.createDirectory(at: relationDirectory, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: walDirectory, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
    try Data("runtime".utf8).write(to: runtimeFile)
    try Data("relation".utf8).write(to: relationFile)
    try Data("wal".utf8).write(to: walFile)
    try Data("{}".utf8).write(to: manifest)

    let storage = try BrokerExtensionStorage(location: .extensionPrivate, rootURL: root)
    var appliedPaths: [String] = []
    try storage.enforceDataProtectionRecursively(fileManager: fileManager) { url in
        appliedPaths.append(url.standardizedFileURL.path)
    }

    var expectedPaths = Set([root.standardizedFileURL.path])
    let enumerator = try #require(fileManager.enumerator(at: root, includingPropertiesForKeys: nil))
    for case let url as URL in enumerator {
        expectedPaths.insert(url.standardizedFileURL.path)
    }
    #expect(Set(appliedPaths) == expectedPaths)
    #expect(appliedPaths.count == expectedPaths.count)

    let indexes = Dictionary(
        uniqueKeysWithValues: appliedPaths.enumerated().map { ($0.element, $0.offset) })
    for path in appliedPaths where path != root.path {
        let parent = URL(fileURLWithPath: path).deletingLastPathComponent().standardizedFileURL.path
        #expect(try #require(indexes[parent]) < (try #require(indexes[path])))
    }
}

@Test
func recursiveProtectionEvidenceFailsClosedOnTraversalError() throws {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory.appendingPathComponent(
        "oliphaunt-protection-audit-\(UUID().uuidString)",
        isDirectory: true
    )
    let denied = root.appendingPathComponent("denied", isDirectory: true)
    try fileManager.createDirectory(at: denied, withIntermediateDirectories: true)
    try Data("unreadable".utf8).write(
        to: denied.appendingPathComponent("entry", isDirectory: false)
    )
    try fileManager.setAttributes([.posixPermissions: 0], ofItemAtPath: denied.path)
    defer {
        try? fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: denied.path)
        try? fileManager.removeItem(at: root)
    }

    let storage = try BrokerExtensionStorage(
        location: .extensionPrivate,
        rootURL: root
    )
    let evidence = storage.recursiveProtectionEvidence(fileManager: fileManager)

    #expect(evidence.enumerationFailed)
    #expect(evidence.unreadableEntryCount > 0)
    #expect(!evidence.allEntriesMatchExpectedProtection)
}

@Test
func recursiveDataProtectionFailsClosedOnTraversalErrorWithoutLeakingPaths() throws {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory.appendingPathComponent(
        "oliphaunt-protection-enforcement-\(UUID().uuidString)",
        isDirectory: true
    )
    let denied = root.appendingPathComponent("private-entry-name", isDirectory: true)
    try fileManager.createDirectory(at: denied, withIntermediateDirectories: true)
    try Data("unreadable".utf8).write(
        to: denied.appendingPathComponent("secret-file-name", isDirectory: false)
    )
    try fileManager.setAttributes([.posixPermissions: 0], ofItemAtPath: denied.path)
    defer {
        try? fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: denied.path)
        try? fileManager.removeItem(at: root)
    }

    let storage = try BrokerExtensionStorage(location: .extensionPrivate, rootURL: root)
    var appliedPaths: [String] = []
    do {
        try storage.enforceDataProtectionRecursively(fileManager: fileManager) { url in
            appliedPaths.append(url.path)
        }
        Issue.record("recursive protection unexpectedly accepted an unreadable subtree")
    } catch {
        let description = String(describing: error)
        #expect(appliedPaths.isEmpty)
        #expect(description.contains("cannot enforce broker storage data protection"))
        #expect(!description.contains(root.path))
        #expect(!description.contains("private-entry-name"))
        #expect(!description.contains("secret-file-name"))
    }
}

@Test
func recursiveDataProtectionRejectsSymbolicLinksWithoutLeakingPaths() throws {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory.appendingPathComponent(
        "oliphaunt-protection-symlink-\(UUID().uuidString)",
        isDirectory: true
    )
    let outside = fileManager.temporaryDirectory.appendingPathComponent(
        "oliphaunt-protection-outside-\(UUID().uuidString)",
        isDirectory: true
    )
    try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: outside, withIntermediateDirectories: true)
    let link = root.appendingPathComponent("private-link-name", isDirectory: false)
    try fileManager.createSymbolicLink(at: link, withDestinationURL: outside)
    defer {
        try? fileManager.removeItem(at: root)
        try? fileManager.removeItem(at: outside)
    }

    let storage = try BrokerExtensionStorage(location: .extensionPrivate, rootURL: root)
    var appliedPaths: [String] = []
    do {
        try storage.enforceDataProtectionRecursively(fileManager: fileManager) { url in
            appliedPaths.append(url.path)
        }
        Issue.record("recursive protection unexpectedly accepted a symbolic link")
    } catch {
        let description = String(describing: error)
        #expect(appliedPaths.isEmpty)
        #expect(description.contains("cannot enforce broker storage data protection"))
        #expect(!description.contains(root.path))
        #expect(!description.contains("private-link-name"))
    }
}

@Test
func recursiveDataProtectionSanitizesApplicationFailureAndStopsMutation() throws {
    let fileManager = FileManager.default
    let root = fileManager.temporaryDirectory.appendingPathComponent(
        "oliphaunt-protection-application-\(UUID().uuidString)",
        isDirectory: true
    )
    let nested = root.appendingPathComponent("nested", isDirectory: true)
    let sensitiveName = "private-application-failure"
    let failure = nested.appendingPathComponent(sensitiveName, isDirectory: false)
    try fileManager.createDirectory(at: nested, withIntermediateDirectories: true)
    try Data("failure".utf8).write(to: failure)
    defer { try? fileManager.removeItem(at: root) }

    let storage = try BrokerExtensionStorage(location: .extensionPrivate, rootURL: root)
    var appliedPaths: [String] = []
    do {
        try storage.enforceDataProtectionRecursively(fileManager: fileManager) { url in
            appliedPaths.append(url.standardizedFileURL.path)
            if url.standardizedFileURL.path == failure.standardizedFileURL.path {
                throw NSError(
                    domain: "failed to protect \(failure.path)",
                    code: 1
                )
            }
        }
        Issue.record("recursive protection unexpectedly ignored an application failure")
    } catch {
        let description = String(describing: error)
        #expect(appliedPaths.last == failure.standardizedFileURL.path)
        #expect(description.contains("cannot enforce broker storage data protection"))
        #expect(!description.contains(root.path))
        #expect(!description.contains(sensitiveName))
    }
}
