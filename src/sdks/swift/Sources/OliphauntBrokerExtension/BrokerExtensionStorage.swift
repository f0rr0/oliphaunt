import CryptoKit
import Foundation
import OliphauntBrokerProtocol

/// The persistent filesystem layout owned by the broker app-extension process.
///
/// The host names only the logical root `default`. It never sends a PGDATA path.
/// Resolving that logical name inside the extension is an intentional security and
/// process-isolation boundary.
public struct BrokerExtensionStorage: Equatable, Sendable {
    public enum Location: Equatable, Sendable {
        case extensionPrivate
        case appGroup(identifier: String)

        public var requiresAppGroup: Bool {
            if case .appGroup = self { return true }
            return false
        }
    }

    public let location: Location
    public let rootURL: URL

    public var manifestURL: URL {
        rootURL.appendingPathComponent("manifest.json", isDirectory: false)
    }

    public var pgdataURL: URL {
        rootURL.appendingPathComponent("pgdata", isDirectory: true)
    }

    public var runtimeCacheURL: URL {
        rootURL.appendingPathComponent("runtime-cache", isDirectory: true)
    }

    public var stagingURL: URL {
        rootURL.appendingPathComponent("staging", isDirectory: true)
    }

    public init(location: Location, rootURL: URL) throws {
        guard rootURL.isFileURL else {
            throw BrokerError.invalidConfiguration("broker storage root must be a file URL")
        }
        let standardized = rootURL.standardizedFileURL
        guard !standardized.path.isEmpty, !standardized.path.utf8.contains(0) else {
            throw BrokerError.invalidConfiguration("broker storage root is invalid")
        }
        self.location = location
        self.rootURL = standardized
    }

    /// Resolves `Library/Application Support/Oliphaunt/default` in the extension's
    /// own container. Call this from the app-extension process, not from the host.
    public static func extensionPrivate(
        fileManager: FileManager = .default
    ) throws -> BrokerExtensionStorage {
        let applicationSupport = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return try BrokerExtensionStorage(
            location: .extensionPrivate,
            rootURL:
                applicationSupport
                .appendingPathComponent("Oliphaunt", isDirectory: true)
                .appendingPathComponent(OliphauntBrokerProtocol.canonicalRootID, isDirectory: true)
        )
    }

    /// Explicit fallback for systems where extension-private persistence cannot
    /// be made reliable. The caller must hold the matching App Group entitlement.
    public static func appGroup(
        identifier: String,
        fileManager: FileManager = .default
    ) throws -> BrokerExtensionStorage {
        guard !identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            !identifier.utf8.contains(0)
        else {
            throw BrokerError.invalidConfiguration("App Group identifier is invalid")
        }
        guard
            let container = fileManager.containerURL(
                forSecurityApplicationGroupIdentifier: identifier
            )
        else {
            throw BrokerError.invalidConfiguration(
                "App Group container is unavailable for \(identifier)"
            )
        }
        return try BrokerExtensionStorage(
            location: .appGroup(identifier: identifier),
            rootURL:
                container
                .appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("Application Support", isDirectory: true)
                .appendingPathComponent("Oliphaunt", isDirectory: true)
                .appendingPathComponent(OliphauntBrokerProtocol.canonicalRootID, isDirectory: true)
        )
    }

    /// Creates the canonical layout and either validates the durable root
    /// manifest or publishes a new one atomically for an empty root.
    public func prepare(
        postgresMajorVersion: UInt16,
        liboliphauntVersion: String,
        cABIVersion: UInt32,
        selectedPostgresExtensions: [String],
        startupConfigurationDigest: String,
        dataProtectionPolicy: String = "completeUntilFirstUserAuthentication",
        fileManager: FileManager = .default
    ) throws -> PreparedBrokerExtensionStorage {
        try validateManifestString(liboliphauntVersion, label: "liboliphaunt version")
        try validateManifestString(
            startupConfigurationDigest, label: "startup configuration digest")
        try validateManifestString(dataProtectionPolicy, label: "data-protection policy")
        guard dataProtectionPolicy == "completeUntilFirstUserAuthentication" else {
            throw BrokerError.invalidConfiguration(
                "unsupported broker data-protection policy \(dataProtectionPolicy)"
            )
        }
        let selectedExtensions = try canonicalExtensions(selectedPostgresExtensions)

        try createProtectedDirectory(rootURL, fileManager: fileManager)
        try rejectSymbolicLink(rootURL, fileManager: fileManager)
        try createProtectedDirectory(pgdataURL, fileManager: fileManager)
        try createProtectedDirectory(runtimeCacheURL, fileManager: fileManager)
        try createProtectedDirectory(stagingURL, fileManager: fileManager)

        let expected = ManifestIdentity(
            postgresMajorVersion: postgresMajorVersion,
            liboliphauntVersion: liboliphauntVersion,
            cABIVersion: cABIVersion,
            selectedPostgresExtensions: selectedExtensions,
            startupConfigurationDigest: startupConfigurationDigest,
            dataProtectionPolicy: dataProtectionPolicy
        )

        let manifest: BrokerRootManifest
        if fileManager.fileExists(atPath: manifestURL.path) {
            manifest = try readManifest(fileManager: fileManager)
            try expected.validate(manifest)
        } else {
            let pgdataEntries = try fileManager.contentsOfDirectory(
                at: pgdataURL,
                includingPropertiesForKeys: nil,
                options: []
            )
            guard pgdataEntries.isEmpty else {
                throw BrokerError.invalidConfiguration(
                    "broker PGDATA exists without manifest.json"
                )
            }
            manifest = BrokerRootManifest(
                postgresMajorVersion: postgresMajorVersion,
                liboliphauntVersion: liboliphauntVersion,
                cABIVersion: cABIVersion,
                rootUUID: UUID(),
                selectedPostgresExtensions: selectedExtensions,
                startupConfigurationDigest: startupConfigurationDigest,
                dataProtectionPolicy: dataProtectionPolicy
            )
            try writeManifest(manifest, fileManager: fileManager)
        }

        let encoded = try Self.canonicalManifestData(manifest)
        return PreparedBrokerExtensionStorage(
            storage: self,
            manifest: manifest,
            manifestDigest: Self.sha256Hex(encoded)
        )
    }

    public func readManifest(
        fileManager: FileManager = .default
    ) throws -> BrokerRootManifest {
        try rejectSymbolicLink(manifestURL, fileManager: fileManager)
        let attributes = try fileManager.attributesOfItem(atPath: manifestURL.path)
        if let size = attributes[.size] as? NSNumber, size.uint64Value > 1024 * 1024 {
            throw BrokerError.invalidConfiguration("broker manifest exceeds 1 MiB")
        }
        do {
            let data = try Data(contentsOf: manifestURL, options: [])
            let manifest = try JSONDecoder().decode(BrokerRootManifest.self, from: data)
            guard manifest.formatVersion == 1 else {
                throw BrokerError.invalidConfiguration(
                    "unsupported broker root manifest format \(manifest.formatVersion)"
                )
            }
            return manifest
        } catch let error as BrokerError {
            throw error
        } catch {
            throw BrokerError.invalidConfiguration(
                "cannot decode broker root manifest: \(error)"
            )
        }
    }

    public func validatePostgresVersion(
        _ expectedMajorVersion: UInt16,
        fileManager: FileManager = .default
    ) throws {
        let versionURL = pgdataURL.appendingPathComponent("PG_VERSION", isDirectory: false)
        guard fileManager.fileExists(atPath: versionURL.path) else {
            throw BrokerError.invalidConfiguration("opened PGDATA has no PG_VERSION")
        }
        let text = try String(contentsOf: versionURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard text == String(expectedMajorVersion) else {
            throw BrokerError.invalidConfiguration(
                "PGDATA major version \(text) does not match \(expectedMajorVersion)"
            )
        }
    }

    /// Applies the broker's Data Protection class to every directory and
    /// regular file currently owned by this root.
    ///
    /// Runtime resources and template PGDATA are copied from the signed app
    /// bundle. `FileManager.copyItem` preserves their source protection class,
    /// so protecting only the destination's top-level directories is not
    /// sufficient. Worker startup calls this after runtime hydration and
    /// PostgreSQL bootstrap, before publishing Ready.
    func enforceDataProtectionRecursively(
        fileManager: FileManager = .default
    ) throws {
        try enforceDataProtectionRecursively(fileManager: fileManager) { url in
            try applyDataProtection(to: url, fileManager: fileManager)
        }
    }

    /// Test seam for proving traversal and ordering on hosts where iOS Data
    /// Protection metadata is unavailable. This stays module-internal so URLs
    /// cannot cross the broker process boundary.
    func enforceDataProtectionRecursively(
        fileManager: FileManager,
        applyingProtection: (URL) throws -> Void
    ) throws {
        var enumerationFailed = false
        var entries: [URL] = []

        func validate(_ url: URL) throws {
            let attributes = try fileManager.attributesOfItem(atPath: url.path)
            guard let type = attributes[.type] as? FileAttributeType,
                type == .typeDirectory || type == .typeRegular
            else {
                throw RecursiveDataProtectionFailure()
            }
            entries.append(url)
        }

        do {
            // Preflight the complete tree before the first mutation. A known
            // traversal, metadata, symlink, or unsupported-type fault therefore
            // cannot leave a partially rewritten protection population.
            try validate(rootURL)
            guard
                let enumerator = fileManager.enumerator(
                    at: rootURL,
                    includingPropertiesForKeys: nil,
                    options: [],
                    errorHandler: { _, _ in
                        enumerationFailed = true
                        return false
                    }
                )
            else {
                throw RecursiveDataProtectionFailure()
            }
            while let item = enumerator.nextObject() {
                guard let url = item as? URL else {
                    throw RecursiveDataProtectionFailure()
                }
                try validate(url)
            }
            guard !enumerationFailed else {
                throw RecursiveDataProtectionFailure()
            }

            // The preflight preserves FileManager's root-first, pre-order
            // enumeration, so parent directories are applied before children.
            for entry in entries {
                try applyingProtection(entry)
            }
        } catch {
            // Never include an underlying Foundation error: it may contain an
            // extension-private absolute or relative path.
            throw BrokerError.invalidConfiguration(
                "cannot enforce broker storage data protection"
            )
        }
    }

    /// Audits the complete extension-owned root without exposing filesystem
    /// names or paths across the process boundary. Call this while the worker is
    /// quiesced so PostgreSQL cannot add, remove, or rename entries mid-scan.
    public func recursiveProtectionEvidence(
        fileManager: FileManager = .default
    ) -> BrokerStorageProtectionEvidence {
        let expected = FileProtectionType.completeUntilFirstUserAuthentication
        var evidence = BrokerStorageProtectionEvidence(
            expectedProtection: expected.rawValue
        )
        let rootPath = rootURL.standardizedFileURL.path

        func inspect(_ url: URL) {
            evidence.entryCount += 1
            do {
                let attributes = try fileManager.attributesOfItem(atPath: url.path)
                let type = attributes[.type] as? FileAttributeType
                switch type {
                case .typeDirectory:
                    evidence.directoryCount += 1
                case .typeRegular:
                    evidence.regularFileCount += 1
                case .typeSymbolicLink:
                    evidence.symbolicLinkCount += 1
                default:
                    evidence.otherEntryCount += 1
                }

                #if os(iOS) && !targetEnvironment(simulator)
                    let protection = attributes[.protectionKey] as? FileProtectionType
                    if protection == expected {
                        evidence.matchingProtectionCount += 1
                    } else if protection == nil {
                        evidence.missingProtectionCount += 1
                    } else {
                        evidence.mismatchedProtectionCount += 1
                    }
                #else
                    evidence.protectionMetadataUnavailableCount += 1
                #endif

                guard type == .typeRegular else { return }
                if let size = attributes[.size] as? NSNumber {
                    evidence.regularFileBytes &+= size.uint64Value
                }
                let relative = url.standardizedFileURL.path.dropFirst(rootPath.count)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                let modification = (attributes[.modificationDate] as? Date)
                    .flatMap(Self.unixNanoseconds)
                if relative.hasPrefix("pgdata/base/") {
                    evidence.relationFileCount += 1
                    evidence.newestRelationModificationUnixNanoseconds = max(
                        evidence.newestRelationModificationUnixNanoseconds ?? 0,
                        modification ?? 0
                    )
                }
                if relative.hasPrefix("pgdata/pg_wal/") {
                    evidence.walFileCount += 1
                    evidence.newestWALModificationUnixNanoseconds = max(
                        evidence.newestWALModificationUnixNanoseconds ?? 0,
                        modification ?? 0
                    )
                }
            } catch {
                evidence.unreadableEntryCount += 1
            }
        }

        inspect(rootURL)
        guard
            let enumerator = fileManager.enumerator(
                at: rootURL,
                includingPropertiesForKeys: nil,
                options: [],
                errorHandler: { _, _ in
                    evidence.enumerationFailed = true
                    evidence.unreadableEntryCount += 1
                    return false
                }
            )
        else {
            evidence.enumerationFailed = true
            return evidence
        }
        for case let url as URL in enumerator {
            inspect(url)
        }
        return evidence
    }

    private static func unixNanoseconds(_ date: Date) -> UInt64? {
        let interval = date.timeIntervalSince1970
        guard interval >= 0, interval < Double(UInt64.max) / 1_000_000_000 else {
            return nil
        }
        return UInt64((interval * 1_000_000_000).rounded())
    }

    private func writeManifest(
        _ manifest: BrokerRootManifest,
        fileManager: FileManager
    ) throws {
        let data = try Self.canonicalManifestData(manifest)
        do {
            try data.write(to: manifestURL, options: [.atomic])
            try applyDataProtection(to: manifestURL, fileManager: fileManager)
        } catch {
            throw BrokerError.invalidConfiguration(
                "cannot publish broker root manifest: \(error)"
            )
        }
    }

    private static func canonicalManifestData(_ manifest: BrokerRootManifest) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(manifest)
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func createProtectedDirectory(
        _ url: URL,
        fileManager: FileManager
    ) throws {
        if fileManager.fileExists(atPath: url.path) {
            try rejectSymbolicLink(url, fileManager: fileManager)
        }
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        try rejectSymbolicLink(url, fileManager: fileManager)
        try applyDataProtection(to: url, fileManager: fileManager)
    }

    private func applyDataProtection(
        to url: URL,
        fileManager: FileManager
    ) throws {
        #if os(iOS) && !targetEnvironment(simulator)
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: url.path
            )
        #endif
    }

    private func rejectSymbolicLink(
        _ url: URL,
        fileManager: FileManager
    ) throws {
        guard fileManager.fileExists(atPath: url.path) else { return }
        let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey])
        guard values.isSymbolicLink != true else {
            throw BrokerError.invalidConfiguration(
                "broker storage path must not be a symbolic link: \(url.lastPathComponent)"
            )
        }
    }
}

private struct RecursiveDataProtectionFailure: Error {}

/// Aggregate-only data-protection evidence safe to return to the containing
/// application. It deliberately contains no absolute or relative paths.
public struct BrokerStorageProtectionEvidence: Codable, Equatable, Sendable {
    public var expectedProtection: String
    public var entryCount = 0
    public var regularFileCount = 0
    public var directoryCount = 0
    public var otherEntryCount = 0
    public var symbolicLinkCount = 0
    public var matchingProtectionCount = 0
    public var missingProtectionCount = 0
    public var mismatchedProtectionCount = 0
    public var protectionMetadataUnavailableCount = 0
    public var unreadableEntryCount = 0
    public var regularFileBytes: UInt64 = 0
    public var relationFileCount = 0
    public var walFileCount = 0
    public var newestRelationModificationUnixNanoseconds: UInt64?
    public var newestWALModificationUnixNanoseconds: UInt64?
    public var enumerationFailed = false

    public init(expectedProtection: String) {
        self.expectedProtection = expectedProtection
    }

    public var allEntriesMatchExpectedProtection: Bool {
        !enumerationFailed
            && unreadableEntryCount == 0
            && missingProtectionCount == 0
            && mismatchedProtectionCount == 0
            && protectionMetadataUnavailableCount == 0
            && symbolicLinkCount == 0
            && entryCount == matchingProtectionCount
    }
}

public struct PreparedBrokerExtensionStorage: Equatable, Sendable {
    public let storage: BrokerExtensionStorage
    public let manifest: BrokerRootManifest
    public let manifestDigest: String

    public init(
        storage: BrokerExtensionStorage,
        manifest: BrokerRootManifest,
        manifestDigest: String
    ) {
        self.storage = storage
        self.manifest = manifest
        self.manifestDigest = manifestDigest
    }
}

private struct ManifestIdentity {
    let postgresMajorVersion: UInt16
    let liboliphauntVersion: String
    let cABIVersion: UInt32
    let selectedPostgresExtensions: [String]
    let startupConfigurationDigest: String
    let dataProtectionPolicy: String

    func validate(_ manifest: BrokerRootManifest) throws {
        guard manifest.formatVersion == 1 else {
            throw mismatch("formatVersion", expected: "1", actual: String(manifest.formatVersion))
        }
        guard manifest.postgresMajorVersion == postgresMajorVersion else {
            throw mismatch(
                "postgresMajorVersion",
                expected: String(postgresMajorVersion),
                actual: String(manifest.postgresMajorVersion)
            )
        }
        guard manifest.liboliphauntVersion == liboliphauntVersion else {
            throw mismatch(
                "liboliphauntVersion",
                expected: liboliphauntVersion,
                actual: manifest.liboliphauntVersion
            )
        }
        guard manifest.cABIVersion == cABIVersion else {
            throw mismatch(
                "cABIVersion",
                expected: String(cABIVersion),
                actual: String(manifest.cABIVersion)
            )
        }
        guard manifest.selectedPostgresExtensions == selectedPostgresExtensions else {
            throw mismatch(
                "selectedPostgresExtensions",
                expected: selectedPostgresExtensions.joined(separator: ","),
                actual: manifest.selectedPostgresExtensions.joined(separator: ",")
            )
        }
        guard manifest.startupConfigurationDigest == startupConfigurationDigest else {
            throw mismatch(
                "startupConfigurationDigest",
                expected: startupConfigurationDigest,
                actual: manifest.startupConfigurationDigest
            )
        }
        guard manifest.dataProtectionPolicy == dataProtectionPolicy else {
            throw mismatch(
                "dataProtectionPolicy",
                expected: dataProtectionPolicy,
                actual: manifest.dataProtectionPolicy
            )
        }
    }

    private func mismatch(_ field: String, expected: String, actual: String) -> BrokerError {
        .invalidConfiguration(
            "root manifest \(field) mismatch: expected \(expected), got \(actual)"
        )
    }
}

private func canonicalExtensions(_ extensions: [String]) throws -> [String] {
    var result = Set<String>()
    for value in extensions {
        let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty,
            !name.utf8.contains(0),
            name.utf8.allSatisfy({ byte in
                (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
                    || (byte >= 48 && byte <= 57) || byte == 95
            })
        else {
            throw BrokerError.invalidConfiguration(
                "invalid PostgreSQL extension identifier \(String(reflecting: value))"
            )
        }
        result.insert(name)
    }
    return result.sorted()
}

private func validateManifestString(_ value: String, label: String) throws {
    guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        !value.utf8.contains(0)
    else {
        throw BrokerError.invalidConfiguration("\(label) is invalid")
    }
}
