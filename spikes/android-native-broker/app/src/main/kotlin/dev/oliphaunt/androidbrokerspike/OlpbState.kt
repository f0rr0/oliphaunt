package dev.oliphaunt.androidbrokerspike

import java.util.UUID

internal enum class OlpbRequestState {
    QUEUED,
    RECEIVING,
    READY_TO_DISPATCH,
    RUNNING,
    CANCEL_REQUESTED,
    TERMINAL,
}

internal enum class OlpbTerminalResult {
    COMPLETED,
    REJECTED,
    OUTCOME_UNKNOWN,
    CANCELED,
    NOT_STARTED,
}

internal class OlpbRequestLifecycle(
    val epoch: UUID,
    val requestId: Long,
) {
    var state: OlpbRequestState = OlpbRequestState.QUEUED
        private set
    var terminalResult: OlpbTerminalResult? = null
        private set
    var nativeDispatchStarted: Boolean = false
        private set

    fun beginReceiving() = transition(OlpbRequestState.QUEUED, OlpbRequestState.RECEIVING)

    fun finishReceiving() =
        transition(OlpbRequestState.RECEIVING, OlpbRequestState.READY_TO_DISPATCH)

    fun beginNativeDispatch() {
        transition(OlpbRequestState.READY_TO_DISPATCH, OlpbRequestState.RUNNING)
        nativeDispatchStarted = true
    }

    fun requestCancellation(): Boolean =
        when (state) {
            OlpbRequestState.QUEUED,
            OlpbRequestState.RECEIVING,
            OlpbRequestState.READY_TO_DISPATCH,
            -> establishTerminal(OlpbTerminalResult.CANCELED)
            OlpbRequestState.RUNNING -> {
                state = OlpbRequestState.CANCEL_REQUESTED
                true
            }
            OlpbRequestState.CANCEL_REQUESTED,
            OlpbRequestState.TERMINAL,
            -> false
        }

    fun establishTerminal(result: OlpbTerminalResult): Boolean {
        if (state == OlpbRequestState.TERMINAL) return false
        state = OlpbRequestState.TERMINAL
        terminalResult = result
        return true
    }

    fun lossResult(): OlpbTerminalResult =
        if (nativeDispatchStarted) OlpbTerminalResult.OUTCOME_UNKNOWN else OlpbTerminalResult.NOT_STARTED

    private fun transition(expected: OlpbRequestState, next: OlpbRequestState) {
        if (state != expected) {
            throw OlpbProtocolException("illegal request transition $state -> $next")
        }
        state = next
    }
}

/** Bounded PostgreSQL frontend-message assembler used between requestBegin/requestEnd. */
internal class OlpbFrontendRequestAssembler(
    private val maximumRequestBytes: Int = OlpbProtocol.DEFAULT_MAXIMUM_REQUEST_BYTES,
) {
    private var bytes = ByteArray(minOf(16 * 1024, maximumRequestBytes))
    private var size = 0
    private var scanOffset = 0

    init {
        require(maximumRequestBytes >= 5)
    }

    val byteCount: Int
        get() = size

    fun append(chunk: ByteArray) {
        val newSize = size.toLong() + chunk.size.toLong()
        if (newSize > maximumRequestBytes) {
            throw OlpbProtocolException("request bytes $newSize exceed $maximumRequestBytes")
        }
        ensureCapacity(newSize.toInt())
        chunk.copyInto(bytes, destinationOffset = size)
        size = newSize.toInt()
        scanCompleteMessages()
    }

    fun finish(): ByteArray {
        scanCompleteMessages()
        if (size == 0) throw OlpbProtocolException("empty PostgreSQL frontend request")
        if (scanOffset != size) {
            val remaining = size - scanOffset
            throw OlpbProtocolException(
                if (remaining < 5) "truncated PostgreSQL message header"
                else "truncated PostgreSQL message body",
            )
        }
        return bytes.copyOf(size)
    }

    fun reset() {
        size = 0
        scanOffset = 0
    }

    private fun scanCompleteMessages() {
        while (size - scanOffset >= 5) {
            val lengthOffset = scanOffset + 1
            val messageLength =
                ((bytes[lengthOffset].toLong() and 0xff) shl 24) or
                    ((bytes[lengthOffset + 1].toLong() and 0xff) shl 16) or
                    ((bytes[lengthOffset + 2].toLong() and 0xff) shl 8) or
                    (bytes[lengthOffset + 3].toLong() and 0xff)
            if (messageLength < 4) {
                throw OlpbProtocolException("PostgreSQL message length $messageLength is smaller than 4")
            }
            val totalLength = messageLength + 1
            if (totalLength > maximumRequestBytes) {
                throw OlpbProtocolException("PostgreSQL message bytes $totalLength exceed $maximumRequestBytes")
            }
            if (totalLength > size - scanOffset) return
            scanOffset += totalLength.toInt()
        }
    }

    private fun ensureCapacity(required: Int) {
        if (required <= bytes.size) return
        var capacity = maxOf(1, bytes.size)
        while (capacity < required) {
            capacity = minOf(maximumRequestBytes, capacity * 2)
        }
        bytes = bytes.copyOf(capacity)
    }
}
