import Darwin
import Foundation
import OliphauntBrokerProtocol
import XPC

/// An explicitly owned descriptor. Initializers take ownership and `close()` is
/// idempotent. `xpc_fd_create` and `xpc_fd_dup` each create a new descriptor;
/// callers therefore never exchange bare integer descriptor values.
public final class IOSBrokerOwnedFileDescriptor: @unchecked Sendable {
    private let lock = NSLock()
    private var rawDescriptor: Int32

    public init(takingOwnershipOf descriptor: Int32) throws {
        guard descriptor >= 0 else {
            throw POSIXError(.EBADF)
        }
        rawDescriptor = descriptor
    }

    deinit {
        close()
    }

    public var isOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return rawDescriptor >= 0
    }

    /// The returned value is borrowed and remains owned by this object.
    public func borrowedDescriptor() throws -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        guard rawDescriptor >= 0 else {
            throw POSIXError(.EBADF)
        }
        return rawDescriptor
    }

    /// Transfers ownership to the caller and prevents this object from closing
    /// the descriptor. This is used when the XPC duplicate is adopted by the
    /// extension's socket worker.
    public func takeDescriptor() throws -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        guard rawDescriptor >= 0 else {
            throw POSIXError(.EBADF)
        }
        let descriptor = rawDescriptor
        rawDescriptor = -1
        return descriptor
    }

    @discardableResult
    public func close() -> Bool {
        lock.lock()
        let descriptor = rawDescriptor
        rawDescriptor = -1
        lock.unlock()
        guard descriptor >= 0 else {
            return false
        }
        Darwin.close(descriptor)
        return true
    }
}

public struct IOSBrokerControlEnvelope: Sendable {
    public var kind: BrokerControlMessageKind
    public var epoch: BrokerEpoch?
    public var requestID: BrokerRequestID?
    public var deadlineUnixNanoseconds: UInt64?
    public var fault: BrokerWorkerFault?

    public init(
        kind: BrokerControlMessageKind,
        epoch: BrokerEpoch? = nil,
        requestID: BrokerRequestID? = nil,
        deadlineUnixNanoseconds: UInt64? = nil,
        fault: BrokerWorkerFault? = nil
    ) {
        self.kind = kind
        self.epoch = epoch
        self.requestID = requestID
        self.deadlineUnixNanoseconds = deadlineUnixNanoseconds
        self.fault = fault
    }
}

/// Path-free diagnostics decoded by the shared XPC layer. The host adapter
/// maps this wire value to its public diagnostics type; keeping the wire DTO in
/// this protocol-only module prevents the extension from importing the host
/// manager/session implementation.
public struct IOSBrokerWireCheckpointMemorySample: Equatable, Sendable {
    public var sequence: UInt64
    public var startedAtUptimeNanoseconds: UInt64
    public var sampledAtUptimeNanoseconds: UInt64
    public var completedAtUptimeNanoseconds: UInt64
    public var physFootprintBytes: UInt64
    public var residentBytes: UInt64
    public var availableMemoryBytes: UInt64

    public init(
        sequence: UInt64,
        startedAtUptimeNanoseconds: UInt64,
        sampledAtUptimeNanoseconds: UInt64,
        completedAtUptimeNanoseconds: UInt64,
        physFootprintBytes: UInt64,
        residentBytes: UInt64,
        availableMemoryBytes: UInt64
    ) {
        self.sequence = sequence
        self.startedAtUptimeNanoseconds = startedAtUptimeNanoseconds
        self.sampledAtUptimeNanoseconds = sampledAtUptimeNanoseconds
        self.completedAtUptimeNanoseconds = completedAtUptimeNanoseconds
        self.physFootprintBytes = physFootprintBytes
        self.residentBytes = residentBytes
        self.availableMemoryBytes = availableMemoryBytes
    }
}

public struct IOSBrokerWireDiagnostics: Equatable, Sendable {
    public var state: String
    public var epoch: BrokerEpoch
    public var extensionProcessIdentifier: Int32
    public var manifestDigest: String?
    public var activeRequestID: BrokerRequestID?
    public var nativeDispatchStarted: Bool
    public var transactionStatus: String
    public var capabilities: BrokerCapabilities
    public var currentPhysFootprintBytes: UInt64?
    public var currentResidentBytes: UInt64?
    public var availableMemoryBytes: UInt64?
    public var checkpointInProgress: Bool
    public var checkpointMemorySample: IOSBrokerWireCheckpointMemorySample?
    public var storageProtectionEvidenceJSON: String?
    public var extensionEntryPreOpenPhysFootprintBytes: UInt64?
    public var extensionEntryPreOpenResidentBytes: UInt64?
    public var openedIdlePhysFootprintBytes: UInt64?
    public var openedIdleResidentBytes: UInt64?

    public init(
        state: String,
        epoch: BrokerEpoch,
        extensionProcessIdentifier: Int32,
        manifestDigest: String?,
        activeRequestID: BrokerRequestID?,
        nativeDispatchStarted: Bool,
        transactionStatus: String,
        capabilities: BrokerCapabilities,
        currentPhysFootprintBytes: UInt64?,
        currentResidentBytes: UInt64?,
        availableMemoryBytes: UInt64?,
        checkpointInProgress: Bool,
        checkpointMemorySample: IOSBrokerWireCheckpointMemorySample? = nil,
        storageProtectionEvidenceJSON: String?,
        extensionEntryPreOpenPhysFootprintBytes: UInt64?,
        extensionEntryPreOpenResidentBytes: UInt64?,
        openedIdlePhysFootprintBytes: UInt64?,
        openedIdleResidentBytes: UInt64?
    ) {
        self.state = state
        self.epoch = epoch
        self.extensionProcessIdentifier = extensionProcessIdentifier
        self.manifestDigest = manifestDigest
        self.activeRequestID = activeRequestID
        self.nativeDispatchStarted = nativeDispatchStarted
        self.transactionStatus = transactionStatus
        self.capabilities = capabilities
        self.currentPhysFootprintBytes = currentPhysFootprintBytes
        self.currentResidentBytes = currentResidentBytes
        self.availableMemoryBytes = availableMemoryBytes
        self.checkpointInProgress = checkpointInProgress
        self.checkpointMemorySample = checkpointMemorySample
        self.storageProtectionEvidenceJSON = storageProtectionEvidenceJSON
        self.extensionEntryPreOpenPhysFootprintBytes =
            extensionEntryPreOpenPhysFootprintBytes
        self.extensionEntryPreOpenResidentBytes = extensionEntryPreOpenResidentBytes
        self.openedIdlePhysFootprintBytes = openedIdlePhysFootprintBytes
        self.openedIdleResidentBytes = openedIdleResidentBytes
    }
}

/// The primitive-only lightweight-XPC control schema shared by a host harness
/// and its extension entry point. Potentially large PostgreSQL bytes are
/// deliberately absent; they travel only through the framed socket.
@available(iOS 26.0, macOS 26.0, *)
public enum IOSBrokerXPC {
    public static let successKey = "success"
    public static let cancelledActiveWorkKey = "cancelledActiveWork"
    public static let checkpointedKey = "checkpointed"
    public static let rejectionKey = "rejection"
    public static let stateKey = "state"
    public static let manifestDigestKey = "manifestDigest"
    public static let activeRequestIDKey = "activeRequestID"
    public static let nativeDispatchStartedKey = "nativeDispatchStarted"
    public static let transactionStatusKey = "transactionStatus"
    public static let capabilitiesKey = "capabilities"
    public static let currentPhysFootprintBytesKey = "currentPhysFootprintBytes"
    public static let currentResidentBytesKey = "currentResidentBytes"
    public static let availableMemoryBytesKey = "availableMemoryBytes"
    public static let checkpointInProgressKey = "checkpointInProgress"
    public static let checkpointMemorySampleSequenceKey = "checkpointMemorySampleSequence"
    public static let checkpointMemorySampleStartedAtUptimeNanosecondsKey =
        "checkpointMemorySampleStartedAtUptimeNanoseconds"
    public static let checkpointMemorySampledAtUptimeNanosecondsKey =
        "checkpointMemorySampledAtUptimeNanoseconds"
    public static let checkpointMemorySampleCompletedAtUptimeNanosecondsKey =
        "checkpointMemorySampleCompletedAtUptimeNanoseconds"
    public static let checkpointMemorySamplePhysFootprintBytesKey =
        "checkpointMemorySamplePhysFootprintBytes"
    public static let checkpointMemorySampleResidentBytesKey =
        "checkpointMemorySampleResidentBytes"
    public static let checkpointMemorySampleAvailableMemoryBytesKey =
        "checkpointMemorySampleAvailableMemoryBytes"
    public static let storageProtectionEvidenceJSONKey = "storageProtectionEvidenceJSON"
    public static let extensionEntryPreOpenPhysFootprintBytesKey =
        "extensionEntryPreOpenPhysFootprintBytes"
    public static let extensionEntryPreOpenResidentBytesKey =
        "extensionEntryPreOpenResidentBytes"
    public static let openedIdlePhysFootprintBytesKey = "openedIdlePhysFootprintBytes"
    public static let openedIdleResidentBytesKey = "openedIdleResidentBytes"

    public static func makeHello(
        _ hello: BrokerHello,
        dataChannel descriptor: IOSBrokerOwnedFileDescriptor
    ) throws -> XPCDictionary {
        var dictionary = XPCDictionary()
        dictionary[BrokerControlKey.message] = BrokerControlMessageKind.hello.rawValue
        dictionary[BrokerControlKey.minimumProtocolVersion] = UInt64(hello.minimumProtocolVersion)
        dictionary[BrokerControlKey.maximumProtocolVersion] = UInt64(hello.maximumProtocolVersion)
        dictionary[BrokerControlKey.expectedABI] = UInt64(hello.expectedABI)
        if let expectedRuntimeVersion = hello.expectedRuntimeVersion {
            dictionary[BrokerControlKey.expectedRuntimeVersion] = expectedRuntimeVersion
        }
        dictionary[BrokerControlKey.rootID] = hello.rootID
        dictionary[BrokerControlKey.startupConfigurationDigest] =
            hello.startupConfigurationDigest
        dictionary[BrokerControlKey.requestedCapabilities] = try encodeJSON(
            hello.requestedCapabilities
        )
        dictionary[BrokerControlKey.dataChannel] = try box(descriptor)
        return dictionary
    }

    public static func decodeHello(
        _ dictionary: XPCDictionary
    ) throws -> (hello: BrokerHello, dataChannel: IOSBrokerOwnedFileDescriptor) {
        guard try messageKind(in: dictionary) == .hello else {
            throw BrokerError.protocolViolation("expected Hello control message")
        }
        let minimum = try uint16(dictionary, BrokerControlKey.minimumProtocolVersion)
        let maximum = try uint16(dictionary, BrokerControlKey.maximumProtocolVersion)
        let expectedABI = try uint32(dictionary, BrokerControlKey.expectedABI)
        let expectedRuntimeVersion: String? = dictionary[BrokerControlKey.expectedRuntimeVersion]
        let rootID = try string(dictionary, BrokerControlKey.rootID)
        let digest = try string(dictionary, BrokerControlKey.startupConfigurationDigest)
        let encodedCapabilities = try string(
            dictionary,
            BrokerControlKey.requestedCapabilities
        )
        let capabilities: Set<BrokerCapability> = try decodeJSON(encodedCapabilities)
        return (
            BrokerHello(
                minimumProtocolVersion: minimum,
                maximumProtocolVersion: maximum,
                expectedABI: expectedABI,
                expectedRuntimeVersion: expectedRuntimeVersion,
                rootID: rootID,
                startupConfigurationDigest: digest,
                requestedCapabilities: capabilities
            ),
            try duplicateDescriptor(in: dictionary, key: BrokerControlKey.dataChannel)
        )
    }

    public static func makeReady(_ ready: BrokerReady) throws -> XPCDictionary {
        var dictionary = XPCDictionary()
        dictionary[BrokerControlKey.message] = BrokerControlMessageKind.ready.rawValue
        dictionary[BrokerControlKey.selectedProtocolVersion] =
            UInt64(ready.selectedProtocolVersion)
        dictionary[BrokerControlKey.epoch] = ready.epoch.description
        dictionary[BrokerControlKey.extensionPID] = Int64(ready.extensionPID)
        dictionary[BrokerControlKey.runtimeVersion] = ready.runtimeVersion
        dictionary[BrokerControlKey.abiVersion] = UInt64(ready.abiVersion)
        dictionary[BrokerControlKey.postgresMajorVersion] =
            UInt64(ready.postgresMajorVersion)
        dictionary[BrokerControlKey.rootManifestDigest] = ready.rootManifestDigest
        dictionary[BrokerControlKey.actualCapabilities] = try encodeJSON(
            ready.actualCapabilities
        )
        dictionary[BrokerControlKey.actualRuntimeConfiguration] = try encodeJSON(
            ready.actualRuntimeConfiguration
        )
        return dictionary
    }

    public static func decodeReady(_ dictionary: XPCDictionary) throws -> BrokerReady {
        let kind = try messageKind(in: dictionary)
        if kind == .rejected {
            throw try decodeError(dictionary)
        }
        guard kind == .ready else {
            throw BrokerError.protocolViolation("expected Ready, received \(kind.rawValue)")
        }

        let epochString = try string(dictionary, BrokerControlKey.epoch)
        guard let epochUUID = UUID(uuidString: epochString) else {
            throw BrokerError.protocolViolation("Ready contains an invalid epoch UUID")
        }
        let pidValue = try int64(dictionary, BrokerControlKey.extensionPID)
        guard let pid = Int32(exactly: pidValue) else {
            throw BrokerError.protocolViolation("Ready contains an invalid worker PID")
        }
        let encodedCapabilities = try string(dictionary, BrokerControlKey.actualCapabilities)
        let encodedRuntimeConfiguration = try string(
            dictionary,
            BrokerControlKey.actualRuntimeConfiguration
        )
        return BrokerReady(
            selectedProtocolVersion: try uint16(
                dictionary,
                BrokerControlKey.selectedProtocolVersion
            ),
            epoch: BrokerEpoch(epochUUID),
            extensionPID: pid,
            runtimeVersion: try string(dictionary, BrokerControlKey.runtimeVersion),
            abiVersion: try uint32(dictionary, BrokerControlKey.abiVersion),
            postgresMajorVersion: try uint16(
                dictionary,
                BrokerControlKey.postgresMajorVersion
            ),
            rootManifestDigest: try string(dictionary, BrokerControlKey.rootManifestDigest),
            actualCapabilities: try decodeJSON(encodedCapabilities),
            actualRuntimeConfiguration: try decodeJSON(encodedRuntimeConfiguration)
        )
    }

    public static func makeRejected(_ rejection: BrokerRejectionReason) throws -> XPCDictionary {
        var dictionary = XPCDictionary()
        dictionary[BrokerControlKey.message] = BrokerControlMessageKind.rejected.rawValue
        dictionary[rejectionKey] = try encodeJSON(rejection)
        dictionary[BrokerControlKey.reason] = String(describing: rejection)
        return dictionary
    }

    /// Returns the path-free error that may cross the extension boundary.
    /// Intrinsically typed handshake failures retain their identity. Free-form
    /// strings are either explicitly allowlisted or replaced with stable text.
    public static func extensionBoundaryError(_ error: any Error) -> BrokerError {
        guard let brokerError = error as? BrokerError else {
            if error is BrokerProtocolError {
                return .protocolViolation("extension control message was invalid")
            }
            return .brokerUnavailable
        }

        switch brokerError {
        case .invalidConfiguration(let reason):
            if pathFreeConfigurationReasons.contains(reason) {
                return brokerError
            }
            return .invalidConfiguration("extension configuration was rejected")
        case .protocolViolation:
            return .protocolViolation("extension control message was invalid")
        case .rejected(.invalidRequest(let reason)):
            if pathFreeInvalidRequestReasons.contains(reason) {
                return brokerError
            }
            return .rejected(.invalidRequest("extension rejected the request"))
        default:
            return brokerError
        }
    }

    /// Encodes a structured, path-free broker failure for handshake and control
    /// replies. ABI/runtime/root/protocol failures retain their typed identity.
    public static func makeError(_ error: BrokerError) throws -> XPCDictionary {
        try makeBoundaryError(extensionBoundaryError(error))
    }

    /// Encodes an arbitrary extension error without reflecting its description.
    public static func makeError(_ error: any Error) throws -> XPCDictionary {
        try makeBoundaryError(extensionBoundaryError(error))
    }

    private static func makeBoundaryError(_ error: BrokerError) throws -> XPCDictionary {
        var dictionary = XPCDictionary()
        dictionary[BrokerControlKey.message] = BrokerControlMessageKind.rejected.rawValue
        dictionary[BrokerControlKey.error] = try encodeJSON(error)
        dictionary[BrokerControlKey.reason] = error.description
        return dictionary
    }

    public static func decodeError(_ dictionary: XPCDictionary) throws -> BrokerError {
        if let encoded: String = dictionary[BrokerControlKey.error] {
            return try decodeJSON(encoded)
        }
        return .rejected(try decodeRejection(dictionary))
    }

    public static func decodeRejection(
        _ dictionary: XPCDictionary
    ) throws -> BrokerRejectionReason {
        if let encoded: String = dictionary[rejectionKey] {
            return try decodeJSON(encoded)
        }
        let reason: String = dictionary[BrokerControlKey.reason] ?? "unspecified rejection"
        return .invalidRequest(reason)
    }

    public static func decodeWorkerDiagnostics(
        _ dictionary: XPCDictionary
    ) throws -> IOSBrokerWireDiagnostics {
        guard try messageKind(in: dictionary) == .diagnostics else {
            throw BrokerError.protocolViolation("expected Diagnostics control reply")
        }
        let epochText = try string(dictionary, BrokerControlKey.epoch)
        guard let epochUUID = UUID(uuidString: epochText) else {
            throw BrokerError.protocolViolation("diagnostics contains an invalid epoch")
        }
        let pidValue = try int64(dictionary, BrokerControlKey.extensionPID)
        guard let pid = Int32(exactly: pidValue) else {
            throw BrokerError.protocolViolation("diagnostics contains an invalid worker PID")
        }
        let activeRequestID: BrokerRequestID?
        if let rawRequestID: UInt64 = dictionary[activeRequestIDKey] {
            activeRequestID = try BrokerRequestID(validating: rawRequestID)
        } else {
            activeRequestID = nil
        }
        guard let nativeDispatchStarted: Bool = dictionary[nativeDispatchStartedKey] else {
            throw BrokerError.protocolViolation(
                "diagnostics is missing nativeDispatchStarted"
            )
        }
        let encodedCapabilities = try string(dictionary, capabilitiesKey)
        return IOSBrokerWireDiagnostics(
            state: try string(dictionary, stateKey),
            epoch: BrokerEpoch(epochUUID),
            extensionProcessIdentifier: pid,
            manifestDigest: dictionary[manifestDigestKey],
            activeRequestID: activeRequestID,
            nativeDispatchStarted: nativeDispatchStarted,
            transactionStatus: try string(dictionary, transactionStatusKey),
            capabilities: try decodeJSON(encodedCapabilities),
            currentPhysFootprintBytes: dictionary[currentPhysFootprintBytesKey],
            currentResidentBytes: dictionary[currentResidentBytesKey],
            availableMemoryBytes: dictionary[availableMemoryBytesKey],
            checkpointInProgress: dictionary[checkpointInProgressKey] ?? false,
            checkpointMemorySample: try decodeCheckpointMemorySample(dictionary),
            storageProtectionEvidenceJSON: dictionary[storageProtectionEvidenceJSONKey],
            extensionEntryPreOpenPhysFootprintBytes: dictionary[
                extensionEntryPreOpenPhysFootprintBytesKey
            ],
            extensionEntryPreOpenResidentBytes: dictionary[
                extensionEntryPreOpenResidentBytesKey
            ],
            openedIdlePhysFootprintBytes: dictionary[openedIdlePhysFootprintBytesKey],
            openedIdleResidentBytes: dictionary[openedIdleResidentBytesKey]
        )
    }

    public static func makeControl(_ envelope: IOSBrokerControlEnvelope) -> XPCDictionary {
        var dictionary = XPCDictionary()
        dictionary[BrokerControlKey.message] = envelope.kind.rawValue
        if let epoch = envelope.epoch {
            dictionary[BrokerControlKey.epoch] = epoch.description
        }
        if let requestID = envelope.requestID {
            dictionary[BrokerControlKey.requestID] = requestID.rawValue
        }
        if let deadline = envelope.deadlineUnixNanoseconds {
            dictionary[BrokerControlKey.deadlineUnixNanoseconds] = deadline
        }
        if let fault = envelope.fault {
            dictionary[BrokerControlKey.fault] = fault.rawValue
        }
        return dictionary
    }

    public static func decodeControl(
        _ dictionary: XPCDictionary
    ) throws
        -> IOSBrokerControlEnvelope
    {
        let kind = try messageKind(in: dictionary)
        let epoch: BrokerEpoch?
        if let value: String = dictionary[BrokerControlKey.epoch] {
            guard let uuid = UUID(uuidString: value) else {
                throw BrokerError.protocolViolation("control message has an invalid epoch")
            }
            epoch = BrokerEpoch(uuid)
        } else {
            epoch = nil
        }
        let requestID: BrokerRequestID?
        if let raw: UInt64 = dictionary[BrokerControlKey.requestID] {
            requestID = try BrokerRequestID(validating: raw)
        } else {
            requestID = nil
        }
        let deadline: UInt64? = dictionary[BrokerControlKey.deadlineUnixNanoseconds]
        let fault: BrokerWorkerFault?
        if let rawFault: String = dictionary[BrokerControlKey.fault] {
            guard let value = BrokerWorkerFault(rawValue: rawFault) else {
                throw BrokerError.protocolViolation("control message has an unknown fault")
            }
            fault = value
        } else {
            fault = nil
        }
        return IOSBrokerControlEnvelope(
            kind: kind,
            epoch: epoch,
            requestID: requestID,
            deadlineUnixNanoseconds: deadline,
            fault: fault
        )
    }

    public static func makeAcknowledgement(
        _ kind: BrokerControlMessageKind,
        success: Bool = true
    ) -> XPCDictionary {
        var dictionary = XPCDictionary()
        dictionary[BrokerControlKey.message] = kind.rawValue
        dictionary[successKey] = success
        return dictionary
    }

    public static func messageKind(
        in dictionary: XPCDictionary
    ) throws -> BrokerControlMessageKind {
        let value = try string(dictionary, BrokerControlKey.message)
        guard let kind = BrokerControlMessageKind(rawValue: value) else {
            throw BrokerError.protocolViolation("unknown control message '\(value)'")
        }
        return kind
    }

    public static func duplicateDescriptor(
        in dictionary: XPCDictionary,
        key: String
    ) throws -> IOSBrokerOwnedFileDescriptor {
        guard let boxed = dictionary[key, as: XPC_TYPE_FD] else {
            throw BrokerError.protocolViolation("missing XPC file descriptor '\(key)'")
        }
        let duplicate = xpc_fd_dup(boxed)
        guard duplicate >= 0 else {
            throw POSIXError(.EBADF)
        }
        return try IOSBrokerOwnedFileDescriptor(takingOwnershipOf: duplicate)
    }

    private static func box(_ descriptor: IOSBrokerOwnedFileDescriptor) throws -> xpc_object_t {
        let rawDescriptor = try descriptor.borrowedDescriptor()
        guard let boxed = xpc_fd_create(rawDescriptor) else {
            throw POSIXError(.EBADF)
        }
        return boxed
    }

    private static func string(_ dictionary: XPCDictionary, _ key: String) throws -> String {
        guard let value: String = dictionary[key] else {
            throw BrokerError.protocolViolation("missing string control field '\(key)'")
        }
        return value
    }

    private static func uint16(_ dictionary: XPCDictionary, _ key: String) throws -> UInt16 {
        let raw = try uint64(dictionary, key)
        guard let value = UInt16(exactly: raw) else {
            throw BrokerError.protocolViolation("control field '\(key)' exceeds UInt16")
        }
        return value
    }

    private static func uint32(_ dictionary: XPCDictionary, _ key: String) throws -> UInt32 {
        let raw = try uint64(dictionary, key)
        guard let value = UInt32(exactly: raw) else {
            throw BrokerError.protocolViolation("control field '\(key)' exceeds UInt32")
        }
        return value
    }

    private static func uint64(_ dictionary: XPCDictionary, _ key: String) throws -> UInt64 {
        guard let value: UInt64 = dictionary[key] else {
            throw BrokerError.protocolViolation("missing unsigned control field '\(key)'")
        }
        return value
    }

    private static func int64(_ dictionary: XPCDictionary, _ key: String) throws -> Int64 {
        guard let value: Int64 = dictionary[key] else {
            throw BrokerError.protocolViolation("missing signed control field '\(key)'")
        }
        return value
    }

    private static func decodeCheckpointMemorySample(
        _ dictionary: XPCDictionary
    ) throws -> IOSBrokerWireCheckpointMemorySample? {
        let values: [UInt64?] = [
            dictionary[checkpointMemorySampleSequenceKey],
            dictionary[checkpointMemorySampleStartedAtUptimeNanosecondsKey],
            dictionary[checkpointMemorySampledAtUptimeNanosecondsKey],
            dictionary[checkpointMemorySampleCompletedAtUptimeNanosecondsKey],
            dictionary[checkpointMemorySamplePhysFootprintBytesKey],
            dictionary[checkpointMemorySampleResidentBytesKey],
            dictionary[checkpointMemorySampleAvailableMemoryBytesKey],
        ]
        if values.allSatisfy({ $0 == nil }) {
            return nil
        }
        guard
            let sequence = values[0],
            let startedAtUptimeNanoseconds = values[1],
            let sampledAtUptimeNanoseconds = values[2],
            let completedAtUptimeNanoseconds = values[3],
            let physFootprintBytes = values[4],
            let residentBytes = values[5],
            let availableMemoryBytes = values[6]
        else {
            throw BrokerError.protocolViolation(
                "diagnostics contains incomplete checkpoint memory evidence"
            )
        }
        return IOSBrokerWireCheckpointMemorySample(
            sequence: sequence,
            startedAtUptimeNanoseconds: startedAtUptimeNanoseconds,
            sampledAtUptimeNanoseconds: sampledAtUptimeNanoseconds,
            completedAtUptimeNanoseconds: completedAtUptimeNanoseconds,
            physFootprintBytes: physFootprintBytes,
            residentBytes: residentBytes,
            availableMemoryBytes: availableMemoryBytes
        )
    }

    private static let pathFreeConfigurationReasons: Set<String> = [
        "minimum protocol version exceeds maximum",
        "startup-configuration digest mismatch",
    ]

    private static let pathFreeInvalidRequestReasons: Set<String> = [
        "a broker data channel is already active",
        "a data channel is already active",
        "cannot checkpoint while a request is active",
        "cannot detach while a request is active",
    ]

    private static func encodeJSON<T: Encodable>(_ value: T) throws -> String {
        let data = try JSONEncoder().encode(value)
        guard let encoded = String(data: data, encoding: .utf8) else {
            throw BrokerError.protocolViolation("failed to encode UTF-8 control field")
        }
        return encoded
    }

    private static func decodeJSON<T: Decodable>(_ value: String) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: Data(value.utf8))
        } catch {
            throw BrokerError.protocolViolation("invalid JSON control field: \(error)")
        }
    }
}
