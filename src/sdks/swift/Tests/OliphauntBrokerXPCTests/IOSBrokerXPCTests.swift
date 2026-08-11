import Darwin
import Foundation
import OliphauntBrokerProtocol
import OliphauntBrokerXPC
import Testing
import XPC

@available(iOS 26.0, macOS 26.0, *)
@Test
func xpcHandshakePreservesStructuredBrokerErrors() throws {
    let expectedErrors: [BrokerError] = [
        .incompatibleProtocol(minimum: 2, maximum: 3),
        .incompatibleABI(expected: 6, actual: 7),
        .runtimeMismatch(expected: "runtime-expected", actual: "runtime-actual"),
        .rootMismatch(expected: "default", actual: "other-logical-root"),
        .invalidConfiguration("minimum protocol version exceeds maximum"),
        .invalidConfiguration("startup-configuration digest mismatch"),
        .rejected(.unsupportedCapability(.backupRestore)),
        .rejected(.invalidRequest("a broker data channel is already active")),
    ]
    for expected in expectedErrors {
        let reply = try IOSBrokerXPC.makeError(expected)
        #expect(try IOSBrokerXPC.decodeError(reply) == expected)
        do {
            _ = try IOSBrokerXPC.decodeReady(reply)
            Issue.record("a rejected handshake must throw its structured broker error")
        } catch let error as BrokerError {
            #expect(error == expected)
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
@Test
func xpcExtensionBoundaryRedactsPrivatePathsFromErrorsAndFallback() throws {
    let sentinelRoot = "/private/var/mobile/Containers/Data/PluginKitPlugin/path-sentinel-root"
    let sentinelPGDATA = "\(sentinelRoot)/pgdata"
    let cases: [(error: any Error, expected: BrokerError)] = [
        (
            BrokerError.invalidConfiguration("cannot open \(sentinelPGDATA)"),
            .invalidConfiguration("extension configuration was rejected")
        ),
        (
            BrokerError.protocolViolation("native startup failed at \(sentinelPGDATA)"),
            .protocolViolation("extension control message was invalid")
        ),
        (
            BrokerError.rejected(.invalidRequest("invalid root \(sentinelRoot)")),
            .rejected(.invalidRequest("extension rejected the request"))
        ),
        (
            NSError(
                domain: NSCocoaErrorDomain,
                code: CocoaError.fileReadNoSuchFile.rawValue,
                userInfo: [NSFilePathErrorKey: sentinelPGDATA]
            ),
            .brokerUnavailable
        ),
    ]

    for testCase in cases {
        let reply = try IOSBrokerXPC.makeError(testCase.error)
        #expect(try IOSBrokerXPC.decodeError(reply) == testCase.expected)
        let encoded: String? = reply[BrokerControlKey.error]
        let reason: String? = reply[BrokerControlKey.reason]
        let fallback = IOSBrokerXPC.extensionBoundaryError(testCase.error).description
        #expect(reason == testCase.expected.description)
        #expect(fallback == testCase.expected.description)
        for value in [encoded, reason, fallback].compactMap({ $0 }) {
            #expect(!value.contains(sentinelRoot))
            #expect(!value.contains("path-sentinel-root"))
            #expect(!value.contains("/private/var/mobile"))
            #expect(!value.lowercased().contains("pgdata"))
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
@Test
func xpcFileDescriptorBoxingDuplicatesOwnership() throws {
    var descriptors: [Int32] = [-1, -1]
    #expect(pipe(&descriptors) == 0)
    defer { Darwin.close(descriptors[1]) }

    let sender = try IOSBrokerOwnedFileDescriptor(
        takingOwnershipOf: descriptors[0]
    )
    let hello = BrokerHello(
        expectedABI: 6,
        startupConfigurationDigest: "xpc-fd-test",
        requestedCapabilities: [.protocolRaw]
    )
    let message = try IOSBrokerXPC.makeHello(hello, dataChannel: sender)
    #expect(sender.close())

    let decoded = try IOSBrokerXPC.decodeHello(message)
    #expect(decoded.hello == hello)
    let received = try decoded.dataChannel.borrowedDescriptor()
    var sent = UInt8(ascii: "X")
    #expect(Darwin.write(descriptors[1], &sent, 1) == 1)
    var byte: UInt8 = 0
    #expect(Darwin.read(received, &byte, 1) == 1)
    #expect(byte == UInt8(ascii: "X"))
    #expect(decoded.dataChannel.close())
    #expect(!decoded.dataChannel.close())
}

@available(iOS 26.0, macOS 26.0, *)
@Test
func xpcDiagnosticsDecodesCompleteCheckpointMemoryEvidence() throws {
    var reply = try makeDiagnosticsReply()
    reply[IOSBrokerXPC.checkpointMemorySampleSequenceKey] = UInt64(4)
    reply[IOSBrokerXPC.checkpointMemorySampleStartedAtUptimeNanosecondsKey] = UInt64(100)
    reply[IOSBrokerXPC.checkpointMemorySampledAtUptimeNanosecondsKey] = UInt64(110)
    reply[IOSBrokerXPC.checkpointMemorySampleCompletedAtUptimeNanosecondsKey] = UInt64(120)
    reply[IOSBrokerXPC.checkpointMemorySamplePhysFootprintBytesKey] = UInt64(1_024)
    reply[IOSBrokerXPC.checkpointMemorySampleResidentBytesKey] = UInt64(2_048)
    reply[IOSBrokerXPC.checkpointMemorySampleAvailableMemoryBytesKey] = UInt64(4_096)

    let diagnostics = try IOSBrokerXPC.decodeWorkerDiagnostics(reply)
    #expect(
        diagnostics.checkpointMemorySample
            == IOSBrokerWireCheckpointMemorySample(
                sequence: 4,
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

@available(iOS 26.0, macOS 26.0, *)
@Test
func xpcDiagnosticsRejectsPartialCheckpointMemoryEvidence() throws {
    var reply = try makeDiagnosticsReply()
    reply[IOSBrokerXPC.checkpointMemorySampleSequenceKey] = UInt64(4)

    do {
        _ = try IOSBrokerXPC.decodeWorkerDiagnostics(reply)
        Issue.record("partial checkpoint memory evidence must be rejected")
    } catch let error as BrokerError {
        guard case .protocolViolation(let message) = error else {
            Issue.record("expected protocolViolation, got \(error)")
            return
        }
        #expect(message.contains("incomplete checkpoint memory evidence"))
    }
}

@available(iOS 26.0, macOS 26.0, *)
private func makeDiagnosticsReply() throws -> XPCDictionary {
    var reply = IOSBrokerXPC.makeAcknowledgement(.diagnostics)
    reply[IOSBrokerXPC.stateKey] = "ready"
    reply[BrokerControlKey.epoch] = BrokerEpoch.fresh().description
    reply[BrokerControlKey.extensionPID] = Int64(42)
    reply[IOSBrokerXPC.nativeDispatchStartedKey] = false
    reply[IOSBrokerXPC.transactionStatusKey] = "idle"
    reply[IOSBrokerXPC.capabilitiesKey] = String(
        decoding: try JSONEncoder().encode(BrokerCapabilities()),
        as: UTF8.self
    )
    reply[IOSBrokerXPC.checkpointInProgressKey] = false
    return reply
}
