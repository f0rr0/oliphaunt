@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package dev.oliphaunt

import kotlinx.cinterop.toKString
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import platform.posix.F_OK
import platform.posix.access
import platform.posix.getenv
import platform.posix.getpid
import platform.posix.usleep
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

class NativeDirectEngineTest {
    @Test
    fun reportsMissingLiboliphauntLibrary() = runTest {
        val engine =
            NativeDirectEngine(
                libraryPath = "/tmp/oliphaunt-missing.dylib",
            )

        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    config = OliphauntConfig(mode = EngineMode.NativeDirect),
                    engine = engine,
                )
            }
        assertTrue(error.message.orEmpty().contains("failed to load liboliphaunt"))
    }

    @Test
    fun extensionsRequireExplicitRuntimeDirectory() = runTest {
        if (env("OLIPHAUNT_INSTALL_DIR") != null || env("OLIPHAUNT_RUNTIME_DIR") != null) {
            return@runTest
        }
        val engine =
            NativeDirectEngine(
                libraryPath = "/tmp/oliphaunt-missing.dylib",
            )

        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    config =
                    OliphauntConfig(
                        mode = EngineMode.NativeDirect,
                        extensions = listOf("vector"),
                    ),
                    engine = engine,
                )
            }
        assertTrue(error.message.orEmpty().contains("extensions require runtimeDirectory"))
    }

    @Test
    fun extensionIdsMustBePortable() = runTest {
        val engine =
            NativeDirectEngine(
                libraryPath = "/tmp/oliphaunt-missing.dylib",
                runtimeDirectory = "/tmp/oliphaunt-runtime",
            )

        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    config =
                    OliphauntConfig(
                        mode = EngineMode.NativeDirect,
                        extensions = listOf("mobile/vector"),
                    ),
                    engine = engine,
                )
            }
        assertTrue(error.message.orEmpty().contains("must contain 1 to 128 ASCII"))
    }

    @Test
    fun extensionIdsMustExistInGeneratedCatalog() = runTest {
        val engine =
            NativeDirectEngine(
                libraryPath = "/tmp/oliphaunt-missing.dylib",
                runtimeDirectory = "/tmp/oliphaunt-runtime",
            )

        val error =
            assertFailsWith<OliphauntException> {
                engine.open(
                    OliphauntConfig(
                        mode = EngineMode.NativeDirect,
                        extensions = listOf("pg_search"),
                    ),
                )
            }
        assertTrue(
            error.message.orEmpty().contains("unknown Kotlin native-direct extension id 'pg_search'"),
        )
    }

    @Test
    fun extensionsUseExplicitRuntimeDirectory() = runTest {
        val engine =
            NativeDirectEngine(
                libraryPath = "/tmp/oliphaunt-missing.dylib",
                runtimeDirectory = "/tmp/oliphaunt-runtime",
            )

        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    config =
                    OliphauntConfig(
                        mode = EngineMode.NativeDirect,
                        extensions = listOf("vector"),
                    ),
                    engine = engine,
                )
            }
        assertTrue(error.message.orEmpty().contains("failed to load liboliphaunt"))
    }

    @Test
    fun commonSupportedModesExposeNativeDirectDefault() {
        val support = OliphauntDatabase.supportedModes()

        assertEquals(
            listOf(EngineMode.NativeDirect, EngineMode.NativeBroker, EngineMode.NativeServer),
            support.map { it.mode },
        )
        assertTrue(support[0].available)
        assertEquals(1, support[0].capabilities.maxClientSessions)
        assertFalse(support[0].capabilities.multiRoot)
        assertTrue(support[0].capabilities.sameRootLogicalReopen)
        assertFalse(support[0].capabilities.rootSwitchable)
        assertFalse(support[0].capabilities.crashRestartable)
        assertTrue(support[0].capabilities.supportsBackupFormat(BackupFormat.PhysicalArchive))
        assertTrue(support[1].capabilities.multiRoot)
        assertTrue(support[1].capabilities.rootSwitchable)
        assertTrue(support[1].capabilities.crashRestartable)
        assertTrue(support[1].unavailableReason.orEmpty().contains("broker"))
        assertFalse(support[2].capabilities.multiRoot)
        assertTrue(support[2].capabilities.rootSwitchable)
        assertFalse(support[2].capabilities.crashRestartable)
        assertTrue(support[2].unavailableReason.orEmpty().contains("server"))
    }

    @Test
    fun executesAgainstLinkedLiboliphauntWhenAvailable() = runBlocking {
        val library = env("LIBOLIPHAUNT_PATH") ?: return@runBlocking
        val runtime = env("OLIPHAUNT_INSTALL_DIR") ?: return@runBlocking
        withTimeout(90.seconds) {
            val engine =
                NativeDirectEngine(
                    libraryPath = library,
                    runtimeDirectory = runtime,
                )
            val config =
                OliphauntConfig(
                    mode = EngineMode.NativeDirect,
                    root = nativeTestRoot("oliphaunt-direct"),
                    durability = DurabilityProfile.FastDev,
                )
            val database =
                OliphauntDatabase.open(
                    config = config,
                    engine = engine,
                )

            try {
                val capabilities = database.capabilities()
                assertTrue(capabilities.protocolRaw)
                assertTrue(capabilities.protocolStream)
                assertTrue(capabilities.queryCancel)
                assertTrue(capabilities.backupRestore)
                assertTrue(capabilities.simpleQuery)

                val response = database.execProtocolRaw(ProtocolRequest.simpleQuery("SELECT 1 AS value"))
                assertTrue(response.bytes.containsTag(0x54), "missing RowDescription")
                assertTrue(response.bytes.containsTag(0x44), "missing DataRow")
                assertTrue(response.bytes.containsTag(0x5A), "missing ReadyForQuery")

                // liboliphaunt-doc-example:kotlin-streaming
                val streamed = mutableListOf<ProtocolResponse>()
                database.execProtocolStream(ProtocolRequest.simpleQuery("SELECT 1 AS streamed_value")) { chunk ->
                    streamed += chunk
                }
                val streamedBytes = streamed.flatMap { chunk -> chunk.bytes.asIterable() }.toByteArray()
                assertTrue(streamedBytes.containsTag(0x54), "missing streamed RowDescription")
                assertTrue(streamedBytes.containsTag(0x44), "missing streamed DataRow")
                assertTrue(streamedBytes.containsTag(0x5A), "missing streamed ReadyForQuery")

                val typed = database.query("SELECT 1::text AS value")
                assertEquals("1", typed.getText(0, "value"))

                val parameterized =
                    database.query(
                        "SELECT \$1::text AS value",
                        listOf(QueryParam.Text("1")),
                    )
                assertEquals("1", parameterized.getText(0, "value"))

                database.execProtocolRaw(
                    ProtocolRequest.simpleQuery(
                        "CREATE TABLE IF NOT EXISTS kotlin_backup_smoke(value integer); " +
                            "TRUNCATE kotlin_backup_smoke; " +
                            "INSERT INTO kotlin_backup_smoke VALUES (42)",
                    ),
                )
                val archive = database.backup()
                assertEquals(BackupFormat.PhysicalArchive, archive.format)
                assertTrue(archive.bytes.containsAscii("backup_label"), "missing backup_label in physical archive")

                val restoredRoot = "${env("TMPDIR") ?: "/tmp"}/oliphaunt-restore-${getpid()}"
                val restored =
                    OliphauntDatabase.restore(
                        RestoreRequest(
                            artifact = archive,
                            root = restoredRoot,
                        ).replaceExisting(),
                    )
                assertEquals(restoredRoot, restored)
                assertTrue(fileExists("$restoredRoot/pgdata/PG_VERSION"), "missing restored PG_VERSION")
                assertTrue(fileExists("$restoredRoot/pgdata/backup_label"), "missing restored backup_label")

                database.close()

                val session = engine.open(config)
                try {
                    val started = CompletableDeferred<Unit>()
                    val query =
                        async(Dispatchers.Default) {
                            started.complete(Unit)
                            session.execProtocolRaw(ProtocolRequest.simpleQuery("SELECT pg_sleep(0.1) AS should_finish"))
                        }
                    started.await()
                    usleep(25_000u)
                    session.close()
                    val response = query.await()
                    assertFalse(response.bytes.containsTag(0x45), "close must not cancel active protocol work")
                    assertTrue(response.bytes.containsTag(0x5A), "missing ReadyForQuery after close waits")
                } finally {
                    runCatching {
                        session.close()
                    }
                }

                val reopened =
                    OliphauntDatabase.open(
                        config = config,
                        engine = engine,
                    )
                try {
                    val cancelled =
                        async(Dispatchers.Default) {
                            reopened.execProtocolRaw(ProtocolRequest.simpleQuery("SELECT pg_sleep(5) AS should_cancel"))
                        }
                    usleep(100_000u)
                    reopened.cancel()
                    val cancelledResponse = cancelled.await()
                    assertTrue(cancelledResponse.bytes.containsTag(0x45), "missing ErrorResponse after cancel")
                    assertTrue(cancelledResponse.bytes.containsTag(0x5A), "missing ReadyForQuery after cancel")

                    val response = reopened.execProtocolRaw(ProtocolRequest.simpleQuery("SELECT 42 AS reopened"))
                    assertTrue(response.bytes.containsTag(0x44), "missing DataRow after reopen")
                    assertTrue(response.bytes.containsTag(0x5A), "missing ReadyForQuery after reopen")
                } finally {
                    reopened.close()
                }
            } finally {
                database.close()
            }
        }
    }
}

private fun ByteArray.containsTag(tag: Int): Boolean {
    var offset = 0
    while (offset + 5 <= size) {
        val messageTag = this[offset].toInt() and 0xff
        val length =
            ((this[offset + 1].toInt() and 0xff) shl 24) or
                ((this[offset + 2].toInt() and 0xff) shl 16) or
                ((this[offset + 3].toInt() and 0xff) shl 8) or
                (this[offset + 4].toInt() and 0xff)
        if (length < 4 || offset + 1 + length > size) {
            return false
        }
        if (messageTag == tag) {
            return true
        }
        offset += 1 + length
    }
    return false
}

private fun ByteArray.containsAscii(needle: String): Boolean {
    val bytes = needle.encodeToByteArray()
    if (bytes.isEmpty()) {
        return true
    }
    return indices.any { start ->
        start + bytes.size <= size && bytes.indices.all { offset -> this[start + offset] == bytes[offset] }
    }
}

private fun fileExists(path: String): Boolean = access(path, F_OK) == 0

private fun nativeTestRoot(name: String): String = "${env("TMPDIR") ?: "/tmp"}/$name-${getpid()}"

private fun env(name: String): String? = getenv(name)?.toKString()?.takeIf(String::isNotEmpty)
