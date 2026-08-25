import Foundation
import COliphaunt

struct OliphauntNativeDirectEngine: OliphauntEngine {
    var libraryURL: URL?
    var runtimeDirectory: URL?
    var runtimeResources: OliphauntRuntimeResources?

    init(
        libraryURL: URL? = nil,
        runtimeDirectory: URL? = nil,
        runtimeResources: OliphauntRuntimeResources? = nil
    ) {
        self.libraryURL = libraryURL
        self.runtimeDirectory = runtimeDirectory
        self.runtimeResources = runtimeResources
    }

    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        try validateOliphauntStorage(configuration.storage)
        try validateOliphauntStartupIdentity(configuration.username, label: "username")
        try validateOliphauntStartupIdentity(configuration.database, label: "database")
        try validateOliphauntStartupGUCs(configuration.startupGUCs)
        _ = try OliphauntRuntimeResources.validateExtensionIds(configuration.extensions)
        let packagedRuntimeResources = try runtimeResources ?? OliphauntRuntimeResources.bundled(
            containing: configuration.extensions
        )
        let resolvedRuntime = try resolveRuntime(
            extensions: configuration.extensions,
            runtimeResources: packagedRuntimeResources
        )
        let username = configuration.username ?? "postgres"
        let database = configuration.database ?? "postgres"

        let storageDirectory = try Self.resolveStorage(configuration.storage)
        let pgdata = storageDirectory.appendingPathComponent("pgdata", isDirectory: true)
        switch try Self.classifyManagedRoot(storageDirectory) {
        case .managed:
            try validateOliphauntCompletePgdata(pgdata)
        case .empty:
            try requireOliphauntFreshRootRole(username)
            var ownsPublishedPgdata = false
            do {
                let preparation = try resolvedRuntime.resources?.preparePgdata(
                    at: pgdata,
                    profile: resolvedRuntime.catalogProfile,
                    didPublishDestination: { ownsPublishedPgdata = true }
                )
                if preparation == nil {
                    let staging = storageDirectory.appendingPathComponent(
                        ".pgdata-initdb-\(UUID().uuidString)",
                        isDirectory: true
                    )
                    let result: Result<OliphauntPgdataPublication, Error> = Result {
                        try Self.runPackagedInitdb(
                            pgdata: staging,
                            runtimeDirectory: resolvedRuntime.directory,
                            username: "postgres",
                            catalogProfile: resolvedRuntime.catalogProfile
                        )
                        return try publishOliphauntPreparedPgdata(
                            staging,
                            to: pgdata,
                            didPublishDestination: { ownsPublishedPgdata = true }
                        )
                    }
                    _ = try finishOliphauntStaging(result, operation: "PGDATA preparation") {
                        try removeOliphauntStagingIfPresent(staging)
                    }
                }
                try validateOliphauntCompletePgdata(pgdata)
                try Self.writeManagedRootDescriptor(storageDirectory)
            } catch let publicationError {
                try recoverOliphauntManagedRootPublicationFailure(
                    publicationError,
                    ownsPublishedPgdata: ownsPublishedPgdata,
                    descriptorDefinitelyAbsent: {
                        try isOliphauntPathDefinitelyAbsent(
                            storageDirectory.appendingPathComponent(
                                ".oliphaunt.json",
                                isDirectory: false
                            )
                        )
                    },
                    removePublishedPgdata: {
                        if !(try isOliphauntPathDefinitelyAbsent(pgdata)) {
                            try FileManager.default.removeItem(at: pgdata)
                        }
                    },
                    syncRoot: { try syncOliphauntDirectory(storageDirectory) }
                )
            }
        }

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

    func restore(destination: URL, bytes: Data) async throws {
        try validateOliphauntDirectory(destination, label: "restore destination")
        let libraryPath = libraryURL?.path
        let rc = destination.path.withCString { destinationCString in
            libraryPath.withOptionalCString { libraryCString in
                bytes.withUnsafeBytes { rawBuffer in
                    var options = OliphauntRestoreOptions(
                        abi_version: UInt32(OLIPHAUNT_ABI_VERSION),
                        destination: destinationCString,
                        data: rawBuffer.bindMemory(to: UInt8.self).baseAddress,
                        len: bytes.count
                    )
                    return oliphaunt_swift_restore(libraryCString, &options)
                }
            }
        }
        guard rc == 0 else {
            throw OliphauntError.engine(Self.lastError(nil))
        }
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
            let closure = try runtimeResources.resolveRuntime(requestedExtensions: extensions)
            return ResolvedNativeRuntime(
                directory: closure.directory,
                sharedPreloadLibraries: closure.sharedPreloadLibraries,
                catalogProfile: closure.catalogProfile,
                resources: closure.owner
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
            let closure = try resources.resolveRuntime(
                at: directory,
                requestedExtensions: extensions
            )
            return ResolvedNativeRuntime(
                directory: closure.directory,
                sharedPreloadLibraries: closure.sharedPreloadLibraries,
                catalogProfile: closure.catalogProfile,
                resources: closure.owner
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
        var catalogProfile: OliphauntNativeCatalogProfile = .standard
        var resources: OliphauntRuntimeResources? = nil
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

    private static func runPackagedInitdb(
        pgdata: URL,
        runtimeDirectory: URL?,
        username: String,
        catalogProfile: OliphauntNativeCatalogProfile
    ) throws {
#if os(macOS)
        let environment = ProcessInfo.processInfo.environment
        let initdb: URL
        if let configured = environment["OLIPHAUNT_INITDB"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !configured.isEmpty
        {
            initdb = URL(fileURLWithPath: configured, isDirectory: false)
        } else if let runtimeDirectory {
            initdb = runtimeDirectory.appendingPathComponent("bin/initdb", isDirectory: false)
        } else {
            throw OliphauntError.engine(
                "new Swift database storage requires packaged initdb; provide packaged runtime resources or OLIPHAUNT_INSTALL_DIR"
            )
        }
        guard FileManager.default.isExecutableFile(atPath: initdb.path) else {
            throw OliphauntError.engine("packaged initdb is not executable: \(initdb.path)")
        }

        let process = Process()
        process.executableURL = initdb
        process.arguments = [
            "-D", pgdata.path,
            "-U", username,
            "--auth=trust",
            "--locale-provider=libc",
            "--locale=C",
            "--encoding=UTF8",
        ]
        var childEnvironment = environment
        childEnvironment.removeValue(forKey: "ICU_DATA")
        childEnvironment.removeValue(forKey: "OLIPHAUNT_INTERNAL_ICU_READY")
        childEnvironment.removeValue(forKey: "OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY")
        childEnvironment.removeValue(forKey: "OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY")
        if catalogProfile == .standard {
            childEnvironment["OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY"] = "1"
        }
        if let runtimeDirectory {
            let libraryDirectory = runtimeDirectory.appendingPathComponent("lib", isDirectory: true).path
            let inherited = environment["DYLD_LIBRARY_PATH"]?.trimmingCharacters(in: .whitespacesAndNewlines)
            childEnvironment["DYLD_LIBRARY_PATH"] = [libraryDirectory, inherited]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .joined(separator: ":")
            if catalogProfile == .icu {
                let icuData = runtimeDirectory.appendingPathComponent("share/icu", isDirectory: true)
                guard FileManager.default.fileExists(atPath: icuData.path) else {
                    throw OliphauntError.engine(
                        "verified ICU runtime closure is missing share/icu at \(icuData.path)"
                    )
                }
                childEnvironment["ICU_DATA"] = icuData.path
                childEnvironment["OLIPHAUNT_INTERNAL_ICU_READY"] = "1"
            }
        }
        process.environment = childEnvironment
        process.standardOutput = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            throw OliphauntError.engine("could not execute packaged initdb \(initdb.path): \(error)")
        }
        guard process.terminationReason == .exit, process.terminationStatus == 0 else {
            throw OliphauntError.engine(
                "packaged initdb \(initdb.path) failed with status \(process.terminationStatus)"
            )
        }
#else
        throw OliphauntError.engine(
            "new Swift database storage requires a packaged cluster seed on this platform"
        )
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
        if FileManager.default.fileExists(atPath: directory.path) {
            let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else {
                throw OliphauntError.engine(
                    "database storage directory must be a real directory: \(directory.path)"
                )
            }
        }
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
    }

    private enum ManagedRootState: Equatable {
        case empty
        case managed
    }

    private static func classifyManagedRoot(_ directory: URL) throws -> ManagedRootState {
        let descriptor = directory.appendingPathComponent(".oliphaunt.json", isDirectory: false)
        if FileManager.default.fileExists(atPath: descriptor.path) {
            try validateManagedRootDescriptor(descriptor)
            let contents = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            guard contents.count == 2, Set(contents) == Set([".oliphaunt.json", "pgdata"]) else {
                throw OliphauntError.engine(
                    "managed database storage directory must contain exactly .oliphaunt.json and pgdata: \(directory.path)"
                )
            }
            return .managed
        }
        let contents = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        guard contents.isEmpty else {
            throw OliphauntError.engine(
                "database storage directory is nonempty but has no .oliphaunt.json descriptor: \(directory.path)"
            )
        }
        return .empty
    }

    private static func writeManagedRootDescriptor(_ directory: URL) throws {
        let descriptor = directory.appendingPathComponent(".oliphaunt.json", isDirectory: false)
        let staging = directory.appendingPathComponent(
            ".oliphaunt.json.tmp-\(UUID().uuidString)",
            isDirectory: false
        )
        let json =
            "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":18,\"physicalFormat\":\"native-pg18-v1\"}\n"
        let result: Result<Void, Error> = Result {
            guard FileManager.default.createFile(
                atPath: staging.path,
                contents: Data(json.utf8),
                attributes: [.posixPermissions: 0o600]
            ) else {
                throw OliphauntError.engine(
                    "failed to create database root descriptor staging file at \(staging.path)"
                )
            }
            let handle = try FileHandle(forWritingTo: staging)
            try handle.synchronize()
            try handle.close()
            do {
                try FileManager.default.moveItem(at: staging, to: descriptor)
            } catch let publicationError {
                do {
                    try validateManagedRootDescriptor(descriptor)
                } catch {
                    throw publicationError
                }
            }
            try syncOliphauntDirectory(directory)
        }
        try finishOliphauntStaging(
            result,
            operation: "database root descriptor publication"
        ) {
            try removeOliphauntStagingIfPresent(staging)
        }
    }

    private static func validateManagedRootDescriptor(_ descriptor: URL) throws {
        let resourceValues = try descriptor.resourceValues(
            forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
        )
        guard resourceValues.isRegularFile == true,
              resourceValues.isSymbolicLink != true,
              (resourceValues.fileSize ?? 0) > 0
        else {
            throw OliphauntError.engine(
                "database root descriptor must be a nonempty real file: \(descriptor.path)"
            )
        }
        let value: [String: OliphauntDescriptorJSONValue]
        do {
            var parser = OliphauntFlatJSONParser(data: try Data(contentsOf: descriptor))
            value = try parser.parse()
        } catch {
            throw OliphauntError.engine("invalid database root descriptor: \(descriptor.path)")
        }
        guard Set(value.keys) == Set(["schema", "engineFamily", "pgdata", "postgresMajor", "physicalFormat"]),
              value["schema"] == .string("oliphaunt-database-root-v1"),
              value["pgdata"] == .string("pgdata"),
              value["postgresMajor"] == .integer(18),
              case .string(let family)? = value["engineFamily"],
              case .string(let format)? = value["physicalFormat"],
              ["native": "native-pg18-v1", "wasix": "wasix-pg18-v1"][family] == format
        else {
            throw OliphauntError.engine("invalid database root descriptor: \(descriptor.path)")
        }
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

private enum OliphauntDescriptorJSONValue: Equatable {
    case string(String)
    case integer(Int64)
}

private struct OliphauntFlatJSONParser {
    private let bytes: [UInt8]
    private var offset = 0

    init(data: Data) {
        bytes = Array(data)
    }

    mutating func parse() throws -> [String: OliphauntDescriptorJSONValue] {
        skipWhitespace()
        try expect(ascii: 0x7b)
        skipWhitespace()
        var values: [String: OliphauntDescriptorJSONValue] = [:]
        if consume(ascii: 0x7d) {
            try finish()
            return values
        }
        while true {
            let key = try parseString()
            guard values[key] == nil else {
                throw ParseError.invalid
            }
            skipWhitespace()
            try expect(ascii: 0x3a)
            skipWhitespace()
            if peek() == 0x22 {
                values[key] = .string(try parseString())
            } else {
                values[key] = .integer(try parseInteger())
            }
            skipWhitespace()
            if consume(ascii: 0x7d) {
                break
            }
            try expect(ascii: 0x2c)
            skipWhitespace()
        }
        try finish()
        return values
    }

    private mutating func parseString() throws -> String {
        let start = offset
        try expect(ascii: 0x22)
        while offset < bytes.count {
            let byte = bytes[offset]
            offset += 1
            if byte == 0x22 {
                let token = Data(bytes[start..<offset])
                guard let value = try JSONSerialization.jsonObject(
                    with: token,
                    options: .fragmentsAllowed
                ) as? String else {
                    throw ParseError.invalid
                }
                return value
            }
            if byte == 0x5c {
                guard offset < bytes.count else {
                    throw ParseError.invalid
                }
                offset += 1
            }
        }
        throw ParseError.invalid
    }

    private mutating func parseInteger() throws -> Int64 {
        let start = offset
        _ = consume(ascii: 0x2d)
        guard let first = peek() else {
            throw ParseError.invalid
        }
        if first == 0x30 {
            offset += 1
            if let byte = peek(), (0x30...0x39).contains(byte) {
                throw ParseError.invalid
            }
        } else if (0x31...0x39).contains(first) {
            while let byte = peek(), (0x30...0x39).contains(byte) {
                offset += 1
            }
        } else {
            throw ParseError.invalid
        }
        guard let value = Int64(String(decoding: bytes[start..<offset], as: UTF8.self)) else {
            throw ParseError.invalid
        }
        return value
    }

    private mutating func finish() throws {
        skipWhitespace()
        guard offset == bytes.count else {
            throw ParseError.invalid
        }
    }

    private mutating func skipWhitespace() {
        while let byte = peek(), [0x20, 0x09, 0x0a, 0x0d].contains(byte) {
            offset += 1
        }
    }

    private func peek() -> UInt8? {
        bytes.indices.contains(offset) ? bytes[offset] : nil
    }

    private mutating func consume(ascii: UInt8) -> Bool {
        guard peek() == ascii else {
            return false
        }
        offset += 1
        return true
    }

    private mutating func expect(ascii: UInt8) throws {
        guard consume(ascii: ascii) else {
            throw ParseError.invalid
        }
    }

    private enum ParseError: Error {
        case invalid
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

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        try box.execProtocolRaw(bytes)
    }

    func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try box.execProtocolStream(bytes, onChunk: onChunk)
    }

    func backup() async throws -> Data {
        try box.backup()
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

    func backup() throws -> Data {
        let pointer = try beginCall()
        defer {
            endCall()
        }

        var response = OliphauntResponse(data: nil, len: 0)
        let rc = oliphaunt_swift_backup(pointer, &response)
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
