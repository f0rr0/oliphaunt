import Foundation
import COliphaunt

public struct OliphauntNativeDirectEngine: OliphauntEngine, OliphauntEngineSupportProvider {
    public var libraryURL: URL?
    public var runtimeDirectory: URL?
    public var runtimeResources: OliphauntRuntimeResources?
    public var username: String
    public var database: String

    public init(
        libraryURL: URL? = nil,
        runtimeDirectory: URL? = nil,
        runtimeResources: OliphauntRuntimeResources? = nil,
        username: String = "postgres",
        database: String = "postgres"
    ) {
        self.libraryURL = libraryURL
        self.runtimeDirectory = runtimeDirectory
        self.runtimeResources = runtimeResources
        self.username = username
        self.database = database
    }

    public var supportedModes: [OliphauntEngineModeSupport] {
        OliphauntSDKSupport.nativeDirectOnly(
            brokerReason: OliphauntDefaultEngine.brokerUnavailableReason,
            serverReason: OliphauntDefaultEngine.serverUnavailableReason
        )
    }

    public func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        guard configuration.mode == .nativeDirect else {
            throw OliphauntError.engine(
                "OliphauntNativeDirectEngine supports nativeDirect, got \(configuration.mode.rawValue)"
            )
        }
        try validateOliphauntRoot(configuration.root, label: "database root")
        try validateOliphauntStartupIdentity(configuration.username ?? username, label: "username")
        try validateOliphauntStartupIdentity(configuration.database ?? database, label: "database")
        try validateOliphauntStartupGUCs(configuration.startupGUCs)
        _ = try OliphauntRuntimeResources.validateExtensionIds(configuration.extensions)
        let packagedRuntimeResources = try runtimeResources ?? OliphauntRuntimeResources.bundled(
            containing: configuration.extensions
        )
        let resolvedRuntime = try resolveRuntime(
            extensions: configuration.extensions,
            runtimeResources: packagedRuntimeResources
        )

        let root = try Self.resolveRoot(configuration.root)
        let pgdata = root.appendingPathComponent("pgdata", isDirectory: true)
        let preparedPgdata = try packagedRuntimeResources?.preparePgdata(at: pgdata) ?? false
        let hasPgVersion = FileManager.default.fileExists(
            atPath: pgdata.appendingPathComponent("PG_VERSION").path
        )
        if !hasPgVersion {
            try Self.requireHostInitdbSupport(
                preparedPgdata: preparedPgdata,
                temporaryRoot: configuration.root == nil,
                root: root
            )
            try FileManager.default.createDirectory(
                at: pgdata,
                withIntermediateDirectories: true
            )
        }

        let username = configuration.username ?? self.username
        let database = configuration.database ?? self.database
        let startupArgs = configuration.postgresStartupArgs(
            sharedPreloadLibraries: resolvedRuntime.sharedPreloadLibraries
        )
        let libraryPath = libraryURL?.path
        let runtimePath = resolvedRuntime.directory?.path ?? ""
        var session: OpaquePointer?
        let rc = withCStringArray(startupArgs) { startupArgPointers in
            pgdata.path.withCString { pgdataCString in
                runtimePath.withCString { runtimeCString in
                    username.withCString { usernameCString in
                        database.withCString { databaseCString in
                            libraryPath.withOptionalCString { libraryCString in
                                var config = OliphauntConfig(
                                    abi_version: UInt32(OLIPHAUNT_ABI_VERSION),
                                    pgdata: pgdataCString,
                                    runtime_dir: runtimeCString,
                                    username: usernameCString,
                                    database: databaseCString,
                                    reserved_flags: 0,
                                    startup_args: startupArgPointers,
                                    startup_arg_count: startupArgs.count
                                )
                                return oliphaunt_swift_open(libraryCString, &config, &session)
                            }
                        }
                    }
                }
            }
        }
        guard rc == 0, let session else {
            if configuration.root == nil {
                try? FileManager.default.removeItem(at: root)
            }
            throw OliphauntError.engine(Self.lastError(nil))
        }
        return NativeDirectSession(
            session: session,
            root: root,
            deleteRootOnClose: configuration.root == nil
        )
    }

    public func restore(_ request: OliphauntRestoreRequest) async throws -> URL {
        try validateOliphauntRoot(request.root, label: "restore root")
        guard request.artifact.format == .physicalArchive else {
            throw OliphauntError.engine(
                "Swift native restore currently requires physicalArchive, got \(request.artifact.format.rawValue)"
            )
        }
        let libraryPath = libraryURL?.path
        let flags: UInt64 = request.targetPolicy == .replaceExisting
            ? UInt64(OLIPHAUNT_RESTORE_REPLACE_EXISTING)
            : 0
        let rc = request.root.path.withCString { rootCString in
            libraryPath.withOptionalCString { libraryCString in
                request.artifact.bytes.withUnsafeBytes { rawBuffer in
                    var options = OliphauntRestoreOptions(
                        abi_version: UInt32(OLIPHAUNT_ABI_VERSION),
                        root: rootCString,
                        format: UInt32(OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE),
                        data: rawBuffer.bindMemory(to: UInt8.self).baseAddress,
                        len: request.artifact.bytes.count,
                        flags: flags
                    )
                    return oliphaunt_swift_restore(libraryCString, &options)
                }
            }
        }
        guard rc == 0 else {
            throw OliphauntError.engine(Self.lastError(nil))
        }
        return request.root
    }

    private func resolveRuntime(
        extensions: [String],
        runtimeResources: OliphauntRuntimeResources?
    ) throws -> ResolvedNativeRuntime {
        if let runtimeDirectory {
            return try resolveExplicitRuntimeDirectory(
                runtimeDirectory,
                extensions: extensions,
                runtimeResources: runtimeResources
            )
        }
        if let runtimeResources {
            return ResolvedNativeRuntime(
                directory: try runtimeResources.materializeRuntime(requestedExtensions: extensions),
                sharedPreloadLibraries: try runtimeResources.sharedPreloadLibraries(requestedExtensions: extensions)
            )
        }
        if let environmentRuntimeDirectory = Self.environmentRuntimeDirectory() {
            return try resolveExplicitRuntimeDirectory(
                environmentRuntimeDirectory,
                extensions: extensions,
                runtimeResources: nil
            )
        }
        if !extensions.isEmpty {
            throw OliphauntError.engine(
                "Swift native-direct extensions require runtimeDirectory or packaged OliphauntRuntimeResources built with the selected extensions"
            )
        }
        return ResolvedNativeRuntime()
    }

    private func resolveExplicitRuntimeDirectory(
        _ directory: URL,
        extensions: [String],
        runtimeResources: OliphauntRuntimeResources?
    ) throws -> ResolvedNativeRuntime {
        let resources =
            try matchingRuntimeResources(
                directory: directory,
                runtimeResources: runtimeResources
            )
        if let resources {
            return ResolvedNativeRuntime(
                directory: directory,
                sharedPreloadLibraries: try resources.sharedPreloadLibraries(
                    forRuntimeDirectory: directory,
                    requestedExtensions: extensions
                )
            )
        }
        if !extensions.isEmpty {
            throw OliphauntError.engine(
                "Swift native-direct extensions with explicit runtimeDirectory require release-shaped OliphauntRuntimeResources at oliphaunt/runtime/files so selected extension files, mobile static registry metadata, and shared preload libraries can be validated"
            )
        }
        return ResolvedNativeRuntime(directory: directory)
    }

    private func matchingRuntimeResources(
        directory: URL,
        runtimeResources: OliphauntRuntimeResources?
    ) throws -> OliphauntRuntimeResources? {
        if let runtimeResources,
           (try? runtimeResources.sharedPreloadLibraries(forRuntimeDirectory: directory)) != nil
        {
            return runtimeResources
        }
        return try OliphauntRuntimeResources.releaseShapedResources(
            forRuntimeDirectory: directory,
            cacheRoot: runtimeResources?.cacheRoot ?? OliphauntRuntimeResources.defaultCacheRoot()
        )
    }

    private struct ResolvedNativeRuntime {
        var directory: URL? = nil
        var sharedPreloadLibraries: [String] = []
    }

    private static func environmentRuntimeDirectory() -> URL? {
        let environment = ProcessInfo.processInfo.environment
        for key in ["OLIPHAUNT_INSTALL_DIR", "OLIPHAUNT_RUNTIME_DIR"] {
            guard let value = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty
            else {
                continue
            }
            return URL(fileURLWithPath: value, isDirectory: true)
        }
        return nil
    }

    private static func requireHostInitdbSupport(
        preparedPgdata: Bool,
        temporaryRoot: Bool,
        root: URL
    ) throws {
        if preparedPgdata {
            return
        }
#if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
        if temporaryRoot {
            try? FileManager.default.removeItem(at: root)
        }
        throw OliphauntError.engine(
            "Swift Oliphaunt native-direct requires packaged template PGDATA or an existing PGDATA root on Apple mobile platforms; initdb cannot be assumed executable from app storage"
        )
#else
        _ = temporaryRoot
        _ = root
#endif
    }

    private static func resolveRoot(_ configuredRoot: URL?) throws -> URL {
        if let configuredRoot {
            try FileManager.default.createDirectory(
                at: configuredRoot,
                withIntermediateDirectories: true
            )
            return configuredRoot
        }
        let root = processTemporaryRoot
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        return root
    }

    private static let processTemporaryRoot: URL = {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "liboliphaunt-swift-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString)",
                isDirectory: true
            )
    }()

    fileprivate static func lastError(_ session: OpaquePointer?) -> String {
        guard let pointer = oliphaunt_swift_last_error(session) else {
            return "unknown liboliphaunt Swift runtime error"
        }
        let message = String(cString: pointer)
        return message.isEmpty ? "unknown liboliphaunt Swift runtime error" : message
    }

}

private actor NativeDirectSession: OliphauntSession {
    private let box: NativeSessionBox

    init(session: OpaquePointer, root: URL, deleteRootOnClose: Bool) {
        self.box = NativeSessionBox(
            pointer: session,
            root: root,
            deleteRootOnClose: deleteRootOnClose
        )
    }

    deinit {
        box.closeBestEffort()
    }

    func capabilities() async -> OliphauntCapabilities {
        let flags = box.capabilityFlags()
        return OliphauntCapabilities(
            mode: .nativeDirect,
            processIsolated: false,
            multiRoot: flags & OLIPHAUNT_CAP_MULTI_INSTANCE != 0,
            reopenable: flags & OLIPHAUNT_CAP_LOGICAL_REOPEN != 0,
            sameRootLogicalReopen: flags & OLIPHAUNT_CAP_LOGICAL_REOPEN != 0,
            rootSwitchable: false,
            crashRestartable: false,
            independentSessions: false,
            maxClientSessions: 1,
            protocolRaw: flags & OLIPHAUNT_CAP_PROTOCOL_RAW != 0,
            protocolStream: flags & OLIPHAUNT_CAP_PROTOCOL_STREAM != 0,
            queryCancel: flags & OLIPHAUNT_CAP_QUERY_CANCEL != 0,
            backupRestore: flags & OLIPHAUNT_CAP_BACKUP_RESTORE != 0,
            backupFormats: [.physicalArchive],
            restoreFormats: [.physicalArchive],
            simpleQuery: flags & OLIPHAUNT_CAP_SIMPLE_QUERY != 0,
            extensions: flags & OLIPHAUNT_CAP_EXTENSIONS != 0
        )
    }

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        try box.execProtocolRaw(bytes)
    }

    func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try box.execProtocolStream(bytes, onChunk: onChunk)
    }

    func backup(_ request: OliphauntBackupRequest) async throws -> OliphauntBackupArtifact {
        try box.backup(request)
    }

    nonisolated func cancel() async throws {
        try box.cancel()
    }

    nonisolated func close() async throws {
        try box.close()
    }
}

private final class NativeSessionBox: @unchecked Sendable {
    private let condition = NSCondition()
    private var pointer: OpaquePointer?
    private var closed = false
    private var activeCalls = 0
    private let root: URL
    private let deleteRootOnClose: Bool

    init(pointer: OpaquePointer, root: URL, deleteRootOnClose: Bool) {
        self.pointer = pointer
        self.root = root
        self.deleteRootOnClose = deleteRootOnClose
    }

    deinit {
        closeBestEffort()
    }

    func capabilityFlags() -> UInt64 {
        guard let pointer = try? beginCall() else {
            return 0
        }
        defer {
            endCall()
        }
        return oliphaunt_swift_capabilities(pointer)
    }

    func execProtocolRaw(_ bytes: Data) throws -> Data {
        let pointer = try beginCall()
        defer {
            endCall()
        }

        var response = OliphauntResponse(data: nil, len: 0)
        let rc = bytes.withUnsafeBytes { rawBuffer in
            let base = rawBuffer.bindMemory(to: UInt8.self).baseAddress
            return oliphaunt_swift_exec_protocol(pointer, base, bytes.count, &response)
        }
        guard rc == 0 else {
            throw OliphauntError.engine(OliphauntNativeDirectEngine.lastError(pointer))
        }
        defer {
            oliphaunt_swift_free_response(pointer, &response)
        }
        guard let data = response.data, response.len > 0 else {
            return Data()
        }
        return Data(bytes: data, count: response.len)
    }

    func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) throws {
        let pointer = try beginCall()
        defer {
            endCall()
        }

        let callbackBox = NativeStreamCallbackBox(onChunk: onChunk)
        let context = Unmanaged.passUnretained(callbackBox).toOpaque()
        let rc = bytes.withUnsafeBytes { rawBuffer in
            let base = rawBuffer.bindMemory(to: UInt8.self).baseAddress
            return oliphaunt_swift_exec_protocol_stream(
                pointer,
                base,
                bytes.count,
                { context, data, len in
                    guard let context else {
                        return -1
                    }
                    let callbackBox = Unmanaged<NativeStreamCallbackBox>
                        .fromOpaque(context)
                        .takeUnretainedValue()
                    do {
                        if let data, len > 0 {
                            try callbackBox.onChunk(Data(bytes: data, count: len))
                        } else {
                            try callbackBox.onChunk(Data())
                        }
                        return 0
                    } catch {
                        callbackBox.error = error
                        return -1
                    }
                },
                context
            )
        }
        if let error = callbackBox.error {
            throw error
        }
        guard rc == 0 else {
            throw OliphauntError.engine(OliphauntNativeDirectEngine.lastError(pointer))
        }
    }

    func backup(_ request: OliphauntBackupRequest) throws -> OliphauntBackupArtifact {
        guard request.format == .physicalArchive else {
            throw OliphauntError.engine(
                "Swift native-direct backup currently supports physicalArchive, got \(request.format.rawValue)"
            )
        }
        let pointer = try beginCall()
        defer {
            endCall()
        }

        var response = OliphauntResponse(data: nil, len: 0)
        let rc = oliphaunt_swift_backup(
            pointer,
            UInt32(OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE),
            &response
        )
        guard rc == 0 else {
            throw OliphauntError.engine(OliphauntNativeDirectEngine.lastError(pointer))
        }
        defer {
            oliphaunt_swift_free_response(pointer, &response)
        }
        guard let data = response.data, response.len > 0 else {
            return OliphauntBackupArtifact(format: .physicalArchive, bytes: Data())
        }
        return OliphauntBackupArtifact(
            format: .physicalArchive,
            bytes: Data(bytes: data, count: response.len)
        )
    }

    func cancel() throws {
        condition.lock()
        let pointer = self.pointer
        let isClosed = closed
        condition.unlock()

        guard let pointer, !isClosed else {
            throw OliphauntError.databaseClosed
        }
        let rc = oliphaunt_swift_cancel(pointer)
        guard rc == 0 else {
            throw OliphauntError.engine(OliphauntNativeDirectEngine.lastError(pointer))
        }
    }

    func close() throws {
        let pointer = prepareClose()
        guard let pointer else {
            cleanupRoot()
            return
        }
        let rc = oliphaunt_swift_close(pointer)
        cleanupRoot()
        guard rc == 0 else {
            throw OliphauntError.engine(OliphauntNativeDirectEngine.lastError(nil))
        }
    }

    func closeBestEffort() {
        let pointer = prepareClose()
        if let pointer {
            _ = oliphaunt_swift_close(pointer)
        }
        cleanupRoot()
    }

    private func beginCall() throws -> OpaquePointer {
        condition.lock()
        defer {
            condition.unlock()
        }
        while !closed && activeCalls > 0 {
            condition.wait()
        }
        guard let pointer, !closed else {
            throw OliphauntError.databaseClosed
        }
        activeCalls += 1
        return pointer
    }

    private func endCall() {
        condition.lock()
        activeCalls -= 1
        condition.broadcast()
        condition.unlock()
    }

    private func prepareClose() -> OpaquePointer? {
        condition.lock()
        if closed {
            condition.unlock()
            return nil
        }
        closed = true
        let pointer = self.pointer
        while activeCalls > 0 {
            condition.wait()
        }
        self.pointer = nil
        condition.unlock()
        return pointer
    }

    private func cleanupRoot() {
        if deleteRootOnClose {
            /*
             Native direct close is a logical detach. The resident PostgreSQL
             backend may still own PGDATA until process exit, so deleting a
             temporary root here would corrupt the live runtime.
             */
            _ = root
        }
    }
}

private final class NativeStreamCallbackBox: @unchecked Sendable {
    let onChunk: @Sendable (Data) throws -> Void
    var error: Error?

    init(onChunk: @escaping @Sendable (Data) throws -> Void) {
        self.onChunk = onChunk
    }
}

private func withCStringArray<T>(
    _ strings: [String],
    _ body: (UnsafePointer<UnsafePointer<CChar>?>?) throws -> T
) rethrows -> T {
    let cStrings = strings.map { strdup($0) }
    defer {
        for cString in cStrings {
            free(cString)
        }
    }
    let pointers = cStrings.map { cString -> UnsafePointer<CChar>? in
        guard let cString else {
            return nil
        }
        return UnsafePointer(cString)
    }
    return try pointers.withUnsafeBufferPointer { buffer in
        try body(buffer.baseAddress)
    }
}

private extension Optional where Wrapped == String {
    func withOptionalCString<T>(_ body: (UnsafePointer<CChar>?) throws -> T) rethrows -> T {
        switch self {
        case .some(let value):
            return try value.withCString(body)
        case .none:
            return try body(nil)
        }
    }
}
