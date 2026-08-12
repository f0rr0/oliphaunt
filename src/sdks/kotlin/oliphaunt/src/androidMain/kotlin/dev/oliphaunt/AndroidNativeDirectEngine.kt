package dev.oliphaunt

import android.content.Context
import android.os.Build
import android.os.Process
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.locks.ReentrantLock
import java.util.zip.ZipFile

public class AndroidNativeDirectEngine(
    context: Context,
    private val libraryPath: String? = null,
    private val runtimeDirectory: String? = null,
    private val resourceRoot: File? = null,
    private val username: String = "postgres",
    private val database: String = "postgres",
) : OliphauntEngine {
    private val appContext = context.applicationContext

    public fun packageSizeReport(): OliphauntPackageSizeReport? = OliphauntAndroid.packageSizeReport(appContext)

    override fun supportedModes(): List<EngineModeSupport> = OliphauntAndroid.supportedModes()

    override suspend fun open(config: OliphauntConfig): OliphauntSession {
        if (config.mode != EngineMode.NativeDirect) {
            throw OliphauntException("AndroidNativeDirectEngine supports NativeDirect, got ${config.mode}")
        }
        validateDatabaseStorage(config.storage)
        validateStartupIdentity(config.username ?: username, "username")
        validateStartupIdentity(config.database ?: database, "database")
        validateStartupGucs(config.startupGucs)
        val runtime =
            OliphauntAndroidRuntimeAssets.resolve(
                context = appContext,
                explicitRuntimeDirectory =
                runtimeDirectory
                    ?: env("OLIPHAUNT_INSTALL_DIR")
                    ?: env("OLIPHAUNT_RUNTIME_DIR"),
                requestedExtensions = config.extensions,
                resourceRoot = resourceRoot,
            )
        val storageDirectory = when (val storage = config.storage) {
            DatabaseStorage.TemporaryDirectory -> AndroidDirectTemporaryStorage.resolve(appContext)
            is DatabaseStorage.Directory -> File(storage.path)
        }
        if (!storageDirectory.mkdirs() && !storageDirectory.isDirectory) {
            throw OliphauntException("failed to create database storage directory at ${storageDirectory.absolutePath}")
        }
        val pgdata = File(storageDirectory, "pgdata")
        val executionDispatcher =
            Executors
                .newSingleThreadExecutor { runnable ->
                    Thread(runnable, "oliphaunt-android-direct").apply {
                        isDaemon = true
                    }
                }.asCoroutineDispatcher()
        var nativeOpenAttempted = false
        try {
            OliphauntAndroidRuntimeAssets.preparePgdata(
                assetManager = appContext.assets,
                pgdata = pgdata,
                templatePgdata = runtime.templatePgdata,
            )
            val effectiveUsername = config.username ?: username
            val effectiveDatabase = config.database ?: database
            val effectiveLibraryPath =
                resolveAndroidLiboliphauntLibraryPath(
                    explicitLibraryPath = libraryPath,
                    nativeLibraryDirectory = appContext.applicationInfo.nativeLibraryDir,
                    sourceArchivePaths = appContext.applicationInfo.liboliphauntSourceArchivePaths(),
                    supportedAbis = Build.SUPPORTED_ABIS.asList(),
                )
            val nativeHandle =
                withContext(executionDispatcher) {
                    nativeOpenAttempted = true
                    OliphauntAndroidNativeBridge.openNative(
                        effectiveLibraryPath,
                        pgdata.absolutePath,
                        runtime.runtimeDirectory,
                        effectiveUsername,
                        effectiveDatabase,
                        config.postgresStartupArgs(runtime.sharedPreloadLibraries).toTypedArray(),
                    )
                }
            return AndroidNativeDirectSession(
                nativeHandle = nativeHandle,
                executionDispatcher = executionDispatcher,
            )
        } catch (error: Throwable) {
            executionDispatcher.close()
            // Preparation failures are safe to clean. Once control reaches the
            // process-resident runtime, a rejected logical reopen may leave it
            // owning the same directory.
            if (config.storage == DatabaseStorage.TemporaryDirectory && !nativeOpenAttempted) {
                storageDirectory.deleteRecursively()
            }
            throw error
        }
    }

    override suspend fun restore(request: RestoreRequest): String {
        validateDirectoryPath(request.destination, "restore destination")
        if (request.artifact.format != BackupFormat.PhysicalArchive) {
            throw OliphauntException("Kotlin Android restore currently requires PhysicalArchive, got ${request.artifact.format}")
        }
        OliphauntAndroidNativeBridge.restoreNative(
            destination = request.destination,
            format = request.artifact.format.wireName(),
            artifact = request.artifact.bytes,
            replaceExisting = request.destinationPolicy == RestoreDestinationPolicy.ReplaceExisting,
            libraryPath =
            resolveAndroidLiboliphauntLibraryPath(
                explicitLibraryPath = libraryPath,
                nativeLibraryDirectory = appContext.applicationInfo.nativeLibraryDir,
                sourceArchivePaths = appContext.applicationInfo.liboliphauntSourceArchivePaths(),
                supportedAbis = Build.SUPPORTED_ABIS.asList(),
            ),
        )
        return request.destination
    }
}

private object AndroidDirectTemporaryStorage {
    @Volatile
    private var root: File? = null

    fun resolve(context: Context): File = synchronized(this) {
        root ?: File(
            context.cacheDir,
            "oliphaunt-direct-${Process.myPid()}-${UUID.randomUUID()}",
        ).also { root = it }
    }
}

private class AndroidNativeDirectSession(
    private val nativeHandle: Long,
    private val executionDispatcher: ExecutorCoroutineDispatcher,
) : OliphauntSession {
    private val lock = ReentrantLock()
    private val noActiveCalls = lock.newCondition()
    private var handle: Long = nativeHandle
    private var closing = false
    private var closed = false
    private var activeCalls = 0

    override suspend fun capabilities(): EngineCapabilities = withContext(executionDispatcher) {
        val current = beginCall()
        val flags =
            try {
                OliphauntAndroidNativeBridge.capabilitiesNative(current)
            } finally {
                endCall()
            }
        EngineCapabilities(
            mode = EngineMode.NativeDirect,
            processIsolated = false,
            independentSessions = false,
            maxClientSessions = 1,
            multipleInstances = flags and CAP_MULTI_INSTANCE != 0L,
            sameInstanceLogicalReopen = flags and CAP_LOGICAL_REOPEN != 0L,
            instanceSwitchable = false,
            crashRestartable = false,
            protocolRaw = flags and CAP_PROTOCOL_RAW != 0L,
            protocolStream = flags and CAP_PROTOCOL_STREAM != 0L,
            queryCancel = flags and CAP_QUERY_CANCEL != 0L,
            backupRestore = flags and CAP_BACKUP_RESTORE != 0L,
            backupFormats = listOf(BackupFormat.PhysicalArchive),
            restoreFormats = listOf(BackupFormat.PhysicalArchive),
            simpleQuery = flags and CAP_SIMPLE_QUERY != 0L,
            extensions = flags and CAP_EXTENSIONS != 0L,
        )
    }

    override suspend fun execProtocolRaw(request: ProtocolRequest): ProtocolResponse = withContext(executionDispatcher) {
        val current = beginCall()
        try {
            ProtocolResponse(
                OliphauntAndroidNativeBridge.execProtocolRawNative(current, request.bytes),
            )
        } finally {
            endCall()
        }
    }

    override suspend fun execProtocolStream(
        request: ProtocolRequest,
        onChunk: (ProtocolResponse) -> Unit,
    ) {
        withContext(executionDispatcher) {
            val current = beginCall()
            try {
                OliphauntAndroidNativeBridge.execProtocolStreamNative(
                    current,
                    request.bytes,
                    OliphauntAndroidProtocolStreamSink { chunk ->
                        onChunk(ProtocolResponse(chunk))
                        0
                    },
                )
            } finally {
                endCall()
            }
        }
    }

    override suspend fun backup(request: BackupRequest): BackupArtifact = withContext(executionDispatcher) {
        requireAndroidNativeDirectBackupFormat(request.format)
        val current = beginCall()
        try {
            BackupArtifact(
                format = BackupFormat.PhysicalArchive,
                bytes =
                OliphauntAndroidNativeBridge.backupNative(
                    current,
                    request.format.wireName(),
                ),
            )
        } finally {
            endCall()
        }
    }

    override suspend fun cancel() {
        val current = beginCall()
        try {
            OliphauntAndroidNativeBridge.cancelNative(current)
        } finally {
            endCall()
        }
    }

    override suspend fun close() {
        val current = beginClose() ?: return
        try {
            withContext(executionDispatcher) {
                OliphauntAndroidNativeBridge.closeNative(current)
            }
            finishClose(detached = true)
            executionDispatcher.close()
        } catch (error: Throwable) {
            finishClose(detached = false)
            throw error
        }
    }

    private fun beginCall(): Long {
        lock.lock()
        try {
            checkOpen()
            activeCalls += 1
            return handle
        } finally {
            lock.unlock()
        }
    }

    private fun endCall() {
        lock.lock()
        try {
            activeCalls -= 1
            noActiveCalls.signalAll()
        } finally {
            lock.unlock()
        }
    }

    private fun beginClose(): Long? {
        lock.lock()
        try {
            if (closed) {
                return null
            }
            if (closing) {
                throw OliphauntException("database close is already in progress")
            }
            closing = true
            val current = handle.takeIf { it != 0L }
            while (activeCalls > 0) {
                try {
                    noActiveCalls.await()
                } catch (error: InterruptedException) {
                    closing = false
                    noActiveCalls.signalAll()
                    Thread.currentThread().interrupt()
                    throw OliphauntException("interrupted while closing database")
                }
            }
            return current
        } finally {
            lock.unlock()
        }
    }

    private fun finishClose(detached: Boolean) {
        lock.lock()
        try {
            if (detached) {
                handle = 0
                closed = true
            }
            closing = false
            noActiveCalls.signalAll()
        } finally {
            lock.unlock()
        }
    }

    private fun checkOpen() {
        if (closing || closed || handle == 0L) {
            throw OliphauntException("database is closed")
        }
    }

    private companion object {
        const val CAP_PROTOCOL_RAW: Long = 1L shl 0
        const val CAP_PROTOCOL_STREAM: Long = 1L shl 1
        const val CAP_MULTI_INSTANCE: Long = 1L shl 2
        const val CAP_EXTENSIONS: Long = 1L shl 4
        const val CAP_QUERY_CANCEL: Long = 1L shl 5
        const val CAP_BACKUP_RESTORE: Long = 1L shl 6
        const val CAP_SIMPLE_QUERY: Long = 1L shl 7
        const val CAP_LOGICAL_REOPEN: Long = 1L shl 9
    }
}

internal fun requireAndroidNativeDirectBackupFormat(format: BackupFormat) {
    if (format != BackupFormat.PhysicalArchive) {
        throw OliphauntException("Kotlin Android native-direct backup currently supports PhysicalArchive, got $format")
    }
}

private fun BackupFormat.wireName(): String = when (this) {
    BackupFormat.Sql -> "sql"
    BackupFormat.PhysicalArchive -> "physicalArchive"
    BackupFormat.OliphauntArchive -> "oliphauntArchive"
}

internal fun resolveAndroidLiboliphauntLibraryPath(
    explicitLibraryPath: String?,
    nativeLibraryDirectory: String?,
    sourceArchivePaths: List<String> = emptyList(),
    supportedAbis: List<String> = emptyList(),
    envProvider: (String) -> String? = ::env,
): String? = explicitLibraryPath?.takeIf(String::isNotBlank)
    ?: envProvider("OLIPHAUNT_KOTLIN_ANDROID_LIBRARY")?.takeIf(String::isNotBlank)
    ?: envProvider("LIBOLIPHAUNT_PATH")?.takeIf(String::isNotBlank)
    ?: envProvider("OLIPHAUNT_LIBRARY")?.takeIf(String::isNotBlank)
    ?: packagedAndroidLiboliphauntPath(nativeLibraryDirectory)
    ?: packagedAndroidLiboliphauntZipPath(sourceArchivePaths, supportedAbis)

private fun packagedAndroidLiboliphauntPath(nativeLibraryDirectory: String?): String? = nativeLibraryDirectory
    ?.takeIf(String::isNotBlank)
    ?.let { File(it, "liboliphaunt.so") }
    ?.takeIf(File::isFile)
    ?.absolutePath

private fun android.content.pm.ApplicationInfo.liboliphauntSourceArchivePaths(): List<String> = buildList {
    add(sourceDir)
    add(publicSourceDir)
    splitSourceDirs?.forEach(::add)
}.filter { path -> path.isNotBlank() }.distinct()

private fun packagedAndroidLiboliphauntZipPath(
    sourceArchivePaths: List<String>,
    supportedAbis: List<String>,
): String? {
    val archivePaths = sourceArchivePaths.filter(String::isNotBlank).distinct()
    val abis = supportedAbis.filter(String::isNotBlank).distinct()
    for (archivePath in archivePaths) {
        val archive = File(archivePath)
        if (!archive.isFile) {
            continue
        }
        ZipFile(archive).use { zip ->
            for (abi in abis) {
                val entryName = "lib/$abi/liboliphaunt.so"
                if (zip.getEntry(entryName) != null) {
                    return "$archivePath!/$entryName"
                }
            }
        }
    }
    return null
}

private fun env(name: String): String? = System.getenv(name)?.takeIf(String::isNotEmpty)
