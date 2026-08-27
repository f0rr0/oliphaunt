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

/// Reports both failures when a transaction callback throws and its automatic
/// rollback cannot be confirmed. The database is poisoned and must be closed.
public struct OliphauntTransactionRollbackError: Error, Sendable, CustomStringConvertible {
    public let callbackError: any Error
    public let rollbackError: any Error

    public var description: String {
        "transaction callback failed and automatic ROLLBACK did not complete; " +
            "close and reopen the database; callback: \(callbackError); rollback: \(rollbackError)"
    }

    init(callbackError: any Error, rollbackError: any Error) {
        self.callbackError = callbackError
        self.rollbackError = rollbackError
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
    func execProtocolRawStream(
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
    private var waiterCountObservers: [(Int, CheckedContinuation<Void, Never>)] = []

    func acquire() async {
        if !locked {
            locked = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
            resumeSatisfiedWaiterCountObservers()
        }
    }

    func release() {
        if waiters.isEmpty {
            locked = false
        } else {
            waiters.removeFirst().resume()
        }
    }

    func waitUntilWaiterCount(atLeast expected: Int) async {
        guard waiters.count < expected else { return }
        await withCheckedContinuation { continuation in
            waiterCountObservers.append((expected, continuation))
        }
    }

    private func resumeSatisfiedWaiterCountObservers() {
        var pending: [(Int, CheckedContinuation<Void, Never>)] = []
        for observer in waiterCountObservers {
            if waiters.count >= observer.0 {
                observer.1.resume()
            } else {
                pending.append(observer)
            }
        }
        waiterCountObservers = pending
    }
}

private enum OliphauntProtocolStreamTaskContext {
    @TaskLocal static var databaseID: UUID?
}

private final class OliphauntProtocolStreamCallbackGate: @unchecked Sendable {
    private let lock = NSLock()
    private var active = false

    func withCallback(
        databaseID: UUID,
        _ body: () throws -> Void
    ) throws {
        lock.lock()
        guard !active else {
            lock.unlock()
            throw OliphauntError.engine(Self.reentryMessage)
        }
        active = true
        lock.unlock()
        defer {
            lock.lock()
            active = false
            lock.unlock()
        }
        try OliphauntProtocolStreamTaskContext.$databaseID.withValue(databaseID) {
            try body()
        }
    }

    func isReentry(databaseID: UUID) -> Bool {
        OliphauntProtocolStreamTaskContext.databaseID == databaseID
    }

    static let reentryMessage =
        "raw protocol stream callback must not reenter the same Oliphaunt database or transaction"
}

public actor OliphauntDatabase {
    private enum TransactionCompletion {
        case active
        case rollingBack
        case committing
        case rolledBack
        case committed
        case failed(String)
    }

    private struct ActiveTransaction {
        let token: UInt64
        var completion: TransactionCompletion = .active
    }

    private var session: (any OliphauntSession)?
    private var closing = false
    private var closeTeardownStarted = false
    private var closeTeardownStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var activeCancellationCount = 0
    private var cancellationDrainWaiters: [CheckedContinuation<Void, Never>] = []
    private var poisonedMessage: String?
    private var activeTransaction: ActiveTransaction?
    private var nextTransactionToken: UInt64 = 1
    private let operationGate = OliphauntAsyncSerialGate()
    private let protocolStreamDatabaseID = UUID()
    private let protocolStreamCallbackGate = OliphauntProtocolStreamCallbackGate()

    private init(session: any OliphauntSession) {
        self.session = session
    }

    public var isClosed: Bool {
        session == nil
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

    public func execProtocolRawStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try await execProtocolRawStream(bytes, transactionToken: nil, onChunk: onChunk)
    }

    public func backup() async throws -> sending Data {
        return try await runSessionOperation { session in
            try await session.backup()
        }
    }

    public func transaction<T: Sendable>(
        _ body: @Sendable (OliphauntTransaction) async throws -> T
    ) async throws -> T {
        _ = try liveSession()
        guard activeTransaction == nil else {
            throw OliphauntError.engine(Self.sessionPinnedMessage)
        }
        let token = nextTransactionToken
        nextTransactionToken = nextTransactionToken == UInt64.max ? 1 : nextTransactionToken + 1
        activeTransaction = ActiveTransaction(token: token)
        let transaction = OliphauntTransaction(database: self, token: token)

        let result: T
        var began = false
        do {
            let begin = try await executeTransactionControl("BEGIN", token: token)
            guard begin.commandTag == "BEGIN" else {
                throw OliphauntError.engine("BEGIN returned unexpected command tag \(begin.commandTag ?? "<none>")")
            }
            began = true
            result = try await body(transaction)
        } catch let callbackError {
            var rollbackError: (any Error)?
            if began, transactionIsActive(token: token) {
                do {
                    try await rollbackTransaction(token: token)
                } catch let error {
                    rollbackError = error
                }
            }
            clearTransaction(token: token)
            if let rollbackError {
                throw OliphauntTransactionRollbackError(
                    callbackError: callbackError,
                    rollbackError: rollbackError
                )
            }
            throw callbackError
        }

        guard let activeTransaction, activeTransaction.token == token else {
            let message = "transaction state was lost; close and reopen the database"
            poisonedMessage = message
            throw OliphauntError.engine(message)
        }
        switch activeTransaction.completion {
        case .rolledBack:
            clearTransaction(token: token)
            return result
        case .failed(let message):
            clearTransaction(token: token)
            throw OliphauntError.engine(message)
        case .active:
            break
        case .rollingBack, .committing, .committed:
            let message = "transaction settlement state is inconsistent; close and reopen the database"
            poisonTransaction(token: token, message: message)
            clearTransaction(token: token)
            throw OliphauntError.engine(message)
        }

        let commit: OliphauntCommandResult
        do {
            try beginTransactionSettlement(token: token, completion: .committing)
            commit = try await executeTransactionControl(
                "COMMIT",
                token: token,
                settlement: .committing
            )
        } catch {
            clearTransaction(token: token)
            throw error
        }
        guard commit.commandTag == "COMMIT" else {
            clearTransaction(token: token)
            throw OliphauntError.engine(
                "COMMIT returned unexpected command tag \(commit.commandTag ?? "<none>")"
            )
        }
        clearTransaction(token: token)
        return result
    }

    public func cancel() async throws {
        guard let session, !closeTeardownStarted else {
            throw OliphauntError.databaseClosed
        }
        activeCancellationCount += 1
        // Cancellation is deliberately out of band. It remains available
        // while close is only waiting for already-admitted FIFO work, and it
        // is the sole same-handle action permitted from a stream callback.
        do {
            try await session.cancel()
            finishCancellationAdmission()
        } catch {
            finishCancellationAdmission()
            throw error
        }
    }

    public func close() async throws {
        try ensureNoProtocolStreamCallbackReentry()
        guard let closingSession = session else {
            return
        }
        guard activeTransaction == nil else {
            throw OliphauntError.engine(Self.sessionPinnedMessage)
        }
        guard !closing else {
            throw OliphauntError.engine("database close is already in progress")
        }
        closing = true
        await operationGate.acquire()
        closeTeardownStarted = true
        let teardownWaiters = closeTeardownStartWaiters
        closeTeardownStartWaiters.removeAll()
        teardownWaiters.forEach { $0.resume() }
        await waitForCancellationDrain()
        do {
            try await closingSession.close()
            session = nil
            closing = false
            await operationGate.release()
        } catch {
            closeTeardownStarted = false
            closing = false
            await operationGate.release()
            throw error
        }
    }

    private func liveSession() throws -> any OliphauntSession {
        try ensureNoProtocolStreamCallbackReentry()
        guard let session, !closing, !closeTeardownStarted else {
            throw OliphauntError.databaseClosed
        }
        if let poisonedMessage {
            throw OliphauntError.engine(poisonedMessage)
        }
        return session
    }

    /// Returns the session captured by an operation that passed lifecycle and
    /// transaction validation at admission. A later close or transaction
    /// cutoff must not revoke that permit, but an outcome from earlier queued
    /// work may still poison the session before this operation reaches it.
    private func sessionForAdmittedOperation(
        _ admittedSession: any OliphauntSession
    ) throws -> any OliphauntSession {
        guard session != nil else {
            throw OliphauntError.databaseClosed
        }
        if let poisonedMessage {
            throw OliphauntError.engine(poisonedMessage)
        }
        return admittedSession
    }

    fileprivate func execProtocolRaw(_ bytes: Data, transactionToken: UInt64?) async throws -> Data {
        try validateTransactionAccess(token: transactionToken)
        return try await runSessionOperation(transactionToken: transactionToken) {
            try await $0.execProtocolRaw(bytes)
        }
    }

    fileprivate func execProtocolRawStream(
        _ bytes: Data,
        transactionToken: UInt64?,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try validateTransactionAccess(token: transactionToken)
        let callbackGate = protocolStreamCallbackGate
        let databaseID = protocolStreamDatabaseID
        try await runSessionOperation(transactionToken: transactionToken) {
            try await $0.execProtocolRawStream(bytes) { chunk in
                try callbackGate.withCallback(databaseID: databaseID) {
                    try onChunk(chunk)
                }
            }
        }
    }

    private func executeTransactionControl(
        _ sql: String,
        token: UInt64,
        settlement: TransactionCompletion? = nil
    ) async throws -> OliphauntCommandResult {
        let request = try OliphauntProtocol.simpleQuery(sql)
        let expectedStatus: OliphauntReadyStatus = sql == "BEGIN" ? .transaction : .idle
        if let settlement {
            try validateTransactionSettlement(token: token, expected: settlement)
        } else {
            try validateTransactionAccess(token: token)
        }
        let admittedSession = try liveSession()
        await operationGate.acquire()
        do {
            let session = try sessionForAdmittedOperation(admittedSession)
            if let settlement {
                // Earlier queued work may have poisoned the transaction. That
                // earlier result is allowed to reject this later settlement.
                try validateTransactionSettlement(token: token, expected: settlement)
            }
            let response: Data
            do {
                response = try await session.execProtocolRaw(request)
            } catch {
                if settlement == nil {
                    poisonUnknownTypedOperation(transactionToken: token, error: error)
                }
                throw error
            }
            let terminalStatus: OliphauntReadyStatus
            do {
                terminalStatus = try inspectOliphauntTerminalReadyStatus(response)
            } catch {
                if settlement == nil {
                    poisonUnknownTypedOperation(transactionToken: token, error: error)
                }
                throw error
            }
            let result = try parseOliphauntCommandResponse(response, expectedProtocol: .simple)
            guard terminalStatus == expectedStatus, result.readyStatus == terminalStatus else {
                throw OliphauntError.engine(
                    "\(sql) returned unexpected ReadyForQuery status \(terminalStatus)"
                )
            }
            if let settlement {
                let completion: TransactionCompletion
                switch (settlement, result.commandTag) {
                case (.rollingBack, "ROLLBACK"), (.committing, "ROLLBACK"):
                    completion = .rolledBack
                case (.committing, "COMMIT"):
                    completion = .committed
                case (.rollingBack, _):
                    throw OliphauntError.engine(
                        "ROLLBACK returned unexpected command tag \(result.commandTag ?? "<none>")"
                    )
                case (.committing, _):
                    throw OliphauntError.engine(
                        "COMMIT returned unexpected command tag \(result.commandTag ?? "<none>")"
                    )
                default:
                    throw OliphauntError.engine("invalid transaction settlement state")
                }
                try finishTransactionSettlement(
                    token: token,
                    expected: settlement,
                    completion: completion
                )
            }
            await operationGate.release()
            return result
        } catch {
            if settlement != nil {
                let label = sql == "COMMIT" ? "transaction COMMIT outcome is unknown" : "transaction rollback failed"
                poisonTransaction(
                    token: token,
                    message: "\(label); close and reopen the database: \(error)"
                )
            }
            await operationGate.release()
            throw error
        }
    }

    private func beginTransactionSettlement(
        token: UInt64,
        completion: TransactionCompletion
    ) throws {
        try validateTransactionAccess(token: token)
        guard var transaction = activeTransaction, transaction.token == token else {
            throw OliphauntError.engine("transaction is no longer active")
        }
        transaction.completion = completion
        activeTransaction = transaction
    }

    private func validateTransactionSettlement(
        token: UInt64,
        expected: TransactionCompletion
    ) throws {
        guard let transaction = activeTransaction, transaction.token == token else {
            throw OliphauntError.engine("transaction settlement is no longer active")
        }
        let matches: Bool
        switch (transaction.completion, expected) {
        case (.rollingBack, .rollingBack), (.committing, .committing):
            matches = true
        default:
            matches = false
        }
        guard matches else {
            throw OliphauntError.engine("transaction settlement is no longer active")
        }
    }

    private func finishTransactionSettlement(
        token: UInt64,
        expected: TransactionCompletion,
        completion: TransactionCompletion
    ) throws {
        try validateTransactionSettlement(token: token, expected: expected)
        guard var transaction = activeTransaction, transaction.token == token else {
            throw OliphauntError.engine("transaction settlement is no longer active")
        }
        transaction.completion = completion
        activeTransaction = transaction
    }

    func runTypedOperation<T: Sendable>(
        _ request: Data,
        transactionToken: UInt64?,
        parser: @Sendable (Data) throws -> (T, OliphauntReadyStatus)
    ) async throws -> T {
        try validateTransactionAccess(token: transactionToken)
        let admittedSession = try liveSession()
        await operationGate.acquire()
        do {
            let session = try sessionForAdmittedOperation(admittedSession)
            let response: Data
            do {
                response = try await session.execProtocolRaw(request)
            } catch {
                poisonUnknownTypedOperation(transactionToken: transactionToken, error: error)
                throw error
            }
            let terminalStatus: OliphauntReadyStatus
            do {
                terminalStatus = try inspectOliphauntTerminalReadyStatus(response)
            } catch {
                poisonUnknownTypedOperation(transactionToken: transactionToken, error: error)
                throw error
            }
            let parsed: (T, OliphauntReadyStatus)
            do {
                parsed = try parser(response)
            } catch {
                try await validateTypedOperationFailureStatus(
                    terminalStatus,
                    transactionToken: transactionToken,
                    session: session
                )
                throw error
            }
            let (result, parsedStatus) = parsed
            guard parsedStatus == terminalStatus else {
                try await validateTypedOperationFailureStatus(
                    terminalStatus,
                    transactionToken: transactionToken,
                    session: session
                )
                throw OliphauntError.engine(
                    "typed response parser disagreed with terminal ReadyForQuery status"
                )
            }
            try await validateTypedOperationStatus(
                terminalStatus,
                transactionToken: transactionToken,
                session: session
            )
            await operationGate.release()
            return result
        } catch {
            await operationGate.release()
            throw error
        }
    }

    private func validateTypedOperationStatus(
        _ status: OliphauntReadyStatus,
        transactionToken: UInt64?,
        session: any OliphauntSession
    ) async throws {
        if let transactionToken {
            switch status {
            case .transaction:
                return
            case .failedTransaction:
                throw OliphauntError.engine(
                    "transaction operation left PostgreSQL in a failed transaction; the callback will roll back"
                )
            case .idle:
                throw escapedTransactionOwnershipError(token: transactionToken)
            }
        }

        guard status != .idle else { return }
        let statusLabel = status == .transaction ? "an open transaction" : "a failed transaction"
        try await recoverUnexpectedDatabaseTransaction(status, session: session)
        throw OliphauntError.engine(
            "typed operation left PostgreSQL in \(statusLabel); Oliphaunt rolled it back to preserve callback ownership"
        )
    }

    private func validateTypedOperationFailureStatus(
        _ status: OliphauntReadyStatus,
        transactionToken: UInt64?,
        session: any OliphauntSession
    ) async throws {
        if let transactionToken {
            guard status == .idle else { return }
            throw escapedTransactionOwnershipError(token: transactionToken)
        }

        guard status != .idle else { return }
        try await recoverUnexpectedDatabaseTransaction(status, session: session)
    }

    private func recoverUnexpectedDatabaseTransaction(
        _ status: OliphauntReadyStatus,
        session: any OliphauntSession
    ) async throws {
        let statusLabel = status == .transaction ? "an open transaction" : "a failed transaction"
        do {
            let request = try OliphauntProtocol.simpleQuery("ROLLBACK")
            let rollback = try parseOliphauntCommandResponse(
                try await session.execProtocolRaw(request),
                expectedProtocol: .simple
            )
            guard rollback.commandTag == "ROLLBACK", rollback.readyStatus == .idle else {
                throw OliphauntError.engine(
                    "automatic ROLLBACK returned unexpected command tag or transaction status"
                )
            }
        } catch {
            let message =
                "typed operation left PostgreSQL in \(statusLabel), and automatic ROLLBACK failed; " +
                "close and reopen the database: \(error)"
            poisonedMessage = message
            throw OliphauntError.engine(message)
        }
    }

    private func escapedTransactionOwnershipError(token: UInt64) -> OliphauntError {
        let message =
            "transaction operation escaped callback ownership and left PostgreSQL idle; close and reopen the database"
        poisonTransaction(token: token, message: message)
        return OliphauntError.engine(message)
    }

    private func poisonUnknownTypedOperation(
        transactionToken: UInt64?,
        error: any Error
    ) {
        let message =
            "typed operation outcome is unknown before a complete ReadyForQuery boundary; " +
            "close and reopen the database: \(error)"
        poisonedMessage = message
        if let transactionToken,
           var transaction = activeTransaction,
           transaction.token == transactionToken {
            transaction.completion = .failed(message)
            activeTransaction = transaction
        }
    }

    private func runSessionOperation<T: Sendable>(
        transactionToken: UInt64? = nil,
        _ body: (any OliphauntSession) async throws -> T
    ) async throws -> T {
        try validateTransactionAccess(token: transactionToken)
        let admittedSession = try liveSession()
        await operationGate.acquire()
        do {
            let session = try sessionForAdmittedOperation(admittedSession)
            let result = try await body(session)
            await operationGate.release()
            return result
        } catch {
            await operationGate.release()
            throw error
        }
    }

    private func validateTransactionAccess(token: UInt64?) throws {
        try ensureNoProtocolStreamCallbackReentry()
        if let token {
            guard let activeTransaction,
                  activeTransaction.token == token,
                  case .active = activeTransaction.completion
            else {
                throw OliphauntError.engine("transaction is no longer active")
            }
            return
        }
        if activeTransaction != nil {
            throw OliphauntError.engine(Self.sessionPinnedMessage)
        }
    }

    private func ensureNoProtocolStreamCallbackReentry() throws {
        if protocolStreamCallbackGate.isReentry(databaseID: protocolStreamDatabaseID) {
            throw OliphauntError.engine(OliphauntProtocolStreamCallbackGate.reentryMessage)
        }
    }

    private func finishCancellationAdmission() {
        precondition(activeCancellationCount > 0)
        activeCancellationCount -= 1
        guard activeCancellationCount == 0 else { return }
        let waiters = cancellationDrainWaiters
        cancellationDrainWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func waitForCancellationDrain() async {
        guard activeCancellationCount > 0 else { return }
        await withCheckedContinuation { continuation in
            cancellationDrainWaiters.append(continuation)
        }
    }

    fileprivate func transactionIsClosed(token: UInt64) -> Bool {
        guard let activeTransaction, activeTransaction.token == token else {
            return true
        }
        guard case .active = activeTransaction.completion else {
            return true
        }
        return false
    }

    fileprivate func rollbackTransaction(token: UInt64) async throws {
        try beginTransactionSettlement(token: token, completion: .rollingBack)
        _ = try await executeTransactionControl(
            "ROLLBACK",
            token: token,
            settlement: .rollingBack
        )
    }

    private func transactionIsActive(token: UInt64) -> Bool {
        guard let activeTransaction, activeTransaction.token == token else {
            return false
        }
        guard case .active = activeTransaction.completion else {
            return false
        }
        return true
    }

    private func clearTransaction(token: UInt64) {
        if activeTransaction?.token == token {
            activeTransaction = nil
        }
    }

    private func poisonTransaction(token: UInt64, message: String) {
        poisonedMessage = message
        if var transaction = activeTransaction, transaction.token == token {
            transaction.completion = .failed(message)
            activeTransaction = transaction
        }
    }

    private static let sessionPinnedMessage =
        "physical session is pinned; use the active OliphauntTransaction"

    func waitUntilQueuedOperationCount(atLeast expected: Int) async {
        await operationGate.waitUntilWaiterCount(atLeast: expected)
    }

    func waitUntilCloseTeardownStarted() async {
        guard !closeTeardownStarted else { return }
        await withCheckedContinuation { continuation in
            closeTeardownStartWaiters.append(continuation)
        }
    }
}

public struct OliphauntTransaction: Sendable {
    fileprivate let database: OliphauntDatabase
    fileprivate let token: UInt64

    public var isClosed: Bool {
        get async {
            await database.transactionIsClosed(token: token)
        }
    }

    public func execProtocolRaw(_ bytes: Data) async throws -> Data {
        try await database.execProtocolRaw(bytes, transactionToken: token)
    }

    public func execProtocolRawStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try await database.execProtocolRawStream(bytes, transactionToken: token, onChunk: onChunk)
    }

    public func rollback() async throws {
        try await database.rollbackTransaction(token: token)
    }

    func runTypedOperation<T: Sendable>(
        _ request: Data,
        parser: @Sendable (Data) throws -> (T, OliphauntReadyStatus)
    ) async throws -> T {
        try await database.runTypedOperation(
            request,
            transactionToken: token,
            parser: parser
        )
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
