import Foundation
import OliphauntNativeBindings
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

package final class NativeDirectSession: OliphauntSession, Sendable {
    private let database: NativeDatabase

    package init(database: NativeDatabase) { self.database = database }

    package func execProtocolRaw(_ bytes: Data) async throws -> Data {
        let request = database.request()
        return try await withTaskCancellationHandler {
            do {
                let result = try await request.execute(bytes: bytes)
                return result
            } catch NativeError.NotSubmitted {
                throw OliphauntRequestNotSubmitted()
            } catch {
                throw nativeError(error)
            }
        } onCancel: {
            try? request.cancel()
        }
    }

    package func execProtocolRawUncancelled(_ bytes: Data) async throws -> Data {
        do { return try await database.request().execute(bytes: bytes) } catch {
            throw nativeError(error)
        }
    }

    package func execProtocolRawStream(
        _ bytes: Data,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws -> OliphauntProtocolStreamOutcome {
        let request = database.request()
        let sink = NativeStreamSink(onChunk: onChunk)
        return try await withTaskCancellationHandler {
            do {
                try await request.stream(bytes: bytes, sink: sink)
                return .complete
            } catch NativeError.Callback {
                // Rust reports Callback only after confirming ReadyForQuery.
                guard let error = sink.callbackError else {
                    throw OliphauntError.engine("stream callback failed without its original error")
                }
                return .callbackAborted(error)
            } catch NativeError.NotSubmitted {
                throw OliphauntRequestNotSubmitted()
            } catch {
                throw nativeError(error)
            }
        } onCancel: {
            try? request.cancel()
        }
    }

    package func backup() async throws -> Data {
        let request = database.request()
        return try await withTaskCancellationHandler {
            do { return try await request.backup() } catch { throw nativeError(error) }
        } onCancel: {
            try? request.cancel()
        }
    }
    package func backup(to destination: URL) async throws {
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(
            ".oliphaunt-archive-\(UUID().uuidString)")
        guard
            FileManager.default.createFile(
                atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600])
        else {
            throw OliphauntError.engine("could not create archive staging file")
        }
        defer { try? FileManager.default.removeItem(at: temporary) }
        let output = try FileHandle(forWritingTo: temporary)
        defer { try? output.close() }
        let request = database.request()
        try await withTaskCancellationHandler {
            do { try await request.backupToFd(fd: output.fileDescriptor) } catch {
                throw nativeError(error)
            }
            try output.synchronize()
            try FileManager.default.moveItem(at: temporary, to: destination)
            // FileHandle's URL initializer rejects directories on Apple platforms.
            let descriptor = open(destination.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY)
            guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let parent = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? parent.close() }
            try parent.synchronize()
        } onCancel: {
            try? request.cancel()
        }
    }
    package func cancel() async throws {
        do { try await database.cancel() } catch { throw nativeError(error) }
    }
    package func close() async throws {
        do { try await database.detach() } catch { throw nativeError(error) }
    }
}

private final class NativeStreamSink: ChunkSink, @unchecked Sendable {
    private let lock = NSLock()
    private let onChunk: @Sendable (Data) throws -> Void
    private var error: Error?

    init(onChunk: @escaping @Sendable (Data) throws -> Void) { self.onChunk = onChunk }
    var callbackError: Error? { lock.withLock { error } }
    func onChunk(bytes: Data) -> Bool {
        do {
            try onChunk(bytes)
            return true
        } catch {
            lock.withLock { self.error = error }
            return false
        }
    }
}

package func nativeError(_ error: Error) -> any Error {
    if case NativeError.Broker(let reason, let execution, let requiresReopen, let detail) = error {
        return OliphauntBrokerError(
            reason: brokerReason(reason),
            execution: brokerExecution(execution),
            requiresReopen: requiresReopen, detail: detail)
    }
    if case NativeError.NotSubmitted = error { return OliphauntRequestNotSubmitted() }
    if case NativeError.Database(let detail) = error { return OliphauntError.engine(detail) }
    return error
}

private func brokerReason(_ reason: BrokerReason) -> OliphauntBrokerError.Reason {
    switch reason {
    case .invalidRequest: .invalidRequest
    case .cancelled: .cancelled
    case .deadline: .deadline
    case .workerInterrupted: .workerInterrupted
    case .transport: .transport
    case .database: .database
    case .callback: .callback
    }
}
private func brokerExecution(_ execution: BrokerExecution) -> OliphauntBrokerError.Execution {
    switch execution {
    case .notStarted: .notStarted
    case .completed: .completed
    case .unknown: .unknown
    }
}
