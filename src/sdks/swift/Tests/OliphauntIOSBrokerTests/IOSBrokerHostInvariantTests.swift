import Darwin
import Foundation
import Oliphaunt
import OliphauntBrokerProtocol
import OliphauntBrokerXPC
import Testing

@testable import OliphauntIOSBroker

@Test
func workerDiagnosticsMapsRetainedCheckpointMemoryEvidence() {
    let epoch = BrokerEpoch.fresh()
    let wire = IOSBrokerWireDiagnostics(
        state: "ready",
        epoch: epoch,
        extensionProcessIdentifier: 42,
        manifestDigest: "manifest",
        activeRequestID: nil,
        nativeDispatchStarted: false,
        transactionStatus: "idle",
        capabilities: BrokerCapabilities(),
        currentPhysFootprintBytes: 10,
        currentResidentBytes: 20,
        availableMemoryBytes: 30,
        checkpointInProgress: false,
        checkpointMemorySample: IOSBrokerWireCheckpointMemorySample(
            sequence: 7,
            startedAtUptimeNanoseconds: 100,
            sampledAtUptimeNanoseconds: 110,
            completedAtUptimeNanoseconds: 120,
            physFootprintBytes: 1_024,
            residentBytes: 2_048,
            availableMemoryBytes: 4_096
        ),
        storageProtectionEvidenceJSON: nil,
        extensionEntryPreOpenPhysFootprintBytes: 40,
        extensionEntryPreOpenResidentBytes: 50,
        openedIdlePhysFootprintBytes: 60,
        openedIdleResidentBytes: 70
    )

    let diagnostics = IOSBrokerWorkerDiagnostics(wire: wire)
    #expect(diagnostics.epoch == epoch)
    #expect(
        diagnostics.checkpointMemorySample
            == IOSBrokerCheckpointMemorySample(
                sequence: 7,
                startedAtUptimeNanoseconds: 100,
                sampledAtUptimeNanoseconds: 110,
                completedAtUptimeNanoseconds: 120,
                physFootprintBytes: 1_024,
                residentBytes: 2_048,
                availableMemoryBytes: 4_096
            )
    )
    #expect(!diagnostics.checkpointInProgress)
}

@Test
func completedWithoutTerminalReadyForQueryIsAProtocolViolation() async throws {
    let sockets = try IOSBrokerSocketPair.make()
    defer { sockets.host.close() }

    let workerDescriptor = try sockets.extensionEndpoint.takeDescriptor()
    let epoch = BrokerEpoch.fresh()
    let requestID = try BrokerRequestID(validating: 17)
    let worker = Task.detached {
        defer { Darwin.close(workerDescriptor) }
        try makeBlocking(workerDescriptor)
        while true {
            let header = try readFrameHeader(workerDescriptor, epoch: epoch)
            _ = try readExactly(workerDescriptor, count: Int(header.payloadLength))
            if header.frameType == .requestEnd {
                break
            }
        }

        let commandComplete = backendMessage(type: 0x43, body: Data("SELECT 1\0".utf8))
        try writeAll(
            try BrokerFrame(
                frameType: .responseBytes,
                epoch: epoch,
                requestID: requestID.rawValue,
                payload: commandComplete
            ).encoded(),
            to: workerDescriptor
        )
        try writeAll(
            try BrokerFrame(
                frameType: .completed,
                epoch: epoch,
                requestID: requestID.rawValue
            ).encoded(),
            to: workerDescriptor
        )
    }

    do {
        _ = try await sockets.host.execute(
            requestID: requestID,
            epoch: epoch,
            protocolVersion: OliphauntBrokerProtocol.maximumVersion,
            bytes: simpleQuery("SELECT 1"),
            maximumRequestBytes: 1024,
            onChunk: { _ in }
        )
        Issue.record("Completed without ReadyForQuery must not be accepted")
    } catch let failure as IOSBrokerDataPlaneFailure {
        switch failure {
        case .protocolViolation(let message):
            #expect(message.contains("without a terminal ReadyForQuery"))
        default:
            Issue.record("expected protocolViolation, got \(failure)")
        }
    }
    try await worker.value
}

@Test
func socketCloseDuringResponseIsOutcomeUnknownAfterPartialDelivery() async throws {
    let sockets = try IOSBrokerSocketPair.make()
    defer { sockets.host.close() }

    let workerDescriptor = try sockets.extensionEndpoint.takeDescriptor()
    let epoch = BrokerEpoch.fresh()
    let requestID = try BrokerRequestID(validating: 18)
    let worker = Task.detached {
        defer { Darwin.close(workerDescriptor) }
        try makeBlocking(workerDescriptor)
        while true {
            let header = try readFrameHeader(workerDescriptor, epoch: epoch)
            _ = try readExactly(workerDescriptor, count: Int(header.payloadLength))
            if header.frameType == .requestEnd {
                break
            }
        }

        let partial = backendMessage(type: 0x43, body: Data("SELECT 1\0".utf8))
        try writeAll(
            try BrokerFrame(
                frameType: .responseBytes,
                epoch: epoch,
                requestID: requestID.rawValue,
                payload: partial
            ).encoded(),
            to: workerDescriptor
        )
        // Closing without Completed makes the already-dispatched result
        // ambiguous even though the streaming consumer observed bytes.
    }
    let observed = LockedChunkAccumulator()

    do {
        _ = try await sockets.host.execute(
            requestID: requestID,
            epoch: epoch,
            protocolVersion: OliphauntBrokerProtocol.maximumVersion,
            bytes: simpleQuery("SELECT 1"),
            maximumRequestBytes: 1024,
            onChunk: { observed.append($0) }
        )
        Issue.record("socket EOF during a response must be OutcomeUnknown")
    } catch let failure as IOSBrokerDataPlaneFailure {
        guard case .outcomeUnknown = failure else {
            Issue.record("expected outcomeUnknown, got \(failure)")
            try await worker.value
            return
        }
    }
    #expect(observed.byteCount > 0)
    try await worker.value
}

@Test
func rawResponseLimitAfterDispatchIsBoundedAndOutcomeUnknown() async throws {
    let sockets = try IOSBrokerSocketPair.make()
    defer { sockets.host.close() }

    let workerDescriptor = try sockets.extensionEndpoint.takeDescriptor()
    let epoch = BrokerEpoch.fresh()
    let requestID = try BrokerRequestID(validating: 20)
    let worker = Task.detached {
        defer { Darwin.close(workerDescriptor) }
        try makeBlocking(workerDescriptor)
        while true {
            let header = try readFrameHeader(workerDescriptor, epoch: epoch)
            _ = try readExactly(workerDescriptor, count: Int(header.payloadLength))
            if header.frameType == .requestEnd {
                break
            }
        }

        try writeAll(
            try BrokerFrame(
                frameType: .responseBytes,
                epoch: epoch,
                requestID: requestID.rawValue,
                payload: backendMessage(type: 0x43, body: Data("SELECT 1\0".utf8))
            ).encoded(),
            to: workerDescriptor
        )
    }
    let collector = IOSBrokerResponseCollector(maximumBytes: 8)

    do {
        _ = try await sockets.host.execute(
            requestID: requestID,
            epoch: epoch,
            protocolVersion: OliphauntBrokerProtocol.maximumVersion,
            bytes: simpleQuery("SELECT 1"),
            maximumRequestBytes: 1024,
            onChunk: { try collector.append($0) }
        )
        Issue.record("an over-limit raw response unexpectedly completed")
    } catch let failure as IOSBrokerDataPlaneFailure {
        guard case .outcomeUnknown = failure else {
            Issue.record("expected outcomeUnknown, got \(failure)")
            try await worker.value
            return
        }
    }
    #expect(collector.value.isEmpty)
    try await worker.value
}

@Test
func socketCloseDuringUploadIsOutcomeUnknown() async throws {
    let sockets = try IOSBrokerSocketPair.make()
    defer { sockets.host.close() }

    let workerDescriptor = try sockets.extensionEndpoint.takeDescriptor()
    let epoch = BrokerEpoch.fresh()
    let requestID = try BrokerRequestID(validating: 19)
    let worker = Task.detached {
        defer { Darwin.close(workerDescriptor) }
        try makeBlocking(workerDescriptor)
        let header = try readFrameHeader(workerDescriptor, epoch: epoch)
        #expect(header.frameType == .requestBegin)
        _ = try readExactly(workerDescriptor, count: Int(header.payloadLength))
        // The peer disappears after admission but before the complete frontend
        // request is known to have arrived. The host must never call this safe
        // to replay.
    }
    let largeRequest = simpleQuery(
        "SELECT '" + String(repeating: "u", count: 2 * 1024 * 1024) + "'")

    do {
        _ = try await sockets.host.execute(
            requestID: requestID,
            epoch: epoch,
            protocolVersion: OliphauntBrokerProtocol.maximumVersion,
            bytes: largeRequest,
            maximumRequestBytes: 3 * 1024 * 1024,
            onChunk: { _ in }
        )
        Issue.record("socket loss during request upload must be OutcomeUnknown")
    } catch let failure as IOSBrokerDataPlaneFailure {
        guard case .outcomeUnknown = failure else {
            Issue.record("expected outcomeUnknown, got \(failure)")
            try await worker.value
            return
        }
    }
    try await worker.value
}

@Test
func ownedDescriptorTransferAndCloseAreExactlyOnce() throws {
    var descriptors: [Int32] = [-1, -1]
    #expect(pipe(&descriptors) == 0)
    defer { Darwin.close(descriptors[1]) }

    let owned = try IOSBrokerOwnedFileDescriptor(takingOwnershipOf: descriptors[0])
    #expect(owned.isOpen)
    let transferred = try owned.takeDescriptor()
    #expect(!owned.isOpen)
    #expect(!owned.close())
    do {
        _ = try owned.borrowedDescriptor()
        Issue.record("a transferred descriptor remained borrowable")
    } catch let error as POSIXError {
        #expect(error.code == .EBADF)
    }
    #expect(Darwin.close(transferred) == 0)
    #expect(!owned.close())
}

@Test
func readyForQueryMustBeTheTerminalBackendMessage() throws {
    var valid = IOSBrokerBackendResponseObserver()
    try valid.append(backendMessage(type: 0x43, body: Data("SELECT 1\0".utf8)))
    try valid.append(backendMessage(type: 0x5A, body: Data([0x49])))
    #expect(try valid.finish() == .idle)

    var followedByAnotherMessage = IOSBrokerBackendResponseObserver()
    try followedByAnotherMessage.append(backendMessage(type: 0x5A, body: Data([0x49])))
    try followedByAnotherMessage.append(backendMessage(type: 0x4E, body: Data()))
    do {
        _ = try followedByAnotherMessage.finish()
        Issue.record("ReadyForQuery followed by another message must not be terminal")
    } catch let failure as IOSBrokerDataPlaneFailure {
        switch failure {
        case .protocolViolation(let message):
            #expect(message.contains("without a terminal ReadyForQuery"))
        default:
            Issue.record("expected protocolViolation, got \(failure)")
        }
    }
}

@Test
func activeAndQueuedRequestsShareTheAggregateInputBudget() throws {
    var budget = IOSBrokerInputBudget(maximumBytes: 8)
    let active = try BrokerRequestID(validating: 1)
    let queued = try BrokerRequestID(validating: 2)
    let rejected = try BrokerRequestID(validating: 3)

    let admittedActive = budget.reserve(5, for: active)
    #expect(admittedActive)
    budget.activate(active)
    #expect(budget.state(for: active) == .active)
    #expect(budget.accountedBytes == 5)

    let admittedQueued = budget.reserve(3, for: queued)
    #expect(admittedQueued)
    #expect(budget.state(for: queued) == .queued)
    #expect(budget.accountedBytes == 8)
    let rejectedWhileFull = budget.reserve(1, for: rejected)
    #expect(!rejectedWhileFull)

    budget.release(active)
    #expect(budget.accountedBytes == 3)
    let admittedAfterTerminal = budget.reserve(1, for: rejected)
    #expect(admittedAfterTerminal)
    #expect(budget.accountedBytes == 4)
}

@Test
func resumeRecoveryRetriesWorkerInterruptionExactlyOnce() throws {
    let staleEpoch = BrokerEpoch.fresh()
    var policy = IOSBrokerResumeRetryPolicy()

    let firstRetry = policy.consumeRetry(
        for: BrokerError.workerInterrupted(epoch: staleEpoch)
    )
    #expect(firstRetry)
    #expect(policy.retryCount == 1)
    let secondRetry = policy.consumeRetry(
        for: BrokerError.workerInterrupted(epoch: staleEpoch)
    )
    #expect(!secondRetry)

    var semanticFailurePolicy = IOSBrokerResumeRetryPolicy()
    let protocolRetry = semanticFailurePolicy.consumeRetry(
        for: BrokerError.protocolViolation("malformed reply")
    )
    #expect(!protocolRetry)
    let configurationRetry = semanticFailurePolicy.consumeRetry(
        for: BrokerError.invalidConfiguration("mismatch")
    )
    #expect(!configurationRetry)
    #expect(semanticFailurePolicy.retryCount == 0)
}

@Test
func resumeRecoveryRequiresFreshEpochAndSameRootIdentity() throws {
    let staleEpoch = BrokerEpoch.fresh()
    let freshEpoch = BrokerEpoch.fresh()
    let expectedDigest = "root-manifest-a"
    let expectation = IOSBrokerResumeRecoveryExpectation(
        staleEpoch: staleEpoch,
        rootManifestDigest: expectedDigest
    )

    try expectation.validate(
        recoveredEpoch: freshEpoch,
        recoveredRootManifestDigest: expectedDigest
    )

    do {
        try expectation.validate(
            recoveredEpoch: staleEpoch,
            recoveredRootManifestDigest: expectedDigest
        )
        Issue.record("resume recovery accepted the interrupted epoch")
    } catch let error as BrokerError {
        guard case .protocolViolation(let reason) = error else {
            Issue.record("expected protocolViolation, got \(error)")
            return
        }
        #expect(reason.contains("reused the interrupted worker epoch"))
    }

    do {
        try expectation.validate(
            recoveredEpoch: freshEpoch,
            recoveredRootManifestDigest: "root-manifest-b"
        )
        Issue.record("resume recovery accepted a different root identity")
    } catch let error as BrokerError {
        #expect(
            error
                == .rootMismatch(
                    expected: expectedDigest,
                    actual: "root-manifest-b"
                )
        )
    }
}

@Test
func launchAcquisitionRetriesNestedDeadProcessAssertionExactlyOnce() throws {
    let deadProcess = NSError(
        domain: "RBSAssertionErrorDomain",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Specified target process does not exist"]
    )
    let failedAssertion = NSError(
        domain: "com.apple.extensionKit.errorDomain",
        code: 4,
        userInfo: [NSUnderlyingErrorKey: deadProcess]
    )
    let failedLaunch = NSError(
        domain: "com.apple.extensionKit.errorDomain",
        code: 2,
        userInfo: [NSUnderlyingErrorKey: failedAssertion]
    )
    var policy = IOSBrokerLaunchAcquisitionRetryPolicy()

    let firstRetry = policy.consumeRetry(
        for: failedLaunch,
        recoveringInterruptedEpoch: true
    )
    #expect(firstRetry)
    #expect(policy.retryCount == 1)
    let secondRetry = policy.consumeRetry(
        for: failedLaunch,
        recoveringInterruptedEpoch: true
    )
    #expect(!secondRetry)

    var initialLaunchPolicy = IOSBrokerLaunchAcquisitionRetryPolicy()
    let initialLaunchRetry = initialLaunchPolicy.consumeRetry(
        for: failedLaunch,
        recoveringInterruptedEpoch: false
    )
    #expect(!initialLaunchRetry)
    #expect(initialLaunchPolicy.retryCount == 0)
}

@Test
func launchMetricsSeparateProcessAttemptsFromValidatedReadyHandshakes() {
    var metrics = IOSBrokerLaunchMetrics()
    #expect(metrics.attemptCount == 0)
    #expect(metrics.successfulCount == 0)

    // A wedged or otherwise failed process acquisition still proves that the
    // host attempted a replacement, but must not inflate successful launches.
    metrics.recordProcessInitializationAttempt()
    #expect(metrics.attemptCount == 1)
    #expect(metrics.successfulCount == 0)

    metrics.recordProcessInitializationAttempt()
    metrics.recordReadyValidatedLaunch()
    #expect(metrics.attemptCount == 2)
    #expect(metrics.successfulCount == 1)
}

@Test
func launchAcquisitionDoesNotRetrySemanticOrAmbiguousDataFailures() throws {
    let failures: [any Error] = [
        BrokerError.protocolViolation("malformed reply"),
        BrokerError.invalidConfiguration("mismatch"),
        BrokerError.outcomeUnknown(
            epoch: BrokerEpoch.fresh(),
            requestID: try BrokerRequestID(validating: 91)
        ),
        NSError(domain: "RBSAssertionErrorDomain", code: 1),
        NSError(domain: "com.apple.extensionKit.errorDomain", code: 2),
    ]

    for failure in failures {
        var policy = IOSBrokerLaunchAcquisitionRetryPolicy()
        let retry = policy.consumeRetry(
            for: failure,
            recoveringInterruptedEpoch: true
        )
        #expect(!retry)
        #expect(policy.retryCount == 0)
    }
}

@Test
func interruptedLaunchRequiresFreshEpochAndKnownDeadProcess() throws {
    let staleEpoch = BrokerEpoch.fresh()
    let freshEpoch = BrokerEpoch.fresh()
    let expectation = IOSBrokerInterruptedLaunchExpectation(
        staleEpoch: staleEpoch,
        knownDeadProcessIdentifier: 3931
    )

    try expectation.validate(
        recoveredEpoch: freshEpoch,
        recoveredProcessIdentifier: 3932
    )

    do {
        try expectation.validate(
            recoveredEpoch: staleEpoch,
            recoveredProcessIdentifier: 3932
        )
        Issue.record("launch recovery accepted the interrupted epoch")
    } catch let error as BrokerError {
        guard case .protocolViolation(let reason) = error else {
            Issue.record("expected protocolViolation, got \(error)")
            return
        }
        #expect(reason.contains("reused the interrupted worker epoch"))
    }

    do {
        try expectation.validate(
            recoveredEpoch: freshEpoch,
            recoveredProcessIdentifier: 3931
        )
        Issue.record("launch recovery accepted the known-dead process")
    } catch let error as BrokerError {
        guard case .protocolViolation(let reason) = error else {
            Issue.record("expected protocolViolation, got \(error)")
            return
        }
        #expect(reason.contains("reused the known-dead extension process"))
    }
}

@available(iOS 26.0, macOS 26.0, *)
@Test
func residentIdentityAcceptsOnlyWorkerSupportedRuntimeFields() throws {
    let broker = IOSBrokerConfiguration(
        expectedABI: 42,
        startupConfigurationDigest: "host-invariant-test"
    )
    let supported = OliphauntConfiguration(
        mode: .nativeBroker,
        durability: .safe,
        runtimeFootprint: .smallMobile,
        extensions: ["vector", "pg_trgm"]
    )
    _ = try IOSBrokerManager.ResidentIdentity(broker: broker, database: supported)

    var explicitDefaults = supported
    explicitDefaults.database = "postgres"
    _ = try IOSBrokerManager.ResidentIdentity(broker: broker, database: explicitDefaults)

    var explicitUsername = supported
    explicitUsername.username = "postgres"
    expectInvalidConfiguration(
        explicitUsername,
        broker: broker,
        reason: "iOS broker v1 does not accept a caller-provided PostgreSQL username"
    )

    var differentRoot = supported
    differentRoot.root = URL(fileURLWithPath: "/tmp/not-the-extension-private-default")
    do {
        _ = try IOSBrokerManager.ResidentIdentity(
            broker: broker,
            database: differentRoot
        )
        Issue.record("iOS broker v1 accepted a caller-provided root")
    } catch let error as BrokerError {
        guard case .rootMismatch(let expected, let actual) = error else {
            Issue.record("expected rootMismatch, got \(error)")
            return
        }
        #expect(expected == OliphauntBrokerProtocol.canonicalRootID)
        #expect(actual.contains("not-the-extension-private-default"))
    }

    var unsafeDurability = supported
    unsafeDurability.durability = .balanced
    expectInvalidConfiguration(
        unsafeDurability,
        broker: broker,
        reason: "iOS broker v1 requires safe durability"
    )

    var customGUCs = supported
    customGUCs.startupGUCs = [OliphauntStartupGUC("statement_timeout", "1000")]
    expectInvalidConfiguration(
        customGUCs,
        broker: broker,
        reason: "iOS broker v1 does not support custom startup GUCs"
    )

    var customUsername = supported
    customUsername.username = "application"
    expectInvalidConfiguration(
        customUsername,
        broker: broker,
        reason: "iOS broker v1 does not accept a caller-provided PostgreSQL username"
    )

    var customDatabase = supported
    customDatabase.database = "application"
    expectInvalidConfiguration(
        customDatabase,
        broker: broker,
        reason: "iOS broker v1 requires PostgreSQL database postgres"
    )
}

@available(iOS 26.0, macOS 26.0, *)
@Test
func iosBrokerEngineNeverAdvertisesServerOrConnectionString() throws {
    let engine = IOSBrokerEngine(
        configuration: IOSBrokerConfiguration(
            expectedABI: 6,
            startupConfigurationDigest: "server-boundary-test"
        ),
        manager: IOSBrokerManager()
    )
    let broker = try #require(
        engine.supportedModes.first(where: { $0.mode == .nativeBroker })
    )
    #expect(broker.available)
    #expect(broker.capabilities.connectionString == nil)
    #expect(!broker.capabilities.backupRestore)
    #expect(!broker.capabilities.independentSessions)
    #expect(broker.capabilities.maxClientSessions == 1)

    let server = try #require(
        engine.supportedModes.first(where: { $0.mode == .nativeServer })
    )
    #expect(!server.available)
    #expect(server.unavailableReason == IOSBrokerEngine.nativeServerUnavailableReason)
}

@Test
func rawResponseCollectorFailsBeforeExceedingItsMemoryCeiling() throws {
    let collector = IOSBrokerResponseCollector(maximumBytes: 8)
    try collector.append(Data(repeating: 0x41, count: 5))
    #expect(collector.value.count == 5)

    do {
        try collector.append(Data(repeating: 0x42, count: 4))
        Issue.record("raw response collector exceeded its declared ceiling")
    } catch let error as IOSBrokerRawResponseLimitError {
        #expect(error == .exceeded(maximumBytes: 8))
    }
    #expect(collector.value.count == 5)
}

@Test
func brokerConfigurationRejectsAnUnboundedRawResponseCollector() throws {
    var configuration = IOSBrokerConfiguration(
        expectedABI: 6,
        startupConfigurationDigest: "raw-response-ceiling-test"
    )
    configuration.maximumRawResponseBytes =
        OliphauntBrokerProtocol.maximumQueuedBytesPerDirection + 1

    do {
        _ = try configuration.validated()
        Issue.record("an oversized raw response collector was accepted")
    } catch let error as BrokerError {
        guard case .invalidConfiguration = error else {
            Issue.record("expected invalidConfiguration, got \(error)")
            return
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
private func expectInvalidConfiguration(
    _ configuration: OliphauntConfiguration,
    broker: IOSBrokerConfiguration,
    reason expectedReason: String
) {
    do {
        _ = try IOSBrokerManager.ResidentIdentity(
            broker: broker,
            database: configuration
        )
        Issue.record("expected invalid configuration: \(expectedReason)")
    } catch let error as BrokerError {
        guard case .invalidConfiguration(let actualReason) = error else {
            Issue.record("expected invalidConfiguration, got \(error)")
            return
        }
        #expect(actualReason == expectedReason)
    } catch {
        Issue.record("expected BrokerError.invalidConfiguration, got \(error)")
    }
}

private func simpleQuery(_ sql: String) -> Data {
    var body = Data(sql.utf8)
    body.append(0)
    var request = Data([0x51])
    appendUInt32(UInt32(body.count + 4), to: &request)
    request.append(body)
    return request
}

private func backendMessage(type: UInt8, body: Data) -> Data {
    var message = Data([type])
    appendUInt32(UInt32(body.count + 4), to: &message)
    message.append(body)
    return message
}

private func appendUInt32(_ value: UInt32, to data: inout Data) {
    data.append(UInt8((value >> 24) & 0xFF))
    data.append(UInt8((value >> 16) & 0xFF))
    data.append(UInt8((value >> 8) & 0xFF))
    data.append(UInt8(value & 0xFF))
}

private func makeBlocking(_ descriptor: Int32) throws {
    let flags = fcntl(descriptor, F_GETFL)
    guard flags >= 0, fcntl(descriptor, F_SETFL, flags & ~O_NONBLOCK) >= 0 else {
        throw POSIXError(POSIXError.Code(rawValue: errno) ?? .EIO)
    }
}

private func readFrameHeader(
    _ descriptor: Int32, epoch: BrokerEpoch
) throws
    -> BrokerFrameHeader
{
    let bytes = try readExactly(
        descriptor,
        count: Int(OliphauntBrokerProtocol.headerLength)
    )
    return try BrokerFrameHeader.decode(bytes, expectedEpoch: epoch)
}

private func readExactly(_ descriptor: Int32, count: Int) throws -> Data {
    var result = Data()
    result.reserveCapacity(count)
    var buffer = [UInt8](repeating: 0, count: min(16 * 1024, max(1, count)))
    while result.count < count {
        let wanted = min(buffer.count, count - result.count)
        let received = buffer.withUnsafeMutableBytes { rawBuffer in
            Darwin.read(descriptor, rawBuffer.baseAddress, wanted)
        }
        if received > 0 {
            result.append(contentsOf: buffer[0..<received])
        } else if received == 0 {
            throw POSIXError(.ECONNRESET)
        } else if errno != EINTR {
            throw POSIXError(POSIXError.Code(rawValue: errno) ?? .EIO)
        }
    }
    return result
}

private func writeAll(_ data: Data, to descriptor: Int32) throws {
    try data.withUnsafeBytes { rawBuffer in
        var offset = 0
        while offset < rawBuffer.count {
            let written = Darwin.write(
                descriptor,
                rawBuffer.baseAddress?.advanced(by: offset),
                rawBuffer.count - offset
            )
            if written > 0 {
                offset += written
            } else if written < 0, errno == EINTR {
                continue
            } else {
                throw POSIXError(POSIXError.Code(rawValue: errno) ?? .EIO)
            }
        }
    }
}

private final class LockedChunkAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = 0

    var byteCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return bytes
    }

    func append(_ chunk: Data) {
        lock.lock()
        bytes += chunk.count
        lock.unlock()
    }
}
