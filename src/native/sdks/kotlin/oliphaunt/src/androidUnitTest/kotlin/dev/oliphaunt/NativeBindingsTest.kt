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
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
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
            val typed = database.query(
                "SELECT $1::uuid AS empty, $2::int4 AS same, $3::bytea AS same",
                listOf(QueryParam.typedNull(PostgresOid.uuid), QueryParam.binary(byteArrayOf(0, 0, 0, 42), PostgresOid.int4), QueryParam.bytes(byteArrayOf(0, -1, 1, 2))),
            )
            assertNull(typed.rows.single().raw(0))
            assertEquals(listOf("empty", "same", "same"), typed.fields.map { it.name })
            assertEquals(42, typed.rows.single().value(1, PostgresDecoders.int))
            assertContentEquals(byteArrayOf(0, -1, 1, 2), typed.rows.single().value(2, PostgresDecoders.bytes))
            assertFailsWith<OliphauntException> { typed.rows.single().raw("same") }
            database.exec("CREATE TEMP TABLE typed_fixture (value int)")
            database.exec("CREATE TYPE pg_temp.typed_fixture_enum AS ENUM ('one')")
            val oid = PostgresOid(database.query("SELECT 'pg_temp.typed_fixture_enum'::regtype::oid::text").rows.single().text(0)!!.toUInt())
            val custom = database.query("SELECT $1 AS value", listOf(QueryParam.text("one", oid)))
            assertEquals(oid, custom.fields.single().typeOid)
            assertEquals("one", custom.rows.single().text(0))
            val error = runCatching { database.query("SELECT $1", listOf(QueryParam.text("missing", oid))) }.exceptionOrNull()
            assertTrue(error is PostgresException)
            assertEquals("22P02", (error as PostgresException).postgresError.sqlstate)
            assertEquals("9", database.query("SELECT 9").rows.single().text(0))
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
