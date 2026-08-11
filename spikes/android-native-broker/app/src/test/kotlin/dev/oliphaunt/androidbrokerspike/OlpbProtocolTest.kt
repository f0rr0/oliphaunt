package dev.oliphaunt.androidbrokerspike

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OlpbProtocolTest {
    private val epoch = UUID.fromString("00112233-4455-6677-8899-aabbccddeeff")

    @Test
    fun headerUsesCanonicalFortyByteNetworkLayout() {
        val payload = byteArrayOf(0x10, 0x20, 0x30)
        val encoded =
            OlpbFrameCodec.encode(
                OlpbFrame(
                    frameType = OlpbFrameType.REQUEST_BYTES,
                    epoch = epoch,
                    requestId = 0x0102030405060708L,
                    payload = payload,
                ),
            )

        assertEquals(OlpbProtocol.HEADER_LENGTH + payload.size, encoded.size)
        assertContentEquals(byteArrayOf(0x4f, 0x4c, 0x50, 0x42), encoded.copyOfRange(0, 4))
        assertContentEquals(byteArrayOf(0, 1, 0, 40, 2, 0, 0, 0), encoded.copyOfRange(4, 12))
        assertContentEquals(
            byteArrayOf(
                0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
                0x88.toByte(), 0x99.toByte(), 0xaa.toByte(), 0xbb.toByte(),
                0xcc.toByte(), 0xdd.toByte(), 0xee.toByte(), 0xff.toByte(),
            ),
            encoded.copyOfRange(12, 28),
        )
        assertContentEquals(payload, OlpbFrameCodec.decode(encoded, epoch).payload)
    }

    @Test
    fun incrementalDecoderHandlesFragmentedAndAdjacentFrames() {
        val first =
            OlpbFrameCodec.encode(
                OlpbFrame(frameType = OlpbFrameType.PING, epoch = epoch, requestId = 0),
            )
        val second =
            OlpbFrameCodec.encode(
                OlpbFrame(
                    frameType = OlpbFrameType.REQUEST_BYTES,
                    epoch = epoch,
                    requestId = 9,
                    payload = byteArrayOf(1, 2, 3),
                ),
            )
        val decoder = OlpbFrameDecoder(expectedEpoch = epoch)

        assertTrue(decoder.append(first.copyOfRange(0, 11)).isEmpty())
        val decoded = decoder.append(first.copyOfRange(11, first.size) + second)

        assertEquals(listOf(OlpbFrameType.PING, OlpbFrameType.REQUEST_BYTES), decoded.map { it.header.frameType })
        assertContentEquals(byteArrayOf(1, 2, 3), decoded[1].payload)
        assertTrue(decoder.finish().isEmpty())
    }

    @Test
    fun codecRejectsStaleEpochUnknownFlagsAndTruncation() {
        val valid =
            OlpbFrameCodec.encode(
                OlpbFrame(frameType = OlpbFrameType.PING, epoch = epoch, requestId = 0),
            )
        assertFailsWith<OlpbProtocolException> {
            OlpbFrameCodec.decode(valid, UUID.randomUUID())
        }

        val flagged = valid.copyOf().also { it[9] = 1 }
        assertFailsWith<OlpbProtocolException> { OlpbFrameCodec.decode(flagged, epoch) }

        val decoder = OlpbFrameDecoder(expectedEpoch = epoch)
        decoder.append(valid.copyOf(valid.size - 1))
        assertFailsWith<OlpbProtocolException> { decoder.finish() }
    }

    @Test
    fun frontendAssemblerAcceptsFragmentedCompleteMessages() {
        val query = simpleQuery("SELECT 1")
        val assembler = OlpbFrontendRequestAssembler()
        assembler.append(query.copyOfRange(0, 3))
        assembler.append(query.copyOfRange(3, query.size))

        assertContentEquals(query, assembler.finish())
    }

    @Test
    fun lifecycleDistinguishesPreDispatchLossFromUnknownOutcome() {
        val beforeDispatch = OlpbRequestLifecycle(epoch, 1)
        beforeDispatch.beginReceiving()
        assertEquals(OlpbTerminalResult.NOT_STARTED, beforeDispatch.lossResult())

        val afterDispatch = OlpbRequestLifecycle(epoch, 2)
        afterDispatch.beginReceiving()
        afterDispatch.finishReceiving()
        afterDispatch.beginNativeDispatch()
        assertEquals(OlpbTerminalResult.OUTCOME_UNKNOWN, afterDispatch.lossResult())
        assertTrue(afterDispatch.requestCancellation())
        assertFalse(afterDispatch.requestCancellation())
    }

    @Test
    fun nativePostgresOutputWitnessRequiresStrictlyMoreThanThresholdAcrossChunks() {
        val counter = NativePostgresOutputWitnessCounter(thresholdBytes = 4)

        assertNull(counter.consume(byteArrayOf(1, 2, 3)))
        assertNull(counter.consume(byteArrayOf(4)))
        assertEquals(5, counter.consume(byteArrayOf(5))?.backendBytes)
        assertNull(counter.consume(byteArrayOf(6)))
    }

    @Test
    fun nativePostgresOutputWitnessRejectsNegativeThreshold() {
        assertFailsWith<IllegalArgumentException> {
            NativePostgresOutputWitnessCounter(thresholdBytes = -1)
        }
    }

    private fun simpleQuery(sql: String): ByteArray {
        val body = sql.toByteArray(Charsets.UTF_8) + 0
        return ByteBuffer
            .allocate(1 + 4 + body.size)
            .order(ByteOrder.BIG_ENDIAN)
            .apply {
                put('Q'.code.toByte())
                putInt(body.size + 4)
                put(body)
            }.array()
    }

}
