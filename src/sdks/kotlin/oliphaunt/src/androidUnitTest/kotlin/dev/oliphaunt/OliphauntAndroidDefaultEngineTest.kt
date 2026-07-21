package dev.oliphaunt

import android.content.Context
import kotlinx.coroutines.test.runTest
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class OliphauntAndroidDefaultEngineTest {
    @Test
    fun commonSupportedModesExposeAndroidFacadeContract() {
        val support = OliphauntDatabase.supportedModes()

        assertEquals(
            listOf(EngineMode.NativeDirect, EngineMode.NativeBroker, EngineMode.NativeServer),
            support.map { it.mode },
        )
        assertTrue(support[0].available)
        assertEquals(1, support[0].capabilities.maxClientSessions)
        assertFalse(support[0].capabilities.independentSessions)
        assertFalse(support[0].capabilities.multiRoot)
        assertTrue(support[0].capabilities.reopenable)
        assertTrue(support[0].capabilities.sameRootLogicalReopen)
        assertFalse(support[0].capabilities.rootSwitchable)
        assertFalse(support[0].capabilities.crashRestartable)
        assertFalse(support[1].available)
        assertTrue(support[1].capabilities.multiRoot)
        assertTrue(support[1].capabilities.reopenable)
        assertFalse(support[1].capabilities.sameRootLogicalReopen)
        assertTrue(support[1].capabilities.rootSwitchable)
        assertTrue(support[1].capabilities.crashRestartable)
        assertTrue(support[1].unavailableReason.orEmpty().contains("broker"))
        assertFalse(support[2].available)
        assertTrue(support[2].capabilities.independentSessions)
        assertFalse(support[2].capabilities.multiRoot)
        assertTrue(support[2].capabilities.reopenable)
        assertFalse(support[2].capabilities.sameRootLogicalReopen)
        assertTrue(support[2].capabilities.rootSwitchable)
        assertFalse(support[2].capabilities.crashRestartable)
        assertTrue(support[2].unavailableReason.orEmpty().contains("server"))
    }

    @Test
    fun commonOpenDefaultPointsAndroidAppsToContextFacade() = runTest {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(OliphauntConfig(mode = EngineMode.NativeDirect))
            }

        assertTrue(error.message.orEmpty().contains("use OliphauntAndroid.open(context, config)"))
    }

    @Test
    fun commonOpenDefaultRejectsUnavailableAndroidModes() = runTest {
        val brokerError =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(OliphauntConfig(mode = EngineMode.NativeBroker))
            }
        assertTrue(brokerError.message.orEmpty().contains("broker mode requires a platform broker adapter"))

        val serverError =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.open(OliphauntConfig(mode = EngineMode.NativeServer))
            }
        assertTrue(serverError.message.orEmpty().contains("server mode requires a platform server adapter"))
    }

    @Test
    fun commonRestoreDefaultPointsAndroidAppsToContextFacade() = runTest {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntDatabase.restore(
                    RestoreRequest(
                        artifact = BackupArtifact(BackupFormat.PhysicalArchive, ByteArray(0)),
                        root = "/tmp/oliphaunt-android-restore-default",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("use OliphauntAndroid.restore(context, request)"))
    }

    @Test
    fun androidNativeDirectRejectsUnsupportedBackupFormatsBeforeJniCall() {
        val sqlError =
            assertFailsWith<OliphauntException> {
                requireAndroidNativeDirectBackupFormat(BackupFormat.Sql)
            }
        assertTrue(sqlError.message.orEmpty().contains("supports PhysicalArchive"))

        val archiveError =
            assertFailsWith<OliphauntException> {
                requireAndroidNativeDirectBackupFormat(BackupFormat.OliphauntArchive)
            }
        assertTrue(archiveError.message.orEmpty().contains("supports PhysicalArchive"))

        requireAndroidNativeDirectBackupFormat(BackupFormat.PhysicalArchive)
    }

    @Test
    fun androidNativeDirectLibraryPathResolutionUsesPackagedLibraryLast() {
        val nativeLibDir = createTempDirectory("liboliphaunt-android-native-libs").toFile()
        try {
            val packaged = File(nativeLibDir, "liboliphaunt.so").apply { writeText("test") }

            assertEquals(
                "/explicit/liboliphaunt.so",
                resolveAndroidLiboliphauntLibraryPath(
                    explicitLibraryPath = "/explicit/liboliphaunt.so",
                    nativeLibraryDirectory = nativeLibDir.absolutePath,
                    envProvider = { null },
                ),
            )
            assertEquals(
                "/env/liboliphaunt.so",
                resolveAndroidLiboliphauntLibraryPath(
                    explicitLibraryPath = null,
                    nativeLibraryDirectory = nativeLibDir.absolutePath,
                    envProvider = { name ->
                        when (name) {
                            "LIBOLIPHAUNT_PATH" -> "/env/liboliphaunt.so"
                            else -> null
                        }
                    },
                ),
            )
            assertEquals(
                packaged.absolutePath,
                resolveAndroidLiboliphauntLibraryPath(
                    explicitLibraryPath = null,
                    nativeLibraryDirectory = nativeLibDir.absolutePath,
                    envProvider = { null },
                ),
            )
        } finally {
            nativeLibDir.deleteRecursively()
        }
    }

    @Test
    fun androidNativeDirectLibraryPathResolutionReturnsNullWhenNoSourceExists() {
        val missingLibDir = createTempDirectory("liboliphaunt-android-missing-libs").toFile()
        try {
            assertNull(
                resolveAndroidLiboliphauntLibraryPath(
                    explicitLibraryPath = null,
                    nativeLibraryDirectory = missingLibDir.absolutePath,
                    envProvider = { null },
                ),
            )
        } finally {
            missingLibDir.deleteRecursively()
        }
    }

    @Test
    fun androidNativeDirectLibraryPathResolutionUsesApkZipPathWhenLibrariesAreNotExtracted() {
        val tempDir = createTempDirectory("liboliphaunt-android-apk-libs").toFile()
        try {
            val apk = File(tempDir, "base.apk")
            ZipOutputStream(apk.outputStream()).use { zip ->
                zip.putNextEntry(ZipEntry("lib/arm64-v8a/liboliphaunt.so"))
                zip.write(byteArrayOf(1))
                zip.closeEntry()
            }

            assertEquals(
                "${apk.absolutePath}!/lib/arm64-v8a/liboliphaunt.so",
                resolveAndroidLiboliphauntLibraryPath(
                    explicitLibraryPath = null,
                    nativeLibraryDirectory = File(tempDir, "not-extracted").absolutePath,
                    sourceArchivePaths = listOf(apk.absolutePath),
                    supportedAbis = listOf("x86_64", "arm64-v8a"),
                    envProvider = { null },
                ),
            )
        } finally {
            tempDir.deleteRecursively()
        }
    }
}

@Suppress("UNUSED_VARIABLE")
private suspend fun readmeAndroidOpenExample(applicationContext: Context) {
    // liboliphaunt-doc-example:kotlin-android-open
    val db =
        OliphauntAndroid.open(
            context = applicationContext,
            config =
            OliphauntConfig(
                mode = EngineMode.NativeDirect,
                username = "postgres",
                database = "postgres",
                extensions = listOf("vector"),
            ),
        )
    val response = db.execProtocolRaw(ProtocolRequest.simpleQuery("SELECT 1"))
    db.close()
}
