import Foundation

private let oliphauntRuntimeResourcesSchema = "oliphaunt-runtime-resources-v1"
private let oliphauntRuntimePackageLayout = "postgres-runtime-files-v1"
private let oliphauntTemplatePgdataPackageLayout = "postgres-template-pgdata-v1"

public struct OliphauntRuntimeResourceSizeReport: Equatable, Sendable {
    public var packageBytes: UInt64
    public var runtimeBytes: UInt64
    public var templatePgdataBytes: UInt64
    public var staticRegistryBytes: UInt64
    public var selectedExtensionBytes: UInt64
    public var extensions: [OliphauntExtensionSizeReport]
    public var runtimeFeatures: [String]
    public var mobileStaticRegistryState: String?
    public var mobileStaticRegistryRegistered: [String]
    public var mobileStaticRegistryPending: [String]
    public var nativeModuleStems: [String]

    public init(
        packageBytes: UInt64,
        runtimeBytes: UInt64,
        templatePgdataBytes: UInt64,
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
        self.templatePgdataBytes = templatePgdataBytes
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

public struct OliphauntExtensionSizeReport: Equatable, Sendable {
    public var name: String
    public var fileCount: Int
    public var bytes: UInt64

    public init(name: String, fileCount: Int, bytes: UInt64) {
        self.name = name
        self.fileCount = fileCount
        self.bytes = bytes
    }
}

public struct OliphauntExtensionReleaseAsset: Equatable, Sendable {
    public var family: String
    public var target: String
    public var kind: String
    public var name: String

    public init(family: String, target: String, kind: String, name: String) {
        self.family = family
        self.target = target
        self.kind = kind
        self.name = name
    }
}

public struct OliphauntResolvedExtensionAsset: Equatable, Sendable {
    public var sqlName: String
    public var product: String
    public var version: String
    public var asset: OliphauntExtensionReleaseAsset

    public init(
        sqlName: String,
        product: String,
        version: String,
        asset: OliphauntExtensionReleaseAsset
    ) {
        self.sqlName = sqlName
        self.product = product
        self.version = version
        self.asset = asset
    }
}

public struct OliphauntExtensionArtifactResolution: Equatable, Sendable {
    public var requestedExtensions: [String]
    public var resolvedExtensions: [String]
    public var assets: [OliphauntResolvedExtensionAsset]

    public init(
        requestedExtensions: [String],
        resolvedExtensions: [String],
        assets: [OliphauntResolvedExtensionAsset]
    ) {
        self.requestedExtensions = requestedExtensions
        self.resolvedExtensions = resolvedExtensions
        self.assets = assets
    }
}

public struct OliphauntExtensionArtifactResolver: Sendable {
    public var manifests: [OliphauntExtensionReleaseManifest]

    public init(manifests: [OliphauntExtensionReleaseManifest]) {
        self.manifests = manifests
    }

    public func resolveNativeArtifacts(
        requestedExtensions: [String],
        target: String
    ) throws -> OliphauntExtensionArtifactResolution {
        try Self.resolveNativeArtifacts(
            requestedExtensions: requestedExtensions,
            manifests: manifests,
            target: target
        )
    }

    public static func resolveNativeArtifacts(
        requestedExtensions: [String],
        manifests: [OliphauntExtensionReleaseManifest],
        target: String
    ) throws -> OliphauntExtensionArtifactResolution {
        let requested = try OliphauntRuntimeResources.normalizedExtensionIds(requestedExtensions)
        let target = try validateTarget(target)
        let kind = try nativeArtifactKind(for: target)
        var bySqlName: [String: OliphauntExtensionReleaseManifest] = [:]
        for manifest in manifests {
            if let existing = bySqlName[manifest.sqlName] {
                throw OliphauntError.engine(
                    "Swift Oliphaunt extension manifests contain duplicate sqlName \(manifest.sqlName): \(existing.product) and \(manifest.product)"
                )
            }
            bySqlName[manifest.sqlName] = manifest
        }

        var visiting = Set<String>()
        var visited = Set<String>()
        var ordered: [OliphauntExtensionReleaseManifest] = []

        func visit(_ sqlName: String, requiredBy: String?) throws {
            if visited.contains(sqlName) {
                return
            }
            guard visiting.insert(sqlName).inserted else {
                throw OliphauntError.engine(
                    "Swift Oliphaunt extension dependency cycle includes \(sqlName)"
                )
            }
            guard let manifest = bySqlName[sqlName] else {
                if let requiredBy {
                    throw OliphauntError.engine(
                        "Swift Oliphaunt extension \(requiredBy) requires missing dependency \(sqlName)"
                    )
                }
                throw OliphauntError.engine(
                    "Swift Oliphaunt requested extension \(sqlName) has no release manifest"
                )
            }
            for dependency in manifest.dependencies {
                try visit(dependency, requiredBy: manifest.sqlName)
            }
            visiting.remove(sqlName)
            visited.insert(sqlName)
            ordered.append(manifest)
        }

        for sqlName in requested {
            try visit(sqlName, requiredBy: nil)
        }

        var resolvedAssets: [OliphauntResolvedExtensionAsset] = []
        for manifest in ordered {
            try validateReadiness(manifest, target: target)
            resolvedAssets.append(OliphauntResolvedExtensionAsset(
                sqlName: manifest.sqlName,
                product: manifest.product,
                version: manifest.version,
                asset: try manifest.requiredAsset(
                    family: "native",
                    target: target,
                    kind: kind
                )
            ))
        }

        return OliphauntExtensionArtifactResolution(
            requestedExtensions: requested,
            resolvedExtensions: ordered.map(\.sqlName),
            assets: resolvedAssets
        )
    }

    private static func validateTarget(_ target: String) throws -> String {
        let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard OliphauntRuntimeResources.isPortableId(trimmed) else {
            throw OliphauntError.engine(
                "Swift Oliphaunt native extension target '\(target)' must contain only ASCII letters, digits, '.', '_' or '-'"
            )
        }
        return trimmed
    }

    private static func nativeArtifactKind(for target: String) throws -> String {
        if target == "ios-xcframework" {
            return "ios-xcframework"
        }
        if target.hasPrefix("android-") {
            return "android-static-archive"
        }
        if target.hasPrefix("macos-") || target.hasPrefix("linux-") || target.hasPrefix("windows-") {
            return "runtime"
        }
        throw OliphauntError.engine(
            "Swift Oliphaunt does not know the native extension artifact kind for target \(target)"
        )
    }

    private static func validateReadiness(
        _ manifest: OliphauntExtensionReleaseManifest,
        target: String
    ) throws {
        if target == "ios-xcframework" || target.hasPrefix("android-") {
            guard manifest.mobileReleaseReady else {
                throw OliphauntError.engine(
                    "\(manifest.product) \(manifest.version) is not marked mobileReleaseReady for \(target)"
                )
            }
            return
        }
        guard manifest.desktopReleaseReady else {
            throw OliphauntError.engine(
                "\(manifest.product) \(manifest.version) is not marked desktopReleaseReady for \(target)"
            )
        }
    }
}

public struct OliphauntExtensionReleaseManifest: Equatable, Sendable {
    public var product: String
    public var version: String
    public var sqlName: String
    public var dependencies: [String]
    public var nativeModuleStem: String?
    public var sharedPreloadLibraries: [String]
    public var mobileReleaseReady: Bool
    public var desktopReleaseReady: Bool
    public var assets: [OliphauntExtensionReleaseAsset]

    public init(contentsOf url: URL) throws {
        let values = try Self.readProperties(url)
        try Self.require(values["schema"], equals: "oliphaunt-extension-release-manifest-v1", key: "schema", url: url)
        let product = try Self.requiredPortableId(values["product"], key: "product", url: url)
        guard product.hasPrefix("oliphaunt-extension-") else {
            throw OliphauntError.engine(
                "Oliphaunt extension release manifest \(url.path) product must start with oliphaunt-extension-"
            )
        }
        self.product = product
        self.version = try Self.requiredPortableId(values["version"], key: "version", url: url)
        self.sqlName = try Self.requiredPortableId(values["sqlName"], key: "sqlName", url: url)
        self.dependencies = try Self.csvPortableIds(values["dependencies"], key: "dependencies", url: url)
        let stem = values["nativeModuleStem"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.nativeModuleStem = stem.isEmpty ? nil : try Self.portableId(stem, key: "nativeModuleStem", url: url)
        self.sharedPreloadLibraries = try Self.csvPortableIds(
            values["sharedPreloadLibraries"],
            key: "sharedPreloadLibraries",
            url: url
        )
        self.mobileReleaseReady = try Self.requiredBool(values["mobileReleaseReady"], key: "mobileReleaseReady", url: url)
        self.desktopReleaseReady = try Self.requiredBool(
            values["desktopReleaseReady"],
            key: "desktopReleaseReady",
            url: url
        )
        self.assets = try Self.assets(from: values, url: url)
    }

    public func asset(family: String, target: String, kind: String) -> OliphauntExtensionReleaseAsset? {
        assets.first { asset in
            asset.family == family && asset.target == target && asset.kind == kind
        }
    }

    public func requiredAsset(family: String, target: String, kind: String) throws -> OliphauntExtensionReleaseAsset {
        if let asset = asset(family: family, target: target, kind: kind) {
            return asset
        }
        throw OliphauntError.engine(
            "\(product) \(version) does not contain \(family)/\(target)/\(kind) extension asset"
        )
    }

    private static func assets(
        from values: [String: String],
        url: URL
    ) throws -> [OliphauntExtensionReleaseAsset] {
        var assets: [OliphauntExtensionReleaseAsset] = []
        var seen = Set<String>()
        for key in values.keys.sorted() where key.hasPrefix("asset.") {
            let parts = key.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 4 else {
                throw OliphauntError.engine(
                    "Oliphaunt extension release manifest \(url.path) asset key '\(key)' must be asset.<family>.<target>.<kind>"
                )
            }
            let family = try portableId(parts[1], key: key, url: url)
            guard family == "native" || family == "wasix" else {
                throw OliphauntError.engine(
                    "Oliphaunt extension release manifest \(url.path) asset key '\(key)' has unsupported family '\(family)'"
                )
            }
            let target = try portableId(parts[2], key: key, url: url)
            let kind = try portableId(parts[3], key: key, url: url)
            let name = values[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !name.isEmpty, name == URL(fileURLWithPath: name).lastPathComponent, !name.contains("/") && !name.contains("\\") else {
                throw OliphauntError.engine(
                    "Oliphaunt extension release manifest \(url.path) asset '\(key)' must be a plain release asset file name"
                )
            }
            let identity = "\(family)\u{1f}\(target)\u{1f}\(kind)"
            guard seen.insert(identity).inserted else {
                throw OliphauntError.engine(
                    "Oliphaunt extension release manifest \(url.path) repeats extension asset \(family)/\(target)/\(kind)"
                )
            }
            assets.append(OliphauntExtensionReleaseAsset(
                family: family,
                target: target,
                kind: kind,
                name: name
            ))
        }
        guard !assets.isEmpty else {
            throw OliphauntError.engine(
                "Oliphaunt extension release manifest \(url.path) does not declare any extension assets"
            )
        }
        return assets.sorted { left, right in
            (left.family, left.target, left.kind, left.name) < (right.family, right.target, right.kind, right.name)
        }
    }

    private static func readProperties(_ url: URL) throws -> [String: String] {
        let text = try String(contentsOf: url, encoding: .utf8)
        var values: [String: String] = [:]
        for rawLine in text.split(whereSeparator: { $0.isNewline }) {
            let line = String(rawLine).trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") {
                continue
            }
            guard let separator = line.firstIndex(of: "=") else {
                continue
            }
            let key = String(line[..<separator]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
            values[key] = value
        }
        return values
    }

    private static func require(_ value: String?, equals expected: String, key: String, url: URL) throws {
        let actual = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard actual == expected else {
            throw OliphauntError.engine(
                "Oliphaunt extension release manifest \(url.path) has unsupported \(key) '\(actual.isEmpty ? "<missing>" : actual)'; expected \(expected)"
            )
        }
    }

    private static func requiredBool(_ value: String?, key: String, url: URL) throws -> Bool {
        switch value?.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "true":
            return true
        case "false":
            return false
        default:
            throw OliphauntError.engine(
                "Oliphaunt extension release manifest \(url.path) \(key) must be true or false"
            )
        }
    }

    private static func requiredPortableId(_ value: String?, key: String, url: URL) throws -> String {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else {
            throw OliphauntError.engine(
                "Oliphaunt extension release manifest \(url.path) is missing required \(key)"
            )
        }
        return try portableId(trimmed, key: key, url: url)
    }

    private static func portableId(_ value: String, key: String, url: URL) throws -> String {
        guard OliphauntRuntimeResources.isPortableId(value) else {
            throw OliphauntError.engine(
                "Oliphaunt extension release manifest \(url.path) \(key) value '\(value)' must contain only ASCII letters, digits, '.', '_' or '-'"
            )
        }
        return value
    }

    private static func csvPortableIds(_ value: String?, key: String, url: URL) throws -> [String] {
        let items = value?.split(separator: ",").map(String.init) ?? []
        return try items.map { item in
            try portableId(item.trimmingCharacters(in: .whitespacesAndNewlines), key: key, url: url)
        }.filter { !$0.isEmpty }.sorted()
    }
}

public struct OliphauntRuntimeResources: Sendable {
    public var resourceRoot: URL
    public var cacheRoot: URL

    public init(resourceRoot: URL, cacheRoot: URL = Self.defaultCacheRoot()) {
        self.resourceRoot = resourceRoot
        self.cacheRoot = cacheRoot
    }

    public init(bundle: Bundle, cacheRoot: URL = Self.defaultCacheRoot()) throws {
        guard let resourceURL = bundle.resourceURL else {
            throw OliphauntError.engine("bundle has no resource URL for Oliphaunt resources")
        }
        self.init(
            resourceRoot: resourceURL.appendingPathComponent("oliphaunt", isDirectory: true),
            cacheRoot: cacheRoot
        )
    }

    public static func bundled(cacheRoot: URL = Self.defaultCacheRoot()) -> OliphauntRuntimeResources? {
        try? bundledResource(
            inResourceDirectories: defaultBundleResourceURLs(),
            containing: [],
            cacheRoot: cacheRoot
        )
    }

    public static func bundled(
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
        for resourceDirectory in resourceDirectories {
            let resources = OliphauntRuntimeResources(
                resourceRoot: resourceDirectory.appendingPathComponent("oliphaunt", isDirectory: true),
                cacheRoot: cacheRoot
            )
            if try resources.hasPackagedResources(containing: requested) {
                return resources
            }
        }
        return nil
    }

    public static func defaultCacheRoot() -> URL {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("oliphaunt/runtime-cache", isDirectory: true)
    }

    public func packageSizeReport() throws -> OliphauntRuntimeResourceSizeReport? {
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

    public func materializeRuntime(requestedExtensions: [String] = []) throws -> URL {
        let requested = try Self.validateExtensionIds(requestedExtensions)
        let runtime = try assetPackage(kind: .runtime)
        try require(runtime: runtime, contains: requested)
        let target = cacheRoot
            .appendingPathComponent("runtime", isDirectory: true)
            .appendingPathComponent(runtime.cacheKey, isDirectory: true)
        try materialize(runtime, to: target)
        try syncDiscoveredIcuData(into: target, runtime: runtime)
        return target
    }

    func sharedPreloadLibraries(requestedExtensions: [String] = []) throws -> [String] {
        let requested = try Self.validateExtensionIds(requestedExtensions)
        let runtime = try assetPackage(kind: .runtime)
        try require(runtime: runtime, contains: requested)
        return runtime.sharedPreloadLibraries.sorted()
    }

    func hasPackagedResources(containing requestedExtensions: Set<String> = []) throws -> Bool {
        guard FileManager.default.fileExists(
            atPath: resourceRoot.appendingPathComponent("runtime/manifest.properties").path
        ) || FileManager.default.fileExists(
            atPath: resourceRoot.appendingPathComponent("template-pgdata/manifest.properties").path
        ) else {
            return false
        }
        guard !requestedExtensions.isEmpty else {
            return true
        }
        guard let runtime = try optionalAssetPackage(kind: .runtime) else {
            return false
        }
        return requestedExtensions.isSubset(of: runtime.extensions)
    }

    @discardableResult
    public func preparePgdata(at pgdata: URL) throws -> Bool {
        if FileManager.default.fileExists(
            atPath: pgdata.appendingPathComponent("PG_VERSION").path
        ) {
            try ensurePgdataDirectoryLayout(at: pgdata)
            try hardenPgdataPermissions(at: pgdata)
            return true
        }
        let template = try optionalAssetPackage(kind: .templatePgdata)
        guard let template else {
            return false
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
            ".pgdata-template-\(template.cacheKey)-\(UUID().uuidString)",
            isDirectory: true
        )
        try? FileManager.default.removeItem(at: temp)
        do {
            try copyTree(from: template.filesURL, to: temp)
            guard FileManager.default.fileExists(
                atPath: temp.appendingPathComponent("PG_VERSION").path
            ) else {
                throw OliphauntError.engine(
                    "packaged liboliphaunt template PGDATA \(template.rootURL.path) does not contain PG_VERSION"
                )
            }
            if FileManager.default.fileExists(atPath: pgdata.path) {
                try FileManager.default.removeItem(at: pgdata)
            }
            try FileManager.default.moveItem(at: temp, to: pgdata)
            try ensurePgdataDirectoryLayout(at: pgdata)
            try hardenPgdataPermissions(at: pgdata)
            return true
        } catch {
            try? FileManager.default.removeItem(at: temp)
            throw error
        }
    }

    private func materialize(_ package: AssetPackage, to target: URL) throws {
        let stamp = target.appendingPathComponent(".liboliphaunt-asset-cache-key")
        if FileManager.default.fileExists(atPath: target.path),
           (try? String(contentsOf: stamp, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) == package.cacheKey
        {
            return
        }

        let parent = target.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        let temp = parent.appendingPathComponent(
            ".\(target.lastPathComponent).tmp-\(UUID().uuidString)",
            isDirectory: true
        )
        try? FileManager.default.removeItem(at: temp)
        do {
            try copyTree(from: package.filesURL, to: temp)
            try package.cacheKey.write(
                to: temp.appendingPathComponent(".liboliphaunt-asset-cache-key"),
                atomically: true,
                encoding: .utf8
            )
            if FileManager.default.fileExists(atPath: target.path) {
                try FileManager.default.removeItem(at: target)
            }
            try FileManager.default.moveItem(at: temp, to: target)
        } catch {
            try? FileManager.default.removeItem(at: temp)
            throw error
        }
    }

    private func syncDiscoveredIcuData(into runtimeDirectory: URL, runtime: AssetPackage) throws {
        let destination = runtimeDirectory
            .appendingPathComponent("share", isDirectory: true)
            .appendingPathComponent("icu", isDirectory: true)
        if let source = try Self.defaultIcuDataURL() {
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try copyTree(from: source, to: destination)
            return
        }
        if !runtime.runtimeFeatures.contains("icu"),
           FileManager.default.fileExists(atPath: destination.path)
        {
            try FileManager.default.removeItem(at: destination)
        }
    }

    private func require(runtime: AssetPackage, contains requested: Set<String>) throws {
        let missing = requested.subtracting(runtime.extensions)
        guard missing.isEmpty else {
            let available = runtime.extensions.sorted().joined(separator: ",")
            throw OliphauntError.engine(
                "Swift Oliphaunt runtime resources \(runtime.rootURL.path) does not contain requested extension(s) \(missing.sorted().joined(separator: ",")); available extensions: \(available.isEmpty ? "<none>" : available)"
            )
        }
        try requireExtensionInstallFiles(runtime: runtime, contains: requested)
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

    private func assetPackage(kind: AssetPackageKind) throws -> AssetPackage {
        guard let package = try optionalAssetPackage(kind: kind) else {
            throw OliphauntError.engine("missing packaged liboliphaunt \(kind.label) resources at \(kind.root(in: resourceRoot).path)")
        }
        return package
    }

    private func optionalAssetPackage(kind: AssetPackageKind) throws -> AssetPackage? {
        let rootURL = kind.root(in: resourceRoot)
        let manifestURL = rootURL.appendingPathComponent("manifest.properties")
        guard FileManager.default.fileExists(atPath: manifestURL.path) else {
            return nil
        }
        let manifest = try readManifest(manifestURL)
        let schema = manifest["schema"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard schema == oliphauntRuntimeResourcesSchema else {
            throw OliphauntError.engine(
                "liboliphaunt \(kind.label) manifest has unsupported runtime resource schema '\(schema.isEmpty ? "<missing>" : schema)'; expected \(oliphauntRuntimeResourcesSchema)"
            )
        }
        let layout = manifest["layout"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard layout == kind.expectedLayout else {
            throw OliphauntError.engine(
                "liboliphaunt \(kind.label) manifest has unsupported layout '\(layout.isEmpty ? "<missing>" : layout)'; expected \(kind.expectedLayout)"
            )
        }
        let cacheKey = manifest["cacheKey"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard Self.isPortableId(cacheKey) else {
            throw OliphauntError.engine("liboliphaunt \(kind.label) manifest has invalid cacheKey '\(cacheKey)'")
        }
        let extensions = try Self.validateExtensionIds(
            manifest["extensions"]?.split(separator: ",").map(String.init) ?? []
        )
        let runtimeFeatures = try Self.validateRuntimeFeatures(
            manifest["runtimeFeatures"]?.split(separator: ",").map(String.init) ?? []
        )
        let mobileStaticRegistryState = try Self.validateMobileStaticRegistryState(
            manifest["mobileStaticRegistryState"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        let mobileStaticRegistryPending = try Self.validatePortableIds(
            manifest["mobileStaticRegistryPending"]?.split(separator: ",").map(String.init) ?? [],
            label: "mobile static registry extension"
        )
        let mobileStaticRegistryRegistered = try Self.validatePortableIds(
            manifest["mobileStaticRegistryRegistered"]?.split(separator: ",").map(String.init) ?? [],
            label: "mobile static registry extension"
        )
        let nativeModuleStems = try Self.validatePortableIds(
            manifest["nativeModuleStems"]?.split(separator: ",").map(String.init) ?? [],
            label: "native module stem"
        )
        let sharedPreloadLibraries = try Self.validatePortableIds(
            manifest["sharedPreloadLibraries"]?.split(separator: ",").map(String.init) ?? [],
            label: "shared preload library"
        )
        try Self.validateMobileStaticRegistryManifest(
            state: mobileStaticRegistryState,
            registered: mobileStaticRegistryRegistered,
            pending: mobileStaticRegistryPending,
            nativeModuleStems: nativeModuleStems
        )
        let filesURL = rootURL.appendingPathComponent("files", isDirectory: true)
        guard FileManager.default.fileExists(atPath: filesURL.path) else {
            throw OliphauntError.engine("liboliphaunt \(kind.label) package is missing files directory at \(filesURL.path)")
        }
        return AssetPackage(
            rootURL: rootURL,
            filesURL: filesURL,
            cacheKey: cacheKey,
            extensions: extensions,
            runtimeFeatures: runtimeFeatures,
            sharedPreloadLibraries: sharedPreloadLibraries,
            mobileStaticRegistryState: mobileStaticRegistryState,
            mobileStaticRegistryRegistered: mobileStaticRegistryRegistered,
            mobileStaticRegistryPending: mobileStaticRegistryPending,
            nativeModuleStems: nativeModuleStems
        )
    }

    private func readManifest(_ url: URL) throws -> [String: String] {
        let text = try String(contentsOf: url, encoding: .utf8)
        var values: [String: String] = [:]
        for rawLine in text.split(whereSeparator: { $0.isNewline }) {
            let line = String(rawLine).trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") {
                continue
            }
            guard let separator = line.firstIndex(of: "=") else {
                continue
            }
            let key = String(line[..<separator]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
            values[key] = value
        }
        return values
    }

    static func parsePackageSizeReport(
        _ text: String,
        source: String
    ) throws -> OliphauntRuntimeResourceSizeReport {
        var packageBytes: UInt64?
        var runtimeBytes: UInt64?
        var templatePgdataBytes: UInt64?
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
            case ("package", "template-pgdata"):
                try Self.setSizeReportValue(
                    &templatePgdataBytes,
                    bytes,
                    row: "package/template-pgdata",
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

        return OliphauntRuntimeResourceSizeReport(
            packageBytes: try Self.requireSizeReportValue(packageBytes, "package/total", source),
            runtimeBytes: try Self.requireSizeReportValue(runtimeBytes, "package/runtime", source),
            templatePgdataBytes: try Self.requireSizeReportValue(
                templatePgdataBytes,
                "package/template-pgdata",
                source
            ),
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
        nativeModuleStems: Set<String>
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

    private static func defaultIcuDataURL() throws -> URL? {
        for resourceDirectory in defaultBundleResourceURLs() {
            for relative in [
                "oliphaunt-icu/share/icu",
                "share/icu",
            ] {
                let candidate = resourceDirectory.appendingPathComponent(relative, isDirectory: true)
                if try icuDataRootContainsData(candidate) {
                    return candidate
                }
            }
        }
        return nil
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
    let bundles = preferred + Bundle.allFrameworks + Bundle.allBundles + [Bundle.main]
    var seen = Set<String>()
    var urls: [URL] = []
    for bundle in bundles {
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
    case templatePgdata

    var label: String {
        switch self {
        case .runtime:
            return "runtime"
        case .templatePgdata:
            return "template-pgdata"
        }
    }

    var expectedLayout: String {
        switch self {
        case .runtime:
            return oliphauntRuntimePackageLayout
        case .templatePgdata:
            return oliphauntTemplatePgdataPackageLayout
        }
    }

    func root(in resourceRoot: URL) -> URL {
        resourceRoot.appendingPathComponent(label, isDirectory: true)
    }
}

private struct AssetPackage {
    var rootURL: URL
    var filesURL: URL
    var cacheKey: String
    var extensions: Set<String>
    var runtimeFeatures: Set<String>
    var sharedPreloadLibraries: Set<String>
    var mobileStaticRegistryState: String?
    var mobileStaticRegistryRegistered: Set<String>
    var mobileStaticRegistryPending: Set<String>
    var nativeModuleStems: Set<String>
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

private func hardenPgdataPermissions(at pgdata: URL) throws {
    let fileManager = FileManager.default
    try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: pgdata.path)
    guard let enumerator = fileManager.enumerator(
        at: pgdata,
        includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
        options: []
    ) else {
        return
    }

    for case let url as URL in enumerator {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        if values.isSymbolicLink == true {
            continue
        }
        let permissions = values.isDirectory == true ? 0o700 : 0o600
        try fileManager.setAttributes([.posixPermissions: permissions], ofItemAtPath: url.path)
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
