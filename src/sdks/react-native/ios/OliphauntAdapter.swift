import Foundation
import Oliphaunt

private struct SendableData: @unchecked Sendable {
    let value: Data
}

private final class ProtocolStreamCallbackFailure: Error, @unchecked Sendable {
    let callbackError: NSError

    init(_ callbackError: NSError) {
        self.callbackError = callbackError
    }
}

private extension OliphauntDatabase {
    func reactNativeBackup() async throws -> SendableData {
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
                let database = try await OliphauntDatabase.open(configuration: parsed.configuration)
                completionBox.value(OliphauntAdapterDatabase(database: database), nil)
            } catch {
                completionBox.value(nil, nsError(error))
            }
        }
    }

    @objc(restoreWithStorageKind:storagePath:storageName:backupData:completion:)
    public static func restore(
        storageKind: String,
        storagePath: String?,
        storageName: String?,
        backupData: Data,
        completion: @escaping (NSError?) -> Void
    ) {
        do {
            let destination = try restoreDestination(
                storageKind: storageKind,
                storagePath: storagePath,
                storageName: storageName
            )
            let completionBox = CompletionBox(completion)
            Task(priority: .userInitiated) {
                do {
                    try await OliphauntDatabase.restore(destination: destination, bytes: backupData)
                    completionBox.value(nil)
                } catch {
                    completionBox.value(nsError(error))
                }
            }
        } catch {
            completion(nsError(error))
        }
    }

    private static func restoreDestination(
        storageKind: String,
        storagePath: String?,
        storageName: String?
    ) throws -> URL {
        switch storageKind {
        case "directory":
            guard let storagePath,
                  !storagePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !storagePath.contains("\0") else {
                throw adapterError("restore destination directory must not be empty or contain NUL bytes")
            }
            return URL(fileURLWithPath: storagePath, isDirectory: true)
        case "applicationData":
            let name = try applicationDataName(storageName)
            guard let support = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first else {
                throw adapterError("failed to resolve application data restore directory")
            }
            return support
                .appendingPathComponent("Oliphaunt", isDirectory: true)
                .appendingPathComponent(name, isDirectory: true)
        default:
            throw adapterError("unknown restore destination kind '\(storageKind)'")
        }
    }

    @objc(execProtocolData:completion:)
    public func execProtocolData(
        _ request: Data,
        completion: @escaping (NSData?, NSError?) -> Void
    ) {
        let completionBox = CompletionBox(completion)
        Task(priority: .userInitiated) { [database] in
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
        onChunk: @escaping (NSData) -> NSError?,
        completion: @escaping (NSError?) -> Void
    ) {
        let completionBox = CompletionBox(completion)
        let chunkBox = CompletionBox(onChunk)
        Task(priority: .userInitiated) { [database] in
            do {
                try await database.execProtocolRawStream(request) { chunk in
                    if let error = chunkBox.value(chunk as NSData) {
                        throw ProtocolStreamCallbackFailure(error)
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

    @objc(backupDataWithCompletion:)
    public func backupData(
        completion: @escaping (NSData?, NSError?) -> Void
    ) {
        let completionBox = CompletionBox(completion)
        Task(priority: .userInitiated) { [database] in
            do {
                let backup = try await database.reactNativeBackup()
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
                completionBox.value(Self.nsError(error))
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
    }

    private static func parseOpenConfig(_ config: NSDictionary) throws -> ParsedOpenConfig {
        let storage = try parseDatabaseStorage(config)
        let username = try startupIdentity(config, "username")
        let database = try startupIdentity(config, "database")
        let extensions = try stringArray(config, "extensions")
        let configuration = OliphauntConfiguration(
            storage: storage,
            startupGUCs: try startupGUCs(config, "startupGUCs"),
            username: username,
            database: database,
            extensions: extensions
        )
        return ParsedOpenConfig(configuration: configuration)
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
            guard let path = try nonBlankString(
                config,
                "storagePath",
                emptyMessage: "database storage directory must not be empty"
            ) else {
                throw adapterError("directory storage requires storagePath")
            }
            return .directory(URL(fileURLWithPath: path, isDirectory: true))
        case "applicationData":
            guard let name = try nonBlankString(
                config,
                "storageName",
                emptyMessage: "applicationData storage name must not be empty"
            ) else {
                throw adapterError("applicationData storage requires storageName")
            }
            guard isPortableStorageName(name) else {
                throw adapterError(
                    "applicationData storage name must contain 1 to 128 ASCII letters, digits, dot, underscore or hyphen"
                )
            }
            guard let baseURL = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first else {
                throw adapterError("failed to resolve application data storage directory")
            }
            return .directory(
                baseURL
                    .appendingPathComponent("Oliphaunt", isDirectory: true)
                    .appendingPathComponent(name, isDirectory: true)
            )
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
            (byte >= 65 && byte <= 90) ||
                (byte >= 97 && byte <= 122) ||
                (byte >= 48 && byte <= 57) ||
                byte == 46 || byte == 95 || byte == 45
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
        return NSError(
            domain: errorDomain,
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: message(error)]
        )
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

private extension String {
    func removingPrefix(_ prefix: String) -> String? {
        guard hasPrefix(prefix) else {
            return nil
        }
        return String(dropFirst(prefix.count))
    }
}
