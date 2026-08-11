import Foundation
import OliphauntBrokerProtocol
import Testing

@Test
func frameHeaderHasStableFortyByteNetworkOrderEncoding() throws {
    let payload = Data([0xaa, 0xbb, 0xcc])
    let frame = try BrokerFrame(
        frameType: .requestBytes,
        epoch: brokerTestEpoch,
        requestID: 0x0102_0304_0506_0708,
        payload: payload
    )

    let expectedHeader = Data([
        0x4f, 0x4c, 0x50, 0x42,
        0x00, 0x01,
        0x00, 0x28,
        0x02,
        0x00,
        0x00, 0x00,
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
        0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x00, 0x00, 0x00, 0x03,
    ])

    let encoded = try frame.encoded()
    #expect(OliphauntBrokerProtocol.headerLength == 40)
    #expect(encoded.count == 43)
    #expect(Data(encoded.prefix(40)) == expectedHeader)
    #expect(Data(encoded.suffix(3)) == payload)

    let decoded = try BrokerFrameHeader.decode(expectedHeader, expectedEpoch: brokerTestEpoch)
    #expect(decoded == frame.header)
}

@Test
func everyFrameTypeRoundTripsAndEnforcesItsRequestIDDomain() throws {
    for frameType in BrokerFrameType.allCases {
        let validRequestID: UInt64 = frameType.requiresRequestID ? 91 : 0
        let frame = try BrokerFrame(
            frameType: frameType,
            epoch: brokerTestEpoch,
            requestID: validRequestID,
            payload: Data([frameType.rawValue])
        )
        var decoder = BrokerFrameDecoder(expectedEpoch: brokerTestEpoch)
        #expect(try decoder.append(frame.encoded()) == [frame])
        #expect(try decoder.finish().isEmpty)

        let invalidRequestID: UInt64 = frameType.requiresRequestID ? 0 : 91
        expectProtocolError(
            .invalidRequestIDForFrame(frameType: frameType, requestID: invalidRequestID)
        ) {
            try BrokerFrame(
                frameType: frameType,
                epoch: brokerTestEpoch,
                requestID: invalidRequestID
            )
        }
    }
}

@Test
func decoderAcceptsEveryFragmentBoundary() throws {
    let frame = try BrokerFrame(
        frameType: .responseBytes,
        epoch: brokerTestEpoch,
        requestID: 7,
        payload: Data((0..<73).map(UInt8.init))
    )
    let encoded = try frame.encoded()

    for split in 0...encoded.count {
        var decoder = BrokerFrameDecoder(expectedEpoch: brokerTestEpoch)
        var decoded: [BrokerFrame] = []
        decoded += try decoder.append(Data(encoded[..<split]))
        decoded += try decoder.append(Data(encoded[split...]))
        decoded += try decoder.finish()
        #expect(decoded == [frame])
    }

    var byteAtATimeDecoder = BrokerFrameDecoder(expectedEpoch: brokerTestEpoch)
    var byteAtATimeFrames: [BrokerFrame] = []
    for byte in encoded {
        byteAtATimeFrames += try byteAtATimeDecoder.append(Data([byte]))
    }
    byteAtATimeFrames += try byteAtATimeDecoder.finish()
    #expect(byteAtATimeFrames == [frame])
}

@Test
func decoderAcceptsCoalescedFramesAndZeroLengthPayloads() throws {
    let frames = [
        try BrokerFrame(
            frameType: .requestBegin,
            epoch: brokerTestEpoch,
            requestID: 1
        ),
        try BrokerFrame(
            frameType: .requestBytes,
            epoch: brokerTestEpoch,
            requestID: 1,
            payload: Data([1, 2, 3, 4])
        ),
        try BrokerFrame(
            frameType: .requestEnd,
            epoch: brokerTestEpoch,
            requestID: 1
        ),
        try BrokerFrame(
            frameType: .ping,
            epoch: brokerTestEpoch,
            requestID: 0
        ),
    ]
    let encoded = try frames.reduce(into: Data()) { bytes, frame in
        bytes.append(try frame.encoded())
    }

    var decoder = BrokerFrameDecoder(expectedEpoch: brokerTestEpoch)
    #expect(try decoder.append(encoded) == frames)
    #expect(try decoder.finish().isEmpty)
}

@Test
func decoderAcceptsMaximumFrameFollowedBySecondFrameBytesWithinAggregateBound() throws {
    let maximumPayload = OliphauntBrokerProtocol.maximumFramePayload
    let firstFrame = try BrokerFrame(
        frameType: .responseBytes,
        epoch: brokerTestEpoch,
        requestID: 101,
        payload: Data(repeating: 0xa5, count: maximumPayload)
    )
    let secondFrame = try BrokerFrame(
        frameType: .responseBytes,
        epoch: brokerTestEpoch,
        requestID: 102,
        payload: Data(repeating: 0x5a, count: maximumPayload)
    )
    let firstEncoded = try firstFrame.encoded()
    let secondEncoded = try secondFrame.encoded()
    let secondFramePrefixCount = Int(OliphauntBrokerProtocol.headerLength) + 17

    var firstStreamRead = firstEncoded
    firstStreamRead.append(secondEncoded.prefix(secondFramePrefixCount))
    #expect(firstStreamRead.count < OliphauntBrokerProtocol.maximumQueuedBytesPerDirection)

    var decoder = BrokerFrameDecoder(expectedEpoch: brokerTestEpoch)
    #expect(try decoder.append(firstStreamRead) == [firstFrame])
    #expect(
        try decoder.append(Data(secondEncoded.dropFirst(secondFramePrefixCount))) == [secondFrame]
    )
    #expect(try decoder.finish().isEmpty)

    var fullyCoalescedDecoder = BrokerFrameDecoder(expectedEpoch: brokerTestEpoch)
    var bothFrames = firstEncoded
    bothFrames.append(secondEncoded)
    #expect(try fullyCoalescedDecoder.append(bothFrames) == [firstFrame, secondFrame])

    var validStreamOverAggregateBound = Data()
    while validStreamOverAggregateBound.count
        <= OliphauntBrokerProtocol.maximumQueuedBytesPerDirection
    {
        validStreamOverAggregateBound.append(firstEncoded)
    }
    var aggregateBoundedDecoder = BrokerFrameDecoder(expectedEpoch: brokerTestEpoch)
    expectProtocolError(
        .payloadTooLarge(
            actual: UInt64(validStreamOverAggregateBound.count),
            maximum: OliphauntBrokerProtocol.maximumQueuedBytesPerDirection
        )
    ) {
        try aggregateBoundedDecoder.append(validStreamOverAggregateBound)
    }
}

@Test
func headerValidationRejectsMalformedInputBeforeWaitingForPayload() throws {
    let baseFrame = try BrokerFrame(
        frameType: .requestBytes,
        epoch: brokerTestEpoch,
        requestID: 0x0102_0304_0506_0708
    )
    let validHeader = try baseFrame.header.encoded()

    struct InvalidHeaderCase {
        var bytes: Data
        var expected: BrokerProtocolError
    }

    var invalidMagic = validHeader
    invalidMagic[0] = 0

    var unsupportedVersion = validHeader
    writeNetworkUInt16(2, to: &unsupportedVersion, at: 4)

    var invalidHeaderLength = validHeader
    writeNetworkUInt16(39, to: &invalidHeaderLength, at: 6)

    var unknownFrameType = validHeader
    unknownFrameType[8] = 0xff

    var invalidFlags = validHeader
    invalidFlags[9] = 0x01

    var nonzeroReserved = validHeader
    writeNetworkUInt16(7, to: &nonzeroReserved, at: 10)

    var missingRequestID = validHeader
    writeNetworkUInt64(0, to: &missingRequestID, at: 28)

    var unexpectedRequestID = validHeader
    unexpectedRequestID[8] = BrokerFrameType.ping.rawValue

    var oversizedPayload = validHeader
    writeNetworkUInt32(
        UInt32(OliphauntBrokerProtocol.maximumFramePayload + 1),
        to: &oversizedPayload,
        at: 36
    )

    let cases = [
        InvalidHeaderCase(bytes: invalidMagic, expected: .invalidMagic),
        InvalidHeaderCase(bytes: unsupportedVersion, expected: .unsupportedVersion(2)),
        InvalidHeaderCase(bytes: invalidHeaderLength, expected: .invalidHeaderLength(39)),
        InvalidHeaderCase(bytes: unknownFrameType, expected: .unknownFrameType(0xff)),
        InvalidHeaderCase(bytes: invalidFlags, expected: .invalidFlags(0x01)),
        InvalidHeaderCase(bytes: nonzeroReserved, expected: .nonzeroReserved(7)),
        InvalidHeaderCase(
            bytes: missingRequestID,
            expected: .invalidRequestIDForFrame(frameType: .requestBytes, requestID: 0)
        ),
        InvalidHeaderCase(
            bytes: unexpectedRequestID,
            expected: .invalidRequestIDForFrame(
                frameType: .ping,
                requestID: 0x0102_0304_0506_0708
            )
        ),
        InvalidHeaderCase(
            bytes: oversizedPayload,
            expected: .payloadTooLarge(
                actual: UInt64(OliphauntBrokerProtocol.maximumFramePayload + 1),
                maximum: OliphauntBrokerProtocol.maximumFramePayload
            )
        ),
    ]

    for invalidCase in cases {
        var decoder = BrokerFrameDecoder(expectedEpoch: brokerTestEpoch)
        expectProtocolError(invalidCase.expected) {
            // Only the fixed-size header is supplied. Each validation failure must
            // surface before the decoder waits for or allocates the declared body.
            try decoder.append(invalidCase.bytes)
        }
    }
}

@Test
func staleEpochIsRejectedAndResetNeverAcceptsOldFrames() throws {
    let oldFrame = try BrokerFrame(
        frameType: .completed,
        epoch: brokerTestEpoch,
        requestID: 44
    )
    let newFrame = try BrokerFrame(
        frameType: .completed,
        epoch: otherBrokerTestEpoch,
        requestID: 44
    )

    var decoder = BrokerFrameDecoder(expectedEpoch: otherBrokerTestEpoch)
    expectProtocolError(
        .staleEpoch(expected: otherBrokerTestEpoch, actual: brokerTestEpoch)
    ) {
        try decoder.append(oldFrame.encoded())
    }

    decoder.reset(expectedEpoch: brokerTestEpoch)
    #expect(try decoder.append(oldFrame.encoded()) == [oldFrame])
    decoder.reset(expectedEpoch: otherBrokerTestEpoch)
    #expect(try decoder.append(newFrame.encoded()) == [newFrame])
}

@Test
func decoderAndFramePayloadLimitsAreExactAndBounded() throws {
    let maximum = OliphauntBrokerProtocol.maximumFramePayload
    let boundaryPayload = Data(repeating: 0xa5, count: maximum)
    let boundaryFrame = try BrokerFrame(
        frameType: .responseBytes,
        epoch: brokerTestEpoch,
        requestID: 1,
        payload: boundaryPayload
    )
    var decoder = BrokerFrameDecoder(expectedEpoch: brokerTestEpoch)
    #expect(try decoder.append(boundaryFrame.encoded()) == [boundaryFrame])

    expectProtocolError(
        .payloadTooLarge(actual: UInt64(maximum + 1), maximum: maximum)
    ) {
        try BrokerFrame(
            frameType: .responseBytes,
            epoch: brokerTestEpoch,
            requestID: 1,
            payload: Data(repeating: 0, count: maximum + 1)
        )
    }

    let maximumBuffered = Int(OliphauntBrokerProtocol.headerLength) + 8
    var boundedDecoder = BrokerFrameDecoder(
        expectedEpoch: brokerTestEpoch,
        maximumPayloadLength: 8,
        maximumBufferedBytes: maximumBuffered
    )
    expectProtocolError(
        .payloadTooLarge(actual: UInt64(maximumBuffered + 1), maximum: maximumBuffered)
    ) {
        try boundedDecoder.append(Data(repeating: 0, count: maximumBuffered + 1))
    }

    #expect(OliphauntBrokerProtocol.maximumFramePayload == 256 * 1024)
    #expect(OliphauntBrokerProtocol.maximumQueuedBytesPerDirection == 8 * 1024 * 1024)
}

@Test
func negativePayloadLimitsFailClosedWithProtocolErrors() throws {
    let frame = try BrokerFrame(
        frameType: .responseBytes,
        epoch: brokerTestEpoch,
        requestID: 1,
        payload: Data([0xa5])
    )
    let expected = BrokerProtocolError.payloadTooLarge(actual: 1, maximum: -1)

    expectProtocolError(expected) {
        try frame.header.validate(maximumPayloadLength: -1)
    }
    expectProtocolError(expected) {
        try BrokerFrameHeader.decode(
            frame.header.encoded(),
            expectedEpoch: brokerTestEpoch,
            maximumPayloadLength: -1
        )
    }

    var decoder = BrokerFrameDecoder(
        expectedEpoch: brokerTestEpoch,
        maximumPayloadLength: -1
    )
    expectProtocolError(expected) {
        try decoder.append(frame.encoded())
    }
}

@Test
func decoderReportsTruncationAndFrameLengthMismatch() throws {
    let frame = try BrokerFrame(
        frameType: .requestBytes,
        epoch: brokerTestEpoch,
        requestID: 5,
        payload: Data([1, 2, 3])
    )
    let encoded = try frame.encoded()
    for retainedByteCount in [1, 39, 40, 42] {
        var decoder = BrokerFrameDecoder(expectedEpoch: brokerTestEpoch)
        #expect(try decoder.append(Data(encoded.prefix(retainedByteCount))).isEmpty)
        expectProtocolError(.truncatedFrame) {
            try decoder.finish()
        }
    }

    var mismatchedFrame = frame
    mismatchedFrame.header.payloadLength = 2
    expectProtocolError(
        .illegalFrame(
            frameType: .protocolError,
            state: "payload length declared 2, actual 3"
        )
    ) {
        try mismatchedFrame.encoded()
    }
}
