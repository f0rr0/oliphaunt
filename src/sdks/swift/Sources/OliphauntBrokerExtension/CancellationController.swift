import Foundation
import Oliphaunt
import OliphauntBrokerProtocol

/// Result of attempting the low-latency cancellation path.
public enum BrokerCancellationSignalResult: Equatable, Sendable {
    /// The request is not the request currently executing in native code.
    case notRunning
    /// This request already has a native cancellation signal in flight.
    case alreadyRequested
    /// `OliphauntSession.cancel()` accepted the signal.
    ///
    /// This is deliberately not called "observed". Observation is reported only
    /// after the backend emits SQLSTATE 57014 for this request.
    case signalSent
}

public struct BrokerCancellationSnapshot: Equatable, Sendable {
    public var requested: Bool
    public var signalSent: Bool
    public var observedByBackend: Bool

    public init(
        requested: Bool,
        signalSent: Bool,
        observedByBackend: Bool
    ) {
        self.requested = requested
        self.signalSent = signalSent
        self.observedByBackend = observedByBackend
    }
}

/// A cancellation fast path that is intentionally independent of `WorkerCore`.
///
/// XPC glue should call this object directly from its control-message handler.
/// The native-direct session's cancellation witness bypasses the serialized
/// request actor, so a long-running PostgreSQL call cannot starve cancellation.
public final class CancellationController: @unchecked Sendable {
    private struct RunningRequest {
        let epoch: BrokerEpoch
        let requestID: BrokerRequestID
        let session: any OliphauntSession
        var nativeTransportActive: Bool
        var requested: Bool
        var signalSent: Bool
        var observedByBackend: Bool
    }

    private let lock = NSLock()
    private var running: RunningRequest?

    public init() {}

    public var activeRequest: (epoch: BrokerEpoch, requestID: BrokerRequestID)? {
        lock.withBrokerLock {
            running.map { ($0.epoch, $0.requestID) }
        }
    }

    /// Installs the only native request that may receive an out-of-band cancel.
    /// WorkerCore calls this immediately before native dispatch.
    func beginNativeRequest(
        epoch: BrokerEpoch,
        requestID: BrokerRequestID,
        session: any OliphauntSession
    ) throws {
        try lock.withBrokerLock {
            guard running == nil else {
                throw BrokerError.protocolViolation(
                    "cancellation target replaced while another request is running"
                )
            }
            running = RunningRequest(
                epoch: epoch,
                requestID: requestID,
                session: session,
                nativeTransportActive: true,
                requested: false,
                signalSent: false,
                observedByBackend: false
            )
        }
    }

    /// Signals native cancellation without ever entering WorkerCore's actor.
    public func requestCancellation(
        epoch: BrokerEpoch,
        requestID: BrokerRequestID
    ) async throws -> BrokerCancellationSignalResult {
        let session: (any OliphauntSession)? = lock.withBrokerLock {
            guard var target = running,
                target.epoch == epoch,
                target.requestID == requestID,
                target.nativeTransportActive
            else {
                return nil
            }
            guard !target.requested else {
                return nil
            }
            target.requested = true
            running = target
            return target.session
        }

        guard let session else {
            return lock.withBrokerLock {
                guard let target = running,
                    target.epoch == epoch,
                    target.requestID == requestID,
                    target.nativeTransportActive,
                    target.requested
                else {
                    return .notRunning
                }
                return .alreadyRequested
            }
        }

        do {
            try await session.cancel()
            lock.withBrokerLock {
                guard var target = running,
                    target.epoch == epoch,
                    target.requestID == requestID
                else { return }
                target.signalSent = true
                running = target
            }
            return .signalSent
        } catch {
            lock.withBrokerLock {
                guard var target = running,
                    target.epoch == epoch,
                    target.requestID == requestID
                else { return }
                target.requested = false
                running = target
            }
            throw error
        }
    }

    /// Closes the cancellation race as soon as a complete ReadyForQuery is seen,
    /// before a potentially backpressured socket writer returns to native code.
    func markNativeTransportComplete(
        epoch: BrokerEpoch,
        requestID: BrokerRequestID
    ) {
        lock.withBrokerLock {
            guard var target = running,
                target.epoch == epoch,
                target.requestID == requestID
            else { return }
            target.nativeTransportActive = false
            running = target
        }
    }

    /// SQLSTATE 57014 is the proof available from the current native API that
    /// PostgreSQL observed the cancellation request.
    func markCancellationObserved(
        epoch: BrokerEpoch,
        requestID: BrokerRequestID
    ) {
        lock.withBrokerLock {
            guard var target = running,
                target.epoch == epoch,
                target.requestID == requestID
            else { return }
            target.observedByBackend = true
            running = target
        }
    }

    @discardableResult
    func finishNativeRequest(
        epoch: BrokerEpoch,
        requestID: BrokerRequestID
    ) -> BrokerCancellationSnapshot {
        lock.withBrokerLock {
            guard let target = running,
                target.epoch == epoch,
                target.requestID == requestID
            else {
                return BrokerCancellationSnapshot(
                    requested: false,
                    signalSent: false,
                    observedByBackend: false
                )
            }
            running = nil
            return BrokerCancellationSnapshot(
                requested: target.requested,
                signalSent: target.signalSent,
                observedByBackend: target.observedByBackend
            )
        }
    }

    func abandonNativeRequest(
        epoch: BrokerEpoch,
        requestID: BrokerRequestID
    ) {
        lock.withBrokerLock {
            guard let target = running,
                target.epoch == epoch,
                target.requestID == requestID
            else { return }
            running = nil
        }
    }
}

extension NSLock {
    @discardableResult
    fileprivate func withBrokerLock<Result>(
        _ body: () throws -> Result
    ) rethrows -> Result {
        lock()
        defer { unlock() }
        return try body()
    }
}
