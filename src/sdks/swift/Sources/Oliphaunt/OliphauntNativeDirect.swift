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
        try validateOliphauntStorage(configuration.storage)
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

        let storageDirectory = try Self.resolveStorage(configuration.storage)
        let pgdata = storageDirectory.appendingPathComponent("pgdata", isDirectory: true)
        let preparedPgdata = try packagedRuntimeResources?.preparePgdata(at: pgdata) ?? false
        let hasPgVersion = FileManager.default.fileExists(
            atPath: pgdata.appendingPathComponent("PG_VERSION").path
        )
        if !hasPgVersion {
            try Self.requireHostInitdbSupport(
                preparedPgdata: preparedPgdata,
                managedTemporaryDirectory: configuration.storage.isTemporaryDirectory,
                storageDirectory: storageDirectory
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
                                    module_dir: nil,
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
            // The native direct runtime is process-resident and may still own
            // this directory after rejecting an incompatible logical reopen.
            // Process-temporary storage is therefore reclaimed only with the
            // process, never on a failed native open.
            throw OliphauntError.engine(Self.lastError(nil))
        }
        return NativeDirectSession(session: session)
    }

    public func restore(_ request: OliphauntRestoreRequest) async throws -> URL {
        try validateOliphauntDirectory(request.destination, label: "restore destination")
        guard request.artifact.format == .physicalArchive else {
            throw OliphauntError.engine(
                "Swift native restore currently requires physicalArchive, got \(request.artifact.format.rawValue)"
            )
        }
        let libraryPath = libraryURL?.path
        let flags: UInt64 = request.destinationPolicy == .replaceExisting
            ? UInt64(OLIPHAUNT_RESTORE_REPLACE_EXISTING)
            : 0
        let rc = request.destination.path.withCString { destinationCString in
            libraryPath.withOptionalCString { libraryCString in
                request.artifact.bytes.withUnsafeBytes { rawBuffer in
                    var options = OliphauntRestoreOptions(
                        abi_version: UInt32(OLIPHAUNT_ABI_VERSION),
                        destination: destinationCString,
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
        return request.destination
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
        managedTemporaryDirectory: Bool,
        storageDirectory: URL
    ) throws {
        if preparedPgdata {
            return
        }
#if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
        if managedTemporaryDirectory {
            try? FileManager.default.removeItem(at: storageDirectory)
        }
        throw OliphauntError.engine(
            "Swift Oliphaunt native-direct requires packaged template PGDATA or an existing database storage directory on Apple mobile platforms; initdb cannot be assumed executable from app storage"
        )
#else
        _ = managedTemporaryDirectory
        _ = storageDirectory
#endif
    }

    private static func resolveStorage(_ storage: OliphauntDatabaseStorage) throws -> URL {
        let directory: URL
        switch storage {
        case .temporaryDirectory:
            directory = processTemporaryDirectory
        case .directory(let configuredDirectory):
            directory = configuredDirectory
        }
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }

    private static let processTemporaryDirectory: URL = {
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

private extension OliphauntDatabaseStorage {
    var isTemporaryDirectory: Bool {
        if case .temporaryDirectory = self {
            return true
        }
        return false
    }
}

private actor NativeDirectSession: OliphauntSession {
    private let box: NativeSessionBox

    init(session: OpaquePointer) {
        self.box = NativeSessionBox(pointer: session)
    }

    deinit {
        box.closeBestEffort()
    }

    func capabilities() async -> OliphauntCapabilities {
        let flags = box.capabilityFlags()
        return OliphauntCapabilities(
            mode: .nativeDirect,
            processIsolated: false,
            multipleInstances: flags & OLIPHAUNT_CAP_MULTI_INSTANCE != 0,
            sameInstanceLogicalReopen: flags & OLIPHAUNT_CAP_LOGICAL_REOPEN != 0,
            instanceSwitchable: false,
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
    private var closing = false
    private var closed = false
    private var activeCalls = 0

    init(pointer: OpaquePointer) {
        self.pointer = pointer
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
        let pointer = try beginCancellation()
        defer {
            endCall()
        }
        let rc = oliphaunt_swift_cancel(pointer)
        guard rc == 0 else {
            throw OliphauntError.engine(OliphauntNativeDirectEngine.lastError(pointer))
        }
    }

    func close() throws {
        let pointer = beginClose()
        guard let pointer else {
            return
        }
        let rc = oliphaunt_swift_close(pointer)
        if rc == 0 {
            finishClose(detached: true)
            return
        }
        let message = OliphauntNativeDirectEngine.lastError(pointer)
        finishClose(detached: false)
        throw OliphauntError.engine(message)
    }

    func closeBestEffort() {
        let pointer = beginClose()
        if let pointer {
            let rc = oliphaunt_swift_close(pointer)
            finishClose(detached: rc == 0)
        }
    }

    private func beginCall() throws -> OpaquePointer {
        condition.lock()
        defer {
            condition.unlock()
        }
        while !closing && !closed && activeCalls > 0 {
            condition.wait()
        }
        guard let pointer, !closing, !closed else {
            throw OliphauntError.databaseClosed
        }
        activeCalls += 1
        return pointer
    }

    private func beginCancellation() throws -> OpaquePointer {
        condition.lock()
        defer {
            condition.unlock()
        }
        guard let pointer, !closing, !closed else {
            throw OliphauntError.databaseClosed
        }
        // Cancellation is intentionally out of band and may overlap the
        // serialized query call it interrupts. Counting it here still makes
        // close wait until the native cancel call has released the pointer.
        activeCalls += 1
        return pointer
    }

    private func endCall() {
        condition.lock()
        activeCalls -= 1
        condition.broadcast()
        condition.unlock()
    }

    private func beginClose() -> OpaquePointer? {
        condition.lock()
        while closing {
            condition.wait()
        }
        if closed {
            condition.unlock()
            return nil
        }
        closing = true
        let pointer = self.pointer
        while activeCalls > 0 {
            condition.wait()
        }
        condition.unlock()
        return pointer
    }

    private func finishClose(detached: Bool) {
        condition.lock()
        if detached {
            pointer = nil
            closed = true
        }
        closing = false
        condition.broadcast()
        condition.unlock()
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
