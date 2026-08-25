import Foundation
@testable @_spi(ExtensionSupport) import Oliphaunt
import Testing

@Test
func swiftPMExtensionResourcesComposeBaseNativeDependenciesMultipleAndSQLOnly() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "oliphaunt-swift-extension-composition-\(UUID().uuidString)",
        isDirectory: true
    )
    let baseRoot = root.appendingPathComponent("base/oliphaunt", isDirectory: true)
    let cacheRoot = root.appendingPathComponent("cache", isDirectory: true)
    defer {
        for sqlName in ["auto_explain", "cube", "earthdistance", "postgis", "pgtap"] {
            OliphauntRuntimeResources.unregisterPackagedExtensionResource(
                sqlName: sqlName,
                resourceRoot: root.appendingPathComponent("fragments/\(sqlName)", isDirectory: true)
            )
        }
        try? FileManager.default.removeItem(at: root)
    }

    try writeExtensionCompositionText(
        baseRoot.appendingPathComponent("runtime/manifest.properties"),
        extensionCompositionRuntimeManifest(cacheKey: "swiftpm-base-v1")
    )
    try writeExtensionCompositionText(
        baseRoot.appendingPathComponent("runtime/files/share/postgresql/postgres.bki"),
        "base runtime\n"
    )
    try writeExtensionCompositionStandardSeeds(baseRoot)

    let rows: [(String, String, String, Bool, [String], String?, [String], [String])] = [
        (
            "auto_explain", "oliphaunt-extension-contrib-pg18", "0.1.0",
            false, [], "auto_explain", [], ["auto_explain"]
        ),
        ("cube", "oliphaunt-extension-contrib-pg18", "0.1.0", true, [], "cube", [], []),
        (
            "earthdistance", "oliphaunt-extension-contrib-pg18", "0.1.0",
            true, ["cube"], "earthdistance", [], []
        ),
        (
            "postgis", "oliphaunt-extension-postgis", "3.6.1",
            true, [], "postgis-3", ["geos"], ["postgis_preload"]
        ),
        ("pgtap", "oliphaunt-extension-pgtap", "1.3.5", true, [], nil, [], []),
    ]
    for (sqlName, product, version, createsExtension, dependencies, stem, nativeDependencies, sharedPreload) in rows {
        let fragment = root.appendingPathComponent("fragments/\(sqlName)", isDirectory: true)
        try makeExtensionCompositionFragment(
            at: fragment,
            product: product,
            sqlName: sqlName,
            version: version,
            createsExtension: createsExtension,
            dependencies: dependencies,
            nativeModuleStem: stem,
            nativeDependencies: nativeDependencies,
            sharedPreloadLibraries: sharedPreload
        )
        #expect(try OliphauntRuntimeResources.registerPackagedExtensionResource(
            product: product,
            version: version,
            sqlName: sqlName,
            dependencies: dependencies,
            nativeDependencies: nativeDependencies,
            nativeModuleStem: stem,
            sharedPreloadLibraries: sharedPreload,
            resourceRoot: fragment
        ))
    }

    let requested = Set(["auto_explain", "earthdistance", "postgis", "pgtap"])
    let base = OliphauntRuntimeResources(resourceRoot: baseRoot, cacheRoot: cacheRoot)
    let composed = try #require(try OliphauntRuntimeResources.composedBundledResource(
        base: base,
        containing: requested,
        cacheRoot: cacheRoot
    ))
    let runtime = try composed.materializeRuntime(requestedExtensions: requested.sorted())
    for sqlName in ["cube", "earthdistance", "postgis", "pgtap"] {
        #expect(FileManager.default.fileExists(
            atPath: runtime.appendingPathComponent(
                "share/postgresql/extension/\(sqlName).control"
            ).path
        ))
    }
    #expect(!FileManager.default.fileExists(
        atPath: runtime.appendingPathComponent("share/postgresql/extension/vector.control").path
    ))
    #expect(try composed.sharedPreloadLibraries(requestedExtensions: requested.sorted()) == [
        "auto_explain",
        "postgis_preload",
    ])

    let runtimeManifest = try extensionCompositionProperties(
        composed.resourceRoot.appendingPathComponent("runtime/manifest.properties")
    )
    #expect(runtimeManifest["selectedExtensions"] == "auto_explain,cube,earthdistance,pgtap,postgis")
    #expect(runtimeManifest["extensions"] == "cube,earthdistance,pgtap,postgis")
    #expect(runtimeManifest["mobileStaticRegistryState"] == "complete")
    #expect(runtimeManifest["mobileStaticRegistryRegistered"] == "auto_explain,cube,earthdistance,postgis")
    #expect(runtimeManifest["nativeModuleStems"] == "auto_explain,cube,earthdistance,postgis-3")
    let registryManifest = try extensionCompositionProperties(
        composed.resourceRoot.appendingPathComponent("static-registry/manifest.properties")
    )
    #expect(registryManifest["state"] == "complete")
    #expect(registryManifest["source"] == "swiftpm-linked-products")
    #expect(registryManifest["dependencyArchives"] == "geos")
    let report = try #require(try composed.packageSizeReport())
    #expect(report.extensions.map(\.name) == ["auto_explain", "cube", "earthdistance", "pgtap", "postgis"])

    // A matching cache key is insufficient: the cached manifest must still be
    // bound to the complete dependency-closed selection, including products
    // that do not support CREATE EXTENSION.
    var staleManifest = runtimeManifest
    staleManifest["selectedExtensions"] = "cube,earthdistance,pgtap,postgis"
    try writeExtensionCompositionText(
        composed.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        staleManifest.keys.sorted().map { "\($0)=\(staleManifest[$0]!)" }.joined(separator: "\n") + "\n"
    )

    let second = try #require(try OliphauntRuntimeResources.composedBundledResource(
        base: base,
        containing: requested,
        cacheRoot: cacheRoot
    ))
    #expect(second.resourceRoot.standardizedFileURL == composed.resourceRoot.standardizedFileURL)
    let repairedManifest = try extensionCompositionProperties(
        second.resourceRoot.appendingPathComponent("runtime/manifest.properties")
    )
    #expect(repairedManifest["selectedExtensions"] == "auto_explain,cube,earthdistance,pgtap,postgis")

    var staleDomains = repairedManifest
    staleDomains["extensions"] = "cube,earthdistance,postgis"
    staleDomains["mobileStaticRegistryRegistered"] = "cube,earthdistance,postgis"
    staleDomains["nativeModuleStems"] = "cube,earthdistance,postgis-3"
    try writeExtensionCompositionText(
        second.resourceRoot.appendingPathComponent("runtime/manifest.properties"),
        staleDomains.keys.sorted().map { "\($0)=\(staleDomains[$0]!)" }.joined(separator: "\n") + "\n"
    )
    var staleRegistry = try extensionCompositionProperties(
        second.resourceRoot.appendingPathComponent("static-registry/manifest.properties")
    )
    staleRegistry["registeredExtensions"] = "cube,earthdistance,postgis"
    staleRegistry["nativeModuleStems"] = "cube,earthdistance,postgis-3"
    staleRegistry["modules"] = "cube,earthdistance,postgis-3"
    try writeExtensionCompositionText(
        second.resourceRoot.appendingPathComponent("static-registry/manifest.properties"),
        staleRegistry.keys.sorted().map { "\($0)=\(staleRegistry[$0]!)" }.joined(separator: "\n") + "\n"
    )

    let third = try #require(try OliphauntRuntimeResources.composedBundledResource(
        base: base,
        containing: requested,
        cacheRoot: cacheRoot
    ))
    let exactRuntimeManifest = try extensionCompositionProperties(
        third.resourceRoot.appendingPathComponent("runtime/manifest.properties")
    )
    #expect(exactRuntimeManifest["extensions"] == "cube,earthdistance,pgtap,postgis")
    #expect(exactRuntimeManifest["mobileStaticRegistryRegistered"] == "auto_explain,cube,earthdistance,postgis")
    #expect(exactRuntimeManifest["nativeModuleStems"] == "auto_explain,cube,earthdistance,postgis-3")
    let exactRegistryManifest = try extensionCompositionProperties(
        third.resourceRoot.appendingPathComponent("static-registry/manifest.properties")
    )
    #expect(exactRegistryManifest["registeredExtensions"] == "auto_explain,cube,earthdistance,postgis")
    #expect(exactRegistryManifest["nativeModuleStems"] == "auto_explain,cube,earthdistance,postgis-3")
}

@Test
func swiftPMExtensionResourceCompositionFailsClosedOnMissingDependency() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "oliphaunt-swift-extension-missing-dependency-\(UUID().uuidString)",
        isDirectory: true
    )
    let baseRoot = root.appendingPathComponent("base/oliphaunt", isDirectory: true)
    let fragment = root.appendingPathComponent("fragment", isDirectory: true)
    defer {
        OliphauntRuntimeResources.unregisterPackagedExtensionResource(
            sqlName: "missing_parent",
            resourceRoot: fragment
        )
        try? FileManager.default.removeItem(at: root)
    }
    try writeExtensionCompositionText(
        baseRoot.appendingPathComponent("runtime/manifest.properties"),
        extensionCompositionRuntimeManifest(cacheKey: "swiftpm-missing-base-v1")
    )
    try writeExtensionCompositionText(
        baseRoot.appendingPathComponent("runtime/files/share/postgresql/postgres.bki"),
        "base runtime\n"
    )
    try writeExtensionCompositionStandardSeeds(baseRoot)
    try makeExtensionCompositionFragment(
        at: fragment,
        product: "oliphaunt-extension-missing-parent",
        sqlName: "missing_parent",
        version: "1.0.0",
        createsExtension: true,
        dependencies: ["missing_child"],
        nativeModuleStem: nil,
        nativeDependencies: [],
        sharedPreloadLibraries: []
    )
    _ = try OliphauntRuntimeResources.registerPackagedExtensionResource(
        product: "oliphaunt-extension-missing-parent",
        version: "1.0.0",
        sqlName: "missing_parent",
        dependencies: ["missing_child"],
        nativeDependencies: [],
        nativeModuleStem: nil,
        sharedPreloadLibraries: [],
        resourceRoot: fragment
    )

    do {
        _ = try OliphauntRuntimeResources.composedBundledResource(
            base: OliphauntRuntimeResources(resourceRoot: baseRoot, cacheRoot: root.appendingPathComponent("cache")),
            containing: ["missing_parent"],
            cacheRoot: root.appendingPathComponent("cache")
        )
        Issue.record("SwiftPM resource composition accepted a missing exact-extension dependency")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("missing_child"))
        #expect(message.contains("required by missing_parent"))
    }
}

@Test
func swiftRuntimeResourcesRejectDuplicateManifestProperties() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "oliphaunt-swift-duplicate-manifest-\(UUID().uuidString)",
        isDirectory: true
    )
    defer { try? FileManager.default.removeItem(at: root) }
    try writeExtensionCompositionStandardSeeds(root)
    try writeExtensionCompositionText(
        root.appendingPathComponent("runtime/manifest.properties"),
        """
        schema=oliphaunt-runtime-resources-v1
        schema=duplicate
        layout=postgres-runtime-files-v1
        """
    )
    try writeExtensionCompositionText(
        root.appendingPathComponent("runtime/files/share/postgresql/postgres.bki"),
        "runtime\n"
    )
    do {
        _ = try OliphauntRuntimeResources(
            resourceRoot: root,
            cacheRoot: root.appendingPathComponent("cache")
        ).materializeRuntime()
        Issue.record("Swift runtime resources accepted duplicate manifest properties")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("duplicate"))
    }
}

@Test
func swiftRuntimeResourcesRejectSharedWhitespaceInvalidClusterSeedManifest() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "oliphaunt-swift-whitespace-manifest-\(UUID().uuidString)",
        isDirectory: true
    )
    defer { try? FileManager.default.removeItem(at: root) }
    try writeExtensionCompositionStandardSeeds(root)
    try writeExtensionCompositionText(
        root.appendingPathComponent("cluster-seed/manifest.properties"),
        try nativeClusterSeedFixture(
            named: "native-whitespace.invalid.properties",
            target: "macos-arm64"
        )
    )
    try writeExtensionCompositionText(
        root.appendingPathComponent("runtime/manifest.properties"),
        extensionCompositionRuntimeManifest(cacheKey: "swiftpm-whitespace-v1")
    )
    try writeExtensionCompositionText(
        root.appendingPathComponent("runtime/files/share/postgresql/postgres.bki"),
        "runtime\n"
    )
    do {
        _ = try OliphauntRuntimeResources(
            resourceRoot: root,
            cacheRoot: root.appendingPathComponent("cache")
        ).materializeRuntime()
        Issue.record("Swift runtime resources accepted whitespace-normalized cluster-seed metadata")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("cacheKey"))
    }
}

@Test
func swiftRuntimeResourcesRejectSharedPathTraversalClusterSeedCacheKeys() throws {
    for fixture in [
        "native-dot-cache-key.invalid.properties",
        "native-dotdot-cache-key.invalid.properties",
    ] {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "oliphaunt-swift-cache-key-contract-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        try writeExtensionCompositionStandardSeeds(root)
        try writeExtensionCompositionText(
            root.appendingPathComponent("cluster-seed/manifest.properties"),
            try nativeClusterSeedFixture(named: fixture, target: "macos-arm64")
        )
        try writeExtensionCompositionText(
            root.appendingPathComponent("runtime/manifest.properties"),
            extensionCompositionRuntimeManifest(cacheKey: "swiftpm-cache-key-contract-v1")
        )
        try writeExtensionCompositionText(
            root.appendingPathComponent("runtime/files/share/postgresql/postgres.bki"),
            "runtime\n"
        )
        do {
            _ = try OliphauntRuntimeResources(
                resourceRoot: root,
                cacheRoot: root.appendingPathComponent("cache")
            ).materializeRuntime()
            Issue.record("Swift runtime resources accepted \(fixture)")
        } catch OliphauntError.engine(let message) {
            #expect(message.contains("invalid cacheKey"))
        }
    }
}

@Test
func swiftRuntimeResourcesRejectNoncanonicalRuntimeManifestContracts() throws {
    let scenarios: [(name: String, manifest: String, expected: String)] = [
        (
            "missing-field",
            extensionCompositionRuntimeManifest(
                cacheKey: "swiftpm-missing-field-v1",
                omitting: ["selectedExtensions"]
            ),
            "missing=selectedExtensions"
        ),
        (
            "extra-field",
            extensionCompositionRuntimeManifest(
                cacheKey: "swiftpm-extra-field-v1",
                extra: ["legacy": "value"]
            ),
            "unsupported=legacy"
        ),
        ("dot-cache-key", extensionCompositionRuntimeManifest(cacheKey: "."), "invalid cacheKey"),
        ("dotdot-cache-key", extensionCompositionRuntimeManifest(cacheKey: ".."), "invalid cacheKey"),
        (
            "mode",
            extensionCompositionRuntimeManifest(cacheKey: "swiftpm-mode-v1", mode: "other"),
            "mode=native-direct"
        ),
        (
            "missing-registry-source",
            extensionCompositionRuntimeManifest(
                cacheKey: "swiftpm-source-v1",
                registryState: "complete",
                registrySource: ""
            ),
            "mobileStaticRegistrySource"
        ),
        (
            "unknown-registry-source",
            extensionCompositionRuntimeManifest(
                cacheKey: "swiftpm-unknown-source-v1",
                registryState: "complete",
                registrySource: "other"
            ),
            "mobileStaticRegistrySource"
        ),
        (
            "unexpected-registry-source",
            extensionCompositionRuntimeManifest(
                cacheKey: "swiftpm-unexpected-source-v1",
                registrySource: "static-registry/oliphaunt_static_registry.c"
            ),
            "mobileStaticRegistrySource"
        ),
    ]

    for scenario in scenarios {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "oliphaunt-swift-runtime-contract-\(scenario.name)-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        try writeExtensionCompositionStandardSeeds(root)
        try writeExtensionCompositionText(
            root.appendingPathComponent("runtime/manifest.properties"),
            scenario.manifest
        )
        try writeExtensionCompositionText(
            root.appendingPathComponent("runtime/files/share/postgresql/postgres.bki"),
            "runtime\n"
        )
        do {
            _ = try OliphauntRuntimeResources(
                resourceRoot: root,
                cacheRoot: root.appendingPathComponent("cache")
            ).materializeRuntime()
            Issue.record("Swift runtime resources accepted \(scenario.name)")
        } catch OliphauntError.engine(let message) {
            #expect(message.contains(scenario.expected))
        }
    }
}

@Test
func swiftRuntimeResourcesAcceptOnlyTheTwoCompleteRegistrySources() throws {
    for source in [
        "static-registry/oliphaunt_static_registry.c",
        "swiftpm-linked-products",
    ] {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "oliphaunt-swift-registry-source-contract-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        try writeExtensionCompositionStandardSeeds(root)
        try writeExtensionCompositionText(
            root.appendingPathComponent("runtime/manifest.properties"),
            extensionCompositionRuntimeManifest(
                cacheKey: "swiftpm-registry-source-v1",
                registryState: "complete",
                registrySource: source
            )
        )
        try writeExtensionCompositionText(
            root.appendingPathComponent("runtime/files/share/postgresql/postgres.bki"),
            "runtime\n"
        )
        _ = try OliphauntRuntimeResources(
            resourceRoot: root,
            cacheRoot: root.appendingPathComponent("cache")
        ).materializeRuntime()
    }
}

@Test
func swiftRuntimeCacheNeverReplacesAnInvalidPublishedTarget() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "oliphaunt-swift-runtime-cache-contract-\(UUID().uuidString)",
        isDirectory: true
    )
    let cache = root.appendingPathComponent("cache", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try writeExtensionCompositionStandardSeeds(root)
    try writeExtensionCompositionText(
        root.appendingPathComponent("runtime/manifest.properties"),
        extensionCompositionRuntimeManifest(cacheKey: "swiftpm-cache-contract-v1")
    )
    try writeExtensionCompositionText(
        root.appendingPathComponent("runtime/files/share/postgresql/postgres.bki"),
        "runtime\n"
    )
    let resources = OliphauntRuntimeResources(resourceRoot: root, cacheRoot: cache)
    let published = try resources.materializeRuntime()
    let sentinel = published.appendingPathComponent("sentinel")
    try "preserve\n".write(to: sentinel, atomically: true, encoding: .utf8)
    try "invalid\n".write(
        to: published.appendingPathComponent(".liboliphaunt-asset-cache-key"),
        atomically: true,
        encoding: .utf8
    )

    do {
        _ = try resources.materializeRuntime()
        Issue.record("Swift runtime cache replaced an invalid published target")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("immutable Swift Oliphaunt runtime cache"))
        #expect(try String(contentsOf: sentinel, encoding: .utf8) == "preserve\n")
    }
}

private func writeExtensionCompositionStandardSeeds(_ resourceRoot: URL) throws {
    let target = "macos-arm64"
    try writeExtensionCompositionText(
        resourceRoot.appendingPathComponent("manifest.properties"),
        """
        schema=oliphaunt-native-runtime-carrier-v1
        clusterSeedTarget=\(target)
        clusterSeedRelativePath=cluster-seed
        icuClusterSeedRelativePath=cluster-seed-icu
        """
    )
    let seed = resourceRoot.appendingPathComponent("cluster-seed", isDirectory: true)
    try writeExtensionCompositionText(
        seed.appendingPathComponent("manifest.properties"),
        try nativeClusterSeedFixture(profile: "standard", target: target)
    )
    try writeExtensionCompositionText(
        seed.appendingPathComponent("files/PG_VERSION"),
        "18\n"
    )
    try writeExtensionCompositionText(
        seed.appendingPathComponent("files/global/pg_control"),
        "control\n"
    )
    let icuSeed = resourceRoot.appendingPathComponent("cluster-seed-icu", isDirectory: true)
    try writeExtensionCompositionText(
        icuSeed.appendingPathComponent("manifest.properties"),
        try nativeClusterSeedFixture(profile: "icu", target: target)
    )
    try writeExtensionCompositionText(
        icuSeed.appendingPathComponent("files/PG_VERSION"),
        "18\n"
    )
    try writeExtensionCompositionText(
        icuSeed.appendingPathComponent("files/global/pg_control"),
        "control\n"
    )
}

private func extensionCompositionRuntimeManifest(
    cacheKey: String,
    mode: String = "native-direct",
    registryState: String = "not-required",
    registrySource: String = "",
    omitting: Set<String> = [],
    extra: [String: String] = [:]
) -> String {
    let registryExtensions = registryState == "complete" ? "vector" : ""
    var fields: [(String, String)] = [
        ("schema", "oliphaunt-runtime-resources-v1"),
        ("layout", "postgres-runtime-files-v1"),
        ("artifactRole", "runtime"),
        ("catalogProfile", ""),
        ("clusterSeedTarget", "macos-arm64"),
        ("icuDataTreeSha256", ""),
        ("mode", mode),
        ("cacheKey", cacheKey),
        ("selectedExtensions", registryExtensions),
        ("extensions", registryExtensions),
        ("runtimeFeatures", ""),
        ("sharedPreloadLibraries", ""),
        ("mobileStaticRegistryState", registryState),
        ("mobileStaticRegistryRegistered", registryExtensions),
        ("mobileStaticRegistryPending", ""),
        ("nativeModuleStems", registryExtensions),
        ("mobileStaticRegistrySource", registrySource),
    ]
    fields.removeAll { omitting.contains($0.0) }
    fields.append(contentsOf: extra.sorted { $0.key < $1.key }.map { ($0.key, $0.value) })
    return fields.map { "\($0.0)=\($0.1)" }.joined(separator: "\n") + "\n"
}

private func nativeClusterSeedFixture(profile: String, target: String) throws -> String {
    try nativeClusterSeedFixture(
        named: "native-\(profile).valid.properties",
        target: target
    )
}

private func nativeClusterSeedFixture(named name: String, target: String) throws -> String {
    var sourceRoot = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 {
        sourceRoot.deleteLastPathComponent()
    }
    let fixture = sourceRoot
        .appendingPathComponent("shared/cluster-seed-contract/fixtures")
        .appendingPathComponent(name)
    let source = try String(contentsOf: fixture, encoding: .utf8)
    let overrides = [
        "target": target,
        "compatibilityKey": "native-pg18-\(target)-v1",
    ]
    return source.split(separator: "\n", omittingEmptySubsequences: false).map { row in
        let line = String(row)
        guard let separator = line.firstIndex(of: "=") else { return line }
        let key = String(line[..<separator])
        guard let value = overrides[key] else { return line }
        return "\(key)=\(value)"
    }.joined(separator: "\n")
}

@Test
func swiftPMExtensionResourceRejectsFrozenProductMismatch() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
        "oliphaunt-swift-extension-product-mismatch-\(UUID().uuidString)",
        isDirectory: true
    )
    defer { try? FileManager.default.removeItem(at: root) }

    try makeExtensionCompositionFragment(
        at: root,
        product: "oliphaunt-extension-contrib-pg18",
        sqlName: "amcheck",
        version: "0.1.0",
        createsExtension: true,
        dependencies: [],
        nativeModuleStem: "amcheck",
        nativeDependencies: [],
        sharedPreloadLibraries: []
    )

    do {
        _ = try OliphauntRuntimeResources.registerPackagedExtensionResource(
            product: "oliphaunt-extension-vector",
            version: "0.1.0",
            sqlName: "amcheck",
            dependencies: [],
            nativeDependencies: [],
            nativeModuleStem: "amcheck",
            sharedPreloadLibraries: [],
            resourceRoot: root
        )
        Issue.record("SwiftPM resource registration accepted a product that disagrees with its manifest")
    } catch OliphauntError.engine(let message) {
        #expect(message.contains("product"))
        #expect(message.contains("oliphaunt-extension-vector"))
    }
}

private func makeExtensionCompositionFragment(
    at root: URL,
    product: String,
    sqlName: String,
    version: String,
    createsExtension: Bool,
    dependencies: [String],
    nativeModuleStem: String?,
    nativeDependencies: [String],
    sharedPreloadLibraries: [String]
) throws {
    try writeExtensionCompositionText(
        root.appendingPathComponent("manifest.properties"),
        """
        schema=oliphaunt-swift-extension-resource-v1
        product=\(product)
        version=\(version)
        sqlName=\(sqlName)
        createsExtension=\(createsExtension ? "yes" : "no")
        dependencies=\(dependencies.sorted().joined(separator: ","))
        nativeModuleStem=\(nativeModuleStem ?? "")
        nativeDependencies=\(nativeDependencies.sorted().joined(separator: ","))
        sharedPreloadLibraries=\(sharedPreloadLibraries.sorted().joined(separator: ","))
        files=files
        """
    )
    if createsExtension {
        try writeExtensionCompositionText(
            root.appendingPathComponent("files/share/postgresql/extension/\(sqlName).control"),
            "default_version = '\(version)'\n"
        )
        try writeExtensionCompositionText(
            root.appendingPathComponent("files/share/postgresql/extension/\(sqlName)--\(version).sql"),
            "SELECT 1;\n"
        )
    } else {
        try writeExtensionCompositionText(
            root.appendingPathComponent("files/share/postgresql/README.\(sqlName)"),
            "module-only product \(sqlName)\n"
        )
    }
}

private func writeExtensionCompositionText(_ url: URL, _ text: String) throws {
    try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try text.write(to: url, atomically: true, encoding: .utf8)
}

private func extensionCompositionProperties(_ url: URL) throws -> [String: String] {
    var values: [String: String] = [:]
    for line in try String(contentsOf: url, encoding: .utf8).split(whereSeparator: \.isNewline) {
        let text = String(line)
        guard let separator = text.firstIndex(of: "=") else { continue }
        values[String(text[..<separator])] = String(text[text.index(after: separator)...])
    }
    return values
}
