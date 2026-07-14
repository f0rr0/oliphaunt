import Foundation

struct OliphauntPackagedExtensionResource: Sendable {
    struct File: Sendable {
        var source: URL
        var relativePath: String
        var bytes: UInt64
    }

    var product: String
    var version: String
    var sqlName: String
    var createsExtension: Bool
    var dependencies: [String]
    var nativeModuleStem: String?
    var nativeDependencies: [String]
    var sharedPreloadLibraries: [String]
    var resourceRoot: URL
    var files: [File]
    var fingerprint: String
}

private enum OliphauntPackagedExtensionRegistry {
    static let lock = NSLock()
    static let compositionLock = NSLock()
    nonisolated(unsafe) static var resources: [String: OliphauntPackagedExtensionResource] = [:]
}

extension OliphauntRuntimeResources {
    /// Registers a generated SwiftPM exact-extension resource fragment.
    /// Applications normally call the generated `OliphauntExtension*.register()`
    /// wrapper rather than invoking this packaging API directly.
    @discardableResult
    public static func registerPackagedExtensionResource(
        product: String,
        version: String,
        sqlName: String,
        dependencies: [String],
        nativeDependencies: [String],
        nativeModuleStem: String?,
        sharedPreloadLibraries: [String],
        resourceRoot: URL
    ) throws -> Bool {
        let expectedProduct = try packagedExtensionPortableId(product, label: "product")
        guard expectedProduct == "oliphaunt-extension-\(sqlName.replacingOccurrences(of: "_", with: "-"))" else {
            throw OliphauntError.engine(
                "SwiftPM exact-extension product \(product) does not match SQL name \(sqlName)"
            )
        }
        let expectedVersion = try packagedExtensionPortableId(version, label: "version")
        let expectedSQLName = try packagedExtensionPortableId(sqlName, label: "SQL name")
        let expectedDependencies = try normalizedPortableIds(dependencies, label: "extension dependency")
        guard Set(expectedDependencies).count == expectedDependencies.count else {
            throw OliphauntError.engine("SwiftPM exact-extension \(sqlName) repeats a dependency")
        }
        let expectedStem = try nativeModuleStem.map {
            try packagedExtensionPortableId($0, label: "native module stem")
        }
        let expectedNativeDependencies = try normalizedPortableIds(
            nativeDependencies,
            label: "native dependency"
        )
        guard Set(expectedNativeDependencies).count == expectedNativeDependencies.count else {
            throw OliphauntError.engine(
                "SwiftPM exact-extension \(sqlName) repeats a native dependency"
            )
        }
        guard expectedStem != nil || expectedNativeDependencies.isEmpty else {
            throw OliphauntError.engine(
                "SQL-only SwiftPM exact-extension \(sqlName) cannot declare native dependencies"
            )
        }
        let expectedSharedPreload = try normalizedPortableIds(
            sharedPreloadLibraries,
            label: "shared preload library"
        )
        guard Set(expectedSharedPreload).count == expectedSharedPreload.count else {
            throw OliphauntError.engine(
                "SwiftPM exact-extension \(sqlName) repeats a shared preload library"
            )
        }

        let resource = try readPackagedExtensionResource(
            at: resourceRoot,
            product: expectedProduct,
            version: expectedVersion,
            sqlName: expectedSQLName,
            dependencies: expectedDependencies.sorted(),
            nativeModuleStem: expectedStem,
            nativeDependencies: expectedNativeDependencies.sorted(),
            sharedPreloadLibraries: expectedSharedPreload.sorted()
        )

        OliphauntPackagedExtensionRegistry.lock.lock()
        defer { OliphauntPackagedExtensionRegistry.lock.unlock() }
        if let existing = OliphauntPackagedExtensionRegistry.resources[expectedSQLName] {
            guard existing.product == resource.product,
                  existing.version == resource.version,
                  existing.dependencies == resource.dependencies,
                  existing.nativeModuleStem == resource.nativeModuleStem,
                  existing.nativeDependencies == resource.nativeDependencies,
                  existing.sharedPreloadLibraries == resource.sharedPreloadLibraries,
                  existing.createsExtension == resource.createsExtension,
                  existing.fingerprint == resource.fingerprint
            else {
                throw OliphauntError.engine(
                    "conflicting SwiftPM exact-extension resources were linked for \(sqlName)"
                )
            }
            return false
        }
        OliphauntPackagedExtensionRegistry.resources[expectedSQLName] = resource
        return true
    }

    public static func unregisterPackagedExtensionResource(
        sqlName: String,
        resourceRoot: URL
    ) {
        OliphauntPackagedExtensionRegistry.lock.lock()
        defer { OliphauntPackagedExtensionRegistry.lock.unlock() }
        guard let existing = OliphauntPackagedExtensionRegistry.resources[sqlName],
              sameExtensionResourceURL(existing.resourceRoot, resourceRoot)
        else {
            return
        }
        OliphauntPackagedExtensionRegistry.resources.removeValue(forKey: sqlName)
    }

    static func composedBundledResource(
        base: OliphauntRuntimeResources,
        containing requested: Set<String>,
        cacheRoot: URL
    ) throws -> OliphauntRuntimeResources? {
        guard !requested.isEmpty else {
            return base
        }
        let selected = try selectedPackagedExtensionResources(containing: requested)
        guard !selected.isEmpty else {
            return nil
        }
        let nonCreateRequested = requested.filter { selected[$0]?.createsExtension != true }.sorted()
        guard nonCreateRequested.isEmpty else {
            throw OliphauntError.engine(
                "SwiftPM product(s) \(nonCreateRequested.joined(separator: ",")) are not CREATE EXTENSION resources"
            )
        }

        let baseManifestURL = base.resourceRoot.appendingPathComponent("runtime/manifest.properties")
        var baseManifest = try packagedExtensionProperties(at: baseManifestURL)
        let baseExtensions = try packagedExtensionCSV(
            baseManifest["extensions"],
            label: "base runtime extensions"
        )
        guard baseExtensions.isEmpty else {
            throw OliphauntError.engine(
                "SwiftPM exact-extension composition requires an extension-free base runtime; " +
                    "\(baseManifestURL.path) contains \(baseExtensions.joined(separator: ","))"
            )
        }
        let baseCacheKey = try packagedExtensionPortableId(
            baseManifest["cacheKey"] ?? "",
            label: "base runtime cache key"
        )
        let cacheKey = composedCacheKey(baseCacheKey: baseCacheKey, selected: Array(selected.values))
        let container = cacheRoot
            .appendingPathComponent("swiftpm-composed-resources", isDirectory: true)
            .appendingPathComponent(cacheKey, isDirectory: true)
        let composedRoot = container.appendingPathComponent("oliphaunt", isDirectory: true)

        OliphauntPackagedExtensionRegistry.compositionLock.lock()
        defer { OliphauntPackagedExtensionRegistry.compositionLock.unlock() }
        if try composedResourceIsCurrent(
            composedRoot,
            cacheKey: cacheKey,
            extensions: Set(selected.values.filter(\.createsExtension).map(\.sqlName))
        ) {
            return OliphauntRuntimeResources(resourceRoot: composedRoot, cacheRoot: cacheRoot)
        }

        let parent = container.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        let temporaryContainer = parent.appendingPathComponent(
            ".\(cacheKey).tmp-\(UUID().uuidString)",
            isDirectory: true
        )
        let temporaryRoot = temporaryContainer.appendingPathComponent("oliphaunt", isDirectory: true)
        try? FileManager.default.removeItem(at: temporaryContainer)
        do {
            try copyPackagedExtensionTree(from: base.resourceRoot, to: temporaryRoot)
            let runtimeFiles = temporaryRoot.appendingPathComponent("runtime/files", isDirectory: true)
            for resource in selected.values.sorted(by: { $0.sqlName < $1.sqlName }) {
                for file in resource.files {
                    try mergePackagedExtensionFile(
                        from: file.source,
                        to: runtimeFiles.appendingPathComponent(file.relativePath)
                    )
                }
            }

            let createExtensions = selected.values.filter(\.createsExtension).map(\.sqlName).sorted()
            let nativeResources = selected.values.filter { $0.nativeModuleStem != nil }
            let nativeStems = nativeResources.compactMap(\.nativeModuleStem).sorted()
            let nativeExtensions = nativeResources.map(\.sqlName).sorted()
            let nativeDependencies = Set(nativeResources.flatMap(\.nativeDependencies)).sorted()
            let sharedPreload = Set(selected.values.flatMap(\.sharedPreloadLibraries)).sorted()
            baseManifest["cacheKey"] = cacheKey
            baseManifest["extensions"] = createExtensions.joined(separator: ",")
            baseManifest["sharedPreloadLibraries"] = sharedPreload.joined(separator: ",")
            baseManifest["mobileStaticRegistryState"] = nativeStems.isEmpty ? "not-required" : "complete"
            baseManifest["mobileStaticRegistryRegistered"] = nativeExtensions.joined(separator: ",")
            baseManifest["mobileStaticRegistryPending"] = ""
            baseManifest["nativeModuleStems"] = nativeStems.joined(separator: ",")
            baseManifest["mobileStaticRegistrySource"] = nativeStems.isEmpty ? "" : "swiftpm-linked-products"
            try writePackagedExtensionProperties(baseManifest, to: temporaryRoot.appendingPathComponent("runtime/manifest.properties"))
            try writeComposedStaticRegistryMetadata(
                at: temporaryRoot,
                extensions: nativeExtensions,
                stems: nativeStems,
                dependencies: nativeDependencies
            )
            try writeComposedPackageSizeReport(
                at: temporaryRoot,
                selected: Array(selected.values)
            )

            let candidate = OliphauntRuntimeResources(resourceRoot: temporaryRoot, cacheRoot: cacheRoot)
            guard try candidate.hasPackagedResources(containing: Set(createExtensions)) else {
                throw OliphauntError.engine("composed SwiftPM exact-extension resources failed validation")
            }
            _ = try candidate.sharedPreloadLibraries(requestedExtensions: createExtensions)

            if FileManager.default.fileExists(atPath: container.path) {
                try FileManager.default.removeItem(at: container)
            }
            try FileManager.default.moveItem(at: temporaryContainer, to: container)
        } catch {
            try? FileManager.default.removeItem(at: temporaryContainer)
            throw error
        }
        return OliphauntRuntimeResources(resourceRoot: composedRoot, cacheRoot: cacheRoot)
    }

    static func isExtensionFreeBaseResource(
        _ resources: OliphauntRuntimeResources
    ) throws -> Bool {
        let manifest = try packagedExtensionProperties(
            at: resources.resourceRoot.appendingPathComponent("runtime/manifest.properties")
        )
        return try packagedExtensionCSV(
            manifest["extensions"],
            label: "base runtime extensions"
        ).isEmpty
    }
}

private func readPackagedExtensionResource(
    at resourceRoot: URL,
    product: String,
    version: String,
    sqlName: String,
    dependencies: [String],
    nativeModuleStem: String?,
    nativeDependencies: [String],
    sharedPreloadLibraries: [String]
) throws -> OliphauntPackagedExtensionResource {
    let standardizedRoot = resourceRoot.standardizedFileURL.resolvingSymlinksInPath()
    let rootValues = try standardizedRoot.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else {
        throw OliphauntError.engine(
            "SwiftPM exact-extension resource root is not a directory: \(resourceRoot.path)"
        )
    }
    let rootEntries = try FileManager.default.contentsOfDirectory(
        at: standardizedRoot,
        includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey],
        options: []
    )
    let allowedRootEntries = Set(["files", "manifest.properties"])
    let actualRootEntries = Set(rootEntries.map(\.lastPathComponent))
    guard actualRootEntries == allowedRootEntries else {
        let unexpected = actualRootEntries.subtracting(allowedRootEntries).sorted()
        let missing = allowedRootEntries.subtracting(actualRootEntries).sorted()
        throw OliphauntError.engine(
            "SwiftPM exact-extension resource root must contain only files and manifest.properties; " +
                "missing=\(missing.joined(separator: ",")) unexpected=\(unexpected.joined(separator: ","))"
        )
    }
    for entry in rootEntries {
        let values = try entry.resourceValues(
            forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
        )
        guard values.isSymbolicLink != true else {
            throw OliphauntError.engine(
                "SwiftPM exact-extension resource root contains a symlink: \(entry.path)"
            )
        }
        if entry.lastPathComponent == "files" {
            guard values.isDirectory == true else {
                throw OliphauntError.engine("SwiftPM exact-extension files entry is not a directory")
            }
        } else if values.isRegularFile != true {
            throw OliphauntError.engine("SwiftPM exact-extension manifest is not a regular file")
        }
    }
    let manifestURL = standardizedRoot.appendingPathComponent("manifest.properties")
    let manifest = try packagedExtensionProperties(at: manifestURL)
    let allowedKeys: Set<String> = [
        "schema", "product", "version", "sqlName", "createsExtension", "dependencies",
        "nativeModuleStem", "nativeDependencies", "sharedPreloadLibraries", "files",
    ]
    let unsupported = Set(manifest.keys).subtracting(allowedKeys).sorted()
    guard unsupported.isEmpty else {
        throw OliphauntError.engine(
            "SwiftPM exact-extension resource \(manifestURL.path) contains unsupported fields: " +
                unsupported.joined(separator: ",")
        )
    }
    try requirePackagedExtensionProperty(manifest, key: "schema", expected: "oliphaunt-swift-extension-resource-v1", source: manifestURL)
    try requirePackagedExtensionProperty(manifest, key: "product", expected: product, source: manifestURL)
    try requirePackagedExtensionProperty(manifest, key: "version", expected: version, source: manifestURL)
    try requirePackagedExtensionProperty(manifest, key: "sqlName", expected: sqlName, source: manifestURL)
    try requirePackagedExtensionProperty(manifest, key: "dependencies", expected: dependencies.joined(separator: ","), source: manifestURL)
    try requirePackagedExtensionProperty(manifest, key: "nativeModuleStem", expected: nativeModuleStem ?? "", source: manifestURL)
    try requirePackagedExtensionProperty(
        manifest,
        key: "nativeDependencies",
        expected: nativeDependencies.joined(separator: ","),
        source: manifestURL
    )
    try requirePackagedExtensionProperty(
        manifest,
        key: "sharedPreloadLibraries",
        expected: sharedPreloadLibraries.joined(separator: ","),
        source: manifestURL
    )
    try requirePackagedExtensionProperty(manifest, key: "files", expected: "files", source: manifestURL)
    let createsExtension: Bool
    switch manifest["createsExtension"] {
    case "yes": createsExtension = true
    case "no": createsExtension = false
    default:
        throw OliphauntError.engine(
            "SwiftPM exact-extension resource \(manifestURL.path) createsExtension must be yes or no"
        )
    }

    let filesRoot = standardizedRoot.appendingPathComponent("files", isDirectory: true)
    let files = try packagedExtensionFiles(in: filesRoot)
    if createsExtension {
        let control = "share/postgresql/extension/\(sqlName).control"
        let installPrefix = "share/postgresql/extension/\(sqlName)--"
        guard files.contains(where: { $0.relativePath == control }) else {
            throw OliphauntError.engine(
                "SwiftPM exact-extension resource \(sqlName) is missing \(control)"
            )
        }
        guard files.contains(where: {
            $0.relativePath.hasPrefix(installPrefix) && $0.relativePath.hasSuffix(".sql")
        }) else {
            throw OliphauntError.engine(
                "SwiftPM exact-extension resource \(sqlName) is missing an install SQL file"
            )
        }
    }
    var fingerprintParts = [
        product,
        version,
        sqlName,
        dependencies.joined(separator: ","),
        nativeModuleStem ?? "",
        nativeDependencies.joined(separator: ","),
        sharedPreloadLibraries.joined(separator: ","),
        createsExtension ? "yes" : "no",
    ]
    for file in files {
        fingerprintParts.append(file.relativePath)
        fingerprintParts.append(String(file.bytes))
        fingerprintParts.append(try Data(contentsOf: file.source).base64EncodedString())
    }
    let fingerprint = packagedExtensionFingerprint(fingerprintParts)
    return OliphauntPackagedExtensionResource(
        product: product,
        version: version,
        sqlName: sqlName,
        createsExtension: createsExtension,
        dependencies: dependencies,
        nativeModuleStem: nativeModuleStem,
        nativeDependencies: nativeDependencies,
        sharedPreloadLibraries: sharedPreloadLibraries,
        resourceRoot: standardizedRoot,
        files: files,
        fingerprint: fingerprint
    )
}

private func selectedPackagedExtensionResources(
    containing requested: Set<String>
) throws -> [String: OliphauntPackagedExtensionResource] {
    OliphauntPackagedExtensionRegistry.lock.lock()
    let available = OliphauntPackagedExtensionRegistry.resources
    OliphauntPackagedExtensionRegistry.lock.unlock()
    var selected: [String: OliphauntPackagedExtensionResource] = [:]
    var visiting = Set<String>()

    func visit(_ sqlName: String, requiredBy: String?) throws {
        if selected[sqlName] != nil { return }
        guard visiting.insert(sqlName).inserted else {
            throw OliphauntError.engine(
                "SwiftPM exact-extension dependency cycle includes \(sqlName)"
            )
        }
        guard let resource = available[sqlName] else {
            let suffix = requiredBy.map { "; required by \($0)" } ?? ""
            throw OliphauntError.engine(
                "SwiftPM exact-extension product for \(sqlName) was not registered before database open\(suffix)"
            )
        }
        for dependency in resource.dependencies {
            try visit(dependency, requiredBy: sqlName)
        }
        visiting.remove(sqlName)
        selected[sqlName] = resource
    }
    for sqlName in requested.sorted() {
        try visit(sqlName, requiredBy: nil)
    }
    return selected
}

private func packagedExtensionProperties(at url: URL) throws -> [String: String] {
    let text = try String(contentsOf: url, encoding: .utf8)
    var values: [String: String] = [:]
    for (index, rawLine) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
        let line = String(rawLine).trimmingCharacters(in: .whitespacesAndNewlines)
        if line.isEmpty || line.hasPrefix("#") { continue }
        guard let separator = line.firstIndex(of: "=") else {
            throw OliphauntError.engine("\(url.path):\(index + 1) is not a key=value property")
        }
        let key = String(line[..<separator]).trimmingCharacters(in: .whitespaces)
        let value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
        guard values.updateValue(value, forKey: key) == nil else {
            throw OliphauntError.engine("\(url.path):\(index + 1) repeats property \(key)")
        }
    }
    return values
}

private func requirePackagedExtensionProperty(
    _ values: [String: String],
    key: String,
    expected: String,
    source: URL
) throws {
    guard values[key] == expected else {
        throw OliphauntError.engine(
            "SwiftPM exact-extension resource \(source.path) must declare \(key)=\(expected); " +
                "got \(values[key] ?? "<missing>")"
        )
    }
}

private func packagedExtensionCSV(_ value: String?, label: String) throws -> [String] {
    guard let value, !value.isEmpty else { return [] }
    return try OliphauntRuntimeResources.normalizedPortableIds(
        value.split(separator: ",").map(String.init),
        label: label
    ).sorted()
}

private func packagedExtensionPortableId(_ value: String, label: String) throws -> String {
    guard OliphauntRuntimeResources.isPortableId(value) else {
        throw OliphauntError.engine(
            "SwiftPM exact-extension \(label) '\(value)' must contain only portable identifier characters"
        )
    }
    return value
}

private func packagedExtensionFiles(
    in root: URL
) throws -> [OliphauntPackagedExtensionResource.File] {
    let standardizedRoot = root.standardizedFileURL
    let rootPath = standardizedRoot.path.hasSuffix("/") ? standardizedRoot.path : "\(standardizedRoot.path)/"
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory),
          isDirectory.boolValue
    else {
        throw OliphauntError.engine("SwiftPM exact-extension resource is missing files directory: \(root.path)")
    }
    var files: [OliphauntPackagedExtensionResource.File] = []
    guard let enumerator = FileManager.default.enumerator(
        at: root,
        includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey],
        options: []
    ) else {
        throw OliphauntError.engine("could not enumerate SwiftPM exact-extension resources at \(root.path)")
    }
    for case let url as URL in enumerator {
        let values = try url.resourceValues(
            forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
        )
        guard values.isSymbolicLink != true else {
            throw OliphauntError.engine("SwiftPM exact-extension resources contain a symlink: \(url.path)")
        }
        if values.isDirectory == true { continue }
        guard values.isRegularFile == true else {
            throw OliphauntError.engine("SwiftPM exact-extension resources contain an unsupported entry: \(url.path)")
        }
        let standardizedPath = url.standardizedFileURL.path
        guard standardizedPath.hasPrefix(rootPath) else {
            throw OliphauntError.engine(
                "SwiftPM exact-extension resource file is outside resource root: \(url.path)"
            )
        }
        let relative = String(standardizedPath.dropFirst(rootPath.count))
        guard relative.hasPrefix("share/postgresql/"), !relative.contains("../") else {
            throw OliphauntError.engine(
                "SwiftPM exact-extension resource file is outside share/postgresql: \(relative)"
            )
        }
        files.append(.init(
            source: url,
            relativePath: relative,
            bytes: UInt64(values.fileSize ?? 0)
        ))
    }
    return files.sorted { $0.relativePath < $1.relativePath }
}

private func composedCacheKey(
    baseCacheKey: String,
    selected: [OliphauntPackagedExtensionResource]
) -> String {
    packagedExtensionFingerprint(
        [baseCacheKey] + selected.sorted(by: { $0.sqlName < $1.sqlName }).flatMap {
            [$0.product, $0.version, $0.sqlName, $0.fingerprint]
        }
    )
}

private func packagedExtensionFingerprint(_ values: [String]) -> String {
    var hash: UInt64 = 14_695_981_039_346_656_037
    for byte in values.joined(separator: "\u{1f}").utf8 {
        hash ^= UInt64(byte)
        hash = hash &* 1_099_511_628_211
    }
    return "swiftpm-\(String(hash, radix: 16))"
}

private func sameExtensionResourceURL(_ left: URL, _ right: URL) -> Bool {
    left.standardizedFileURL.resolvingSymlinksInPath().path ==
        right.standardizedFileURL.resolvingSymlinksInPath().path
}

private func copyPackagedExtensionTree(from source: URL, to destination: URL) throws {
    let values = try source.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey])
    guard values.isSymbolicLink != true else {
        throw OliphauntError.engine("refusing to compose a symlink from \(source.path)")
    }
    if values.isDirectory == true {
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        for child in try FileManager.default.contentsOfDirectory(
            at: source,
            includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey],
            options: []
        ).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            try copyPackagedExtensionTree(
                from: child,
                to: destination.appendingPathComponent(child.lastPathComponent)
            )
        }
    } else if values.isRegularFile == true {
        try FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.copyItem(at: source, to: destination)
    } else {
        throw OliphauntError.engine("unsupported resource entry while composing \(source.path)")
    }
}

private func mergePackagedExtensionFile(from source: URL, to destination: URL) throws {
    if FileManager.default.fileExists(atPath: destination.path) {
        guard try Data(contentsOf: source) == Data(contentsOf: destination) else {
            throw OliphauntError.engine(
                "selected SwiftPM extension resources conflict at \(destination.path)"
            )
        }
        return
    }
    try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try FileManager.default.copyItem(at: source, to: destination)
}

private func writePackagedExtensionProperties(
    _ properties: [String: String],
    to destination: URL
) throws {
    let preferred = [
        "schema", "layout", "cacheKey", "source", "extensions", "runtimeFeatures",
        "sharedPreloadLibraries", "mobileStaticRegistryState", "mobileStaticRegistryRegistered",
        "mobileStaticRegistryPending", "nativeModuleStems", "mobileStaticRegistrySource",
    ]
    let preferredSet = Set(preferred)
    let keys = preferred.filter { properties[$0] != nil } + properties.keys.filter {
        !preferredSet.contains($0)
    }.sorted()
    try (keys.map { "\($0)=\(properties[$0]!)" }.joined(separator: "\n") + "\n").write(
        to: destination,
        atomically: true,
        encoding: .utf8
    )
}

private func writeComposedStaticRegistryMetadata(
    at resourceRoot: URL,
    extensions: [String],
    stems: [String],
    dependencies: [String]
) throws {
    let directory = resourceRoot.appendingPathComponent("static-registry", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let values = [
        "packageLayout=oliphaunt-static-registry-v1",
        "abiVersion=1",
        "state=\(stems.isEmpty ? "not-required" : "complete")",
        "source=\(stems.isEmpty ? "" : "swiftpm-linked-products")",
        "registeredExtensions=\(extensions.joined(separator: ","))",
        "pendingExtensions=",
        "nativeModuleStems=\(stems.joined(separator: ","))",
        "modules=\(stems.joined(separator: ","))",
        "archiveTargets=\(stems.isEmpty ? "" : "swiftpm-linked-products")",
        "dependencyArchiveTargets=\(dependencies.isEmpty ? "" : "swiftpm-linked-products")",
        "dependencyArchives=\(dependencies.joined(separator: ","))",
        "",
    ]
    try values.joined(separator: "\n").write(
        to: directory.appendingPathComponent("manifest.properties"),
        atomically: true,
        encoding: .utf8
    )
}

private func writeComposedPackageSizeReport(
    at resourceRoot: URL,
    selected: [OliphauntPackagedExtensionResource]
) throws {
    let runtime = try packagedTreeSize(resourceRoot.appendingPathComponent("runtime", isDirectory: true))
    let template = try packagedTreeSize(resourceRoot.appendingPathComponent("template-pgdata", isDirectory: true))
    let registry = try packagedTreeSize(resourceRoot.appendingPathComponent("static-registry", isDirectory: true))
    let extensionRows = selected.sorted(by: { $0.sqlName < $1.sqlName }).map { resource in
        let bytes = resource.files.reduce(UInt64(0)) { $0 + $1.bytes }
        return "extension\t\(resource.sqlName)\t-\t\(resource.files.count)\t\(bytes)"
    }
    let selectedBytes = selected.flatMap(\.files).reduce(UInt64(0)) { $0 + $1.bytes }
    let extensions = selected.filter(\.createsExtension).map(\.sqlName).sorted().joined(separator: ",")
    let rows = [
        "kind\tid\textensions\tfiles\tbytes",
        "package\ttotal\t\(extensions.isEmpty ? "-" : extensions)\t\(runtime.files + template.files + registry.files)\t\(runtime.bytes + template.bytes + registry.bytes)",
        "package\truntime\t\(extensions.isEmpty ? "-" : extensions)\t\(runtime.files)\t\(runtime.bytes)",
        "package\ttemplate-pgdata\t-\t\(template.files)\t\(template.bytes)",
        "package\tstatic-registry\t\(extensions.isEmpty ? "-" : extensions)\t\(registry.files)\t\(registry.bytes)",
        "extensions\tselected\t\(extensions.isEmpty ? "-" : extensions)\t\(selected.flatMap(\.files).count)\t\(selectedBytes)",
    ] + extensionRows + [""]
    try rows.joined(separator: "\n").write(
        to: resourceRoot.appendingPathComponent("package-size.tsv"),
        atomically: true,
        encoding: .utf8
    )
}

private func packagedTreeSize(_ root: URL) throws -> (files: Int, bytes: UInt64) {
    guard FileManager.default.fileExists(atPath: root.path) else { return (0, 0) }
    var count = 0
    var bytes: UInt64 = 0
    guard let enumerator = FileManager.default.enumerator(
        at: root,
        includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey],
        options: []
    ) else { return (0, 0) }
    for case let url as URL in enumerator {
        let values = try url.resourceValues(
            forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
        )
        guard values.isSymbolicLink != true else {
            throw OliphauntError.engine("composed SwiftPM resources contain a symlink: \(url.path)")
        }
        if values.isRegularFile == true {
            count += 1
            bytes += UInt64(values.fileSize ?? 0)
        }
    }
    return (count, bytes)
}

private func composedResourceIsCurrent(
    _ resourceRoot: URL,
    cacheKey: String,
    extensions: Set<String>
) throws -> Bool {
    guard FileManager.default.fileExists(atPath: resourceRoot.path) else { return false }
    let manifest = try? packagedExtensionProperties(
        at: resourceRoot.appendingPathComponent("runtime/manifest.properties")
    )
    guard manifest?["cacheKey"] == cacheKey else { return false }
    let resources = OliphauntRuntimeResources(resourceRoot: resourceRoot)
    return (try? resources.hasPackagedResources(containing: extensions)) == true
}
