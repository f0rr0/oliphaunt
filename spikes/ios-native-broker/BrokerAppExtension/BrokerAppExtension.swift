import Darwin
import Dispatch
import ExtensionFoundation
import Foundation
import OliphauntBrokerExtension
import OliphauntBrokerProtocol
import OliphauntBrokerXPC
import XPC
import os

@main
struct BrokerAppExtension: AppExtension {
    @AppExtensionPoint.Bind
    var extensionPoint: AppExtensionPoint {
        AppExtensionPoint.Identifier(
            host: "dev.oliphaunt.brokerspike",
            name: "OliphauntBroker"
        )
    }

    init() {}

    var configuration: ConnectionHandler {
        ConnectionHandler { request in
            let sessionID = UUID()
            return request.accept(
                incomingMessageHandler: { message in
                    BrokerExtensionServer.shared.handle(message, sessionID: sessionID)
                },
                cancellationHandler: { _ in
                    BrokerExtensionServer.shared.cancelSession(sessionID)
                }
            )
        }
    }
}

/// Production control-plane glue for the simulator fixture. PostgreSQL bytes
/// stay on BrokerSocketWorker's owned socket; XPC carries primitives only.
private final class BrokerExtensionServer: @unchecked Sendable {
    private struct PendingHello {
        var token: UUID
        var sessionID: UUID
        var cancelled: Bool
    }

    private struct ActiveChannel {
        var token: UUID
        var sessionID: UUID
        var worker: BrokerSocketWorker
        var task: Task<Void, Never>?
    }

    private struct CheckpointMemoryEvidence: Sendable {
        var epoch: BrokerEpoch
        var sequence: UInt64
        var startedAtUptimeNanoseconds: UInt64
        var sampledAtUptimeNanoseconds: UInt64
        var completedAtUptimeNanoseconds: UInt64
        var memory: BrokerProcessMemorySnapshot
    }

    static let shared = BrokerExtensionServer()

    private static let liboliphauntVersion = "0.1.1"
    private static let startupConfigurationDigest =
        "ios-native-broker-spike-v2-restricted-role"
    private static let selectedPostgresExtensions = ["pg_trgm", "vector"]

    // These strings are also public constants in IOSBrokerXPC. Keep the
    // extension independent of any host-only diagnostics model.
    private enum DiagnosticsKey {
        static let state = "state"
        static let manifestDigest = "manifestDigest"
        static let activeRequestID = "activeRequestID"
        static let nativeDispatchStarted = "nativeDispatchStarted"
        static let transactionStatus = "transactionStatus"
        static let capabilities = "capabilities"
        static let currentPhysFootprintBytes = "currentPhysFootprintBytes"
        static let currentResidentBytes = "currentResidentBytes"
        static let availableMemoryBytes = "availableMemoryBytes"
        static let checkpointInProgress = "checkpointInProgress"
        static let checkpointMemorySampleSequence = "checkpointMemorySampleSequence"
        static let checkpointMemorySampleStartedAtUptimeNanoseconds =
            "checkpointMemorySampleStartedAtUptimeNanoseconds"
        static let checkpointMemorySampledAtUptimeNanoseconds =
            "checkpointMemorySampledAtUptimeNanoseconds"
        static let checkpointMemorySampleCompletedAtUptimeNanoseconds =
            "checkpointMemorySampleCompletedAtUptimeNanoseconds"
        static let checkpointMemorySamplePhysFootprintBytes =
            "checkpointMemorySamplePhysFootprintBytes"
        static let checkpointMemorySampleResidentBytes =
            "checkpointMemorySampleResidentBytes"
        static let checkpointMemorySampleAvailableMemoryBytes =
            "checkpointMemorySampleAvailableMemoryBytes"
        static let storageProtectionEvidenceJSON = "storageProtectionEvidenceJSON"
        static let extensionEntryPreOpenPhysFootprintBytes =
            "extensionEntryPreOpenPhysFootprintBytes"
        static let extensionEntryPreOpenResidentBytes =
            "extensionEntryPreOpenResidentBytes"
        static let openedIdlePhysFootprintBytes = "openedIdlePhysFootprintBytes"
        static let openedIdleResidentBytes = "openedIdleResidentBytes"
    }

    private let lock = NSLock()
    private var core: WorkerCore?
    private var pendingHello: PendingHello?
    private var activeChannel: ActiveChannel?
    private var extensionEntryPreOpenMemory: BrokerProcessMemorySnapshot?
    private var openedIdleMemory: BrokerProcessMemorySnapshot?
    private var checkpointInProgress = false
    private var checkpointMemorySampleSequence: UInt64 = 0
    private var checkpointMemoryEvidence: CheckpointMemoryEvidence?
    private var storageProtectionEvidenceJSON: String?

    func handle(_ message: XPCDictionary, sessionID: UUID) -> XPCDictionary? {
        do {
            switch try IOSBrokerXPC.messageKind(in: message) {
            case .hello:
                return try acceptHello(message, sessionID: sessionID)
            case .cancel:
                return try cancel(message)
            case .checkpoint:
                return try checkpoint(message)
            case .prepareForBackground:
                return try prepareForBackground(message)
            case .resumeFromBackground:
                return try resumeFromBackground(message)
            case .detach:
                return try detach(message, sessionID: sessionID)
            case .diagnostics:
                return try diagnostics(message)
            case .injectFault:
                return try injectFault(message)
            case .attachDataChannel:
                throw BrokerError.protocolViolation(
                    "v1 attaches its data-channel descriptor in Hello"
                )
            case .ready, .rejected, .cancelObserved:
                throw BrokerError.protocolViolation(
                    "host sent an extension-only control message"
                )
            }
        } catch {
            return rejection(error)
        }
    }

    /// The XPC session interruption path never waits for WorkerCore's actor.
    /// It closes the socket immediately, sends native cancellation directly,
    /// then marks the epoch interrupted in detached cleanup work.
    func cancelSession(_ sessionID: UUID) {
        let interruption: (WorkerCore, BrokerSocketWorker?)? = lock.withExtensionLock {
            if pendingHello?.sessionID == sessionID {
                pendingHello?.cancelled = true
            }
            guard let core else { return nil }
            if let channel = activeChannel, channel.sessionID == sessionID {
                return (core, channel.worker)
            }
            if pendingHello?.sessionID == sessionID {
                return (core, nil)
            }
            return nil
        }
        guard let (core, worker) = interruption else { return }
        worker?.stop()
        let activeRequest = core.cancellationController.activeRequest
        Task.detached(priority: .userInitiated) {
            if let activeRequest {
                _ = try? await core.cancellationController.requestCancellation(
                    epoch: activeRequest.epoch,
                    requestID: activeRequest.requestID
                )
            }
            await core.interruptCurrentEpoch()
        }
    }

    private func acceptHello(
        _ message: XPCDictionary,
        sessionID: UUID
    ) throws -> XPCDictionary {
        let decoded = try IOSBrokerXPC.decodeHello(message)
        let token = UUID()
        try reserveHello(token: token, sessionID: sessionID)

        var didStartCore = false
        do {
            let core = try workerCore()
            // liboliphaunt is directly linked, so dyld has already mapped it at
            // extension entry. This is a pre-open baseline, not a pre-load one.
            let extensionEntryPreOpen = BrokerProcessMemorySnapshot.current()
            lock.withExtensionLock {
                extensionEntryPreOpenMemory = extensionEntryPreOpen
                storageProtectionEvidenceJSON = nil
            }

            let ready = try waitForAsync {
                try await core.start(hello: decoded.hello)
            }
            didStartCore = true
            let openedIdle = BrokerProcessMemorySnapshot.current()
            lock.withExtensionLock {
                openedIdleMemory = openedIdle
            }

            let descriptor = try decoded.dataChannel.takeDescriptor()
            let worker = try BrokerSocketWorker(
                ownedFileDescriptor: descriptor,
                core: core,
                epoch: ready.epoch,
                protocolVersion: ready.selectedProtocolVersion
            )
            try installChannel(
                token: token,
                sessionID: sessionID,
                worker: worker
            )

            let task = Task.detached(priority: .userInitiated) { [weak self] in
                _ = try? await worker.run()
                self?.channelFinished(token: token)
            }
            lock.withExtensionLock {
                guard activeChannel?.token == token else {
                    task.cancel()
                    worker.stop()
                    return
                }
                activeChannel?.task = task
            }
            return try IOSBrokerXPC.makeReady(ready)
        } catch {
            decoded.dataChannel.close()
            clearPendingHello(token: token)
            if didStartCore, let core = lock.withExtensionLock({ self.core }) {
                Task.detached {
                    await core.interruptCurrentEpoch()
                }
            }
            throw error
        }
    }

    private func cancel(_ message: XPCDictionary) throws -> XPCDictionary {
        let envelope = try IOSBrokerXPC.decodeControl(message)
        guard envelope.kind == .cancel,
            let epoch = envelope.epoch,
            let requestID = envelope.requestID
        else {
            throw BrokerError.protocolViolation("Cancel requires epoch and request ID")
        }
        let core = try currentCore()

        // This is deliberately the first call: no WorkerCore hop precedes the
        // native cancellation witness.
        let direct = try waitForAsync {
            try await core.cancellationController.requestCancellation(
                epoch: epoch,
                requestID: requestID
            )
        }
        switch direct {
        case .signalSent, .alreadyRequested:
            // The native signal is already in flight. Record the lifecycle
            // transition without delaying this control-plane acknowledgement.
            Task.detached(priority: .userInitiated) {
                _ = try? await core.cancelRequest(
                    epoch: epoch,
                    requestID: requestID
                )
            }
            return IOSBrokerXPC.makeAcknowledgement(.cancel)
        case .notRunning:
            let disposition = try waitForAsync {
                try await core.cancelRequest(epoch: epoch, requestID: requestID)
            }
            switch disposition {
            case .canceledBeforeNativeDispatch:
                return IOSBrokerXPC.makeAcknowledgement(.cancelObserved)
            case .notCurrent, .nativeSignal:
                // Cancellation is idempotent. Backend observation, when there
                // is a running request, is also reported on the data plane.
                return IOSBrokerXPC.makeAcknowledgement(.cancel)
            }
        }
    }

    private func checkpoint(_ message: XPCDictionary) throws -> XPCDictionary {
        let (core, _, expectedEpoch) = try controlCore(message, expected: .checkpoint)
        let checkpointStart = lock.withExtensionLock {
            () -> (sequence: UInt64, uptimeNanoseconds: UInt64) in
            checkpointMemorySampleSequence += 1
            checkpointInProgress = true
            return (
                checkpointMemorySampleSequence,
                DispatchTime.now().uptimeNanoseconds
            )
        }
        let checkpointMemory = BrokerProcessMemorySnapshot.current()
        let checkpointSampledAt = DispatchTime.now().uptimeNanoseconds
        defer { lock.withExtensionLock { checkpointInProgress = false } }
        try waitForAsync {
            try await core.checkpoint(expectedEpoch: expectedEpoch)
        }
        let checkpointCompletedAt = DispatchTime.now().uptimeNanoseconds
        lock.withExtensionLock {
            checkpointMemoryEvidence = CheckpointMemoryEvidence(
                epoch: expectedEpoch,
                sequence: checkpointStart.sequence,
                startedAtUptimeNanoseconds: checkpointStart.uptimeNanoseconds,
                sampledAtUptimeNanoseconds: checkpointSampledAt,
                completedAtUptimeNanoseconds: checkpointCompletedAt,
                memory: checkpointMemory
            )
        }
        return IOSBrokerXPC.makeAcknowledgement(.checkpoint)
    }

    private func prepareForBackground(
        _ message: XPCDictionary
    ) throws -> XPCDictionary {
        let (core, envelope, expectedEpoch) = try controlCore(
            message,
            expected: .prepareForBackground
        )
        guard let nanoseconds = envelope.deadlineUnixNanoseconds else {
            throw BrokerError.protocolViolation(
                "PrepareForBackground requires an absolute deadline"
            )
        }
        let deadline = Date(
            timeIntervalSince1970: TimeInterval(nanoseconds) / 1_000_000_000
        )
        let result = try waitForAsync {
            try await core.prepareForBackground(
                expectedEpoch: expectedEpoch,
                deadline: deadline
            )
        }
        if let diagnostics = try? waitForAsync({
            try await core.diagnostics(expectedEpoch: expectedEpoch)
        }), diagnostics.state == .quiescing,
            let encoded = try? encodeProtectionEvidence(rootURL: diagnostics.rootURL)
        {
            lock.withExtensionLock {
                storageProtectionEvidenceJSON = encoded
            }
        }
        var reply = IOSBrokerXPC.makeAcknowledgement(.prepareForBackground)
        reply[IOSBrokerXPC.cancelledActiveWorkKey] = result.cancelledActiveWork
        reply[IOSBrokerXPC.checkpointedKey] = result.checkpointed
        return reply
    }

    private func resumeFromBackground(
        _ message: XPCDictionary
    ) throws -> XPCDictionary {
        let (core, _, expectedEpoch) = try controlCore(
            message,
            expected: .resumeFromBackground
        )
        try waitForAsync {
            try await core.resumeFromBackground(expectedEpoch: expectedEpoch)
        }
        return IOSBrokerXPC.makeAcknowledgement(.resumeFromBackground)
    }

    private func detach(
        _ message: XPCDictionary,
        sessionID: UUID
    ) throws -> XPCDictionary {
        let (core, _, expectedEpoch) = try controlCore(message, expected: .detach)
        let worker = lock.withExtensionLock { () -> BrokerSocketWorker? in
            guard activeChannel?.sessionID == sessionID else { return nil }
            return activeChannel?.worker
        }
        try waitForAsync {
            try await core.detach(expectedEpoch: expectedEpoch)
        }
        worker?.stopGracefully()
        return IOSBrokerXPC.makeAcknowledgement(.detach)
    }

    private func diagnostics(_ message: XPCDictionary) throws -> XPCDictionary {
        let currentMemory = BrokerProcessMemorySnapshot.current()
        let (core, _, expectedEpoch) = try controlCore(message, expected: .diagnostics)
        let value = try waitForAsync {
            try await core.diagnostics(expectedEpoch: expectedEpoch)
        }
        let phaseState = lock.withExtensionLock {
            (
                extensionEntryPreOpen: extensionEntryPreOpenMemory,
                openedIdle: openedIdleMemory,
                checkpointInProgress: checkpointInProgress,
                checkpointMemoryEvidence: checkpointMemoryEvidence,
                storageProtectionEvidenceJSON: storageProtectionEvidenceJSON
            )
        }

        var reply = IOSBrokerXPC.makeAcknowledgement(.diagnostics)
        reply[DiagnosticsKey.state] = stateName(value.state)
        reply[BrokerControlKey.epoch] = value.epoch.description
        reply[BrokerControlKey.extensionPID] = Int64(value.processID)
        if let digest = value.manifestDigest {
            reply[DiagnosticsKey.manifestDigest] = digest
        }
        if let requestID = value.activeRequestID {
            reply[DiagnosticsKey.activeRequestID] = requestID.rawValue
        }
        reply[DiagnosticsKey.nativeDispatchStarted] = value.nativeDispatchStarted
        reply[DiagnosticsKey.transactionStatus] = value.transactionStatus
        reply[DiagnosticsKey.capabilities] = try encodedCapabilities(value.capabilities)
        reply[DiagnosticsKey.currentPhysFootprintBytes] = currentMemory.physFootprintBytes
        reply[DiagnosticsKey.currentResidentBytes] = currentMemory.residentBytes
        reply[DiagnosticsKey.availableMemoryBytes] = currentMemory.availableMemoryBytes
        reply[DiagnosticsKey.checkpointInProgress] = phaseState.checkpointInProgress
        if let evidence = phaseState.checkpointMemoryEvidence,
            evidence.epoch == value.epoch
        {
            reply[DiagnosticsKey.checkpointMemorySampleSequence] = evidence.sequence
            reply[DiagnosticsKey.checkpointMemorySampleStartedAtUptimeNanoseconds] =
                evidence.startedAtUptimeNanoseconds
            reply[DiagnosticsKey.checkpointMemorySampledAtUptimeNanoseconds] =
                evidence.sampledAtUptimeNanoseconds
            reply[DiagnosticsKey.checkpointMemorySampleCompletedAtUptimeNanoseconds] =
                evidence.completedAtUptimeNanoseconds
            reply[DiagnosticsKey.checkpointMemorySamplePhysFootprintBytes] =
                evidence.memory.physFootprintBytes
            reply[DiagnosticsKey.checkpointMemorySampleResidentBytes] =
                evidence.memory.residentBytes
            reply[DiagnosticsKey.checkpointMemorySampleAvailableMemoryBytes] =
                evidence.memory.availableMemoryBytes
        }
        if let protection = phaseState.storageProtectionEvidenceJSON {
            reply[DiagnosticsKey.storageProtectionEvidenceJSON] = protection
        }
        if let before = phaseState.extensionEntryPreOpen {
            reply[DiagnosticsKey.extensionEntryPreOpenPhysFootprintBytes] =
                before.physFootprintBytes
            reply[DiagnosticsKey.extensionEntryPreOpenResidentBytes] = before.residentBytes
        }
        if let opened = phaseState.openedIdle {
            reply[DiagnosticsKey.openedIdlePhysFootprintBytes] =
                opened.physFootprintBytes
            reply[DiagnosticsKey.openedIdleResidentBytes] = opened.residentBytes
        }
        return reply
    }

    private func injectFault(_ message: XPCDictionary) throws -> XPCDictionary {
        let (core, envelope, expectedEpoch) = try controlCore(
            message,
            expected: .injectFault
        )
        guard let fault = envelope.fault else {
            throw BrokerError.protocolViolation("InjectFault requires a fault name")
        }
        #if DEBUG
            try waitForAsync {
                try await core.injectFault(fault, expectedEpoch: expectedEpoch)
            }
            return IOSBrokerXPC.makeAcknowledgement(.injectFault)
        #else
            _ = core
            _ = fault
            throw BrokerError.rejected(
                .invalidRequest("fault injection is unavailable in release builds")
            )
        #endif
    }

    private func controlCore(
        _ message: XPCDictionary,
        expected: BrokerControlMessageKind
    ) throws -> (WorkerCore, IOSBrokerControlEnvelope, BrokerEpoch) {
        let envelope = try IOSBrokerXPC.decodeControl(message)
        guard envelope.kind == expected, let requestedEpoch = envelope.epoch else {
            throw BrokerError.protocolViolation(
                "\(expected.rawValue) requires the current epoch"
            )
        }
        let core = try currentCore()
        return (core, envelope, requestedEpoch)
    }

    private func workerCore() throws -> WorkerCore {
        if let existing = lock.withExtensionLock({ core }) {
            return existing
        }
        let storage: BrokerExtensionStorage
        do {
            storage = try BrokerExtensionStorage.extensionPrivate()
        } catch {
            throw BrokerError.rejected(.rootOpen)
        }
        let configuration: BrokerWorkerConfiguration
        do {
            configuration = try BrokerWorkerConfiguration.nativeDirect(
                storage: storage,
                liboliphauntVersion: Self.liboliphauntVersion,
                startupConfigurationDigest: Self.startupConfigurationDigest,
                selectedPostgresExtensions: Self.selectedPostgresExtensions
            )
        } catch {
            throw BrokerError.brokerUnavailable
        }
        let created = WorkerCore(configuration: configuration)
        return lock.withExtensionLock {
            if let existing = core { return existing }
            core = created
            return created
        }
    }

    private func currentCore() throws -> WorkerCore {
        guard let core = lock.withExtensionLock({ core }) else {
            throw BrokerError.brokerUnavailable
        }
        return core
    }

    private func reserveHello(token: UUID, sessionID: UUID) throws {
        try lock.withExtensionLock {
            guard pendingHello == nil, activeChannel == nil else {
                throw BrokerError.rejected(
                    .invalidRequest("a broker data channel is already active")
                )
            }
            pendingHello = PendingHello(
                token: token,
                sessionID: sessionID,
                cancelled: false
            )
        }
    }

    private func installChannel(
        token: UUID,
        sessionID: UUID,
        worker: BrokerSocketWorker
    ) throws {
        try lock.withExtensionLock {
            guard let pendingHello,
                pendingHello.token == token,
                pendingHello.sessionID == sessionID,
                !pendingHello.cancelled,
                activeChannel == nil
            else {
                throw BrokerError.workerInterrupted(epoch: nil)
            }
            self.pendingHello = nil
            activeChannel = ActiveChannel(
                token: token,
                sessionID: sessionID,
                worker: worker,
                task: nil
            )
        }
    }

    private func clearPendingHello(token: UUID) {
        lock.withExtensionLock {
            guard pendingHello?.token == token else { return }
            pendingHello = nil
        }
    }

    private func channelFinished(token: UUID) {
        lock.withExtensionLock {
            guard activeChannel?.token == token else { return }
            activeChannel = nil
        }
    }

    private func rejection(_ error: Error) -> XPCDictionary {
        let brokerError = IOSBrokerXPC.extensionBoundaryError(error)
        if let encoded = try? IOSBrokerXPC.makeError(brokerError) {
            return encoded
        }
        var fallback = XPCDictionary()
        fallback[BrokerControlKey.message] = BrokerControlMessageKind.rejected.rawValue
        fallback[BrokerControlKey.reason] = brokerError.description
        return fallback
    }
}

private func encodeProtectionEvidence(rootURL: URL) throws -> String {
    let storage = try BrokerExtensionStorage(
        location: .extensionPrivate,
        rootURL: rootURL
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(storage.recursiveProtectionEvidence())
    guard let value = String(data: data, encoding: .utf8) else {
        throw BrokerError.protocolViolation("cannot encode storage-protection evidence")
    }
    return value
}

private struct BrokerProcessMemorySnapshot: Sendable {
    var physFootprintBytes: UInt64
    var residentBytes: UInt64
    var availableMemoryBytes: UInt64

    /// Samples this extension process directly and does not enter WorkerCore.
    static func current() -> BrokerProcessMemorySnapshot {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
        )
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(
                to: integer_t.self,
                capacity: Int(count)
            ) { rebound in
                task_info(
                    mach_task_self_,
                    task_flavor_t(TASK_VM_INFO),
                    rebound,
                    &count
                )
            }
        }
        guard result == KERN_SUCCESS else {
            return BrokerProcessMemorySnapshot(
                physFootprintBytes: 0,
                residentBytes: 0,
                availableMemoryBytes: UInt64(os_proc_available_memory())
            )
        }
        return BrokerProcessMemorySnapshot(
            physFootprintBytes: UInt64(info.phys_footprint),
            residentBytes: UInt64(info.resident_size),
            availableMemoryBytes: UInt64(os_proc_available_memory())
        )
    }
}

private final class BrokerBlockingResult<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Value, Error>?

    func set(_ result: Result<Value, Error>) {
        lock.withExtensionLock { self.result = result }
    }

    func take() -> Result<Value, Error> {
        lock.withExtensionLock {
            precondition(result != nil)
            return result!
        }
    }
}

private func waitForAsync<Value: Sendable>(
    _ operation: @escaping @Sendable () async throws -> Value
) throws -> Value {
    let semaphore = DispatchSemaphore(value: 0)
    let result = BrokerBlockingResult<Value>()
    Task.detached {
        do {
            result.set(.success(try await operation()))
        } catch {
            result.set(.failure(error))
        }
        semaphore.signal()
    }
    semaphore.wait()
    return try result.take().get()
}

private func encodedCapabilities(_ value: BrokerCapabilities) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
}

private func stateName(_ state: BrokerWorkerCoreState) -> String {
    switch state {
    case .created: "created"
    case .starting: "starting"
    case .ready: "ready"
    case .quiescing: "quiescing"
    case .interrupted: "interrupted"
    case .detached: "detached"
    case .failed: "failed"
    }
}

extension NSLock {
    @discardableResult
    fileprivate func withExtensionLock<Result>(_ body: () throws -> Result) rethrows -> Result {
        lock()
        defer { unlock() }
        return try body()
    }
}
