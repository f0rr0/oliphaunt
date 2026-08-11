import COliphaunt
import Darwin
import Foundation
import Oliphaunt
import OliphauntBrokerProtocol

public protocol BrokerFrameSink: Sendable {
    func send(_ frame: BrokerFrame) throws
}

public enum BrokerFrameHandlingResult: Equatable, Sendable {
    case continueReading
    case closeChannel
}

public enum BrokerWorkerCoreState: Equatable, Sendable {
    case created
    case starting
    case ready
    case quiescing
    case interrupted
    case detached
    case failed(String)
}

public enum BrokerWorkerCancellationDisposition: Equatable, Sendable {
    case notCurrent
    case canceledBeforeNativeDispatch
    case nativeSignal(BrokerCancellationSignalResult)
}

public struct BrokerWorkerDiagnostics: Equatable, Sendable {
    public var state: BrokerWorkerCoreState
    public var epoch: BrokerEpoch
    public var processID: Int32
    public var rootURL: URL
    public var manifestDigest: String?
    public var activeRequestID: BrokerRequestID?
    public var nativeDispatchStarted: Bool
    public var transactionStatus: String
    public var capabilities: BrokerCapabilities

    public init(
        state: BrokerWorkerCoreState,
        epoch: BrokerEpoch,
        processID: Int32,
        rootURL: URL,
        manifestDigest: String?,
        activeRequestID: BrokerRequestID?,
        nativeDispatchStarted: Bool,
        transactionStatus: String,
        capabilities: BrokerCapabilities
    ) {
        self.state = state
        self.epoch = epoch
        self.processID = processID
        self.rootURL = rootURL
        self.manifestDigest = manifestDigest
        self.activeRequestID = activeRequestID
        self.nativeDispatchStarted = nativeDispatchStarted
        self.transactionStatus = transactionStatus
        self.capabilities = capabilities
    }
}

public struct BrokerWorkerConfiguration: Sendable {
    public static let restrictedRoleUsername = "oliphaunt_broker"
    public static let restrictedDatabase = "postgres"
    public static let restrictedSearchPath = "\"$user\", public"

    public let storage: BrokerExtensionStorage
    public let engine: any OliphauntEngine
    public let liboliphauntVersion: String
    public let cABIVersion: UInt32
    public let postgresMajorVersion: UInt16
    public let startupConfigurationDigest: String
    public let selectedPostgresExtensions: [String]
    public let durability: OliphauntDurability
    public let startupGUCs: [OliphauntStartupGUC]
    public let username: String
    public let database: String
    public let dataProtectionPolicy: String
    public let maximumRequestBytes: Int
    public let capabilities: BrokerCapabilities
    public let runtimeVersionProvider: @Sendable () throws -> String

    public init(
        storage: BrokerExtensionStorage,
        engine: any OliphauntEngine,
        liboliphauntVersion: String,
        cABIVersion: UInt32 = UInt32(OLIPHAUNT_ABI_VERSION),
        postgresMajorVersion: UInt16 = 18,
        startupConfigurationDigest: String,
        selectedPostgresExtensions: [String] = [],
        durability: OliphauntDurability = .safe,
        startupGUCs: [OliphauntStartupGUC] = [],
        username: String = Self.restrictedRoleUsername,
        database: String = Self.restrictedDatabase,
        dataProtectionPolicy: String = "completeUntilFirstUserAuthentication",
        maximumRequestBytes: Int = OliphauntBrokerProtocol.defaultMaximumRequestBytes,
        capabilities: BrokerCapabilities? = nil,
        runtimeVersionProvider: (@Sendable () throws -> String)? = nil
    ) throws {
        guard maximumRequestBytes >= 5,
            maximumRequestBytes <= OliphauntBrokerProtocol.maximumQueuedBytesPerDirection
        else {
            throw BrokerError.invalidConfiguration(
                "maximum request size must be between 5 and \(OliphauntBrokerProtocol.maximumQueuedBytesPerDirection) bytes"
            )
        }
        guard !liboliphauntVersion.isEmpty,
            !startupConfigurationDigest.isEmpty,
            !username.isEmpty,
            !database.isEmpty
        else {
            throw BrokerError.invalidConfiguration("worker identity fields must not be empty")
        }
        guard username == Self.restrictedRoleUsername,
            database == Self.restrictedDatabase
        else {
            throw BrokerError.invalidConfiguration(
                "worker must authenticate as the restricted broker role in the postgres database"
            )
        }
        guard
            !startupGUCs.contains(where: {
                $0.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    .caseInsensitiveCompare("search_path") == .orderedSame
            })
        else {
            throw BrokerError.invalidConfiguration(
                "worker search_path is fixed by the restricted broker boundary"
            )
        }

        var actual =
            capabilities
            ?? BrokerCapabilities(
                crashRestartable: true,
                requiresAppGroup: storage.location.requiresAppGroup
            )
        // These are invariants of the v1 extension worker, not caller options.
        actual.mode = "nativeBroker"
        actual.implementation = "iosExtensionBroker"
        actual.minimumOS = "iOS 26"
        actual.processIsolated = true
        actual.crashRestartable = true
        actual.hangRestartable = false
        actual.sameRootLogicalReopen = true
        actual.rootSwitchable = false
        actual.multiRoot = false
        actual.independentSessions = false
        actual.maxClientSessions = 1
        actual.backgroundContinuable = false
        actual.requiresAppGroup = storage.location.requiresAppGroup
        actual.protocolRaw = true
        actual.protocolStream = true
        actual.streamingRequestInput = false
        actual.queryCancel = true
        actual.backupRestore = false
        actual.connectionString = nil
        actual.serverMode = false

        self.storage = storage
        self.engine = engine
        self.liboliphauntVersion = liboliphauntVersion
        self.cABIVersion = cABIVersion
        self.postgresMajorVersion = postgresMajorVersion
        self.startupConfigurationDigest = startupConfigurationDigest
        self.selectedPostgresExtensions = selectedPostgresExtensions
        self.durability = durability
        self.startupGUCs =
            startupGUCs + [
                OliphauntStartupGUC("search_path", Self.restrictedSearchPath)
            ]
        self.username = username
        self.database = database
        self.dataProtectionPolicy = dataProtectionPolicy
        self.maximumRequestBytes = maximumRequestBytes
        self.capabilities = actual
        self.runtimeVersionProvider = runtimeVersionProvider ?? { liboliphauntVersion }
    }

    /// Constructs the production worker engine with runtime materialization kept
    /// under the extension-private root.
    public static func nativeDirect(
        storage: BrokerExtensionStorage,
        liboliphauntVersion: String,
        startupConfigurationDigest: String,
        selectedPostgresExtensions: [String] = [],
        durability: OliphauntDurability = .safe,
        startupGUCs: [OliphauntStartupGUC] = [],
        username: String = Self.restrictedRoleUsername,
        database: String = Self.restrictedDatabase
    ) throws -> BrokerWorkerConfiguration {
        guard
            let resources = try OliphauntRuntimeResources.bundled(
                containing: selectedPostgresExtensions,
                cacheRoot: storage.runtimeCacheURL
            )
        else {
            throw BrokerError.invalidConfiguration(
                "broker app extension does not contain packaged Oliphaunt runtime resources"
            )
        }
        return try BrokerWorkerConfiguration(
            storage: storage,
            engine: OliphauntNativeDirectEngine(runtimeResources: resources),
            liboliphauntVersion: liboliphauntVersion,
            startupConfigurationDigest: startupConfigurationDigest,
            selectedPostgresExtensions: selectedPostgresExtensions,
            durability: durability,
            startupGUCs: startupGUCs,
            username: username,
            database: database,
            runtimeVersionProvider: linkedOliphauntVersion
        )
    }
}

/// Owns the single physical native session in the app-extension process.
///
/// The actor is deliberately reentrancy-safe: request admission is guarded by an
/// explicit lifecycle even while the native session call is suspended. Running
/// cancellation is delegated to `cancellationController`, which XPC glue can call
/// without entering this actor.
public actor WorkerCore {
    private struct ActiveRequest: Sendable {
        var lifecycle: BrokerRequestLifecycle
        var assembler: BrokerFrontendRequestAssembler
    }

    public private(set) var epoch: BrokerEpoch
    public nonisolated let cancellationController: CancellationController

    private let configuration: BrokerWorkerConfiguration
    private var state: BrokerWorkerCoreState = .created
    private var preparedStorage: PreparedBrokerExtensionStorage?
    private var selectedProtocolVersion: UInt16?
    private var session: (any OliphauntSession)?
    private var sessionCloseInProgress = false
    private var deadlineRecoveryID: UUID?
    private var startAttemptID: UUID?
    private var activeRequest: ActiveRequest?
    private var acceptingRequests = false
    private var transactionStatus: BrokerBackendTransactionStatus = .idle

    #if DEBUG
        private nonisolated let faultInjector = BrokerFaultInjector()
    #endif

    public init(configuration: BrokerWorkerConfiguration) {
        self.configuration = configuration
        self.epoch = .fresh()
        self.cancellationController = CancellationController()
    }

    public func start(hello: BrokerHello) async throws -> BrokerReady {
        let previousState = state
        let previousEpoch = epoch
        switch state {
        case .created:
            break
        case .detached, .interrupted:
            guard activeRequest == nil,
                session == nil,
                !sessionCloseInProgress,
                startAttemptID == nil
            else {
                throw BrokerError.workerInterrupted(epoch: epoch)
            }
            epoch = .fresh()
        case .ready, .quiescing, .starting:
            throw BrokerError.rejected(.invalidRequest("a data channel is already active"))
        case .failed(let reason):
            throw BrokerError.brokerUnavailableWithReason(reason)
        }

        let attemptID = UUID()
        startAttemptID = attemptID
        state = .starting
        acceptingRequests = false

        do {
            let version = try BrokerHandshake.validate(
                hello,
                actualABI: configuration.cABIVersion,
                actualRuntimeVersion: configuration.liboliphauntVersion,
                residentRootID: OliphauntBrokerProtocol.canonicalRootID,
                startupConfigurationDigest: configuration.startupConfigurationDigest
            )
            try validateRequestedCapabilities(hello.requestedCapabilities)
            let prepared: PreparedBrokerExtensionStorage
            do {
                prepared = try configuration.storage.prepare(
                    postgresMajorVersion: configuration.postgresMajorVersion,
                    liboliphauntVersion: configuration.liboliphauntVersion,
                    cABIVersion: configuration.cABIVersion,
                    selectedPostgresExtensions: configuration.selectedPostgresExtensions,
                    startupConfigurationDigest: configuration.startupConfigurationDigest,
                    dataProtectionPolicy: configuration.dataProtectionPolicy
                )
            } catch {
                throw BrokerError.rejected(.rootOpen)
            }

            let nativeConfiguration = OliphauntConfiguration(
                mode: .nativeDirect,
                root: configuration.storage.rootURL,
                durability: configuration.durability,
                runtimeFootprint: .smallMobile,
                startupGUCs: configuration.startupGUCs,
                username: configuration.username,
                database: configuration.database,
                extensions: prepared.manifest.selectedPostgresExtensions
            )
            let opened: any OliphauntSession
            do {
                opened = try await configuration.engine.open(configuration: nativeConfiguration)
            } catch {
                throw BrokerError.rejected(.rootOpen)
            }
            do {
                try validateStartAttempt(attemptID)
                do {
                    try await establishRestrictedRoleBoundary(
                        opened,
                        selectedExtensions: prepared.manifest.selectedPostgresExtensions
                    )
                } catch {
                    // ALTER ROLE is transactional. A post-demotion validation
                    // failure must explicitly abandon the transaction before
                    // this session is closed so no partial bootstrap can be
                    // observed by a later resident lease.
                    try? await executeControlSQL("ROLLBACK", session: opened)
                    throw BrokerError.brokerUnavailable
                }
                try validateStartAttempt(attemptID)
                let actualRuntimeVersion: String
                do {
                    actualRuntimeVersion = try configuration.runtimeVersionProvider()
                } catch {
                    throw BrokerError.brokerUnavailable
                }
                guard actualRuntimeVersion == configuration.liboliphauntVersion else {
                    throw BrokerError.runtimeMismatch(
                        expected: configuration.liboliphauntVersion,
                        actual: actualRuntimeVersion
                    )
                }
                do {
                    try await validateNativeCapabilities(opened)
                } catch {
                    throw BrokerError.brokerUnavailable
                }
                try validateStartAttempt(attemptID)
                do {
                    try await healthCheck(opened)
                } catch {
                    throw BrokerError.brokerUnavailable
                }
                try validateStartAttempt(attemptID)
                do {
                    try configuration.storage.validatePostgresVersion(
                        configuration.postgresMajorVersion
                    )
                } catch {
                    throw BrokerError.rejected(.rootOpen)
                }
                do {
                    // Runtime/template resources are copied before native open,
                    // and bootstrap may create additional PGDATA files. Repair
                    // that complete population only after all startup writes,
                    // then fail closed on an immediate iOS audit before Ready.
                    try configuration.storage.enforceDataProtectionRecursively()
                    #if os(iOS) && !targetEnvironment(simulator)
                        guard
                            configuration.storage.recursiveProtectionEvidence()
                                .allEntriesMatchExpectedProtection
                        else {
                            throw BrokerError.rejected(.rootOpen)
                        }
                    #endif
                } catch {
                    // Do not expose extension-private paths carried by a
                    // traversal or filesystem error across the broker boundary.
                    throw BrokerError.rejected(.rootOpen)
                }
            } catch {
                try? await opened.close()
                throw error
            }

            try validateStartAttempt(attemptID)
            preparedStorage = prepared
            selectedProtocolVersion = version
            session = opened
            transactionStatus = .idle
            acceptingRequests = true
            startAttemptID = nil
            state = .ready
            return readyValue()
        } catch {
            if startAttemptID == attemptID {
                startAttemptID = nil
                if state == .starting {
                    // Handshake/configuration failures are scoped to this
                    // incoming generation. They must not poison the resident
                    // process: the host may correct the mismatch and issue a
                    // fresh Hello over the same ExtensionKit process. Any
                    // session opened by this attempt was closed above before
                    // the stable pre-start state and epoch are restored.
                    epoch = previousEpoch
                    state = previousState
                }
            }
            throw error
        }
    }

    public func handle(
        _ frame: BrokerFrame,
        sink: any BrokerFrameSink
    ) async throws -> BrokerFrameHandlingResult {
        guard frame.header.epoch == epoch else {
            throw BrokerProtocolError.staleEpoch(expected: epoch, actual: frame.header.epoch)
        }
        if let selectedProtocolVersion,
            frame.header.protocolVersion != selectedProtocolVersion
        {
            throw BrokerProtocolError.unsupportedVersion(frame.header.protocolVersion)
        }

        switch frame.header.frameType {
        case .ping:
            guard frame.payload.isEmpty else {
                return try protocolViolation("ping payload must be empty", sink: sink)
            }
            try sink.send(try makeFrame(.pong))
            return .continueReading

        case .channelClose:
            guard frame.payload.isEmpty else {
                return try protocolViolation("channelClose payload must be empty", sink: sink)
            }
            acceptingRequests = false
            return .closeChannel

        case .requestBegin:
            try beginRequest(frame, sink: sink)
            return .continueReading

        case .requestBytes:
            try appendRequestBytes(frame, sink: sink)
            return .continueReading

        case .requestEnd:
            try await finishAndExecuteRequest(frame, sink: sink)
            return .continueReading

        case .cancelRequested:
            let requestID = try BrokerRequestID(validating: frame.header.requestID)
            _ = try await cancelRequest(epoch: epoch, requestID: requestID)
            return .continueReading

        case .responseBytes, .completed, .rejected, .outcomeUnknown,
            .cancelObserved, .pong, .protocolError:
            return try protocolViolation(
                "host sent extension-only frame \(frame.header.frameType)",
                sink: sink
            )
        }
    }

    /// Handles pre-dispatch cancellation and provides a convenience path for
    /// running work. XPC should normally call `cancellationController` directly
    /// first so running cancellation never waits behind this actor.
    public func cancelRequest(
        epoch requestedEpoch: BrokerEpoch,
        requestID: BrokerRequestID
    ) async throws -> BrokerWorkerCancellationDisposition {
        guard requestedEpoch == epoch,
            var request = activeRequest,
            request.lifecycle.requestID == requestID
        else {
            return .notCurrent
        }

        if !request.lifecycle.nativeDispatchStarted {
            _ = request.lifecycle.requestCancellation()
            // Keep a canceled receiving request installed until RequestEnd.
            // The host may already have queued additional SOCK_STREAM bytes;
            // discarding those frames preserves channel synchronization while
            // still proving that the request never reached liboliphaunt.
            activeRequest = request
            return .canceledBeforeNativeDispatch
        }

        if case .running = request.lifecycle.state {
            _ = request.lifecycle.requestCancellation()
            activeRequest = request
        }
        let result = try await cancellationController.requestCancellation(
            epoch: requestedEpoch,
            requestID: requestID
        )
        return .nativeSignal(result)
    }

    public func checkpoint(expectedEpoch: BrokerEpoch) async throws {
        try validateExpectedEpoch(expectedEpoch)
        guard state == .ready || state == .quiescing else {
            throw BrokerError.databaseClosed
        }
        guard activeRequest == nil else {
            throw BrokerError.rejected(
                .invalidRequest("cannot checkpoint while a request is active"))
        }
        guard let session else { throw BrokerError.databaseClosed }
        #if DEBUG
            faultInjector.duringCheckpoint()
        #endif
        try await executeControlSQL("CHECKPOINT", session: session)
        try validateControlContinuation(
            expectedEpoch: expectedEpoch,
            allowedStates: [.ready, .quiescing]
        )
    }

    public func prepareForBackground(
        expectedEpoch: BrokerEpoch,
        deadline: Date
    ) async throws -> OliphauntBackgroundPreparationResult {
        try validateExpectedEpoch(expectedEpoch)
        guard state == .ready || state == .quiescing else {
            throw BrokerError.databaseClosed
        }
        state = .quiescing
        acceptingRequests = false

        var canceledActiveWork = false
        if let request = activeRequest {
            canceledActiveWork = true
            if request.lifecycle.nativeDispatchStarted {
                _ = try? await cancellationController.requestCancellation(
                    epoch: expectedEpoch,
                    requestID: request.lifecycle.requestID
                )
                try validateControlContinuation(
                    expectedEpoch: expectedEpoch,
                    allowedStates: [.quiescing]
                )
            } else {
                var canceled = request
                _ = canceled.lifecycle.requestCancellation()
                activeRequest = nil
            }
        }

        while activeRequest != nil, Date() < deadline {
            try await Task.sleep(for: .milliseconds(10))
            try validateControlContinuation(
                expectedEpoch: expectedEpoch,
                allowedStates: [.quiescing]
            )
        }
        guard activeRequest == nil else {
            return OliphauntBackgroundPreparationResult(
                cancelledActiveWork: canceledActiveWork,
                checkpointed: false,
                skippedCheckpointReason: .activeWork
            )
        }
        guard Date() < deadline, let session else {
            return OliphauntBackgroundPreparationResult(
                cancelledActiveWork: canceledActiveWork,
                checkpointed: false,
                skippedCheckpointReason: .activeWork
            )
        }

        // Keep a small reply/serialization reserve inside the caller's hard
        // deadline. The host owns the outer transport timer; the worker never
        // begins unbounded native control work at that boundary.
        let controlDeadline = deadline.addingTimeInterval(-0.25)
        if transactionStatus != .idle {
            guard Date() < controlDeadline else {
                beginDeadlineRecovery(
                    session: session,
                    operation: nil,
                    expectedEpoch: expectedEpoch
                )
                throw BrokerError.workerInterrupted(epoch: expectedEpoch)
            }
            try await executeControlSQL(
                "ROLLBACK",
                session: session,
                completingBefore: controlDeadline,
                expectedEpoch: expectedEpoch
            )
            try validateControlContinuation(
                expectedEpoch: expectedEpoch,
                allowedStates: [.quiescing]
            )
            transactionStatus = .idle
        }
        guard Date() < controlDeadline else {
            return OliphauntBackgroundPreparationResult(
                cancelledActiveWork: canceledActiveWork,
                checkpointed: false,
                skippedCheckpointReason: .activeWork
            )
        }

        #if DEBUG
            faultInjector.duringCheckpoint()
        #endif
        try await executeControlSQL(
            "CHECKPOINT",
            session: session,
            completingBefore: controlDeadline,
            expectedEpoch: expectedEpoch
        )
        try validateControlContinuation(
            expectedEpoch: expectedEpoch,
            allowedStates: [.quiescing]
        )
        return OliphauntBackgroundPreparationResult(
            cancelledActiveWork: canceledActiveWork,
            checkpointed: true
        )
    }

    public func resumeFromBackground(expectedEpoch: BrokerEpoch) async throws {
        try validateExpectedEpoch(expectedEpoch)
        guard state == .quiescing, let session else {
            throw BrokerError.databaseClosed
        }
        do {
            try await healthCheck(session)
            try validateControlContinuation(
                expectedEpoch: expectedEpoch,
                allowedStates: [.quiescing]
            )
            acceptingRequests = true
            state = .ready
        } catch {
            if epoch == expectedEpoch, state == .quiescing {
                acceptingRequests = false
                state = .failed(String(describing: error))
            }
            throw error
        }
    }

    /// Marks the current channel stale. The XPC interruption handler should call
    /// the CancellationController directly first, close the FD, then call here.
    public func interruptCurrentEpoch() async {
        acceptingRequests = false
        state = .interrupted
        if var request = activeRequest {
            _ = request.lifecycle.establishTerminal(request.lifecycle.lossResult())
            if request.lifecycle.nativeDispatchStarted {
                // Native work may already have committed. Keep its terminal
                // outcome installed until the suspended execution unwinds so a
                // replacement epoch can never overlap or replay it.
                activeRequest = request
                return
            }

            // The channel is already gone, so unlike an in-band cancellation
            // there are no remaining upload frames to drain. This request is
            // proven not-started and must not pin the resident worker forever.
            activeRequest = nil
        }
        await closeCurrentSessionForRecovery()
    }

    public func detach(expectedEpoch: BrokerEpoch) async throws {
        try validateExpectedEpoch(expectedEpoch)
        acceptingRequests = false
        guard state == .ready || state == .quiescing else {
            throw BrokerError.databaseClosed
        }
        guard activeRequest == nil else {
            throw BrokerError.rejected(.invalidRequest("cannot detach while a request is active"))
        }
        let detachState = state
        if let session {
            guard !sessionCloseInProgress else {
                throw BrokerError.workerInterrupted(epoch: expectedEpoch)
            }
            sessionCloseInProgress = true
            do {
                try await session.close()
            } catch {
                sessionCloseInProgress = false
                if epoch == expectedEpoch, state == .interrupted {
                    await closeCurrentSessionForRecovery()
                }
                throw error
            }
            sessionCloseInProgress = false
            do {
                try validateControlContinuation(
                    expectedEpoch: expectedEpoch,
                    allowedStates: [detachState]
                )
            } catch {
                self.session = nil
                throw error
            }
        }
        session = nil
        selectedProtocolVersion = nil
        state = .detached
    }

    public func diagnostics(expectedEpoch: BrokerEpoch) throws -> BrokerWorkerDiagnostics {
        try validateExpectedEpoch(expectedEpoch)
        return BrokerWorkerDiagnostics(
            state: state,
            epoch: epoch,
            processID: Int32(ProcessInfo.processInfo.processIdentifier),
            rootURL: configuration.storage.rootURL,
            manifestDigest: preparedStorage?.manifestDigest,
            activeRequestID: activeRequest?.lifecycle.requestID,
            nativeDispatchStarted: activeRequest?.lifecycle.nativeDispatchStarted ?? false,
            transactionStatus: transactionStatus.description,
            capabilities: configuration.capabilities
        )
    }

    #if DEBUG
        public func injectFault(
            _ fault: BrokerWorkerFault,
            expectedEpoch: BrokerEpoch
        ) throws {
            try validateExpectedEpoch(expectedEpoch)
            switch fault {
            case .deadlock, .deadlockWithFailStop:
                // Acknowledge the XPC control request while WorkerCore is still
                // responsive. The next registered native request triggers the
                // actor deadlock after the cancellation fast path is installed.
                faultInjector.armDeadlockAfterNativeRequestRegistration(
                    failStop: fault == .deadlockWithFailStop
                )
            default:
                faultInjector.inject(fault)
            }
        }
    #endif

    /// Backup/restore remain unavailable until the C ABI has bounded streaming
    /// source/sink APIs. The existing whole-Data archive path is intentionally not
    /// exposed through the extension broker.
    public func rejectBackupOrRestore() throws {
        throw BrokerError.rejected(.unsupportedCapability(.backupRestore))
    }

    private func beginRequest(
        _ frame: BrokerFrame,
        sink: any BrokerFrameSink
    ) throws {
        let requestID = try BrokerRequestID(validating: frame.header.requestID)
        guard frame.payload.isEmpty else {
            try sendRejection(
                requestID: requestID,
                reason: .invalidRequest("requestBegin payload must be empty"),
                sink: sink
            )
            return
        }
        guard state == .ready, acceptingRequests, session != nil else {
            try sendRejection(requestID: requestID, reason: .queueClosed, sink: sink)
            return
        }
        guard activeRequest == nil else {
            throw BrokerProtocolError.illegalFrame(
                frameType: .requestBegin,
                state: activeRequest?.lifecycle.state.description ?? "active"
            )
        }
        var lifecycle = BrokerRequestLifecycle(epoch: epoch, requestID: requestID)
        try lifecycle.beginReceiving()
        activeRequest = ActiveRequest(
            lifecycle: lifecycle,
            assembler: BrokerFrontendRequestAssembler(
                maximumRequestBytes: configuration.maximumRequestBytes
            )
        )
    }

    private func appendRequestBytes(
        _ frame: BrokerFrame,
        sink: any BrokerFrameSink
    ) throws {
        let requestID = try BrokerRequestID(validating: frame.header.requestID)
        guard var request = activeRequest,
            request.lifecycle.requestID == requestID
        else {
            throw BrokerProtocolError.illegalFrame(
                frameType: .requestBytes,
                state: activeRequest?.lifecycle.state.description ?? "idle"
            )
        }
        if request.lifecycle.state == .terminal(.canceled) {
            return
        }
        do {
            try request.assembler.append(frame.payload)
            activeRequest = request
        } catch {
            _ = request.lifecycle.establishTerminal(
                .rejected(.invalidRequest(String(describing: error)))
            )
            activeRequest = nil
            try sendRejection(
                requestID: requestID,
                reason: .invalidRequest(String(describing: error)),
                sink: sink
            )
        }
    }

    private func finishAndExecuteRequest(
        _ frame: BrokerFrame,
        sink: any BrokerFrameSink
    ) async throws {
        let requestID = try BrokerRequestID(validating: frame.header.requestID)
        guard frame.payload.isEmpty else {
            try sendRejection(
                requestID: requestID,
                reason: .invalidRequest("requestEnd payload must be empty"),
                sink: sink
            )
            activeRequest = nil
            return
        }
        guard var request = activeRequest,
            request.lifecycle.requestID == requestID
        else {
            throw BrokerProtocolError.illegalFrame(
                frameType: .requestEnd,
                state: activeRequest?.lifecycle.state.description ?? "idle"
            )
        }
        if request.lifecycle.state == .terminal(.canceled) {
            activeRequest = nil
            try sendRejection(requestID: requestID, reason: .canceled, sink: sink)
            return
        }

        let bytes: Data
        do {
            bytes = try request.assembler.finish()
            try request.lifecycle.finishReceiving()
            try request.lifecycle.beginNativeDispatch()
            activeRequest = request
        } catch {
            _ = request.lifecycle.establishTerminal(
                .rejected(.invalidRequest(String(describing: error)))
            )
            activeRequest = nil
            try sendRejection(
                requestID: requestID,
                reason: .invalidRequest(String(describing: error)),
                sink: sink
            )
            return
        }
        try await executeNativeRequest(bytes, requestID: requestID, sink: sink)
    }

    private func executeNativeRequest(
        _ bytes: Data,
        requestID: BrokerRequestID,
        sink: any BrokerFrameSink
    ) async throws {
        guard let session else {
            throw BrokerError.databaseClosed
        }
        #if DEBUG
            faultInjector.beforeNativeDispatch()
            let nativeFaultWorkItem = faultInjector.beginNativeExecution()
        #endif

        let observer = BrokerBackendResponseObserver(
            epoch: epoch,
            requestID: requestID,
            cancellationController: cancellationController
        )
        do {
            let privacyFilter = try makeBackendPrivacyFilter()
            try cancellationController.beginNativeRequest(
                epoch: epoch,
                requestID: requestID,
                session: session
            )
            #if DEBUG
                faultInjector.afterNativeRequestRegistration()
            #endif
            let version = selectedProtocolVersion ?? OliphauntBrokerProtocol.maximumVersion
            let requestEpoch = epoch
            #if DEBUG
                let injector = faultInjector
            #endif
            try await session.execProtocolStream(bytes) { chunk in
                try privacyFilter.process(chunk) { filteredChunk in
                    // Observe ReadyForQuery before a backpressured write so a
                    // late cancel cannot poison the following request.
                    try observer.observe(filteredChunk)
                    try sendResponseBytes(
                        filteredChunk,
                        protocolVersion: version,
                        epoch: requestEpoch,
                        requestID: requestID,
                        sink: sink
                    )
                }
                #if DEBUG
                    injector.afterResponseChunk()
                #endif
            }
            // A native callback may end between backend-frame fragments. Never
            // accept Completed/Ready while a potentially sensitive E/N message
            // remains buffered or a generic backend frame is truncated.
            try privacyFilter.finish()
            #if DEBUG
                nativeFaultWorkItem?.cancel()
            #endif

            let observation = observer.snapshot()
            guard observation.sawReadyForQuery,
                let finalTransactionStatus = observation.transactionStatus
            else {
                throw BrokerError.protocolViolation(
                    "native response ended without ReadyForQuery"
                )
            }
            let cancellation = cancellationController.finishNativeRequest(
                epoch: epoch,
                requestID: requestID
            )
            transactionStatus = finalTransactionStatus

            guard state != .interrupted,
                var request = activeRequest,
                request.lifecycle.requestID == requestID,
                !request.lifecycle.state.isTerminal
            else {
                throw BrokerError.workerInterrupted(epoch: epoch)
            }

            if cancellation.observedByBackend || observation.sawQueryCanceled {
                try sink.send(try makeFrame(.cancelObserved, requestID: requestID))
            }
            #if DEBUG
                faultInjector.afterNativeSuccessBeforeCompleted()
            #endif
            _ = request.lifecycle.establishTerminal(.completed)
            activeRequest = request
            try sink.send(try makeFrame(.completed, requestID: requestID))
            activeRequest = nil
        } catch {
            #if DEBUG
                nativeFaultWorkItem?.cancel()
            #endif
            cancellationController.abandonNativeRequest(epoch: epoch, requestID: requestID)
            if var request = activeRequest, request.lifecycle.requestID == requestID {
                _ = request.lifecycle.establishTerminal(.outcomeUnknown)
                activeRequest = request
            }
            try? sink.send(try makeFrame(.outcomeUnknown, requestID: requestID))
            activeRequest = nil
            // A thrown native stream or socket write makes this request's
            // outcome unknown, but it does not prove permanent process damage.
            // Tear down the physical session and allow a fresh epoch to reopen
            // the same root. The failed request is never replayed.
            state = .interrupted
            acceptingRequests = false
            await closeCurrentSessionForRecovery()
            throw error
        }
    }

    private func makeBackendPrivacyFilter() throws -> BrokerBackendPrivacyFilter {
        var prefixes = [
            configuration.storage.rootURL.path,
            configuration.storage.pgdataURL.path,
            configuration.storage.runtimeCacheURL.path,
            configuration.storage.stagingURL.path,
            NSHomeDirectory(),
            NSTemporaryDirectory(),
            Bundle.main.bundleURL.path,
        ]
        if let resourceURL = Bundle.main.resourceURL {
            prefixes.append(resourceURL.path)
        }
        return try BrokerBackendPrivacyFilter(
            sensitiveAbsolutePrefixes: prefixes
        )
    }

    /// Removes the physical session before suspending in `close()` and keeps
    /// `start` gated until the close finishes. Both the XPC interruption handler
    /// and socket worker can report the same loss, so this also prevents a
    /// duplicate close or a same-root reopen overlapping the old session.
    private func closeCurrentSessionForRecovery() async {
        guard !sessionCloseInProgress, let session else { return }
        self.session = nil
        sessionCloseInProgress = true
        defer { sessionCloseInProgress = false }
        try? await session.close()
    }

    /// Executes rollback/checkpoint against an internal deadline without
    /// waiting for an uncooperative native call after that deadline. A timeout
    /// makes the epoch unusable, requests cancellation out of band, and keeps a
    /// replacement epoch gated until the old call and close have unwound.
    private func executeControlSQL(
        _ sql: String,
        session: any OliphauntSession,
        completingBefore deadline: Date,
        expectedEpoch: BrokerEpoch
    ) async throws {
        let request = try OliphauntProtocol.simpleQuery(sql)
        let operation = Task.detached(priority: .userInitiated) {
            () -> Result<Data, any Error> in
            do {
                return .success(try await session.execProtocolRaw(request))
            } catch {
                return .failure(error)
            }
        }
        let gate = BrokerControlDeadlineGate()
        Task.detached(priority: .userInitiated) {
            gate.resolve(.completed(await operation.value))
        }
        Task.detached(priority: .userInitiated) {
            let remaining = max(0, deadline.timeIntervalSinceNow)
            if remaining > 0 {
                try? await Task.sleep(for: .seconds(remaining))
            }
            gate.resolve(.expired)
        }

        switch await gate.wait() {
        case .completed(let result) where Date() <= deadline:
            let response = try result.get()
            _ = try parseOliphauntQueryResponse(response)
        case .completed, .expired:
            beginDeadlineRecovery(
                session: session,
                operation: operation,
                expectedEpoch: expectedEpoch
            )
            throw BrokerError.workerInterrupted(epoch: expectedEpoch)
        }
    }

    private func beginDeadlineRecovery(
        session: any OliphauntSession,
        operation: Task<Result<Data, any Error>, Never>?,
        expectedEpoch: BrokerEpoch
    ) {
        guard epoch == expectedEpoch else { return }
        acceptingRequests = false
        state = .interrupted
        self.session = nil
        sessionCloseInProgress = true
        let recoveryID = UUID()
        deadlineRecoveryID = recoveryID

        Task.detached(priority: .userInitiated) {
            try? await session.cancel()
        }
        Task.detached(priority: .utility) { [weak self] in
            if let operation {
                _ = await operation.value
            }
            try? await session.close()
            await self?.finishDeadlineRecovery(recoveryID)
        }
    }

    private func finishDeadlineRecovery(_ recoveryID: UUID) {
        guard deadlineRecoveryID == recoveryID else { return }
        deadlineRecoveryID = nil
        sessionCloseInProgress = false
    }

    private func validateStartAttempt(_ attemptID: UUID) throws {
        guard startAttemptID == attemptID, state == .starting else {
            throw BrokerError.workerInterrupted(epoch: epoch)
        }
    }

    private func validateExpectedEpoch(_ expectedEpoch: BrokerEpoch) throws {
        guard epoch == expectedEpoch else {
            throw BrokerError.workerInterrupted(epoch: expectedEpoch)
        }
    }

    private func validateControlContinuation(
        expectedEpoch: BrokerEpoch,
        allowedStates: [BrokerWorkerCoreState]
    ) throws {
        try validateExpectedEpoch(expectedEpoch)
        guard allowedStates.contains(state) else {
            throw BrokerError.workerInterrupted(epoch: expectedEpoch)
        }
    }

    private func executeControlSQL(
        _ sql: String,
        session: any OliphauntSession
    ) async throws {
        let response = try await session.execProtocolRaw(try OliphauntProtocol.simpleQuery(sql))
        _ = try parseOliphauntQueryResponse(response)
    }

    private func establishRestrictedRoleBoundary(
        _ session: any OliphauntSession,
        selectedExtensions: [String]
    ) async throws {
        let role = BrokerWorkerConfiguration.restrictedRoleUsername
        let quotedRoleLiteral = postgresStringLiteral(role)
        let quotedRoleIdentifier = postgresIdentifier(role)
        let bootstrapRole = "postgres"
        let quotedBootstrapRoleLiteral = postgresStringLiteral(bootstrapRole)
        let quotedBootstrapRoleIdentifier = postgresIdentifier(bootstrapRole)
        let database = BrokerWorkerConfiguration.restrictedDatabase
        let quotedDatabaseIdentifier = postgresIdentifier(database)
        let extensionArray =
            selectedExtensions
            .sorted()
            .map(postgresStringLiteral)
            .joined(separator: ", ")

        let sql = """
            BEGIN;
            DO $oliphaunt_broker_bootstrap$
            DECLARE
              extension_name text;
              membership_name text;
              membership_names text[];
              role_is_superuser boolean;
            BEGIN
              IF session_user <> \(quotedRoleLiteral)
                 OR current_user <> \(quotedRoleLiteral) THEN
                RAISE EXCEPTION 'broker restricted role identity mismatch';
              END IF;

              SELECT rolsuper
              INTO STRICT role_is_superuser
              FROM pg_catalog.pg_roles
              WHERE rolname = \(quotedRoleLiteral);

              IF role_is_superuser THEN
                FOREACH extension_name IN ARRAY ARRAY[\(extensionArray)]::text[] LOOP
                  EXECUTE format(
                    'CREATE EXTENSION IF NOT EXISTS %I',
                    extension_name
                  );
                END LOOP;

                REASSIGN OWNED BY \(quotedRoleIdentifier)
                  TO \(quotedBootstrapRoleIdentifier);
                CREATE SCHEMA IF NOT EXISTS \(quotedRoleIdentifier)
                  AUTHORIZATION \(quotedRoleIdentifier);
                ALTER SCHEMA \(quotedRoleIdentifier)
                  OWNER TO \(quotedRoleIdentifier);
                GRANT CONNECT, TEMPORARY
                  ON DATABASE \(quotedDatabaseIdentifier)
                  TO \(quotedRoleIdentifier);
                REVOKE CREATE
                  ON DATABASE \(quotedDatabaseIdentifier)
                  FROM \(quotedRoleIdentifier);
                GRANT USAGE, CREATE
                  ON SCHEMA \(quotedRoleIdentifier)
                  TO \(quotedRoleIdentifier);
                REVOKE CREATE
                  ON SCHEMA public
                  FROM PUBLIC, \(quotedRoleIdentifier);
                GRANT USAGE ON SCHEMA public TO \(quotedRoleIdentifier);
                GRANT pg_checkpoint TO \(quotedRoleIdentifier);
                REVOKE EXECUTE
                  ON FUNCTION pg_catalog.pg_relation_filepath(regclass)
                  FROM PUBLIC, \(quotedRoleIdentifier);
                REVOKE EXECUTE
                  ON FUNCTION pg_catalog.pg_tablespace_location(oid)
                  FROM PUBLIC, \(quotedRoleIdentifier);

                SELECT coalesce(
                  array_agg(parent.rolname::text ORDER BY parent.rolname),
                  ARRAY[]::text[]
                )
                INTO membership_names
                FROM pg_catalog.pg_auth_members membership
                JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
                JOIN pg_catalog.pg_roles member ON member.oid = membership.member
                WHERE member.rolname = \(quotedRoleLiteral)
                  AND parent.rolname <> 'pg_checkpoint';

                FOREACH membership_name IN ARRAY membership_names LOOP
                  EXECUTE format(
                    'REVOKE %I FROM %I',
                    membership_name,
                    \(quotedRoleLiteral)
                  );
                END LOOP;

                ALTER ROLE \(quotedRoleIdentifier)
                  NOSUPERUSER NOCREATEDB NOCREATEROLE
                  INHERIT LOGIN NOREPLICATION NOBYPASSRLS;
              END IF;

              ALTER ROLE \(quotedRoleIdentifier)
                SET search_path TO "$user", public;
            END
            $oliphaunt_broker_bootstrap$;
            SET SESSION AUTHORIZATION \(quotedRoleIdentifier);
            SET search_path TO "$user", public;

            DO $oliphaunt_broker_validate$
            DECLARE
              direct_memberships text[];
              effective_memberships text[];
              role_is_safe boolean;
            BEGIN
              SELECT
                NOT rolsuper
                AND NOT rolcreatedb
                AND NOT rolcreaterole
                AND rolinherit
                AND rolcanlogin
                AND NOT rolreplication
                AND NOT rolbypassrls
                AND coalesce(
                  rolconfig @> ARRAY['search_path="$user", public'],
                  false
                )
              INTO STRICT role_is_safe
              FROM pg_catalog.pg_roles
              WHERE rolname = \(quotedRoleLiteral);

              IF session_user <> \(quotedRoleLiteral)
                 OR current_user <> \(quotedRoleLiteral)
                 OR current_setting('is_superuser') <> 'off'
                 OR current_schemas(false)
                   <> ARRAY[\(quotedRoleLiteral), 'public']::name[]
                 OR NOT role_is_safe THEN
                RAISE EXCEPTION 'broker restricted role validation failed';
              END IF;

              SELECT coalesce(
                array_agg(parent.rolname::text ORDER BY parent.rolname),
                ARRAY[]::text[]
              )
              INTO direct_memberships
              FROM pg_catalog.pg_auth_members membership
              JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
              JOIN pg_catalog.pg_roles member ON member.oid = membership.member
              WHERE member.rolname = \(quotedRoleLiteral);

              IF direct_memberships <> ARRAY['pg_checkpoint']::text[] THEN
                RAISE EXCEPTION 'broker restricted role membership validation failed';
              END IF;

              WITH RECURSIVE effective_role_oids(oid) AS (
                SELECT oid
                FROM pg_catalog.pg_roles
                WHERE rolname = \(quotedRoleLiteral)
                UNION
                SELECT membership.roleid
                FROM effective_role_oids effective
                JOIN pg_catalog.pg_auth_members membership
                  ON membership.member = effective.oid
              )
              SELECT coalesce(
                array_agg(
                  role.rolname::text
                  ORDER BY role.rolname::text COLLATE "C"
                ),
                ARRAY[]::text[]
              )
              INTO effective_memberships
              FROM effective_role_oids effective
              JOIN pg_catalog.pg_roles role ON role.oid = effective.oid;

              IF effective_memberships
                 <> ARRAY[\(quotedRoleLiteral), 'pg_checkpoint']::text[] THEN
                RAISE EXCEPTION 'broker effective role membership validation failed';
              END IF;

              IF NOT EXISTS (
                SELECT 1
                FROM pg_catalog.pg_database database
                JOIN pg_catalog.pg_roles owner ON owner.oid = database.datdba
                WHERE database.datname = current_database()
                  AND owner.rolname = \(quotedBootstrapRoleLiteral)
              ) THEN
                RAISE EXCEPTION 'broker database owner validation failed';
              END IF;

              IF NOT EXISTS (
                SELECT 1
                FROM pg_catalog.pg_namespace namespace
                JOIN pg_catalog.pg_roles owner ON owner.oid = namespace.nspowner
                WHERE namespace.nspname = \(quotedRoleLiteral)
                  AND owner.rolname = \(quotedRoleLiteral)
              ) THEN
                RAISE EXCEPTION 'broker schema owner validation failed';
              END IF;

              IF EXISTS (
                SELECT 1
                FROM unnest(ARRAY[\(extensionArray)]::text[]) requested(name)
                LEFT JOIN pg_catalog.pg_extension installed
                  ON installed.extname = requested.name
                LEFT JOIN pg_catalog.pg_roles owner
                  ON owner.oid = installed.extowner
                WHERE installed.oid IS NULL
                  OR owner.rolname <> \(quotedBootstrapRoleLiteral)
              ) THEN
                RAISE EXCEPTION 'broker selected extension owner validation failed';
              END IF;

              IF NOT pg_catalog.has_database_privilege(
                  \(quotedRoleLiteral), current_database(), 'CONNECT'
                )
                 OR NOT pg_catalog.has_database_privilege(
                   \(quotedRoleLiteral), current_database(), 'TEMPORARY'
                 )
                 OR pg_catalog.has_database_privilege(
                   \(quotedRoleLiteral), current_database(), 'CREATE'
                 )
                 OR NOT pg_catalog.has_schema_privilege(
                   \(quotedRoleLiteral), \(quotedRoleLiteral), 'USAGE'
                 )
                 OR NOT pg_catalog.has_schema_privilege(
                   \(quotedRoleLiteral), \(quotedRoleLiteral), 'CREATE'
                 )
                 OR NOT pg_catalog.has_schema_privilege(
                   \(quotedRoleLiteral), 'public', 'USAGE'
                 )
                 OR pg_catalog.has_schema_privilege(
                   \(quotedRoleLiteral), 'public', 'CREATE'
                 ) THEN
                RAISE EXCEPTION 'broker runtime privilege validation failed';
              END IF;

              IF pg_catalog.pg_has_role(
                  \(quotedRoleLiteral), 'pg_database_owner', 'USAGE'
                )
                 OR pg_catalog.pg_has_role(
                   \(quotedRoleLiteral), 'pg_database_owner', 'MEMBER'
                 )
                 OR pg_catalog.pg_has_role(
                   \(quotedRoleLiteral), 'pg_database_owner', 'SET'
                 ) THEN
                RAISE EXCEPTION 'broker database-owner role validation failed';
              END IF;

              IF pg_catalog.has_function_privilege(
                  \(quotedRoleLiteral),
                  'pg_catalog.pg_relation_filepath(regclass)',
                  'EXECUTE'
                )
                 OR pg_catalog.has_function_privilege(
                   \(quotedRoleLiteral),
                   'pg_catalog.pg_tablespace_location(oid)',
                   'EXECUTE'
                 ) THEN
                RAISE EXCEPTION 'broker path function privilege validation failed';
              END IF;

              IF EXISTS (
                SELECT 1
                FROM pg_catalog.pg_tablespace
                WHERE spcname NOT IN ('pg_default', 'pg_global')
              ) THEN
                RAISE EXCEPTION 'broker tablespace validation failed';
              END IF;
            END
            $oliphaunt_broker_validate$;
            COMMIT;
            """
        try await executeControlSQL(sql, session: session)
    }

    private func healthCheck(_ session: any OliphauntSession) async throws {
        let response = try await session.execProtocolRaw(
            try OliphauntProtocol.simpleQuery("SELECT 1 AS broker_health")
        )
        let result = try parseOliphauntQueryResponse(response)
        guard result.rows.count == 1,
            try result.rows[0].text(0) == "1"
        else {
            throw BrokerError.protocolViolation("broker health check returned an unexpected row")
        }
    }

    private func validateNativeCapabilities(_ session: any OliphauntSession) async throws {
        let capabilities = await session.capabilities()
        guard capabilities.protocolRaw,
            capabilities.protocolStream,
            capabilities.queryCancel
        else {
            throw BrokerError.invalidConfiguration(
                "linked liboliphaunt lacks raw protocol, streaming response, or cancellation support"
            )
        }
    }

    private func validateRequestedCapabilities(
        _ requested: Set<BrokerCapability>
    ) throws {
        let unsupported = requested.subtracting(configuration.capabilities.enabled)
            .sorted { $0.rawValue < $1.rawValue }
        if let first = unsupported.first {
            throw BrokerError.rejected(.unsupportedCapability(first))
        }
    }

    private func readyValue() -> BrokerReady {
        precondition(state == .ready)
        precondition(session != nil)
        guard let preparedStorage, let selectedProtocolVersion else {
            preconditionFailure("ready worker has no prepared storage or protocol version")
        }
        return BrokerReady(
            selectedProtocolVersion: selectedProtocolVersion,
            epoch: epoch,
            extensionPID: Int32(ProcessInfo.processInfo.processIdentifier),
            runtimeVersion: configuration.liboliphauntVersion,
            abiVersion: configuration.cABIVersion,
            postgresMajorVersion: configuration.postgresMajorVersion,
            rootManifestDigest: preparedStorage.manifestDigest,
            actualCapabilities: configuration.capabilities,
            actualRuntimeConfiguration: BrokerRuntimeConfiguration(
                rootID: OliphauntBrokerProtocol.canonicalRootID,
                startupConfigurationDigest: configuration.startupConfigurationDigest,
                selectedExtensions: preparedStorage.manifest.selectedPostgresExtensions,
                footprintProfile: "smallMobile"
            )
        )
    }

    private func sendRejection(
        requestID: BrokerRequestID,
        reason: BrokerRejectionReason,
        sink: any BrokerFrameSink
    ) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try sink.send(
            try makeFrame(
                .rejected,
                requestID: requestID,
                payload: try encoder.encode(reason)
            ))
    }

    private func protocolViolation(
        _ reason: String,
        sink: any BrokerFrameSink
    ) throws -> BrokerFrameHandlingResult {
        try sink.send(try makeFrame(.protocolError, payload: Data(reason.utf8)))
        return .closeChannel
    }

    private func makeFrame(
        _ type: BrokerFrameType,
        requestID: BrokerRequestID? = nil,
        payload: Data = Data()
    ) throws -> BrokerFrame {
        try BrokerFrame(
            protocolVersion: selectedProtocolVersion ?? OliphauntBrokerProtocol.maximumVersion,
            frameType: type,
            epoch: epoch,
            requestID: requestID?.rawValue ?? 0,
            payload: payload
        )
    }
}

private enum BrokerControlDeadlineOutcome: Sendable {
    case completed(Result<Data, any Error>)
    case expired
}

private final class BrokerControlDeadlineGate: @unchecked Sendable {
    private let lock = NSLock()
    private var outcome: BrokerControlDeadlineOutcome?
    private var continuation: CheckedContinuation<BrokerControlDeadlineOutcome, Never>?

    func wait() async -> BrokerControlDeadlineOutcome {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let outcome {
                lock.unlock()
                continuation.resume(returning: outcome)
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }

    func resolve(_ outcome: BrokerControlDeadlineOutcome) {
        lock.lock()
        guard self.outcome == nil else {
            lock.unlock()
            return
        }
        self.outcome = outcome
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: outcome)
    }
}

private func sendResponseBytes(
    _ bytes: Data,
    protocolVersion: UInt16,
    epoch: BrokerEpoch,
    requestID: BrokerRequestID,
    sink: any BrokerFrameSink
) throws {
    var offset = 0
    while offset < bytes.count {
        let end = min(offset + OliphauntBrokerProtocol.maximumFramePayload, bytes.count)
        try sink.send(
            try BrokerFrame(
                protocolVersion: protocolVersion,
                frameType: .responseBytes,
                epoch: epoch,
                requestID: requestID.rawValue,
                payload: bytes.subdata(in: offset..<end)
            ))
        offset = end
    }
}

private func postgresIdentifier(_ value: String) -> String {
    "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
}

private func postgresStringLiteral(_ value: String) -> String {
    "'\(value.replacingOccurrences(of: "'", with: "''"))'"
}

extension BrokerBackendTransactionStatus {
    fileprivate var description: String {
        switch self {
        case .idle: "idle"
        case .transaction: "transaction"
        case .failedTransaction: "failedTransaction"
        }
    }
}

extension BrokerError {
    fileprivate static func brokerUnavailableWithReason(_ reason: String) -> BrokerError {
        .invalidConfiguration("worker is unavailable: \(reason)")
    }
}

private func linkedOliphauntVersion() throws -> String {
    dlerror()
    guard
        let symbol = dlsym(
            UnsafeMutableRawPointer(bitPattern: -2),  // Darwin's RTLD_DEFAULT
            "oliphaunt_version"
        )
    else {
        let detail = dlerror().map { String(cString: $0) } ?? "symbol not found"
        throw BrokerError.invalidConfiguration(
            "cannot inspect linked liboliphaunt version: \(detail)"
        )
    }
    typealias VersionFunction = @convention(c) () -> UnsafePointer<CChar>?
    let function = unsafeBitCast(symbol, to: VersionFunction.self)
    guard let value = function() else {
        throw BrokerError.invalidConfiguration("linked liboliphaunt returned a null version")
    }
    let version = String(cString: value)
    guard !version.isEmpty else {
        throw BrokerError.invalidConfiguration("linked liboliphaunt returned an empty version")
    }
    return version
}
