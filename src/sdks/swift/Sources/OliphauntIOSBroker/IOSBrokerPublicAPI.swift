import ExtensionFoundation
import Foundation
import Oliphaunt
import OliphauntBrokerProtocol
import OliphauntBrokerXPC

/// Host-side settings that must agree with the app-extension worker.
///
/// No filesystem URL is part of this value. Broker v1 always opens the logical
/// root named `default`; the extension alone resolves that name to PGDATA.
public struct IOSBrokerConfiguration: Equatable, Sendable {
    public var expectedABI: UInt32
    public var expectedRuntimeVersion: String?
    public var startupConfigurationDigest: String
    public var requestedCapabilities: Set<BrokerCapability>
    public var maximumRequestBytes: Int
    public var maximumRawResponseBytes: Int
    public var requestDeadline: Duration?
    public var extensionBundleIdentifier: String?
    public var controlReplyTimeout: Duration
    public var cancellationGracePeriod: Duration

    public init(
        expectedABI: UInt32,
        expectedRuntimeVersion: String? = nil,
        startupConfigurationDigest: String,
        requestedCapabilities: Set<BrokerCapability> = [
            .processIsolated,
            .crashRestartable,
            .sameRootLogicalReopen,
            .protocolRaw,
            .protocolStream,
            .queryCancel,
        ],
        maximumRequestBytes: Int = OliphauntBrokerProtocol.defaultMaximumRequestBytes,
        maximumRawResponseBytes: Int =
            OliphauntBrokerProtocol.maximumQueuedBytesPerDirection,
        requestDeadline: Duration? = .seconds(30),
        extensionBundleIdentifier: String? = nil,
        controlReplyTimeout: Duration = .seconds(15),
        cancellationGracePeriod: Duration = .seconds(2)
    ) {
        self.expectedABI = expectedABI
        self.expectedRuntimeVersion = expectedRuntimeVersion
        self.startupConfigurationDigest = startupConfigurationDigest
        self.requestedCapabilities = requestedCapabilities
        self.maximumRequestBytes = maximumRequestBytes
        self.maximumRawResponseBytes = maximumRawResponseBytes
        self.requestDeadline = requestDeadline
        self.extensionBundleIdentifier = extensionBundleIdentifier
        self.controlReplyTimeout = controlReplyTimeout
        self.cancellationGracePeriod = cancellationGracePeriod
    }

    func validated() throws -> IOSBrokerConfiguration {
        guard !startupConfigurationDigest.isEmpty else {
            throw BrokerError.invalidConfiguration("startup-configuration digest is empty")
        }
        guard maximumRequestBytes >= 5 else {
            throw BrokerError.invalidConfiguration("maximum request size must be at least 5 bytes")
        }
        guard maximumRequestBytes <= OliphauntBrokerProtocol.maximumQueuedBytesPerDirection else {
            throw BrokerError.invalidConfiguration(
                "maximum request size exceeds the bounded host queue"
            )
        }
        guard maximumRawResponseBytes > 0 else {
            throw BrokerError.invalidConfiguration("maximum raw response size must be positive")
        }
        guard
            maximumRawResponseBytes
                <= OliphauntBrokerProtocol.maximumQueuedBytesPerDirection
        else {
            throw BrokerError.invalidConfiguration(
                "maximum raw response size exceeds the bounded host response collector"
            )
        }
        if let requestDeadline, requestDeadline <= .zero {
            throw BrokerError.invalidConfiguration("request deadline must be positive")
        }
        guard controlReplyTimeout > .zero else {
            throw BrokerError.invalidConfiguration("control reply timeout must be positive")
        }
        guard cancellationGracePeriod > .zero else {
            throw BrokerError.invalidConfiguration("cancellation grace period must be positive")
        }
        if let extensionBundleIdentifier, extensionBundleIdentifier.isEmpty {
            throw BrokerError.invalidConfiguration("extension bundle identifier is empty")
        }
        return self
    }

    var hello: BrokerHello {
        BrokerHello(
            expectedABI: expectedABI,
            expectedRuntimeVersion: expectedRuntimeVersion,
            rootID: OliphauntBrokerProtocol.canonicalRootID,
            startupConfigurationDigest: startupConfigurationDigest,
            requestedCapabilities: requestedCapabilities
        )
    }
}

/// Runtime values useful to the simulator feasibility harness. The PID is
/// reported by the worker in `Ready`; ExtensionFoundation does not expose one.
public struct IOSBrokerDiagnostics: Equatable, Sendable {
    public var state: IOSBrokerManagerState
    public var epoch: BrokerEpoch?
    public var extensionProcessIdentifier: Int32?
    public var logicalHandleCount: Int
    public var queuedOperationCount: Int
    public var activeRequestID: BrokerRequestID?
    /// Number of `AppExtensionProcess` initializer attempts, including failures.
    public var launchAttemptCount: UInt64
    /// Number of attempts that reached and passed the worker `Ready` handshake.
    public var launchCount: UInt64
    public var interruptionCount: UInt64
    public var admissionsPaused: Bool

    public init(
        state: IOSBrokerManagerState,
        epoch: BrokerEpoch?,
        extensionProcessIdentifier: Int32?,
        logicalHandleCount: Int,
        queuedOperationCount: Int,
        activeRequestID: BrokerRequestID?,
        launchAttemptCount: UInt64,
        launchCount: UInt64,
        interruptionCount: UInt64,
        admissionsPaused: Bool = false
    ) {
        self.state = state
        self.epoch = epoch
        self.extensionProcessIdentifier = extensionProcessIdentifier
        self.logicalHandleCount = logicalHandleCount
        self.queuedOperationCount = queuedOperationCount
        self.activeRequestID = activeRequestID
        self.launchAttemptCount = launchAttemptCount
        self.launchCount = launchCount
        self.interruptionCount = interruptionCount
        self.admissionsPaused = admissionsPaused
    }
}

/// A sanitized worker snapshot returned over the diagnostics control message.
/// It intentionally contains no extension-private filesystem paths.
public struct IOSBrokerCheckpointMemorySample: Equatable, Sendable {
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

    init(wire: IOSBrokerWireCheckpointMemorySample) {
        self.init(
            sequence: wire.sequence,
            startedAtUptimeNanoseconds: wire.startedAtUptimeNanoseconds,
            sampledAtUptimeNanoseconds: wire.sampledAtUptimeNanoseconds,
            completedAtUptimeNanoseconds: wire.completedAtUptimeNanoseconds,
            physFootprintBytes: wire.physFootprintBytes,
            residentBytes: wire.residentBytes,
            availableMemoryBytes: wire.availableMemoryBytes
        )
    }
}

public struct IOSBrokerWorkerDiagnostics: Equatable, Sendable {
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
    public var checkpointMemorySample: IOSBrokerCheckpointMemorySample?
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
        availableMemoryBytes: UInt64? = nil,
        checkpointInProgress: Bool = false,
        checkpointMemorySample: IOSBrokerCheckpointMemorySample? = nil,
        storageProtectionEvidenceJSON: String? = nil,
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
        self.extensionEntryPreOpenPhysFootprintBytes = extensionEntryPreOpenPhysFootprintBytes
        self.extensionEntryPreOpenResidentBytes = extensionEntryPreOpenResidentBytes
        self.openedIdlePhysFootprintBytes = openedIdlePhysFootprintBytes
        self.openedIdleResidentBytes = openedIdleResidentBytes
    }

    init(wire: IOSBrokerWireDiagnostics) {
        self.init(
            state: wire.state,
            epoch: wire.epoch,
            extensionProcessIdentifier: wire.extensionProcessIdentifier,
            manifestDigest: wire.manifestDigest,
            activeRequestID: wire.activeRequestID,
            nativeDispatchStarted: wire.nativeDispatchStarted,
            transactionStatus: wire.transactionStatus,
            capabilities: wire.capabilities,
            currentPhysFootprintBytes: wire.currentPhysFootprintBytes,
            currentResidentBytes: wire.currentResidentBytes,
            availableMemoryBytes: wire.availableMemoryBytes,
            checkpointInProgress: wire.checkpointInProgress,
            checkpointMemorySample: wire.checkpointMemorySample.map(
                IOSBrokerCheckpointMemorySample.init(wire:)
            ),
            storageProtectionEvidenceJSON: wire.storageProtectionEvidenceJSON,
            extensionEntryPreOpenPhysFootprintBytes:
                wire.extensionEntryPreOpenPhysFootprintBytes,
            extensionEntryPreOpenResidentBytes:
                wire.extensionEntryPreOpenResidentBytes,
            openedIdlePhysFootprintBytes: wire.openedIdlePhysFootprintBytes,
            openedIdleResidentBytes: wire.openedIdleResidentBytes
        )
    }
}

@available(iOS 26.0, macOS 26.0, *)
extension AppExtensionPoint {
    /// Bundle-only, non-UI extension point emitted into the containing app by
    /// Xcode when `EX_ENABLE_EXTENSION_POINT_GENERATION=YES` is enabled.
    @Definition public static var oliphauntBroker: AppExtensionPoint {
        Name("OliphauntBroker")
        UserInterface(false)
    }
}

@available(iOS 26.0, macOS 26.0, *)
enum IOSBrokerExtensionDiscovery {
    static func discover(bundleIdentifier: String?) async throws -> AppExtensionIdentity {
        let monitor: AppExtensionPoint.Monitor
        do {
            monitor = try await AppExtensionPoint.Monitor(appExtensionPoint: .oliphauntBroker)
        } catch {
            throw BrokerError.extensionMissing
        }

        let identities = monitor.identities.filter { identity in
            bundleIdentifier.map { identity.bundleIdentifier == $0 } ?? true
        }
        guard !identities.isEmpty else {
            throw BrokerError.extensionMissing
        }
        guard identities.count == 1 else {
            let choices = identities.map(\.bundleIdentifier).sorted().joined(separator: ", ")
            throw BrokerError.invalidConfiguration(
                "multiple broker extensions were discovered (\(choices)); select a bundle identifier"
            )
        }
        return identities[0]
    }
}

@available(iOS 26.0, macOS 26.0, *)
public struct IOSBrokerEngine: OliphauntEngine, OliphauntEngineSupportProvider {
    public static let nativeServerUnavailableReason =
        "NativeServer is unavailable on iOS; the broker exposes no listener or connection string"

    public let configuration: IOSBrokerConfiguration
    public let manager: IOSBrokerManager

    public init(
        configuration: IOSBrokerConfiguration,
        manager: IOSBrokerManager = .shared
    ) {
        self.configuration = configuration
        self.manager = manager
    }

    public var supportedModes: [OliphauntEngineModeSupport] {
        [
            OliphauntEngineModeSupport(
                mode: .nativeDirect,
                available: false,
                capabilities: OliphauntSDKSupport.capabilities(for: .nativeDirect),
                unavailableReason: "this engine is the iOS out-of-process broker adapter"
            ),
            OliphauntEngineModeSupport(
                mode: .nativeBroker,
                available: true,
                capabilities: IOSBrokerCapabilityMapping.initial
            ),
            OliphauntEngineModeSupport(
                mode: .nativeServer,
                available: false,
                capabilities: OliphauntSDKSupport.capabilities(for: .nativeServer),
                unavailableReason: Self.nativeServerUnavailableReason
            ),
        ]
    }

    public func open(
        configuration databaseConfiguration: OliphauntConfiguration
    ) async throws
        -> any OliphauntSession
    {
        guard databaseConfiguration.mode == .nativeBroker else {
            throw OliphauntError.runtimeUnavailable(databaseConfiguration.mode)
        }
        return try await manager.open(
            configuration: configuration,
            databaseConfiguration: databaseConfiguration
        )
    }

    public func restore(_ request: OliphauntRestoreRequest) async throws -> URL {
        throw OliphauntError.engine(
            "iOS NativeBroker backup/restore is unavailable until a bounded streaming archive API exists"
        )
    }
}

enum IOSBrokerCapabilityMapping {
    static let initial = OliphauntCapabilities(
        mode: .nativeBroker,
        processIsolated: true,
        multiRoot: false,
        reopenable: true,
        sameRootLogicalReopen: true,
        rootSwitchable: false,
        crashRestartable: true,
        independentSessions: false,
        maxClientSessions: 1,
        protocolRaw: true,
        protocolStream: true,
        queryCancel: true,
        backupRestore: false,
        backupFormats: [],
        restoreFormats: [],
        simpleQuery: true,
        extensions: true,
        connectionString: nil
    )

    static func map(_ broker: BrokerCapabilities) -> OliphauntCapabilities {
        OliphauntCapabilities(
            mode: .nativeBroker,
            processIsolated: broker.processIsolated,
            multiRoot: false,
            reopenable: broker.sameRootLogicalReopen,
            sameRootLogicalReopen: broker.sameRootLogicalReopen,
            rootSwitchable: false,
            crashRestartable: broker.crashRestartable,
            independentSessions: false,
            maxClientSessions: 1,
            protocolRaw: broker.protocolRaw,
            protocolStream: broker.protocolStream,
            queryCancel: broker.queryCancel,
            backupRestore: false,
            backupFormats: [],
            restoreFormats: [],
            simpleQuery: true,
            extensions: true,
            connectionString: nil
        )
    }
}
