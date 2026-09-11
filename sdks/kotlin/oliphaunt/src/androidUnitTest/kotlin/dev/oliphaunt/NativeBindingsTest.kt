package dev.oliphaunt

import dev.oliphaunt.bindings.NativeDatabase
import dev.oliphaunt.bindings.OpenOptions
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class NativeBindingsTest {
    @Test
    fun generatedBridgePreservesTypedQueriesCancellationAndRecovery() = runBlocking {
        val pgdata = System.getenv("OLIPHAUNT_MOBILE_TEST_PGDATA")
        assumeTrue("requires a prepared native database", pgdata != null)
        val descriptor = File(File(requireNotNull(pgdata)).parentFile, ".oliphaunt.json")
        if (!descriptor.exists()) {
            val fixture = JSONObject(File(System.getProperty("oliphaunt.sharedFixturesDir"), "storage/database-root.json").readText())
            val descriptors = fixture.getJSONArray("validDescriptors")
            val native = (0 until descriptors.length()).map(descriptors::getJSONObject)
                .first { it.getString("engineFamily") == "native" }
            descriptor.writeText("$native\n")
        }
        System.setProperty("jna.library.path", System.getenv("OLIPHAUNT_MOBILE_BINDINGS_DIR"))
        val native = NativeDatabase.open(
            OpenOptions(
                System.getenv("LIBOLIPHAUNT_PATH"),
                requireNotNull(pgdata),
                System.getenv("OLIPHAUNT_INSTALL_DIR"),
                System.getenv("OLIPHAUNT_EMBEDDED_MODULE_DIR"),
                null,
                "postgres",
                "postgres",
                emptyList(),
            ),
        )
        val database = OliphauntDatabase.open(
            EngineConfig(),
            object : OliphauntEngine {
                override suspend fun open(config: EngineConfig): OliphauntSession = AndroidNativeDirectSession(native)
                override suspend fun restore(destination: String, bytes: ByteArray) = dev.oliphaunt.bindings.restore(System.getenv("LIBOLIPHAUNT_PATH"), destination, bytes)
            },
        )
        try {
            assertEquals("42", database.query("SELECT 42").rows.single().text(0))
            val sleeping = launch { runCatching { database.query("SELECT pg_sleep(60)") } }
            delay(100)
            val start = System.nanoTime()
            sleeping.cancelAndJoin()
            assertTrue(System.nanoTime() - start < 3_000_000_000)
            assertEquals("7", database.query("SELECT 7").rows.single().text(0))
            val transaction = launch {
                runCatching { database.transaction { it.query("SELECT pg_sleep(60)") } }
            }
            delay(100)
            transaction.cancelAndJoin()
            assertEquals("7", database.query("SELECT 7").rows.single().text(0))
            // Coroutine debug stack recovery may copy standard exception types.
            // An application exception with state must retain its identity.
            class CallbackFailure(val marker: Any) : RuntimeException("stop rows")
            val callbackFailure = CallbackFailure(Any())
            val failure = runCatching {
                database.execProtocolRawStream(simpleQueryProtocol("SELECT generate_series(1, 1000)")) {
                    throw callbackFailure
                }
            }.exceptionOrNull()
            assertTrue(failure === callbackFailure, "callback failure changed to $failure")
            assertEquals("8", database.query("SELECT 8").rows.single().text(0))
            assertTrue(database.backup().isNotEmpty())
        } finally {
            database.close()
            native.destroy()
        }
    }
}
