@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package dev.oliphaunt

import dev.oliphaunt.native.c.oliphaunt_kotlin_remove_tree
import kotlinx.cinterop.toKString
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import platform.posix.F_OK
import platform.posix.access
import platform.posix.fclose
import platform.posix.fopen
import platform.posix.fputs
import platform.posix.getenv
import platform.posix.getpid
import platform.posix.mkdir
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

class NativeDirectEngineTest {
    @Test
    fun unavailableInitdbDoesNotPublishAnIncompleteManagedRoot() = runTest {
        val root = nativeTestRoot("oliphaunt-native-root")
        removeTree(root)
        try {
            val error = assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    OliphauntConfig(storage = DatabaseStorage.Directory(root)),
                    NativeDirectEngine(
                        libraryPath = "/tmp/oliphaunt-missing.dylib",
                        runtimeDirectory = "/tmp/oliphaunt-missing-runtime",
                    ),
                )
            }
            assertTrue(error.message.orEmpty().contains("initdb is not executable"))
            assertTrue(!fileExists("$root/.oliphaunt.json"))
            assertTrue(!fileExists("$root/pgdata"))
        } finally {
            removeTree(root)
        }
    }

    @Test
    fun descriptorlessNonemptyRootIsRejectedWithoutMutation() = runTest {
        val library = env("LIBOLIPHAUNT_PATH") ?: return@runTest
        val root = nativeTestRoot("oliphaunt-native-nonempty")
        removeTree(root)
        mkdir(root, 0x1C0u)
        writeText("$root/keep.txt", "keep")
        try {
            val error = assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(
                    OliphauntConfig(storage = DatabaseStorage.Directory(root)),
                    NativeDirectEngine(libraryPath = library),
                )
            }
            assertTrue(error.message.orEmpty().contains("nonempty"))
            assertTrue(fileExists("$root/keep.txt"))
            assertTrue(!fileExists("$root/.oliphaunt.json"))
        } finally {
            removeTree(root)
        }
    }

    @Test
    fun extensionsRequireRuntimeDirectory() = runTest {
        if (env("OLIPHAUNT_INSTALL_DIR") != null || env("OLIPHAUNT_RUNTIME_DIR") != null) return@runTest
        val error = assertFailsWith<OliphauntException> {
            NativeDirectEngine(libraryPath = "/tmp/oliphaunt-missing.dylib").open(
                OliphauntConfig(extensions = listOf("vector")),
            )
        }
        assertTrue(error.message.orEmpty().contains("extensions require runtimeDirectory"))
    }

    @Test
    fun executesBacksUpAndRestoresWhenRuntimeIsAvailable() = runBlocking {
        val library = env("LIBOLIPHAUNT_PATH") ?: return@runBlocking
        val runtime = env("OLIPHAUNT_INSTALL_DIR") ?: return@runBlocking
        val root = nativeTestRoot("oliphaunt-native-integration")
        val restoreRoot = nativeTestRoot("oliphaunt-native-restore")
        removeTree(root)
        removeTree(restoreRoot)
        withTimeout(90.seconds) {
            val database = OliphauntDatabase.open(
                OliphauntConfig(storage = DatabaseStorage.Directory(root)),
                NativeDirectEngine(libraryPath = library, runtimeDirectory = runtime),
            )
            try {
                val result = database.query("SELECT 1::text AS value")
                assertEquals("1", result.getText(0, "value"))
                database.execute("CREATE TABLE kotlin_backup_smoke(value integer)")
                val backup = database.backup()
                assertTrue(backup.isNotEmpty())
                OliphauntDatabase.restore(
                    restoreRoot,
                    backup,
                    NativeDirectEngine(libraryPath = library, runtimeDirectory = runtime),
                )
                assertTrue(fileExists("$restoreRoot/.oliphaunt.json"))
                assertTrue(fileExists("$restoreRoot/pgdata/PG_VERSION"))
                assertContentEquals(backup, backup.copyOf())
            } finally {
                database.close()
                removeTree(root)
                removeTree(restoreRoot)
            }
        }
    }
}

private fun fileExists(path: String): Boolean = access(path, F_OK) == 0

private fun nativeTestRoot(name: String): String = "${env("TMPDIR") ?: "/tmp"}/$name-${getpid()}-${Random.nextInt()}"

private fun env(name: String): String? = getenv(name)?.toKString()?.takeIf(String::isNotEmpty)

private fun removeTree(path: String) {
    if (fileExists(path)) oliphaunt_kotlin_remove_tree(path)
}

private fun writeText(path: String, value: String) {
    val file = checkNotNull(fopen(path, "wb"))
    try {
        check(fputs(value, file) >= 0)
    } finally {
        fclose(file)
    }
}
