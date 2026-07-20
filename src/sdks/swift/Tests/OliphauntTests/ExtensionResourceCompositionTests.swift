import Foundation
@testable import Oliphaunt
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
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=swiftpm-base-v1
        source=swiftpm-test
        selectedExtensions=
        extensions=
        runtimeFeatures=
        sharedPreloadLibraries=
        mobileStaticRegistryState=not-required
        mobileStaticRegistryRegistered=
        mobileStaticRegistryPending=
        nativeModuleStems=
        mobileStaticRegistrySource=
        """
    )
    try writeExtensionCompositionText(
        baseRoot.appendingPathComponent("runtime/files/share/postgresql/postgres.bki"),
        "base runtime\n"
    )

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
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=swiftpm-missing-base-v1
        extensions=
        runtimeFeatures=
        sharedPreloadLibraries=
        mobileStaticRegistryState=not-required
        mobileStaticRegistryRegistered=
        mobileStaticRegistryPending=
        nativeModuleStems=
        """
    )
    try writeExtensionCompositionText(
        baseRoot.appendingPathComponent("runtime/files/share/postgresql/postgres.bki"),
        "base runtime\n"
    )
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
