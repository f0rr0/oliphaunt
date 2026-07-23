import Foundation

public enum OliphauntEngineMode: String, Sendable {
    case nativeDirect
    case nativeBroker
    case nativeServer
}

public enum OliphauntDurability: String, Sendable {
    case safe
    case balanced
    case fastDev
}

public enum OliphauntRuntimeFootprintProfile: String, Sendable {
    case throughput
    case balancedMobile
    case smallMobile
}

public struct OliphauntStartupGUC: Equatable, Sendable {
    public var name: String
    public var value: String

    public init(_ name: String, _ value: String) {
        self.name = name
        self.value = value
    }
}

public struct OliphauntCapabilities: Equatable, Sendable {
    public var mode: OliphauntEngineMode
    public var processIsolated: Bool
    public var multiRoot: Bool
    public var reopenable: Bool
    public var sameRootLogicalReopen: Bool
    public var rootSwitchable: Bool
    public var crashRestartable: Bool
    public var independentSessions: Bool
    public var maxClientSessions: Int
    public var protocolRaw: Bool
    public var protocolStream: Bool
    public var queryCancel: Bool
    public var backupRestore: Bool
    public var backupFormats: [OliphauntBackupFormat]
    public var restoreFormats: [OliphauntBackupFormat]
    public var simpleQuery: Bool
    public var extensions: Bool
    public var connectionString: String?

    public init(
        mode: OliphauntEngineMode,
        processIsolated: Bool,
        multiRoot: Bool = false,
        reopenable: Bool? = nil,
        sameRootLogicalReopen: Bool? = nil,
        rootSwitchable: Bool? = nil,
        crashRestartable: Bool = false,
        independentSessions: Bool,
        maxClientSessions: Int,
        protocolRaw: Bool = true,
        protocolStream: Bool = true,
        queryCancel: Bool = true,
        backupRestore: Bool = true,
        backupFormats: [OliphauntBackupFormat] = [.physicalArchive],
        restoreFormats: [OliphauntBackupFormat] = [.physicalArchive],
        simpleQuery: Bool = true,
        extensions: Bool = true,
        connectionString: String? = nil
    ) {
        self.mode = mode
        self.processIsolated = processIsolated
        self.multiRoot = multiRoot
        let effectiveReopenable = reopenable ?? processIsolated
        self.reopenable = effectiveReopenable
        self.sameRootLogicalReopen = sameRootLogicalReopen ?? (!processIsolated && effectiveReopenable)
        self.rootSwitchable = rootSwitchable ?? processIsolated
        self.crashRestartable = crashRestartable
        self.independentSessions = independentSessions
        self.maxClientSessions = maxClientSessions
        self.protocolRaw = protocolRaw
        self.protocolStream = protocolStream
        self.queryCancel = queryCancel
        self.backupRestore = backupRestore
        self.backupFormats = backupFormats
        self.restoreFormats = restoreFormats
        self.simpleQuery = simpleQuery
        self.extensions = extensions
        self.connectionString = connectionString
    }

    public func supportsBackupFormat(_ format: OliphauntBackupFormat) -> Bool {
        backupRestore && backupFormats.contains(format)
    }

    public func supportsRestoreFormat(_ format: OliphauntBackupFormat) -> Bool {
        backupRestore && restoreFormats.contains(format)
    }
}

public struct OliphauntEngineModeSupport: Equatable, Sendable {
    public var mode: OliphauntEngineMode
    public var available: Bool
    public var capabilities: OliphauntCapabilities
    public var unavailableReason: String?

    public init(
        mode: OliphauntEngineMode,
        available: Bool,
        capabilities: OliphauntCapabilities,
        unavailableReason: String? = nil
    ) {
        self.mode = mode
        self.available = available
        self.capabilities = capabilities
        self.unavailableReason = unavailableReason
    }
}

public enum OliphauntSDKSupport {
    public static let allModes: [OliphauntEngineMode] = [
        .nativeDirect,
        .nativeBroker,
        .nativeServer,
    ]

    public static func capabilities(for mode: OliphauntEngineMode) -> OliphauntCapabilities {
        switch mode {
        case .nativeDirect:
            OliphauntCapabilities(
                mode: mode,
                processIsolated: false,
                reopenable: true,
                sameRootLogicalReopen: true,
                rootSwitchable: false,
                crashRestartable: false,
                independentSessions: false,
                maxClientSessions: 1
            )
        case .nativeBroker:
            OliphauntCapabilities(
                mode: mode,
                processIsolated: true,
                multiRoot: true,
                reopenable: true,
                sameRootLogicalReopen: false,
                rootSwitchable: true,
                crashRestartable: true,
                independentSessions: false,
                maxClientSessions: 1
            )
        case .nativeServer:
            OliphauntCapabilities(
                mode: mode,
                processIsolated: true,
                reopenable: true,
                sameRootLogicalReopen: false,
                rootSwitchable: true,
                crashRestartable: false,
                independentSessions: true,
                maxClientSessions: 32,
                backupFormats: [.sql, .physicalArchive]
            )
        }
    }

    public static func nativeDirectOnly(
        brokerReason: String,
        serverReason: String
    ) -> [OliphauntEngineModeSupport] {
        [
            OliphauntEngineModeSupport(
                mode: .nativeDirect,
                available: true,
                capabilities: capabilities(for: .nativeDirect)
            ),
            OliphauntEngineModeSupport(
                mode: .nativeBroker,
                available: false,
                capabilities: capabilities(for: .nativeBroker),
                unavailableReason: brokerReason
            ),
            OliphauntEngineModeSupport(
                mode: .nativeServer,
                available: false,
                capabilities: capabilities(for: .nativeServer),
                unavailableReason: serverReason
            ),
        ]
    }

    public static func unavailable(reason: String) -> [OliphauntEngineModeSupport] {
        allModes.map { mode in
            OliphauntEngineModeSupport(
                mode: mode,
                available: false,
                capabilities: capabilities(for: mode),
                unavailableReason: reason
            )
        }
    }
}

public struct OliphauntConfiguration: Equatable, Sendable {
    public var mode: OliphauntEngineMode
    public var root: URL?
    public var durability: OliphauntDurability
    public var runtimeFootprint: OliphauntRuntimeFootprintProfile
    public var startupGUCs: [OliphauntStartupGUC]
    public var username: String?
    public var database: String?
    public var extensions: [String]

    public init(
        mode: OliphauntEngineMode = .nativeDirect,
        root: URL? = nil,
        durability: OliphauntDurability = .balanced,
        runtimeFootprint: OliphauntRuntimeFootprintProfile = .balancedMobile,
        startupGUCs: [OliphauntStartupGUC] = [],
        username: String? = nil,
        database: String? = nil,
        extensions: [String] = []
    ) {
        self.mode = mode
        self.root = root
        self.durability = durability
        self.runtimeFootprint = runtimeFootprint
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

func validateOliphauntStartupGUCs(_ gucs: [OliphauntStartupGUC]) throws {
    for guc in gucs {
        let name = guc.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            throw OliphauntError.engine("PostgreSQL startup GUC name must not be empty")
        }
        if name.utf8.contains(0) || guc.value.utf8.contains(0) {
            throw OliphauntError.engine("PostgreSQL startup GUC must not contain NUL bytes")
        }
        if !name.utf8.allSatisfy({ byte in
            (byte >= 65 && byte <= 90) ||
                (byte >= 97 && byte <= 122) ||
                (byte >= 48 && byte <= 57) ||
                byte == 95 ||
                byte == 46
        }) {
            throw OliphauntError.engine(
                "PostgreSQL startup GUC name '\(guc.name)' must contain only ASCII letters, digits, '_' or '.'"
            )
        }
        if guc.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw OliphauntError.engine("PostgreSQL startup GUC '\(guc.name)' value must not be empty")
        }
    }
}

func validateOliphauntRoot(_ root: URL?, label: String) throws {
    guard let root else {
        return
    }
    guard root.isFileURL else {
        throw OliphauntError.engine("\(label) must be a file URL")
    }
    if root.path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        throw OliphauntError.engine("\(label) must not be empty")
    }
    if root.path.utf8.contains(0) ||
        root.absoluteString.range(of: "%00", options: .caseInsensitive) != nil {
        throw OliphauntError.engine("\(label) must not contain NUL bytes")
    }
}

public enum OliphauntBackupFormat: String, Sendable {
    case sql
    case physicalArchive
    case oliphauntArchive
}

public struct OliphauntBackupRequest: Equatable, Sendable {
    public var format: OliphauntBackupFormat

    public init(format: OliphauntBackupFormat = .physicalArchive) {
        self.format = format
    }
}

public struct OliphauntBackupArtifact: Equatable, Sendable {
    public var format: OliphauntBackupFormat
    public var bytes: Data

    public init(format: OliphauntBackupFormat, bytes: Data) {
        self.format = format
        self.bytes = bytes
    }
}

public enum OliphauntRestoreTargetPolicy: String, Sendable {
    case failIfExists
    case replaceExisting
}

public struct OliphauntRestoreRequest: Equatable, Sendable {
    public var artifact: OliphauntBackupArtifact
    public var root: URL
    public var targetPolicy: OliphauntRestoreTargetPolicy

    public init(
        artifact: OliphauntBackupArtifact,
        root: URL,
        targetPolicy: OliphauntRestoreTargetPolicy = .failIfExists
    ) {
        self.artifact = artifact
        self.root = root
        self.targetPolicy = targetPolicy
    }

    public func replaceExisting() -> OliphauntRestoreRequest {
        OliphauntRestoreRequest(
            artifact: artifact,
            root: root,
            targetPolicy: .replaceExisting
        )
    }
}

public struct OliphauntBackgroundPreparationOptions: Equatable, Sendable {
    public var cancelActiveWork: Bool
    public var checkpointWhenIdle: Bool

    public init(
        cancelActiveWork: Bool = true,
        checkpointWhenIdle: Bool = true
    ) {
        self.cancelActiveWork = cancelActiveWork
        self.checkpointWhenIdle = checkpointWhenIdle
    }
}

public enum OliphauntBackgroundCheckpointSkipReason: String, Equatable, Sendable {
    case activeWork
    case transactionActive
}

public struct OliphauntBackgroundPreparationResult: Equatable, Sendable {
    public var cancelledActiveWork: Bool
    public var checkpointed: Bool
    public var skippedCheckpointReason: OliphauntBackgroundCheckpointSkipReason?

    public init(
        cancelledActiveWork: Bool,
        checkpointed: Bool,
        skippedCheckpointReason: OliphauntBackgroundCheckpointSkipReason? = nil
    ) {
        self.cancelledActiveWork = cancelledActiveWork
        self.checkpointed = checkpointed
        self.skippedCheckpointReason = skippedCheckpointReason
    }
}

public enum OliphauntError: Error, Equatable, Sendable, CustomStringConvertible {
    case runtimeUnavailable(OliphauntEngineMode)
    case databaseClosed
    case engine(String)
    case postgres(OliphauntPostgresError)

    public var description: String {
        switch self {
        case .runtimeUnavailable(let mode):
            "no Oliphaunt runtime is linked for \(mode)"
        case .databaseClosed:
            "database is closed"
        case .engine(let message):
            message
        case .postgres(let error):
            error.description
        }
    }
}

public protocol OliphauntEngine: Sendable {
    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession
    func restore(_ request: OliphauntRestoreRequest) async throws -> URL
}

public protocol OliphauntEngineSupportProvider: Sendable {
    var supportedModes: [OliphauntEngineModeSupport] { get }
}

public protocol OliphauntSession: Sendable {
    func capabilities() async -> OliphauntCapabilities
    func execProtocolRaw(_ bytes: Data) async throws -> Data
    func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws
    func backup(_ request: OliphauntBackupRequest) async throws -> OliphauntBackupArtifact
    func cancel() async throws
    func close() async throws
}

public extension OliphauntSession {
    func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try onChunk(try await execProtocolRaw(bytes))
    }
}

public struct RuntimeUnavailableEngine: OliphauntEngine, OliphauntEngineSupportProvider {
    public init() {}

    public var supportedModes: [OliphauntEngineModeSupport] {
        OliphauntSDKSupport.unavailable(reason: "no native Oliphaunt runtime is linked")
    }

    public func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        throw OliphauntError.runtimeUnavailable(configuration.mode)
    }

    public func restore(_ request: OliphauntRestoreRequest) async throws -> URL {
        throw OliphauntError.engine(
            "no native Oliphaunt restore runtime is linked for \(request.artifact.format.rawValue)"
        )
    }
}

public struct OliphauntDefaultEngine: OliphauntEngine, OliphauntEngineSupportProvider {
    public static let brokerUnavailableReason =
        "Swift broker mode requires a platform broker adapter; it is not aliased to direct mode"
    public static let serverUnavailableReason =
        "Swift server mode requires a platform server adapter; it is not aliased to direct mode"

    public init() {}

    public var supportedModes: [OliphauntEngineModeSupport] {
        OliphauntSDKSupport.nativeDirectOnly(
            brokerReason: Self.brokerUnavailableReason,
            serverReason: Self.serverUnavailableReason
        )
    }

    public func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        switch configuration.mode {
        case .nativeDirect:
            return try await OliphauntNativeDirectEngine().open(configuration: configuration)
        case .nativeBroker, .nativeServer:
            throw OliphauntError.runtimeUnavailable(configuration.mode)
        }
    }

    public func restore(_ request: OliphauntRestoreRequest) async throws -> URL {
        try await OliphauntNativeDirectEngine().restore(request)
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
    private var activeTransactionToken: UInt64?
    private var nextTransactionToken: UInt64 = 1
    private var activeOperationCount: Int = 0
    private let operationGate = OliphauntAsyncSerialGate()

    private init(session: any OliphauntSession) {
        self.session = session
    }

    public static func open(
        configuration: OliphauntConfiguration,
        engine: any OliphauntEngine = OliphauntDefaultEngine()
    ) async throws -> OliphauntDatabase {
        try validateOliphauntRoot(configuration.root, label: "database root")
        try validateOliphauntStartupIdentity(configuration.username, label: "username")
        try validateOliphauntStartupIdentity(configuration.database, label: "database")
        try validateOliphauntStartupGUCs(configuration.startupGUCs)
        var normalized = configuration
        normalized.extensions = try OliphauntRuntimeResources.normalizedExtensionIds(
            configuration.extensions
        )
        let session = try await engine.open(configuration: normalized)
        return OliphauntDatabase(session: session)
    }

    public static func restore(
        _ request: OliphauntRestoreRequest,
        engine: any OliphauntEngine = OliphauntDefaultEngine()
    ) async throws -> URL {
        try validateOliphauntRoot(request.root, label: "restore root")
        guard request.artifact.format == .physicalArchive else {
            throw OliphauntError.engine(
                "restore currently requires a physicalArchive artifact, got \(request.artifact.format.rawValue)"
            )
        }
        return try await engine.restore(request)
    }

    public static func supportedModes(
        engine: any OliphauntEngine = OliphauntDefaultEngine()
    ) -> [OliphauntEngineModeSupport] {
        guard let supportProvider = engine as? any OliphauntEngineSupportProvider else {
            return OliphauntSDKSupport.unavailable(
                reason: "engine does not publish static mode support"
            )
        }
        return supportProvider.supportedModes
    }

    public func capabilities() async throws -> OliphauntCapabilities {
        try await runSessionOperation(allowDuringTransaction: true) { session in
            await session.capabilities()
        }
    }

    public func connectionString() async throws -> String? {
        try await capabilities().connectionString
    }

    public func supportsBackupFormat(_ format: OliphauntBackupFormat) async throws -> Bool {
        try await capabilities().supportsBackupFormat(format)
    }

    public func supportsRestoreFormat(_ format: OliphauntBackupFormat) async throws -> Bool {
        try await capabilities().supportsRestoreFormat(format)
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

    public func backup(_ request: OliphauntBackupRequest = OliphauntBackupRequest()) async throws -> OliphauntBackupArtifact {
        try validateTransactionAccess(token: nil)
        return try await runSessionOperation { session in
            let capabilities = await session.capabilities()
            guard capabilities.supportsBackupFormat(request.format) else {
                throw OliphauntError.engine(
                    "\(request.format.rawValue) backup is not supported by \(capabilities.mode.rawValue)"
                )
            }
            return try await session.backup(request)
        }
    }

    public func checkpoint() async throws {
        _ = try await execProtocolRaw(try OliphauntProtocol.simpleQuery("CHECKPOINT"), transactionToken: nil)
    }

    public func prepareForBackground(
        _ options: OliphauntBackgroundPreparationOptions = OliphauntBackgroundPreparationOptions()
    ) async throws -> OliphauntBackgroundPreparationResult {
        let session = try liveSession()
        let hadActiveWork = activeOperationCount > 0
        let cancelledActiveWork: Bool
        if options.cancelActiveWork && hadActiveWork {
            try await session.cancel()
            cancelledActiveWork = true
        } else {
            cancelledActiveWork = false
        }

        guard options.checkpointWhenIdle else {
            return OliphauntBackgroundPreparationResult(
                cancelledActiveWork: cancelledActiveWork,
                checkpointed: false
            )
        }
        if activeTransactionToken != nil {
            return OliphauntBackgroundPreparationResult(
                cancelledActiveWork: cancelledActiveWork,
                checkpointed: false,
                skippedCheckpointReason: .transactionActive
            )
        }
        if hadActiveWork || activeOperationCount > 0 {
            return OliphauntBackgroundPreparationResult(
                cancelledActiveWork: cancelledActiveWork,
                checkpointed: false,
                skippedCheckpointReason: .activeWork
            )
        }

        try await checkpoint()
        return OliphauntBackgroundPreparationResult(
            cancelledActiveWork: cancelledActiveWork,
            checkpointed: true
        )
    }

    public func resumeFromBackground() async throws {
        _ = try await execProtocolRaw(
            try OliphauntProtocol.simpleQuery("SELECT 1"),
            transactionToken: nil
        )
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

        do {
            _ = try await execProtocolRaw(try OliphauntProtocol.simpleQuery("BEGIN"), transactionToken: token)
            let result = try await body(transaction)
            _ = try await execProtocolRaw(try OliphauntProtocol.simpleQuery("COMMIT"), transactionToken: token)
            activeTransactionToken = nil
            return result
        } catch {
            do {
                _ = try await execProtocolRaw(try OliphauntProtocol.simpleQuery("ROLLBACK"), transactionToken: token)
            } catch {
                // Preserve the original transaction failure; rollback is best-effort cleanup.
            }
            activeTransactionToken = nil
            throw error
        }
    }

    public func cancel() async throws {
        try await liveSession().cancel()
    }

    public func close() async throws {
        guard let closingSession = session else {
            return
        }
        self.session = nil
        activeTransactionToken = nil
        await operationGate.acquire()
        do {
            try await closingSession.close()
            await operationGate.release()
        } catch {
            await operationGate.release()
            throw error
        }
    }

    private func liveSession() throws -> any OliphauntSession {
        guard let session else {
            throw OliphauntError.databaseClosed
        }
        return session
    }

    fileprivate func execProtocolRaw(_ bytes: Data, transactionToken: UInt64?) async throws -> Data {
        _ = try liveSession()
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
        _ = try liveSession()
        try validateTransactionAccess(token: transactionToken)
        try await runSessionOperation(transactionToken: transactionToken) {
            try await $0.execProtocolStream(bytes, onChunk: onChunk)
        }
    }

    private func runSessionOperation<T: Sendable>(
        transactionToken: UInt64? = nil,
        allowDuringTransaction: Bool = false,
        _ body: (any OliphauntSession) async throws -> T
    ) async throws -> T {
        if !allowDuringTransaction {
            try validateTransactionAccess(token: transactionToken)
        }
        await operationGate.acquire()
        activeOperationCount += 1
        do {
            let session = try liveSession()
            if !allowDuringTransaction {
                try validateTransactionAccess(token: transactionToken)
            }
            let result = try await body(session)
            activeOperationCount -= 1
            await operationGate.release()
            return result
        } catch {
            activeOperationCount -= 1
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
        var args = runtimeFootprint.postgresStartupArgs()
        args.append(contentsOf: durability.postgresStartupArgs())
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

private extension OliphauntRuntimeFootprintProfile {
    func postgresStartupArgs() -> [String] {
        switch self {
        case .throughput:
            return [
                "-c", "shared_buffers=128MB",
                "-c", "wal_buffers=4MB",
                "-c", "min_wal_size=80MB"
            ]
        case .balancedMobile:
            return [
                "-c", "max_connections=1",
                "-c", "superuser_reserved_connections=0",
                "-c", "reserved_connections=0",
                "-c", "autovacuum_worker_slots=1",
                "-c", "max_wal_senders=0",
                "-c", "max_replication_slots=0",
                "-c", "shared_buffers=32MB",
                "-c", "wal_buffers=-1",
                "-c", "min_wal_size=32MB",
                "-c", "max_wal_size=64MB",
                "-c", "io_method=sync",
                "-c", "io_max_concurrency=1"
            ]
        case .smallMobile:
            return [
                "-c", "max_connections=1",
                "-c", "superuser_reserved_connections=0",
                "-c", "reserved_connections=0",
                "-c", "autovacuum_worker_slots=1",
                "-c", "max_wal_senders=0",
                "-c", "max_replication_slots=0",
                "-c", "shared_buffers=8MB",
                "-c", "wal_buffers=256kB",
                "-c", "min_wal_size=32MB",
                "-c", "max_wal_size=64MB",
                "-c", "work_mem=1MB",
                "-c", "maintenance_work_mem=16MB",
                "-c", "io_method=sync",
                "-c", "io_max_concurrency=1"
            ]
        }
    }
}

private extension OliphauntDurability {
    func postgresStartupArgs() -> [String] {
        switch self {
        case .safe:
            return [
                "-c", "fsync=on",
                "-c", "full_page_writes=on",
                "-c", "synchronous_commit=on"
            ]
        case .balanced:
            return [
                "-c", "fsync=on",
                "-c", "full_page_writes=on",
                "-c", "synchronous_commit=off"
            ]
        case .fastDev:
            return [
                "-c", "fsync=off",
                "-c", "full_page_writes=off",
                "-c", "synchronous_commit=off"
            ]
        }
    }
}
