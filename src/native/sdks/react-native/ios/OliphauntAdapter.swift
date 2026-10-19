import Darwin
import Foundation
@_spi(ReactNative) import OliphauntCore

#if OLIPHAUNT_BROKER
    import OliphauntBroker
#else
    import Oliphaunt
#endif

private struct SendableData: @unchecked Sendable {
    let value: Data
}

private final class ProtocolStreamCallbackFailure: Error, @unchecked Sendable {
    let callbackError: NSError

    init(_ callbackError: NSError) {
        self.callbackError = callbackError
    }
}

extension OliphauntDatabase {
    fileprivate func reactNativeBackup() async throws -> SendableData {
        SendableData(value: try await backup())
    }
}

@objc(OliphauntAdapterDatabase)
public final class OliphauntAdapterDatabase: NSObject, @unchecked Sendable {
    private static let errorDomain = "dev.oliphaunt.reactnative.ios"

    private let database: OliphauntDatabase

    private init(database: OliphauntDatabase) {
        self.database = database
    }

    @objc public static func topology() -> String {
        #if OLIPHAUNT_BROKER
            return "broker"
        #else
            return "direct"
        #endif
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
        Task(priority: .userInitiated) {
            do {
                let database: OliphauntDatabase
                #if OLIPHAUNT_BROKER
                    guard #available(iOS 26, *) else {
                        throw adapterError("broker execution requires iOS 26")
                    }
                    database = try await OliphauntBroker.open(
                        configuration: parsed.configuration,
                        options: .init(
                            startupTimeout: .milliseconds(parsed.startupTimeoutMs),
                            operationTimeout: parsed.operationTimeoutMs.map { .milliseconds($0) }))
                #else
                    database = try await OliphauntDatabase.open(configuration: parsed.configuration)
                #endif
                completionBox.value(OliphauntAdapterDatabase(database: database), nil)
            } catch {
                completionBox.value(nil, nsError(error))
            }
        }
    }

    @objc(restoreWithStorageKind:storagePath:storageName:options:backupData:completion:)
    public static func restore(
        storageKind: String,
        storagePath: String?,
        storageName: String?,
        options: NSDictionary,
        backupData: Data,
        completion: @escaping (NSError?) -> Void
    ) {
        do {
            var config = options as? [String: Any] ?? [:]
            config["storageKind"] = storageKind
            config["storagePath"] = storagePath
            config["storageName"] = storageName
            let parsed = try parseOpenConfig(config as NSDictionary)
            let completionBox = CompletionBox(completion)
            Task(priority: .userInitiated) {
                do {
                    #if OLIPHAUNT_BROKER
                        guard #available(iOS 26, *) else {
                            throw adapterError("broker execution requires iOS 26")
                        }
                        guard storageKind == "applicationData" else {
                            throw adapterError("broker restore requires named applicationData storage")
                        }
                        let archive = FileManager.default.temporaryDirectory.appendingPathComponent(
                            "oliphaunt-restore-\(UUID().uuidString)")
                        defer { try? FileManager.default.removeItem(at: archive) }
                        try backupData.write(to: archive, options: .withoutOverwriting)
                        try await OliphauntBroker.restore(
                            storage: parsed.configuration.storage, from: archive,
                            options: .init(
                                startupTimeout: .milliseconds(parsed.startupTimeoutMs),
                                operationTimeout: parsed.operationTimeoutMs.map { .milliseconds($0) }))
                    #else
                        try await OliphauntDatabase.restore(storage: parsed.configuration.storage, bytes: backupData)
                    #endif
                    completionBox.value(nil)
                } catch {
                    completionBox.value(nsError(error))
                }
            }
        } catch {
            completion(nsError(error))
        }
    }

    @objc(execProtocolData:deadline:completion:)
    public func execProtocolData(
        _ request: Data,
        deadline: Double,
        completion: @escaping (NSData?, NSError?) -> Void
    ) {
        let completionBox = CompletionBox(completion)
        Task(priority: .userInitiated) { [database] in
            do {
                let response = try await Self.withOperationDeadline(deadline) {
                    try await database.execProtocolRaw(request)
                }
                completionBox.value(response as NSData, nil)
            } catch {
                completionBox.value(nil, Self.nsError(error))
            }
        }
    }

    @objc(execProtocolStreamData:deadline:onChunk:completion:)
    public func execProtocolStreamData(
        _ request: Data,
        deadline: Double,
        onChunk: @escaping (NSData) -> NSError?,
        completion: @escaping (NSError?) -> Void
    ) {
        let completionBox = CompletionBox(completion)
        let chunkBox = CompletionBox(onChunk)
        Task(priority: .userInitiated) { [database] in
            do {
                try await Self.withOperationDeadline(deadline) {
                    try await database.execProtocolRawStream(request) { chunk in
                        if let error = chunkBox.value(chunk as NSData) {
                            throw ProtocolStreamCallbackFailure(error)
                        }
                    }
                }
                completionBox.value(nil)
            } catch {
                if let recoveredCallback = error as? ProtocolStreamCallbackFailure {
                    // The Swift SDK can rethrow this private sentinel only for
                    // the typed result after recovery reached ReadyForQuery.
                    completionBox.value(
                        Self.protocolStreamCallbackAbortedError(recoveredCallback.callbackError)
                    )
                } else {
                    completionBox.value(Self.nsError(error))
                }
            }
        }
    }

    @objc(backupDataWithDeadline:completion:)
    public func backupData(
        deadline: Double,
        completion: @escaping (NSData?, NSError?) -> Void
    ) {
        let completionBox = CompletionBox(completion)
        Task(priority: .userInitiated) { [database] in
            do {
                let backup = try await Self.withOperationDeadline(deadline) {
                    try await database.reactNativeBackup()
                }
                completionBox.value(backup.value as NSData, nil)
            } catch {
                completionBox.value(nil, Self.nsError(error))
            }
        }
    }

    @objc(cancelWithCompletion:)
    public func cancel(completion: @escaping (NSError?) -> Void) {
        let completionBox = CompletionBox(completion)
        Task(priority: .userInitiated) { [database] in
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
        Task(priority: .userInitiated) { [database] in
            do {
                try await database.close()
                completionBox.value(nil)
            } catch {
                let native = Self.nsError(error)
                var info = native.userInfo
                info["oliphauntClosed"] = await database.isClosed
                completionBox.value(NSError(domain: native.domain, code: native.code, userInfo: info))
            }
        }
    }

    private struct CompletionBox<Value>: @unchecked Sendable {
        let value: Value

        init(_ value: Value) {
            self.value = value
        }
    }

    private static func operationDeadline(_ milliseconds: Double) -> ContinuousClock.Instant? {
        guard milliseconds > 0 else { return nil }
        var scale = mach_timebase_info_data_t()
        mach_timebase_info(&scale)
        let now = Double(mach_continuous_time()) * Double(scale.numer) / Double(scale.denom) / 1_000_000
        return ContinuousClock.now.advanced(by: .milliseconds(max(0, milliseconds - now)))
    }

    private static func withOperationDeadline<Result>(
        _ milliseconds: Double,
        operation: () async throws -> Result
    ) async rethrows -> Result {
        #if OLIPHAUNT_BROKER
            return try await OliphauntBridge.$deadline.withValue(
                operationDeadline(milliseconds),
                operation: operation
            )
        #else
            return try await operation()
        #endif
    }

    private struct ParsedOpenConfig {
        let startupTimeoutMs: Int64
        let operationTimeoutMs: Int64?
        var configuration: OliphauntConfiguration
    }

    private static func parseOpenConfig(_ config: NSDictionary) throws -> ParsedOpenConfig {
        let storage = try parseDatabaseStorage(config)
        let username = try startupIdentity(config, "username")
        let database = try startupIdentity(config, "database")
        let extensions = try stringArray(config, "extensions").map {
            try OliphauntExtension(sqlName: $0)
        }
        let configuration = OliphauntConfiguration(
            storage: storage,
            startupGUCs: try startupGUCs(config, "startupGUCs"),
            username: username,
            database: database,
            extensions: extensions
        )
        if topology() == "direct", config["startupTimeoutMs"] != nil || config["operationTimeoutMs"] != nil {
            throw adapterError("broker timeouts require a broker native build")
        }
        func timeout(_ key: String) throws -> Int64? {
            guard let raw = config[key] else { return nil }
            guard let number = raw as? NSNumber, number.doubleValue.isFinite,
                number.doubleValue > 0, number.doubleValue <= 9_007_199_254_740_991,
                number.doubleValue.rounded(.towardZero) == number.doubleValue
            else { throw adapterError("invalid broker timeout") }
            return number.int64Value
        }
        return ParsedOpenConfig(
            startupTimeoutMs: try timeout("startupTimeoutMs") ?? 30_000,
            operationTimeoutMs: try timeout("operationTimeoutMs"), configuration: configuration)
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

    private static func parseDatabaseStorage(
        _ config: NSDictionary
    ) throws -> OliphauntDatabaseStorage {
        switch try string(config, "storageKind") ?? "temporaryDirectory" {
        case "temporaryDirectory":
            return .temporaryDirectory
        case "directory":
            guard
                let path = try nonBlankString(
                    config,
                    "storagePath",
                    emptyMessage: "database storage directory must not be empty"
                )
            else {
                throw adapterError("directory storage requires storagePath")
            }
            return .directory(URL(fileURLWithPath: path, isDirectory: true))
        case "applicationData":
            guard
                let name = try nonBlankString(
                    config,
                    "storageName",
                    emptyMessage: "applicationData storage name must not be empty"
                )
            else {
                throw adapterError("applicationData storage requires storageName")
            }
            guard isPortableStorageName(name) else {
                throw adapterError(
                    "applicationData storage name must contain 1 to 128 ASCII letters, digits, dot, underscore or hyphen"
                )
            }
            return .applicationData(name: name)
        case let kind:
            throw adapterError("unknown database storage kind '\(kind)'")
        }
    }

    private static func isPortableStorageName(_ value: String) -> Bool {
        let bytes = value.utf8
        guard !bytes.isEmpty, bytes.count <= 128, value != ".", value != ".." else {
            return false
        }
        return bytes.allSatisfy { byte in
            (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57)
                || byte == 46 || byte == 95 || byte == 45
        }
    }

    private static func applicationDataName(_ value: String?) throws -> String {
        let name = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard isPortableStorageName(name) else {
            throw adapterError(
                "applicationData storage name must contain 1 to 128 ASCII letters, digits, dot, underscore or hyphen"
            )
        }
        return name
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

    private static func startupGUCs(_ dictionary: NSDictionary, _ key: String) throws
        -> [OliphauntStartupGUC]
    {
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

    private static func protocolStreamCallbackAbortedError(_ error: NSError) -> NSError {
        NSError(
            domain: OliphauntProtocolStreamCallbackAbortedErrorDomain,
            code: 1,
            userInfo: [
                NSLocalizedDescriptionKey: error.localizedDescription,
                NSUnderlyingErrorKey: error,
            ]
        )
    }

    private static func nsError(_ error: Error) -> NSError {
        if let nsError = error as NSError?, nsError.domain == errorDomain {
            return nsError
        }
        var details: [String: Any] = [NSLocalizedDescriptionKey: message(error)]
        if let broker = error as? OliphauntBrokerError {
            details["reason"] = broker.reason.rawValue
            details["execution"] = broker.execution.rawValue
            details["requiresReopen"] = broker.requiresReopen
        }
        return NSError(domain: errorDomain, code: 2, userInfo: details)
    }

    private static func message(_ error: Error) -> String {
        switch error {
        case OliphauntError.databaseClosed:
            return "Oliphaunt database is closed"
        case OliphauntError.engine(let message):
            return message
        default:
            return (error as NSError).localizedDescription
        }
    }
}

extension String {
    fileprivate func removingPrefix(_ prefix: String) -> String? {
        guard hasPrefix(prefix) else {
            return nil
        }
        return String(dropFirst(prefix.count))
    }
}
