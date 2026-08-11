import Darwin
import ExtensionFoundation
import Foundation
import OliphauntBrokerProtocol
import XPC

#if canImport(OliphauntIOSBroker)
    import OliphauntIOSBroker
#endif

enum BrokerPlatformProbe {
    static func run(
        retain: @MainActor @escaping (AppExtensionProcess, XPCSession) -> Void
    ) async throws -> BrokerProbeResult {
        let hostPID = getpid()
        #if canImport(OliphauntIOSBroker)
            let extensionPoint: AppExtensionPoint = .oliphauntBroker
        #else
            let extensionPoint: AppExtensionPoint = .oliphauntBrokerSpike
        #endif
        let monitor = try await AppExtensionPoint.Monitor(appExtensionPoint: extensionPoint)
        guard
            let identity = monitor.identities.first(where: {
                $0.bundleIdentifier == BrokerFixtureBundleIdentifiers.extensionBundleIdentifier
            })
        else {
            throw BrokerProbeError.extensionMissing(
                discovered: monitor.identities.map(\.bundleIdentifier)
            )
        }

        let interruption = ProbeInterruptionFlag()
        let configuration = AppExtensionProcess.Configuration(
            appExtensionIdentity: identity,
            onInterruption: {
                interruption.markInterrupted()
            }
        )
        let process = try await AppExtensionProcess(configuration: configuration)
        let session = try process.makeXPCSession()
        session.setTargetQueue(DispatchQueue(label: "dev.oliphaunt.brokerspike.xpc"))
        session.setCancellationHandler { error in
            interruption.markInterrupted(reason: String(describing: error))
        }
        session.setIncomingMessageHandler { (_: XPCDictionary) in nil }
        try session.activate()
        await retain(process, session)

        let pair = try ProbeSocketPair()
        var hello = XPCDictionary()
        hello[BrokerControlKey.message] = BrokerControlMessageKind.hello.rawValue
        hello[BrokerControlKey.minimumProtocolVersion] = UInt64(
            OliphauntBrokerProtocol.minimumVersion)
        hello[BrokerControlKey.maximumProtocolVersion] = UInt64(
            OliphauntBrokerProtocol.maximumVersion)
        hello[BrokerControlKey.expectedABI] = UInt64(6)
        hello[BrokerControlKey.rootID] = OliphauntBrokerProtocol.canonicalRootID
        hello[BrokerControlKey.startupConfigurationDigest] = "simulator-probe-v1"
        guard let boxedDescriptor = xpc_fd_create(pair.workerDescriptor) else {
            throw BrokerProbeError.fileDescriptorBoxingFailed
        }
        hello[BrokerControlKey.dataChannel] = boxedDescriptor

        let reply = try await session.request(hello).dictionary
        pair.closeWorkerOriginal()
        guard
            reply[BrokerControlKey.message, as: String.self]
                == BrokerControlMessageKind.ready.rawValue,
            let epochText = reply[BrokerControlKey.epoch, as: String.self],
            let epochUUID = UUID(uuidString: epochText),
            let workerPID = reply[BrokerControlKey.extensionPID, as: Int64.self]
        else {
            throw BrokerProbeError.invalidReady(String(describing: reply))
        }
        let epoch = BrokerEpoch(epochUUID)
        guard Int32(workerPID) != hostPID else {
            throw BrokerProbeError.notProcessIsolated(pid: hostPID)
        }

        let ping = try BrokerFrame(
            frameType: .ping,
            epoch: epoch,
            requestID: 0
        ).encoded()
        try await pair.host.writeFragmented(ping)
        let pong = try await pair.host.readFrame(expectedEpoch: epoch)
        guard pong.header.frameType == .pong else {
            throw BrokerProbeError.unexpectedFrame(pong.header.frameType)
        }

        let requestID = try BrokerRequestID(validating: 1)
        let request = simpleQuery("SELECT 1")
        try await pair.host.write(
            try BrokerFrame(
                frameType: .requestBegin,
                epoch: epoch,
                requestID: requestID.rawValue
            ).encoded())
        for chunk in request.chunked(maximum: 3) {
            try await pair.host.write(
                try BrokerFrame(
                    frameType: .requestBytes,
                    epoch: epoch,
                    requestID: requestID.rawValue,
                    payload: chunk
                ).encoded())
        }
        try await pair.host.write(
            try BrokerFrame(
                frameType: .requestEnd,
                epoch: epoch,
                requestID: requestID.rawValue
            ).encoded())

        var echoed = Data()
        while true {
            let frame = try await pair.host.readFrame(expectedEpoch: epoch)
            guard frame.header.requestID == requestID.rawValue else {
                throw BrokerProbeError.unexpectedRequestID(frame.header.requestID)
            }
            switch frame.header.frameType {
            case .responseBytes:
                echoed.append(frame.payload)
            case .completed:
                guard echoed == request else {
                    throw BrokerProbeError.echoMismatch
                }
                try await pair.host.write(
                    try BrokerFrame(
                        frameType: .channelClose,
                        epoch: epoch,
                        requestID: 0
                    ).encoded())
                return BrokerProbeResult(
                    hostPID: hostPID,
                    workerPID: Int32(workerPID),
                    epoch: epoch.description,
                    checks: [
                        "extensionDiscovery",
                        "separatePID",
                        "xpcSession",
                        "fdTransfer",
                        "fragmentedFrame",
                        "boundedRequestAssembly",
                    ]
                )
            default:
                throw BrokerProbeError.unexpectedFrame(frame.header.frameType)
            }
        }
    }

    private static func simpleQuery(_ sql: String) -> Data {
        let sqlBytes = Data(sql.utf8)
        let length = UInt32(sqlBytes.count + 5)
        var result = Data([0x51])
        result.append(UInt8((length >> 24) & 0xff))
        result.append(UInt8((length >> 16) & 0xff))
        result.append(UInt8((length >> 8) & 0xff))
        result.append(UInt8(length & 0xff))
        result.append(sqlBytes)
        result.append(0)
        return result
    }
}

private final class ProbeInterruptionFlag: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var reason: String?

    func markInterrupted(reason: String = "AppExtensionProcess interrupted") {
        lock.withLock {
            self.reason = reason
        }
    }
}

extension XPCSession {
    fileprivate func request(_ message: XPCDictionary) async throws -> ProbeXPCReply {
        try await withCheckedThrowingContinuation { continuation in
            send(message: message) { result in
                switch result {
                case .success(let dictionary):
                    continuation.resume(returning: ProbeXPCReply(dictionary))
                case .failure(let error):
                    continuation.resume(
                        throwing: BrokerProbeError.xpcRequestFailed(String(describing: error))
                    )
                }
            }
        }
    }
}

private final class ProbeXPCReply: @unchecked Sendable {
    let dictionary: XPCDictionary

    init(_ dictionary: XPCDictionary) {
        self.dictionary = dictionary
    }
}

private enum BrokerProbeError: Error, CustomStringConvertible {
    case extensionMissing(discovered: [String])
    case fileDescriptorBoxingFailed
    case invalidReady(String)
    case notProcessIsolated(pid: Int32)
    case xpcRequestFailed(String)
    case unexpectedFrame(BrokerFrameType)
    case unexpectedRequestID(UInt64)
    case echoMismatch

    var description: String {
        switch self {
        case .extensionMissing(let discovered):
            "broker extension missing; discovered=\(discovered)"
        case .fileDescriptorBoxingFailed: "xpc_fd_create failed"
        case .invalidReady(let value): "invalid Ready reply: \(value)"
        case .notProcessIsolated(let pid): "host and worker share PID \(pid)"
        case .xpcRequestFailed(let reason): "XPC request failed: \(reason)"
        case .unexpectedFrame(let type): "unexpected broker frame \(type)"
        case .unexpectedRequestID(let id): "unexpected broker request ID \(id)"
        case .echoMismatch: "extension data-channel echo mismatch"
        }
    }
}

extension Data {
    fileprivate func chunked(maximum: Int) -> [Data] {
        guard !isEmpty else { return [] }
        return stride(from: 0, to: count, by: maximum).map { offset in
            subdata(in: offset..<Swift.min(count, offset + maximum))
        }
    }
}
