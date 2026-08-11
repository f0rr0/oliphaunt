import Darwin
import Dispatch
import Foundation
import OliphauntBrokerProtocol

public enum BrokerSocketError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalidFileDescriptor
    case notStreamSocket
    case alreadyRunning
    case stopped
    case unexpectedEndOfFile
    case systemCall(name: String, code: Int32)

    public var description: String {
        switch self {
        case .invalidFileDescriptor: "invalid broker socket file descriptor"
        case .notStreamSocket: "broker data channel is not a SOCK_STREAM socket"
        case .alreadyRunning: "broker socket worker is already running"
        case .stopped: "broker socket worker was stopped"
        case .unexpectedEndOfFile: "broker socket closed without channelClose"
        case .systemCall(let name, let code):
            "\(name) failed (errno \(code): \(String(cString: strerror(code))))"
        }
    }
}

/// A synchronous, backpressured frame sink over an owned AF_UNIX socket FD.
///
/// There is no userspace output queue: the native streaming callback blocks on
/// the bounded socket send buffer when the host is slow. This keeps response
/// memory bounded without converting native streaming into whole-result buffering.
public final class BrokerSocketFrameSink: BrokerFrameSink, @unchecked Sendable {
    private let stateLock = NSLock()
    private let writeLock = NSLock()
    private var fileDescriptor: Int32
    private var stopping = false

    public init(ownedFileDescriptor: Int32) throws {
        guard ownedFileDescriptor >= 0 else {
            throw BrokerSocketError.invalidFileDescriptor
        }
        do {
            var socketType: Int32 = 0
            var socketTypeLength = socklen_t(MemoryLayout<Int32>.size)
            guard
                getsockopt(
                    ownedFileDescriptor,
                    SOL_SOCKET,
                    SO_TYPE,
                    &socketType,
                    &socketTypeLength
                ) == 0
            else {
                throw BrokerSocketError.systemCall(name: "getsockopt(SO_TYPE)", code: errno)
            }
            guard socketType == SOCK_STREAM else {
                throw BrokerSocketError.notStreamSocket
            }

            let descriptorFlags = fcntl(ownedFileDescriptor, F_GETFD)
            guard descriptorFlags >= 0,
                fcntl(ownedFileDescriptor, F_SETFD, descriptorFlags | FD_CLOEXEC) == 0
            else {
                throw BrokerSocketError.systemCall(name: "fcntl(FD_CLOEXEC)", code: errno)
            }
            // The host may create both socketpair endpoints as nonblocking before FD
            // transfer. This side intentionally uses bounded blocking I/O on its
            // private queue, so clear O_NONBLOCK on the received endpoint.
            let statusFlags = fcntl(ownedFileDescriptor, F_GETFL)
            guard statusFlags >= 0,
                fcntl(ownedFileDescriptor, F_SETFL, statusFlags & ~O_NONBLOCK) == 0
            else {
                throw BrokerSocketError.systemCall(name: "fcntl(clear O_NONBLOCK)", code: errno)
            }
            var noSigPipe: Int32 = 1
            guard
                setsockopt(
                    ownedFileDescriptor,
                    SOL_SOCKET,
                    SO_NOSIGPIPE,
                    &noSigPipe,
                    socklen_t(MemoryLayout<Int32>.size)
                ) == 0
            else {
                throw BrokerSocketError.systemCall(name: "setsockopt(SO_NOSIGPIPE)", code: errno)
            }
            // Keep the kernel buffer comfortably below the 8 MiB userspace target.
            // Darwin may adjust/double this value, but this implementation itself
            // never holds a second queued copy.
            var sendBufferBytes: Int32 = 512 * 1024
            _ = setsockopt(
                ownedFileDescriptor,
                SOL_SOCKET,
                SO_SNDBUF,
                &sendBufferBytes,
                socklen_t(MemoryLayout<Int32>.size)
            )
        } catch {
            _ = Darwin.close(ownedFileDescriptor)
            throw error
        }
        self.fileDescriptor = ownedFileDescriptor
    }

    deinit {
        requestStop()
        finishAndClose()
    }

    public func send(_ frame: BrokerFrame) throws {
        let bytes = try frame.encoded()
        writeLock.lock()
        defer { writeLock.unlock() }

        let descriptor = try descriptorForUse()
        try bytes.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else { return }
            var offset = 0
            while offset < rawBuffer.count {
                let written = Darwin.send(
                    descriptor,
                    baseAddress.advanced(by: offset),
                    rawBuffer.count - offset,
                    0
                )
                if written > 0 {
                    offset += written
                    continue
                }
                if written < 0, errno == EINTR { continue }
                let code = written == 0 ? EPIPE : errno
                throw BrokerSocketError.systemCall(name: "send", code: code)
            }
        }
    }

    /// Wakes blocked reads/writes without closing the numeric FD out from under
    /// an in-progress system call. The owning worker closes it after its loop exits.
    public func requestStop() {
        let descriptor: Int32? = stateLock.withSocketLock {
            guard fileDescriptor >= 0, !stopping else { return nil }
            stopping = true
            return fileDescriptor
        }
        if let descriptor {
            _ = shutdown(descriptor, SHUT_RDWR)
        }
    }

    func descriptorForRead() throws -> Int32 {
        try descriptorForUse()
    }

    func finishAndClose() {
        writeLock.lock()
        defer { writeLock.unlock() }
        let descriptor: Int32? = stateLock.withSocketLock {
            guard fileDescriptor >= 0 else { return nil }
            let result = fileDescriptor
            fileDescriptor = -1
            stopping = true
            return result
        }
        if let descriptor {
            _ = Darwin.close(descriptor)
        }
    }

    private func descriptorForUse() throws -> Int32 {
        try stateLock.withSocketLock {
            guard fileDescriptor >= 0, !stopping else {
                throw BrokerSocketError.stopped
            }
            return fileDescriptor
        }
    }
}

/// Runs bounded blocking socket I/O on a private GCD queue, never the main actor
/// or WorkerCore's actor executor. Frames are handed to WorkerCore serially.
public final class BrokerSocketWorker: @unchecked Sendable {
    private let core: WorkerCore
    private let sink: BrokerSocketFrameSink
    private let epoch: BrokerEpoch
    private let protocolVersion: UInt16
    private let ioQueue: DispatchQueue
    private let stateLock = NSLock()
    private var hasRun = false
    private var gracefulStopRequested = false

    public init(
        ownedFileDescriptor: Int32,
        core: WorkerCore,
        epoch: BrokerEpoch,
        protocolVersion: UInt16,
        queueLabel: String = "dev.oliphaunt.ios-broker.socket"
    ) throws {
        self.core = core
        self.sink = try BrokerSocketFrameSink(ownedFileDescriptor: ownedFileDescriptor)
        self.epoch = epoch
        self.protocolVersion = protocolVersion
        self.ioQueue = DispatchQueue(label: queueLabel, qos: .userInitiated)
    }

    deinit {
        sink.requestStop()
    }

    public func run() async throws {
        let mayRun = stateLock.withSocketLock {
            guard !hasRun else { return false }
            hasRun = true
            return true
        }
        guard mayRun else { throw BrokerSocketError.alreadyRunning }

        try await withCheckedThrowingContinuation { continuation in
            ioQueue.async { [self] in
                let result: Result<Void, Error>
                do {
                    try runBlocking()
                    result = .success(())
                } catch {
                    result = .failure(error)
                }
                continuation.resume(with: result)
            }
        }
    }

    public func stop() {
        sink.requestStop()
    }

    /// Wakes the worker and treats the externally requested shutdown as a
    /// clean detach instead of an interrupted epoch. Extension control glue
    /// uses this after accepting a Detach request.
    public func stopGracefully() {
        stateLock.withSocketLock {
            gracefulStopRequested = true
        }
        sink.requestStop()
    }

    private func runBlocking() throws {
        var decoder = BrokerSocketIncrementalFrameDecoder(
            expectedEpoch: epoch,
            expectedProtocolVersion: protocolVersion
        )
        var gracefulClose = false

        defer {
            sink.requestStop()
            sink.finishAndClose()
            let shouldDetach =
                gracefulClose
                || stateLock.withSocketLock {
                    gracefulStopRequested
                }
            if shouldDetach {
                _ = try? waitForActor {
                    try await self.core.detach(expectedEpoch: self.epoch)
                }
            } else {
                _ = try? waitForActor { await self.core.interruptCurrentEpoch() }
            }
        }

        do {
            let descriptor = try sink.descriptorForRead()
            var readBuffer = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let count = readBuffer.withUnsafeMutableBytes { rawBuffer in
                    Darwin.recv(descriptor, rawBuffer.baseAddress, rawBuffer.count, 0)
                }
                if count == 0 {
                    try decoder.finish()
                    throw BrokerSocketError.unexpectedEndOfFile
                }
                if count < 0 {
                    if errno == EINTR { continue }
                    if errno == EBADF || errno == ECONNRESET || errno == ENOTCONN {
                        throw BrokerSocketError.stopped
                    }
                    throw BrokerSocketError.systemCall(name: "recv", code: errno)
                }

                let frames = try decoder.append(Data(readBuffer[0..<count]))
                for frame in frames {
                    let result = try waitForActor {
                        try await self.core.handle(frame, sink: self.sink)
                    }
                    if result == .closeChannel {
                        gracefulClose = true
                        return
                    }
                }
            }
        } catch {
            if error is BrokerProtocolError {
                sendProtocolErrorBestEffort(error)
            }
            throw error
        }
    }

    private func sendProtocolErrorBestEffort(_ error: Error) {
        try? sink.send(
            try BrokerFrame(
                protocolVersion: protocolVersion,
                frameType: .protocolError,
                epoch: epoch,
                requestID: 0,
                payload: Data(String(describing: error).utf8)
            ))
    }
}

/// Unlike a generic Data buffer, this decoder allocates a payload only after a
/// validated 40-byte header and consumes exactly one bounded payload at a time.
/// Coalesced adjacent frames therefore never require a two-frame-sized buffer.
private struct BrokerSocketIncrementalFrameDecoder {
    private let expectedEpoch: BrokerEpoch
    private let expectedProtocolVersion: UInt16
    private var headerBytes = Data()
    private var currentHeader: BrokerFrameHeader?
    private var payloadBytes = Data()

    init(expectedEpoch: BrokerEpoch, expectedProtocolVersion: UInt16) {
        self.expectedEpoch = expectedEpoch
        self.expectedProtocolVersion = expectedProtocolVersion
        headerBytes.reserveCapacity(Int(OliphauntBrokerProtocol.headerLength))
    }

    mutating func append(_ bytes: Data) throws -> [BrokerFrame] {
        var frames: [BrokerFrame] = []
        var offset = 0
        while offset < bytes.count {
            if currentHeader == nil {
                let needed = Int(OliphauntBrokerProtocol.headerLength) - headerBytes.count
                let count = min(needed, bytes.count - offset)
                headerBytes.append(bytes.subdata(in: offset..<(offset + count)))
                offset += count
                guard headerBytes.count == Int(OliphauntBrokerProtocol.headerLength) else {
                    continue
                }
                let header = try BrokerFrameHeader.decode(
                    headerBytes,
                    expectedEpoch: expectedEpoch,
                    maximumPayloadLength: OliphauntBrokerProtocol.maximumFramePayload
                )
                guard header.protocolVersion == expectedProtocolVersion else {
                    throw BrokerProtocolError.unsupportedVersion(header.protocolVersion)
                }
                currentHeader = header
                payloadBytes = Data(capacity: Int(header.payloadLength))
                headerBytes.removeAll(keepingCapacity: true)
                if header.payloadLength == 0 {
                    frames.append(try finishFrame())
                }
                continue
            }

            guard let header = currentHeader else { continue }
            let needed = Int(header.payloadLength) - payloadBytes.count
            let count = min(needed, bytes.count - offset)
            payloadBytes.append(bytes.subdata(in: offset..<(offset + count)))
            offset += count
            if payloadBytes.count == Int(header.payloadLength) {
                frames.append(try finishFrame())
            }
        }
        return frames
    }

    mutating func finish() throws {
        guard headerBytes.isEmpty, currentHeader == nil, payloadBytes.isEmpty else {
            throw BrokerProtocolError.truncatedFrame
        }
    }

    private mutating func finishFrame() throws -> BrokerFrame {
        guard let header = currentHeader else {
            throw BrokerProtocolError.truncatedFrame
        }
        let frame = try BrokerFrame(
            protocolVersion: header.protocolVersion,
            frameType: header.frameType,
            flags: header.flags,
            epoch: header.epoch,
            requestID: header.requestID,
            payload: payloadBytes
        )
        currentHeader = nil
        payloadBytes.removeAll(keepingCapacity: false)
        return frame
    }
}

private final class BrokerBlockingResult<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Value, Error>?

    func set(_ result: Result<Value, Error>) {
        lock.withSocketLock { self.result = result }
    }

    func take() -> Result<Value, Error> {
        lock.withSocketLock {
            precondition(result != nil)
            return result!
        }
    }
}

private func waitForActor<Value: Sendable>(
    _ operation: @escaping @Sendable () async throws -> Value
) throws -> Value {
    let semaphore = DispatchSemaphore(value: 0)
    let box = BrokerBlockingResult<Value>()
    Task.detached {
        do {
            box.set(.success(try await operation()))
        } catch {
            box.set(.failure(error))
        }
        semaphore.signal()
    }
    semaphore.wait()
    return try box.take().get()
}

extension NSLock {
    fileprivate func withSocketLock<Result>(_ body: () throws -> Result) rethrows -> Result {
        lock()
        defer { unlock() }
        return try body()
    }
}
