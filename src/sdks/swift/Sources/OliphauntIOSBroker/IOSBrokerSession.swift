import Foundation
import Oliphaunt
import OliphauntBrokerProtocol

/// A logical attachment to the one physical broker session.
///
/// Multiple instances share the application-scoped manager and its FIFO.
/// Closing this value only releases its logical reference; it does not claim
/// that `AppExtensionProcess.invalidate()` terminated the worker process.
@available(iOS 26.0, macOS 26.0, *)
public actor IOSBrokerSession: OliphauntSession {
    private let manager: IOSBrokerManager
    private let handleID: UUID
    private let maximumRawResponseBytes: Int
    private var closed = false

    init(
        manager: IOSBrokerManager,
        handleID: UUID,
        maximumRawResponseBytes: Int
    ) {
        self.manager = manager
        self.handleID = handleID
        self.maximumRawResponseBytes = maximumRawResponseBytes
    }

    public func capabilities() async -> OliphauntCapabilities {
        await manager.capabilities(for: handleID)
    }

    public func workerDiagnostics() async throws -> IOSBrokerWorkerDiagnostics {
        try requireOpen()
        return try await manager.workerDiagnostics(handleID: handleID)
    }

    public func execProtocolRaw(_ bytes: Data) async throws -> Data {
        try requireOpen()
        let collector = IOSBrokerResponseCollector(
            maximumBytes: maximumRawResponseBytes
        )
        try await manager.execute(handleID: handleID, bytes: bytes) { chunk in
            try collector.append(chunk)
        }
        return collector.value
    }

    public func execProtocolStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws {
        try requireOpen()
        try await manager.execute(
            handleID: handleID,
            bytes: bytes,
            onChunk: onChunk
        )
    }

    public func backup(
        _ request: OliphauntBackupRequest
    ) async throws -> OliphauntBackupArtifact {
        try requireOpen()
        throw OliphauntError.engine(
            "iOS NativeBroker backup is unavailable: whole-archive Data transfer is not memory bounded"
        )
    }

    public func checkpoint() async throws {
        try requireOpen()
        try await manager.checkpoint(handleID: handleID)
    }

    public func prepareForBackground(
        deadline: Date
    ) async throws -> OliphauntBackgroundPreparationResult {
        try requireOpen()
        return try await manager.prepareForBackground(
            handleID: handleID,
            deadline: deadline
        )
    }

    public func prepareForBackground(
        timeout: Duration = .seconds(5)
    ) async throws -> OliphauntBackgroundPreparationResult {
        try requireOpen()
        return try await manager.prepareForBackground(
            handleID: handleID,
            timeout: timeout
        )
    }

    public func resumeFromBackground() async throws {
        try requireOpen()
        try await manager.resumeFromBackground(handleID: handleID)
    }

    public func cancel() async throws {
        try requireOpen()
        try await manager.cancel(handleID: handleID)
    }

    #if DEBUG
        /// Arms a one-shot extension fault for the simulator qualification fixture.
        /// This API is absent from distribution builds.
        public func injectFault(_ fault: BrokerWorkerFault) async throws {
            try requireOpen()
            try await manager.injectFault(handleID: handleID, fault: fault)
        }
    #endif

    public func close() async throws {
        guard !closed else {
            return
        }
        closed = true
        try await manager.close(handleID: handleID)
    }

    private func requireOpen() throws {
        guard !closed else {
            throw OliphauntError.databaseClosed
        }
    }
}

enum IOSBrokerRawResponseLimitError: Error, Equatable, Sendable {
    case exceeded(maximumBytes: Int)
}

final class IOSBrokerResponseCollector: @unchecked Sendable {
    private let lock = NSLock()
    private let maximumBytes: Int
    private var bytes = Data()

    init(maximumBytes: Int) {
        precondition(maximumBytes > 0)
        self.maximumBytes = maximumBytes
    }

    func append(_ chunk: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        guard chunk.count <= maximumBytes - bytes.count else {
            throw IOSBrokerRawResponseLimitError.exceeded(
                maximumBytes: maximumBytes
            )
        }
        bytes.append(chunk)
    }

    var value: Data {
        lock.lock()
        defer { lock.unlock() }
        return bytes
    }
}
