package dev.oliphaunt.androidbrokerspike

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

internal object OlpbProtocol {
    val magic: ByteArray = byteArrayOf(0x4f, 0x4c, 0x50, 0x42)
    const val HEADER_LENGTH = 40
    const val MINIMUM_VERSION = 1
    const val MAXIMUM_VERSION = 1
    const val MAXIMUM_FRAME_PAYLOAD = 256 * 1024
    const val MAXIMUM_QUEUED_BYTES_PER_DIRECTION = 8 * 1024 * 1024
    const val DEFAULT_MAXIMUM_REQUEST_BYTES = 8 * 1024 * 1024
    const val KNOWN_FLAGS_MASK = 0
}

internal enum class OlpbFrameType(
    val wireValue: Int,
    val requiresRequestId: Boolean,
) {
    REQUEST_BEGIN(1, true),
    REQUEST_BYTES(2, true),
    REQUEST_END(3, true),
    RESPONSE_BYTES(4, true),
    COMPLETED(5, true),
    REJECTED(6, true),
    OUTCOME_UNKNOWN(7, true),
    CANCEL_REQUESTED(8, true),
    CANCEL_OBSERVED(9, true),
    PING(10, false),
    PONG(11, false),
    PROTOCOL_ERROR(12, false),
    CHANNEL_CLOSE(13, false),
    ;

    companion object {
        fun fromWireValue(value: Int): OlpbFrameType =
            entries.firstOrNull { it.wireValue == value }
                ?: throw OlpbProtocolException("unknown OLPB frame type $value")
    }
}

internal data class OlpbFrameHeader(
    val protocolVersion: Int = OlpbProtocol.MAXIMUM_VERSION,
    val frameType: OlpbFrameType,
    val flags: Int = 0,
    val epoch: UUID,
    /** Raw unsigned 64-bit request ID bits. Zero is reserved. */
    val requestId: Long,
    val payloadLength: Int,
)

internal class OlpbFrame(
    val header: OlpbFrameHeader,
    val payload: ByteArray,
) {
    constructor(
        protocolVersion: Int = OlpbProtocol.MAXIMUM_VERSION,
        frameType: OlpbFrameType,
        flags: Int = 0,
        epoch: UUID,
        requestId: Long,
        payload: ByteArray = ByteArray(0),
    ) : this(
        header =
            OlpbFrameHeader(
                protocolVersion = protocolVersion,
                frameType = frameType,
                flags = flags,
                epoch = epoch,
                requestId = requestId,
                payloadLength = payload.size,
            ),
        payload = payload,
    )
}

internal class OlpbProtocolException(message: String) : IllegalArgumentException(message)

internal object OlpbFrameCodec {
    fun encode(frame: OlpbFrame): ByteArray {
        if (frame.payload.size != frame.header.payloadLength) {
            throw OlpbProtocolException(
                "OLPB payload length declared ${frame.header.payloadLength}, actual ${frame.payload.size}",
            )
        }
        val header = encodeHeader(frame.header)
        return ByteArray(header.size + frame.payload.size).also { encoded ->
            header.copyInto(encoded)
            frame.payload.copyInto(encoded, destinationOffset = header.size)
        }
    }

    fun encodeHeader(header: OlpbFrameHeader): ByteArray {
        validateHeader(header)
        return ByteBuffer
            .allocate(OlpbProtocol.HEADER_LENGTH)
            .order(ByteOrder.BIG_ENDIAN)
            .apply {
                put(OlpbProtocol.magic)
                putShort(header.protocolVersion.toShort())
                putShort(OlpbProtocol.HEADER_LENGTH.toShort())
                put(header.frameType.wireValue.toByte())
                put(header.flags.toByte())
                putShort(0)
                putLong(header.epoch.mostSignificantBits)
                putLong(header.epoch.leastSignificantBits)
                putLong(header.requestId)
                putInt(header.payloadLength)
            }.array()
    }

    fun decodeHeader(
        bytes: ByteArray,
        expectedEpoch: UUID? = null,
        maximumPayloadLength: Int = OlpbProtocol.MAXIMUM_FRAME_PAYLOAD,
    ): OlpbFrameHeader {
        if (bytes.size < OlpbProtocol.HEADER_LENGTH) {
            throw OlpbProtocolException("truncated OLPB frame header")
        }
        if (!bytes.copyOfRange(0, OlpbProtocol.magic.size).contentEquals(OlpbProtocol.magic)) {
            throw OlpbProtocolException("invalid OLPB magic")
        }
        val source = ByteBuffer.wrap(bytes, 4, OlpbProtocol.HEADER_LENGTH - 4).order(ByteOrder.BIG_ENDIAN)
        val protocolVersion = source.short.toInt() and 0xffff
        val headerLength = source.short.toInt() and 0xffff
        if (headerLength != OlpbProtocol.HEADER_LENGTH) {
            throw OlpbProtocolException("invalid OLPB header length $headerLength")
        }
        val frameType = OlpbFrameType.fromWireValue(source.get().toInt() and 0xff)
        val flags = source.get().toInt() and 0xff
        val reserved = source.short.toInt() and 0xffff
        if (reserved != 0) {
            throw OlpbProtocolException("nonzero OLPB reserved field $reserved")
        }
        val epoch = UUID(source.long, source.long)
        if (expectedEpoch != null && epoch != expectedEpoch) {
            throw OlpbProtocolException("stale OLPB epoch $epoch; expected $expectedEpoch")
        }
        val requestId = source.long
        val payloadLengthUnsigned = source.int.toLong() and 0xffff_ffffL
        if (payloadLengthUnsigned > Int.MAX_VALUE.toLong()) {
            throw OlpbProtocolException("OLPB payload length $payloadLengthUnsigned is not representable")
        }
        val header =
            OlpbFrameHeader(
                protocolVersion = protocolVersion,
                frameType = frameType,
                flags = flags,
                epoch = epoch,
                requestId = requestId,
                payloadLength = payloadLengthUnsigned.toInt(),
            )
        validateHeader(header, maximumPayloadLength)
        return header
    }

    fun decode(
        bytes: ByteArray,
        expectedEpoch: UUID? = null,
        maximumPayloadLength: Int = OlpbProtocol.MAXIMUM_FRAME_PAYLOAD,
    ): OlpbFrame {
        val header = decodeHeader(bytes, expectedEpoch, maximumPayloadLength)
        val expectedLength = OlpbProtocol.HEADER_LENGTH + header.payloadLength
        if (bytes.size != expectedLength) {
            throw OlpbProtocolException("OLPB frame length ${bytes.size}; expected $expectedLength")
        }
        return OlpbFrame(header, bytes.copyOfRange(OlpbProtocol.HEADER_LENGTH, expectedLength))
    }

    fun validateHeader(
        header: OlpbFrameHeader,
        maximumPayloadLength: Int = OlpbProtocol.MAXIMUM_FRAME_PAYLOAD,
    ) {
        if (header.protocolVersion !in OlpbProtocol.MINIMUM_VERSION..OlpbProtocol.MAXIMUM_VERSION) {
            throw OlpbProtocolException("unsupported OLPB protocol version ${header.protocolVersion}")
        }
        if (header.flags and OlpbProtocol.KNOWN_FLAGS_MASK.inv() != 0) {
            throw OlpbProtocolException("unknown OLPB flags ${header.flags}")
        }
        if (header.frameType.requiresRequestId == (header.requestId == 0L)) {
            throw OlpbProtocolException(
                "invalid request ID ${header.requestId} for ${header.frameType}",
            )
        }
        if (maximumPayloadLength < 0 || header.payloadLength !in 0..maximumPayloadLength) {
            throw OlpbProtocolException(
                "OLPB payload length ${header.payloadLength} exceeds $maximumPayloadLength",
            )
        }
    }
}

/** Incremental decoder with an aggregate unread-byte bound. */
internal class OlpbFrameDecoder(
    var expectedEpoch: UUID? = null,
    private val maximumPayloadLength: Int = OlpbProtocol.MAXIMUM_FRAME_PAYLOAD,
    private val maximumBufferedBytes: Int = OlpbProtocol.MAXIMUM_QUEUED_BYTES_PER_DIRECTION,
) {
    private var buffered = ByteArray(0)

    fun append(bytes: ByteArray): List<OlpbFrame> {
        val combinedSize = buffered.size.toLong() + bytes.size.toLong()
        if (combinedSize > maximumBufferedBytes) {
            throw OlpbProtocolException(
                "OLPB buffered bytes $combinedSize exceed $maximumBufferedBytes",
            )
        }
        if (bytes.isNotEmpty()) {
            buffered += bytes
        }
        val frames = mutableListOf<OlpbFrame>()
        var offset = 0
        while (buffered.size - offset >= OlpbProtocol.HEADER_LENGTH) {
            val header =
                OlpbFrameCodec.decodeHeader(
                    buffered.copyOfRange(offset, offset + OlpbProtocol.HEADER_LENGTH),
                    expectedEpoch,
                    maximumPayloadLength,
                )
            val frameLength = OlpbProtocol.HEADER_LENGTH + header.payloadLength
            if (buffered.size - offset < frameLength) {
                break
            }
            frames +=
                OlpbFrame(
                    header,
                    buffered.copyOfRange(
                        offset + OlpbProtocol.HEADER_LENGTH,
                        offset + frameLength,
                    ),
                )
            offset += frameLength
        }
        if (offset > 0) {
            buffered = buffered.copyOfRange(offset, buffered.size)
        }
        return frames
    }

    fun finish(): List<OlpbFrame> {
        val frames = append(ByteArray(0))
        if (buffered.isNotEmpty()) {
            throw OlpbProtocolException("truncated OLPB frame")
        }
        return frames
    }

    fun reset(expectedEpoch: UUID? = null) {
        buffered = ByteArray(0)
        this.expectedEpoch = expectedEpoch
    }
}
