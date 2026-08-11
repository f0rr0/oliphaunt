import Dispatch
import Foundation

enum BrokerHostLifecycleEventKind: String, Codable, Hashable, Sendable {
    case inactive
    case background
    case active
    case memoryWarning
}

struct BrokerHostLifecycleEvent: Codable, Equatable, Sendable {
    var kind: BrokerHostLifecycleEventKind
    var observedAtUnixNanoseconds: UInt64
    var observedAtUptimeNanoseconds: UInt64
}

private final class BrokerHostLifecycleEventStorage: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [BrokerHostLifecycleEvent] = []
    private var lastApplicationStateKind: BrokerHostLifecycleEventKind?

    func append(_ event: BrokerHostLifecycleEvent) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if event.kind != .memoryWarning {
            guard event.kind != lastApplicationStateKind else { return false }
            lastApplicationStateKind = event.kind
        }
        values.append(event)
        return true
    }

    func snapshot() -> [BrokerHostLifecycleEvent] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}

/// A process-lifecycle event channel owned by the host application.
///
/// `BrokerSpikeAppDelegate` sends UIKit application-state and memory-warning
/// notifications into this value. The lifecycle fixture is its only stream consumer. Copies
/// share one continuation and one journal snapshot, so it is safe to retain one
/// copy in the model and pass another to `DeviceLifecycleFixture.run(events:)`.
struct BrokerHostLifecycleEventSource: Sendable {
    fileprivate let stream: AsyncStream<BrokerHostLifecycleEvent>
    private let continuation: AsyncStream<BrokerHostLifecycleEvent>.Continuation
    private let storage: BrokerHostLifecycleEventStorage

    init() {
        let pair = AsyncStream<BrokerHostLifecycleEvent>.makeStream(
            bufferingPolicy: .bufferingNewest(32)
        )
        stream = pair.stream
        continuation = pair.continuation
        storage = BrokerHostLifecycleEventStorage()
    }

    func send(_ kind: BrokerHostLifecycleEventKind) {
        let event = BrokerHostLifecycleEvent(
            kind: kind,
            observedAtUnixNanoseconds: deviceLifecycleUnixNanoseconds(),
            observedAtUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds
        )
        guard storage.append(event) else { return }
        continuation.yield(event)
    }

    func finish() {
        continuation.finish()
    }

    fileprivate func snapshot() -> [BrokerHostLifecycleEvent] {
        storage.snapshot()
    }
}

#if canImport(OliphauntIOSBroker)
    import Darwin
    import Oliphaunt
    import OliphauntBrokerProtocol
    import OliphauntIOSBroker

    enum DeviceLifecycleFixture {
        private static let startupConfigurationDigest =
            "ios-native-broker-spike-v2-restricted-role"
        private static let selectedExtensions = ["pg_trgm", "vector"]
        private static let backgroundPreparationSeconds: TimeInterval = 8
        private static let filesystemTimestampToleranceNanoseconds: UInt64 = 2_000_000_000

        static func run(
            events: BrokerHostLifecycleEventSource
        ) async throws -> BrokerProbeResult {
            let rawEnvironment = DeviceLifecycleEnvironment.capture()
            let journal = try DeviceLifecycleJournalWriter(environment: rawEnvironment)
            var controlSession: IOSBrokerSession?
            var database: OliphauntDatabase?
            var checks = Set<String>()
            var observations: [String: String] = [:]
            var diagnostics: [BrokerDiagnosticEvidence] = []
            var recoveredEpochs: [String] = []

            do {
                let environment = try rawEnvironment.validated()
                #if targetEnvironment(simulator)
                    throw DeviceLifecycleFailure.assertion(
                        "device lifecycle qualification requires a physical iOS device"
                    )
                #elseif DEBUG
                    throw DeviceLifecycleFailure.assertion(
                        "device lifecycle qualification requires a Release build"
                    )
                #endif

                let hostPID = getpid()
                let manager = IOSBrokerManager()
                let brokerConfiguration = IOSBrokerConfiguration(
                    expectedABI: 6,
                    expectedRuntimeVersion: nil,
                    startupConfigurationDigest: startupConfigurationDigest,
                    maximumRequestBytes: OliphauntBrokerProtocol.defaultMaximumRequestBytes,
                    requestDeadline: .seconds(environment.orchestrationTimeoutSeconds * 3),
                    extensionBundleIdentifier: BrokerFixtureBundleIdentifiers
                        .extensionBundleIdentifier,
                    controlReplyTimeout: .seconds(20),
                    cancellationGracePeriod: .seconds(3)
                )
                let databaseConfiguration = OliphauntConfiguration(
                    mode: .nativeBroker,
                    root: nil,
                    durability: .safe,
                    runtimeFootprint: .smallMobile,
                    extensions: selectedExtensions
                )
                let engine = IOSBrokerEngine(
                    configuration: brokerConfiguration,
                    manager: manager
                )

                observations = [
                    "buildConfiguration": "release",
                    "deviceLifecycleLaunchIndex": String(environment.launchIndex),
                    "deviceLifecycleRunToken": environment.runToken,
                    "expectWorkerKill": environment.expectWorkerKill ? "YES" : "NO",
                    "orchestrationTimeoutSeconds": String(environment.orchestrationTimeoutSeconds),
                    "backgroundActiveWorkSeconds": String(
                        environment.orchestrationTimeoutSeconds * 2
                    ),
                    "requestDeadlineSeconds": String(environment.orchestrationTimeoutSeconds * 3),
                ]
                var iterator = events.stream.makeAsyncIterator()
                var foregroundActiveEvent: BrokerHostLifecycleEvent?
                while let event = await iterator.next() {
                    if event.kind == .active {
                        foregroundActiveEvent = event
                        break
                    }
                }
                let foregroundActive = try requireValue(
                    foregroundActiveEvent,
                    "host lifecycle event stream ended before initial foreground activation"
                )
                observations["foregroundActiveUptimeNanoseconds"] = String(
                    foregroundActive.observedAtUptimeNanoseconds
                )
                try journal.update(
                    phase: .foregroundActive,
                    events: events.snapshot()
                ) { report in
                    report.hostPID = hostPID
                    report.observations = observations
                }

                let openedControl = try await manager.open(
                    configuration: brokerConfiguration,
                    databaseConfiguration: databaseConfiguration
                )
                controlSession = openedControl
                let openedDatabase = try await OliphauntDatabase.open(
                    configuration: databaseConfiguration,
                    engine: engine
                )
                database = openedDatabase

                let initialManager = await manager.diagnostics()
                let initialWorker = try await openedControl.workerDiagnostics()
                let initialPID = initialWorker.extensionProcessIdentifier
                let initialEpoch = initialWorker.epoch
                let initialManifestDigest = try requireValue(
                    initialWorker.manifestDigest,
                    "initial worker diagnostics omitted the manifest digest"
                )
                try require(initialPID != hostPID) {
                    "host and extension unexpectedly have the same PID"
                }
                try require(initialManager.state == .ready(initialEpoch)) {
                    "manager was not ready at the worker's initial epoch"
                }
                try require(!initialManager.admissionsPaused) {
                    "new manager started with admissions paused"
                }
                try require(!initialWorker.capabilities.backgroundContinuable) {
                    "worker overclaimed backgroundContinuable"
                }
                try requireAvailableMemory(initialWorker, phase: "openedIdle")
                diagnostics.append(
                    evidence(phase: "openedIdle", manager: initialManager, worker: initialWorker)
                )
                checks.formUnion([
                    "extensionDiscovery",
                    "separatePID",
                    "workerDiagnostics",
                    "backgroundContinuableFalse",
                    "openedIdleMemory",
                    "availableMemory",
                ])
                try journal.update(
                    phase: .foregroundQualification,
                    events: events.snapshot()
                ) { report in
                    report.hostPID = hostPID
                    report.initialWorkerPID = initialPID
                    report.initialEpoch = initialEpoch.description
                    report.currentWorkerPID = initialPID
                    report.currentEpoch = initialEpoch.description
                    report.manifestDigest = initialManifestDigest
                    report.diagnostics = diagnostics
                    report.checks = checks.sorted()
                    report.observations = observations
                }

                let capabilities = await openedControl.capabilities()
                try require(capabilities.processIsolated) {
                    "host capability mapping did not preserve process isolation"
                }
                try require(capabilities.crashRestartable) {
                    "host capability mapping did not preserve crash recovery"
                }
                try require(!capabilities.rootSwitchable && !capabilities.multiRoot) {
                    "host capability mapping overclaimed root behavior"
                }
                checks.insert("capabilities")

                let launchObservations = try await verifyCrossLaunchPersistence(
                    database: openedDatabase,
                    environment: environment
                )
                observations.merge(launchObservations) { _, current in current }
                checks.insert("crossLaunchPersistence")

                let writeStartedAt = deviceLifecycleUnixNanoseconds()
                try await recreateSizableRelation(database: openedDatabase)
                let relationStats = try await openedDatabase.query(
                    """
                    SELECT
                        count(*)::text AS row_count,
                        pg_total_relation_size('broker_lifecycle_pressure')::text AS relation_bytes
                    FROM broker_lifecycle_pressure
                    """
                )
                let relationRowCount = try integerValue(
                    relationStats,
                    column: "row_count",
                    label: "lifecycle relation row count"
                )
                let relationBytes = try unsignedIntegerValue(
                    relationStats,
                    column: "relation_bytes",
                    label: "lifecycle relation size"
                )
                try require(relationRowCount == 8_192) {
                    "sizable lifecycle relation contains \(relationRowCount) rows, expected 8192"
                }
                try require(relationBytes >= 24 * 1024 * 1024) {
                    "sizable lifecycle relation occupies only \(relationBytes) bytes"
                }
                observations["relationBytes"] = String(relationBytes)
                observations["relationRows"] = String(relationRowCount)
                checks.insert("sizableRelation")

                let foregroundIdleWorker = try await openedControl.workerDiagnostics()
                try requireAvailableMemory(foregroundIdleWorker, phase: "foregroundIdle")
                diagnostics.append(
                    evidence(
                        phase: "foregroundIdle",
                        manager: await manager.diagnostics(),
                        worker: foregroundIdleWorker
                    )
                )

                let foregroundSleep = Task {
                    try await openedDatabase.query("SELECT pg_sleep(30)")
                }
                let foregroundExecuting = try await waitForActiveNativeRequest(
                    session: openedControl,
                    timeout: .seconds(5)
                )
                try requireAvailableMemory(foregroundExecuting, phase: "executingBeforeCancel")
                diagnostics.append(
                    evidence(
                        phase: "executingBeforeCancel",
                        manager: await manager.diagnostics(),
                        worker: foregroundExecuting
                    )
                )
                try await openedDatabase.cancel()
                try await requirePostgresCancellation(foregroundSleep)
                let afterCancel = try await openedDatabase.query(
                    "SELECT 'live-after-cancel'::text AS status"
                )
                try require(
                    try afterCancel.getText(row: 0, column: "status") == "live-after-cancel"
                ) {
                    "worker was not live after foreground cancellation"
                }
                diagnostics.append(
                    evidence(
                        phase: "afterCancel",
                        manager: await manager.diagnostics(),
                        worker: try await openedControl.workerDiagnostics()
                    )
                )
                checks.formUnion(["cancellation", "postCancelLiveness", "executingMemory"])

                let declaredQueueCeiling = UInt64(
                    OliphauntBrokerProtocol.maximumQueuedBytesPerDirection
                )
                let maximumSlowStreamFootprintDelta = declaredQueueCeiling * 2
                let requiredSlowStreamAvailableMemoryHeadroom =
                    declaredQueueCeiling
                let smallSlowStreamSamplingDeadlineSeconds = 30
                let slowStreamSamplingDeadlineSeconds = 120
                observations["smallSlowStreamSamplingDeadlineSeconds"] = String(
                    smallSlowStreamSamplingDeadlineSeconds
                )
                observations["slowStreamSamplingDeadlineSeconds"] = String(
                    slowStreamSamplingDeadlineSeconds
                )

                let smallStreamCounter = DeviceLifecycleStreamCounter()
                let smallStreamFinished = DeviceLifecycleSignal()
                let smallStreamStartedAt = DispatchTime.now().uptimeNanoseconds
                let smallStreaming = Task {
                    defer { smallStreamFinished.signal() }
                    try await openedDatabase.execProtocolStream(
                        try OliphauntProtocol.simpleQuery(
                            "SELECT repeat('s', 8192) FROM generate_series(1, 1024)"
                        )
                    ) { chunk in
                        smallStreamCounter.consume(chunk)
                        Thread.sleep(forTimeInterval: 0.005)
                    }
                }
                let smallStreamingSamples: DeviceLifecycleActiveStreamSamples
                do {
                    smallStreamingSamples = try await sampleActiveStreaming(
                        session: openedControl,
                        counter: smallStreamCounter,
                        finished: smallStreamFinished,
                        timeout: .seconds(smallSlowStreamSamplingDeadlineSeconds)
                    )
                    try await smallStreaming.value
                } catch {
                    smallStreaming.cancel()
                    _ = try? await smallStreaming.value
                    throw error
                }
                let smallStreamingWorker = smallStreamingSamples.representative
                try requireAvailableMemory(smallStreamingWorker, phase: "slowStreaming8MiB")
                diagnostics.append(
                    evidence(
                        phase: "slowStreaming8MiB",
                        manager: await manager.diagnostics(),
                        worker: smallStreamingWorker
                    )
                )
                let smallStreamFinishedAt = DispatchTime.now().uptimeNanoseconds
                let smallStreamBytes = smallStreamCounter.byteCount
                try require(
                    smallStreamBytes > 8 * 1024 * 1024 && smallStreamCounter.chunkCount > 1
                ) {
                    "8 MiB slow-reader probe did not produce a multi-frame response"
                }
                observations["smallSlowStreamBytes"] = String(smallStreamBytes)
                observations["smallSlowStreamChunks"] = String(smallStreamCounter.chunkCount)
                observations["smallSlowStreamActiveSampleCount"] = String(
                    smallStreamingSamples.count
                )
                observations["smallSlowStreamElapsedNanoseconds"] = String(
                    smallStreamFinishedAt &- smallStreamStartedAt
                )

                let streamCounter = DeviceLifecycleStreamCounter()
                let streamFinished = DeviceLifecycleSignal()
                let streamStartedAt = DispatchTime.now().uptimeNanoseconds
                let streaming = Task {
                    defer { streamFinished.signal() }
                    try await openedDatabase.execProtocolStream(
                        try OliphauntProtocol.simpleQuery(
                            "SELECT repeat('s', 8192) FROM generate_series(1, 4096)"
                        )
                    ) { chunk in
                        streamCounter.consume(chunk)
                        Thread.sleep(forTimeInterval: 0.005)
                    }
                }
                let streamingSamples: DeviceLifecycleActiveStreamSamples
                do {
                    streamingSamples = try await sampleActiveStreaming(
                        session: openedControl,
                        counter: streamCounter,
                        finished: streamFinished,
                        timeout: .seconds(slowStreamSamplingDeadlineSeconds)
                    )
                    try await streaming.value
                } catch {
                    streaming.cancel()
                    _ = try? await streaming.value
                    throw error
                }
                let streamingWorker = streamingSamples.representative
                try requireAvailableMemory(streamingWorker, phase: "slowStreaming32MiB")
                diagnostics.append(
                    evidence(
                        phase: "slowStreaming32MiB",
                        manager: await manager.diagnostics(),
                        worker: streamingWorker
                    )
                )
                let streamFinishedAt = DispatchTime.now().uptimeNanoseconds
                let streamElapsed = max(1, streamFinishedAt &- streamStartedAt)
                let streamBytes = streamCounter.byteCount
                let throughput = UInt64(
                    min(
                        Double(UInt64.max),
                        Double(streamBytes) * 1_000_000_000 / Double(streamElapsed)
                    )
                )
                observations["slowStreamBytes"] = String(streamBytes)
                observations["slowStreamChunks"] = String(streamCounter.chunkCount)
                observations["slowStreamActiveSampleCount"] = String(streamingSamples.count)
                observations["slowStreamElapsedNanoseconds"] = String(streamElapsed)
                observations["slowStreamBytesPerSecond"] = String(throughput)
                let minimumStreamHeadroom = min(
                    smallStreamingSamples.minimumAvailableMemoryBytes,
                    streamingSamples.minimumAvailableMemoryBytes
                )
                let responseSizeDelta = UInt64(streamBytes - smallStreamBytes)
                let smallStreamingFootprint = smallStreamingSamples.peakPhysFootprintBytes
                let largeStreamingFootprint = streamingSamples.peakPhysFootprintBytes
                let streamingFootprintDelta =
                    largeStreamingFootprint > smallStreamingFootprint
                    ? largeStreamingFootprint - smallStreamingFootprint
                    : 0
                observations["declaredQueueCeilingBytes"] = String(declaredQueueCeiling)
                observations["maximumSlowStreamFootprintDeltaBytes"] = String(
                    maximumSlowStreamFootprintDelta
                )
                observations["slowStreamResponseSizeDeltaBytes"] = String(responseSizeDelta)
                observations["requiredSlowStreamAvailableMemoryHeadroomBytes"] = String(
                    requiredSlowStreamAvailableMemoryHeadroom
                )
                observations["minimumSlowStreamAvailableMemoryBytes"] = String(
                    minimumStreamHeadroom
                )
                observations["smallSlowStreamPhysFootprintBytes"] = String(
                    smallStreamingFootprint
                )
                observations["largeSlowStreamPhysFootprintBytes"] = String(
                    largeStreamingFootprint
                )
                observations["slowStreamFootprintDeltaBytes"] = String(
                    streamingFootprintDelta
                )
                observations["slowStreamPeakPhysFootprintBytes"] = String(
                    max(smallStreamingFootprint, largeStreamingFootprint)
                )
                try require(streamBytes > 32 * 1024 * 1024) {
                    "slow streaming response delivered only \(streamBytes) bytes"
                }
                try require(
                    minimumStreamHeadroom > requiredSlowStreamAvailableMemoryHeadroom
                ) {
                    "slow-reader minimum available memory \(minimumStreamHeadroom) did not exceed required bound \(requiredSlowStreamAvailableMemoryHeadroom)"
                }
                try require(responseSizeDelta > maximumSlowStreamFootprintDelta) {
                    "slow-reader response-size delta \(responseSizeDelta) did not exceed footprint bound \(maximumSlowStreamFootprintDelta)"
                }
                try require(streamingFootprintDelta <= maximumSlowStreamFootprintDelta) {
                    "slow-reader physical-footprint delta \(streamingFootprintDelta) exceeded bound \(maximumSlowStreamFootprintDelta)"
                }
                checks.formUnion([
                    "slowStreamTwoSizes",
                    "slowStreamThroughput",
                    "slowStreamBoundedHeadroom",
                ])

                let protocolRTTSamples = try await measureProtocolRTT(
                    session: openedControl,
                    sampleCount: 20
                )
                let protocolRTTMedianMilliseconds = protocolRTTSamples[
                    protocolRTTSamples.count / 2
                ]
                observations["protocolRTTMedianMilliseconds"] = String(
                    format: "%.3f",
                    protocolRTTMedianMilliseconds
                )
                observations["protocolRTTSampleCount"] = String(protocolRTTSamples.count)
                checks.insert("protocolRTT")

                _ = try await openedDatabase.execute(
                    "UPDATE broker_lifecycle_pressure SET payload = reverse(payload)"
                )
                let beforeCheckpointWorker = try await openedControl.workerDiagnostics()
                let priorCheckpointSampleSequence =
                    beforeCheckpointWorker.checkpointMemorySample?.sequence ?? 0
                try await openedControl.checkpoint()
                let afterCheckpointWorker = try await openedControl.workerDiagnostics()
                let checkpointMemorySample = try requireValue(
                    afterCheckpointWorker.checkpointMemorySample,
                    "checkpoint diagnostics omitted the retained memory sample"
                )
                try require(
                    checkpointMemorySample.sequence > priorCheckpointSampleSequence
                ) {
                    "checkpoint diagnostics returned a stale retained memory sample"
                }
                try require(
                    checkpointMemorySample.startedAtUptimeNanoseconds
                        <= checkpointMemorySample.sampledAtUptimeNanoseconds
                        && checkpointMemorySample.sampledAtUptimeNanoseconds
                            <= checkpointMemorySample.completedAtUptimeNanoseconds
                ) {
                    "checkpoint memory sample timestamps fall outside the checkpoint interval"
                }
                try require(
                    checkpointMemorySample.physFootprintBytes > 0
                        && checkpointMemorySample.residentBytes > 0
                        && checkpointMemorySample.availableMemoryBytes > 0
                ) {
                    "checkpoint memory sample omitted footprint, resident, or headroom evidence"
                }
                try require(!afterCheckpointWorker.checkpointInProgress) {
                    "checkpointInProgress remained set after checkpoint completion"
                }
                diagnostics.append(
                    evidence(
                        phase: "checkpointMemorySample",
                        manager: await manager.diagnostics(),
                        worker: afterCheckpointWorker,
                        checkpointMemorySample: checkpointMemorySample
                    )
                )
                try requireAvailableMemory(afterCheckpointWorker, phase: "afterCheckpoint")
                diagnostics.append(
                    evidence(
                        phase: "afterCheckpoint",
                        manager: await manager.diagnostics(),
                        worker: afterCheckpointWorker
                    )
                )
                observations["priorCheckpointMemorySampleSequence"] = String(
                    priorCheckpointSampleSequence
                )
                observations["checkpointMemorySampleSequence"] = String(
                    checkpointMemorySample.sequence
                )
                observations["checkpointMemorySampleStartedAtUptimeNanoseconds"] = String(
                    checkpointMemorySample.startedAtUptimeNanoseconds
                )
                observations["checkpointMemorySampledAtUptimeNanoseconds"] = String(
                    checkpointMemorySample.sampledAtUptimeNanoseconds
                )
                observations["checkpointMemorySampleCompletedAtUptimeNanoseconds"] = String(
                    checkpointMemorySample.completedAtUptimeNanoseconds
                )
                observations["checkpointInProgressAfterCompletion"] =
                    afterCheckpointWorker.checkpointInProgress ? "true" : "false"
                checks.formUnion(["checkpointControl", "checkpointDiagnostics"])

                do {
                    _ = try await openedControl.prepareForBackground(
                        deadline: Date(timeIntervalSinceNow: -1)
                    )
                    throw DeviceLifecycleFailure.assertion(
                        "already-expired background preparation unexpectedly succeeded"
                    )
                } catch let error as BrokerError {
                    guard case .deadlineExceeded = error else { throw error }
                }
                let afterExpiredDeadline = await manager.diagnostics()
                try require(!afterExpiredDeadline.admissionsPaused) {
                    "an already-expired background deadline paused admissions"
                }
                try require(afterExpiredDeadline.state == .ready(initialEpoch)) {
                    "an already-expired background deadline changed manager state"
                }
                let afterExpiredQuery = try await rawQuery(
                    openedControl,
                    "SELECT 'admitted'::text AS status"
                )
                try require(try afterExpiredQuery.getText(row: 0, column: "status") == "admitted") {
                    "admissions did not remain usable after an already-expired deadline"
                }
                checks.insert("expiredDeadlineAdmission")

                let backgroundSleep = Task {
                    try await openedDatabase.query(
                        "SELECT pg_sleep(\(environment.orchestrationTimeoutSeconds * 2))"
                    )
                }
                _ = try await waitForActiveNativeRequest(
                    session: openedControl,
                    timeout: .seconds(5)
                )
                let queuedQuery = Task {
                    try await openedControl.execProtocolRaw(
                        try OliphauntProtocol.simpleQuery(
                            "SELECT 'must-not-run-before-resume'::text AS status"
                        )
                    )
                }
                try await waitForQueuedOperation(manager: manager, timeout: .seconds(5))

                let readyEvents = events.snapshot()
                let latestApplicationState = readyEvents.last { event in
                    event.kind != .memoryWarning
                }
                try require(latestApplicationState?.kind == .active) {
                    "host was not active immediately before the background handoff"
                }
                let backgroundTransitionNotBefore = DispatchTime.now().uptimeNanoseconds
                observations["backgroundTransitionNotBeforeUptimeNanoseconds"] = String(
                    backgroundTransitionNotBefore
                )
                try journal.update(
                    phase: .readyForBackground,
                    events: events.snapshot()
                ) { report in
                    report.writeStartedAtUnixNanoseconds = writeStartedAt
                    report.checks = checks.sorted()
                    report.diagnostics = diagnostics
                    report.observations = observations
                }

                var transitionEvent: BrokerHostLifecycleEvent?
                while let event = await iterator.next() {
                    guard event.observedAtUptimeNanoseconds > backgroundTransitionNotBefore else {
                        continue
                    }
                    if event.kind == .inactive || event.kind == .background {
                        transitionEvent = event
                        break
                    }
                }
                let firstTransition = try requireValue(
                    transitionEvent,
                    "host lifecycle event stream ended before inactive/background"
                )
                observations["backgroundTransitionUptimeNanoseconds"] = String(
                    firstTransition.observedAtUptimeNanoseconds
                )
                if firstTransition.kind == .inactive {
                    try journal.update(
                        phase: .inactiveObserved,
                        events: events.snapshot()
                    ) { _ in }
                } else {
                    try journal.update(
                        phase: .backgroundObserved,
                        events: events.snapshot()
                    ) { _ in }
                }

                let backgroundDeadline = Date(
                    timeIntervalSinceNow: backgroundPreparationSeconds
                )
                let preparationStartedAt = DispatchTime.now().uptimeNanoseconds
                let preparation = Task {
                    try await openedControl.prepareForBackground(deadline: backgroundDeadline)
                }
                let paused = try await waitForAdmissionsPaused(
                    manager: manager,
                    epoch: initialEpoch,
                    timeout: .seconds(2)
                )
                try require(paused.admissionsPaused) {
                    "manager did not pause admissions during background preparation"
                }

                try await expectQueueClosed("query") {
                    _ = try await openedControl.execProtocolRaw(
                        try OliphauntProtocol.simpleQuery("SELECT 1")
                    )
                }
                try await expectQueueClosed("checkpoint") {
                    try await openedControl.checkpoint()
                }
                try await expectQueueClosed("logical open") {
                    let unexpected = try await manager.open(
                        configuration: brokerConfiguration,
                        databaseConfiguration: databaseConfiguration
                    )
                    try await unexpected.close()
                }

                let preparationResult = try await preparation.value
                let preparationFinishedAt = DispatchTime.now().uptimeNanoseconds
                try require(Date() < backgroundDeadline) {
                    "background preparation returned after its absolute deadline"
                }
                try require(preparationResult.cancelledActiveWork) {
                    "background preparation did not report active-work cancellation"
                }
                try await requirePostgresCancellation(backgroundSleep)
                try await requireQueuedCancellation(queuedQuery)

                let quiescedManager = await manager.diagnostics()
                let quiescedWorker = try await openedControl.workerDiagnostics()
                try require(quiescedManager.state == .quiescing(initialEpoch)) {
                    "manager did not remain quiescing after background preparation"
                }
                try require(quiescedManager.admissionsPaused) {
                    "manager reopened admissions before resume"
                }
                try require(
                    quiescedManager.queuedOperationCount == 0
                        && quiescedManager.activeRequestID == nil
                ) {
                    "manager retained active or queued work after background preparation"
                }
                try require(
                    quiescedWorker.state == "quiescing"
                        && quiescedWorker.activeRequestID == nil
                        && quiescedWorker.transactionStatus == "idle"
                ) {
                    "worker did not reach an idle quiescing state"
                }
                try requireAvailableMemory(quiescedWorker, phase: "quiesced")
                diagnostics.append(
                    evidence(
                        phase: "quiesced",
                        manager: quiescedManager,
                        worker: quiescedWorker
                    )
                )

                let protection = try decodeProtectionEvidence(
                    quiescedWorker.storageProtectionEvidenceJSON
                )
                try validateProtectionEvidence(
                    protection,
                    writeStartedAtUnixNanoseconds: writeStartedAt
                )
                observations["storageEntryCount"] = String(protection.entryCount)
                observations["storageRegularFileBytes"] = String(protection.regularFileBytes)
                observations["storageRelationFileCount"] = String(protection.relationFileCount)
                observations["storageWALFileCount"] = String(protection.walFileCount)
                observations["backgroundPreparationCheckpointed"] =
                    preparationResult.checkpointed ? "true" : "false"
                observations["backgroundPreparationElapsedNanoseconds"] = String(
                    preparationFinishedAt &- preparationStartedAt
                )
                checks.formUnion([
                    "backgroundCancellation",
                    "backgroundAdmissionClosed",
                    "backgroundDeadline",
                    "recursiveStorageProtection",
                    "relationAndWALFreshness",
                ])

                var backgroundEvent: BrokerHostLifecycleEvent?
                if firstTransition.kind == .background {
                    backgroundEvent = firstTransition
                } else {
                    while let event = await iterator.next() {
                        if event.kind == .background {
                            backgroundEvent = event
                            break
                        }
                    }
                }
                let observedBackground = try requireValue(
                    backgroundEvent,
                    "host lifecycle event stream ended before actual background"
                )
                observations["backgroundObservedUptimeNanoseconds"] = String(
                    observedBackground.observedAtUptimeNanoseconds
                )
                checks.insert("actualBackground")
                try journal.update(
                    phase: .backgroundObserved,
                    events: events.snapshot()
                ) { report in
                    report.checks = checks.sorted()
                    report.diagnostics = diagnostics
                    report.observations = observations
                    report.storageProtection = protection
                }
                try journal.update(
                    phase: .quiesced,
                    events: events.snapshot()
                ) { report in
                    report.checks = checks.sorted()
                    report.diagnostics = diagnostics
                    report.observations = observations
                    report.storageProtection = protection
                }

                var activeEvent: BrokerHostLifecycleEvent?
                while let event = await iterator.next() {
                    if event.kind == .active {
                        activeEvent = event
                        break
                    }
                }
                let observedActive = try requireValue(
                    activeEvent,
                    "host lifecycle event stream ended before foreground activation"
                )
                observations["resumedActiveUptimeNanoseconds"] = String(
                    observedActive.observedAtUptimeNanoseconds
                )
                try journal.update(
                    phase: .activeObserved,
                    events: events.snapshot()
                ) { report in
                    report.observations = observations
                }

                try await openedControl.resumeFromBackground()
                let resumedManager = await manager.diagnostics()
                let resumedWorker = try await openedControl.workerDiagnostics()
                let resumedDigest = try requireValue(
                    resumedWorker.manifestDigest,
                    "resumed worker diagnostics omitted the manifest digest"
                )
                try require(resumedDigest == initialManifestDigest) {
                    "resume changed the extension-private root manifest"
                }
                let resumedWithSamePID =
                    resumedWorker.extensionProcessIdentifier == initialPID
                let resumedWithSameEpoch = resumedWorker.epoch == initialEpoch
                if environment.expectWorkerKill {
                    try require(
                        !resumedWithSamePID && !resumedWithSameEpoch
                    ) {
                        "worker-kill qualification did not establish a fresh PID and epoch"
                    }
                    recoveredEpochs.append(resumedWorker.epoch.description)
                    checks.insert("backgroundWorkerKillRecovery")
                } else {
                    try require(resumedWithSamePID == resumedWithSameEpoch) {
                        "healthy background resume produced a mixed PID/epoch identity"
                    }
                    if resumedWithSamePID {
                        checks.insert("backgroundSameWorkerResume")
                    } else {
                        recoveredEpochs.append(resumedWorker.epoch.description)
                        checks.insert("backgroundFreshWorkerResume")
                    }
                }
                try require(
                    resumedManager.state == .ready(resumedWorker.epoch)
                        && !resumedManager.admissionsPaused
                ) {
                    "resume admitted work before the manager reached ready"
                }
                let resumedHealth = try await rawQuery(
                    openedControl,
                    "SELECT 'resumed'::text AS status"
                )
                try require(try resumedHealth.getText(row: 0, column: "status") == "resumed") {
                    "post-resume health query returned the wrong value"
                }
                try requireAvailableMemory(resumedWorker, phase: "resumed")
                diagnostics.append(
                    evidence(
                        phase: "resumed",
                        manager: resumedManager,
                        worker: resumedWorker
                    )
                )
                checks.formUnion(["backgroundResume", "postResumeHealth", "postResumeMemory"])
                try journal.update(
                    phase: .resumed,
                    events: events.snapshot()
                ) { report in
                    report.currentWorkerPID = resumedWorker.extensionProcessIdentifier
                    report.currentEpoch = resumedWorker.epoch.description
                    report.checks = checks.sorted()
                    report.diagnostics = diagnostics
                    report.observations = observations
                }

                let finalRelation = try await openedDatabase.query(
                    "SELECT count(*)::text AS row_count FROM broker_lifecycle_pressure"
                )
                try require(
                    try integerValue(
                        finalRelation,
                        column: "row_count",
                        label: "post-resume lifecycle relation row count"
                    ) == 8_192
                ) {
                    "post-resume relation content changed"
                }
                let finalMarkers = try await openedDatabase.query(
                    """
                    SELECT count(*)::text AS marker_count
                    FROM broker_lifecycle_launches
                    WHERE run_token = $1
                    """,
                    parameters: [.text(environment.runToken)]
                )
                try require(
                    try integerValue(
                        finalMarkers,
                        column: "marker_count",
                        label: "final lifecycle launch-marker count"
                    ) == environment.launchIndex
                ) {
                    "post-resume launch-marker history changed"
                }
                checks.insert("postResumePersistence")

                observations["initialWorkerPID"] = String(initialPID)
                observations["resumedWorkerPID"] = String(
                    resumedWorker.extensionProcessIdentifier
                )
                observations["resumedEpoch"] = resumedWorker.epoch.description
                let result = BrokerProbeResult(
                    hostPID: hostPID,
                    workerPID: initialPID,
                    epoch: initialEpoch.description,
                    checks: checks.sorted(),
                    recoveredEpochs: recoveredEpochs,
                    diagnostics: diagnostics,
                    observations: observations
                )

                try await openedDatabase.close()
                database = nil
                try await openedControl.close()
                controlSession = nil

                try journal.complete(
                    result: result,
                    diagnostics: diagnostics,
                    checks: checks.sorted(),
                    observations: observations,
                    storageProtection: protection,
                    events: events.snapshot()
                )
                return result
            } catch {
                if let database {
                    try? await database.cancel()
                    try? await database.close()
                }
                if let controlSession {
                    try? await controlSession.close()
                }
                try? journal.fail(
                    error: error,
                    diagnostics: diagnostics,
                    checks: checks.sorted(),
                    observations: observations,
                    events: events.snapshot()
                )
                throw error
            }
        }

        private static func verifyCrossLaunchPersistence(
            database: OliphauntDatabase,
            environment: DeviceLifecycleEnvironment
        ) async throws -> [String: String] {
            _ = try await database.execute(
                """
                CREATE TABLE IF NOT EXISTS broker_lifecycle_launches(
                    run_token text NOT NULL,
                    launch_index integer NOT NULL,
                    marker text NOT NULL,
                    created_at_unix_nanoseconds numeric NOT NULL,
                    PRIMARY KEY(run_token, launch_index)
                )
                """
            )
            let before = try await database.query(
                """
                SELECT
                    count(*)::text AS total,
                    count(*) FILTER (WHERE launch_index = 1)::text AS launch_one,
                    count(*) FILTER (WHERE launch_index = 2)::text AS launch_two
                FROM broker_lifecycle_launches
                WHERE run_token = $1
                """,
                parameters: [.text(environment.runToken)]
            )
            let total = try integerValue(before, column: "total", label: "prior marker count")
            let launchOne = try integerValue(
                before,
                column: "launch_one",
                label: "launch-one marker count"
            )
            let launchTwo = try integerValue(
                before,
                column: "launch_two",
                label: "launch-two marker count"
            )
            if environment.launchIndex == 1 {
                try require(total == 0 && launchOne == 0 && launchTwo == 0) {
                    "launch one found stale markers for its run token"
                }
            } else {
                try require(total == 1 && launchOne == 1 && launchTwo == 0) {
                    "launch two did not find exactly the launch-one marker"
                }
            }
            _ = try await database.query(
                """
                INSERT INTO broker_lifecycle_launches(
                    run_token,
                    launch_index,
                    marker,
                    created_at_unix_nanoseconds
                )
                VALUES ($1, $2::integer, $3, $4::numeric)
                """,
                parameters: [
                    .text(environment.runToken),
                    .text(String(environment.launchIndex)),
                    .text("\(environment.runToken):\(environment.launchIndex)"),
                    .text(String(deviceLifecycleUnixNanoseconds())),
                ]
            )
            let after = try await database.query(
                """
                SELECT count(*)::text AS total
                FROM broker_lifecycle_launches
                WHERE run_token = $1
                """,
                parameters: [.text(environment.runToken)]
            )
            try require(
                try integerValue(after, column: "total", label: "current marker count")
                    == environment.launchIndex
            ) {
                "current launch marker was not persisted exactly once"
            }
            return [
                "priorLaunchMarkerCount": String(total),
                "currentLaunchMarker":
                    "\(environment.runToken):\(environment.launchIndex)",
            ]
        }

        private static func recreateSizableRelation(
            database: OliphauntDatabase
        ) async throws {
            _ = try await database.execute(
                """
                CREATE EXTENSION IF NOT EXISTS vector;
                CREATE EXTENSION IF NOT EXISTS pg_trgm;
                DROP TABLE IF EXISTS broker_lifecycle_pressure;
                CREATE TABLE broker_lifecycle_pressure(
                    id integer PRIMARY KEY,
                    payload text NOT NULL
                );
                INSERT INTO broker_lifecycle_pressure(id, payload)
                SELECT
                    value,
                    (
                        SELECT string_agg(
                            md5(value::text || ':' || part::text),
                            ''
                            ORDER BY part
                        )
                        FROM generate_series(1, 128) AS parts(part)
                    )
                FROM generate_series(1, 8192) AS value;
                ANALYZE broker_lifecycle_pressure;
                """
            )
        }

        private static func rawQuery(
            _ session: IOSBrokerSession,
            _ sql: String
        ) async throws -> OliphauntQueryResult {
            try await parseOliphauntQueryResponse(
                session.execProtocolRaw(try OliphauntProtocol.simpleQuery(sql))
            )
        }

        private static func waitForActiveNativeRequest(
            session: IOSBrokerSession,
            timeout: Duration
        ) async throws -> IOSBrokerWorkerDiagnostics {
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: timeout)
            var lastError: (any Error)?
            while clock.now < deadline {
                do {
                    let diagnostics = try await session.workerDiagnostics()
                    if diagnostics.activeRequestID != nil && diagnostics.nativeDispatchStarted {
                        return diagnostics
                    }
                } catch {
                    lastError = error
                }
                try await Task.sleep(for: .milliseconds(20))
            }
            if let lastError { throw lastError }
            throw DeviceLifecycleFailure.assertion(
                "worker diagnostics did not observe active native dispatch"
            )
        }

        private static func waitForQueuedOperation(
            manager: IOSBrokerManager,
            timeout: Duration
        ) async throws {
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: timeout)
            while clock.now < deadline {
                let diagnostics = await manager.diagnostics()
                if diagnostics.queuedOperationCount > 0 {
                    return
                }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw DeviceLifecycleFailure.assertion(
                "manager diagnostics did not observe a queued operation"
            )
        }

        private static func waitForAdmissionsPaused(
            manager: IOSBrokerManager,
            epoch: BrokerEpoch,
            timeout: Duration
        ) async throws -> IOSBrokerDiagnostics {
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: timeout)
            while clock.now < deadline {
                let diagnostics = await manager.diagnostics()
                if diagnostics.admissionsPaused
                    && diagnostics.state == .quiescing(epoch)
                {
                    return diagnostics
                }
                try await Task.sleep(for: .milliseconds(10))
            }
            throw DeviceLifecycleFailure.assertion(
                "manager did not pause admissions while quiescing"
            )
        }

        private static func sampleActiveStreaming(
            session: IOSBrokerSession,
            counter: DeviceLifecycleStreamCounter,
            finished: DeviceLifecycleSignal,
            timeout: Duration
        ) async throws -> DeviceLifecycleActiveStreamSamples {
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: timeout)
            var lastError: (any Error)?
            var lastSampledChunkCount = 0
            var samples: [IOSBrokerWorkerDiagnostics] = []
            while clock.now < deadline {
                do {
                    let diagnostics = try await session.workerDiagnostics()
                    let chunkCount = counter.chunkCount
                    if chunkCount > lastSampledChunkCount,
                        diagnostics.activeRequestID != nil,
                        diagnostics.nativeDispatchStarted
                    {
                        try requireAvailableMemory(diagnostics, phase: "activeSlowStreaming")
                        samples.append(diagnostics)
                        lastSampledChunkCount = chunkCount
                    }
                } catch {
                    lastError = error
                }
                if finished.isSignaled { break }
                try await Task.sleep(for: .milliseconds(5))
            }
            guard finished.isSignaled else {
                if let lastError { throw lastError }
                throw DeviceLifecycleFailure.assertion(
                    "slow-reader probe did not finish before its sampling deadline"
                )
            }
            try require(samples.count > 1) {
                "slow-reader probe did not produce repeated active native-dispatch samples"
            }
            return try DeviceLifecycleActiveStreamSamples(samples: samples)
        }

        private static func measureProtocolRTT(
            session: IOSBrokerSession,
            sampleCount: Int
        ) async throws -> [Double] {
            try require(sampleCount > 0) {
                "protocol RTT sample count must be positive"
            }
            var milliseconds: [Double] = []
            milliseconds.reserveCapacity(sampleCount)
            for _ in 0..<sampleCount {
                let startedAt = DispatchTime.now().uptimeNanoseconds
                let result = try await rawQuery(session, "SELECT 1::text AS value")
                let finishedAt = DispatchTime.now().uptimeNanoseconds
                try require(try result.getText(row: 0, column: "value") == "1") {
                    "protocol RTT query returned the wrong value"
                }
                milliseconds.append(
                    Double(finishedAt &- startedAt) / 1_000_000
                )
            }
            return milliseconds.sorted()
        }

        private static func requirePostgresCancellation(
            _ task: Task<OliphauntQueryResult, any Error>
        ) async throws {
            do {
                _ = try await task.value
                throw DeviceLifecycleFailure.assertion(
                    "active pg_sleep completed without cancellation"
                )
            } catch OliphauntError.postgres(let postgresError) {
                try require(postgresError.sqlstate == "57014") {
                    "active pg_sleep cancellation returned SQLSTATE \(postgresError.sqlstate ?? "nil")"
                }
            }
        }

        private static func requireQueuedCancellation(
            _ task: Task<Data, any Error>
        ) async throws {
            do {
                _ = try await task.value
                throw DeviceLifecycleFailure.assertion(
                    "queued query completed instead of being canceled before dispatch"
                )
            } catch let error as BrokerError {
                guard case .canceled = error else { throw error }
            }
        }

        private static func expectQueueClosed(
            _ operationName: String,
            operation: () async throws -> Void
        ) async throws {
            do {
                try await operation()
                throw DeviceLifecycleFailure.assertion(
                    "\(operationName) was admitted while the broker was quiescing"
                )
            } catch let error as BrokerError {
                guard case .rejected(.queueClosed) = error else { throw error }
            }
        }

        private static func requireAvailableMemory(
            _ diagnostics: IOSBrokerWorkerDiagnostics,
            phase: String
        ) throws {
            try require((diagnostics.availableMemoryBytes ?? 0) > 0) {
                "\(phase) diagnostics omitted available process memory"
            }
            try require(
                (diagnostics.currentPhysFootprintBytes ?? 0) > 0
                    && (diagnostics.currentResidentBytes ?? 0) > 0
            ) {
                "\(phase) diagnostics omitted worker footprint or resident memory"
            }
        }

        private static func decodeProtectionEvidence(
            _ encoded: String?
        ) throws -> DeviceLifecycleStorageProtectionEvidence {
            let encoded = try requireValue(
                encoded,
                "quiesced diagnostics omitted recursive storage-protection evidence"
            )
            let data = Data(encoded.utf8)
            let object = try JSONSerialization.jsonObject(with: data)
            guard let dictionary = object as? [String: Any] else {
                throw DeviceLifecycleFailure.assertion(
                    "storage-protection evidence was not a JSON object"
                )
            }
            let allowedKeys: Set<String> = [
                "expectedProtection",
                "entryCount",
                "regularFileCount",
                "directoryCount",
                "otherEntryCount",
                "symbolicLinkCount",
                "matchingProtectionCount",
                "missingProtectionCount",
                "mismatchedProtectionCount",
                "protectionMetadataUnavailableCount",
                "unreadableEntryCount",
                "regularFileBytes",
                "relationFileCount",
                "walFileCount",
                "newestRelationModificationUnixNanoseconds",
                "newestWALModificationUnixNanoseconds",
                "enumerationFailed",
            ]
            let unexpectedKeys = Set(dictionary.keys).subtracting(allowedKeys)
            try require(unexpectedKeys.isEmpty) {
                "storage-protection evidence exposed unexpected fields: \(unexpectedKeys.sorted())"
            }
            return try JSONDecoder().decode(
                DeviceLifecycleStorageProtectionEvidence.self,
                from: data
            )
        }

        private static func validateProtectionEvidence(
            _ evidence: DeviceLifecycleStorageProtectionEvidence,
            writeStartedAtUnixNanoseconds: UInt64
        ) throws {
            try require(
                evidence.expectedProtection
                    == FileProtectionType.completeUntilFirstUserAuthentication.rawValue
            ) {
                "storage audit expected the wrong data-protection class"
            }
            try require(evidence.entryCount > 0 && evidence.regularFileBytes > 0) {
                "storage audit did not observe nonempty recursive storage"
            }
            try require(evidence.allEntriesMatchExpectedProtection) {
                "recursive storage entries did not all match the declared protection class"
            }
            try require(evidence.relationFileCount > 0 && evidence.walFileCount > 0) {
                "storage audit did not observe both relation and WAL files"
            }
            let earliestAccepted =
                writeStartedAtUnixNanoseconds > filesystemTimestampToleranceNanoseconds
                ? writeStartedAtUnixNanoseconds - filesystemTimestampToleranceNanoseconds
                : 0
            try require(
                (evidence.newestRelationModificationUnixNanoseconds ?? 0) >= earliestAccepted
            ) {
                "newest relation-file modification predates the lifecycle write"
            }
            try require(
                (evidence.newestWALModificationUnixNanoseconds ?? 0) >= earliestAccepted
            ) {
                "newest WAL-file modification predates the lifecycle write"
            }
        }

        private static func integerValue(
            _ result: OliphauntQueryResult,
            column: String,
            label: String
        ) throws -> Int {
            let text = try requireValue(
                result.getText(row: 0, column: column),
                "\(label) was NULL"
            )
            guard let value = Int(text) else {
                throw DeviceLifecycleFailure.assertion("\(label) was not an integer: \(text)")
            }
            return value
        }

        private static func unsignedIntegerValue(
            _ result: OliphauntQueryResult,
            column: String,
            label: String
        ) throws -> UInt64 {
            let text = try requireValue(
                result.getText(row: 0, column: column),
                "\(label) was NULL"
            )
            guard let value = UInt64(text) else {
                throw DeviceLifecycleFailure.assertion(
                    "\(label) was not an unsigned integer: \(text)"
                )
            }
            return value
        }

        private static func evidence(
            phase: String,
            manager: IOSBrokerDiagnostics,
            worker: IOSBrokerWorkerDiagnostics?,
            checkpointMemorySample: IOSBrokerCheckpointMemorySample? = nil
        ) -> BrokerDiagnosticEvidence {
            BrokerDiagnosticEvidence(
                phase: phase,
                managerState: managerState(manager.state),
                epoch: manager.epoch?.description,
                workerPID: manager.extensionProcessIdentifier,
                logicalHandleCount: manager.logicalHandleCount,
                queuedOperationCount: manager.queuedOperationCount,
                activeRequestID: worker?.activeRequestID?.rawValue
                    ?? manager.activeRequestID?.rawValue,
                launchCount: manager.launchCount,
                interruptionCount: manager.interruptionCount,
                admissionsPaused: manager.admissionsPaused,
                workerState: worker?.state,
                transactionStatus: worker?.transactionStatus,
                manifestDigest: worker?.manifestDigest,
                currentPhysFootprintBytes:
                    checkpointMemorySample?.physFootprintBytes
                    ?? worker?.currentPhysFootprintBytes,
                currentResidentBytes:
                    checkpointMemorySample?.residentBytes ?? worker?.currentResidentBytes,
                availableMemoryBytes:
                    checkpointMemorySample?.availableMemoryBytes
                    ?? worker?.availableMemoryBytes,
                nativeDispatchStarted: worker?.nativeDispatchStarted ?? false,
                checkpointInProgress: worker?.checkpointInProgress ?? false,
                storageProtectionEvidenceJSON: worker?.storageProtectionEvidenceJSON,
                extensionEntryPreOpenPhysFootprintBytes:
                    worker?.extensionEntryPreOpenPhysFootprintBytes,
                extensionEntryPreOpenResidentBytes:
                    worker?.extensionEntryPreOpenResidentBytes,
                openedIdlePhysFootprintBytes: worker?.openedIdlePhysFootprintBytes,
                openedIdleResidentBytes: worker?.openedIdleResidentBytes
            )
        }

        private static func managerState(_ state: IOSBrokerManagerState) -> String {
            switch state {
            case .unavailable: "unavailable"
            case .idle: "idle"
            case .launching: "launching"
            case .binding: "binding"
            case .recovering: "recovering"
            case .ready: "ready"
            case .quiescing: "quiescing"
            case .interrupted: "interrupted"
            case .closing: "closing"
            }
        }

        private static func require(
            _ condition: @autoclosure () throws -> Bool,
            _ message: () -> String
        ) throws {
            guard try condition() else {
                throw DeviceLifecycleFailure.assertion(message())
            }
        }

        private static func requireValue<T>(
            _ value: @autoclosure () throws -> T?,
            _ message: @autoclosure () -> String
        ) throws -> T {
            guard let value = try value() else {
                throw DeviceLifecycleFailure.assertion(message())
            }
            return value
        }
    }

    private struct DeviceLifecycleEnvironment: Sendable {
        var runToken: String
        var launchIndexText: String
        var expectWorkerKillText: String
        var orchestrationTimeoutSecondsText: String
        var launchIndex: Int = 0
        var expectWorkerKill = false
        var orchestrationTimeoutSeconds = 0

        static func capture() -> DeviceLifecycleEnvironment {
            let environment = ProcessInfo.processInfo.environment
            return DeviceLifecycleEnvironment(
                runToken: environment["OLIPHAUNT_BROKER_LIFECYCLE_RUN_TOKEN"] ?? "",
                launchIndexText:
                    environment["OLIPHAUNT_BROKER_LIFECYCLE_LAUNCH_INDEX"] ?? "",
                expectWorkerKillText:
                    environment["OLIPHAUNT_BROKER_LIFECYCLE_EXPECT_WORKER_KILL"] ?? "",
                orchestrationTimeoutSecondsText:
                    environment["OLIPHAUNT_BROKER_LIFECYCLE_ORCHESTRATION_TIMEOUT_SECONDS"] ?? ""
            )
        }

        func validated() throws -> DeviceLifecycleEnvironment {
            let token = runToken.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !token.isEmpty, token.utf8.count <= 256, !token.utf8.contains(0) else {
                throw DeviceLifecycleFailure.invalidEnvironment(
                    "OLIPHAUNT_BROKER_LIFECYCLE_RUN_TOKEN must be 1...256 UTF-8 bytes"
                )
            }
            guard let launchIndex = Int(launchIndexText), launchIndex == 1 || launchIndex == 2
            else {
                throw DeviceLifecycleFailure.invalidEnvironment(
                    "OLIPHAUNT_BROKER_LIFECYCLE_LAUNCH_INDEX must be 1 or 2"
                )
            }
            let normalizedKill = expectWorkerKillText.uppercased()
            guard normalizedKill == "YES" || normalizedKill == "NO" else {
                throw DeviceLifecycleFailure.invalidEnvironment(
                    "OLIPHAUNT_BROKER_LIFECYCLE_EXPECT_WORKER_KILL must be YES or NO"
                )
            }
            guard
                let orchestrationTimeoutSeconds = Int(orchestrationTimeoutSecondsText),
                (30...600).contains(orchestrationTimeoutSeconds)
            else {
                throw DeviceLifecycleFailure.invalidEnvironment(
                    "OLIPHAUNT_BROKER_LIFECYCLE_ORCHESTRATION_TIMEOUT_SECONDS must be 30...600"
                )
            }
            var value = self
            value.runToken = token
            value.launchIndex = launchIndex
            value.expectWorkerKill = normalizedKill == "YES"
            value.orchestrationTimeoutSeconds = orchestrationTimeoutSeconds
            return value
        }
    }

    private enum DeviceLifecycleJournalPhase: String, Codable, Sendable {
        case starting
        case foregroundActive
        case foregroundQualification
        case readyForBackground
        case inactiveObserved
        case backgroundObserved
        case quiesced
        case activeObserved
        case resumed
        case completed
        case failed
    }

    private struct DeviceLifecycleStorageProtectionEvidence: Codable, Equatable, Sendable {
        var expectedProtection = ""
        var entryCount = 0
        var regularFileCount = 0
        var directoryCount = 0
        var otherEntryCount = 0
        var symbolicLinkCount = 0
        var matchingProtectionCount = 0
        var missingProtectionCount = 0
        var mismatchedProtectionCount = 0
        var protectionMetadataUnavailableCount = 0
        var unreadableEntryCount = 0
        var regularFileBytes: UInt64 = 0
        var relationFileCount = 0
        var walFileCount = 0
        var newestRelationModificationUnixNanoseconds: UInt64?
        var newestWALModificationUnixNanoseconds: UInt64?
        var enumerationFailed = false

        var allEntriesMatchExpectedProtection: Bool {
            !enumerationFailed
                && unreadableEntryCount == 0
                && missingProtectionCount == 0
                && mismatchedProtectionCount == 0
                && protectionMetadataUnavailableCount == 0
                && symbolicLinkCount == 0
                && entryCount == matchingProtectionCount
        }
    }

    private struct DeviceLifecycleJournalReport: Codable {
        var schemaVersion = 1
        var status = "running"
        var phase = DeviceLifecycleJournalPhase.starting
        var runToken = ""
        var launchIndex = 0
        var expectWorkerKill = false
        var hostPID: Int32?
        var initialWorkerPID: Int32?
        var initialEpoch: String?
        var currentWorkerPID: Int32?
        var currentEpoch: String?
        var manifestDigest: String?
        var updatedAtUnixNanoseconds: UInt64 = deviceLifecycleUnixNanoseconds()
        var writeStartedAtUnixNanoseconds: UInt64?
        var checks: [String] = []
        var events: [BrokerHostLifecycleEvent] = []
        var diagnostics: [BrokerDiagnosticEvidence] = []
        var observations: [String: String] = [:]
        var storageProtection: DeviceLifecycleStorageProtectionEvidence?
        var result: BrokerProbeResult?
        var error: String?
    }

    private final class DeviceLifecycleJournalWriter {
        private let url: URL
        private var report: DeviceLifecycleJournalReport

        init(environment: DeviceLifecycleEnvironment) throws {
            guard
                let documents = FileManager.default.urls(
                    for: .documentDirectory,
                    in: .userDomainMask
                ).first
            else {
                throw DeviceLifecycleFailure.assertion("host Documents directory is unavailable")
            }
            url = documents.appendingPathComponent(
                "broker-lifecycle-report.json",
                isDirectory: false
            )
            report = DeviceLifecycleJournalReport(
                runToken: environment.runToken,
                launchIndex: Int(environment.launchIndexText) ?? 0,
                expectWorkerKill: environment.expectWorkerKillText.uppercased() == "YES"
            )
            try persist()
            publishPhase()
        }

        func update(
            phase: DeviceLifecycleJournalPhase,
            events: [BrokerHostLifecycleEvent],
            _ update: (inout DeviceLifecycleJournalReport) -> Void
        ) throws {
            report.phase = phase
            report.events = events
            report.updatedAtUnixNanoseconds = deviceLifecycleUnixNanoseconds()
            update(&report)
            try persist()
            publishPhase()
        }

        func complete(
            result: BrokerProbeResult,
            diagnostics: [BrokerDiagnosticEvidence],
            checks: [String],
            observations: [String: String],
            storageProtection: DeviceLifecycleStorageProtectionEvidence,
            events: [BrokerHostLifecycleEvent]
        ) throws {
            report.status = "pass"
            report.phase = .completed
            report.result = result
            report.diagnostics = diagnostics
            report.checks = checks
            report.observations = observations
            report.storageProtection = storageProtection
            report.events = events
            report.updatedAtUnixNanoseconds = deviceLifecycleUnixNanoseconds()
            report.error = nil
            try persist()
            publishPhase()
        }

        func fail(
            error: any Error,
            diagnostics: [BrokerDiagnosticEvidence],
            checks: [String],
            observations: [String: String],
            events: [BrokerHostLifecycleEvent]
        ) throws {
            report.status = "fail"
            report.phase = .failed
            report.error = String(describing: error)
            report.diagnostics = diagnostics
            report.checks = checks
            report.observations = observations
            report.events = events
            report.updatedAtUnixNanoseconds = deviceLifecycleUnixNanoseconds()
            try persist()
            publishPhase()
        }

        private func persist() throws {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            try encoder.encode(report).write(to: url, options: .atomic)
        }

        private func publishPhase() {
            print(
                "OLIPHAUNT_BROKER_LIFECYCLE phase=\(report.phase.rawValue) status=\(report.status)"
            )
        }
    }

    private final class DeviceLifecycleSignal: @unchecked Sendable {
        private let lock = NSLock()
        private var signaled = false

        var isSignaled: Bool {
            lock.lock()
            defer { lock.unlock() }
            return signaled
        }

        func signal() {
            lock.lock()
            signaled = true
            lock.unlock()
        }
    }

    private struct DeviceLifecycleActiveStreamSamples: Sendable {
        var representative: IOSBrokerWorkerDiagnostics
        var count: Int
        var peakPhysFootprintBytes: UInt64
        var minimumAvailableMemoryBytes: UInt64

        init(samples: [IOSBrokerWorkerDiagnostics]) throws {
            guard
                let representative = samples.max(by: {
                    ($0.currentPhysFootprintBytes ?? 0) < ($1.currentPhysFootprintBytes ?? 0)
                }),
                let minimumAvailableMemoryBytes = samples.compactMap(\.availableMemoryBytes).min()
            else {
                throw DeviceLifecycleFailure.assertion(
                    "active stream samples omitted physical-footprint or available-memory evidence"
                )
            }
            self.representative = representative
            count = samples.count
            peakPhysFootprintBytes = representative.currentPhysFootprintBytes ?? 0
            self.minimumAvailableMemoryBytes = minimumAvailableMemoryBytes
        }
    }

    private final class DeviceLifecycleStreamCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var bytes = 0
        private var chunks = 0

        func consume(_ data: Data) {
            lock.lock()
            bytes += data.count
            chunks += 1
            lock.unlock()
        }

        var byteCount: Int {
            lock.lock()
            defer { lock.unlock() }
            return bytes
        }

        var chunkCount: Int {
            lock.lock()
            defer { lock.unlock() }
            return chunks
        }
    }

    private enum DeviceLifecycleFailure: Error, CustomStringConvertible {
        case invalidEnvironment(String)
        case assertion(String)

        var description: String {
            switch self {
            case .invalidEnvironment(let message):
                "device lifecycle environment is invalid: \(message)"
            case .assertion(let message):
                "device lifecycle assertion failed: \(message)"
            }
        }
    }
#endif

private func deviceLifecycleUnixNanoseconds(_ date: Date = Date()) -> UInt64 {
    let interval = date.timeIntervalSince1970
    guard interval.isFinite, interval >= 0,
        interval < Double(UInt64.max) / 1_000_000_000
    else {
        return 0
    }
    return UInt64((interval * 1_000_000_000).rounded())
}
