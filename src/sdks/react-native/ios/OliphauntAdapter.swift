import Foundation
import Oliphaunt
import Darwin

@objc(OliphauntAdapterDatabase)
public final class OliphauntAdapterDatabase: NSObject, @unchecked Sendable {
    private static let errorDomain = "dev.oliphaunt.reactnative.ios"

    private let database: OliphauntDatabase

    private init(database: OliphauntDatabase) {
        self.database = database
    }

    @objc(openWithConfig:completion:)
    public static func open(
        config: NSDictionary,
        completion: @escaping (OliphauntAdapterDatabase?, NSError?) -> Void
    ) {
        let parsed: ParsedOpenConfig
        do {
            parsed = try parseOpenConfig(config)
        } catch {
            completion(nil, nsError(error))
            return
        }
        let completionBox = CompletionBox(completion)
        Task.detached(priority: .userInitiated) {
            do {
                let database = try await OliphauntDatabase.open(
                    configuration: parsed.configuration,
                    engine: parsed.engine
                )
                completionBox.value(OliphauntAdapterDatabase(database: database), nil)
            } catch {
                completionBox.value(nil, nsError(error))
            }
        }
    }

    @objc(supportedModesWithCompletion:)
    public static func supportedModes(
        completion: @escaping (NSArray?, NSError?) -> Void
    ) {
        let modes = OliphauntDatabase.supportedModes().map(modeSupportDictionary)
        completion(modes as NSArray, nil)
    }

    @objc(packageSizeReportWithConfig:completion:)
    public static func packageSizeReport(
        config: NSDictionary,
        completion: @escaping (NSDictionary?, NSError?) -> Void
    ) {
        do {
            let report = try runtimeResources(config: config)?.packageSizeReport()
            completion(report.map(packageSizeReportDictionary), nil)
        } catch {
            completion(nil, nsError(error))
        }
    }

    @objc(processMemoryWithCompletion:)
    public static func processMemory(
        completion: @escaping (NSDictionary?, NSError?) -> Void
    ) {
        completion(processMemoryDictionary(), nil)
    }

    @objc(restoreWithRoot:format:artifactData:replaceExisting:libraryPath:completion:)
    public static func restore(
        root: String,
        format: String,
        artifactData: Data,
        replaceExisting: Bool,
        libraryPath: String?,
        completion: @escaping (NSString?, NSError?) -> Void
    ) {
        let request: OliphauntRestoreRequest
        let engine: OliphauntNativeDirectEngine
        do {
            guard !root.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw adapterError("restore root must not be empty")
            }
            let backupFormat = try parseBackupFormat(format)
            guard backupFormat == .physicalArchive else {
                throw adapterError("React Native iOS restore currently requires physicalArchive")
            }
            request = OliphauntRestoreRequest(
                artifact: OliphauntBackupArtifact(format: backupFormat, bytes: artifactData),
                root: URL(fileURLWithPath: root, isDirectory: true),
                targetPolicy: replaceExisting ? .replaceExisting : .failIfExists
            )
            let config = NSMutableDictionary()
            if let libraryPath = try nonBlankValue(
                libraryPath,
                "libraryPath",
                emptyMessage: "libraryPath must not be empty"
            ) {
                config["libraryPath"] = libraryPath
            }
            engine = try nativeDirectEngine(config: config, username: nil, database: nil)
        } catch {
            completion(nil, nsError(error))
            return
        }
        let completionBox = CompletionBox(completion)
        Task.detached(priority: .userInitiated) {
            do {
                let restored = try await OliphauntDatabase.restore(request, engine: engine)
                completionBox.value(restored.path as NSString, nil)
            } catch {
                completionBox.value(nil, nsError(error))
            }
        }
    }

    @objc(execProtocolData:completion:)
    public func execProtocolData(
        _ request: Data,
        completion: @escaping (NSData?, NSError?) -> Void
    ) {
        let completionBox = CompletionBox(completion)
        Task.detached(priority: .userInitiated) { [database] in
            do {
                let response = try await database.execProtocolRaw(request)
                completionBox.value(response as NSData, nil)
            } catch {
                completionBox.value(nil, Self.nsError(error))
            }
        }
    }

    @objc(execProtocolStreamData:onChunk:completion:)
    public func execProtocolStreamData(
        _ request: Data,
        onChunk: @escaping (NSData) -> Void,
        completion: @escaping (NSError?) -> Void
    ) {
        let completionBox = CompletionBox(completion)
        let chunkBox = CompletionBox(onChunk)
        Task.detached(priority: .userInitiated) { [database] in
            do {
                try await database.execProtocolStream(request) { chunk in
                    chunkBox.value(chunk as NSData)
                }
                completionBox.value(nil)
            } catch {
                completionBox.value(Self.nsError(error))
            }
        }
    }

    @objc(backupDataWithFormat:completion:)
    public func backupData(
        format: String,
        completion: @escaping (NSData?, NSError?) -> Void
    ) {
        let request: OliphauntBackupRequest
        do {
            request = OliphauntBackupRequest(format: try Self.parseBackupFormat(format))
        } catch {
            completion(nil, Self.nsError(error))
            return
        }
        let completionBox = CompletionBox(completion)
        Task.detached(priority: .userInitiated) { [database] in
            do {
                let artifact = try await database.backup(request)
                completionBox.value(artifact.bytes as NSData, nil)
            } catch {
                completionBox.value(nil, Self.nsError(error))
            }
        }
    }

    @objc(cancelWithCompletion:)
    public func cancel(completion: @escaping (NSError?) -> Void) {
        let completionBox = CompletionBox(completion)
        Task.detached(priority: .userInitiated) { [database] in
            do {
                try await database.cancel()
                completionBox.value(nil)
            } catch {
                completionBox.value(Self.nsError(error))
            }
        }
    }

    @objc(closeWithCompletion:)
    public func close(completion: @escaping (NSError?) -> Void) {
        let completionBox = CompletionBox(completion)
        Task.detached(priority: .userInitiated) { [database] in
            do {
                try await database.close()
                completionBox.value(nil)
            } catch {
                completionBox.value(Self.nsError(error))
            }
        }
    }

    @objc(capabilitiesWithCompletion:)
    public func capabilities(completion: @escaping (NSDictionary?, NSError?) -> Void) {
        let completionBox = CompletionBox(completion)
        Task.detached(priority: .userInitiated) { [database] in
            do {
                let capabilities = try await database.capabilities()
                completionBox.value(Self.capabilitiesDictionary(capabilities), nil)
            } catch {
                completionBox.value(nil, Self.nsError(error))
            }
        }
    }

    private struct CompletionBox<Value>: @unchecked Sendable {
        let value: Value

        init(_ value: Value) {
            self.value = value
        }
    }

    private struct ParsedOpenConfig {
        var configuration: OliphauntConfiguration
        var engine: OliphauntNativeDirectEngine
    }

    private static func parseOpenConfig(_ config: NSDictionary) throws -> ParsedOpenConfig {
        let mode = try parseEngineMode(try string(config, "engine") ?? "nativeDirect")
        guard mode == .nativeDirect else {
            throw adapterError("React Native iOS currently supports nativeDirect, got \(mode.rawValue)")
        }
        let configuredRoot = try nonBlankString(
            config,
            "root",
            emptyMessage: "database root must not be empty"
        )
        let root = try configuredRoot.map { try resolveRootSpecifier($0) }
        let username = try startupIdentity(config, "username")
        let database = try startupIdentity(config, "database")
        let extensions = try stringArray(config, "extensions")
        let configuration = OliphauntConfiguration(
            mode: mode,
            root: root,
            durability: try parseDurability(try string(config, "durability") ?? "balanced"),
            runtimeFootprint: try parseRuntimeFootprint(
                try string(config, "runtimeFootprint") ?? "balancedMobile"
            ),
            startupGUCs: try startupGUCs(config, "startupGUCs"),
            username: username,
            database: database,
            extensions: extensions
        )
        return ParsedOpenConfig(
            configuration: configuration,
            engine: try nativeDirectEngine(
                config: config,
                username: username,
                database: database,
                extensions: extensions
            )
        )
    }

    private static func modeSupportDictionary(_ support: OliphauntEngineModeSupport) -> NSDictionary {
        let values = NSMutableDictionary()
        values["engine"] = support.mode.rawValue
        values["available"] = support.available
        values["capabilities"] = capabilitiesDictionary(support.capabilities)
        if let unavailableReason = support.unavailableReason {
            values["unavailableReason"] = unavailableReason
        }
        return values
    }

    private static func capabilitiesDictionary(_ capabilities: OliphauntCapabilities) -> NSDictionary {
        let values = NSMutableDictionary()
        values["engine"] = capabilities.mode.rawValue
        values["processIsolated"] = capabilities.processIsolated
        values["multiRoot"] = capabilities.multiRoot
        values["reopenable"] = capabilities.reopenable
        values["sameRootLogicalReopen"] = capabilities.sameRootLogicalReopen
        values["rootSwitchable"] = capabilities.rootSwitchable
        values["crashRestartable"] = capabilities.crashRestartable
        values["independentSessions"] = capabilities.independentSessions
        values["maxClientSessions"] = capabilities.maxClientSessions
        values["protocolRaw"] = capabilities.protocolRaw
        values["protocolStream"] = capabilities.protocolStream
        values["queryCancel"] = capabilities.queryCancel
        values["backupRestore"] = capabilities.backupRestore
        values["backupFormats"] = capabilities.backupFormats.map(\.rawValue)
        values["restoreFormats"] = capabilities.restoreFormats.map(\.rawValue)
        values["simpleQuery"] = capabilities.simpleQuery
        values["extensions"] = capabilities.extensions
        values["rawProtocolTransport"] = "jsi-array-buffer"
        if let connectionString = capabilities.connectionString {
            values["connectionString"] = connectionString
        }
        return values
    }

    private static func packageSizeReportDictionary(
        _ report: OliphauntRuntimeResourceSizeReport
    ) -> NSDictionary {
        let values = NSMutableDictionary()
        values["packageBytes"] = NSNumber(value: report.packageBytes)
        values["runtimeBytes"] = NSNumber(value: report.runtimeBytes)
        values["templatePgdataBytes"] = NSNumber(value: report.templatePgdataBytes)
        values["staticRegistryBytes"] = NSNumber(value: report.staticRegistryBytes)
        values["selectedExtensionBytes"] = NSNumber(value: report.selectedExtensionBytes)
        values["extensions"] = report.extensions.map(extensionSizeReportDictionary)
        if let state = report.mobileStaticRegistryState {
            values["mobileStaticRegistryState"] = state
        }
        values["mobileStaticRegistryRegistered"] = report.mobileStaticRegistryRegistered
        values["mobileStaticRegistryPending"] = report.mobileStaticRegistryPending
        values["nativeModuleStems"] = report.nativeModuleStems
        values["runtimeFeatures"] = report.runtimeFeatures
        return values
    }

    private static func extensionSizeReportDictionary(
        _ report: OliphauntExtensionSizeReport
    ) -> NSDictionary {
        let values = NSMutableDictionary()
        values["name"] = report.name
        values["fileCount"] = report.fileCount
        values["bytes"] = NSNumber(value: report.bytes)
        return values
    }

    private static func processMemoryDictionary() -> NSDictionary {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
        )
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
            }
        }
        if status == KERN_SUCCESS {
            let values = NSMutableDictionary()
            values["source"] = "ios-task-vm-info"
            values["residentBytes"] = NSNumber(value: info.resident_size)
            values["physicalFootprintBytes"] = NSNumber(value: info.phys_footprint)
            values["virtualBytes"] = NSNumber(value: info.virtual_size)
            values["peakResidentBytes"] = NSNumber(value: info.resident_size_peak)
            return values
        }

        var basic = task_basic_info_64_data_t()
        var basicCount = mach_msg_type_number_t(
            MemoryLayout<task_basic_info_64_data_t>.size / MemoryLayout<natural_t>.size
        )
        let basicStatus = withUnsafeMutablePointer(to: &basic) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(basicCount)) { rebound in
                task_info(mach_task_self_, task_flavor_t(TASK_BASIC_INFO_64), rebound, &basicCount)
            }
        }
        let values = NSMutableDictionary()
        values["source"] = "ios-task-basic-info-64"
        if basicStatus == KERN_SUCCESS {
            values["residentBytes"] = NSNumber(value: basic.resident_size)
            values["virtualBytes"] = NSNumber(value: basic.virtual_size)
        }
        return values
    }

    private static func nativeDirectEngine(
        config: NSDictionary,
        username: String?,
        database: String?,
        extensions: [String] = []
    ) throws -> OliphauntNativeDirectEngine {
        let resources = try runtimeResources(config: config, requestedExtensions: extensions)
        return OliphauntNativeDirectEngine(
            libraryURL: try libraryURL(config: config, resources: resources),
            runtimeDirectory: urlFromPath(
                try nonBlankString(
                    config,
                    "runtimeDirectory",
                    emptyMessage: "runtimeDirectory must not be empty"
                )
                    ?? env("OLIPHAUNT_REACT_NATIVE_IOS_RUNTIME_DIR")
                    ?? env("OLIPHAUNT_SWIFT_RUNTIME_DIR")
                    ?? env("OLIPHAUNT_INSTALL_DIR")
                    ?? env("OLIPHAUNT_RUNTIME_DIR")
            ),
            runtimeResources: resources,
            username: username ?? "postgres",
            database: database ?? "postgres"
        )
    }

    private static func libraryURL(
        config: NSDictionary,
        resources: OliphauntRuntimeResources?
    ) throws -> URL? {
        if let configured = try nonBlankString(
            config,
            "libraryPath",
            emptyMessage: "libraryPath must not be empty"
        )
            ?? env("OLIPHAUNT_REACT_NATIVE_IOS_LIBRARY")
            ?? env("OLIPHAUNT_SWIFT_LIBRARY")
            ?? env("LIBOLIPHAUNT_PATH")
            ?? env("OLIPHAUNT_LIBRARY")
        {
            return URL(fileURLWithPath: configured, isDirectory: false)
        }
        if let resources,
           let bundled = bundledLibraryURL(inResourceRoot: resources.resourceRoot) {
            return bundled
        }
        return bundledLibraryURLFromBundles()
    }

    private static func runtimeResources(
        config: NSDictionary,
        requestedExtensions: [String] = []
    ) throws -> OliphauntRuntimeResources? {
        let configured = try nonBlankString(
            config,
            "resourceRoot",
            emptyMessage: "resourceRoot must not be empty"
        ) ?? nonBlankString(
            config,
            "iosResourceRoot",
            emptyMessage: "resourceRoot must not be empty"
        )
        if let configured {
            return OliphauntRuntimeResources(
                resourceRoot: URL(fileURLWithPath: configured, isDirectory: true),
                cacheRoot: cacheRoot()
            )
        }

        if let bundled = try bundledRuntimeResourcesFromKnownBundles(
            containing: requestedExtensions
        ) {
            return bundled
        }

        return try OliphauntRuntimeResources.bundled(
            containing: requestedExtensions,
            cacheRoot: cacheRoot()
        )
    }

    private static func bundledRuntimeResourcesFromKnownBundles(
        containing requestedExtensions: [String]
    ) throws -> OliphauntRuntimeResources? {
        for bundle in candidateRuntimeResourceBundles() {
            let resources = try OliphauntRuntimeResources(bundle: bundle, cacheRoot: cacheRoot())
            if try resourcesContainPackagedAssets(
                resources,
                requestedExtensions: requestedExtensions
            ) {
                return resources
            }
        }
        return nil
    }

    private static func candidateRuntimeResourceBundles() -> [Bundle] {
        let candidates = [
            Bundle.main,
            Bundle(for: OliphauntAdapterDatabase.self)
        ] + explicitResourceBundles()

        var seen = Set<String>()
        var bundles: [Bundle] = []
        for bundle in candidates {
            let key = (bundle.bundleURL.standardizedFileURL.path as NSString).standardizingPath
            if seen.insert(key).inserted {
                bundles.append(bundle)
            }
        }
        return bundles
    }

    private static func explicitResourceBundles() -> [Bundle] {
        ["OliphauntReactNativeResources", "OliphauntResources"].compactMap { bundleName in
            guard let bundleURL = Bundle.main.url(
                forResource: bundleName,
                withExtension: "bundle"
            ) else {
                return nil
            }
            return Bundle(url: bundleURL)
        }
    }

    private static func resourcesContainPackagedAssets(
        _ resources: OliphauntRuntimeResources,
        requestedExtensions: [String]
    ) throws -> Bool {
        let runtimeManifest = resources.resourceRoot.appendingPathComponent(
            "runtime/manifest.properties",
            isDirectory: false
        )
        let templateManifest = resources.resourceRoot.appendingPathComponent(
            "template-pgdata/manifest.properties",
            isDirectory: false
        )
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: runtimeManifest.path) ||
            fileManager.fileExists(atPath: templateManifest.path)
        else {
            return false
        }
        guard !requestedExtensions.isEmpty else {
            return true
        }
        guard fileManager.fileExists(atPath: runtimeManifest.path) else {
            return false
        }
        let manifest = try manifestProperties(at: runtimeManifest)
        let available = Set(
            (manifest["extensions"] ?? "")
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        )
        return Set(requestedExtensions).isSubset(of: available)
    }

    private static func manifestProperties(at url: URL) throws -> [String: String] {
        let contents = try String(contentsOf: url, encoding: .utf8)
        var values: [String: String] = [:]
        for rawLine in contents.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("#") {
                continue
            }
            guard let separator = line.firstIndex(of: "=") else {
                continue
            }
            let key = line[..<separator].trimmingCharacters(in: .whitespacesAndNewlines)
            let value = line[line.index(after: separator)...]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            values[String(key)] = String(value)
        }
        return values
    }

    private static func bundledLibraryURLFromBundles() -> URL? {
        for bundle in [Bundle.main, Bundle(for: OliphauntAdapterDatabase.self)] {
            if let url = bundledLibraryURL(in: bundle) {
                return url
            }
        }
        for bundleName in ["OliphauntReactNativeResources", "OliphauntResources", "OliphauntResources"] {
            guard let bundleURL = Bundle.main.url(forResource: bundleName, withExtension: "bundle"),
                  let bundle = Bundle(url: bundleURL),
                  let url = bundledLibraryURL(in: bundle)
            else {
                continue
            }
            return url
        }
        return nil
    }

    private static func bundledLibraryURL(in bundle: Bundle) -> URL? {
        if let root = bundle.url(forResource: "oliphaunt", withExtension: nil),
           let url = bundledLibraryURL(inResourceRoot: root) {
            return url
        }
        if let url = bundle.url(forResource: "liboliphaunt", withExtension: "dylib") {
            return url
        }
        if let frameworkRoot = bundle.privateFrameworksURL,
           let url = bundledFrameworkExecutableURL(in: frameworkRoot) {
            return url
        }
        if let frameworkRoot = bundle.builtInPlugInsURL,
           let url = bundledFrameworkExecutableURL(in: frameworkRoot) {
            return url
        }
        return nil
    }

    private static func bundledLibraryURL(inResourceRoot root: URL) -> URL? {
        let candidates = [
            root.appendingPathComponent("lib/liboliphaunt.dylib", isDirectory: false),
            root.appendingPathComponent("liboliphaunt.dylib", isDirectory: false)
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private static func bundledFrameworkExecutableURL(in root: URL) -> URL? {
        let candidates = [
            root.appendingPathComponent("liboliphaunt.framework/liboliphaunt", isDirectory: false),
            root.appendingPathComponent("Oliphaunt.framework/Oliphaunt", isDirectory: false),
            root.appendingPathComponent("LibOliphaunt.framework/LibOliphaunt", isDirectory: false)
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private static func cacheRoot() -> URL {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory
        let root = base.appendingPathComponent("oliphaunt-react-native-ios", isDirectory: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableRoot = root
        try? mutableRoot.setResourceValues(values)
        return root
    }

    private static func parseEngineMode(_ value: String) throws -> OliphauntEngineMode {
        guard let mode = OliphauntEngineMode(rawValue: value) else {
            throw adapterError("unknown liboliphaunt engine '\(value)'")
        }
        return mode
    }

    private static func parseDurability(_ value: String) throws -> OliphauntDurability {
        guard let durability = OliphauntDurability(rawValue: value) else {
            throw adapterError("unknown liboliphaunt durability profile '\(value)'")
        }
        return durability
    }

    private static func parseRuntimeFootprint(_ value: String) throws -> OliphauntRuntimeFootprintProfile {
        guard let profile = OliphauntRuntimeFootprintProfile(rawValue: value) else {
            throw adapterError("unknown liboliphaunt runtime footprint profile '\(value)'")
        }
        return profile
    }

    private static func parseBackupFormat(_ value: String) throws -> OliphauntBackupFormat {
        guard let format = OliphauntBackupFormat(rawValue: value) else {
            throw adapterError("unknown liboliphaunt backup format '\(value)'")
        }
        return format
    }

    private static func string(_ dictionary: NSDictionary, _ key: String) throws -> String? {
        guard let raw = dictionary[key] else {
            return nil
        }
        guard !(raw is NSNull) else {
            return nil
        }
        guard let value = raw as? String else {
            throw adapterError("\(key) must be a string")
        }
        return value
    }

    private static func nonBlankString(
        _ dictionary: NSDictionary,
        _ key: String,
        emptyMessage: String
    ) throws -> String? {
        return try nonBlankValue(try string(dictionary, key), key, emptyMessage: emptyMessage)
    }

    private static func nonBlankValue(
        _ value: String?,
        _ key: String,
        emptyMessage: String
    ) throws -> String? {
        guard let value else {
            return nil
        }
        if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw adapterError(emptyMessage)
        }
        if value.utf8.contains(0) {
            throw adapterError("\(key) must not contain NUL bytes")
        }
        return value
    }

    private static func resolveRootSpecifier(_ value: String) throws -> URL {
        if let suffix = value.removingPrefix("app-support://") {
            return try sandboxRoot(base: .applicationSupportDirectory, suffix: suffix)
        }
        if let suffix = value.removingPrefix("documents://") {
            return try sandboxRoot(base: .documentDirectory, suffix: suffix)
        }
        return URL(fileURLWithPath: value, isDirectory: true)
    }

    private static func sandboxRoot(
        base: FileManager.SearchPathDirectory,
        suffix: String
    ) throws -> URL {
        let components = try validatedSandboxRootComponents(suffix)
        guard let baseURL = FileManager.default.urls(for: base, in: .userDomainMask).first else {
            throw adapterError("failed to resolve app sandbox directory for database root")
        }
        return components.reduce(baseURL.appendingPathComponent("Oliphaunt", isDirectory: true)) {
            $0.appendingPathComponent($1, isDirectory: true)
        }
    }

    private static func validatedSandboxRootComponents(_ suffix: String) throws -> [String] {
        let trimmed = suffix.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmed.isEmpty {
            throw adapterError("database root sandbox specifier must include a relative path")
        }
        let components = trimmed.split(separator: "/").map(String.init)
        if components.contains(where: { $0 == "." || $0 == ".." }) {
            throw adapterError("database root sandbox specifier must not contain '.' or '..'")
        }
        return components
    }

    private static func startupIdentity(_ dictionary: NSDictionary, _ key: String) throws -> String? {
        guard let value = try string(dictionary, key) else { return nil }
        if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw adapterError(startupIdentityMessage(key, reason: .empty))
        }
        if value.utf8.contains(0) {
            throw adapterError(startupIdentityMessage(key, reason: .nul))
        }
        return value
    }

    private enum StartupIdentityReason {
        case empty
        case nul
    }

    private static func startupIdentityMessage(_ key: String, reason: StartupIdentityReason) -> String {
        switch (key, reason) {
        case ("username", .empty):
            return "username must not be empty"
        case ("username", .nul):
            return "username must not contain NUL bytes"
        case ("database", .empty):
            return "database must not be empty"
        case ("database", .nul):
            return "database must not contain NUL bytes"
        case (_, .empty):
            return "\(key) must not be empty"
        case (_, .nul):
            return "\(key) must not contain NUL bytes"
        }
    }

    private static func stringArray(_ dictionary: NSDictionary, _ key: String) throws -> [String] {
        guard let raw = dictionary[key] else {
            return []
        }
        guard !(raw is NSNull) else {
            return []
        }
        guard let values = raw as? [Any] else {
            throw adapterError(arrayOfStringsMessage(key))
        }
        return try values.map { value in
            guard let string = value as? String else {
                throw adapterError(arrayOfStringsMessage(key))
            }
            return string
        }
    }

    private static func startupGUCs(_ dictionary: NSDictionary, _ key: String) throws -> [OliphauntStartupGUC] {
        try stringArray(dictionary, key).map { assignment in
            guard let separator = assignment.firstIndex(of: "=") else {
                throw adapterError("PostgreSQL startup GUC string must use name=value")
            }
            let name = String(assignment[..<separator])
            let value = String(assignment[assignment.index(after: separator)...])
            return OliphauntStartupGUC(name, value)
        }
    }

    private static func arrayOfStringsMessage(_ key: String) -> String {
        if key == "extensions" {
            return "extensions must be an array of strings"
        }
        if key == "startupGUCs" {
            return "startupGUCs must be an array of strings"
        }
        return "\(key) must be an array of strings"
    }

    private static func env(_ key: String) -> String? {
        guard let value = ProcessInfo.processInfo.environment[key],
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }
        return value
    }

    private static func urlFromPath(_ path: String?) -> URL? {
        guard let path, !path.isEmpty else {
            return nil
        }
        return URL(fileURLWithPath: path)
    }

    private static func adapterError(_ message: String) -> NSError {
        NSError(
            domain: errorDomain,
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    private static func nsError(_ error: Error) -> NSError {
        if let nsError = error as NSError?, nsError.domain == errorDomain {
            return nsError
        }
        return NSError(
            domain: errorDomain,
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: message(error)]
        )
    }

    private static func message(_ error: Error) -> String {
        switch error {
        case OliphauntError.runtimeUnavailable(let mode):
            return "native Oliphaunt runtime is unavailable for \(mode.rawValue)"
        case OliphauntError.databaseClosed:
            return "Oliphaunt database is closed"
        case OliphauntError.engine(let message):
            return message
        default:
            return (error as NSError).localizedDescription
        }
    }
}

private extension String {
    func removingPrefix(_ prefix: String) -> String? {
        guard hasPrefix(prefix) else {
            return nil
        }
        return String(dropFirst(prefix.count))
    }
}
