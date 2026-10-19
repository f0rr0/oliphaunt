package dev.oliphaunt

import com.sun.management.ThreadMXBean
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import java.lang.management.ManagementFactory
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class AdmissionAllocationTest {
    @Test
    fun byteSaturationRejectsSqlBeforeEncodingWithAnUnusedCountSlot() = runTest {
        val allocations = ManagementFactory.getThreadMXBean() as? ThreadMXBean ?: return@runTest
        if (!allocations.isThreadAllocatedMemorySupported) return@runTest
        allocations.isThreadAllocatedMemoryEnabled = true
        val session = AdmissionOrderSession()
        val database = OliphauntDatabase.open(EngineConfig(admission = AdmissionLimits(2, 1024)), TestEngine(session))
        val first = async(start = CoroutineStart.UNDISPATCHED) { database.execProtocolRaw(byteArrayOf(1)) }
        session.awaitFirstRaw()
        val sql = "SELECT 1 /*" + "x".repeat(8 * 1024 * 1024) + "*/"
        val warmupSql = "SELECT 1 /*" + "x".repeat(2048) + "*/"
        val operations = listOf<Pair<String, suspend (String) -> Unit>>(
            "exec" to { database.exec(it) },
            "query" to { database.query(it) },
            "describe" to { database.describe(it) },
        )
        val thread = Thread.currentThread().id
        try {
            for ((name, operation) in operations) {
                repeat(2) { assertFailsWith<OliphauntException> { operation(warmupSql) } }
                val before = allocations.getThreadAllocatedBytes(thread)
                val failure = runCatching { operation(sql) }.exceptionOrNull()
                val allocated = allocations.getThreadAllocatedBytes(thread) - before
                assertTrue(assertNotNull(failure).message.orEmpty().contains("operation queue is full"), name)
                assertTrue(allocated < 1024 * 1024, "$name allocated $allocated bytes before rejecting byte saturation")
            }
            val second = async(start = CoroutineStart.UNDISPATCHED) { database.execProtocolRaw(byteArrayOf(2)) }
            session.releaseFirstRaw()
            assertContentEquals(byteArrayOf(2), second.await())
        } finally {
            session.releaseFirstRaw()
            assertContentEquals(byteArrayOf(1), first.await())
            database.close()
        }
    }
}
