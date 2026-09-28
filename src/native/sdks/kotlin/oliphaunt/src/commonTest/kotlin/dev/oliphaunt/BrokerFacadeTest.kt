package dev.oliphaunt

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class BrokerFacadeTest {
    @Test
    fun queuedDeadlineDoesNotDispatchOrPoison() = runTest {
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        var calls = 0
        val session = object : FakeBrokerSession() {
            override val operationTimeoutMillis: Long = 5
            override fun operationTimeMillis(): Long = testScheduler.currentTime
            override suspend fun execProtocolRaw(request: ByteArray): ByteArray {
                calls++
                started.complete(Unit)
                finish.await()
                return request
            }
        }
        val database = open(session)
        val first = async { database.execProtocolRaw(byteArrayOf(1)) }
        started.await()
        val queued = async { runCatching { database.execProtocolRaw(byteArrayOf(2)) } }
        runCurrent()
        advanceTimeBy(6)
        runCurrent()
        val error = assertIs<OliphauntBrokerException>(queued.await().exceptionOrNull())
        assertEquals(BrokerExecution.NotStarted, error.execution)
        assertFalse(error.requiresReopen)
        assertEquals(1, calls)
        finish.complete(Unit)
        first.await()
        database.execProtocolRaw(byteArrayOf(3))
        assertEquals(2, calls)
        database.close()
    }

    @Test
    fun rejectionPreservesUsabilityAndLostTerminalPoisonsQueuedWork() = runTest {
        var calls = 0
        val session = object : FakeBrokerSession() {
            override suspend fun execProtocolRaw(request: ByteArray): ByteArray {
                calls++
                if (request[0] == 1.toByte()) {
                    throw OliphauntBrokerException(
                        BrokerFailureReason.InvalidRequest,
                        BrokerExecution.NotStarted,
                        false,
                        "invalid group",
                    )
                }
                if (request[0] == 3.toByte()) {
                    throw OliphauntBrokerException(
                        BrokerFailureReason.WorkerInterrupted,
                        BrokerExecution.Unknown,
                        true,
                        "terminal lost",
                    )
                }
                return request
            }
        }
        val database = open(session)
        assertIs<OliphauntBrokerException>(runCatching { database.execProtocolRaw(byteArrayOf(1)) }.exceptionOrNull())
        database.execProtocolRaw(byteArrayOf(2))
        val lost = assertIs<OliphauntBrokerException>(runCatching { database.execProtocolRaw(byteArrayOf(3)) }.exceptionOrNull())
        assertEquals(BrokerExecution.Unknown, lost.execution)
        val queued = assertIs<OliphauntBrokerException>(runCatching { database.execProtocolRaw(byteArrayOf(4)) }.exceptionOrNull())
        assertEquals(BrokerExecution.NotStarted, queued.execution)
        assertTrue(queued.requiresReopen)
        assertEquals(3, calls)
        database.close()
    }

    @Test
    fun terminalCloseReleasesFacadeEvenWhenReceiptIsLost() = runTest {
        val database = open(object : FakeBrokerSession() {
            override fun isUsable(): Boolean = false
            override suspend fun execProtocolRaw(request: ByteArray): ByteArray = error("unused")
            override suspend fun close(): Unit = throw OliphauntBrokerException(BrokerFailureReason.WorkerInterrupted, BrokerExecution.Unknown, true, "lost close receipt")
        })
        assertIs<OliphauntBrokerException>(runCatching { database.close() }.exceptionOrNull())
        assertTrue(database.isClosed)
        database.close()
    }

    private suspend fun open(session: OliphauntSession): OliphauntDatabase = OliphauntDatabase.open(
        EngineConfig(),
        object : OliphauntEngine {
            override suspend fun open(config: EngineConfig): OliphauntSession = session
            override suspend fun restore(destination: String, bytes: ByteArray): Unit = error("unused")
        },
    )

    private abstract class FakeBrokerSession : OliphauntSession {
        override suspend fun execProtocolRawStream(request: ByteArray, onChunk: (ByteArray) -> Unit): ProtocolStreamOutcome = error("unused")
        override suspend fun backup(): ByteArray = error("unused")
        override suspend fun cancel() {}
        override suspend fun close() {}
    }
}
