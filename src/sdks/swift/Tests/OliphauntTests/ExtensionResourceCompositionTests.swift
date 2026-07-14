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
        for sqlName in ["cube", "earthdistance", "postgis", "pgtap"] {
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

    let rows: [(String, String, [String], String?, [String], [String])] = [
        ("cube", "0.1.0", [], "cube", [], []),
        ("earthdistance", "0.1.0", ["cube"], "earthdistance", [], []),
        ("postgis", "3.6.1", [], "postgis-3", ["geos"], ["postgis_preload"]),
        ("pgtap", "1.3.5", [], nil, [], []),
    ]
    for (sqlName, version, dependencies, stem, nativeDependencies, sharedPreload) in rows {
        let fragment = root.appendingPathComponent("fragments/\(sqlName)", isDirectory: true)
        try makeExtensionCompositionFragment(
            at: fragment,
            sqlName: sqlName,
            version: version,
            dependencies: dependencies,
            nativeModuleStem: stem,
            nativeDependencies: nativeDependencies,
            sharedPreloadLibraries: sharedPreload
        )
        #expect(try OliphauntRuntimeResources.registerPackagedExtensionResource(
            product: "oliphaunt-extension-\(sqlName.replacingOccurrences(of: "_", with: "-"))",
            version: version,
            sqlName: sqlName,
            dependencies: dependencies,
            nativeDependencies: nativeDependencies,
            nativeModuleStem: stem,
            sharedPreloadLibraries: sharedPreload,
            resourceRoot: fragment
        ))
    }

    let requested = Set(["earthdistance", "postgis", "pgtap"])
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
        "postgis_preload",
    ])

    let runtimeManifest = try extensionCompositionProperties(
        composed.resourceRoot.appendingPathComponent("runtime/manifest.properties")
    )
    #expect(runtimeManifest["extensions"] == "cube,earthdistance,pgtap,postgis")
    #expect(runtimeManifest["mobileStaticRegistryState"] == "complete")
    #expect(runtimeManifest["mobileStaticRegistryRegistered"] == "cube,earthdistance,postgis")
    #expect(runtimeManifest["nativeModuleStems"] == "cube,earthdistance,postgis-3")
    let registryManifest = try extensionCompositionProperties(
        composed.resourceRoot.appendingPathComponent("static-registry/manifest.properties")
    )
    #expect(registryManifest["state"] == "complete")
    #expect(registryManifest["source"] == "swiftpm-linked-products")
    #expect(registryManifest["dependencyArchives"] == "geos")
    let report = try #require(try composed.packageSizeReport())
    #expect(report.extensions.map(\.name) == ["cube", "earthdistance", "pgtap", "postgis"])

    let second = try #require(try OliphauntRuntimeResources.composedBundledResource(
        base: base,
        containing: requested,
        cacheRoot: cacheRoot
    ))
    #expect(second.resourceRoot.standardizedFileURL == composed.resourceRoot.standardizedFileURL)
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
        sqlName: "missing_parent",
        version: "1.0.0",
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

private func makeExtensionCompositionFragment(
    at root: URL,
    sqlName: String,
    version: String,
    dependencies: [String],
    nativeModuleStem: String?,
    nativeDependencies: [String],
    sharedPreloadLibraries: [String]
) throws {
    try writeExtensionCompositionText(
        root.appendingPathComponent("manifest.properties"),
        """
        schema=oliphaunt-swift-extension-resource-v1
        product=oliphaunt-extension-\(sqlName.replacingOccurrences(of: "_", with: "-"))
        version=\(version)
        sqlName=\(sqlName)
        createsExtension=yes
        dependencies=\(dependencies.sorted().joined(separator: ","))
        nativeModuleStem=\(nativeModuleStem ?? "")
        nativeDependencies=\(nativeDependencies.sorted().joined(separator: ","))
        sharedPreloadLibraries=\(sharedPreloadLibraries.sorted().joined(separator: ","))
        files=files
        """
    )
    try writeExtensionCompositionText(
        root.appendingPathComponent("files/share/postgresql/extension/\(sqlName).control"),
        "default_version = '\(version)'\n"
    )
    try writeExtensionCompositionText(
        root.appendingPathComponent("files/share/postgresql/extension/\(sqlName)--\(version).sql"),
        "SELECT 1;\n"
    )
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
