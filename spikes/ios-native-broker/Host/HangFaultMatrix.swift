#if DEBUG && canImport(OliphauntIOSBroker)
    import Foundation
    import Oliphaunt
    import OliphauntBrokerProtocol
    import OliphauntIOSBroker

    /// Runs last, in its own launch. It measures whether the selected teardown
    /// strategy obtains a fresh, Ready worker after deliberately wedging WorkerCore.
    enum HangFaultMatrix {
        private static let maximumRecoveryDelayMilliseconds = 60_000

        static func run() async throws -> BrokerProbeResult {
            let configuredRecoveryDelayMilliseconds = try recoveryDelayMilliseconds()
            let recoveryStrategy = try hangRecoveryStrategy()
            let manager = IOSBrokerManager()
            let brokerConfiguration = IOSBrokerConfiguration(
                expectedABI: 6,
                startupConfigurationDigest: "ios-native-broker-spike-v2-restricted-role",
                requestDeadline: .seconds(5),
                extensionBundleIdentifier:
                    BrokerFixtureBundleIdentifiers.extensionBundleIdentifier,
                controlReplyTimeout: .seconds(5),
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
            let initialManager = await manager.diagnostics()
            let initial = try await control.workerDiagnostics()
            guard !initial.capabilities.hangRestartable else {
                throw HangFaultFailure.assertion("worker overclaimed hang restartability")
            }

            let faultAcknowledgementStartedAt = ContinuousClock.now
            let deadlockFault: BrokerWorkerFault =
                recoveryStrategy == "selfExitWatchdog" ? .deadlockWithFailStop : .deadlock
            try await control.injectFault(deadlockFault)
            let faultAcknowledgementElapsedMilliseconds = elapsedMilliseconds(
                faultAcknowledgementStartedAt.duration(to: .now)
            )
            let postAcknowledgement = try await control.workerDiagnostics()
            guard
                postAcknowledgement.extensionProcessIdentifier
                    == initial.extensionProcessIdentifier,
                postAcknowledgement.epoch == initial.epoch
            else {
                throw HangFaultFailure.assertion(
                    "worker identity changed before the armed deadlock was triggered"
                )
            }
            let postAcknowledgementManager = await manager.diagnostics()
            guard
                postAcknowledgementManager.interruptionCount
                    == initialManager.interruptionCount
            else {
                throw HangFaultFailure.assertion(
                    "fault acknowledgement interrupted the worker before the trigger query"
                )
            }

            let heartbeat = await MainActor.run { MainActorHeartbeat() }
            let hangTriggerStartedAt = ContinuousClock.now
            let hangingQuery = Task.detached {
                try await database.query("SELECT 'must-not-complete'::text AS status")
            }
            try await Task.sleep(for: .milliseconds(250))
            await MainActor.run {
                heartbeat.beat()
            }
            guard await MainActor.run(body: { heartbeat.wasObserved }) else {
                throw HangFaultFailure.assertion("main actor did not remain responsive")
            }

            var timeoutDescription = ""
            do {
                _ = try await hangingQuery.value
                throw HangFaultFailure.assertion("armed WorkerCore deadlock did not trigger")
            } catch let error as BrokerError {
                switch error {
                case .deadlineExceeded, .workerInterrupted, .outcomeUnknown:
                    timeoutDescription = error.description
                default:
                    throw error
                }
            }
            let hangTriggerElapsedMilliseconds = elapsedMilliseconds(
                hangTriggerStartedAt.duration(to: .now)
            )
            let interrupted = await manager.diagnostics()
            guard
                interrupted.interruptionCount
                    > postAcknowledgementManager.interruptionCount
            else {
                throw HangFaultFailure.assertion("hang timeout did not invalidate the epoch")
            }

            let recoveryDelayStartedAt = ContinuousClock.now
            if configuredRecoveryDelayMilliseconds > 0 {
                try await Task.sleep(
                    for: .milliseconds(Int64(configuredRecoveryDelayMilliseconds))
                )
            }
            let actualRecoveryDelayMilliseconds = elapsedMilliseconds(
                recoveryDelayStartedAt.duration(to: .now)
            )

            var observations: [String: String] = [
                "actualHangRecoveryDelayMilliseconds": String(actualRecoveryDelayMilliseconds),
                "configuredHangRecoveryDelayMilliseconds": String(
                    configuredRecoveryDelayMilliseconds),
                "faultAcknowledged": "true",
                "faultAcknowledgementElapsedMilliseconds": String(
                    faultAcknowledgementElapsedMilliseconds),
                "hangTriggerElapsedMilliseconds": String(hangTriggerElapsedMilliseconds),
                "hangTriggerOutcome": timeoutDescription,
                "initialWorkerPID": String(initial.extensionProcessIdentifier),
                "initialEpoch": initial.epoch.description,
                "initialLaunchAttemptCount": String(initialManager.launchAttemptCount),
                "interruptedLaunchAttemptCount": String(interrupted.launchAttemptCount),
                "initialLaunchCount": String(initialManager.launchCount),
                "interruptedLaunchCount": String(interrupted.launchCount),
                "postAckEpoch": postAcknowledgement.epoch.description,
                "postAckInterruptionCount": String(
                    postAcknowledgementManager.interruptionCount),
                "postAckWorkerPID": String(postAcknowledgement.extensionProcessIdentifier),
                "postAckWorkerResponsive": "true",
                "timeout": timeoutDescription,
                "hangRestartableCapability": "false",
                "hangRecoveryStrategy": recoveryStrategy,
            ]
            var recoveredEpochs: [String] = []
            var freshProcessObtained = false
            do {
                let health = try await database.query("SELECT 'healthy'::text AS status")
                guard try health.getText(row: 0, column: "status") == "healthy" else {
                    throw HangFaultFailure.assertion("fresh worker health check returned bad data")
                }
                let recovered = try await control.workerDiagnostics()
                observations["recoveredWorkerPID"] = String(
                    recovered.extensionProcessIdentifier)
                observations["recoveredEpoch"] = recovered.epoch.description
                let freshEpoch = recovered.epoch != initial.epoch
                let freshProcessIdentifier =
                    recovered.extensionProcessIdentifier != initial.extensionProcessIdentifier
                if freshEpoch && freshProcessIdentifier {
                    freshProcessObtained = true
                    observations["freshProcessObtained"] = "true"
                    recoveredEpochs.append(recovered.epoch.description)
                } else {
                    observations["freshProcessObtained"] = "false"
                    observations["recoveryFailure"] =
                        "replacement did not establish both a fresh epoch and a different PID"
                }
            } catch {
                observations["freshProcessObtained"] = "false"
                observations["recoveryFailure"] = String(describing: error)
            }
            let afterRecoveryAttempt = await manager.diagnostics()
            guard afterRecoveryAttempt.launchAttemptCount > interrupted.launchAttemptCount else {
                throw HangFaultFailure.assertion(
                    "post-hang operation did not attempt replacement process initialization"
                )
            }
            guard afterRecoveryAttempt.launchCount >= interrupted.launchCount else {
                throw HangFaultFailure.assertion("post-hang successful launch count regressed")
            }
            if freshProcessObtained,
                afterRecoveryAttempt.launchCount <= interrupted.launchCount
            {
                throw HangFaultFailure.assertion(
                    "fresh-process classification had no validated Ready launch"
                )
            }
            observations["postRecoveryLaunchAttemptCount"] = String(
                afterRecoveryAttempt.launchAttemptCount
            )
            observations["replacementLaunchAttemptDelta"] = String(
                afterRecoveryAttempt.launchAttemptCount - interrupted.launchAttemptCount
            )
            observations["postRecoveryLaunchCount"] = String(
                afterRecoveryAttempt.launchCount
            )
            observations["successfulLaunchCountDelta"] = String(
                afterRecoveryAttempt.launchCount - interrupted.launchCount
            )

            try? await database.close()
            try? await control.close()
            return BrokerProbeResult(
                hostPID: Int32(ProcessInfo.processInfo.processIdentifier),
                workerPID: initial.extensionProcessIdentifier,
                epoch: initial.epoch.description,
                checks: [
                    "hangCapabilityConservative",
                    "hangTimeout",
                    "mainActorResponsiveDuringHang",
                    "oldHangEpochInvalidated",
                    "replacementLaunchAttempted",
                ],
                recoveredEpochs: recoveredEpochs,
                observations: observations
            )
        }

        private static func recoveryDelayMilliseconds() throws -> Int {
            let variable = "OLIPHAUNT_BROKER_HANG_RECOVERY_DELAY_MILLISECONDS"
            guard let rawValue = ProcessInfo.processInfo.environment[variable] else {
                return 0
            }
            guard let value = Int(rawValue),
                (0...maximumRecoveryDelayMilliseconds).contains(value)
            else {
                throw HangFaultFailure.assertion(
                    "\(variable) must be an integer from 0 through \(maximumRecoveryDelayMilliseconds)"
                )
            }
            return value
        }

        private static func hangRecoveryStrategy() throws -> String {
            let variable = "OLIPHAUNT_BROKER_HANG_RECOVERY_STRATEGY"
            let value = ProcessInfo.processInfo.environment[variable] ?? "public"
            let supported = [
                "public",
                "selfExitWatchdog",
            ]
            guard supported.contains(value) else {
                throw HangFaultFailure.assertion(
                    "\(variable) must be one of \(supported.joined(separator: ", "))"
                )
            }
            return value
        }

        private static func elapsedMilliseconds(_ duration: Duration) -> Int64 {
            let components = duration.components
            return components.seconds * 1_000
                + components.attoseconds / 1_000_000_000_000_000
        }
    }

    @MainActor
    private final class MainActorHeartbeat {
        private(set) var wasObserved = false

        func beat() {
            wasObserved = true
        }
    }

    private enum HangFaultFailure: Error, CustomStringConvertible {
        case assertion(String)

        var description: String {
            switch self {
            case .assertion(let message): "hang fault matrix failed: \(message)"
            }
        }
    }
#endif
