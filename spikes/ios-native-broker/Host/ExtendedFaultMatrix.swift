#if DEBUG && canImport(OliphauntIOSBroker)
    import Foundation
    import Oliphaunt
    import OliphauntBrokerProtocol
    import OliphauntIOSBroker

    /// Destructive DEBUG-only fault matrix. The ordinary semantic fixture remains
    /// stable; the simulator runner selects this mode explicitly in a separate
    /// installed-app launch.
    enum ExtendedFaultMatrix {
        static func run() async throws -> BrokerProbeResult {
            let manager = IOSBrokerManager()
            let brokerConfiguration = IOSBrokerConfiguration(
                expectedABI: 6,
                startupConfigurationDigest: "ios-native-broker-spike-v2-restricted-role",
                maximumRequestBytes: OliphauntBrokerProtocol.defaultMaximumRequestBytes,
                requestDeadline: .seconds(6),
                extensionBundleIdentifier:
                    BrokerFixtureBundleIdentifiers.extensionBundleIdentifier,
                controlReplyTimeout: .seconds(6),
                cancellationGracePeriod: .seconds(1)
            )
            let databaseConfiguration = OliphauntConfiguration(
                mode: .nativeBroker,
                durability: .safe,
                runtimeFootprint: .smallMobile,
                extensions: ["pg_trgm", "vector"]
            )
            let engine = IOSBrokerEngine(
                configuration: brokerConfiguration,
                manager: manager
            )
            let control = try await manager.open(
                configuration: brokerConfiguration,
                databaseConfiguration: databaseConfiguration
            )
            let database = try await OliphauntDatabase.open(
                configuration: databaseConfiguration,
                engine: engine
            )
            let initial = try await control.workerDiagnostics()
            var current = initial
            var checks = Set<String>()
            var recoveredEpochs: [String] = []
            var observations: [String: String] = [
                "initialWorkerPID": String(initial.extensionProcessIdentifier),
                "initialManifestDigest": initial.manifestDigest ?? "",
            ]

            let capabilities = try await database.capabilities()
            try require(!capabilities.backupRestore) {
                "broker advertised whole-archive backup/restore"
            }
            checks.insert("archiveBoundaryRejected")

            var differentRoot = databaseConfiguration
            differentRoot.root = URL(fileURLWithPath: "/tmp/not-broker-default")
            do {
                _ = try await manager.open(
                    configuration: brokerConfiguration,
                    databaseConfiguration: differentRoot
                )
                throw ExtendedFaultFailure.assertion("a different broker root was accepted")
            } catch let error as BrokerError {
                guard case .rootMismatch = error else { throw error }
            }
            checks.insert("differentRootRejected")

            _ = try await database.execute(
                """
                CREATE TABLE IF NOT EXISTS broker_fault_matrix(
                    marker text PRIMARY KEY
                );
                DELETE FROM broker_fault_matrix;
                """
            )

            let racingSession = try await engine.open(
                configuration: databaseConfiguration
            )
            guard let racingControl = racingSession as? IOSBrokerSession else {
                throw ExtendedFaultFailure.assertion(
                    "broker engine did not return IOSBrokerSession for race fixture"
                )
            }
            let racingExecution = Task {
                try await racingControl.execProtocolRaw(
                    try OliphauntProtocol.simpleQuery("SELECT pg_sleep(3)")
                )
            }
            try await waitForNativeExecution(manager, session: racingControl)
            let racingCancel = Task { try await cancelDuringCloseRace(racingControl) }
            let racingClose = Task { try await racingControl.close() }
            let cancelControlOutcome = try await racingCancel.value
            try await racingClose.value
            let response = try await racingExecution.value
            let raceTerminal = try cancellationTerminal(from: response)
            observations["closeCancelCompletionTerminal"] = raceTerminal
            observations["closeCancelControlOutcome"] = cancelControlOutcome
            let postRaceHealth = try await database.query(
                "SELECT 'live-after-race'::text AS status"
            )
            try require(
                try postRaceHealth.getText(row: 0, column: "status") == "live-after-race"
            ) {
                "physical session was not live after close/cancel/completion race"
            }
            let postRaceManager = await manager.diagnostics()
            try require(
                postRaceManager.activeRequestID == nil
                    && postRaceManager.queuedOperationCount == 0
            ) {
                "close/cancel/completion race left a request pending"
            }
            checks.insert("closeCancelCompletionRace")

            try await control.injectFault(.beforeNativeDispatch)
            try await expectOutcomeUnknown {
                _ = try await database.execute(
                    "INSERT INTO broker_fault_matrix(marker) VALUES ('before-dispatch')"
                )
            }
            current = try await recover(
                from: current,
                control: control,
                database: database,
                recoveredEpochs: &recoveredEpochs
            )
            let beforeDispatch = try await database.query(
                "SELECT count(*)::text AS count FROM broker_fault_matrix WHERE marker = 'before-dispatch'"
            )
            try require(try beforeDispatch.getText(row: 0, column: "count") == "0") {
                "the before-dispatch crash reached PostgreSQL"
            }
            checks.formUnion(["beforeDispatchCrash", "beforeDispatchNotReplayed"])

            let partial = LockedFaultStreamCounter()
            try await control.injectFault(.afterResponseChunks)
            try await expectOutcomeUnknown {
                try await control.execProtocolStream(
                    try OliphauntProtocol.simpleQuery(
                        "SELECT repeat('f', 4096) FROM generate_series(1, 512)"
                    )
                ) { chunk in
                    partial.consume(chunk)
                }
            }
            try require(partial.byteCount > 0) {
                "after-N-chunks crash delivered no partial streaming evidence"
            }
            observations["partialResponseBytesBeforeCrash"] = String(partial.byteCount)
            observations["partialResponseChunksBeforeCrash"] = String(partial.chunkCount)
            current = try await recover(
                from: current,
                control: control,
                database: database,
                recoveredEpochs: &recoveredEpochs
            )
            checks.formUnion(["afterResponseChunksCrash", "partialStreamOutcomeUnknown"])

            try await control.injectFault(.duringCheckpoint)
            try await expectControlInterruption {
                try await control.checkpoint()
            }
            current = try await recover(
                from: current,
                control: control,
                database: database,
                recoveredEpochs: &recoveredEpochs
            )
            checks.insert("checkpointCrashRecovery")

            try await expectControlInterruption {
                try await control.injectFault(.abort)
            }
            current = try await recover(
                from: current,
                control: control,
                database: database,
                recoveredEpochs: &recoveredEpochs
            )
            checks.insert("idleAbortRecovery")

            try await expectControlInterruption {
                try await control.injectFault(.invalidMemoryAccess)
            }
            current = try await recover(
                from: current,
                control: control,
                database: database,
                recoveredEpochs: &recoveredEpochs
            )
            checks.insert("idleSIGSEGVRecovery")

            observations["finalWorkerPID"] = String(current.extensionProcessIdentifier)
            observations["finalManifestDigest"] = current.manifestDigest ?? ""
            observations["recoveryCount"] = String(recoveredEpochs.count)
            try require(current.manifestDigest == initial.manifestDigest) {
                "fault recovery changed the resident root manifest"
            }

            try await database.close()
            try await control.close()
            return BrokerProbeResult(
                hostPID: Int32(ProcessInfo.processInfo.processIdentifier),
                workerPID: initial.extensionProcessIdentifier,
                epoch: initial.epoch.description,
                checks: checks.sorted(),
                recoveredEpochs: recoveredEpochs,
                observations: observations
            )
        }

        private static func recover(
            from stale: IOSBrokerWorkerDiagnostics,
            control: IOSBrokerSession,
            database: OliphauntDatabase,
            recoveredEpochs: inout [String]
        ) async throws -> IOSBrokerWorkerDiagnostics {
            let probe = try await database.query("SELECT 'healthy'::text AS status")
            try require(try probe.getText(row: 0, column: "status") == "healthy") {
                "post-fault health check failed"
            }
            let recovered = try await control.workerDiagnostics()
            try require(recovered.epoch != stale.epoch) {
                "fault recovery reused the stale epoch"
            }
            try require(recovered.extensionProcessIdentifier != stale.extensionProcessIdentifier) {
                "crash recovery reused the dead worker PID"
            }
            try require(recovered.manifestDigest == stale.manifestDigest) {
                "crash recovery changed the root manifest digest"
            }
            recoveredEpochs.append(recovered.epoch.description)
            return recovered
        }

        private static func expectOutcomeUnknown(
            _ operation: () async throws -> Void
        ) async throws {
            do {
                try await operation()
            } catch let error as BrokerError {
                guard case .outcomeUnknown = error else { throw error }
                return
            }
            throw ExtendedFaultFailure.assertion(
                "faulted data operation completed without OutcomeUnknown"
            )
        }

        private static func expectControlInterruption(
            _ operation: () async throws -> Void
        ) async throws {
            do {
                try await operation()
            } catch let error as BrokerError {
                switch error {
                case .workerInterrupted, .deadlineExceeded:
                    return
                default:
                    throw error
                }
            }
            throw ExtendedFaultFailure.assertion(
                "fatal control fault unexpectedly returned success"
            )
        }

        private static func waitForNativeExecution(
            _ manager: IOSBrokerManager,
            session: IOSBrokerSession
        ) async throws {
            for _ in 0..<100 {
                let host = await manager.diagnostics()
                if let activeRequestID = host.activeRequestID,
                    let worker = try? await session.workerDiagnostics(),
                    worker.activeRequestID == activeRequestID,
                    worker.nativeDispatchStarted
                {
                    return
                }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw ExtendedFaultFailure.assertion(
                "close/cancel/completion race never reached native execution"
            )
        }

        /// Running cancellation deliberately returns PostgreSQL's normal backend
        /// ErrorResponse + ReadyForQuery bytes before the broker sends Completed.
        /// `execProtocolRaw` therefore succeeds at the transport layer; parse those
        /// bytes so a real SQL completion cannot impersonate a canceled terminal.
        private static func cancellationTerminal(from response: Data) throws -> String {
            do {
                _ = try parseOliphauntQueryResponse(response)
            } catch OliphauntError.postgres(let postgresError) {
                guard postgresError.sqlstate == "57014" else {
                    throw OliphauntError.postgres(postgresError)
                }
                return "postgresCanceledCompleted"
            }
            throw ExtendedFaultFailure.assertion(
                "close/cancel/completion race returned a successful PostgreSQL result"
            )
        }

        private static func cancelDuringCloseRace(
            _ session: IOSBrokerSession
        ) async throws -> String {
            do {
                try await session.cancel()
                return "acknowledged"
            } catch OliphauntError.databaseClosed {
                return "databaseClosed"
            } catch BrokerError.databaseClosed {
                return "databaseClosed"
            }
        }

        private static func require(
            _ condition: @autoclosure () throws -> Bool,
            _ message: () -> String
        ) throws {
            guard try condition() else {
                throw ExtendedFaultFailure.assertion(message())
            }
        }
    }

    private enum ExtendedFaultFailure: Error, CustomStringConvertible {
        case assertion(String)

        var description: String {
            switch self {
            case .assertion(let message): "extended fault matrix failed: \(message)"
            }
        }
    }

    private final class LockedFaultStreamCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var bytes = 0
        private var chunks = 0

        func consume(_ chunk: Data) {
            lock.lock()
            bytes += chunk.count
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
#endif
