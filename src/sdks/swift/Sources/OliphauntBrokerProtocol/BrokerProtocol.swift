import Foundation

public enum OliphauntBrokerProtocol {
    public static let magic: (UInt8, UInt8, UInt8, UInt8) = (0x4f, 0x4c, 0x50, 0x42)
    public static let headerLength: UInt16 = 40
    public static let minimumVersion: UInt16 = 1
    public static let maximumVersion: UInt16 = 1
    public static let maximumFramePayload = 256 * 1024
    public static let maximumQueuedBytesPerDirection = 8 * 1024 * 1024
    public static let defaultMaximumRequestBytes = 8 * 1024 * 1024
    public static let canonicalRootID = "default"

    public static func supports(version: UInt16) -> Bool {
        version >= minimumVersion && version <= maximumVersion
    }
}

public struct BrokerEpoch: Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: UUID

    public init(_ rawValue: UUID) {
        self.rawValue = rawValue
    }

    public static func fresh() -> BrokerEpoch {
        BrokerEpoch(UUID())
    }

    public var description: String {
        rawValue.uuidString.lowercased()
    }
}

public struct BrokerRequestID: Hashable, Codable, Sendable, Comparable, CustomStringConvertible {
    public let rawValue: UInt64

    public init(validating rawValue: UInt64) throws {
        guard rawValue != 0 else {
            throw BrokerProtocolError.invalidRequestID(rawValue)
        }
        self.rawValue = rawValue
    }

    init(unchecked rawValue: UInt64) {
        self.rawValue = rawValue
    }

    public static func < (lhs: BrokerRequestID, rhs: BrokerRequestID) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public var description: String {
        String(rawValue)
    }
}

public struct BrokerRequestIDSequence: Sendable {
    private var nextValue: UInt64

    public init(startingAt: UInt64 = 1) throws {
        guard startingAt != 0 else {
            throw BrokerProtocolError.invalidRequestID(startingAt)
        }
        nextValue = startingAt
    }

    public mutating func next() throws -> BrokerRequestID {
        guard nextValue != 0 else {
            throw BrokerProtocolError.requestIDSpaceExhausted
        }
        let result = BrokerRequestID(unchecked: nextValue)
        if nextValue == UInt64.max {
            nextValue = 0
        } else {
            nextValue += 1
        }
        return result
    }
}

public enum BrokerControlMessageKind: String, Codable, CaseIterable, Sendable {
    case hello
    case ready
    case rejected
    case attachDataChannel
    case cancel
    case cancelObserved
    case checkpoint
    case prepareForBackground
    case resumeFromBackground
    case detach
    case diagnostics
    case injectFault
}

public enum BrokerControlKey {
    public static let message = "message"
    public static let minimumProtocolVersion = "minimumProtocolVersion"
    public static let maximumProtocolVersion = "maximumProtocolVersion"
    public static let selectedProtocolVersion = "selectedProtocolVersion"
    public static let expectedABI = "expectedABI"
    public static let expectedRuntimeVersion = "expectedRuntimeVersion"
    public static let rootID = "rootID"
    public static let startupConfigurationDigest = "startupConfigurationDigest"
    public static let requestedCapabilities = "requestedCapabilities"
    public static let dataChannel = "dataChannel"
    public static let epoch = "epoch"
    public static let requestID = "requestID"
    public static let extensionPID = "extensionPID"
    public static let runtimeVersion = "runtimeVersion"
    public static let abiVersion = "abiVersion"
    public static let postgresMajorVersion = "postgresMajorVersion"
    public static let rootManifestDigest = "rootManifestDigest"
    public static let actualCapabilities = "actualCapabilities"
    public static let actualRuntimeConfiguration = "actualRuntimeConfiguration"
    public static let deadlineUnixNanoseconds = "deadlineUnixNanoseconds"
    public static let fault = "fault"
    public static let reason = "reason"
    public static let error = "error"
}

public struct BrokerHello: Equatable, Codable, Sendable {
    public var minimumProtocolVersion: UInt16
    public var maximumProtocolVersion: UInt16
    public var expectedABI: UInt32
    public var expectedRuntimeVersion: String?
    public var rootID: String
    public var startupConfigurationDigest: String
    public var requestedCapabilities: Set<BrokerCapability>

    public init(
        minimumProtocolVersion: UInt16 = OliphauntBrokerProtocol.minimumVersion,
        maximumProtocolVersion: UInt16 = OliphauntBrokerProtocol.maximumVersion,
        expectedABI: UInt32,
        expectedRuntimeVersion: String? = nil,
        rootID: String = OliphauntBrokerProtocol.canonicalRootID,
        startupConfigurationDigest: String,
        requestedCapabilities: Set<BrokerCapability>
    ) {
        self.minimumProtocolVersion = minimumProtocolVersion
        self.maximumProtocolVersion = maximumProtocolVersion
        self.expectedABI = expectedABI
        self.expectedRuntimeVersion = expectedRuntimeVersion
        self.rootID = rootID
        self.startupConfigurationDigest = startupConfigurationDigest
        self.requestedCapabilities = requestedCapabilities
    }
}

public struct BrokerReady: Equatable, Codable, Sendable {
    public var selectedProtocolVersion: UInt16
    public var epoch: BrokerEpoch
    public var extensionPID: Int32
    public var runtimeVersion: String
    public var abiVersion: UInt32
    public var postgresMajorVersion: UInt16
    public var rootManifestDigest: String
    public var actualCapabilities: BrokerCapabilities
    public var actualRuntimeConfiguration: BrokerRuntimeConfiguration

    public init(
        selectedProtocolVersion: UInt16,
        epoch: BrokerEpoch,
        extensionPID: Int32,
        runtimeVersion: String,
        abiVersion: UInt32,
        postgresMajorVersion: UInt16,
        rootManifestDigest: String,
        actualCapabilities: BrokerCapabilities,
        actualRuntimeConfiguration: BrokerRuntimeConfiguration
    ) {
        self.selectedProtocolVersion = selectedProtocolVersion
        self.epoch = epoch
        self.extensionPID = extensionPID
        self.runtimeVersion = runtimeVersion
        self.abiVersion = abiVersion
        self.postgresMajorVersion = postgresMajorVersion
        self.rootManifestDigest = rootManifestDigest
        self.actualCapabilities = actualCapabilities
        self.actualRuntimeConfiguration = actualRuntimeConfiguration
    }
}

public struct BrokerRuntimeConfiguration: Equatable, Codable, Sendable {
    public var rootID: String
    public var startupConfigurationDigest: String
    public var selectedExtensions: [String]
    public var footprintProfile: String

    public init(
        rootID: String,
        startupConfigurationDigest: String,
        selectedExtensions: [String],
        footprintProfile: String = "smallMobile"
    ) {
        self.rootID = rootID
        self.startupConfigurationDigest = startupConfigurationDigest
        self.selectedExtensions = selectedExtensions
        self.footprintProfile = footprintProfile
    }
}

public enum BrokerCapability: String, Codable, CaseIterable, Sendable {
    case processIsolated
    case crashRestartable
    case hangRestartable
    case sameRootLogicalReopen
    case rootSwitchable
    case multiRoot
    case independentSessions
    case backgroundContinuable
    case protocolRaw
    case protocolStream
    case streamingRequestInput
    case queryCancel
    case backupRestore
}

public struct BrokerCapabilities: Equatable, Codable, Sendable {
    public var mode: String
    public var implementation: String
    public var minimumOS: String
    public var processIsolated: Bool
    public var crashRestartable: Bool
    public var hangRestartable: Bool
    public var sameRootLogicalReopen: Bool
    public var rootSwitchable: Bool
    public var multiRoot: Bool
    public var independentSessions: Bool
    public var maxClientSessions: Int
    public var backgroundContinuable: Bool
    public var requiresAppGroup: Bool
    public var protocolRaw: Bool
    public var protocolStream: Bool
    public var streamingRequestInput: Bool
    public var queryCancel: Bool
    public var backupRestore: Bool
    public var connectionString: String?
    public var serverMode: Bool

    public init(
        mode: String = "nativeBroker",
        implementation: String = "iosExtensionBroker",
        minimumOS: String = "iOS 26",
        processIsolated: Bool = true,
        crashRestartable: Bool = true,
        hangRestartable: Bool = false,
        sameRootLogicalReopen: Bool = true,
        rootSwitchable: Bool = false,
        multiRoot: Bool = false,
        independentSessions: Bool = false,
        maxClientSessions: Int = 1,
        backgroundContinuable: Bool = false,
        requiresAppGroup: Bool = false,
        protocolRaw: Bool = true,
        protocolStream: Bool = true,
        streamingRequestInput: Bool = false,
        queryCancel: Bool = true,
        backupRestore: Bool = false,
        connectionString: String? = nil,
        serverMode: Bool = false
    ) {
        self.mode = mode
        self.implementation = implementation
        self.minimumOS = minimumOS
        self.processIsolated = processIsolated
        self.crashRestartable = crashRestartable
        self.hangRestartable = hangRestartable
        self.sameRootLogicalReopen = sameRootLogicalReopen
        self.rootSwitchable = rootSwitchable
        self.multiRoot = multiRoot
        self.independentSessions = independentSessions
        self.maxClientSessions = maxClientSessions
        self.backgroundContinuable = backgroundContinuable
        self.requiresAppGroup = requiresAppGroup
        self.protocolRaw = protocolRaw
        self.protocolStream = protocolStream
        self.streamingRequestInput = streamingRequestInput
        self.queryCancel = queryCancel
        self.backupRestore = backupRestore
        self.connectionString = connectionString
        self.serverMode = serverMode
    }

    public var enabled: Set<BrokerCapability> {
        var result = Set<BrokerCapability>()
        if processIsolated { result.insert(.processIsolated) }
        if crashRestartable { result.insert(.crashRestartable) }
        if hangRestartable { result.insert(.hangRestartable) }
        if sameRootLogicalReopen { result.insert(.sameRootLogicalReopen) }
        if rootSwitchable { result.insert(.rootSwitchable) }
        if multiRoot { result.insert(.multiRoot) }
        if independentSessions { result.insert(.independentSessions) }
        if backgroundContinuable { result.insert(.backgroundContinuable) }
        if protocolRaw { result.insert(.protocolRaw) }
        if protocolStream { result.insert(.protocolStream) }
        if streamingRequestInput { result.insert(.streamingRequestInput) }
        if queryCancel { result.insert(.queryCancel) }
        if backupRestore { result.insert(.backupRestore) }
        return result
    }
}

public enum BrokerRejectionReason: Equatable, Codable, Sendable {
    case invalidRequest(String)
    case canceled
    case queueClosed
    case rootOpen
    case unsupportedCapability(BrokerCapability)
}

public enum BrokerError: Error, Equatable, Codable, Sendable, CustomStringConvertible {
    case brokerUnavailable
    case unsupportedOS
    case extensionMissing
    case incompatibleProtocol(minimum: UInt16, maximum: UInt16)
    case incompatibleABI(expected: UInt32, actual: UInt32)
    case runtimeMismatch(expected: String, actual: String)
    case rootMismatch(expected: String, actual: String)
    case invalidConfiguration(String)
    case notStarted
    case rejected(BrokerRejectionReason)
    case outcomeUnknown(epoch: BrokerEpoch, requestID: BrokerRequestID)
    case canceled
    case deadlineExceeded
    case workerInterrupted(epoch: BrokerEpoch?)
    case protocolViolation(String)
    case databaseClosed

    public var description: String {
        switch self {
        case .brokerUnavailable: "iOS broker is unavailable"
        case .unsupportedOS: "iOS broker requires iOS 26 or newer"
        case .extensionMissing: "broker app extension is missing"
        case .incompatibleProtocol(let minimum, let maximum):
            "no compatible broker protocol version in \(minimum)...\(maximum)"
        case .incompatibleABI(let expected, let actual):
            "liboliphaunt ABI mismatch: expected \(expected), got \(actual)"
        case .runtimeMismatch(let expected, let actual):
            "liboliphaunt runtime mismatch: expected \(expected), got \(actual)"
        case .rootMismatch(let expected, let actual):
            "broker root mismatch: expected \(expected), got \(actual)"
        case .invalidConfiguration(let reason): "invalid broker configuration: \(reason)"
        case .notStarted: "request did not start"
        case .rejected(let reason): "broker rejected request: \(reason)"
        case .outcomeUnknown(let epoch, let requestID):
            "request outcome is unknown (epoch \(epoch), request \(requestID))"
        case .canceled: "request was canceled before dispatch"
        case .deadlineExceeded: "broker request deadline exceeded"
        case .workerInterrupted(let epoch):
            "broker worker was interrupted\(epoch.map { " (epoch \($0))" } ?? "")"
        case .protocolViolation(let reason): "broker protocol violation: \(reason)"
        case .databaseClosed: "database is closed"
        }
    }
}

public enum BrokerHandshake {
    public static func negotiateVersion(_ hello: BrokerHello) throws -> UInt16 {
        guard hello.minimumProtocolVersion <= hello.maximumProtocolVersion else {
            throw BrokerError.invalidConfiguration("minimum protocol version exceeds maximum")
        }
        let minimum = max(hello.minimumProtocolVersion, OliphauntBrokerProtocol.minimumVersion)
        let maximum = min(hello.maximumProtocolVersion, OliphauntBrokerProtocol.maximumVersion)
        guard minimum <= maximum else {
            throw BrokerError.incompatibleProtocol(
                minimum: hello.minimumProtocolVersion,
                maximum: hello.maximumProtocolVersion
            )
        }
        return maximum
    }

    public static func validate(
        _ hello: BrokerHello,
        actualABI: UInt32,
        actualRuntimeVersion: String,
        residentRootID: String?,
        startupConfigurationDigest: String
    ) throws -> UInt16 {
        let version = try negotiateVersion(hello)
        guard hello.expectedABI == actualABI else {
            throw BrokerError.incompatibleABI(expected: hello.expectedABI, actual: actualABI)
        }
        if let expected = hello.expectedRuntimeVersion, expected != actualRuntimeVersion {
            throw BrokerError.runtimeMismatch(expected: expected, actual: actualRuntimeVersion)
        }
        guard hello.rootID == OliphauntBrokerProtocol.canonicalRootID else {
            throw BrokerError.rootMismatch(
                expected: OliphauntBrokerProtocol.canonicalRootID,
                actual: hello.rootID
            )
        }
        if let residentRootID, residentRootID != hello.rootID {
            throw BrokerError.rootMismatch(expected: residentRootID, actual: hello.rootID)
        }
        guard hello.startupConfigurationDigest == startupConfigurationDigest else {
            throw BrokerError.invalidConfiguration("startup-configuration digest mismatch")
        }
        return version
    }
}

public enum BrokerProtocolError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidMagic
    case unsupportedVersion(UInt16)
    case invalidHeaderLength(UInt16)
    case unknownFrameType(UInt8)
    case invalidFlags(UInt8)
    case nonzeroReserved(UInt16)
    case staleEpoch(expected: BrokerEpoch, actual: BrokerEpoch)
    case invalidRequestID(UInt64)
    case invalidRequestIDForFrame(frameType: BrokerFrameType, requestID: UInt64)
    case payloadTooLarge(actual: UInt64, maximum: Int)
    case arithmeticOverflow
    case illegalFrame(frameType: BrokerFrameType, state: String)
    case truncatedFrame
    case malformedFrontendProtocol(String)
    case requestIDSpaceExhausted

    public var description: String {
        switch self {
        case .invalidMagic: "invalid OLPB frame magic"
        case .unsupportedVersion(let version): "unsupported broker protocol version \(version)"
        case .invalidHeaderLength(let length): "unsupported broker header length \(length)"
        case .unknownFrameType(let raw): "unknown broker frame type \(raw)"
        case .invalidFlags(let flags): "unknown broker frame flags 0x\(String(flags, radix: 16))"
        case .nonzeroReserved(let reserved): "broker frame reserved field is nonzero: \(reserved)"
        case .staleEpoch(let expected, let actual):
            "stale broker epoch \(actual); current epoch is \(expected)"
        case .invalidRequestID(let requestID): "invalid broker request ID \(requestID)"
        case .invalidRequestIDForFrame(let frameType, let requestID):
            "request ID \(requestID) is invalid for \(frameType)"
        case .payloadTooLarge(let actual, let maximum):
            "broker frame/request payload \(actual) exceeds limit \(maximum)"
        case .arithmeticOverflow: "broker frame length arithmetic overflow"
        case .illegalFrame(let frameType, let state):
            "broker frame \(frameType) is illegal while request is \(state)"
        case .truncatedFrame: "broker channel ended with a truncated frame"
        case .malformedFrontendProtocol(let reason):
            "malformed PostgreSQL frontend protocol: \(reason)"
        case .requestIDSpaceExhausted: "broker request ID space is exhausted for this epoch"
        }
    }
}
