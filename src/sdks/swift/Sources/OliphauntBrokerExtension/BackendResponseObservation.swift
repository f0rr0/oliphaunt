import Foundation
import OliphauntBrokerProtocol

enum BrokerBackendTransactionStatus: UInt8, Equatable, Sendable {
    case idle = 0x49
    case transaction = 0x54
    case failedTransaction = 0x45
}

struct BrokerBackendResponseSnapshot: Equatable, Sendable {
    var sawReadyForQuery: Bool
    var transactionStatus: BrokerBackendTransactionStatus?
    var sawQueryCanceled: Bool
}

/// Incrementally observes just enough backend protocol to close cancellation
/// races and track transaction ownership. Large row values are skipped rather
/// than accumulated.
private struct BrokerBackendResponseParser {
    private static let maximumCapturedErrorBytes = 64 * 1024

    private var header: [UInt8] = []
    private var currentTag: UInt8?
    private var remainingBodyBytes = 0
    private var capturedBody: [UInt8] = []
    private var captureOverflowed = false
    private(set) var snapshot = BrokerBackendResponseSnapshot(
        sawReadyForQuery: false,
        transactionStatus: nil,
        sawQueryCanceled: false
    )

    mutating func append(_ data: Data) throws {
        try data.withUnsafeBytes { rawBuffer in
            let bytes = rawBuffer.bindMemory(to: UInt8.self)
            var offset = 0
            while offset < bytes.count {
                if currentTag == nil {
                    let needed = 5 - header.count
                    let count = min(needed, bytes.count - offset)
                    header.append(contentsOf: bytes[offset..<(offset + count)])
                    offset += count
                    guard header.count == 5 else { continue }

                    let length =
                        (UInt32(header[1]) << 24) | (UInt32(header[2]) << 16)
                        | (UInt32(header[3]) << 8) | UInt32(header[4])
                    guard length >= 4 else {
                        throw BrokerError.protocolViolation(
                            "backend message length is smaller than its header"
                        )
                    }
                    guard let bodyLength = Int(exactly: length - 4) else {
                        throw BrokerError.protocolViolation(
                            "backend message length does not fit this process"
                        )
                    }
                    currentTag = header[0]
                    remainingBodyBytes = bodyLength
                    capturedBody.removeAll(keepingCapacity: true)
                    captureOverflowed = false
                    header.removeAll(keepingCapacity: true)
                    if bodyLength == 0 {
                        try finishMessage()
                    }
                    continue
                }

                let count = min(remainingBodyBytes, bytes.count - offset)
                if shouldCaptureCurrentMessage, !captureOverflowed {
                    let available = Self.maximumCapturedErrorBytes - capturedBody.count
                    if count <= available {
                        capturedBody.append(contentsOf: bytes[offset..<(offset + count)])
                    } else {
                        if available > 0 {
                            capturedBody.append(contentsOf: bytes[offset..<(offset + available)])
                        }
                        captureOverflowed = true
                    }
                }
                remainingBodyBytes -= count
                offset += count
                if remainingBodyBytes == 0 {
                    try finishMessage()
                }
            }
        }
    }

    private var shouldCaptureCurrentMessage: Bool {
        currentTag == 0x45 || currentTag == 0x5a
    }

    private mutating func finishMessage() throws {
        guard let tag = currentTag else { return }
        defer {
            currentTag = nil
            remainingBodyBytes = 0
            capturedBody.removeAll(keepingCapacity: true)
            captureOverflowed = false
        }

        switch tag {
        case 0x45 where !captureOverflowed:
            if errorSQLState(capturedBody) == "57014" {
                snapshot.sawQueryCanceled = true
            }
        case 0x5a:
            guard !captureOverflowed, capturedBody.count == 1,
                let status = BrokerBackendTransactionStatus(rawValue: capturedBody[0])
            else {
                throw BrokerError.protocolViolation("invalid ReadyForQuery message")
            }
            snapshot.sawReadyForQuery = true
            snapshot.transactionStatus = status
        default:
            break
        }
    }

    private func errorSQLState(_ bytes: [UInt8]) -> String? {
        var offset = 0
        while offset < bytes.count {
            let field = bytes[offset]
            offset += 1
            if field == 0 { return nil }
            guard let end = bytes[offset...].firstIndex(of: 0) else { return nil }
            if field == 0x43 {
                return String(bytes: bytes[offset..<end], encoding: .utf8)
            }
            offset = end + 1
        }
        return nil
    }
}

final class BrokerBackendResponseObserver: @unchecked Sendable {
    private let lock = NSLock()
    private var parser = BrokerBackendResponseParser()
    private let epoch: BrokerEpoch
    private let requestID: BrokerRequestID
    private let cancellationController: CancellationController

    init(
        epoch: BrokerEpoch,
        requestID: BrokerRequestID,
        cancellationController: CancellationController
    ) {
        self.epoch = epoch
        self.requestID = requestID
        self.cancellationController = cancellationController
    }

    func observe(_ data: Data) throws {
        let (becameReady, becameCanceled): (Bool, Bool) = try lock.withResponseLock {
            let previous = parser.snapshot
            try parser.append(data)
            let current = parser.snapshot
            return (
                !previous.sawReadyForQuery && current.sawReadyForQuery,
                !previous.sawQueryCanceled && current.sawQueryCanceled
            )
        }
        if becameCanceled {
            cancellationController.markCancellationObserved(
                epoch: epoch,
                requestID: requestID
            )
        }
        if becameReady {
            cancellationController.markNativeTransportComplete(
                epoch: epoch,
                requestID: requestID
            )
        }
    }

    func snapshot() -> BrokerBackendResponseSnapshot {
        lock.withResponseLock { parser.snapshot }
    }
}

extension NSLock {
    fileprivate func withResponseLock<Result>(_ body: () throws -> Result) rethrows -> Result {
        lock()
        defer { unlock() }
        return try body()
    }
}
