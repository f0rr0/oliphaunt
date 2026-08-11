import ExtensionFoundation
import Foundation
import Oliphaunt
import OliphauntBrokerProtocol
import OliphauntBrokerXPC
import XPC

@available(iOS 26.0, macOS 26.0, *)
private final class IOSBrokerProcessHandle: @unchecked Sendable {
    let value: AppExtensionProcess

    init(_ value: AppExtensionProcess) {
        self.value = value
    }

    func invalidate() {
        value.invalidate()
    }
}

struct IOSBrokerInputBudget: Sendable {
    enum ReservationState: Equatable, Sendable {
        case queued
        case active
    }

    private struct Reservation: Sendable {
        let bytes: Int
        var state: ReservationState
    }

    let maximumBytes: Int
    private var reservations: [BrokerRequestID: Reservation] = [:]
    private(set) var accountedBytes = 0

    init(
        maximumBytes: Int = OliphauntBrokerProtocol.maximumQueuedBytesPerDirection
    ) {
        precondition(maximumBytes >= 0)
        self.maximumBytes = maximumBytes
    }

    mutating func reserve(_ bytes: Int, for requestID: BrokerRequestID) -> Bool {
        guard bytes >= 0, reservations[requestID] == nil else {
            return false
        }
        let (newTotal, overflow) = accountedBytes.addingReportingOverflow(bytes)
        guard !overflow, newTotal <= maximumBytes else {
            return false
        }
        reservations[requestID] = Reservation(bytes: bytes, state: .queued)
        accountedBytes = newTotal
        return true
    }

    mutating func activate(_ requestID: BrokerRequestID) {
        guard var reservation = reservations[requestID] else {
            preconditionFailure("activating an unaccounted broker request")
        }
        precondition(reservation.state == .queued, "broker request activated more than once")
        reservation.state = .active
        reservations[requestID] = reservation
    }

    mutating func release(_ requestID: BrokerRequestID) {
        guard let reservation = reservations.removeValue(forKey: requestID) else {
            preconditionFailure("releasing an unaccounted broker request")
        }
        precondition(accountedBytes >= reservation.bytes)
        accountedBytes -= reservation.bytes
    }

    mutating func reset() {
        reservations.removeAll(keepingCapacity: true)
        accountedBytes = 0
    }

    func state(for requestID: BrokerRequestID) -> ReservationState? {
        reservations[requestID]?.state
    }
}

struct IOSBrokerLaunchMetrics: Equatable, Sendable {
    private(set) var attemptCount: UInt64 = 0
    private(set) var successfulCount: UInt64 = 0

    mutating func recordProcessInitializationAttempt() {
        attemptCount &+= 1
    }

    mutating func recordReadyValidatedLaunch() {
        precondition(
            successfulCount < attemptCount,
            "a broker launch cannot succeed without a process initialization attempt"
        )
        successfulCount &+= 1
    }
}

struct IOSBrokerResumeRetryPolicy: Sendable {
    private(set) var retryCount = 0

    mutating func consumeRetry(for error: any Error) -> Bool {
        guard retryCount == 0,
            let brokerError = error as? BrokerError,
            case .workerInterrupted = brokerError
        else {
            return false
        }
        retryCount = 1
        return true
    }
}

struct IOSBrokerLaunchAcquisitionRetryPolicy: Sendable {
    private(set) var retryCount = 0

    mutating func consumeRetry(
        for error: any Error,
        recoveringInterruptedEpoch: Bool
    ) -> Bool {
        guard recoveringInterruptedEpoch,
            retryCount == 0,
            Self.containsDeadProcessAssertion(error)
        else {
            return false
        }
        retryCount = 1
        return true
    }

    private static func containsDeadProcessAssertion(_ error: any Error) -> Bool {
        var current: NSError? = error as NSError
        var visited: Set<ObjectIdentifier> = []

        while let currentError = current {
            guard visited.insert(ObjectIdentifier(currentError)).inserted else {
                return false
            }
            if currentError.domain == "RBSAssertionErrorDomain",
                currentError.code == 2
            {
                return true
            }
            current = currentError.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return false
    }
}

struct IOSBrokerInterruptedLaunchExpectation: Equatable, Sendable {
    let staleEpoch: BrokerEpoch
    let knownDeadProcessIdentifier: Int32?

    func validate(
        recoveredEpoch: BrokerEpoch,
        recoveredProcessIdentifier: Int32
    ) throws {
        guard recoveredEpoch != staleEpoch else {
            throw BrokerError.protocolViolation(
                "worker recovery reused the interrupted worker epoch"
            )
        }
        if let knownDeadProcessIdentifier,
            recoveredProcessIdentifier == knownDeadProcessIdentifier
        {
            throw BrokerError.protocolViolation(
                "worker recovery reused the known-dead extension process"
            )
        }
    }
}

struct IOSBrokerResumeRecoveryExpectation: Equatable, Sendable {
    let staleEpoch: BrokerEpoch?
    let rootManifestDigest: String?

    func validate(
        recoveredEpoch: BrokerEpoch,
        recoveredRootManifestDigest: String
    ) throws {
        if let staleEpoch, recoveredEpoch == staleEpoch {
            throw BrokerError.protocolViolation(
                "resume recovery reused the interrupted worker epoch"
            )
        }
        if let rootManifestDigest,
            recoveredRootManifestDigest != rootManifestDigest
        {
            throw BrokerError.rootMismatch(
                expected: rootManifestDigest,
                actual: recoveredRootManifestDigest
            )
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
public actor IOSBrokerManager {
    public static let shared = IOSBrokerManager()

    public private(set) var state: IOSBrokerManagerState = .idle

    private var process: IOSBrokerProcessHandle?
    private var controlSession: XPCSession?
    private var dataChannel: IOSBrokerDataChannel?
    private var ready: BrokerReady?
    private var currentLaunchID: UUID?
    private var lastExtensionPID: Int32?
    private var residentRootManifestDigest: String?

    private var residentIdentity: ResidentIdentity?
    private var brokerConfiguration: IOSBrokerConfiguration?
    private var handles: Set<UUID> = []
    private var queue: [PendingOperation] = []
    private var inputBudget = IOSBrokerInputBudget()
    private var inFlight: [BrokerRequestID: PendingOperation] = [:]
    private var active: PendingOperation?
    private var transactionOwner: UUID?
    private var drainRunning = false
    private var detachWhenIdle = false
    private var admissionsPaused = false
    private var requestIDs = try! BrokerRequestIDSequence()
    private var launchMetrics = IOSBrokerLaunchMetrics()
    private var interruptionCount: UInt64 = 0

    private let controlQueue = DispatchQueue(
        label: "dev.oliphaunt.ios-broker.control",
        qos: .userInitiated
    )

    public init() {}

    deinit {
        // XPCSession treats releasing an activated session without an explicit
        // cancel as API misuse. Actor teardown can happen while unwinding a
        // failed launch, before the normal detach path has run.
        controlSession?.cancel(reason: "broker manager deinitialized")
        process?.invalidate()
        dataChannel?.close()
    }

    public func open(
        configuration proposedConfiguration: IOSBrokerConfiguration,
        databaseConfiguration: OliphauntConfiguration
    ) async throws -> IOSBrokerSession {
        let configuration = try proposedConfiguration.validated()
        let identity = try ResidentIdentity(
            broker: configuration,
            database: databaseConfiguration
        )

        if let residentIdentity, residentIdentity != identity {
            throw BrokerError.invalidConfiguration(
                "broker v1 already owns the canonical root with a different runtime configuration"
            )
        }
        if let brokerConfiguration, brokerConfiguration != configuration {
            throw BrokerError.invalidConfiguration(
                "the application-scoped broker manager already has different host settings"
            )
        }
        guard !admissionsPaused else {
            throw BrokerError.rejected(.queueClosed)
        }

        residentIdentity = identity
        brokerConfiguration = configuration
        let handleID = UUID()
        handles.insert(handleID)
        detachWhenIdle = false

        do {
            _ = try await enqueue(
                kind: .ensureReady,
                handleID: handleID,
                queuedBytes: 0,
                deadline: nil
            )
            return IOSBrokerSession(
                manager: self,
                handleID: handleID,
                maximumRawResponseBytes: configuration.maximumRawResponseBytes
            )
        } catch {
            handles.remove(handleID)
            if handles.isEmpty {
                detachWhenIdle = true
                await detachIfUnused()
            }
            throw error
        }
    }

    public func diagnostics() -> IOSBrokerDiagnostics {
        IOSBrokerDiagnostics(
            state: state,
            epoch: ready?.epoch ?? state.epoch,
            extensionProcessIdentifier: ready?.extensionPID ?? lastExtensionPID,
            logicalHandleCount: handles.count,
            queuedOperationCount: queue.count,
            activeRequestID: active?.requestID,
            launchAttemptCount: launchMetrics.attemptCount,
            launchCount: launchMetrics.successfulCount,
            interruptionCount: interruptionCount,
            admissionsPaused: admissionsPaused
        )
    }

    public func extensionProcessIdentifier() -> Int32? {
        ready?.extensionPID ?? lastExtensionPID
    }

    func capabilities(for handleID: UUID) -> OliphauntCapabilities {
        guard handles.contains(handleID) else {
            return IOSBrokerCapabilityMapping.initial
        }
        return ready.map { IOSBrokerCapabilityMapping.map($0.actualCapabilities) }
            ?? IOSBrokerCapabilityMapping.initial
    }

    func workerDiagnostics(handleID: UUID) async throws -> IOSBrokerWorkerDiagnostics {
        try requireHandle(handleID)
        if let connection = currentConnection(),
            state == .ready(connection.ready.epoch)
                || state == .quiescing(connection.ready.epoch)
        {
            // Diagnostics is deliberately an out-of-band control read. It does
            // no database work and may sample the extension while the framed
            // data channel is executing or backpressured.
            let reply = try await sendControl(
                IOSBrokerControlEnvelope(
                    kind: .diagnostics,
                    epoch: connection.ready.epoch
                ),
                expected: .diagnostics
            )
            guard currentLaunchID == connection.launchID,
                ready?.epoch == connection.ready.epoch
            else {
                throw BrokerError.workerInterrupted(epoch: connection.ready.epoch)
            }
            let diagnostics = IOSBrokerWorkerDiagnostics(
                wire: try IOSBrokerXPC.decodeWorkerDiagnostics(reply)
            )
            guard diagnostics.epoch == connection.ready.epoch else {
                throw BrokerError.workerInterrupted(epoch: connection.ready.epoch)
            }
            return diagnostics
        }
        let operation = try await enqueue(
            kind: .diagnostics,
            handleID: handleID,
            queuedBytes: 0,
            deadline: brokerConfiguration?.requestDeadline
        )
        guard let diagnostics = operation.workerDiagnostics else {
            throw BrokerError.protocolViolation("worker omitted diagnostics result")
        }
        return diagnostics
    }

    func execute(
        handleID: UUID,
        bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try requireHandle(handleID)
        guard !admissionsPaused else {
            throw BrokerError.rejected(.queueClosed)
        }
        guard let configuration = brokerConfiguration else {
            throw BrokerError.brokerUnavailable
        }
        guard bytes.count <= configuration.maximumRequestBytes else {
            throw BrokerProtocolError.payloadTooLarge(
                actual: UInt64(bytes.count),
                maximum: configuration.maximumRequestBytes
            )
        }
        _ = try await enqueue(
            kind: .data(bytes, onChunk),
            handleID: handleID,
            queuedBytes: bytes.count,
            deadline: configuration.requestDeadline
        )
    }

    func checkpoint(handleID: UUID) async throws {
        try requireHandle(handleID)
        guard !admissionsPaused else {
            throw BrokerError.rejected(.queueClosed)
        }
        _ = try await enqueue(
            kind: .checkpoint,
            handleID: handleID,
            queuedBytes: 0,
            deadline: brokerConfiguration?.requestDeadline
        )
    }

    func prepareForBackground(
        handleID: UUID,
        deadline: Date
    ) async throws -> OliphauntBackgroundPreparationResult {
        try requireHandle(handleID)
        guard deadline > Date() else {
            throw BrokerError.deadlineExceeded
        }
        admissionsPaused = true
        if case .ready(let epoch) = state {
            state = .quiescing(epoch)
        }

        let queuedData = queue.filter { $0.isData }
        for operation in queuedData {
            finish(operation, throwing: BrokerError.canceled)
        }

        let cancelledActiveWork = active?.isData == true
        if cancelledActiveWork {
            let operation = active
            Task { [weak self, weak operation] in
                guard let self, let operation else { return }
                try? await self.sendCancellation(for: operation)
            }
        }

        let duration = Duration.seconds(max(0, deadline.timeIntervalSinceNow))
        let operation = try await enqueue(
            kind: .prepareForBackground(deadline),
            handleID: handleID,
            queuedBytes: 0,
            deadline: duration
        )
        let workerResult =
            operation.backgroundResult
            ?? OliphauntBackgroundPreparationResult(
                cancelledActiveWork: false,
                checkpointed: true
            )
        return Self.mergeBackgroundPreparationResult(
            hostCancelledActiveWork: cancelledActiveWork,
            workerResult: workerResult
        )
    }

    static func mergeBackgroundPreparationResult(
        hostCancelledActiveWork: Bool,
        workerResult: OliphauntBackgroundPreparationResult
    ) -> OliphauntBackgroundPreparationResult {
        OliphauntBackgroundPreparationResult(
            cancelledActiveWork:
                hostCancelledActiveWork || workerResult.cancelledActiveWork,
            checkpointed: workerResult.checkpointed,
            skippedCheckpointReason: workerResult.skippedCheckpointReason
        )
    }

    func prepareForBackground(
        handleID: UUID,
        timeout: Duration
    ) async throws -> OliphauntBackgroundPreparationResult {
        try await prepareForBackground(
            handleID: handleID,
            deadline: Date().addingTimeInterval(timeout.timeInterval)
        )
    }

    func resumeFromBackground(handleID: UUID) async throws {
        try requireHandle(handleID)
        let recoveryExpectation = IOSBrokerResumeRecoveryExpectation(
            staleEpoch: ready?.epoch ?? state.epoch,
            rootManifestDigest: residentRootManifestDigest
        )
        let deadline = brokerConfiguration?.requestDeadline

        if currentConnection() == nil, state.epoch != nil {
            _ = try await enqueue(
                kind: .resumeFromBackground(recovering: recoveryExpectation),
                handleID: handleID,
                queuedBytes: 0,
                deadline: deadline
            )
        } else {
            var retryPolicy = IOSBrokerResumeRetryPolicy()
            do {
                _ = try await enqueue(
                    kind: .resumeFromBackground(recovering: nil),
                    handleID: handleID,
                    queuedBytes: 0,
                    deadline: deadline
                )
            } catch {
                guard retryPolicy.consumeRetry(for: error) else {
                    throw error
                }
                _ = try await enqueue(
                    kind: .resumeFromBackground(recovering: recoveryExpectation),
                    handleID: handleID,
                    queuedBytes: 0,
                    deadline: deadline
                )
            }
        }
        admissionsPaused = false
        if let epoch = ready?.epoch {
            state = .ready(epoch)
        }
    }

    func cancel(handleID: UUID) async throws {
        try requireHandle(handleID)

        let queuedForHandle = queue.filter { $0.handleID == handleID && $0.isData }
        for operation in queuedForHandle {
            finish(operation, throwing: BrokerError.canceled)
        }

        guard let active, active.handleID == handleID, active.isData else {
            return
        }
        do {
            try await sendCancellation(for: active)
        } catch {
            interruptCurrentLaunch(reason: "cancellation control failed: \(error)")
            throw error
        }
    }

    #if DEBUG
        func injectFault(handleID: UUID, fault: BrokerWorkerFault) async throws {
            try requireHandle(handleID)
            _ = try await enqueue(
                kind: .injectFault(fault),
                handleID: handleID,
                queuedBytes: 0,
                deadline: brokerConfiguration?.requestDeadline
            )
        }
    #endif

    func close(handleID: UUID) async throws {
        guard handles.remove(handleID) != nil else {
            return
        }

        let queuedForHandle = queue.filter { $0.handleID == handleID }
        for operation in queuedForHandle {
            finish(operation, throwing: BrokerError.canceled)
        }
        if let active, active.handleID == handleID, active.isData {
            try? await sendCancellation(for: active)
        }
        if transactionOwner == handleID {
            transactionOwner = nil
            interruptCurrentLaunch(
                reason: "logical handle detached while it owned a physical transaction"
            )
        }

        guard handles.isEmpty else {
            return
        }
        detachWhenIdle = true
        admissionsPaused = false
        await detachIfUnused()
    }

    private func enqueue(
        kind: PendingOperation.Kind,
        handleID: UUID,
        queuedBytes: Int,
        deadline: Duration?
    ) async throws -> PendingOperation {
        try requireHandle(handleID)
        let requestID = try requestIDs.next()
        guard inputBudget.reserve(queuedBytes, for: requestID) else {
            throw BrokerError.rejected(.queueClosed)
        }
        let operation = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<PendingOperation, any Error>) in
            let operation = PendingOperation(
                requestID: requestID,
                handleID: handleID,
                kind: kind,
                queuedBytes: queuedBytes,
                continuation: continuation
            )
            queue.append(operation)
            inFlight[requestID] = operation
            if let deadline {
                operation.deadlineTask = Task { [weak self, weak operation] in
                    do {
                        try await Task.sleep(for: deadline)
                    } catch {
                        return
                    }
                    guard let self, let operation else {
                        return
                    }
                    await self.deadlineExpired(operation)
                }
            }
            scheduleDrain()
        }
        return operation
    }

    private func scheduleDrain() {
        guard !drainRunning else {
            return
        }
        drainRunning = true
        Task { await drain() }
    }

    private func drain() async {
        while true {
            guard active == nil else {
                drainRunning = false
                return
            }
            while let first = queue.first, first.terminal {
                removeFromQueue(first)
            }
            guard let operation = nextQueuedOperation() else {
                drainRunning = false
                await detachIfUnused()
                return
            }

            removeFromQueue(operation)
            inputBudget.activate(operation.requestID)
            active = operation

            do {
                let connection = try await ensureReady()
                guard !operation.terminal else {
                    active = nil
                    continue
                }
                operation.epoch = connection.ready.epoch
                try await perform(operation, connection: connection)
                finish(operation)
            } catch {
                if !operation.terminal {
                    handleOperationFailure(operation, error: error)
                }
            }
            if active === operation {
                active = nil
            }
        }
    }

    private func perform(
        _ operation: PendingOperation,
        connection: ActiveConnection
    ) async throws {
        switch operation.kind {
        case .ensureReady:
            return
        case .data(let bytes, let onChunk):
            operation.bytesMayHaveReachedWorker = true
            let transactionStatus = try await connection.channel.execute(
                requestID: operation.requestID,
                epoch: connection.ready.epoch,
                protocolVersion: connection.ready.selectedProtocolVersion,
                bytes: bytes,
                maximumRequestBytes: brokerConfiguration?.maximumRequestBytes
                    ?? OliphauntBrokerProtocol.defaultMaximumRequestBytes,
                onChunk: onChunk
            )
            switch transactionStatus {
            case .idle:
                if transactionOwner == operation.handleID {
                    transactionOwner = nil
                }
            case .inTransaction, .failedTransaction:
                transactionOwner = operation.handleID
            }
        case .checkpoint:
            _ = try await sendControl(
                IOSBrokerControlEnvelope(
                    kind: .checkpoint,
                    epoch: connection.ready.epoch,
                    requestID: operation.requestID
                ),
                expected: .checkpoint
            )
        case .diagnostics:
            let reply = try await sendControl(
                IOSBrokerControlEnvelope(
                    kind: .diagnostics,
                    epoch: connection.ready.epoch,
                    requestID: operation.requestID
                ),
                expected: .diagnostics
            )
            operation.workerDiagnostics = IOSBrokerWorkerDiagnostics(
                wire: try IOSBrokerXPC.decodeWorkerDiagnostics(reply)
            )
        #if DEBUG
            case .injectFault(let fault):
                _ = try await sendControl(
                    IOSBrokerControlEnvelope(
                        kind: .injectFault,
                        epoch: connection.ready.epoch,
                        requestID: operation.requestID,
                        fault: fault
                    ),
                    expected: .injectFault
                )
        #endif
        case .prepareForBackground(let deadline):
            let reply = try await sendControl(
                IOSBrokerControlEnvelope(
                    kind: .prepareForBackground,
                    epoch: connection.ready.epoch,
                    requestID: operation.requestID,
                    deadlineUnixNanoseconds: deadline.unixNanoseconds
                ),
                expected: .prepareForBackground,
                timeout: Duration.seconds(max(0.001, deadline.timeIntervalSinceNow))
            )
            let cancelled: Bool = reply[IOSBrokerXPC.cancelledActiveWorkKey] ?? false
            let checkpointed: Bool = reply[IOSBrokerXPC.checkpointedKey] ?? true
            operation.backgroundResult = OliphauntBackgroundPreparationResult(
                cancelledActiveWork: cancelled,
                checkpointed: checkpointed,
                skippedCheckpointReason: checkpointed ? nil : .activeWork
            )
            transactionOwner = nil
            state = .quiescing(connection.ready.epoch)
        case .resumeFromBackground(let recoveryExpectation):
            if let recoveryExpectation {
                try recoveryExpectation.validate(
                    recoveredEpoch: connection.ready.epoch,
                    recoveredRootManifestDigest: connection.ready.rootManifestDigest
                )
            } else {
                _ = try await sendControl(
                    IOSBrokerControlEnvelope(
                        kind: .resumeFromBackground,
                        epoch: connection.ready.epoch,
                        requestID: operation.requestID
                    ),
                    expected: .resumeFromBackground
                )
            }
            try await connection.channel.healthCheck(
                epoch: connection.ready.epoch,
                protocolVersion: connection.ready.selectedProtocolVersion
            )
            state = .ready(connection.ready.epoch)
        }
    }

    private func handleOperationFailure(_ operation: PendingOperation, error: any Error) {
        if error is IOSBrokerTransportFailure {
            let interruptedEpoch = operation.epoch ?? ready?.epoch ?? state.epoch
            interruptCurrentLaunch(reason: String(describing: error))
            if !operation.terminal {
                finish(
                    operation,
                    throwing: BrokerError.workerInterrupted(epoch: interruptedEpoch)
                )
            }
            return
        }
        if let failure = error as? IOSBrokerDataPlaneFailure {
            switch failure {
            case .rejected(let reason):
                if reason == .canceled {
                    finish(operation, throwing: BrokerError.canceled)
                } else {
                    finish(operation, throwing: BrokerError.rejected(reason))
                }
            case .outcomeUnknown, .protocolViolation:
                let epoch = operation.epoch ?? ready?.epoch
                interruptCurrentLaunch(reason: String(describing: failure))
                if !operation.terminal, let epoch {
                    finish(
                        operation,
                        throwing: BrokerError.outcomeUnknown(
                            epoch: epoch,
                            requestID: operation.requestID
                        )
                    )
                }
            }
            return
        }
        if let brokerError = error as? BrokerError {
            switch brokerError {
            case .workerInterrupted, .protocolViolation:
                // A timed-out or malformed control exchange leaves the epoch's
                // synchronization unprovable. Atomically tear it down so the
                // next demand must establish a fresh process/session/epoch.
                interruptCurrentLaunch(reason: String(describing: brokerError))
                if !operation.terminal {
                    finish(operation, throwing: brokerError)
                }
                return
            default:
                break
            }
        }
        finish(operation, throwing: error)
    }

    private func ensureReady() async throws -> ActiveConnection {
        try await ensureReady(
            launchAcquisitionRetryPolicy: IOSBrokerLaunchAcquisitionRetryPolicy(),
            knownDeadProcessIdentifier: nil
        )
    }

    private func ensureReady(
        launchAcquisitionRetryPolicy: IOSBrokerLaunchAcquisitionRetryPolicy,
        knownDeadProcessIdentifier: Int32?
    ) async throws -> ActiveConnection {
        if let connection = currentConnection(),
            state == .ready(connection.ready.epoch) || state == .quiescing(connection.ready.epoch)
        {
            return connection
        }
        guard let configuration = brokerConfiguration,
            let residentIdentity
        else {
            throw BrokerError.brokerUnavailable
        }
        if state == .unavailable {
            throw BrokerError.extensionMissing
        }

        let oldEpoch = state.epoch
        state = oldEpoch == nil ? .launching : .recovering
        let launchID = UUID()
        currentLaunchID = launchID
        var processAcquired = false
        var retryPolicy = launchAcquisitionRetryPolicy

        do {
            let identity = try await IOSBrokerExtensionDiscovery.discover(
                bundleIdentifier: configuration.extensionBundleIdentifier
            )
            guard currentLaunchID == launchID else {
                throw BrokerError.workerInterrupted(epoch: oldEpoch)
            }

            let interruptionRelay = IOSBrokerInterruptionRelay()
            interruptionRelay.install { [weak self] in
                Task { await self?.extensionInterrupted(launchID: launchID) }
            }
            launchMetrics.recordProcessInitializationAttempt()
            let processConfiguration = AppExtensionProcess.Configuration(
                appExtensionIdentity: identity,
                onInterruption: { interruptionRelay.signal() }
            )
            let launchedProcess = try await AppExtensionProcess(
                configuration: processConfiguration
            )
            processAcquired = true
            guard currentLaunchID == launchID else {
                launchedProcess.invalidate()
                throw BrokerError.workerInterrupted(epoch: oldEpoch)
            }

            let session = try launchedProcess.makeXPCSession()
            session.setTargetQueue(controlQueue)
            session.setIncomingMessageHandler { _ in
                try? IOSBrokerXPC.makeRejected(
                    .invalidRequest("host does not accept unsolicited control requests")
                )
            }
            session.setCancellationHandler { _ in
                interruptionRelay.signal()
            }
            try session.activate()

            let sockets = try IOSBrokerSocketPair.make()
            process = IOSBrokerProcessHandle(launchedProcess)
            controlSession = session
            dataChannel = sockets.host
            state = .binding

            let helloMessage = try IOSBrokerXPC.makeHello(
                configuration.hello,
                dataChannel: sockets.extensionEndpoint
            )
            let reply: XPCDictionary
            do {
                reply = try await request(
                    session: session,
                    message: helloMessage,
                    timeout: configuration.controlReplyTimeout,
                    epoch: oldEpoch
                ).dictionary
            } catch {
                sockets.extensionEndpoint.close()
                throw error
            }
            // xpc_fd_create owns its duplicate. The sender's original is closed
            // only once a worker reply proves the transfer completed.
            sockets.extensionEndpoint.close()

            let workerReady = try IOSBrokerXPC.decodeReady(reply)
            try validateReady(
                workerReady,
                hello: configuration.hello,
                residentIdentity: residentIdentity
            )
            if let oldEpoch {
                try IOSBrokerInterruptedLaunchExpectation(
                    staleEpoch: oldEpoch,
                    knownDeadProcessIdentifier: knownDeadProcessIdentifier
                ).validate(
                    recoveredEpoch: workerReady.epoch,
                    recoveredProcessIdentifier: workerReady.extensionPID
                )
            }
            if let residentRootManifestDigest,
                workerReady.rootManifestDigest != residentRootManifestDigest
            {
                throw BrokerError.rootMismatch(
                    expected: residentRootManifestDigest,
                    actual: workerReady.rootManifestDigest
                )
            }
            guard currentLaunchID == launchID else {
                throw BrokerError.workerInterrupted(epoch: workerReady.epoch)
            }
            ready = workerReady
            transactionOwner = nil
            lastExtensionPID = workerReady.extensionPID
            launchMetrics.recordReadyValidatedLaunch()

            try await sockets.host.healthCheck(
                epoch: workerReady.epoch,
                protocolVersion: workerReady.selectedProtocolVersion
            )
            guard currentLaunchID == launchID else {
                throw BrokerError.workerInterrupted(epoch: workerReady.epoch)
            }
            if residentRootManifestDigest == nil {
                residentRootManifestDigest = workerReady.rootManifestDigest
            }
            state = .ready(workerReady.epoch)
            return ActiveConnection(
                session: session,
                channel: sockets.host,
                ready: workerReady,
                launchID: launchID
            )
        } catch let launchError {
            if !processAcquired,
                let oldEpoch,
                currentLaunchID == launchID,
                retryPolicy.consumeRetry(
                    for: launchError,
                    recoveringInterruptedEpoch: true
                )
            {
                let deadProcessIdentifier = lastExtensionPID
                do {
                    try await Task.sleep(for: .milliseconds(500))
                } catch {
                    if currentLaunchID == launchID {
                        tearDownConnection(reason: "launch retry cancelled")
                        state = .interrupted(oldEpoch)
                    }
                    throw launchError
                }
                guard currentLaunchID == launchID else {
                    throw BrokerError.workerInterrupted(epoch: oldEpoch)
                }
                tearDownConnection(
                    reason: "retrying stale ExtensionKit process assertion"
                )
                state = .interrupted(oldEpoch)
                return try await ensureReady(
                    launchAcquisitionRetryPolicy: retryPolicy,
                    knownDeadProcessIdentifier: deadProcessIdentifier
                )
            }
            if currentLaunchID == launchID {
                let missing = (launchError as? BrokerError) == .extensionMissing
                tearDownConnection(reason: "launch failed")
                if missing {
                    state = .unavailable
                } else if let oldEpoch {
                    state = .interrupted(oldEpoch)
                } else {
                    state = .idle
                }
            }
            throw launchError
        }
    }

    private func currentConnection() -> ActiveConnection? {
        guard let session = controlSession,
            let channel = dataChannel,
            let ready,
            let launchID = currentLaunchID
        else {
            return nil
        }
        return ActiveConnection(
            session: session,
            channel: channel,
            ready: ready,
            launchID: launchID
        )
    }

    private func validateReady(
        _ ready: BrokerReady,
        hello: BrokerHello,
        residentIdentity: ResidentIdentity
    ) throws {
        guard ready.selectedProtocolVersion >= hello.minimumProtocolVersion,
            ready.selectedProtocolVersion <= hello.maximumProtocolVersion,
            OliphauntBrokerProtocol.supports(version: ready.selectedProtocolVersion)
        else {
            throw BrokerError.incompatibleProtocol(
                minimum: hello.minimumProtocolVersion,
                maximum: hello.maximumProtocolVersion
            )
        }
        guard ready.abiVersion == hello.expectedABI else {
            throw BrokerError.incompatibleABI(
                expected: hello.expectedABI,
                actual: ready.abiVersion
            )
        }
        if let expected = hello.expectedRuntimeVersion, expected != ready.runtimeVersion {
            throw BrokerError.runtimeMismatch(expected: expected, actual: ready.runtimeVersion)
        }
        guard ready.actualRuntimeConfiguration.rootID == hello.rootID else {
            throw BrokerError.rootMismatch(
                expected: hello.rootID,
                actual: ready.actualRuntimeConfiguration.rootID
            )
        }
        guard
            ready.actualRuntimeConfiguration.startupConfigurationDigest
                == hello.startupConfigurationDigest
        else {
            throw BrokerError.invalidConfiguration(
                "worker startup-configuration digest does not match the host"
            )
        }
        guard
            ready.actualRuntimeConfiguration.selectedExtensions.sorted()
                == residentIdentity.extensions
        else {
            throw BrokerError.invalidConfiguration("worker extension set does not match the host")
        }
        let missing = hello.requestedCapabilities.subtracting(
            ready.actualCapabilities.enabled
        )
        if let capability = missing.sorted(by: { $0.rawValue < $1.rawValue }).first {
            throw BrokerError.rejected(.unsupportedCapability(capability))
        }
        guard !ready.actualCapabilities.rootSwitchable,
            !ready.actualCapabilities.multiRoot,
            !ready.actualCapabilities.independentSessions,
            ready.actualCapabilities.maxClientSessions == 1,
            !ready.actualCapabilities.backupRestore,
            !ready.actualCapabilities.serverMode,
            ready.actualCapabilities.connectionString == nil
        else {
            throw BrokerError.protocolViolation(
                "worker advertised capabilities that violate iOS broker v1 invariants"
            )
        }
    }

    private func sendCancellation(for operation: PendingOperation?) async throws {
        guard let operation,
            let epoch = operation.epoch,
            !operation.terminal
        else {
            return
        }
        let reply = try await sendControl(
            IOSBrokerControlEnvelope(
                kind: .cancel,
                epoch: epoch,
                requestID: operation.requestID
            ),
            expected: .cancelObserved
        )
        let kind = try IOSBrokerXPC.messageKind(in: reply)
        guard kind == .cancelObserved || kind == .cancel else {
            throw BrokerError.protocolViolation("invalid cancellation acknowledgement")
        }
    }

    private func sendControl(
        _ envelope: IOSBrokerControlEnvelope,
        expected: BrokerControlMessageKind,
        timeout: Duration? = nil
    ) async throws -> XPCDictionary {
        guard let session = controlSession else {
            throw BrokerError.workerInterrupted(epoch: envelope.epoch)
        }
        let reply = try await request(
            session: session,
            message: IOSBrokerXPC.makeControl(envelope),
            timeout: timeout ?? brokerConfiguration?.controlReplyTimeout ?? .seconds(15),
            epoch: envelope.epoch
        ).dictionary
        let kind = try IOSBrokerXPC.messageKind(in: reply)
        if kind == .rejected {
            throw try IOSBrokerXPC.decodeError(reply)
        }
        if expected == .cancelObserved {
            guard kind == .cancelObserved || kind == .cancel else {
                throw BrokerError.protocolViolation(
                    "expected CancelObserved, received \(kind.rawValue)"
                )
            }
        } else if kind != expected {
            throw BrokerError.protocolViolation(
                "expected \(expected.rawValue), received \(kind.rawValue)"
            )
        }
        let succeeded: Bool = reply[IOSBrokerXPC.successKey] ?? true
        guard succeeded else {
            let reason: String = reply[BrokerControlKey.reason] ?? "control request failed"
            throw BrokerError.rejected(.invalidRequest(reason))
        }
        return reply
    }

    private func request(
        session: XPCSession,
        message: XPCDictionary,
        timeout: Duration,
        epoch: BrokerEpoch?
    ) async throws -> IOSBrokerXPCReply {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<IOSBrokerXPCReply, any Error>) in
            let gate = XPCReplyGate(continuation: continuation)
            controlQueue.asyncAfter(deadline: .now() + timeout.timeInterval) {
                gate.fail(BrokerError.workerInterrupted(epoch: epoch))
            }
            session.send(message: message) { result in
                switch result {
                case .success(let reply):
                    gate.succeed(reply)
                case .failure:
                    gate.fail(BrokerError.workerInterrupted(epoch: epoch))
                }
            }
        }
    }

    private func deadlineExpired(_ operation: PendingOperation) async {
        guard inFlight[operation.requestID] === operation,
            !operation.terminal
        else {
            return
        }
        guard active === operation else {
            if operation.isBackgroundPreparation {
                finish(operation, throwing: BrokerError.deadlineExceeded)
                interruptCurrentLaunch(
                    reason: "background preparation could not quiesce before its deadline"
                )
                return
            }
            finish(operation, throwing: BrokerError.deadlineExceeded)
            return
        }
        guard operation.isData else {
            if !operation.terminal {
                finish(operation, throwing: BrokerError.deadlineExceeded)
            }
            interruptCurrentLaunch(reason: "lifecycle control exceeded its deadline")
            return
        }

        operation.deadlineCancellationRequested = true
        Task { [weak self, weak operation] in
            guard let self, let operation else { return }
            try? await self.sendCancellation(for: operation)
        }
        let grace = brokerConfiguration?.cancellationGracePeriod ?? .seconds(2)
        operation.cancellationGraceTask = Task { [weak self, weak operation] in
            do {
                try await Task.sleep(for: grace)
            } catch {
                return
            }
            guard let self, let operation else { return }
            await self.cancellationGraceExpired(operation)
        }
    }

    private func cancellationGraceExpired(_ operation: PendingOperation) {
        guard active === operation, !operation.terminal else {
            return
        }
        interruptCurrentLaunch(reason: "request did not terminate during cancellation grace")
    }

    private func extensionInterrupted(launchID: UUID) {
        guard currentLaunchID == launchID else {
            return
        }
        interruptCurrentLaunch(reason: "ExtensionFoundation interruption")
    }

    private func interruptCurrentLaunch(reason: String) {
        guard currentLaunchID != nil || ready != nil || process != nil else {
            return
        }
        interruptionCount &+= 1
        let interruptedEpoch = ready?.epoch ?? state.epoch
        transactionOwner = nil
        tearDownConnection(reason: reason)
        if let interruptedEpoch {
            state = .interrupted(interruptedEpoch)
        } else {
            state = .idle
        }

        let operations = Array(inFlight.values)
        for operation in operations where !operation.terminal {
            if operation.isData,
                operation.bytesMayHaveReachedWorker,
                let epoch = operation.epoch ?? interruptedEpoch
            {
                finish(
                    operation,
                    throwing: BrokerError.outcomeUnknown(
                        epoch: epoch,
                        requestID: operation.requestID
                    )
                )
            } else if operation.isData {
                finish(operation, throwing: BrokerError.notStarted)
            } else {
                finish(
                    operation,
                    throwing: BrokerError.workerInterrupted(epoch: interruptedEpoch)
                )
            }
        }
        queue.removeAll()
        inputBudget.reset()
        // Recovery is intentionally lazy. A later open, query, checkpoint, or
        // resume operation drives interrupted -> recovering -> ready(new epoch).
    }

    private func tearDownConnection(reason: String) {
        let oldSession = controlSession
        let oldProcess = process
        currentLaunchID = nil
        ready = nil
        transactionOwner = nil
        dataChannel?.close()
        dataChannel = nil
        controlSession = nil
        process = nil
        oldSession?.cancel(reason: reason)
        oldProcess?.invalidate()
    }

    private func detachIfUnused() async {
        guard detachWhenIdle,
            handles.isEmpty,
            active == nil,
            queue.isEmpty
        else {
            return
        }
        detachWhenIdle = false
        guard let epoch = ready?.epoch,
            let launchID = currentLaunchID
        else {
            if state == .unavailable {
                state = .idle
            }
            return
        }
        state = .closing
        _ = try? await sendControl(
            IOSBrokerControlEnvelope(kind: .detach, epoch: epoch),
            expected: .detach,
            timeout: min(
                brokerConfiguration?.cancellationGracePeriod ?? .seconds(2),
                .seconds(2)
            )
        )
        guard currentLaunchID == launchID else {
            return
        }
        tearDownConnection(reason: "last logical broker handle detached")
        state = .idle
    }

    private func finish(_ operation: PendingOperation, throwing error: (any Error)? = nil) {
        guard !operation.terminal else {
            return
        }
        operation.terminal = true
        operation.deadlineTask?.cancel()
        operation.cancellationGraceTask?.cancel()
        removeFromQueue(operation)
        inputBudget.release(operation.requestID)
        inFlight.removeValue(forKey: operation.requestID)
        if let error {
            operation.continuation.resume(throwing: error)
        } else {
            operation.continuation.resume(returning: operation)
        }
    }

    private func removeFromQueue(_ operation: PendingOperation) {
        queue.removeAll { $0 === operation }
    }

    private func nextQueuedOperation() -> PendingOperation? {
        guard let transactionOwner else {
            return queue.first
        }
        // A physical PostgreSQL transaction belongs to the logical handle that
        // observed ReadyForQuery(T/E). Other callers retain FIFO position until
        // that handle observes ReadyForQuery(I). Lifecycle operations may pass
        // the pin because they do not execute caller SQL and background prepare
        // is responsible for rolling an abandoned transaction back.
        return queue.first {
            $0.handleID == transactionOwner || $0.mayBypassTransactionPin
        }
    }

    private func requireHandle(_ handleID: UUID) throws {
        guard handles.contains(handleID) else {
            throw BrokerError.databaseClosed
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
extension IOSBrokerManager {
    fileprivate struct ActiveConnection {
        let session: XPCSession
        let channel: IOSBrokerDataChannel
        let ready: BrokerReady
        let launchID: UUID
    }

    struct ResidentIdentity: Equatable, Sendable {
        let expectedABI: UInt32
        let expectedRuntimeVersion: String?
        let startupConfigurationDigest: String
        let extensionBundleIdentifier: String?
        let durability: OliphauntDurability
        let runtimeFootprint: OliphauntRuntimeFootprintProfile
        let startupGUCs: [OliphauntStartupGUC]
        let username: String?
        let database: String?
        let extensions: [String]

        init(
            broker: IOSBrokerConfiguration,
            database configuration: OliphauntConfiguration
        ) throws {
            guard configuration.mode == .nativeBroker else {
                throw OliphauntError.runtimeUnavailable(configuration.mode)
            }
            if let root = configuration.root {
                throw BrokerError.rootMismatch(
                    expected: OliphauntBrokerProtocol.canonicalRootID,
                    actual: root.absoluteString
                )
            }
            guard configuration.runtimeFootprint == .smallMobile else {
                throw BrokerError.invalidConfiguration(
                    "iOS broker v1 requires the smallMobile runtime-footprint profile"
                )
            }
            guard configuration.durability == .safe else {
                throw BrokerError.invalidConfiguration(
                    "iOS broker v1 requires safe durability"
                )
            }
            guard configuration.startupGUCs.isEmpty else {
                throw BrokerError.invalidConfiguration(
                    "iOS broker v1 does not support custom startup GUCs"
                )
            }
            guard configuration.username == nil else {
                throw BrokerError.invalidConfiguration(
                    "iOS broker v1 does not accept a caller-provided PostgreSQL username"
                )
            }
            guard configuration.database == nil || configuration.database == "postgres" else {
                throw BrokerError.invalidConfiguration(
                    "iOS broker v1 requires PostgreSQL database postgres"
                )
            }
            expectedABI = broker.expectedABI
            expectedRuntimeVersion = broker.expectedRuntimeVersion
            startupConfigurationDigest = broker.startupConfigurationDigest
            extensionBundleIdentifier = broker.extensionBundleIdentifier
            durability = configuration.durability
            runtimeFootprint = configuration.runtimeFootprint
            startupGUCs = configuration.startupGUCs
            username = configuration.username
            database = configuration.database
            extensions = configuration.extensions.sorted()
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
private final class PendingOperation: @unchecked Sendable {
    enum Kind: Sendable {
        case ensureReady
        case data(Data, @Sendable (Data) throws -> Void)
        case checkpoint
        case diagnostics
        #if DEBUG
            case injectFault(BrokerWorkerFault)
        #endif
        case prepareForBackground(Date)
        case resumeFromBackground(recovering: IOSBrokerResumeRecoveryExpectation?)
    }

    let requestID: BrokerRequestID
    let handleID: UUID
    let kind: Kind
    let queuedBytes: Int
    let continuation: CheckedContinuation<PendingOperation, any Error>
    var epoch: BrokerEpoch?
    var bytesMayHaveReachedWorker = false
    var deadlineCancellationRequested = false
    var terminal = false
    var deadlineTask: Task<Void, Never>?
    var cancellationGraceTask: Task<Void, Never>?
    var backgroundResult: OliphauntBackgroundPreparationResult?
    var workerDiagnostics: IOSBrokerWorkerDiagnostics?

    init(
        requestID: BrokerRequestID,
        handleID: UUID,
        kind: Kind,
        queuedBytes: Int,
        continuation: CheckedContinuation<PendingOperation, any Error>
    ) {
        self.requestID = requestID
        self.handleID = handleID
        self.kind = kind
        self.queuedBytes = queuedBytes
        self.continuation = continuation
    }

    var isData: Bool {
        if case .data = kind { return true }
        return false
    }

    var isBackgroundPreparation: Bool {
        if case .prepareForBackground = kind { return true }
        return false
    }

    var mayBypassTransactionPin: Bool {
        switch kind {
        case .ensureReady, .diagnostics, .prepareForBackground, .resumeFromBackground:
            true
        #if DEBUG
            case .injectFault:
                true
        #endif
        case .data, .checkpoint:
            false
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
private final class IOSBrokerInterruptionRelay: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: (@Sendable () -> Void)?
    private var signalled = false

    func install(_ handler: @escaping @Sendable () -> Void) {
        lock.lock()
        self.handler = handler
        let shouldSignal = signalled
        lock.unlock()
        if shouldSignal {
            handler()
        }
    }

    func signal() {
        lock.lock()
        signalled = true
        let handler = handler
        lock.unlock()
        handler?()
    }
}

@available(iOS 26.0, macOS 26.0, *)
private final class XPCReplyGate: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private let continuation: CheckedContinuation<IOSBrokerXPCReply, any Error>

    init(continuation: CheckedContinuation<IOSBrokerXPCReply, any Error>) {
        self.continuation = continuation
    }

    func succeed(_ dictionary: XPCDictionary) {
        guard claim() else { return }
        continuation.resume(returning: IOSBrokerXPCReply(dictionary))
    }

    func fail(_ error: BrokerError) {
        guard claim() else { return }
        continuation.resume(throwing: error)
    }

    private func claim() -> Bool {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return false
        }
        finished = true
        lock.unlock()
        return true
    }
}

@available(iOS 26.0, macOS 26.0, *)
private final class IOSBrokerXPCReply: @unchecked Sendable {
    let dictionary: XPCDictionary

    init(_ dictionary: XPCDictionary) {
        self.dictionary = dictionary
    }
}

extension Duration {
    fileprivate var timeInterval: TimeInterval {
        let components = self.components
        return TimeInterval(components.seconds) + TimeInterval(components.attoseconds)
            / 1_000_000_000_000_000_000
    }
}

extension Date {
    fileprivate var unixNanoseconds: UInt64 {
        let value = timeIntervalSince1970 * 1_000_000_000
        guard value.isFinite, value > 0 else {
            return 0
        }
        return UInt64(min(value, Double(UInt64.max)))
    }
}
