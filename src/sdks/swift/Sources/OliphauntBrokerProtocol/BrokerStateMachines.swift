import Foundation

public enum IOSBrokerManagerState: Equatable, Sendable {
    case unavailable
    case idle
    case launching
    case binding
    case recovering
    case ready(BrokerEpoch)
    case quiescing(BrokerEpoch)
    case interrupted(BrokerEpoch)
    case closing

    public var epoch: BrokerEpoch? {
        switch self {
        case .ready(let epoch), .quiescing(let epoch), .interrupted(let epoch): epoch
        default: nil
        }
    }
}

public enum BrokerRequestState: Equatable, Sendable, CustomStringConvertible {
    case queued
    case receiving
    case readyToDispatch
    case running
    case cancelRequested
    case terminal(BrokerTerminalResult)

    public var description: String {
        switch self {
        case .queued: "queued"
        case .receiving: "receiving"
        case .readyToDispatch: "readyToDispatch"
        case .running: "running"
        case .cancelRequested: "cancelRequested"
        case .terminal(let result): "terminal(\(result))"
        }
    }

    public var isTerminal: Bool {
        if case .terminal = self { return true }
        return false
    }
}

public enum BrokerTerminalResult: Equatable, Sendable {
    case completed
    case rejected(BrokerRejectionReason)
    case outcomeUnknown
    case canceled
    case notStarted
}

public struct BrokerRequestLifecycle: Equatable, Sendable {
    public let epoch: BrokerEpoch
    public let requestID: BrokerRequestID
    public private(set) var state: BrokerRequestState
    public private(set) var nativeDispatchStarted: Bool

    public init(epoch: BrokerEpoch, requestID: BrokerRequestID) {
        self.epoch = epoch
        self.requestID = requestID
        state = .queued
        nativeDispatchStarted = false
    }

    public mutating func beginReceiving() throws {
        try transition(from: [.queued], to: .receiving, frameType: .requestBegin)
    }

    public mutating func finishReceiving() throws {
        try transition(from: [.receiving], to: .readyToDispatch, frameType: .requestEnd)
    }

    public mutating func beginNativeDispatch() throws {
        try transition(from: [.readyToDispatch], to: .running, frameType: .requestEnd)
        nativeDispatchStarted = true
    }

    @discardableResult
    public mutating func requestCancellation() -> Bool {
        switch state {
        case .queued, .receiving, .readyToDispatch:
            state = .terminal(.canceled)
            return true
        case .running:
            state = .cancelRequested
            return true
        case .cancelRequested, .terminal:
            return false
        }
    }

    @discardableResult
    public mutating func establishTerminal(_ result: BrokerTerminalResult) -> Bool {
        guard !state.isTerminal else {
            return false
        }
        state = .terminal(result)
        return true
    }

    public func lossResult() -> BrokerTerminalResult {
        nativeDispatchStarted ? .outcomeUnknown : .notStarted
    }

    private mutating func transition(
        from allowed: [BrokerRequestState],
        to newState: BrokerRequestState,
        frameType: BrokerFrameType
    ) throws {
        guard allowed.contains(state) else {
            throw BrokerProtocolError.illegalFrame(frameType: frameType, state: state.description)
        }
        state = newState
    }
}

public struct BrokerFrontendRequestAssembler: Sendable {
    public let maximumRequestBytes: Int
    private var bytes = Data()
    private var scanOffset = 0

    public init(maximumRequestBytes: Int = OliphauntBrokerProtocol.defaultMaximumRequestBytes) {
        precondition(maximumRequestBytes >= 5)
        self.maximumRequestBytes = maximumRequestBytes
    }

    public var byteCount: Int { bytes.count }

    public mutating func append(_ chunk: Data) throws {
        let (newCount, overflow) = bytes.count.addingReportingOverflow(chunk.count)
        guard !overflow else {
            throw BrokerProtocolError.arithmeticOverflow
        }
        guard newCount <= maximumRequestBytes else {
            throw BrokerProtocolError.payloadTooLarge(
                actual: UInt64(newCount),
                maximum: maximumRequestBytes
            )
        }
        bytes.append(chunk)
        try scanCompleteMessages()
    }

    public mutating func finish() throws -> Data {
        try scanCompleteMessages()
        guard !bytes.isEmpty else {
            throw BrokerProtocolError.malformedFrontendProtocol("empty request")
        }
        guard scanOffset == bytes.count else {
            let remaining = bytes.count - scanOffset
            throw BrokerProtocolError.malformedFrontendProtocol(
                remaining < 5 ? "truncated message header" : "truncated message body"
            )
        }
        return bytes
    }

    public mutating func reset() {
        bytes.removeAll(keepingCapacity: true)
        scanOffset = 0
    }

    private mutating func scanCompleteMessages() throws {
        while bytes.count - scanOffset >= 5 {
            let lengthOffset = scanOffset + 1
            let messageLength =
                (UInt32(bytes[lengthOffset]) << 24) | (UInt32(bytes[lengthOffset + 1]) << 16)
                | (UInt32(bytes[lengthOffset + 2]) << 8) | UInt32(bytes[lengthOffset + 3])
            guard messageLength >= 4 else {
                throw BrokerProtocolError.malformedFrontendProtocol(
                    "message length is smaller than protocol header"
                )
            }
            let (totalLength, overflow) = Int(messageLength).addingReportingOverflow(1)
            guard !overflow else {
                throw BrokerProtocolError.arithmeticOverflow
            }
            guard totalLength <= maximumRequestBytes else {
                throw BrokerProtocolError.payloadTooLarge(
                    actual: UInt64(totalLength),
                    maximum: maximumRequestBytes
                )
            }
            guard totalLength <= bytes.count - scanOffset else {
                return
            }
            scanOffset += totalLength
        }
    }
}

public struct BrokerRootManifest: Equatable, Codable, Sendable {
    public var formatVersion: UInt32
    public var postgresMajorVersion: UInt16
    public var liboliphauntVersion: String
    public var cABIVersion: UInt32
    public var rootUUID: UUID
    public var selectedPostgresExtensions: [String]
    public var startupConfigurationDigest: String
    public var dataProtectionPolicy: String

    public init(
        formatVersion: UInt32 = 1,
        postgresMajorVersion: UInt16,
        liboliphauntVersion: String,
        cABIVersion: UInt32,
        rootUUID: UUID,
        selectedPostgresExtensions: [String],
        startupConfigurationDigest: String,
        dataProtectionPolicy: String
    ) {
        self.formatVersion = formatVersion
        self.postgresMajorVersion = postgresMajorVersion
        self.liboliphauntVersion = liboliphauntVersion
        self.cABIVersion = cABIVersion
        self.rootUUID = rootUUID
        self.selectedPostgresExtensions = selectedPostgresExtensions
        self.startupConfigurationDigest = startupConfigurationDigest
        self.dataProtectionPolicy = dataProtectionPolicy
    }
}

public enum BrokerWorkerFault: String, Codable, CaseIterable, Sendable {
    case beforeNativeDispatch
    case duringNativeExecution
    case afterNativeSuccessBeforeCompleted
    case afterResponseChunks
    case duringCheckpoint
    case duringBackup
    case duringRestore
    case abort
    case invalidMemoryAccess
    case deadlock
    #if DEBUG
        case deadlockWithFailStop
    #endif
}
