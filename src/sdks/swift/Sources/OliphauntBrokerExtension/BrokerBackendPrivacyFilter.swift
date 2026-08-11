import Foundation

enum BrokerBackendPrivacyFilterError: Error, Equatable, LocalizedError, Sendable {
    case invalidConfiguration
    case malformedBackendMessage
    case incompleteBackendMessage
    case invalidState

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration:
            "invalid backend privacy filter configuration"
        case .malformedBackendMessage:
            "malformed backend protocol message"
        case .incompleteBackendMessage:
            "incomplete backend protocol message"
        case .invalidState:
            "backend privacy filter is no longer available"
        }
    }
}

/// Incrementally removes extension-private absolute paths from PostgreSQL
/// ErrorResponse and NoticeResponse messages. Other backend messages are
/// forwarded as their header and incoming body slices without response-wide
/// accumulation.
final class BrokerBackendPrivacyFilter: @unchecked Sendable {
    static let maximumBufferedMessageBytes = 64 * 1024

    private let lock = NSLock()
    private var parser: Parser

    init(sensitiveAbsolutePrefixes: [String]) throws {
        var variants = Set<String>()
        for path in sensitiveAbsolutePrefixes {
            guard path.hasPrefix("/"), !path.contains("\0"), path != "/" else {
                throw BrokerBackendPrivacyFilterError.invalidConfiguration
            }
            let url = URL(fileURLWithPath: path)
            let candidates = [
                path,
                url.standardizedFileURL.path,
                url.resolvingSymlinksInPath().standardizedFileURL.path,
            ]
            guard candidates.allSatisfy({ !$0.isEmpty && $0 != "/" }) else {
                throw BrokerBackendPrivacyFilterError.invalidConfiguration
            }
            variants.formUnion(candidates)
        }
        guard !variants.isEmpty else {
            throw BrokerBackendPrivacyFilterError.invalidConfiguration
        }
        let prefixes =
            variants
            .map { Array($0.utf8) }
            .sorted { lhs, rhs in
                lhs.count == rhs.count
                    ? lhs.lexicographicallyPrecedes(rhs)
                    : lhs.count > rhs.count
            }
        parser = Parser(sensitivePrefixes: prefixes)
    }

    func process(
        _ data: Data,
        emit: (Data) throws -> Void
    ) throws {
        lock.lock()
        defer { lock.unlock() }
        do {
            try parser.process(data, emit: emit)
        } catch {
            parser.invalidate()
            throw error
        }
    }

    func finish() throws {
        lock.lock()
        defer { lock.unlock() }
        do {
            try parser.finish()
        } catch {
            parser.invalidate()
            throw error
        }
    }
}

extension BrokerBackendPrivacyFilter {
    fileprivate struct Parser {
        private static let errorResponseTag: UInt8 = 0x45
        private static let noticeResponseTag: UInt8 = 0x4e
        private static let redaction = Array("[redacted]".utf8)

        private let sensitivePrefixes: [[UInt8]]
        private var header: [UInt8] = []
        private var currentTag: UInt8?
        private var remainingBodyBytes = 0
        private var bufferedMessage: [UInt8] = []
        private var buffersCurrentMessage = false
        private var currentMessageIsOversized = false
        private var failed = false
        private var finished = false

        init(sensitivePrefixes: [[UInt8]]) {
            self.sensitivePrefixes = sensitivePrefixes
            header.reserveCapacity(5)
            bufferedMessage.reserveCapacity(
                BrokerBackendPrivacyFilter.maximumBufferedMessageBytes
            )
        }

        mutating func process(
            _ data: Data,
            emit: (Data) throws -> Void
        ) throws {
            guard !failed, !finished else {
                throw BrokerBackendPrivacyFilterError.invalidState
            }

            try data.withUnsafeBytes { rawBuffer in
                let bytes = rawBuffer.bindMemory(to: UInt8.self)
                var offset = 0
                while offset < bytes.count {
                    if currentTag == nil {
                        let count = min(5 - header.count, bytes.count - offset)
                        header.append(contentsOf: bytes[offset..<(offset + count)])
                        offset += count
                        guard header.count == 5 else { continue }
                        try beginMessage(emit: emit)
                        if remainingBodyBytes == 0 {
                            try completeMessage(emit: emit)
                        }
                        continue
                    }

                    let count = min(remainingBodyBytes, bytes.count - offset)
                    if buffersCurrentMessage {
                        let available =
                            BrokerBackendPrivacyFilter.maximumBufferedMessageBytes
                            - bufferedMessage.count
                        let capturedCount = min(count, max(0, available))
                        if capturedCount > 0 {
                            bufferedMessage.append(
                                contentsOf: bytes[offset..<(offset + capturedCount)]
                            )
                        }
                    } else if count > 0 {
                        try emit(Data(bytes[offset..<(offset + count)]))
                    }
                    remainingBodyBytes -= count
                    offset += count
                    if remainingBodyBytes == 0 {
                        try completeMessage(emit: emit)
                    }
                }
            }
        }

        mutating func finish() throws {
            guard !failed, !finished else {
                throw BrokerBackendPrivacyFilterError.invalidState
            }
            guard header.isEmpty, currentTag == nil else {
                failed = true
                throw BrokerBackendPrivacyFilterError.incompleteBackendMessage
            }
            finished = true
        }

        mutating func invalidate() {
            failed = true
            header.removeAll(keepingCapacity: false)
            currentTag = nil
            remainingBodyBytes = 0
            bufferedMessage.removeAll(keepingCapacity: false)
            buffersCurrentMessage = false
            currentMessageIsOversized = false
        }

        private mutating func beginMessage(
            emit: (Data) throws -> Void
        ) throws {
            let length =
                (UInt32(header[1]) << 24)
                | (UInt32(header[2]) << 16)
                | (UInt32(header[3]) << 8)
                | UInt32(header[4])
            guard length >= 4,
                let bodyLength = Int(exactly: length - 4)
            else {
                throw BrokerBackendPrivacyFilterError.malformedBackendMessage
            }

            let tag = header[0]
            currentTag = tag
            remainingBodyBytes = bodyLength
            buffersCurrentMessage =
                tag == Self.errorResponseTag
                || tag == Self.noticeResponseTag
            currentMessageIsOversized =
                bodyLength
                > BrokerBackendPrivacyFilter.maximumBufferedMessageBytes - 5

            if buffersCurrentMessage {
                bufferedMessage.removeAll(keepingCapacity: true)
                bufferedMessage.append(contentsOf: header)
            } else {
                try emit(Data(header))
            }
            header.removeAll(keepingCapacity: true)
        }

        private mutating func completeMessage(
            emit: (Data) throws -> Void
        ) throws {
            guard let tag = currentTag else { return }
            defer { resetMessage() }
            guard buffersCurrentMessage else { return }

            let body = bufferedMessage.dropFirst(5)
            if currentMessageIsOversized {
                try emit(fixedReplacement(tag: tag, capturedBody: body))
                return
            }
            guard let filtered = filteredMessage(tag: tag, body: body) else {
                throw BrokerBackendPrivacyFilterError.malformedBackendMessage
            }
            try emit(filtered)
        }

        private mutating func resetMessage() {
            currentTag = nil
            remainingBodyBytes = 0
            bufferedMessage.removeAll(keepingCapacity: true)
            buffersCurrentMessage = false
            currentMessageIsOversized = false
        }

        private func filteredMessage(tag: UInt8, body: ArraySlice<UInt8>) -> Data? {
            var filteredBody: [UInt8] = []
            filteredBody.reserveCapacity(body.count)
            var offset = body.startIndex
            var sawTerminator = false

            while offset < body.endIndex {
                let fieldTag = body[offset]
                offset += 1
                if fieldTag == 0 {
                    guard offset == body.endIndex else { return nil }
                    filteredBody.append(0)
                    sawTerminator = true
                    break
                }
                guard let end = body[offset...].firstIndex(of: 0) else { return nil }
                let value = body[offset..<end]
                let shouldRedact = containsSensitivePrefix(value)
                let replacementCount = shouldRedact ? Self.redaction.count : value.count
                guard
                    filteredBody.count + replacementCount + 2
                        <= BrokerBackendPrivacyFilter.maximumBufferedMessageBytes - 5
                else {
                    return fixedReplacement(tag: tag, capturedBody: body)
                }
                filteredBody.append(fieldTag)
                if shouldRedact {
                    filteredBody.append(contentsOf: Self.redaction)
                } else {
                    filteredBody.append(contentsOf: value)
                }
                filteredBody.append(0)
                offset = end + 1
            }
            guard sawTerminator else { return nil }
            return makeMessage(tag: tag, body: filteredBody)
        }

        private func containsSensitivePrefix(_ value: ArraySlice<UInt8>) -> Bool {
            for prefix in sensitivePrefixes where prefix.count <= value.count {
                var index = value.startIndex
                let finalStart = value.endIndex - prefix.count
                while index <= finalStart {
                    if value[index..<(index + prefix.count)].elementsEqual(prefix) {
                        return true
                    }
                    index += 1
                }
            }
            return false
        }

        private func fixedReplacement(tag: UInt8, capturedBody: ArraySlice<UInt8>) -> Data {
            let severity = tag == Self.noticeResponseTag ? "NOTICE" : "ERROR"
            let message =
                tag == Self.noticeResponseTag
                ? "backend notice details redacted"
                : "backend error details redacted"
            var fields: [(UInt8, [UInt8])] = [
                (0x53, Array(severity.utf8)),
                (0x56, Array(severity.utf8)),
            ]
            if let sqlState = safelyCapturedSQLState(capturedBody) {
                fields.append((0x43, sqlState))
            }
            fields.append((0x4d, Array(message.utf8)))
            return makeMessage(tag: tag, fields: fields)
        }

        private func safelyCapturedSQLState(_ body: ArraySlice<UInt8>) -> [UInt8]? {
            var offset = body.startIndex
            while offset < body.endIndex {
                let fieldTag = body[offset]
                offset += 1
                if fieldTag == 0 { return nil }
                guard let end = body[offset...].firstIndex(of: 0) else { return nil }
                if fieldTag == 0x43 {
                    let value = Array(body[offset..<end])
                    guard value.count == 5,
                        value.allSatisfy({ byte in
                            (0x30...0x39).contains(byte) || (0x41...0x5a).contains(byte)
                        })
                    else {
                        return nil
                    }
                    return value
                }
                offset = end + 1
            }
            return nil
        }

        private func makeMessage(tag: UInt8, fields: [(UInt8, [UInt8])]) -> Data {
            var body: [UInt8] = []
            for (fieldTag, value) in fields {
                body.append(fieldTag)
                body.append(contentsOf: value)
                body.append(0)
            }
            body.append(0)
            return makeMessage(tag: tag, body: body)
        }

        private func makeMessage(tag: UInt8, body: [UInt8]) -> Data {
            let length = UInt32(body.count + 4)
            var message = Data([
                tag,
                UInt8(truncatingIfNeeded: length >> 24),
                UInt8(truncatingIfNeeded: length >> 16),
                UInt8(truncatingIfNeeded: length >> 8),
                UInt8(truncatingIfNeeded: length),
            ])
            message.append(contentsOf: body)
            return message
        }
    }
}
