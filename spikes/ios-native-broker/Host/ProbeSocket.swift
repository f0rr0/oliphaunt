import Darwin
import Foundation
import OliphauntBrokerProtocol

final class ProbeSocketPair: @unchecked Sendable {
    let host: ProbeSocket
    private let lock = NSLock()
    private var workerOriginal: Int32

    var workerDescriptor: Int32 {
        lock.withLock { workerOriginal }
    }

    func takeWorkerDescriptor() throws -> Int32 {
        try lock.withLock {
            guard workerOriginal >= 0 else {
                throw ProbeSocketError.systemCall("take worker descriptor", EBADF)
            }
            let descriptor = workerOriginal
            workerOriginal = -1
            return descriptor
        }
    }

    init() throws {
        var descriptors = [Int32](repeating: -1, count: 2)
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
            throw ProbeSocketError.systemCall("socketpair", errno)
        }
        do {
            try ProbeSocket.configure(descriptors[0])
            try ProbeSocket.configure(descriptors[1])
        } catch {
            Darwin.close(descriptors[0])
            Darwin.close(descriptors[1])
            throw error
        }
        host = ProbeSocket(adopting: descriptors[0])
        workerOriginal = descriptors[1]
    }

    deinit {
        closeWorkerOriginal()
    }

    func closeWorkerOriginal() {
        lock.withLock {
            if workerOriginal >= 0 {
                Darwin.close(workerOriginal)
                workerOriginal = -1
            }
        }
    }
}

final class ProbeSocket: @unchecked Sendable {
    private let descriptor: Int32
    private let ioQueue = DispatchQueue(label: "dev.oliphaunt.brokerspike.socket")
    private let closeLock = NSLock()
    private var closed = false
    private var decoder = BrokerFrameDecoder()
    private var pendingFrames: [BrokerFrame] = []

    init(adopting descriptor: Int32) {
        self.descriptor = descriptor
    }

    deinit {
        close()
    }

    static func configure(_ descriptor: Int32) throws {
        let descriptorFlags = fcntl(descriptor, F_GETFD)
        guard descriptorFlags >= 0,
            fcntl(descriptor, F_SETFD, descriptorFlags | FD_CLOEXEC) == 0
        else {
            throw ProbeSocketError.systemCall("fcntl(FD_CLOEXEC)", errno)
        }
        let statusFlags = fcntl(descriptor, F_GETFL)
        guard statusFlags >= 0,
            fcntl(descriptor, F_SETFL, statusFlags | O_NONBLOCK) == 0
        else {
            throw ProbeSocketError.systemCall("fcntl(O_NONBLOCK)", errno)
        }
        var enabled: Int32 = 1
        guard
            setsockopt(
                descriptor,
                SOL_SOCKET,
                SO_NOSIGPIPE,
                &enabled,
                socklen_t(MemoryLayout.size(ofValue: enabled))
            ) == 0
        else {
            throw ProbeSocketError.systemCall("setsockopt(SO_NOSIGPIPE)", errno)
        }
    }

    func write(_ data: Data) async throws {
        try await onIOQueue {
            try Self.writeAll(data, to: self.descriptor)
        }
    }

    func writeFragmented(_ data: Data) async throws {
        var offset = 0
        var fragment = 1
        while offset < data.count {
            let end = min(data.count, offset + fragment)
            try await write(data.subdata(in: offset..<end))
            offset = end
            fragment = fragment == 7 ? 1 : fragment + 1
        }
    }

    func readFrame(expectedEpoch: BrokerEpoch) async throws -> BrokerFrame {
        try await onIOQueue {
            self.decoder.expectedEpoch = expectedEpoch
            if !self.pendingFrames.isEmpty {
                return self.pendingFrames.removeFirst()
            }
            while true {
                let bytes = try Self.readSome(from: self.descriptor)
                self.pendingFrames.append(contentsOf: try self.decoder.append(bytes))
                if !self.pendingFrames.isEmpty {
                    return self.pendingFrames.removeFirst()
                }
            }
        }
    }

    func close() {
        closeLock.withLock {
            guard !closed else { return }
            closed = true
            Darwin.close(descriptor)
        }
    }

    private func onIOQueue<T: Sendable>(
        _ work: @escaping @Sendable () throws -> T
    ) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            ioQueue.async {
                continuation.resume(with: Result(catching: work))
            }
        }
    }

    private static func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            var offset = 0
            while offset < rawBuffer.count {
                let written = Darwin.write(
                    descriptor,
                    base.advanced(by: offset),
                    rawBuffer.count - offset
                )
                if written > 0 {
                    offset += written
                } else if written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                    try wait(descriptor: descriptor, events: Int16(POLLOUT))
                } else if written < 0 && errno == EINTR {
                    continue
                } else {
                    throw ProbeSocketError.systemCall("write", errno)
                }
            }
        }
    }

    private static func readSome(from descriptor: Int32) throws -> Data {
        var storage = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(descriptor, &storage, storage.count)
            if count > 0 {
                return Data(storage.prefix(count))
            }
            if count == 0 {
                throw ProbeSocketError.endOfFile
            }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                try wait(descriptor: descriptor, events: Int16(POLLIN))
            } else if errno != EINTR {
                throw ProbeSocketError.systemCall("read", errno)
            }
        }
    }

    private static func wait(descriptor: Int32, events: Int16) throws {
        var item = pollfd(fd: descriptor, events: events, revents: 0)
        while true {
            let result = Darwin.poll(&item, 1, 5_000)
            if result > 0 { return }
            if result == 0 { throw ProbeSocketError.timeout }
            if errno != EINTR {
                throw ProbeSocketError.systemCall("poll", errno)
            }
        }
    }
}

enum ProbeSocketError: Error, CustomStringConvertible {
    case systemCall(String, Int32)
    case endOfFile
    case timeout

    var description: String {
        switch self {
        case .systemCall(let name, let code): "\(name) failed: \(String(cString: strerror(code)))"
        case .endOfFile: "broker socket closed"
        case .timeout: "broker socket timed out"
        }
    }
}
