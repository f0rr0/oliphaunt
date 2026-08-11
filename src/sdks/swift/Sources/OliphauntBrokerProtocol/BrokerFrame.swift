import Foundation

public enum BrokerFrameType: UInt8, Codable, CaseIterable, Sendable {
    case requestBegin = 1
    case requestBytes = 2
    case requestEnd = 3
    case responseBytes = 4
    case completed = 5
    case rejected = 6
    case outcomeUnknown = 7
    case cancelRequested = 8
    case cancelObserved = 9
    case ping = 10
    case pong = 11
    case protocolError = 12
    case channelClose = 13

    public var requiresRequestID: Bool {
        switch self {
        case .ping, .pong, .protocolError, .channelClose:
            false
        default:
            true
        }
    }
}

public struct BrokerFrameFlags: OptionSet, Hashable, Codable, Sendable {
    public let rawValue: UInt8

    public init(rawValue: UInt8) {
        self.rawValue = rawValue
    }

    public static let none: BrokerFrameFlags = []
    public static let knownMask: UInt8 = 0
}

public struct BrokerFrameHeader: Equatable, Sendable {
    public var protocolVersion: UInt16
    public var frameType: BrokerFrameType
    public var flags: BrokerFrameFlags
    public var epoch: BrokerEpoch
    public var requestID: UInt64
    public var payloadLength: UInt32

    public init(
        protocolVersion: UInt16 = OliphauntBrokerProtocol.maximumVersion,
        frameType: BrokerFrameType,
        flags: BrokerFrameFlags = .none,
        epoch: BrokerEpoch,
        requestID: UInt64,
        payloadLength: UInt32
    ) {
        self.protocolVersion = protocolVersion
        self.frameType = frameType
        self.flags = flags
        self.epoch = epoch
        self.requestID = requestID
        self.payloadLength = payloadLength
    }

    public func encoded() throws -> Data {
        try validate(maximumPayloadLength: OliphauntBrokerProtocol.maximumFramePayload)
        var result = Data(capacity: Int(OliphauntBrokerProtocol.headerLength))
        result.append(contentsOf: [
            OliphauntBrokerProtocol.magic.0,
            OliphauntBrokerProtocol.magic.1,
            OliphauntBrokerProtocol.magic.2,
            OliphauntBrokerProtocol.magic.3,
        ])
        result.appendNetwork(protocolVersion)
        result.appendNetwork(OliphauntBrokerProtocol.headerLength)
        result.append(frameType.rawValue)
        result.append(flags.rawValue)
        result.appendNetwork(UInt16(0))
        result.appendUUID(epoch.rawValue)
        result.appendNetwork(requestID)
        result.appendNetwork(payloadLength)
        precondition(result.count == Int(OliphauntBrokerProtocol.headerLength))
        return result
    }

    public static func decode(
        _ bytes: Data,
        expectedEpoch: BrokerEpoch? = nil,
        maximumPayloadLength: Int = OliphauntBrokerProtocol.maximumFramePayload
    ) throws -> BrokerFrameHeader {
        guard bytes.count >= Int(OliphauntBrokerProtocol.headerLength) else {
            throw BrokerProtocolError.truncatedFrame
        }
        guard bytes[0] == OliphauntBrokerProtocol.magic.0,
            bytes[1] == OliphauntBrokerProtocol.magic.1,
            bytes[2] == OliphauntBrokerProtocol.magic.2,
            bytes[3] == OliphauntBrokerProtocol.magic.3
        else {
            throw BrokerProtocolError.invalidMagic
        }
        let protocolVersion = try bytes.networkUInt16(at: 4)
        guard OliphauntBrokerProtocol.supports(version: protocolVersion) else {
            throw BrokerProtocolError.unsupportedVersion(protocolVersion)
        }
        let headerLength = try bytes.networkUInt16(at: 6)
        guard headerLength == OliphauntBrokerProtocol.headerLength else {
            throw BrokerProtocolError.invalidHeaderLength(headerLength)
        }
        guard let frameType = BrokerFrameType(rawValue: bytes[8]) else {
            throw BrokerProtocolError.unknownFrameType(bytes[8])
        }
        let flags = BrokerFrameFlags(rawValue: bytes[9])
        guard flags.rawValue & ~BrokerFrameFlags.knownMask == 0 else {
            throw BrokerProtocolError.invalidFlags(flags.rawValue)
        }
        let reserved = try bytes.networkUInt16(at: 10)
        guard reserved == 0 else {
            throw BrokerProtocolError.nonzeroReserved(reserved)
        }
        let epoch = BrokerEpoch(try bytes.uuid(at: 12))
        if let expectedEpoch, epoch != expectedEpoch {
            throw BrokerProtocolError.staleEpoch(expected: expectedEpoch, actual: epoch)
        }
        let requestID = try bytes.networkUInt64(at: 28)
        let payloadLength = try bytes.networkUInt32(at: 36)
        let header = BrokerFrameHeader(
            protocolVersion: protocolVersion,
            frameType: frameType,
            flags: flags,
            epoch: epoch,
            requestID: requestID,
            payloadLength: payloadLength
        )
        try header.validate(maximumPayloadLength: maximumPayloadLength)
        return header
    }

    public func validate(maximumPayloadLength: Int) throws {
        guard OliphauntBrokerProtocol.supports(version: protocolVersion) else {
            throw BrokerProtocolError.unsupportedVersion(protocolVersion)
        }
        guard flags.rawValue & ~BrokerFrameFlags.knownMask == 0 else {
            throw BrokerProtocolError.invalidFlags(flags.rawValue)
        }
        if frameType.requiresRequestID {
            guard requestID != 0 else {
                throw BrokerProtocolError.invalidRequestIDForFrame(
                    frameType: frameType,
                    requestID: requestID
                )
            }
        } else if requestID != 0 {
            throw BrokerProtocolError.invalidRequestIDForFrame(
                frameType: frameType,
                requestID: requestID
            )
        }
        guard maximumPayloadLength >= 0 else {
            throw BrokerProtocolError.payloadTooLarge(
                actual: UInt64(payloadLength),
                maximum: maximumPayloadLength
            )
        }
        guard UInt64(payloadLength) <= UInt64(maximumPayloadLength) else {
            throw BrokerProtocolError.payloadTooLarge(
                actual: UInt64(payloadLength),
                maximum: maximumPayloadLength
            )
        }
    }
}

public struct BrokerFrame: Equatable, Sendable {
    public var header: BrokerFrameHeader
    public var payload: Data

    public init(
        protocolVersion: UInt16 = OliphauntBrokerProtocol.maximumVersion,
        frameType: BrokerFrameType,
        flags: BrokerFrameFlags = .none,
        epoch: BrokerEpoch,
        requestID: UInt64,
        payload: Data = Data()
    ) throws {
        guard payload.count <= Int(UInt32.max) else {
            throw BrokerProtocolError.payloadTooLarge(
                actual: UInt64(payload.count),
                maximum: Int(UInt32.max)
            )
        }
        header = BrokerFrameHeader(
            protocolVersion: protocolVersion,
            frameType: frameType,
            flags: flags,
            epoch: epoch,
            requestID: requestID,
            payloadLength: UInt32(payload.count)
        )
        self.payload = payload
        try header.validate(maximumPayloadLength: OliphauntBrokerProtocol.maximumFramePayload)
    }

    init(header: BrokerFrameHeader, payload: Data) {
        self.header = header
        self.payload = payload
    }

    public func encoded() throws -> Data {
        guard payload.count == Int(header.payloadLength) else {
            throw BrokerProtocolError.protocolLengthMismatchForFrame(
                declared: header.payloadLength,
                actual: payload.count
            )
        }
        var result = try header.encoded()
        result.append(payload)
        return result
    }
}

public struct BrokerFrameDecoder: Sendable {
    private var buffer = Data()
    private var readOffset = 0
    public var expectedEpoch: BrokerEpoch?
    public var maximumPayloadLength: Int
    public var maximumBufferedBytes: Int

    public init(
        expectedEpoch: BrokerEpoch? = nil,
        maximumPayloadLength: Int = OliphauntBrokerProtocol.maximumFramePayload,
        maximumBufferedBytes: Int = OliphauntBrokerProtocol.maximumQueuedBytesPerDirection
    ) {
        self.expectedEpoch = expectedEpoch
        self.maximumPayloadLength = maximumPayloadLength
        self.maximumBufferedBytes = maximumBufferedBytes
    }

    public mutating func append(_ bytes: Data) throws -> [BrokerFrame] {
        if !bytes.isEmpty {
            let unread = buffer.count - readOffset
            let (combined, overflow) = unread.addingReportingOverflow(bytes.count)
            guard !overflow else {
                throw BrokerProtocolError.arithmeticOverflow
            }
            // A stream read may finish one maximum-sized frame and include the
            // beginning of subsequent frames. Bound aggregate buffered bytes,
            // but let the header parser enforce the per-frame payload limit.
            guard combined <= maximumBufferedBytes else {
                throw BrokerProtocolError.payloadTooLarge(
                    actual: UInt64(combined),
                    maximum: maximumBufferedBytes
                )
            }
            compactIfNeeded(force: readOffset > 0)
            buffer.append(bytes)
        }

        var frames: [BrokerFrame] = []
        while buffer.count - readOffset >= Int(OliphauntBrokerProtocol.headerLength) {
            let headerEnd = readOffset + Int(OliphauntBrokerProtocol.headerLength)
            let headerData = buffer.subdata(in: readOffset..<headerEnd)
            let header = try BrokerFrameHeader.decode(
                headerData,
                expectedEpoch: expectedEpoch,
                maximumPayloadLength: maximumPayloadLength
            )
            let (frameLength, overflow) = Int(OliphauntBrokerProtocol.headerLength)
                .addingReportingOverflow(Int(header.payloadLength))
            guard !overflow else {
                throw BrokerProtocolError.arithmeticOverflow
            }
            guard buffer.count - readOffset >= frameLength else {
                break
            }
            let payloadStart = headerEnd
            let payloadEnd = readOffset + frameLength
            frames.append(
                BrokerFrame(
                    header: header,
                    payload: buffer.subdata(in: payloadStart..<payloadEnd)
                ))
            readOffset = payloadEnd
        }
        compactIfNeeded(force: readOffset == buffer.count)
        return frames
    }

    public mutating func finish() throws -> [BrokerFrame] {
        let frames = try append(Data())
        guard buffer.count == readOffset else {
            throw BrokerProtocolError.truncatedFrame
        }
        return frames
    }

    public mutating func reset(expectedEpoch: BrokerEpoch?) {
        buffer.removeAll(keepingCapacity: true)
        readOffset = 0
        self.expectedEpoch = expectedEpoch
    }

    private mutating func compactIfNeeded(force: Bool) {
        guard readOffset > 0, force || readOffset >= 64 * 1024 else {
            return
        }
        if readOffset == buffer.count {
            buffer.removeAll(keepingCapacity: true)
        } else {
            buffer.removeSubrange(0..<readOffset)
        }
        readOffset = 0
    }
}

extension BrokerProtocolError {
    fileprivate static func protocolLengthMismatchForFrame(
        declared: UInt32, actual: Int
    ) -> BrokerProtocolError {
        .illegalFrame(
            frameType: .protocolError,
            state: "payload length declared \(declared), actual \(actual)"
        )
    }
}

extension Data {
    fileprivate mutating func appendNetwork(_ value: UInt16) {
        append(UInt8((value >> 8) & 0xff))
        append(UInt8(value & 0xff))
    }

    fileprivate mutating func appendNetwork(_ value: UInt32) {
        append(UInt8((value >> 24) & 0xff))
        append(UInt8((value >> 16) & 0xff))
        append(UInt8((value >> 8) & 0xff))
        append(UInt8(value & 0xff))
    }

    fileprivate mutating func appendNetwork(_ value: UInt64) {
        for shift in stride(from: 56, through: 0, by: -8) {
            append(UInt8((value >> UInt64(shift)) & 0xff))
        }
    }

    fileprivate mutating func appendUUID(_ value: UUID) {
        var uuid = value.uuid
        Swift.withUnsafeBytes(of: &uuid) { append(contentsOf: $0) }
    }

    fileprivate func networkUInt16(at offset: Int) throws -> UInt16 {
        guard offset >= 0, count - offset >= 2 else {
            throw BrokerProtocolError.truncatedFrame
        }
        return (UInt16(self[offset]) << 8) | UInt16(self[offset + 1])
    }

    fileprivate func networkUInt32(at offset: Int) throws -> UInt32 {
        guard offset >= 0, count - offset >= 4 else {
            throw BrokerProtocolError.truncatedFrame
        }
        return (UInt32(self[offset]) << 24) | (UInt32(self[offset + 1]) << 16)
            | (UInt32(self[offset + 2]) << 8) | UInt32(self[offset + 3])
    }

    fileprivate func networkUInt64(at offset: Int) throws -> UInt64 {
        guard offset >= 0, count - offset >= 8 else {
            throw BrokerProtocolError.truncatedFrame
        }
        var result: UInt64 = 0
        for index in offset..<(offset + 8) {
            result = (result << 8) | UInt64(self[index])
        }
        return result
    }

    fileprivate func uuid(at offset: Int) throws -> UUID {
        guard offset >= 0, count - offset >= 16 else {
            throw BrokerProtocolError.truncatedFrame
        }
        let values = Array(self[offset..<(offset + 16)])
        return UUID(
            uuid: (
                values[0], values[1], values[2], values[3],
                values[4], values[5], values[6], values[7],
                values[8], values[9], values[10], values[11],
                values[12], values[13], values[14], values[15]
            ))
    }
}
