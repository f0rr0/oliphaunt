import Darwin
import Dispatch
import Foundation
import OliphauntBrokerProtocol
import OliphauntBrokerXPC

enum IOSBrokerDataPlaneFailure: Error, Sendable {
    case rejected(BrokerRejectionReason)
    case outcomeUnknown(String)
    case protocolViolation(String)
}

/// Loss of the socket transport, distinct from a well-formed peer violating the
/// framed broker protocol. Data requests still translate this into
/// `outcomeUnknown`; lifecycle recovery may safely use it as an interruption
/// signal because it never replays caller SQL.
enum IOSBrokerTransportFailure: Error, Equatable, Sendable {
    case socketWrite(Int32)
    case socketRead(Int32)
    case unexpectedEOF
}

enum IOSBrokerBackendTransactionStatus: UInt8, Sendable {
    case idle = 0x49  // I
    case inTransaction = 0x54  // T
    case failedTransaction = 0x45  // E
}

struct IOSBrokerSocketPair {
    let host: IOSBrokerDataChannel
    let extensionEndpoint: IOSBrokerOwnedFileDescriptor

    static func make() throws -> IOSBrokerSocketPair {
        var descriptors: [Int32] = [-1, -1]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
            throw POSIXError(POSIXError.Code(rawValue: errno) ?? .EIO)
        }
        do {
            try configure(descriptors[0])
            try configure(descriptors[1])
            let extensionEndpoint = try IOSBrokerOwnedFileDescriptor(
                takingOwnershipOf: descriptors[1]
            )
            return IOSBrokerSocketPair(
                host: IOSBrokerDataChannel(takingOwnershipOf: descriptors[0]),
                extensionEndpoint: extensionEndpoint
            )
        } catch {
            Darwin.close(descriptors[0])
            Darwin.close(descriptors[1])
            throw error
        }
    }

    private static func configure(_ descriptor: Int32) throws {
        let descriptorFlags = fcntl(descriptor, F_GETFD)
        guard descriptorFlags >= 0,
            fcntl(descriptor, F_SETFD, descriptorFlags | FD_CLOEXEC) >= 0
        else {
            throw POSIXError(POSIXError.Code(rawValue: errno) ?? .EIO)
        }
        let statusFlags = fcntl(descriptor, F_GETFL)
        guard statusFlags >= 0,
            fcntl(descriptor, F_SETFL, statusFlags | O_NONBLOCK) >= 0
        else {
            throw POSIXError(POSIXError.Code(rawValue: errno) ?? .EIO)
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
            throw POSIXError(POSIXError.Code(rawValue: errno) ?? .EIO)
        }
    }
}

/// One epoch's host endpoint. DispatchIO supplies bounded, nonblocking I/O on a
/// private queue, and closing the channel interrupts outstanding reads/writes.
final class IOSBrokerDataChannel: @unchecked Sendable {
    private let queue = DispatchQueue(label: "dev.oliphaunt.ios-broker.data-channel")
    private let channel: DispatchIO
    private let closeLock = NSLock()
    private var isClosed = false

    init(takingOwnershipOf descriptor: Int32) {
        channel = DispatchIO(
            type: .stream,
            fileDescriptor: descriptor,
            queue: queue
        ) { _ in
            Darwin.close(descriptor)
        }
        channel.setLimit(lowWater: 1)
        channel.setLimit(
            highWater: Int(OliphauntBrokerProtocol.headerLength)
                + OliphauntBrokerProtocol.maximumFramePayload
        )
    }

    deinit {
        close()
    }

    func close() {
        closeLock.lock()
        guard !isClosed else {
            closeLock.unlock()
            return
        }
        isClosed = true
        closeLock.unlock()
        channel.close(flags: .stop)
    }

    func healthCheck(epoch: BrokerEpoch, protocolVersion: UInt16) async throws {
        let ping = try BrokerFrame(
            protocolVersion: protocolVersion,
            frameType: .ping,
            epoch: epoch,
            requestID: 0
        )
        try await write(ping)
        let reply = try await readFrame(expectedEpoch: epoch)
        guard reply.header.frameType == .pong,
            reply.header.requestID == 0,
            reply.payload.isEmpty
        else {
            throw IOSBrokerDataPlaneFailure.protocolViolation(
                "health check did not receive an empty Pong"
            )
        }
    }

    func execute(
        requestID: BrokerRequestID,
        epoch: BrokerEpoch,
        protocolVersion: UInt16,
        bytes: Data,
        maximumRequestBytes: Int,
        onChunk: @escaping @Sendable (Data) throws -> Void
    ) async throws -> IOSBrokerBackendTransactionStatus {
        var assembler = BrokerFrontendRequestAssembler(
            maximumRequestBytes: maximumRequestBytes
        )
        do {
            try assembler.append(bytes)
            _ = try assembler.finish()
        } catch {
            throw IOSBrokerDataPlaneFailure.protocolViolation(String(describing: error))
        }

        let rawRequestID = requestID.rawValue
        do {
            try await write(
                try BrokerFrame(
                    protocolVersion: protocolVersion,
                    frameType: .requestBegin,
                    epoch: epoch,
                    requestID: rawRequestID
                ))

            var offset = 0
            while offset < bytes.count {
                let end = min(
                    bytes.count,
                    offset + OliphauntBrokerProtocol.maximumFramePayload
                )
                try await write(
                    try BrokerFrame(
                        protocolVersion: protocolVersion,
                        frameType: .requestBytes,
                        epoch: epoch,
                        requestID: rawRequestID,
                        payload: bytes.subdata(in: offset..<end)
                    ))
                offset = end
            }
            try await write(
                try BrokerFrame(
                    protocolVersion: protocolVersion,
                    frameType: .requestEnd,
                    epoch: epoch,
                    requestID: rawRequestID
                ))
        } catch let failure as IOSBrokerDataPlaneFailure {
            throw failure
        } catch {
            // A DispatchIO write error cannot prove that zero bytes reached the
            // peer, so loss after the first write attempt is always ambiguous.
            throw IOSBrokerDataPlaneFailure.outcomeUnknown(String(describing: error))
        }

        var responseObserver = IOSBrokerBackendResponseObserver()
        while true {
            let frame: BrokerFrame
            do {
                frame = try await readFrame(expectedEpoch: epoch)
            } catch let failure as IOSBrokerDataPlaneFailure {
                throw failure
            } catch {
                throw IOSBrokerDataPlaneFailure.outcomeUnknown(String(describing: error))
            }
            guard frame.header.requestID == rawRequestID else {
                throw IOSBrokerDataPlaneFailure.protocolViolation(
                    "response request ID \(frame.header.requestID) does not match \(rawRequestID)"
                )
            }

            switch frame.header.frameType {
            case .responseBytes:
                do {
                    try responseObserver.append(frame.payload)
                    try onChunk(frame.payload)
                } catch {
                    throw IOSBrokerDataPlaneFailure.outcomeUnknown(
                        "response consumer failed before transport completion: \(error)"
                    )
                }
            case .cancelObserved:
                guard frame.payload.isEmpty else {
                    throw IOSBrokerDataPlaneFailure.protocolViolation(
                        "CancelObserved must not contain a payload"
                    )
                }
            case .completed:
                guard frame.payload.isEmpty else {
                    throw IOSBrokerDataPlaneFailure.protocolViolation(
                        "Completed must not contain a payload"
                    )
                }
                return try responseObserver.finish()
            case .rejected:
                throw IOSBrokerDataPlaneFailure.rejected(decodeRejection(frame.payload))
            case .outcomeUnknown:
                throw IOSBrokerDataPlaneFailure.outcomeUnknown(
                    String(data: frame.payload, encoding: .utf8) ?? "worker reported ambiguity"
                )
            case .protocolError:
                throw IOSBrokerDataPlaneFailure.protocolViolation(
                    String(data: frame.payload, encoding: .utf8) ?? "worker protocol error"
                )
            default:
                throw IOSBrokerDataPlaneFailure.protocolViolation(
                    "illegal worker frame \(frame.header.frameType) while a request is active"
                )
            }
        }
    }

    private func write(_ frame: BrokerFrame) async throws {
        try await write(frame.encoded())
    }

    private func write(_ bytes: Data) async throws {
        guard
            bytes.count <= Int(OliphauntBrokerProtocol.headerLength)
                + OliphauntBrokerProtocol.maximumFramePayload
        else {
            throw BrokerProtocolError.payloadTooLarge(
                actual: UInt64(bytes.count),
                maximum: Int(OliphauntBrokerProtocol.headerLength)
                    + OliphauntBrokerProtocol.maximumFramePayload
            )
        }
        let payload = bytes.withUnsafeBytes { DispatchData(bytes: $0) }
        try await withCheckedThrowingContinuation { continuation in
            let state = IOWriteState(continuation: continuation)
            channel.write(offset: 0, data: payload, queue: queue) { done, _, error in
                state.consume(done: done, error: error)
            }
        }
    }

    private func readFrame(expectedEpoch: BrokerEpoch) async throws -> BrokerFrame {
        let headerBytes = try await readExactly(Int(OliphauntBrokerProtocol.headerLength))
        let header: BrokerFrameHeader
        do {
            header = try BrokerFrameHeader.decode(
                headerBytes,
                expectedEpoch: expectedEpoch,
                maximumPayloadLength: OliphauntBrokerProtocol.maximumFramePayload
            )
        } catch {
            throw IOSBrokerDataPlaneFailure.protocolViolation(String(describing: error))
        }
        let payload = try await readExactly(Int(header.payloadLength))
        return try BrokerFrame(
            protocolVersion: header.protocolVersion,
            frameType: header.frameType,
            flags: header.flags,
            epoch: header.epoch,
            requestID: header.requestID,
            payload: payload
        )
    }

    private func readExactly(_ count: Int) async throws -> Data {
        guard count > 0 else {
            return Data()
        }
        return try await withCheckedThrowingContinuation { continuation in
            let state = IOReadState(expectedCount: count, continuation: continuation)
            channel.read(offset: 0, length: count, queue: queue) { done, data, error in
                state.consume(done: done, data: data, error: error)
            }
        }
    }

    private func decodeRejection(_ payload: Data) -> BrokerRejectionReason {
        if let decoded = try? JSONDecoder().decode(BrokerRejectionReason.self, from: payload) {
            return decoded
        }
        return .invalidRequest(
            String(data: payload, encoding: .utf8) ?? "worker rejected request"
        )
    }
}

/// Incrementally observes backend framing without retaining message bodies.
/// ReadyForQuery (`Z`) is protocol metadata, so transaction ownership can be
/// pinned without parsing or classifying SQL.
struct IOSBrokerBackendResponseObserver {
    private var header = Data()
    private var messageType: UInt8 = 0
    private var remainingBodyBytes: Int?
    private var bodyOffset = 0
    private var lastCompletedMessageType: UInt8?
    private(set) var lastReadyStatus: IOSBrokerBackendTransactionStatus?

    init() {
        header.reserveCapacity(5)
    }

    mutating func append(_ bytes: Data) throws {
        var offset = 0
        while offset < bytes.count {
            if remainingBodyBytes == nil {
                let count = min(5 - header.count, bytes.count - offset)
                header.append(bytes.subdata(in: offset..<(offset + count)))
                offset += count
                guard header.count == 5 else { continue }

                messageType = header[0]
                let length =
                    (UInt32(header[1]) << 24) | (UInt32(header[2]) << 16)
                    | (UInt32(header[3]) << 8) | UInt32(header[4])
                guard length >= 4 else {
                    throw IOSBrokerDataPlaneFailure.protocolViolation(
                        "backend message length is smaller than its header"
                    )
                }
                let bodyLength = Int(length - 4)
                if messageType == 0x5A, bodyLength != 1 {
                    throw IOSBrokerDataPlaneFailure.protocolViolation(
                        "ReadyForQuery has an invalid length"
                    )
                }
                header.removeAll(keepingCapacity: true)
                remainingBodyBytes = bodyLength
                bodyOffset = 0
                if bodyLength == 0 {
                    lastCompletedMessageType = messageType
                    remainingBodyBytes = nil
                }
                continue
            }

            guard let remaining = remainingBodyBytes else { continue }
            let count = min(remaining, bytes.count - offset)
            if messageType == 0x5A, bodyOffset == 0, count > 0 {
                guard let status = IOSBrokerBackendTransactionStatus(rawValue: bytes[offset]) else {
                    throw IOSBrokerDataPlaneFailure.protocolViolation(
                        "ReadyForQuery has an unknown transaction status"
                    )
                }
                lastReadyStatus = status
            }
            offset += count
            bodyOffset += count
            let nextRemaining = remaining - count
            if nextRemaining == 0 {
                lastCompletedMessageType = messageType
            }
            remainingBodyBytes = nextRemaining == 0 ? nil : nextRemaining
        }
    }

    func finish() throws -> IOSBrokerBackendTransactionStatus {
        guard header.isEmpty, remainingBodyBytes == nil else {
            throw IOSBrokerDataPlaneFailure.protocolViolation(
                "Completed arrived in the middle of a PostgreSQL backend message"
            )
        }
        guard lastCompletedMessageType == 0x5A, let lastReadyStatus else {
            throw IOSBrokerDataPlaneFailure.protocolViolation(
                "Completed arrived without a terminal ReadyForQuery"
            )
        }
        return lastReadyStatus
    }
}

private final class IOWriteState: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private let continuation: CheckedContinuation<Void, any Error>

    init(continuation: CheckedContinuation<Void, any Error>) {
        self.continuation = continuation
    }

    func consume(done: Bool, error: Int32) {
        guard done || error != 0 else {
            return
        }
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        finished = true
        lock.unlock()
        if error == 0 {
            continuation.resume()
        } else {
            continuation.resume(
                throwing: IOSBrokerTransportFailure.socketWrite(error)
            )
        }
    }
}

private final class IOReadState: @unchecked Sendable {
    private let lock = NSLock()
    private let expectedCount: Int
    private var bytes = Data()
    private var finished = false
    private let continuation: CheckedContinuation<Data, any Error>

    init(
        expectedCount: Int,
        continuation: CheckedContinuation<Data, any Error>
    ) {
        self.expectedCount = expectedCount
        self.continuation = continuation
        bytes.reserveCapacity(expectedCount)
    }

    func consume(done: Bool, data: DispatchData?, error: Int32) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        if let data, !data.isEmpty {
            bytes.append(contentsOf: data)
        }
        if bytes.count > expectedCount {
            finished = true
            lock.unlock()
            continuation.resume(
                throwing: BrokerError.protocolViolation("socket read exceeded requested length")
            )
            return
        }
        if error != 0 {
            finished = true
            lock.unlock()
            continuation.resume(
                throwing: IOSBrokerTransportFailure.socketRead(error)
            )
            return
        }
        if bytes.count == expectedCount {
            let result = bytes
            finished = true
            lock.unlock()
            continuation.resume(returning: result)
            return
        }
        if done {
            finished = true
            lock.unlock()
            continuation.resume(
                throwing: IOSBrokerTransportFailure.unexpectedEOF
            )
            return
        }
        lock.unlock()
    }
}
