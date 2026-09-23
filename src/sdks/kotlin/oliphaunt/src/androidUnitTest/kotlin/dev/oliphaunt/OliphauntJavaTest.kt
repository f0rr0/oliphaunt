package dev.oliphaunt

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals

class OliphauntJavaTest {
    @Test
    fun blockingFacadeOwnsTheSessionAndSupportsUse() {
        var closed = 0
        var cancelled = 0
        val session = object : OliphauntSession {
            override suspend fun execProtocolRaw(request: ByteArray): ByteArray = error("unused")
            override suspend fun execProtocolRawStream(request: ByteArray, onChunk: (ByteArray) -> Unit): ProtocolStreamOutcome = error("unused")
            override suspend fun backup(): ByteArray = byteArrayOf(1, 2, 3)
            override suspend fun cancel() {
                cancelled++
            }
            override suspend fun close() {
                closed++
            }
        }
        val engine = object : OliphauntEngine {
            override suspend fun open(config: EngineConfig): OliphauntSession = session
            override suspend fun restore(destination: String, bytes: ByteArray): Unit = error("unused")
        }
        val database = runBlocking { OliphauntDatabase.open(EngineConfig(), engine) }
        BlockingOliphauntDatabase(database).use {
            assertContentEquals(byteArrayOf(1, 2, 3), it.backup())
            it.cancel()
        }
        assertEquals(1, cancelled)
        assertEquals(1, closed)
    }
}
