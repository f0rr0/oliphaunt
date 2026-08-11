import Foundation
import OliphauntBrokerProtocol
import Testing

@Test
func frontendRequestAssemblerAcceptsFragmentedAndCoalescedMessages() throws {
    let query = postgresFrontendMessage(
        type: Character("Q").asciiValue!,
        body: Array("SELECT 1\0".utf8)
    )
    let sync = postgresFrontendMessage(type: Character("S").asciiValue!, body: [])
    let request = query + sync

    for split in 0...request.count {
        var assembler = BrokerFrontendRequestAssembler(maximumRequestBytes: request.count)
        try assembler.append(Data(request[..<split]))
        try assembler.append(Data(request[split...]))
        #expect(assembler.byteCount == request.count)
        #expect(try assembler.finish() == request)
    }

    var byteAtATimeAssembler = BrokerFrontendRequestAssembler(maximumRequestBytes: request.count)
    for byte in request {
        try byteAtATimeAssembler.append(Data([byte]))
    }
    #expect(try byteAtATimeAssembler.finish() == request)
}

@Test
func frontendRequestAssemblerRejectsMalformedOrOversizedInputEarly() throws {
    var empty = BrokerFrontendRequestAssembler()
    expectProtocolError(.malformedFrontendProtocol("empty request")) {
        try empty.finish()
    }

    for truncatedHeaderLength in 1...4 {
        var truncated = BrokerFrontendRequestAssembler()
        try truncated.append(Data(repeating: 0x51, count: truncatedHeaderLength))
        expectProtocolError(.malformedFrontendProtocol("truncated message header")) {
            try truncated.finish()
        }
    }

    var tooShortLength = BrokerFrontendRequestAssembler()
    expectProtocolError(
        .malformedFrontendProtocol("message length is smaller than protocol header")
    ) {
        try tooShortLength.append(Data([0x51, 0, 0, 0, 3]))
    }

    var truncatedBody = BrokerFrontendRequestAssembler()
    try truncatedBody.append(Data([0x51, 0, 0, 0, 8, 0xaa]))
    expectProtocolError(.malformedFrontendProtocol("truncated message body")) {
        try truncatedBody.finish()
    }

    var declaredOversized = BrokerFrontendRequestAssembler(maximumRequestBytes: 16)
    expectProtocolError(.payloadTooLarge(actual: 17, maximum: 16)) {
        // The five-byte PostgreSQL header is sufficient to reject the declared
        // message size; its body is intentionally absent.
        try declaredOversized.append(Data([0x51, 0, 0, 0, 16]))
    }

    var aggregateOversized = BrokerFrontendRequestAssembler(maximumRequestBytes: 8)
    expectProtocolError(.payloadTooLarge(actual: 9, maximum: 8)) {
        try aggregateOversized.append(Data(repeating: 0, count: 9))
    }
}

@Test
func frontendRequestAssemblerHonorsExactLimitAndReset() throws {
    let exactMessage = postgresFrontendMessage(
        type: Character("Q").asciiValue!,
        body: Array(repeating: 0xa5, count: 11)
    )
    #expect(exactMessage.count == 16)

    var assembler = BrokerFrontendRequestAssembler(maximumRequestBytes: 16)
    try assembler.append(exactMessage)
    #expect(try assembler.finish() == exactMessage)

    assembler.reset()
    #expect(assembler.byteCount == 0)
    let secondMessage = postgresFrontendMessage(type: Character("S").asciiValue!, body: [])
    try assembler.append(secondMessage)
    #expect(try assembler.finish() == secondMessage)
}

@Test
func requestLifecycleFollowsReceiveDispatchAndCompletionStates() throws {
    let requestID = try BrokerRequestID(validating: 17)
    var lifecycle = BrokerRequestLifecycle(epoch: brokerTestEpoch, requestID: requestID)

    #expect(lifecycle.state == .queued)
    #expect(lifecycle.lossResult() == .notStarted)
    try lifecycle.beginReceiving()
    #expect(lifecycle.state == .receiving)
    try lifecycle.finishReceiving()
    #expect(lifecycle.state == .readyToDispatch)
    try lifecycle.beginNativeDispatch()
    #expect(lifecycle.state == .running)
    #expect(lifecycle.nativeDispatchStarted)
    #expect(lifecycle.lossResult() == .outcomeUnknown)
    let establishedCompletion = lifecycle.establishTerminal(.completed)
    #expect(establishedCompletion)
    #expect(lifecycle.state == .terminal(.completed))
    let establishedSecondTerminal = lifecycle.establishTerminal(.outcomeUnknown)
    #expect(!establishedSecondTerminal)
    let canceledTerminal = lifecycle.requestCancellation()
    #expect(!canceledTerminal)
}

@Test
func illegalRequestTransitionsAreRejectedWithoutChangingState() throws {
    let requestID = try BrokerRequestID(validating: 18)
    var lifecycle = BrokerRequestLifecycle(epoch: brokerTestEpoch, requestID: requestID)

    expectProtocolError(.illegalFrame(frameType: .requestEnd, state: "queued")) {
        try lifecycle.finishReceiving()
    }
    #expect(lifecycle.state == .queued)

    expectProtocolError(.illegalFrame(frameType: .requestEnd, state: "queued")) {
        try lifecycle.beginNativeDispatch()
    }
    #expect(lifecycle.state == .queued)

    try lifecycle.beginReceiving()
    expectProtocolError(.illegalFrame(frameType: .requestBegin, state: "receiving")) {
        try lifecycle.beginReceiving()
    }
    #expect(lifecycle.state == .receiving)

    try lifecycle.finishReceiving()
    expectProtocolError(.illegalFrame(frameType: .requestEnd, state: "readyToDispatch")) {
        try lifecycle.finishReceiving()
    }
    #expect(lifecycle.state == .readyToDispatch)
}

@Test
func cancellationBeforeDispatchIsKnownAndIdempotent() throws {
    let statesBeforeCancellation: [BrokerRequestState] = [
        .queued,
        .receiving,
        .readyToDispatch,
    ]

    for (index, desiredState) in statesBeforeCancellation.enumerated() {
        let requestID = try BrokerRequestID(validating: UInt64(index + 1))
        var lifecycle = BrokerRequestLifecycle(epoch: brokerTestEpoch, requestID: requestID)
        if desiredState == .receiving || desiredState == .readyToDispatch {
            try lifecycle.beginReceiving()
        }
        if desiredState == .readyToDispatch {
            try lifecycle.finishReceiving()
        }

        #expect(lifecycle.state == desiredState)
        let acceptedCancellation = lifecycle.requestCancellation()
        #expect(acceptedCancellation)
        #expect(lifecycle.state == .terminal(.canceled))
        #expect(!lifecycle.nativeDispatchStarted)
        #expect(lifecycle.lossResult() == .notStarted)
        let acceptedSecondCancellation = lifecycle.requestCancellation()
        #expect(!acceptedSecondCancellation)
        let acceptedCompletion = lifecycle.establishTerminal(.completed)
        #expect(!acceptedCompletion)
    }
}

@Test
func runningCancellationAndCompletionRaceProducesOneTerminalResult() throws {
    func runningLifecycle(id: UInt64) throws -> BrokerRequestLifecycle {
        var lifecycle = BrokerRequestLifecycle(
            epoch: brokerTestEpoch,
            requestID: try BrokerRequestID(validating: id)
        )
        try lifecycle.beginReceiving()
        try lifecycle.finishReceiving()
        try lifecycle.beginNativeDispatch()
        return lifecycle
    }

    var cancelFirst = try runningLifecycle(id: 1)
    let acceptedCancellation = cancelFirst.requestCancellation()
    #expect(acceptedCancellation)
    #expect(cancelFirst.state == .cancelRequested)
    let acceptedSecondCancellation = cancelFirst.requestCancellation()
    #expect(!acceptedSecondCancellation)
    let establishedCancellation = cancelFirst.establishTerminal(.canceled)
    #expect(establishedCancellation)
    let establishedCompletionAfterCancellation = cancelFirst.establishTerminal(.completed)
    #expect(!establishedCompletionAfterCancellation)
    #expect(cancelFirst.state == .terminal(.canceled))

    var completionFirst = try runningLifecycle(id: 2)
    let establishedCompletion = completionFirst.establishTerminal(.completed)
    #expect(establishedCompletion)
    let acceptedLateCancellation = completionFirst.requestCancellation()
    #expect(!acceptedLateCancellation)
    let establishedLateCancellation = completionFirst.establishTerminal(.canceled)
    #expect(!establishedLateCancellation)
    #expect(completionFirst.state == .terminal(.completed))

    for (index, terminal) in [
        BrokerTerminalResult.completed,
        .rejected(.queueClosed),
        .outcomeUnknown,
        .canceled,
        .notStarted,
    ].enumerated() {
        var lifecycle = try runningLifecycle(id: UInt64(index + 10))
        let establishedFirst = lifecycle.establishTerminal(terminal)
        #expect(establishedFirst)
        let establishedSecond = lifecycle.establishTerminal(.completed)
        #expect(!establishedSecond)
        let acceptedCancellationAfterTerminal = lifecycle.requestCancellation()
        #expect(!acceptedCancellationAfterTerminal)
        #expect(lifecycle.state == .terminal(terminal))
    }
}

@Test
func requestIDSequenceIsMonotonicAndFailsClosedAtExhaustion() throws {
    expectProtocolError(.invalidRequestID(0)) {
        try BrokerRequestID(validating: 0)
    }
    expectProtocolError(.invalidRequestID(0)) {
        try BrokerRequestIDSequence(startingAt: 0)
    }

    var ordinary = try BrokerRequestIDSequence(startingAt: 41)
    let firstOrdinary = try ordinary.next()
    let secondOrdinary = try ordinary.next()
    #expect(firstOrdinary.rawValue == 41)
    #expect(secondOrdinary.rawValue == 42)

    var exhaustion = try BrokerRequestIDSequence(startingAt: UInt64.max)
    let finalID = try exhaustion.next()
    #expect(finalID.rawValue == UInt64.max)
    expectProtocolError(.requestIDSpaceExhausted) {
        try exhaustion.next()
    }
    expectProtocolError(.requestIDSpaceExhausted) {
        try exhaustion.next()
    }
}
