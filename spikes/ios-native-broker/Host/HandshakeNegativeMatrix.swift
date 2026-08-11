#if canImport(OliphauntIOSBroker)
    import ExtensionFoundation
    import Foundation
    import OliphauntBrokerProtocol
    import OliphauntBrokerXPC
    import OliphauntIOSBroker
    import XPC

    enum HandshakeNegativeMatrix {
        static func run() async throws -> BrokerProbeResult {
            let monitor = try await AppExtensionPoint.Monitor(appExtensionPoint: .oliphauntBroker)
            guard
                let identity = monitor.identities.first(where: {
                    $0.bundleIdentifier == BrokerFixtureBundleIdentifiers.extensionBundleIdentifier
                })
            else {
                throw HandshakeMatrixFailure.assertion("broker extension was not discovered")
            }
            let process = try await AppExtensionProcess(
                configuration: .init(appExtensionIdentity: identity, onInterruption: {})
            )
            let session = try process.makeXPCSession()
            session.setTargetQueue(
                DispatchQueue(label: "dev.oliphaunt.brokerspike.negative-handshake")
            )
            session.setCancellationHandler { _ in }
            session.setIncomingMessageHandler { (_: XPCDictionary) in nil }
            try session.activate()
            defer {
                session.cancel(reason: "negative handshake matrix complete")
                process.invalidate()
            }

            let capabilities: Set<BrokerCapability> = [
                .processIsolated,
                .crashRestartable,
                .sameRootLogicalReopen,
                .protocolRaw,
                .protocolStream,
                .queryCancel,
            ]
            let valid = BrokerHello(
                expectedABI: 6,
                startupConfigurationDigest: "ios-native-broker-spike-v2-restricted-role",
                requestedCapabilities: capabilities
            )
            var checks = Set<String>()

            var incompatibleProtocol = valid
            incompatibleProtocol.minimumProtocolVersion = 99
            incompatibleProtocol.maximumProtocolVersion = 99
            try await expectRejection(
                incompatibleProtocol,
                through: session,
                expected: .incompatibleProtocol
            )
            checks.insert("incompatibleProtocolRejected")

            var incompatibleABI = valid
            incompatibleABI.expectedABI = 7
            try await expectRejection(
                incompatibleABI,
                through: session,
                expected: .incompatibleABI
            )
            checks.insert("incompatibleABIRejected")

            var runtimeMismatch = valid
            runtimeMismatch.expectedRuntimeVersion = "not-the-linked-runtime"
            try await expectRejection(
                runtimeMismatch,
                through: session,
                expected: .runtimeMismatch
            )
            checks.insert("runtimeMismatchRejected")

            var rootMismatch = valid
            rootMismatch.rootID = "different-root"
            try await expectRejection(
                rootMismatch,
                through: session,
                expected: .rootMismatch
            )
            checks.insert("rootMismatchRejected")

            var configurationMismatch = valid
            configurationMismatch.startupConfigurationDigest = "different-configuration"
            try await expectRejection(
                configurationMismatch,
                through: session,
                expected: .invalidConfiguration
            )
            checks.insert("startupConfigurationRejected")

            let pair = try ProbeSocketPair()
            let owned = try IOSBrokerOwnedFileDescriptor(
                takingOwnershipOf: pair.takeWorkerDescriptor()
            )
            let message = try IOSBrokerXPC.makeHello(valid, dataChannel: owned)
            owned.close()
            let ready = try IOSBrokerXPC.decodeReady(
                try await session.handshakeMatrixRequest(message)
            )
            guard ready.extensionPID != Int32(ProcessInfo.processInfo.processIdentifier) else {
                throw HandshakeMatrixFailure.assertion("valid retry was not process isolated")
            }
            try await pair.host.write(
                try BrokerFrame(
                    protocolVersion: ready.selectedProtocolVersion,
                    frameType: .ping,
                    epoch: ready.epoch,
                    requestID: 0
                ).encoded()
            )
            let pong = try await pair.host.readFrame(expectedEpoch: ready.epoch)
            guard pong.header.frameType == .pong else {
                throw HandshakeMatrixFailure.assertion("valid retry did not pass health check")
            }

            let secondPair = try ProbeSocketPair()
            let secondOwned = try IOSBrokerOwnedFileDescriptor(
                takingOwnershipOf: secondPair.takeWorkerDescriptor()
            )
            let secondReply = try await session.handshakeMatrixRequest(
                try IOSBrokerXPC.makeHello(valid, dataChannel: secondOwned)
            )
            secondOwned.close()
            let secondError = try IOSBrokerXPC.decodeError(secondReply)
            guard case .rejected(.invalidRequest(let reason)) = secondError,
                reason.contains("data channel is already active")
            else {
                throw HandshakeMatrixFailure.assertion(
                    "second active data channel returned \(secondError)"
                )
            }
            checks.insert("secondActiveDataChannelRejected")

            try await pair.host.write(
                try BrokerFrame(
                    protocolVersion: ready.selectedProtocolVersion,
                    frameType: .channelClose,
                    epoch: ready.epoch,
                    requestID: 0
                ).encoded()
            )
            checks.insert("validHandshakeAfterRejections")

            return BrokerProbeResult(
                hostPID: Int32(ProcessInfo.processInfo.processIdentifier),
                workerPID: ready.extensionPID,
                epoch: ready.epoch.description,
                checks: checks.sorted(),
                observations: [
                    "rootManifestDigest": ready.rootManifestDigest,
                    "selectedProtocolVersion": String(ready.selectedProtocolVersion),
                ]
            )
        }

        private static func expectRejection(
            _ hello: BrokerHello,
            through session: XPCSession,
            expected: ExpectedHandshakeRejection
        ) async throws {
            let pair = try ProbeSocketPair()
            let owned = try IOSBrokerOwnedFileDescriptor(
                takingOwnershipOf: pair.takeWorkerDescriptor()
            )
            let message = try IOSBrokerXPC.makeHello(hello, dataChannel: owned)
            owned.close()
            let reply = try await session.handshakeMatrixRequest(message)
            let error = try IOSBrokerXPC.decodeError(reply)
            guard expected.matches(error) else {
                throw HandshakeMatrixFailure.assertion(
                    "expected \(expected.rawValue), received \(error)"
                )
            }
        }
    }

    private enum ExpectedHandshakeRejection: String {
        case incompatibleProtocol
        case incompatibleABI
        case runtimeMismatch
        case rootMismatch
        case invalidConfiguration

        func matches(_ error: BrokerError) -> Bool {
            switch (self, error) {
            case (.incompatibleProtocol, .incompatibleProtocol),
                (.incompatibleABI, .incompatibleABI),
                (.runtimeMismatch, .runtimeMismatch),
                (.rootMismatch, .rootMismatch),
                (.invalidConfiguration, .invalidConfiguration):
                true
            default:
                false
            }
        }
    }

    private enum HandshakeMatrixFailure: Error, CustomStringConvertible {
        case assertion(String)

        var description: String {
            switch self {
            case .assertion(let message): "negative handshake matrix failed: \(message)"
            }
        }
    }

    private final class HandshakeMatrixReply: @unchecked Sendable {
        let dictionary: XPCDictionary

        init(_ dictionary: XPCDictionary) {
            self.dictionary = dictionary
        }
    }

    extension XPCSession {
        fileprivate func handshakeMatrixRequest(
            _ message: XPCDictionary
        ) async throws -> XPCDictionary {
            try await withCheckedThrowingContinuation { continuation in
                send(message: message) { result in
                    switch result {
                    case .success(let reply):
                        continuation.resume(returning: HandshakeMatrixReply(reply))
                    case .failure(let error):
                        continuation.resume(throwing: error)
                    }
                }
            }.dictionary
        }
    }
#endif
