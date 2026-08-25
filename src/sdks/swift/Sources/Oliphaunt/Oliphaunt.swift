import Foundation

enum OliphauntNativeCatalogProfile: String, Sendable {
    case standard
    case icu
}

public struct OliphauntStartupGUC: Equatable, Sendable {
    public var name: String
    public var value: String

    public init(_ name: String, _ value: String) {
        self.name = name
        self.value = value
    }
}

public enum OliphauntDatabaseStorage: Equatable, Sendable {
    case temporaryDirectory
    case directory(URL)
}

public struct OliphauntConfiguration: Equatable, Sendable {
    public var storage: OliphauntDatabaseStorage
    public var startupGUCs: [OliphauntStartupGUC]
    public var username: String?
    public var database: String?
    public var extensions: [String]

    public init(
        storage: OliphauntDatabaseStorage = .temporaryDirectory,
        startupGUCs: [OliphauntStartupGUC] = [],
        username: String? = nil,
        database: String? = nil,
        extensions: [String] = []
    ) {
        self.storage = storage
        self.startupGUCs = startupGUCs
        self.username = username
        self.database = database
        self.extensions = extensions
    }
}

func validateOliphauntStartupIdentity(_ value: String?, label: String) throws {
    guard let value else {
        return
    }
    if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        throw OliphauntError.engine("\(label) must not be empty")
    }
    if value.utf8.contains(0) {
        throw OliphauntError.engine("\(label) must not contain NUL bytes")
    }
}

func requireOliphauntFreshRootRole(_ username: String) throws {
    guard username == "postgres" else {
        throw OliphauntError.engine(
            "a new Swift Oliphaunt database is initialized with the postgres role; " +
                "username selects an existing role and cannot be '\(username)' on first open"
        )
    }
}

func validateOliphauntStartupGUCs(_ gucs: [OliphauntStartupGUC]) throws {
    for guc in gucs {
        let name = guc.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            throw OliphauntError.engine("PostgreSQL startup GUC name must not be empty")
        }
        if name.utf8.contains(0) || guc.value.utf8.contains(0) {
            throw OliphauntError.engine("PostgreSQL startup GUC must not contain NUL bytes")
        }
        if !isPortablePostgresGUCName(name) {
            throw OliphauntError.engine(
                "PostgreSQL startup GUC name '\(guc.name)': each dot-separated component must start " +
                    "with an ASCII letter or '_', followed by ASCII letters, digits, '_', or '$'"
            )
        }
    }
}

private func isPortablePostgresGUCName(_ name: String) -> Bool {
    name.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { component in
        guard let first = component.utf8.first,
              isASCIIAlpha(first) || first == 95 else {
            return false
        }
        return component.utf8.dropFirst().allSatisfy { byte in
            isASCIIAlpha(byte) || (byte >= 48 && byte <= 57) || byte == 95 || byte == 36
        }
    }
}

private func isASCIIAlpha(_ byte: UInt8) -> Bool {
    (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
}

func validateOliphauntStorage(_ storage: OliphauntDatabaseStorage) throws {
    guard case .directory(let directory) = storage else {
        return
    }
    try validateOliphauntDirectory(directory, label: "database storage directory")
}

func validateOliphauntDirectory(_ directory: URL, label: String) throws {
    guard directory.isFileURL else {
        throw OliphauntError.engine("\(label) must be a file URL")
    }
    if directory.path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        throw OliphauntError.engine("\(label) must not be empty")
    }
    if directory.path.utf8.contains(0) ||
        directory.absoluteString.range(of: "%00", options: .caseInsensitive) != nil {
        throw OliphauntError.engine("\(label) must not contain NUL bytes")
    }
}

public enum OliphauntError: Error, Equatable, Sendable, CustomStringConvertible {
    case databaseClosed
    case engine(String)
    case postgres(OliphauntPostgresError)

    public var description: String {
        switch self {
        case .databaseClosed:
            "database is closed"
        case .engine(let message):
            message
        case .postgres(let error):
            error.description
        }
    }
}

// The engine boundary is deliberately internal. Applications use
// OliphauntDatabase; the protocol exists only to keep the facade testable and
// to isolate the native C bridge.
protocol OliphauntEngine: Sendable {
    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession
    func restore(destination: URL, bytes: Data) async throws
}

protocol OliphauntSession: Sendable {
    func execProtocolRaw(_ bytes: Data) async throws -> Data
    func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws
    func backup() async throws -> Data
    func cancel() async throws
    func close() async throws
}

struct OliphauntDefaultEngine: OliphauntEngine {
    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        try await OliphauntNativeDirectEngine().open(configuration: configuration)
    }

    func restore(destination: URL, bytes: Data) async throws {
        try await OliphauntNativeDirectEngine().restore(destination: destination, bytes: bytes)
    }
}

private actor OliphauntAsyncSerialGate {
    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !locked {
            locked = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func release() {
        if waiters.isEmpty {
            locked = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}

public actor OliphauntDatabase {
    private var session: (any OliphauntSession)?
    private var closing = false
    private var poisonedMessage: String?
    private var activeTransactionToken: UInt64?
    private var nextTransactionToken: UInt64 = 1
    private let operationGate = OliphauntAsyncSerialGate()

    private init(session: any OliphauntSession) {
        self.session = session
    }

    public static func open(
        configuration: OliphauntConfiguration = .init()
    ) async throws -> OliphauntDatabase {
        try await open(configuration: configuration, engine: OliphauntDefaultEngine())
    }

    static func open(
        configuration: OliphauntConfiguration = .init(),
        engine: any OliphauntEngine
    ) async throws -> OliphauntDatabase {
        try validateOliphauntStorage(configuration.storage)
        try validateOliphauntStartupIdentity(configuration.username, label: "username")
        try validateOliphauntStartupIdentity(configuration.database, label: "database")
        try validateOliphauntStartupGUCs(configuration.startupGUCs)
        var normalized = configuration
        normalized.extensions = try OliphauntRuntimeResources.normalizedExtensionIds(
            configuration.extensions
        )
        return OliphauntDatabase(session: try await engine.open(configuration: normalized))
    }

    public static func restore(destination: URL, bytes: Data) async throws {
        try await restore(
            destination: destination,
            bytes: bytes,
            engine: OliphauntDefaultEngine()
        )
    }

    static func restore(
        destination: URL,
        bytes: Data,
        engine: any OliphauntEngine
    ) async throws {
        try validateOliphauntDirectory(destination, label: "restore destination")
        try await engine.restore(destination: destination, bytes: bytes)
    }

    public func execProtocolRaw(_ bytes: Data) async throws -> Data {
        try await execProtocolRaw(bytes, transactionToken: nil)
    }

    public func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try await execProtocolStream(bytes, transactionToken: nil, onChunk: onChunk)
    }

    public func backup() async throws -> sending Data {
        try validateTransactionAccess(token: nil)
        return try await runSessionOperation { session in
            try await session.backup()
        }
    }

    public func checkpoint() async throws {
        _ = try await execute("CHECKPOINT")
    }

    public func transaction<T: Sendable>(
        _ body: @Sendable (OliphauntTransaction) async throws -> T
    ) async throws -> T {
        guard activeTransactionToken == nil else {
            throw OliphauntError.engine(Self.sessionPinnedMessage)
        }
        let token = nextTransactionToken
        nextTransactionToken = nextTransactionToken == UInt64.max ? 1 : nextTransactionToken + 1
        activeTransactionToken = token
        let transaction = OliphauntTransaction(database: self, token: token)

        let result: T
        do {
            let begin = try await executeTransactionControl("BEGIN", token: token)
            guard begin.commandTag == "BEGIN" else {
                throw OliphauntError.engine("BEGIN returned unexpected command tag \(begin.commandTag ?? "<none>")")
            }
            result = try await body(transaction)
        } catch {
            do {
                let rollback = try await executeTransactionControl("ROLLBACK", token: token)
                guard rollback.commandTag == "ROLLBACK" else {
                    throw OliphauntError.engine(
                        "ROLLBACK returned unexpected command tag \(rollback.commandTag ?? "<none>")"
                    )
                }
            } catch let rollbackError {
                poisonedMessage = "transaction rollback failed; close and reopen the database: \(rollbackError)"
            }
            activeTransactionToken = nil
            throw error
        }

        let commit: OliphauntCommandResult
        do {
            commit = try await executeTransactionControl("COMMIT", token: token)
        } catch {
            poisonedMessage = "transaction COMMIT outcome is unknown; close and reopen the database: \(error)"
            activeTransactionToken = nil
            throw error
        }
        guard commit.commandTag == "COMMIT" else {
            if commit.commandTag != "ROLLBACK" {
                poisonedMessage =
                    "transaction COMMIT outcome is unknown after command tag \(commit.commandTag ?? "<none>"); close and reopen the database"
            }
            activeTransactionToken = nil
            throw OliphauntError.engine(
                "COMMIT returned unexpected command tag \(commit.commandTag ?? "<none>")"
            )
        }
        activeTransactionToken = nil
        return result
    }

    public func cancel() async throws {
        try await liveSession().cancel()
    }

    public func close() async throws {
        guard let closingSession = session else {
            return
        }
        guard activeTransactionToken == nil else {
            throw OliphauntError.engine(Self.sessionPinnedMessage)
        }
        guard !closing else {
            throw OliphauntError.engine("database close is already in progress")
        }
        closing = true
        await operationGate.acquire()
        do {
            try await closingSession.close()
            session = nil
            closing = false
            await operationGate.release()
        } catch {
            closing = false
            await operationGate.release()
            throw error
        }
    }

    private func liveSession() throws -> any OliphauntSession {
        guard let session, !closing else {
            throw OliphauntError.databaseClosed
        }
        if let poisonedMessage {
            throw OliphauntError.engine(poisonedMessage)
        }
        return session
    }

    fileprivate func execProtocolRaw(_ bytes: Data, transactionToken: UInt64?) async throws -> Data {
        try validateTransactionAccess(token: transactionToken)
        return try await runSessionOperation(transactionToken: transactionToken) {
            try await $0.execProtocolRaw(bytes)
        }
    }

    fileprivate func execProtocolStream(
        _ bytes: Data,
        transactionToken: UInt64?,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try validateTransactionAccess(token: transactionToken)
        try await runSessionOperation(transactionToken: transactionToken) {
            try await $0.execProtocolStream(bytes, onChunk: onChunk)
        }
    }

    private func executeTransactionControl(
        _ sql: String,
        token: UInt64
    ) async throws -> OliphauntCommandResult {
        let request = try OliphauntProtocol.simpleQuery(sql)
        return try await parseOliphauntCommandResponse(
            execProtocolRaw(request, transactionToken: token)
        )
    }

    private func runSessionOperation<T: Sendable>(
        transactionToken: UInt64? = nil,
        _ body: (any OliphauntSession) async throws -> T
    ) async throws -> T {
        try validateTransactionAccess(token: transactionToken)
        await operationGate.acquire()
        do {
            let session = try liveSession()
            try validateTransactionAccess(token: transactionToken)
            let result = try await body(session)
            await operationGate.release()
            return result
        } catch {
            await operationGate.release()
            throw error
        }
    }

    private func validateTransactionAccess(token: UInt64?) throws {
        if let token {
            guard activeTransactionToken == token else {
                throw OliphauntError.engine("transaction is no longer active")
            }
            return
        }
        if activeTransactionToken != nil {
            throw OliphauntError.engine(Self.sessionPinnedMessage)
        }
    }

    private static let sessionPinnedMessage =
        "physical session is pinned; use the active OliphauntTransaction"
}

public struct OliphauntTransaction: Sendable {
    fileprivate let database: OliphauntDatabase
    fileprivate let token: UInt64

    public func execProtocolRaw(_ bytes: Data) async throws -> Data {
        try await database.execProtocolRaw(bytes, transactionToken: token)
    }

    public func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try await database.execProtocolStream(bytes, transactionToken: token, onChunk: onChunk)
    }

}

extension OliphauntConfiguration {
    func postgresStartupArgs(sharedPreloadLibraries: [String] = []) -> [String] {
        var args: [String] = []
        for guc in startupGUCs {
            args.append("-c")
            args.append("\(guc.name.trimmingCharacters(in: .whitespacesAndNewlines))=\(guc.value)")
        }
        let preloadLibraries = Set(sharedPreloadLibraries).sorted()
        if !preloadLibraries.isEmpty {
            args.append("-c")
            args.append("shared_preload_libraries=\(preloadLibraries.joined(separator: ","))")
        }
        return args
    }
}
