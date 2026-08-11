import Foundation
import Oliphaunt
import OliphauntBrokerExtension
import OliphauntBrokerProtocol
import Testing

@Test
func uploadInterruptionClosesSessionAndAllowsFreshEpoch() async throws {
    let harness = try RecoveryHarness(behaviors: [.succeed, .succeed])
    defer { harness.removeStorage() }

    let firstReady = try await harness.core.start(hello: harness.hello)
    let firstSession = try #require(await harness.engine.session(at: 0))
    let sink = RecordingFrameSink()

    _ = try await harness.core.handle(
        try brokerFrame(.requestBegin, ready: firstReady, requestID: 1),
        sink: sink
    )
    _ = try await harness.core.handle(
        try brokerFrame(
            .requestBytes,
            ready: firstReady,
            requestID: 1,
            payload: try OliphauntProtocol.simpleQuery("SELECT 1")
        ),
        sink: sink
    )

    await harness.core.interruptCurrentEpoch()

    let interrupted = try await harness.core.diagnostics(expectedEpoch: firstReady.epoch)
    #expect(interrupted.state == .interrupted)
    #expect(interrupted.activeRequestID == nil)
    #expect(!interrupted.nativeDispatchStarted)
    #expect(await firstSession.closeCallCount() == 1)

    let recovered = try await harness.core.start(hello: harness.hello)
    #expect(recovered.epoch != firstReady.epoch)
    #expect(await harness.engine.openCallCount() == 2)
    #expect(try await harness.core.diagnostics(expectedEpoch: recovered.epoch).state == .ready)
}

@Test
func nativeStreamFailureIsRecoverableWithoutReplay() async throws {
    let harness = try RecoveryHarness(behaviors: [.fail, .succeed])
    defer { harness.removeStorage() }

    let firstReady = try await harness.core.start(hello: harness.hello)
    let firstSession = try #require(await harness.engine.session(at: 0))
    let sink = RecordingFrameSink()

    _ = try await harness.core.handle(
        try brokerFrame(.requestBegin, ready: firstReady, requestID: 7),
        sink: sink
    )
    _ = try await harness.core.handle(
        try brokerFrame(
            .requestBytes,
            ready: firstReady,
            requestID: 7,
            payload: try OliphauntProtocol.simpleQuery("INSERT INTO t VALUES (1)")
        ),
        sink: sink
    )
    do {
        _ = try await harness.core.handle(
            try brokerFrame(.requestEnd, ready: firstReady, requestID: 7),
            sink: sink
        )
        Issue.record("expected the native stream to fail")
    } catch let error as RecoveryTestError {
        #expect(error == .nativeStreamFailed)
    }

    let interrupted = try await harness.core.diagnostics(expectedEpoch: firstReady.epoch)
    #expect(interrupted.state == .interrupted)
    #expect(interrupted.activeRequestID == nil)
    #expect(await firstSession.streamCallCount() == 1)
    #expect(await firstSession.closeCallCount() == 1)
    #expect(sink.frameTypes() == [.outcomeUnknown])

    let recovered = try await harness.core.start(hello: harness.hello)
    #expect(recovered.epoch != firstReady.epoch)
    #expect(await harness.engine.openCallCount() == 2)
    #expect(await firstSession.streamCallCount() == 1)
    #expect(try await harness.core.diagnostics(expectedEpoch: recovered.epoch).state == .ready)
}

@Test
func runningCancellationSignalsNativeBeforeWorkerBookkeepingAndCompletesOnce() async throws {
    let harness = try RecoveryHarness(behaviors: [.blockUntilReleasedAfterCancellation])
    defer { harness.removeStorage() }

    let ready = try await harness.core.start(hello: harness.hello)
    let session = try #require(await harness.engine.session(at: 0))
    let sink = RecordingFrameSink()
    let requestID = try BrokerRequestID(validating: 11)

    _ = try await harness.core.handle(
        try brokerFrame(.requestBegin, ready: ready, requestID: requestID.rawValue),
        sink: sink
    )
    _ = try await harness.core.handle(
        try brokerFrame(
            .requestBytes,
            ready: ready,
            requestID: requestID.rawValue,
            payload: try OliphauntProtocol.simpleQuery("SELECT pg_sleep(10)")
        ),
        sink: sink
    )
    let execution = Task {
        try await harness.core.handle(
            try brokerFrame(.requestEnd, ready: ready, requestID: requestID.rawValue),
            sink: sink
        )
    }
    await session.waitUntilStreamIsBlocked()

    let direct = try await harness.core.cancellationController.requestCancellation(
        epoch: ready.epoch,
        requestID: requestID
    )
    #expect(direct == .signalSent)
    #expect(await session.cancelCallCount() == 1)

    let bookkeeping = Task {
        try await harness.core.cancelRequest(
            epoch: ready.epoch,
            requestID: requestID
        )
    }
    #expect(try await bookkeeping.value == .nativeSignal(.alreadyRequested))
    #expect(await session.cancelCallCount() == 1)

    await session.releaseBlockedStream()
    _ = try await execution.value

    let frameTypes = sink.frameTypes()
    #expect(frameTypes.dropLast(2).allSatisfy { $0 == .responseBytes })
    #expect(Array(frameTypes.suffix(2)) == [.cancelObserved, .completed])
    #expect(frameTypes.count { $0 == .cancelObserved } == 1)
    #expect(frameTypes.count { $0 == .completed } == 1)
    #expect(
        try await harness.core.diagnostics(expectedEpoch: ready.epoch).activeRequestID
            == nil
    )
}

@Test
func workerSanitizesBackendErrorsBeforeTheyReachTheFrameSink() async throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("oliphaunt-private-path-\(UUID().uuidString)", isDirectory: true)
    let response = backendPathErrorResponse(path: root.path)
    let harness = try RecoveryHarness(
        behaviors: [.chunks(response.map { Data([$0]) })],
        rootURL: root
    )
    defer { harness.removeStorage() }

    let ready = try await harness.core.start(hello: harness.hello)
    let sink = RecordingFrameSink()
    _ = try await harness.core.handle(
        try brokerFrame(.requestBegin, ready: ready, requestID: 19),
        sink: sink
    )
    _ = try await harness.core.handle(
        try brokerFrame(
            .requestBytes,
            ready: ready,
            requestID: 19,
            payload: try OliphauntProtocol.simpleQuery("SELECT path_error_probe()")
        ),
        sink: sink
    )
    _ = try await harness.core.handle(
        try brokerFrame(.requestEnd, ready: ready, requestID: 19),
        sink: sink
    )

    let visibleResponse = sink.responsePayload()
    #expect(visibleResponse.range(of: Data(root.path.utf8)) == nil)
    #expect(visibleResponse.range(of: Data("[redacted]".utf8)) != nil)
    #expect(sink.frameTypes().last == .completed)
    #expect(
        try await harness.core.diagnostics(expectedEpoch: ready.epoch).state
            == .ready
    )
}

@Test
func interruptedStartAttemptCannotPublishOrOverlapAReplacementSession() async throws {
    let harness = try RecoveryHarness(
        behaviors: [.succeed, .succeed],
        blockFirstOpen: true
    )
    defer { harness.removeStorage() }

    let initialEpoch = await harness.core.epoch
    let opening = Task {
        try await harness.core.start(hello: harness.hello)
    }
    await harness.engine.waitUntilFirstOpenIsBlocked()
    let invalidatedSession = try #require(await harness.engine.session(at: 0))

    await harness.core.interruptCurrentEpoch()
    await expectWorkerInterrupted(epoch: initialEpoch) {
        try await harness.core.start(hello: harness.hello)
    }

    await harness.engine.releaseFirstOpen()
    await expectWorkerInterrupted(epoch: initialEpoch) {
        try await opening.value
    }

    #expect(await invalidatedSession.closeCallCount() == 1)
    #expect(await harness.engine.openCallCount() == 1)
    let interrupted = try await harness.core.diagnostics(expectedEpoch: initialEpoch)
    #expect(interrupted.state == .interrupted)

    let recovered = try await harness.core.start(hello: harness.hello)
    #expect(recovered.epoch != initialEpoch)
    #expect(await harness.engine.openCallCount() == 2)
    #expect(try await harness.core.diagnostics(expectedEpoch: recovered.epoch).state == .ready)
}

@Test
func staleControlGenerationCannotActOnRecoveredWorker() async throws {
    let harness = try RecoveryHarness(behaviors: [.succeed, .succeed])
    defer { harness.removeStorage() }

    let firstReady = try await harness.core.start(hello: harness.hello)
    await harness.core.interruptCurrentEpoch()
    let recovered = try await harness.core.start(hello: harness.hello)
    let recoveredSession = try #require(await harness.engine.session(at: 1))

    await expectWorkerInterrupted(epoch: firstReady.epoch) {
        try await harness.core.checkpoint(expectedEpoch: firstReady.epoch)
    }
    await expectWorkerInterrupted(epoch: firstReady.epoch) {
        try await harness.core.prepareForBackground(
            expectedEpoch: firstReady.epoch,
            deadline: Date().addingTimeInterval(1)
        )
    }
    await expectWorkerInterrupted(epoch: firstReady.epoch) {
        try await harness.core.resumeFromBackground(expectedEpoch: firstReady.epoch)
    }
    await expectWorkerInterrupted(epoch: firstReady.epoch) {
        try await harness.core.detach(expectedEpoch: firstReady.epoch)
    }
    await expectWorkerInterrupted(epoch: firstReady.epoch) {
        try await harness.core.diagnostics(expectedEpoch: firstReady.epoch)
    }
    #if DEBUG
        await expectWorkerInterrupted(epoch: firstReady.epoch) {
            try await harness.core.injectFault(
                .duringBackup,
                expectedEpoch: firstReady.epoch
            )
        }
    #endif

    // Startup performs the restricted-role bootstrap and then its health check.
    #expect(await recoveredSession.rawCallCount() == 2)
    #expect(await recoveredSession.closeCallCount() == 0)
    let diagnostics = try await harness.core.diagnostics(expectedEpoch: recovered.epoch)
    #expect(diagnostics.state == .ready)
    #expect(diagnostics.epoch == recovered.epoch)
}

@Test
func backgroundCheckpointDeadlineInterruptsAndGatesFreshEpochUntilClose() async throws {
    let harness = try RecoveryHarness(
        behaviors: [.succeed, .succeed],
        blockFirstControlRaw: true
    )
    defer { harness.removeStorage() }

    let firstReady = try await harness.core.start(hello: harness.hello)
    let firstSession = try #require(await harness.engine.session(at: 0))
    let started = ContinuousClock.now
    do {
        _ = try await harness.core.prepareForBackground(
            expectedEpoch: firstReady.epoch,
            deadline: Date().addingTimeInterval(0.75)
        )
        Issue.record("expected the blocked checkpoint to invalidate its epoch")
    } catch let error as BrokerError {
        #expect(error == .workerInterrupted(epoch: firstReady.epoch))
    }
    #expect(started.duration(to: .now) < .seconds(0.75))
    #expect(
        try await harness.core.diagnostics(expectedEpoch: firstReady.epoch).state
            == .interrupted
    )

    for _ in 0..<100 where await firstSession.closeCallCount() == 0 {
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(await firstSession.cancelCallCount() == 1)
    #expect(await firstSession.closeCallCount() == 1)

    let recovered = try await harness.core.start(hello: harness.hello)
    #expect(recovered.epoch != firstReady.epoch)
    #expect(await harness.engine.openCallCount() == 2)
}

private struct RecoveryHarness {
    let rootURL: URL
    let engine: RecoveryTestEngine
    let core: WorkerCore
    let hello: BrokerHello

    init(
        behaviors: [RecoveryStreamBehavior],
        rootURL: URL? = nil,
        blockFirstOpen: Bool = false,
        blockFirstControlRaw: Bool = false
    ) throws {
        self.rootURL =
            rootURL
            ?? FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "oliphaunt-worker-recovery-\(UUID().uuidString)",
                isDirectory: true
            )
        engine = RecoveryTestEngine(
            behaviors: behaviors,
            blockFirstOpen: blockFirstOpen,
            blockFirstControlRaw: blockFirstControlRaw
        )
        let storage = try BrokerExtensionStorage(
            location: .extensionPrivate,
            rootURL: self.rootURL
        )
        let configuration = try BrokerWorkerConfiguration(
            storage: storage,
            engine: engine,
            liboliphauntVersion: "recovery-test-runtime",
            cABIVersion: 42,
            postgresMajorVersion: 18,
            startupConfigurationDigest: "recovery-test-configuration",
            runtimeVersionProvider: { "recovery-test-runtime" }
        )
        core = WorkerCore(configuration: configuration)
        hello = BrokerHello(
            expectedABI: 42,
            expectedRuntimeVersion: "recovery-test-runtime",
            startupConfigurationDigest: "recovery-test-configuration",
            requestedCapabilities: [.protocolRaw, .protocolStream, .queryCancel]
        )
    }

    func removeStorage() {
        try? FileManager.default.removeItem(at: rootURL)
    }
}

private enum RecoveryStreamBehavior: Sendable {
    case succeed
    case fail
    case chunks([Data])
    case blockUntilReleasedAfterCancellation
}

private enum RecoveryTestError: Error, Equatable {
    case nativeStreamFailed
}

private actor RecoveryTestEngine: OliphauntEngine {
    private let behaviors: [RecoveryStreamBehavior]
    private let blockFirstOpen: Bool
    private let blockFirstControlRaw: Bool
    private var sessions: [RecoveryTestSession] = []
    private var firstOpenIsBlocked = false
    private var firstOpenWasReleased = false
    private var firstOpenStartedWaiters: [CheckedContinuation<Void, Never>] = []
    private var firstOpenReleaseContinuation: CheckedContinuation<Void, Never>?

    init(
        behaviors: [RecoveryStreamBehavior],
        blockFirstOpen: Bool,
        blockFirstControlRaw: Bool
    ) {
        self.behaviors = behaviors
        self.blockFirstOpen = blockFirstOpen
        self.blockFirstControlRaw = blockFirstControlRaw
    }

    func open(configuration: OliphauntConfiguration) async throws -> any OliphauntSession {
        let root = try #require(configuration.root)
        let pgVersion =
            root
            .appendingPathComponent("pgdata", isDirectory: true)
            .appendingPathComponent("PG_VERSION", isDirectory: false)
        try Data("18\n".utf8).write(to: pgVersion, options: .atomic)

        let behavior = sessions.count < behaviors.count ? behaviors[sessions.count] : .succeed
        let session = RecoveryTestSession(
            streamBehavior: behavior,
            blockControlRaw: blockFirstControlRaw && sessions.isEmpty
        )
        sessions.append(session)
        if blockFirstOpen, sessions.count == 1 {
            firstOpenIsBlocked = true
            let waiters = firstOpenStartedWaiters
            firstOpenStartedWaiters.removeAll()
            for waiter in waiters {
                waiter.resume()
            }
            await withCheckedContinuation { continuation in
                if firstOpenWasReleased {
                    continuation.resume()
                } else {
                    firstOpenReleaseContinuation = continuation
                }
            }
        }
        return session
    }

    func restore(_ request: OliphauntRestoreRequest) async throws -> URL {
        request.root
    }

    func openCallCount() -> Int {
        sessions.count
    }

    func session(at index: Int) -> RecoveryTestSession? {
        sessions.indices.contains(index) ? sessions[index] : nil
    }

    func waitUntilFirstOpenIsBlocked() async {
        if firstOpenIsBlocked {
            return
        }
        await withCheckedContinuation { continuation in
            firstOpenStartedWaiters.append(continuation)
        }
    }

    func releaseFirstOpen() {
        firstOpenWasReleased = true
        firstOpenReleaseContinuation?.resume()
        firstOpenReleaseContinuation = nil
    }
}

private actor RecoveryTestSession: OliphauntSession {
    private let streamBehavior: RecoveryStreamBehavior
    private var rawCalls = 0
    private var streamCalls = 0
    private var closeCalls = 0
    private var cancelCalls = 0
    private let blockControlRaw: Bool
    private var controlRawWasReleased = false
    private var controlRawContinuation: CheckedContinuation<Void, Never>?
    private var streamIsBlocked = false
    private var blockedStreamWasReleased = false
    private var streamStartedWaiters: [CheckedContinuation<Void, Never>] = []
    private var blockedStreamContinuation: CheckedContinuation<Void, Never>?

    init(streamBehavior: RecoveryStreamBehavior, blockControlRaw: Bool) {
        self.streamBehavior = streamBehavior
        self.blockControlRaw = blockControlRaw
    }

    func capabilities() async -> OliphauntCapabilities {
        OliphauntCapabilities(
            mode: .nativeDirect,
            processIsolated: false,
            independentSessions: false,
            maxClientSessions: 1
        )
    }

    func execProtocolRaw(_ bytes: Data) async throws -> Data {
        rawCalls += 1
        // Startup call 1 establishes the role boundary and call 2 performs the
        // health check. Block the first later lifecycle control statement.
        if blockControlRaw, rawCalls > 2, !controlRawWasReleased {
            await withCheckedContinuation { continuation in
                if controlRawWasReleased {
                    continuation.resume()
                } else {
                    controlRawContinuation = continuation
                }
            }
        }
        return backendSelectOneResponse()
    }

    func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        streamCalls += 1
        switch streamBehavior {
        case .succeed:
            try onChunk(backendSelectOneResponse())
        case .fail:
            throw RecoveryTestError.nativeStreamFailed
        case .chunks(let chunks):
            for chunk in chunks {
                try onChunk(chunk)
            }
        case .blockUntilReleasedAfterCancellation:
            streamIsBlocked = true
            let waiters = streamStartedWaiters
            streamStartedWaiters.removeAll()
            for waiter in waiters {
                waiter.resume()
            }
            await withCheckedContinuation { continuation in
                if blockedStreamWasReleased {
                    continuation.resume()
                } else {
                    blockedStreamContinuation = continuation
                }
            }
            try onChunk(backendQueryCanceledResponse())
        }
    }

    func backup(_ request: OliphauntBackupRequest) async throws -> OliphauntBackupArtifact {
        OliphauntBackupArtifact(format: request.format, bytes: Data())
    }

    func cancel() async throws {
        cancelCalls += 1
        controlRawWasReleased = true
        controlRawContinuation?.resume()
        controlRawContinuation = nil
    }

    func close() async throws {
        closeCalls += 1
    }

    func streamCallCount() -> Int {
        streamCalls
    }

    func rawCallCount() -> Int {
        rawCalls
    }

    func closeCallCount() -> Int {
        closeCalls
    }

    func cancelCallCount() -> Int {
        cancelCalls
    }

    func waitUntilStreamIsBlocked() async {
        if streamIsBlocked {
            return
        }
        await withCheckedContinuation { continuation in
            streamStartedWaiters.append(continuation)
        }
    }

    func releaseBlockedStream() {
        blockedStreamWasReleased = true
        blockedStreamContinuation?.resume()
        blockedStreamContinuation = nil
    }
}

private func expectWorkerInterrupted<Value>(
    epoch: BrokerEpoch,
    performing operation: () async throws -> Value
) async {
    do {
        _ = try await operation()
        Issue.record("expected worker interruption for stale epoch \(epoch)")
    } catch let error as BrokerError {
        #expect(error == .workerInterrupted(epoch: epoch))
    } catch {
        Issue.record("expected BrokerError.workerInterrupted, got \(error)")
    }
}

private final class RecordingFrameSink: BrokerFrameSink, @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [BrokerFrame] = []

    func send(_ frame: BrokerFrame) throws {
        lock.lock()
        defer { lock.unlock() }
        frames.append(frame)
    }

    func frameTypes() -> [BrokerFrameType] {
        lock.lock()
        defer { lock.unlock() }
        return frames.map(\.header.frameType)
    }

    func responsePayload() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return
            frames
            .filter { $0.header.frameType == .responseBytes }
            .reduce(into: Data()) { $0.append($1.payload) }
    }
}

private func brokerFrame(
    _ type: BrokerFrameType,
    ready: BrokerReady,
    requestID: UInt64,
    payload: Data = Data()
) throws -> BrokerFrame {
    try BrokerFrame(
        protocolVersion: ready.selectedProtocolVersion,
        frameType: type,
        epoch: ready.epoch,
        requestID: requestID,
        payload: payload
    )
}

private func backendSelectOneResponse() -> Data {
    var response = Data()

    var rowDescription = Data()
    appendInt16(1, to: &rowDescription)
    rowDescription.append(Data("broker_health".utf8))
    rowDescription.append(0)
    appendUInt32(0, to: &rowDescription)
    appendInt16(0, to: &rowDescription)
    appendUInt32(23, to: &rowDescription)
    appendInt16(4, to: &rowDescription)
    appendUInt32(UInt32.max, to: &rowDescription)
    appendInt16(0, to: &rowDescription)
    appendBackendMessage(0x54, body: rowDescription, to: &response)

    var row = Data()
    appendInt16(1, to: &row)
    appendUInt32(1, to: &row)
    row.append(Data("1".utf8))
    appendBackendMessage(0x44, body: row, to: &response)

    appendBackendMessage(0x43, body: Data("SELECT 1\0".utf8), to: &response)
    appendBackendMessage(0x5a, body: Data([0x49]), to: &response)
    return response
}

private func backendPathErrorResponse(path: String) -> Data {
    var response = Data()
    var error = Data()
    error.append(0x53)
    error.append(Data("ERROR\0".utf8))
    error.append(0x56)
    error.append(Data("ERROR\0".utf8))
    error.append(0x43)
    error.append(Data("F0000\0".utf8))
    error.append(0x4d)
    error.append(Data("could not open \(path)/runtime-cache/private.stop\0".utf8))
    error.append(0)
    appendBackendMessage(0x45, body: error, to: &response)
    appendBackendMessage(0x5a, body: Data([0x49]), to: &response)
    return response
}

private func backendQueryCanceledResponse() -> Data {
    var response = Data()
    var error = Data()
    error.append(0x53)
    error.append(Data("ERROR\0".utf8))
    error.append(0x56)
    error.append(Data("ERROR\0".utf8))
    error.append(0x43)
    error.append(Data("57014\0".utf8))
    error.append(0x4d)
    error.append(Data("canceling statement due to user request\0".utf8))
    error.append(0)
    appendBackendMessage(0x45, body: error, to: &response)
    appendBackendMessage(0x5a, body: Data([0x49]), to: &response)
    return response
}

private func appendBackendMessage(_ tag: UInt8, body: Data, to response: inout Data) {
    response.append(tag)
    appendUInt32(UInt32(body.count + 4), to: &response)
    response.append(body)
}

private func appendInt16(_ value: Int16, to data: inout Data) {
    let bits = UInt16(bitPattern: value)
    data.append(UInt8((bits >> 8) & 0xff))
    data.append(UInt8(bits & 0xff))
}

private func appendUInt32(_ value: UInt32, to data: inout Data) {
    data.append(UInt8((value >> 24) & 0xff))
    data.append(UInt8((value >> 16) & 0xff))
    data.append(UInt8((value >> 8) & 0xff))
    data.append(UInt8(value & 0xff))
}
