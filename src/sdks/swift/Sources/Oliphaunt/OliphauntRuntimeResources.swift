import Foundation

private let oliphauntRuntimeResourcesSchema = "oliphaunt-runtime-resources-v1"
private let oliphauntRuntimePackageLayout = "postgres-runtime-files-v1"
private let oliphauntClusterSeedPackageLayout = "oliphaunt-cluster-seed-v1"
private let oliphauntIcuDataSchema = "oliphaunt-icu-data-v1"

private var oliphauntSwiftClusterSeedTarget: String {
    #if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
    return "ios-datum64"
    #else
    return "macos-arm64"
    #endif
}

private var oliphauntSwiftClusterSeedCompatibilityKey: String {
    "native-pg18-\(oliphauntSwiftClusterSeedTarget)-v1"
}

struct ResolvedOliphauntRuntimeResources {
    var directory: URL
    var sharedPreloadLibraries: [String]
    var catalogProfile: OliphauntNativeCatalogProfile
    var owner: OliphauntRuntimeResources
}

private struct OliphauntIcuDataCarrier {
    var dataURL: URL
    var treeSha256: String
}

struct OliphauntRuntimeResourceSizeReport: Equatable, Sendable {
    var packageBytes: UInt64
    var runtimeBytes: UInt64
    var clusterSeedBytes: UInt64
    var staticRegistryBytes: UInt64
    var selectedExtensionBytes: UInt64
    var extensions: [OliphauntExtensionSizeReport]
    var runtimeFeatures: [String]
    var mobileStaticRegistryState: String?
    var mobileStaticRegistryRegistered: [String]
    var mobileStaticRegistryPending: [String]
    var nativeModuleStems: [String]

    init(
        packageBytes: UInt64,
        runtimeBytes: UInt64,
        clusterSeedBytes: UInt64,
        staticRegistryBytes: UInt64,
        selectedExtensionBytes: UInt64,
        extensions: [OliphauntExtensionSizeReport],
        runtimeFeatures: [String] = [],
        mobileStaticRegistryState: String? = nil,
        mobileStaticRegistryRegistered: [String] = [],
        mobileStaticRegistryPending: [String] = [],
        nativeModuleStems: [String] = []
    ) {
        self.packageBytes = packageBytes
        self.runtimeBytes = runtimeBytes
        self.clusterSeedBytes = clusterSeedBytes
        self.staticRegistryBytes = staticRegistryBytes
        self.selectedExtensionBytes = selectedExtensionBytes
        self.extensions = extensions
        self.runtimeFeatures = runtimeFeatures
        self.mobileStaticRegistryState = mobileStaticRegistryState
        self.mobileStaticRegistryRegistered = mobileStaticRegistryRegistered
        self.mobileStaticRegistryPending = mobileStaticRegistryPending
        self.nativeModuleStems = nativeModuleStems
    }
}

struct OliphauntExtensionSizeReport: Equatable, Sendable {
    var name: String
    var fileCount: Int
    var bytes: UInt64

    init(name: String, fileCount: Int, bytes: UInt64) {
        self.name = name
        self.fileCount = fileCount
        self.bytes = bytes
    }
}

@_spi(ExtensionSupport) public struct OliphauntRuntimeResources: Sendable {
    var resourceRoot: URL
    var cacheRoot: URL
    var icuResourceDirectories: [URL]?

    init(
        resourceRoot: URL,
        cacheRoot: URL = Self.defaultCacheRoot(),
        icuResourceDirectories: [URL]? = nil
    ) {
        self.resourceRoot = resourceRoot
        self.cacheRoot = cacheRoot
        self.icuResourceDirectories = icuResourceDirectories
    }

    init(bundle: Bundle, cacheRoot: URL = Self.defaultCacheRoot()) throws {
        guard let resourceURL = bundle.resourceURL else {
            throw OliphauntError.engine("bundle has no resource URL for Oliphaunt resources")
        }
        self.init(
            resourceRoot: resourceURL.appendingPathComponent("oliphaunt", isDirectory: true),
            cacheRoot: cacheRoot
        )
    }

    static func bundled(cacheRoot: URL = Self.defaultCacheRoot()) -> OliphauntRuntimeResources? {
        try? bundledResource(
            inResourceDirectories: defaultBundleResourceURLs(),
            containing: [],
            cacheRoot: cacheRoot
        )
    }

    static func bundled(
        containing requestedExtensions: [String],
        cacheRoot: URL = Self.defaultCacheRoot()
    ) throws -> OliphauntRuntimeResources? {
        try bundledResource(
            inResourceDirectories: defaultBundleResourceURLs(),
            containing: requestedExtensions,
            cacheRoot: cacheRoot
        )
    }

    static func bundledResource(
        inResourceDirectories resourceDirectories: [URL],
        containing requestedExtensions: [String] = [],
        cacheRoot: URL = Self.defaultCacheRoot()
    ) throws -> OliphauntRuntimeResources? {
        let requested = try validateExtensionIds(requestedExtensions)
        var extensionFreeBase: OliphauntRuntimeResources?
        for resourceDirectory in resourceDirectories {
            let resources = OliphauntRuntimeResources(
                resourceRoot: resourceDirectory.appendingPathComponent("oliphaunt", isDirectory: true),
                cacheRoot: cacheRoot
            )
            if try resources.hasPackagedResources(containing: requested) {
                return resources
            }
            if extensionFreeBase == nil,
               (try? resources.hasPackagedResources()) == true,
               try isExtensionFreeBaseResource(resources)
            {
                extensionFreeBase = resources
            }
        }
        if let extensionFreeBase {
            return try composedBundledResource(
                base: extensionFreeBase,
                containing: requested,
                cacheRoot: cacheRoot
            )
        }
        return nil
    }

    static func defaultCacheRoot() -> URL {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("Oliphaunt", isDirectory: true)
            .appendingPathComponent("runtime-cache", isDirectory: true)
    }

    func packageSizeReport() throws -> OliphauntRuntimeResourceSizeReport? {
        let url = resourceRoot.appendingPathComponent("package-size.tsv", isDirectory: false)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return nil
        }
        var report = try Self.parsePackageSizeReport(
            String(contentsOf: url, encoding: .utf8),
            source: url.path
        )
        if let runtime = try optionalAssetPackage(kind: .runtime) {
            report.mobileStaticRegistryState = runtime.mobileStaticRegistryState
            report.mobileStaticRegistryRegistered = runtime.mobileStaticRegistryRegistered.sorted()
            report.mobileStaticRegistryPending = runtime.mobileStaticRegistryPending.sorted()
            report.nativeModuleStems = runtime.nativeModuleStems.sorted()
            report.runtimeFeatures = runtime.runtimeFeatures.sorted()
        }
        return report
    }

    func materializeRuntime(requestedExtensions: [String] = []) throws -> URL {
        return try resolveRuntime(requestedExtensions: requestedExtensions).directory
    }

    func resolveRuntime(
        requestedExtensions: [String] = []
    ) throws -> ResolvedOliphauntRuntimeResources {
        let requested = try Self.validateExtensionIds(requestedExtensions)
        let runtime = try assetPackage(kind: .runtime)
        try require(runtime: runtime, contains: requested)
        let integratedIcu = runtime.runtimeFeatures.contains("icu")
        let externalIcu = integratedIcu ? nil : try Self.icuDataCarrier(
            inResourceDirectories: icuResourceDirectories ?? defaultBundleResourceURLs()
        )
        let profile: OliphauntNativeCatalogProfile = integratedIcu || externalIcu != nil ? .icu : .standard
        let seed = try matchingClusterSeed(
            profile: profile,
            runtime: runtime,
            icuDataTreeSha256: externalIcu?.treeSha256
        )
        let target = try materialize(runtime, seed: seed, profile: profile, externalIcu: externalIcu)
        return ResolvedOliphauntRuntimeResources(
            directory: target,
            sharedPreloadLibraries: runtime.sharedPreloadLibraries.sorted(),
            catalogProfile: profile,
            owner: self
        )
    }

    func resolveRuntime(
        at runtimeDirectory: URL,
        requestedExtensions: [String] = []
    ) throws -> ResolvedOliphauntRuntimeResources {
        let requested = try Self.validateExtensionIds(requestedExtensions)
        let runtime = try assetPackage(kind: .runtime)
        guard Self.sameFileURL(runtime.filesURL, runtimeDirectory) else {
            throw OliphauntError.engine(
                "Swift Oliphaunt runtimeDirectory \(runtimeDirectory.path) is not owned by runtime resources \(runtime.rootURL.path)"
            )
        }
        try require(runtime: runtime, contains: requested)
        let profile: OliphauntNativeCatalogProfile = runtime.runtimeFeatures.contains("icu") ? .icu : .standard
        _ = try matchingClusterSeed(profile: profile, runtime: runtime, icuDataTreeSha256: nil)
        return ResolvedOliphauntRuntimeResources(
            directory: runtimeDirectory,
            sharedPreloadLibraries: runtime.sharedPreloadLibraries.sorted(),
            catalogProfile: profile,
            owner: self
        )
    }

    func sharedPreloadLibraries(requestedExtensions: [String] = []) throws -> [String] {
        let requested = try Self.validateExtensionIds(requestedExtensions)
        let runtime = try assetPackage(kind: .runtime)
        try require(runtime: runtime, contains: requested)
        return runtime.sharedPreloadLibraries.sorted()
    }

    func sharedPreloadLibraries(
        forRuntimeDirectory runtimeDirectory: URL,
        requestedExtensions: [String] = []
    ) throws -> [String] {
        let requested = try Self.validateExtensionIds(requestedExtensions)
        let runtime = try assetPackage(kind: .runtime)
        guard Self.sameFileURL(runtime.filesURL, runtimeDirectory) else {
            throw OliphauntError.engine(
                "Swift Oliphaunt runtimeDirectory \(runtimeDirectory.path) is not the files directory for runtime resources \(runtime.rootURL.path)"
            )
        }
        try require(runtime: runtime, contains: requested)
        return runtime.sharedPreloadLibraries.sorted()
    }

    static func releaseShapedResources(
        forRuntimeDirectory runtimeDirectory: URL,
        cacheRoot: URL = Self.defaultCacheRoot()
    ) throws -> OliphauntRuntimeResources? {
        let filesURL = runtimeDirectory.standardizedFileURL
        guard filesURL.lastPathComponent == "files" else {
            return nil
        }
        let runtimeRoot = filesURL.deletingLastPathComponent()
        guard runtimeRoot.lastPathComponent == "runtime" else {
            return nil
        }
        let resourceRoot = runtimeRoot.deletingLastPathComponent()
        guard resourceRoot.lastPathComponent == "oliphaunt" else {
            return nil
        }
        let resources = OliphauntRuntimeResources(
            resourceRoot: resourceRoot,
            cacheRoot: cacheRoot
        )
        guard let runtime = try resources.optionalAssetPackage(kind: .runtime),
              Self.sameFileURL(runtime.filesURL, runtimeDirectory)
        else {
            return nil
        }
        return resources
    }

    func hasPackagedResources(containing requestedExtensions: Set<String> = []) throws -> Bool {
        guard FileManager.default.fileExists(
            atPath: resourceRoot.appendingPathComponent("runtime/manifest.properties").path
        ) || FileManager.default.fileExists(
            atPath: AssetPackageKind.clusterSeed(.standard)
                .root(in: resourceRoot)
                .appendingPathComponent("manifest.properties")
                .path
        ) else {
            return false
        }
        guard !requestedExtensions.isEmpty else {
            return true
        }
        guard let runtime = try optionalAssetPackage(kind: .runtime) else {
            return false
        }
        return requestedExtensions.isSubset(of: runtime.selectedExtensions)
    }

    @discardableResult
    func preparePgdata(
        at pgdata: URL,
        profile: OliphauntNativeCatalogProfile,
        didPublishDestination: () -> Void
    ) throws -> OliphauntPgdataPublication? {
        if FileManager.default.fileExists(
            atPath: pgdata.appendingPathComponent("PG_VERSION").path
        ) {
            try validateOliphauntCompletePgdata(pgdata)
            try ensurePgdataDirectoryLayout(at: pgdata)
            try hardenOliphauntPgdataPermissions(at: pgdata)
            return .existing
        }
        guard let seed = try optionalAssetPackage(kind: .clusterSeed(profile)) else {
            return nil
        }

        if FileManager.default.fileExists(atPath: pgdata.path) {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: pgdata.path, isDirectory: &isDirectory),
                  isDirectory.boolValue
            else {
                throw OliphauntError.engine("PGDATA path exists but is not a directory: \(pgdata.path)")
            }
            let contents = try FileManager.default.contentsOfDirectory(atPath: pgdata.path)
            if !contents.isEmpty {
                throw OliphauntError.engine("PGDATA exists without PG_VERSION and is not empty: \(pgdata.path)")
            }
        }

        let parent = pgdata.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        let temp = parent.appendingPathComponent(
            ".cluster-seed-\(seed.cacheKey)-\(UUID().uuidString)",
            isDirectory: true
        )
        let result: Result<OliphauntPgdataPublication, Error> = Result {
            try copyTree(from: seed.filesURL, to: temp)
            try ensurePgdataDirectoryLayout(at: temp)
            return try publishOliphauntPreparedPgdata(
                temp,
                to: pgdata,
                didPublishDestination: didPublishDestination
            )
        }
        return try finishOliphauntStaging(result, operation: "PGDATA preparation") {
            try removeOliphauntStagingIfPresent(temp)
        }
    }

    private func matchingClusterSeed(
        profile: OliphauntNativeCatalogProfile,
        runtime: AssetPackage,
        icuDataTreeSha256: String?
    ) throws -> AssetPackage {
        guard runtime.clusterSeedTarget == oliphauntSwiftClusterSeedTarget else {
            throw OliphauntError.engine(
                "Swift Oliphaunt runtime resources do not carry cluster seeds for \(oliphauntSwiftClusterSeedTarget)"
            )
        }
        let seed = try assetPackage(kind: .clusterSeed(profile))
        if profile == .icu {
            let selectedDigest = icuDataTreeSha256 ?? runtime.icuDataTreeSha256
            guard !selectedDigest.isEmpty, selectedDigest == seed.icuDataTreeSha256 else {
                throw OliphauntError.engine(
                    "Swift Oliphaunt ICU data does not match the \(oliphauntSwiftClusterSeedTarget) ICU cluster seed"
                )
            }
        }
        return seed
    }

    private func materialize(
        _ runtime: AssetPackage,
        seed: AssetPackage,
        profile: OliphauntNativeCatalogProfile,
        externalIcu: OliphauntIcuDataCarrier?
    ) throws -> URL {
        let digest = profile == .icu ? seed.icuDataTreeSha256 : "none"
        let target = cacheRoot
            .appendingPathComponent("runtime", isDirectory: true)
            .appendingPathComponent(runtime.cacheKey, isDirectory: true)
            .appendingPathComponent(profile.rawValue, isDirectory: true)
            .appendingPathComponent(seed.cacheKey, isDirectory: true)
            .appendingPathComponent(digest, isDirectory: true)
        let identity = [
            "runtime=\(runtime.cacheKey)",
            "target=\(oliphauntSwiftClusterSeedTarget)",
            "profile=\(profile.rawValue)",
            "seed=\(seed.cacheKey)",
            "icuDataTreeSha256=\(profile == .icu ? digest : "")",
            "",
        ].joined(separator: "\n")
        let stamp = target.appendingPathComponent(".liboliphaunt-asset-cache-key")
        if Self.hasRuntimeCacheIdentity(target: target, stamp: stamp, identity: identity) {
            return target
        }
        if FileManager.default.fileExists(atPath: target.path) {
            throw OliphauntError.engine(
                "immutable Swift Oliphaunt runtime cache has an invalid identity at \(target.path)"
            )
        }

        let parent = target.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        let temp = parent.appendingPathComponent(
            ".\(target.lastPathComponent).tmp-\(UUID().uuidString)",
            isDirectory: true
        )
        let result: Result<URL, Error> = Result {
            try copyTree(from: runtime.filesURL, to: temp)
            if let externalIcu {
                let destination = temp
                    .appendingPathComponent("share", isDirectory: true)
                    .appendingPathComponent("icu", isDirectory: true)
                if try Self.icuDataRootContainsData(destination) {
                    throw OliphauntError.engine(
                        "base Swift Oliphaunt runtime already contains ICU data while composing an external ICU carrier"
                    )
                }
                if FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.removeItem(at: destination)
                }
                try copyTree(from: externalIcu.dataURL, to: destination)
            }
            if profile == .icu {
                let data = temp.appendingPathComponent("share/icu", isDirectory: true)
                guard try Self.icuDataRootContainsData(data) else {
                    throw OliphauntError.engine(
                        "Swift Oliphaunt ICU runtime closure contains no ICU data at \(data.path)"
                    )
                }
            }
            try identity.write(
                to: temp.appendingPathComponent(".liboliphaunt-asset-cache-key"),
                atomically: true,
                encoding: .utf8
            )
            try makeOliphauntPublicationTreeDurable(temp)
            do {
                try FileManager.default.moveItem(at: temp, to: target)
            } catch let publicationError {
                if Self.hasRuntimeCacheIdentity(target: target, stamp: stamp, identity: identity) {
                    return target
                }
                throw publicationError
            }
            try syncOliphauntDirectory(parent)
            return target
        }
        return try finishOliphauntStaging(result, operation: "runtime cache publication") {
            try removeOliphauntStagingIfPresent(temp)
        }
    }

    private static func hasRuntimeCacheIdentity(
        target: URL,
        stamp: URL,
        identity: String
    ) -> Bool {
        guard let values = try? target.resourceValues(
            forKeys: [.isDirectoryKey, .isSymbolicLinkKey]
        ),
              values.isDirectory == true,
              values.isSymbolicLink != true
        else {
            return false
        }
        return (try? String(contentsOf: stamp, encoding: .utf8)) == identity
    }

    private func require(runtime: AssetPackage, contains requested: Set<String>) throws {
        let missing = requested.subtracting(runtime.selectedExtensions)
        guard missing.isEmpty else {
            let available = runtime.selectedExtensions.sorted().joined(separator: ",")
            throw OliphauntError.engine(
                "Swift Oliphaunt runtime resources \(runtime.rootURL.path) does not contain requested extension(s) \(missing.sorted().joined(separator: ",")); available extensions: \(available.isEmpty ? "<none>" : available)"
            )
        }
        try requireExtensionInstallFiles(
            runtime: runtime,
            contains: requested.intersection(runtime.extensions)
        )
        #if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
        guard requested.isEmpty || runtime.mobileStaticRegistryState != nil else {
            throw OliphauntError.engine(
                "Swift Oliphaunt runtime resources \(runtime.rootURL.path) does not declare mobileStaticRegistryState; rebuild it with the current oliphaunt runtime-resource generator"
            )
        }
        if runtime.mobileStaticRegistryState == "pending" {
            let pending = runtime.mobileStaticRegistryPending.sorted().joined(separator: ",")
            throw OliphauntError.engine(
                "Swift Oliphaunt runtime resources \(runtime.rootURL.path) is not mobile static-registry ready for selected extension(s); pending extension(s): \(pending.isEmpty ? "<unknown>" : pending)"
            )
        }
        #endif
    }

    private func requireExtensionInstallFiles(runtime: AssetPackage, contains requested: Set<String>) throws {
        guard !requested.isEmpty else {
            return
        }
        try Self.requireExtensionInstallFiles(runtime: runtime, contains: requested)
    }

    private static func requireExtensionInstallFiles(runtime: AssetPackage, contains requested: Set<String>) throws {
        let extensionDirectory = runtime.filesURL
            .appendingPathComponent("share", isDirectory: true)
            .appendingPathComponent("postgresql", isDirectory: true)
            .appendingPathComponent("extension", isDirectory: true)
        for extensionName in requested.sorted() {
            let control = extensionDirectory
                .appendingPathComponent("\(extensionName).control", isDirectory: false)
            guard FileManager.default.fileExists(atPath: control.path) else {
                throw OliphauntError.engine(
                    "Swift Oliphaunt runtime resources \(runtime.rootURL.path) declare extension \(extensionName) but are missing \(extensionName).control"
                )
            }
            let prefix = "\(extensionName)--"
            let installScripts = try FileManager.default.contentsOfDirectory(
                at: extensionDirectory,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            ).filter { url in
                url.lastPathComponent.hasPrefix(prefix) && url.pathExtension == "sql"
            }
            guard !installScripts.isEmpty else {
                throw OliphauntError.engine(
                    "Swift Oliphaunt runtime resources \(runtime.rootURL.path) declare extension \(extensionName) but are missing \(extensionName)--*.sql"
                )
            }
        }
    }

    private static func sameFileURL(_ left: URL, _ right: URL) -> Bool {
        left.standardizedFileURL.resolvingSymlinksInPath().path ==
            right.standardizedFileURL.resolvingSymlinksInPath().path
    }

    private func assetPackage(kind: AssetPackageKind) throws -> AssetPackage {
        guard let package = try optionalAssetPackage(kind: kind) else {
            throw OliphauntError.engine("missing packaged liboliphaunt \(kind.label) resources at \(kind.root(in: resourceRoot).path)")
        }
        return package
    }

    private func optionalAssetPackage(kind: AssetPackageKind) throws -> AssetPackage? {
        if case .runtime = kind {
            try validateRuntimeCarrierReceipt()
        }
        let rootURL = kind.root(in: resourceRoot)
        let manifestURL = rootURL.appendingPathComponent("manifest.properties")
        guard FileManager.default.fileExists(atPath: manifestURL.path) else {
            return nil
        }
        let manifest = try readManifest(manifestURL)
        let isRuntime: Bool
        switch kind {
        case .runtime: isRuntime = true
        case .clusterSeed: isRuntime = false
        }
        let manifestKeys = Set(manifest.keys)
        let allowedManifestKeys: Set<String>
        switch kind {
        case .runtime:
            allowedManifestKeys = [
                "schema", "layout", "artifactRole", "catalogProfile", "clusterSeedTarget",
                "icuDataTreeSha256", "mode", "cacheKey", "selectedExtensions", "extensions",
                "runtimeFeatures", "sharedPreloadLibraries", "mobileStaticRegistryState",
                "mobileStaticRegistryRegistered", "mobileStaticRegistryPending",
                "nativeModuleStems", "mobileStaticRegistrySource",
            ]
        case .clusterSeed:
            allowedManifestKeys = [
                "schema", "layout", "artifactRole", "catalogProfile", "postgresMajor",
                "physicalFormat", "target", "compatibilityKey", "initialSuperuser",
                "runtimeFeatures", "icuDataVersion", "icuDataForm", "icuDataTreeSha256",
                "cacheKey",
            ]
        }
        let unsupported = manifestKeys.subtracting(allowedManifestKeys)
        let missing = allowedManifestKeys.subtracting(manifestKeys)
        guard manifestKeys == allowedManifestKeys else {
            throw OliphauntError.engine(
                "liboliphaunt \(kind.label) manifest does not contain its exact canonical field set; missing=\(missing.sorted().joined(separator: ",")); unsupported=\(unsupported.sorted().joined(separator: ","))"
            )
        }
        let schema = manifest["schema"] ?? ""
        guard schema == oliphauntRuntimeResourcesSchema else {
            throw OliphauntError.engine(
                "liboliphaunt \(kind.label) manifest has unsupported runtime resource schema '\(schema.isEmpty ? "<missing>" : schema)'; expected \(oliphauntRuntimeResourcesSchema)"
            )
        }
        let layout = manifest["layout"] ?? ""
        guard layout == kind.expectedLayout else {
            throw OliphauntError.engine(
                "liboliphaunt \(kind.label) manifest has unsupported layout '\(layout.isEmpty ? "<missing>" : layout)'; expected \(kind.expectedLayout)"
            )
        }
        let cacheKey = manifest["cacheKey"] ?? ""
        guard Self.isPortableId(cacheKey), cacheKey != ".", cacheKey != ".." else {
            throw OliphauntError.engine("liboliphaunt \(kind.label) manifest has invalid cacheKey '\(cacheKey)'")
        }
        if isRuntime, manifest["mode"] != "native-direct" {
            throw OliphauntError.engine("liboliphaunt runtime manifest must declare mode=native-direct")
        }
        let extensions: Set<String>
        let selectedExtensions: Set<String>
        if isRuntime {
            extensions = try Self.validateExtensionIds(
                manifest["extensions"]?.split(separator: ",").map(String.init) ?? []
            )
            guard let selectedExtensionsValue = manifest["selectedExtensions"] else {
                throw OliphauntError.engine(
                    "liboliphaunt runtime manifest is missing selectedExtensions"
                )
            }
            selectedExtensions = try Self.validateExtensionIds(
                selectedExtensionsValue.split(separator: ",").map(String.init)
            )
        } else {
            extensions = []
            selectedExtensions = []
        }
        guard extensions.isSubset(of: selectedExtensions) else {
            let unselected = extensions.subtracting(selectedExtensions).sorted()
            throw OliphauntError.engine(
                "liboliphaunt \(kind.label) manifest extensions must be a subset of selectedExtensions; unselected extension(s): \(unselected.joined(separator: ","))"
            )
        }
        let runtimeFeatures = try Self.validateRuntimeFeatures(
            manifest["runtimeFeatures"]?.split(separator: ",").map(String.init) ?? []
        )
        let clusterSeedTarget = manifest["clusterSeedTarget"] ?? ""
        let icuDataTreeSha256 = manifest["icuDataTreeSha256"] ?? ""
        let artifactRole = manifest["artifactRole"] ?? ""
        let catalogProfile = manifest["catalogProfile"] ?? ""
        switch kind {
        case .runtime:
            guard artifactRole == "runtime",
                  catalogProfile.isEmpty,
                  clusterSeedTarget == oliphauntSwiftClusterSeedTarget
            else {
                throw OliphauntError.engine(
                    "liboliphaunt runtime manifest must declare artifactRole=runtime, an empty catalogProfile, and cluster seeds for \(oliphauntSwiftClusterSeedTarget)"
                )
            }
            if runtimeFeatures.contains("icu") {
                guard Self.isSha256(icuDataTreeSha256) else {
                    throw OliphauntError.engine(
                        "liboliphaunt ICU runtime manifest does not bind the canonical ICU data tree"
                    )
                }
            } else if !icuDataTreeSha256.isEmpty {
                throw OliphauntError.engine(
                    "liboliphaunt standard runtime manifest must not select ICU data"
                )
            }
        case .clusterSeed(let profile):
            let expectedProfile = profile.rawValue
            let expectedRole = "cluster-seed-\(expectedProfile)"
            let expectedRuntimeFeatures: Set<String> = profile == .icu ? ["icu"] : []
            guard runtimeFeatures == expectedRuntimeFeatures,
                  artifactRole == expectedRole,
                  catalogProfile == expectedProfile,
                  manifest["target"] == oliphauntSwiftClusterSeedTarget,
                  manifest["postgresMajor"] == "18",
                  manifest["physicalFormat"] == "native-pg18-v1",
                  manifest["compatibilityKey"] == oliphauntSwiftClusterSeedCompatibilityKey,
                  manifest["initialSuperuser"] == "postgres"
            else {
                throw OliphauntError.engine(
                    "liboliphaunt cluster-seed manifest has an incompatible native catalog contract"
                )
            }
            if expectedProfile == "icu" {
                guard manifest["icuDataVersion"] == "76.1",
                      manifest["icuDataForm"] == "files-le",
                      Self.isSha256(icuDataTreeSha256)
                else {
                    throw OliphauntError.engine(
                        "liboliphaunt ICU cluster-seed manifest does not bind the canonical ICU data tree"
                    )
                }
            } else if !(manifest["icuDataVersion"] ?? "").isEmpty
                        || !(manifest["icuDataForm"] ?? "").isEmpty
                        || !icuDataTreeSha256.isEmpty
            {
                throw OliphauntError.engine(
                    "liboliphaunt standard cluster-seed manifest must not select ICU data"
                )
            }
        }
        let mobileStaticRegistryState: String?
        let mobileStaticRegistryPending: Set<String>
        let mobileStaticRegistryRegistered: Set<String>
        let nativeModuleStems: Set<String>
        if isRuntime {
            mobileStaticRegistryState = try Self.validateMobileStaticRegistryState(
                manifest["mobileStaticRegistryState"]
            )
            let registrySource = manifest["mobileStaticRegistrySource"] ?? ""
            let sourceIsValid = mobileStaticRegistryState == "complete"
                ? [
                    "static-registry/oliphaunt_static_registry.c",
                    "swiftpm-linked-products",
                ].contains(registrySource)
                : registrySource.isEmpty
            guard sourceIsValid else {
                throw OliphauntError.engine(
                    "liboliphaunt runtime manifest has mobileStaticRegistrySource inconsistent with mobileStaticRegistryState"
                )
            }
            mobileStaticRegistryPending = try Self.validatePortableIds(
                manifest["mobileStaticRegistryPending"]?.split(separator: ",").map(String.init) ?? [],
                label: "mobile static registry extension"
            )
            mobileStaticRegistryRegistered = try Self.validatePortableIds(
                manifest["mobileStaticRegistryRegistered"]?.split(separator: ",").map(String.init) ?? [],
                label: "mobile static registry extension"
            )
            nativeModuleStems = try Self.validatePortableIds(
                manifest["nativeModuleStems"]?.split(separator: ",").map(String.init) ?? [],
                label: "native module stem"
            )
            try Self.validateMobileStaticRegistryManifest(
                state: mobileStaticRegistryState,
                registered: mobileStaticRegistryRegistered,
                pending: mobileStaticRegistryPending,
                nativeModuleStems: nativeModuleStems,
                selectedExtensions: selectedExtensions
            )
        } else {
            mobileStaticRegistryState = nil
            mobileStaticRegistryPending = []
            mobileStaticRegistryRegistered = []
            nativeModuleStems = []
        }
        let sharedPreloadLibraries = try Self.validatePortableIds(
            manifest["sharedPreloadLibraries"]?.split(separator: ",").map(String.init) ?? [],
            label: "shared preload library"
        )
        let filesURL = rootURL.appendingPathComponent("files", isDirectory: true)
        guard FileManager.default.fileExists(atPath: filesURL.path) else {
            throw OliphauntError.engine("liboliphaunt \(kind.label) package is missing files directory at \(filesURL.path)")
        }
        if case .clusterSeed = kind {
            for relative in ["PG_VERSION", "global/pg_control"] {
                guard FileManager.default.fileExists(
                    atPath: filesURL.appendingPathComponent(relative).path
                ) else {
                    throw OliphauntError.engine(
                        "liboliphaunt \(kind.label) package is missing \(relative)"
                    )
                }
            }
        }
        return AssetPackage(
            rootURL: rootURL,
            filesURL: filesURL,
            cacheKey: cacheKey,
            selectedExtensions: selectedExtensions,
            extensions: extensions,
            runtimeFeatures: runtimeFeatures,
            sharedPreloadLibraries: sharedPreloadLibraries,
            mobileStaticRegistryState: mobileStaticRegistryState,
            mobileStaticRegistryRegistered: mobileStaticRegistryRegistered,
            mobileStaticRegistryPending: mobileStaticRegistryPending,
            nativeModuleStems: nativeModuleStems,
            clusterSeedTarget: clusterSeedTarget,
            icuDataTreeSha256: icuDataTreeSha256
        )
    }

    private func validateRuntimeCarrierReceipt() throws {
        let url = resourceRoot.appendingPathComponent("manifest.properties")
        let values = try readManifest(url)
        let expectedKeys: Set<String> = [
            "schema", "clusterSeedTarget", "clusterSeedRelativePath",
            "icuClusterSeedRelativePath",
        ]
        guard Set(values.keys) == expectedKeys,
              values["schema"] == "oliphaunt-native-runtime-carrier-v1",
              values["clusterSeedTarget"] == oliphauntSwiftClusterSeedTarget,
              values["clusterSeedRelativePath"] == "cluster-seed",
              values["icuClusterSeedRelativePath"] == "cluster-seed-icu"
        else {
            throw OliphauntError.engine(
                "liboliphaunt runtime carrier does not contain the exact \(oliphauntSwiftClusterSeedTarget) seed receipt"
            )
        }
        _ = try assetPackage(kind: .clusterSeed(.standard))
        _ = try assetPackage(kind: .clusterSeed(.icu))
    }

    private func readManifest(_ url: URL) throws -> [String: String] {
        let text = try String(contentsOf: url, encoding: .utf8)
        var values: [String: String] = [:]
        for rawLine in text.split(whereSeparator: { $0.isNewline }) {
            let line = String(rawLine)
            guard let separator = line.firstIndex(of: "=") else {
                throw OliphauntError.engine(
                    "malformed liboliphaunt resource manifest at \(url.path)"
                )
            }
            let key = String(line[..<separator])
            let value = String(line[line.index(after: separator)...])
            guard !key.isEmpty, values.updateValue(value, forKey: key) == nil else {
                throw OliphauntError.engine(
                    "invalid or duplicate property in liboliphaunt resource manifest at \(url.path)"
                )
            }
        }
        guard !values.isEmpty else {
            throw OliphauntError.engine("empty liboliphaunt resource manifest at \(url.path)")
        }
        return values
    }

    static func parsePackageSizeReport(
        _ text: String,
        source: String
    ) throws -> OliphauntRuntimeResourceSizeReport {
        var packageBytes: UInt64?
        var runtimeBytes: UInt64?
        var clusterSeedBytes: UInt64?
        var icuClusterSeedBytes: UInt64?
        var staticRegistryBytes: UInt64?
        var selectedExtensionBytes: UInt64?
        var extensionReports: [OliphauntExtensionSizeReport] = []
        var seenExtensionIds = Set<String>()

        let lines = text.split(whereSeparator: \.isNewline).map(String.init)
        guard lines.first == "kind\tid\textensions\tfiles\tbytes" else {
            throw OliphauntError.engine(
                "Oliphaunt package size report \(source) has unsupported header"
            )
        }
        for (index, line) in lines.dropFirst().enumerated() where !line.isEmpty {
            let columns = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard columns.count == 5 else {
                throw OliphauntError.engine(
                    "Oliphaunt package size report \(source) line \(index + 2) must have 5 tab-separated columns"
                )
            }
            let bytes = try Self.parseSizeReportUInt64(
                columns[4],
                source: source,
                line: index + 2,
                field: "bytes"
            )
            switch (columns[0], columns[1]) {
            case ("package", "total"):
                try Self.setSizeReportValue(
                    &packageBytes,
                    bytes,
                    row: "package/total",
                    source: source,
                    line: index + 2
                )
            case ("package", "runtime"):
                try Self.setSizeReportValue(
                    &runtimeBytes,
                    bytes,
                    row: "package/runtime",
                    source: source,
                    line: index + 2
                )
            case ("package", "cluster-seed"):
                try Self.setSizeReportValue(
                    &clusterSeedBytes,
                    bytes,
                    row: "package/cluster-seed",
                    source: source,
                    line: index + 2
                )
            case ("package", "cluster-seed-icu"):
                try Self.setSizeReportValue(
                    &icuClusterSeedBytes,
                    bytes,
                    row: "package/cluster-seed-icu",
                    source: source,
                    line: index + 2
                )
            case ("package", "static-registry"):
                try Self.setSizeReportValue(
                    &staticRegistryBytes,
                    bytes,
                    row: "package/static-registry",
                    source: source,
                    line: index + 2
                )
            case ("extensions", "selected"):
                try Self.setSizeReportValue(
                    &selectedExtensionBytes,
                    bytes,
                    row: "extensions/selected",
                    source: source,
                    line: index + 2
                )
            case ("extension", let id):
                guard Self.isPortableId(id) else {
                    throw OliphauntError.engine(
                        "Oliphaunt package size report \(source) line \(index + 2) has invalid extension id '\(id)'"
                    )
                }
                guard seenExtensionIds.insert(id).inserted else {
                    throw OliphauntError.engine(
                        "Oliphaunt package size report \(source) line \(index + 2) repeats extension row '\(id)'"
                    )
                }
                guard columns[2] == "-" else {
                    throw OliphauntError.engine(
                        "Oliphaunt package size report \(source) line \(index + 2) extension rows must use '-' in the extensions column"
                    )
                }
                let fileCount = try Self.parseSizeReportInt(
                    columns[3],
                    source: source,
                    line: index + 2,
                    field: "files"
                )
                extensionReports.append(OliphauntExtensionSizeReport(
                    name: id,
                    fileCount: fileCount,
                    bytes: bytes
                ))
            default:
                throw OliphauntError.engine(
                    "Oliphaunt package size report \(source) line \(index + 2) has unknown row \(columns[0])/\(columns[1])"
                )
            }
        }

        let standardSeedBytes = try Self.requireSizeReportValue(
            clusterSeedBytes,
            "package/cluster-seed",
            source
        )
        let icuSeedBytes = try Self.requireSizeReportValue(
            icuClusterSeedBytes,
            "package/cluster-seed-icu",
            source
        )
        let (allSeedBytes, overflow) = standardSeedBytes.addingReportingOverflow(icuSeedBytes)
        guard !overflow else {
            throw OliphauntError.engine(
                "Oliphaunt package size report \(source) cluster-seed bytes overflow UInt64"
            )
        }
        return OliphauntRuntimeResourceSizeReport(
            packageBytes: try Self.requireSizeReportValue(packageBytes, "package/total", source),
            runtimeBytes: try Self.requireSizeReportValue(runtimeBytes, "package/runtime", source),
            clusterSeedBytes: allSeedBytes,
            staticRegistryBytes: try Self.requireSizeReportValue(
                staticRegistryBytes,
                "package/static-registry",
                source
            ),
            selectedExtensionBytes: try Self.requireSizeReportValue(
                selectedExtensionBytes,
                "extensions/selected",
                source
            ),
            extensions: extensionReports.sorted { $0.name < $1.name }
        )
    }

    private static func setSizeReportValue(
        _ target: inout UInt64?,
        _ value: UInt64,
        row: String,
        source: String,
        line: Int
    ) throws {
        guard target == nil else {
            throw OliphauntError.engine(
                "Oliphaunt package size report \(source) line \(line) repeats required row \(row)"
            )
        }
        target = value
    }

    private static func requireSizeReportValue(
        _ value: UInt64?,
        _ row: String,
        _ source: String
    ) throws -> UInt64 {
        guard let value else {
            throw OliphauntError.engine(
                "Oliphaunt package size report \(source) is missing required row \(row)"
            )
        }
        return value
    }

    private static func parseSizeReportUInt64(
        _ value: String,
        source: String,
        line: Int,
        field: String
    ) throws -> UInt64 {
        guard let parsed = UInt64(value) else {
            throw OliphauntError.engine(
                "Oliphaunt package size report \(source) line \(line) has invalid \(field) value '\(value)'"
            )
        }
        return parsed
    }

    private static func parseSizeReportInt(
        _ value: String,
        source: String,
        line: Int,
        field: String
    ) throws -> Int {
        guard let parsed = Int(value), parsed >= 0 else {
            throw OliphauntError.engine(
                "Oliphaunt package size report \(source) line \(line) has invalid \(field) value '\(value)'"
            )
        }
        return parsed
    }

    static func validateExtensionIds(_ values: [String]) throws -> Set<String> {
        Set(try normalizedExtensionIds(values))
    }

    static func validateRuntimeFeatures(_ values: [String]) throws -> Set<String> {
        let features = try validatePortableIds(values, label: "runtime feature")
        let unsupported = features.subtracting(["icu"])
        guard unsupported.isEmpty else {
            throw OliphauntError.engine(
                "Swift Oliphaunt runtime feature(s) \(unsupported.sorted().joined(separator: ",")) are not supported by this SDK"
            )
        }
        return features
    }

    static func normalizedExtensionIds(_ values: [String]) throws -> [String] {
        try normalizedPortableIds(values, label: "extension id")
    }

    static func validatePortableIds(_ values: [String], label: String) throws -> Set<String> {
        Set(try normalizedPortableIds(values, label: label))
    }

    static func normalizedPortableIds(_ values: [String], label: String) throws -> [String] {
        var validated: [String] = []
        for value in values.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }) where !value.isEmpty {
            guard isPortableId(value) else {
                throw OliphauntError.engine(
                    "Swift Oliphaunt \(label) '\(value)' must contain only ASCII letters, digits, '.', '_' or '-'"
                )
            }
            validated.append(value)
        }
        return validated
    }

    private static func validateMobileStaticRegistryState(_ state: String?) throws -> String? {
        guard let state, !state.isEmpty else {
            return nil
        }
        guard state == "not-required" || state == "complete" || state == "pending" else {
            throw OliphauntError.engine(
                "Swift Oliphaunt mobileStaticRegistryState '\(state)' must be one of not-required, complete, or pending"
            )
        }
        return state
    }

    private static func validateMobileStaticRegistryManifest(
        state: String?,
        registered: Set<String>,
        pending: Set<String>,
        nativeModuleStems: Set<String>,
        selectedExtensions: Set<String>
    ) throws {
        guard let state else {
            throw OliphauntError.engine(
                "Swift Oliphaunt mobile static-registry manifest omits mobileStaticRegistryState"
            )
        }
        guard registered.isDisjoint(with: pending) else {
            throw OliphauntError.engine(
                "Swift Oliphaunt mobile static-registry manifest lists the same extension as registered and pending"
            )
        }
        let unselectedNativeExtensions = registered
            .union(pending)
            .subtracting(selectedExtensions)
        guard unselectedNativeExtensions.isEmpty else {
            throw OliphauntError.engine(
                "Swift Oliphaunt mobile static-registry manifest lists extension(s) outside selectedExtensions: \(unselectedNativeExtensions.sorted().joined(separator: ","))"
            )
        }
        switch state {
        case "not-required":
            guard registered.isEmpty, pending.isEmpty, nativeModuleStems.isEmpty else {
                throw OliphauntError.engine(
                    "Swift Oliphaunt mobileStaticRegistryState=not-required must not list registered, pending, or native module stems"
                )
            }
        case "pending":
            guard !pending.isEmpty else {
                throw OliphauntError.engine(
                    "Swift Oliphaunt mobileStaticRegistryState=pending must list mobileStaticRegistryPending"
                )
            }
        case "complete":
            guard pending.isEmpty else {
                throw OliphauntError.engine(
                    "Swift Oliphaunt mobileStaticRegistryState=complete must not list mobileStaticRegistryPending"
                )
            }
            guard !registered.isEmpty, !nativeModuleStems.isEmpty else {
                throw OliphauntError.engine(
                    "Swift Oliphaunt mobileStaticRegistryState=complete must list mobileStaticRegistryRegistered and nativeModuleStems"
                )
            }
        default:
            return
        }
    }

    static func isPortableId(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard !bytes.isEmpty, bytes.count <= 128 else {
            return false
        }
        return bytes.allSatisfy { byte in
            (byte >= 65 && byte <= 90) ||
                (byte >= 97 && byte <= 122) ||
                (byte >= 48 && byte <= 57) ||
                byte == 45 ||
                byte == 46 ||
                byte == 95
        }
    }

    private static func isSha256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (97...102).contains(byte)
        }
    }

    private static func icuDataCarrier(
        inResourceDirectories resourceDirectories: [URL]
    ) throws -> OliphauntIcuDataCarrier? {
        var carriers: [OliphauntIcuDataCarrier] = []
        var seen = Set<String>()
        for resourceDirectory in resourceDirectories {
            var roots = [resourceDirectory.appendingPathComponent("oliphaunt-icu", isDirectory: true)]
            if isGeneratedIcuBundleResourceURL(resourceDirectory) {
                roots.append(resourceDirectory)
            }
            for root in roots {
                let key = root.standardizedFileURL.path
                guard seen.insert(key).inserted else { continue }
                let manifestURL = root.appendingPathComponent("manifest.properties", isDirectory: false)
                guard FileManager.default.fileExists(atPath: manifestURL.path) else { continue }
                let values = try readIcuDataManifest(manifestURL)
                let dataURL = root.appendingPathComponent("share/icu", isDirectory: true)
                guard try icuDataRootContainsData(dataURL) else {
                    throw OliphauntError.engine(
                        "Oliphaunt ICU data carrier contains no ICU data at \(dataURL.path)"
                    )
                }
                carriers.append(
                    OliphauntIcuDataCarrier(
                        dataURL: dataURL,
                        treeSha256: values["icuDataTreeSha256"]!
                    )
                )
            }
        }
        guard let selected = carriers.first else { return nil }
        let mismatched = carriers.first { $0.treeSha256 != selected.treeSha256 }
        guard mismatched == nil else {
            throw OliphauntError.engine(
                "multiple generated Oliphaunt ICU data carriers expose different logical tree digests"
            )
        }
        return selected
    }

    private static func readIcuDataManifest(_ url: URL) throws -> [String: String] {
        let text = try String(contentsOf: url, encoding: .utf8)
        var values: [String: String] = [:]
        for rawLine in text.split(whereSeparator: { $0.isNewline }) {
            let line = String(rawLine)
            guard let separator = line.firstIndex(of: "=") else {
                throw OliphauntError.engine("malformed Oliphaunt ICU data manifest at \(url.path)")
            }
            let key = String(line[..<separator])
            let value = String(line[line.index(after: separator)...])
            guard !key.isEmpty, values.updateValue(value, forKey: key) == nil else {
                throw OliphauntError.engine("invalid Oliphaunt ICU data manifest at \(url.path)")
            }
        }
        let expectedKeys: Set<String> = [
            "schema", "artifactRole", "icuDataVersion", "icuDataForm", "icuDataTreeSha256",
        ]
        guard Set(values.keys) == expectedKeys,
              values["schema"] == oliphauntIcuDataSchema,
              values["artifactRole"] == "icu-data",
              values["icuDataVersion"] == "76.1",
              values["icuDataForm"] == "files-le",
              isSha256(values["icuDataTreeSha256"] ?? "")
        else {
            throw OliphauntError.engine(
                "Oliphaunt ICU data manifest at \(url.path) does not declare the canonical data contract"
            )
        }
        return values
    }

    private static func isGeneratedIcuBundleResourceURL(_ url: URL) -> Bool {
        var candidate = url.standardizedFileURL
        for _ in 0..<4 {
            let name = candidate.lastPathComponent
            if name == "OliphauntICU.bundle" || name.hasSuffix("_OliphauntICU.bundle") {
                return true
            }
            let parent = candidate.deletingLastPathComponent()
            if parent.path == candidate.path { break }
            candidate = parent
        }
        return false
    }

    private static func icuDataRootContainsData(_ root: URL) throws -> Bool {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else {
            return false
        }
        let children = try FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey],
            options: []
        )
        for child in children {
            let name = child.lastPathComponent
            let values = try child.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey])
            if values.isRegularFile == true, name.hasPrefix("icudt"), name.hasSuffix(".dat") {
                return true
            }
            if values.isDirectory == true, name.hasPrefix("icudt") {
                return true
            }
        }
        return false
    }
}

private func defaultBundleResourceURLs() -> [URL] {
    let preferred = Bundle(identifier: "dev.oliphaunt.liboliphaunt").map { [$0] } ?? []
    #if os(iOS) || os(macOS) || os(tvOS) || os(watchOS) || os(visionOS)
    let bundles = preferred + Bundle.allFrameworks + Bundle.allBundles + [Bundle.main]
    #else
    // Corelibs Foundation has crashed while bridging Bundle.allFrameworks on
    // Linux. Apple bundle discovery is the production path; non-Apple package
    // checks need only explicitly identified resources and Bundle.main.
    let bundles = preferred + [Bundle.main]
    #endif
    return bundleResourceURLs(
        bundles,
        discoveringChildBundlesAt: Bundle.main.resourceURL
    )
}

func bundleResourceURLs(
    _ bundles: [Bundle],
    discoveringChildBundlesAt resourceRoot: URL?
) -> [URL] {
    var discovered = bundles
    #if os(iOS) || os(macOS) || os(tvOS) || os(watchOS) || os(visionOS)
    // CocoaPods resource bundles are copied beside the app executable but are
    // not guaranteed to appear in Bundle.allBundles until explicitly loaded.
    // Discover immediate child bundles so app-owned runtime payloads are
    // visible before the first database open.
    if let resourceRoot,
       let children = try? FileManager.default.contentsOfDirectory(
           at: resourceRoot,
           includingPropertiesForKeys: [.isDirectoryKey],
           options: [.skipsHiddenFiles]
       )
    {
        discovered.append(contentsOf: children.compactMap { child in
            guard child.pathExtension == "bundle" else { return nil }
            return Bundle(url: child)
        })
    }
    #endif
    var seen = Set<String>()
    var urls: [URL] = []
    for bundle in discovered {
        guard let url = bundle.resourceURL else {
            continue
        }
        let key = url.standardizedFileURL.path
        if seen.insert(key).inserted {
            urls.append(url)
        }
    }
    return urls
}

private enum AssetPackageKind {
    case runtime
    case clusterSeed(OliphauntNativeCatalogProfile)

    var label: String {
        switch self {
        case .runtime:
            return "runtime"
        case .clusterSeed(let profile):
            return "\(profile.rawValue) cluster seed"
        }
    }

    var expectedLayout: String {
        switch self {
        case .runtime:
            return oliphauntRuntimePackageLayout
        case .clusterSeed:
            return oliphauntClusterSeedPackageLayout
        }
    }

    func root(in resourceRoot: URL) -> URL {
        switch self {
        case .runtime:
            return resourceRoot.appendingPathComponent("runtime", isDirectory: true)
        case .clusterSeed(let profile):
            let name = profile == .standard ? "cluster-seed" : "cluster-seed-icu"
            return resourceRoot.appendingPathComponent(name, isDirectory: true)
        }
    }
}

private struct AssetPackage {
    var rootURL: URL
    var filesURL: URL
    var cacheKey: String
    var selectedExtensions: Set<String>
    var extensions: Set<String>
    var runtimeFeatures: Set<String>
    var sharedPreloadLibraries: Set<String>
    var mobileStaticRegistryState: String?
    var mobileStaticRegistryRegistered: Set<String>
    var mobileStaticRegistryPending: Set<String>
    var nativeModuleStems: Set<String>
    var clusterSeedTarget: String
    var icuDataTreeSha256: String
}

private func copyTree(from source: URL, to destination: URL) throws {
    let values = try source.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    if values.isSymbolicLink == true {
        throw OliphauntError.engine("refusing to copy symbolic link in Oliphaunt resources: \(source.path)")
    }
    if values.isDirectory == true {
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let children = try FileManager.default.contentsOfDirectory(
            at: source,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
            options: []
        )
        for child in children {
            try copyTree(from: child, to: destination.appendingPathComponent(child.lastPathComponent))
        }
    } else {
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.copyItem(at: source, to: destination)
    }
}

private func ensurePgdataDirectoryLayout(at pgdata: URL) throws {
    let requiredDirectories = [
        "base",
        "global",
        "pg_commit_ts",
        "pg_dynshmem",
        "pg_logical",
        "pg_logical/mappings",
        "pg_logical/snapshots",
        "pg_multixact",
        "pg_multixact/members",
        "pg_multixact/offsets",
        "pg_notify",
        "pg_replslot",
        "pg_serial",
        "pg_snapshots",
        "pg_stat",
        "pg_stat_tmp",
        "pg_subtrans",
        "pg_tblspc",
        "pg_twophase",
        "pg_wal",
        "pg_wal/archive_status",
        "pg_wal/summaries",
        "pg_xact",
    ]
    for relativePath in requiredDirectories {
        try FileManager.default.createDirectory(
            at: pgdata.appendingPathComponent(relativePath, isDirectory: true),
            withIntermediateDirectories: true
        )
    }
}
