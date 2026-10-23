package dev.oliphaunt

import dev.oliphaunt.bindings.NativeDatabase
import dev.oliphaunt.bindings.OpenOptions
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NativeBindingsTest {
    @Test
    fun generatedBridgePreservesTypedQueriesCancellationAndRecovery() = runBlocking {
        val declared = if (System.getenv("OLIPHAUNT_MOBILE_TEST_PGDATA") == null) declaredNativeFixture() else null
        val pgdata = System.getenv("OLIPHAUNT_MOBILE_TEST_PGDATA") ?: declared?.pgdata
        assumeTrue("requires a prepared native database", pgdata != null)
        val descriptor = File(File(requireNotNull(pgdata)).parentFile, ".oliphaunt.json")
        if (!descriptor.exists()) {
            descriptor.writeText("${nativeDatabaseDescriptor()}\n")
        }
        val library = System.getenv("LIBOLIPHAUNT_PATH") ?: declared?.library
        System.setProperty("jna.library.path", System.getenv("OLIPHAUNT_MOBILE_BINDINGS_DIR") ?: declared?.bindings)
        val native = NativeDatabase.open(
            OpenOptions(
                library,
                requireNotNull(pgdata),
                System.getenv("OLIPHAUNT_INSTALL_DIR") ?: declared?.runtime,
                System.getenv("OLIPHAUNT_EMBEDDED_MODULE_DIR") ?: declared?.modules,
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
                override suspend fun restore(destination: String, bytes: ByteArray) = dev.oliphaunt.bindings.restore(library, destination, bytes)
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

private data class NativeFixture(
    val pgdata: String,
    val library: String,
    val runtime: String,
    val modules: String,
    val bindings: String,
)

private fun nativeDatabaseDescriptor(): JSONObject {
    val fixture = JSONObject(File(sharedFixtureDirectory(), "storage/database-root.json").readText())
    val descriptors = fixture.getJSONArray("validDescriptors")
    return (0 until descriptors.length()).map(descriptors::getJSONObject)
        .first { it.getString("engineFamily") == "native" }
}

private fun declaredNativeFixture(): NativeFixture? {
    val supplied = System.getProperty("oliphaunt.native.facts") ?: return null
    val facts = File(supplied).absoluteFile
    val rows = JSONArray(facts.readText())
    val row = (0 until rows.length()).map(rows::getJSONObject).single { it.getString("target") == "linux-x64-gnu" }
    val root = File(facts.parentFile, row.getString("target"))
    val runtime = File(root, "runtime")
    val library = File(root, row.getString("library"))
    val bindings = File(checkNotNull(System.getProperty("oliphaunt.native.bindings"))).absoluteFile
    check(library.isFile && bindings.isFile) { "Native test requires both declared shared libraries" }
    val temporary = Files.createTempDirectory(File(checkNotNull(System.getenv("TEST_TMPDIR"))).toPath(), "native-bindings-").toFile()
    val pgdata = File(temporary, nativeDatabaseDescriptor().getString("pgdata"))
    val process = ProcessBuilder(
        File(runtime, "bin/initdb").absolutePath,
        "-D", pgdata.absolutePath,
        "-L", File(runtime, "share/postgresql").absolutePath,
        "--no-sync", "-U", "postgres", "--locale-provider=libc", "--locale=C", "-E", "UTF8",
    ).redirectErrorStream(true)
    process.environment().apply {
        clear()
        put("LANG", "C")
        put("LD_LIBRARY_PATH", listOf(File(root, "lib"), File(runtime, "lib")).joinToString(File.pathSeparator) { it.absolutePath })
        // The default published runtime has no optional ICU data carrier.
        put("OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY", "1")
        put("OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY", "1")
    }
    val initialized = process.start()
    val output = initialized.inputStream.bufferedReader().readText()
    check(initialized.waitFor() == 0) { "Declared runtime initdb failed: $output" }
    return NativeFixture(pgdata.absolutePath, library.absolutePath, runtime.absolutePath, File(runtime, "lib").absolutePath, checkNotNull(bindings.parentFile).absolutePath)
}
