package dev.oliphaunt

import android.content.Context
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.Process
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import dev.oliphaunt.bindings.ChunkSink
import dev.oliphaunt.bindings.NativeDatabase
import dev.oliphaunt.bindings.NativeException
import dev.oliphaunt.bindings.OpenOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.ZipFile

private const val OWNER_READ_WRITE_MODE = 384 // 0600

internal class AndroidNativeDirectEngine(
    context: Context,
    private val libraryPath: String? = null,
    private val runtimeDirectory: String? = null,
    private val resourceRoot: File? = null,
) : OliphauntEngine {
    private val appContext = context.applicationContext

    override suspend fun open(config: EngineConfig): OliphauntSession = withContext(Dispatchers.IO) {
        nativeOperation { AndroidNativeDirectSession(NativeDatabase.open(prepare(config))) }
    }

    internal fun prepare(config: EngineConfig): OpenOptions {
        validateDatabaseStorage(config.storage)
        validateStartupIdentity(config.username, "username")
        validateStartupIdentity(config.database, "database")
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
        val storageDirectory = resolveAndroidStorage(appContext, config.storage)
        try {
            if (isAndroidSymbolicLink(storageDirectory)) {
                throw OliphauntException(
                    "database storage directory must be a real directory: ${storageDirectory.absolutePath}",
                )
            }
            if (!storageDirectory.mkdirs() && !storageDirectory.isDirectory) {
                throw OliphauntException(
                    "failed to create database storage directory at ${storageDirectory.absolutePath}",
                )
            }
            val pgdata = File(storageDirectory, "pgdata")
            val rootState = classifyAndroidManagedRoot(storageDirectory)
            val effectiveUsername = config.username ?: "postgres"
            val effectiveDatabase = config.database ?: "postgres"
            when (rootState) {
                AndroidManagedRootState.Managed -> {
                    validateCompleteAndroidPgdata(pgdata)
                }

                AndroidManagedRootState.Empty -> {
                    requireAndroidFreshRootRole(effectiveUsername)
                    // Publish PGDATA and its descriptor together. A killed initializer
                    // may leave a sibling staging tree, but never poisons the live root.
                    val stagingRoot = File(storageDirectory.parentFile, ".oliphaunt-root-${UUID.randomUUID()}")
                    check(stagingRoot.mkdir()) { "failed to create database root staging directory" }
                    val result = runCatching {
                        Os.chmod(stagingRoot.absolutePath, 448) // 0700
                        val stagedPgdata = File(stagingRoot, "pgdata")
                        OliphauntAndroidRuntimeAssets.preparePgdata(
                            assetManager = appContext.assets,
                            pgdata = stagedPgdata,
                            clusterSeed = runtime.clusterSeed,
                        )
                        validateCompleteAndroidPgdata(stagedPgdata)
                        writeAndroidManagedRootDescriptor(stagingRoot)
                        // POSIX rename replaces an empty directory, never a nonempty root.
                        Os.rename(stagingRoot.absolutePath, storageDirectory.absolutePath)
                        OliphauntAndroidRuntimeAssets.syncAndroidDirectory(storageDirectory.parentFile!!)
                    }
                    finishAndroidStaging(result, operation = "database root publication") {
                        removeAndroidStagingIfPresent(stagingRoot)
                    }
                }
            }
            val effectiveLibraryPath =
                resolveAndroidLiboliphauntLibraryPath(
                    explicitLibraryPath = libraryPath,
                    nativeLibraryDirectory = appContext.applicationInfo.nativeLibraryDir,
                    sourceArchivePaths = appContext.applicationInfo.liboliphauntSourceArchivePaths(),
                    supportedAbis = Build.SUPPORTED_ABIS.asList(),
                )
            return OpenOptions(
                libraryPath = effectiveLibraryPath,
                pgdata = pgdata.absolutePath,
                runtimeDirectory = runtime.runtimeDirectory,
                moduleDirectory = null,
                icuDataDirectory = File(runtime.runtimeDirectory, "share/icu")
                    .takeIf { it.isDirectory }?.absolutePath,
                username = effectiveUsername,
                database = effectiveDatabase,
                startupArgs = config.postgresStartupArgs(runtime.sharedPreloadLibraries),
            )
        } catch (error: Throwable) {
            // No process-resident session has been opened by preparation.
            if (config.storage == EngineStorage.TemporaryDirectory) {
                storageDirectory.deleteRecursively()
            }
            throw if (error is NativeException.Database) OliphauntException(error.detail) else error
        }
    }

    override suspend fun restore(
        destination: String,
        bytes: ByteArray,
    ) {
        validateDirectoryPath(destination, "restore destination")
        nativeOperation {
            dev.oliphaunt.bindings.restore(
                destination = destination,
                bytes = bytes,
                libraryPath = resolveAndroidLiboliphauntLibraryPath(
                    explicitLibraryPath = libraryPath,
                    nativeLibraryDirectory = appContext.applicationInfo.nativeLibraryDir,
                    sourceArchivePaths = appContext.applicationInfo.liboliphauntSourceArchivePaths(),
                    supportedAbis = Build.SUPPORTED_ABIS.asList(),
                ),
            )
        }
    }
}

internal fun requireAndroidFreshRootRole(username: String) {
    if (username != "postgres") {
        throw OliphauntException(
            "a new Android Oliphaunt database is initialized with the postgres role; " +
                "username selects an existing role and cannot be '$username' on first open",
        )
    }
}

internal fun isAndroidSymbolicLink(file: File): Boolean = try {
    OsConstants.S_ISLNK(Os.lstat(file.absolutePath).st_mode)
} catch (error: ErrnoException) {
    if (error.errno == OsConstants.ENOENT) {
        false
    } else {
        throw OliphauntException("failed to inspect database storage path ${file.absolutePath}: ${error.message}")
    }
}

internal enum class AndroidManagedRootState {
    Empty,
    Managed,
}

internal fun classifyAndroidManagedRoot(directory: File): AndroidManagedRootState {
    val descriptor = File(directory, ".oliphaunt.json")
    if (descriptor.exists()) {
        validateAndroidManagedRootDescriptor(descriptor)
        val entries =
            directory.list()?.toList()
                ?: throw OliphauntException("could not inspect database storage directory: ${directory.absolutePath}")
        if (entries.size != 2 || entries.toSet() != setOf(".oliphaunt.json", "pgdata")) {
            throw OliphauntException(
                "managed database storage directory must contain exactly .oliphaunt.json and pgdata: ${directory.absolutePath}",
            )
        }
        return AndroidManagedRootState.Managed
    }
    if (!directory.list().orEmpty().isEmpty()) {
        throw OliphauntException(
            "database storage directory is nonempty but has no .oliphaunt.json descriptor: ${directory.absolutePath}",
        )
    }
    return AndroidManagedRootState.Empty
}

internal fun writeAndroidManagedRootDescriptor(directory: File) {
    val descriptor = File(directory, ".oliphaunt.json")
    val temporary = File(directory, ".oliphaunt.json.tmp-${UUID.randomUUID()}")
    val result =
        runCatching {
            FileOutputStream(temporary).use { output ->
                output.write(NATIVE_ROOT_DESCRIPTOR.encodeToByteArray())
                Os.fchmod(output.fd, OWNER_READ_WRITE_MODE)
                output.fd.sync()
            }
            if (!temporary.renameTo(descriptor)) {
                validateAndroidManagedRootDescriptor(descriptor)
            }
            OliphauntAndroidRuntimeAssets.syncAndroidDirectory(directory)
        }
    finishAndroidStaging(result, operation = "database root descriptor publication") {
        removeAndroidStagingIfPresent(temporary)
    }
}

internal fun isAndroidPathDefinitelyAbsent(path: File): Boolean = try {
    Os.lstat(path.absolutePath)
    false
} catch (error: ErrnoException) {
    if (error.errno == OsConstants.ENOENT) {
        true
    } else {
        throw OliphauntException(
            "failed to inspect ${path.absolutePath}: ${error.message}",
        )
    }
}

internal fun validateCompleteAndroidPgdata(pgdata: File) {
    val version = File(pgdata, "PG_VERSION")
    requireRealAndroidFile(version, "PG_VERSION")
    if (version.readText().trim() != "18") {
        throw OliphauntException("PGDATA PostgreSQL major must be 18: ${version.absolutePath}")
    }
    requireRealAndroidDirectory(File(pgdata, "global"), "global")
    requireRealAndroidFile(File(pgdata, "global/pg_control"), "global/pg_control")
    requireRealAndroidDirectory(File(pgdata, "pg_wal"), "pg_wal")
}

private fun validateAndroidManagedRootDescriptor(descriptor: File) {
    val parent =
        descriptor.parentFile
            ?: throw OliphauntException("database root descriptor has no parent: ${descriptor.absolutePath}")
    val realLocation = File(parent.canonicalFile, descriptor.name)
    if (!descriptor.isFile || descriptor.length() == 0L || descriptor.canonicalFile != realLocation) {
        throw OliphauntException("database root descriptor must be a nonempty real file: ${descriptor.absolutePath}")
    }
    val value =
        runCatching { AndroidFlatJsonParser(descriptor.readText()).parse() }
            .getOrElse { throw OliphauntException("invalid database root descriptor: ${descriptor.absolutePath}") }
    val family = (value["engineFamily"] as? AndroidJsonValue.StringValue)?.value
    val format = (value["physicalFormat"] as? AndroidJsonValue.StringValue)?.value
    val expectedFormat = mapOf("native" to "native-pg18-v1", "wasix" to "wasix-pg18-v1")[family]
    if (
        value.keys != setOf("schema", "engineFamily", "pgdata", "postgresMajor", "physicalFormat") ||
        value["schema"] != AndroidJsonValue.StringValue("oliphaunt-database-root-v1") ||
        value["pgdata"] != AndroidJsonValue.StringValue("pgdata") ||
        value["postgresMajor"] != AndroidJsonValue.IntegerValue(18) ||
        expectedFormat == null ||
        expectedFormat != format
    ) {
        throw OliphauntException("invalid database root descriptor: ${descriptor.absolutePath}")
    }
}

private sealed interface AndroidJsonValue {
    data class StringValue(
        val value: String,
    ) : AndroidJsonValue

    data class IntegerValue(
        val value: Long,
    ) : AndroidJsonValue
}

private class AndroidFlatJsonParser(
    private val source: String,
) {
    private var offset = 0

    fun parse(): Map<String, AndroidJsonValue> {
        skipWhitespace()
        expect('{')
        skipWhitespace()
        val values = mutableMapOf<String, AndroidJsonValue>()
        if (consume('}')) {
            finish()
            return values
        }
        while (true) {
            val key = parseString()
            if (values.containsKey(key)) throw IllegalArgumentException("duplicate key")
            skipWhitespace()
            expect(':')
            skipWhitespace()
            values[key] =
                if (peek() == '"') {
                    AndroidJsonValue.StringValue(parseString())
                } else {
                    AndroidJsonValue.IntegerValue(parseInteger())
                }
            skipWhitespace()
            if (consume('}')) break
            expect(',')
            skipWhitespace()
        }
        finish()
        return values
    }

    private fun parseString(): String {
        expect('"')
        val result = StringBuilder()
        while (offset < source.length) {
            val character = source[offset++]
            when {
                character == '"' -> {
                    return result.toString()
                }

                character.code < 0x20 -> {
                    throw IllegalArgumentException("unescaped control character")
                }

                character != '\\' -> {
                    result.append(character)
                }

                offset >= source.length -> {
                    throw IllegalArgumentException("incomplete escape")
                }

                else -> {
                    when (val escaped = source[offset++]) {
                        '"', '\\', '/' -> {
                            result.append(escaped)
                        }

                        'b' -> {
                            result.append('\b')
                        }

                        'f' -> {
                            result.append('\u000c')
                        }

                        'n' -> {
                            result.append('\n')
                        }

                        'r' -> {
                            result.append('\r')
                        }

                        't' -> {
                            result.append('\t')
                        }

                        'u' -> {
                            if (offset + 4 > source.length) throw IllegalArgumentException("incomplete unicode escape")
                            val code =
                                source.substring(offset, offset + 4).toIntOrNull(16)
                                    ?: throw IllegalArgumentException("invalid unicode escape")
                            result.append(code.toChar())
                            offset += 4
                        }

                        else -> {
                            throw IllegalArgumentException("invalid escape")
                        }
                    }
                }
            }
        }
        throw IllegalArgumentException("unterminated string")
    }

    private fun parseInteger(): Long {
        val start = offset
        consume('-')
        when (peek()) {
            '0' -> {
                offset += 1
                if (peek()?.isDigit() == true) throw IllegalArgumentException("leading zero")
            }

            in '1'..'9' -> {
                while (peek()?.isDigit() == true) offset += 1
            }

            else -> {
                throw IllegalArgumentException("expected integer")
            }
        }
        return source.substring(start, offset).toLongOrNull()
            ?: throw IllegalArgumentException("invalid integer")
    }

    private fun finish() {
        skipWhitespace()
        if (offset != source.length) throw IllegalArgumentException("trailing content")
    }

    private fun skipWhitespace() {
        while (true) {
            when (peek()) {
                ' ', '\t', '\n', '\r' -> offset += 1
                else -> return
            }
        }
    }

    private fun peek(): Char? = source.getOrNull(offset)

    private fun consume(expected: Char): Boolean = if (peek() == expected) {
        offset += 1
        true
    } else {
        false
    }

    private fun expect(expected: Char) {
        if (!consume(expected)) throw IllegalArgumentException("expected $expected")
    }
}

private fun requireRealAndroidDirectory(
    file: File,
    label: String,
) {
    val parent = file.parentFile
    val realLocation = parent?.let { File(it.canonicalFile, file.name) }
    if (!file.isDirectory || realLocation == null || file.canonicalFile != realLocation) {
        throw OliphauntException("PGDATA $label must be a real directory: ${file.absolutePath}")
    }
}

private fun requireRealAndroidFile(
    file: File,
    label: String,
) {
    val parent = file.parentFile
    val realLocation = parent?.let { File(it.canonicalFile, file.name) }
    if (!file.isFile || file.length() == 0L || realLocation == null || file.canonicalFile != realLocation) {
        throw OliphauntException("PGDATA $label must be a nonempty real file: ${file.absolutePath}")
    }
}

internal const val NATIVE_ROOT_DESCRIPTOR: String =
    "{\"schema\":\"oliphaunt-database-root-v1\",\"engineFamily\":\"native\",\"pgdata\":\"pgdata\",\"postgresMajor\":18,\"physicalFormat\":\"native-pg18-v1\"}\n"

internal fun resolveAndroidStorage(context: Context, storage: EngineStorage): File {
    validateDatabaseStorage(storage)
    return when (storage) {
        EngineStorage.TemporaryDirectory -> AndroidDirectTemporaryStorage.resolve(context)
        is EngineStorage.Directory -> File(storage.path)
        is EngineStorage.ApplicationData -> File(context.filesDir, "Oliphaunt/${storage.name}")
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

internal class AndroidNativeDirectSession(
    private val database: NativeDatabase,
) : OliphauntSession {
    private suspend fun <T> runRequest(block: suspend (dev.oliphaunt.bindings.NativeRequest) -> T): T {
        val request = database.request()
        // A child Job observes cancellation immediately, while the native
        // future remains alive until its confirmed protocol outcome arrives.
        val context = currentCoroutineContext()
        val cancellation = Job(context[OliphauntOperationCancellation]?.caller ?: context[Job])
        val cancellationFailure = AtomicReference<Throwable?>()
        val observer = cancellation.invokeOnCompletion { cause ->
            if (cause != null) runCatching { request.cancel() }.exceptionOrNull()?.let(cancellationFailure::set)
        }
        try {
            val result = withContext(NonCancellable) { block(request) }
            cancellationFailure.get()?.let { throw OliphauntException("native cancellation failed", it) }
            return result
        } catch (_: NativeException.NotSubmitted) {
            throw OliphauntRequestNotSubmitted()
        } catch (error: NativeException.Broker) {
            throw error.toPublicError()
        } catch (error: NativeException.Database) {
            throw OliphauntException(error.detail)
        } finally {
            observer.dispose()
            cancellation.complete()
            request.destroy()
        }
    }

    override suspend fun execProtocolRaw(request: ByteArray): ByteArray = runRequest { it.execute(request) }

    override suspend fun execProtocolRawStream(
        request: ByteArray,
        onChunk: (ByteArray) -> Unit,
    ): ProtocolStreamOutcome {
        val callbackError = AtomicReference<Throwable?>()
        val deliver = onChunk
        return runRequest { operation ->
            try {
                operation.stream(
                    request,
                    object : ChunkSink {
                        override fun onChunk(bytes: ByteArray): Boolean = try {
                            deliver(bytes)
                            true
                        } catch (error: Throwable) {
                            callbackError.set(error)
                            false
                        }
                    },
                )
                ProtocolStreamOutcome.Complete
            } catch (error: NativeException.Callback) {
                // Rust only returns Callback after recovery reaches ReadyForQuery.
                ProtocolStreamOutcome.CallbackAborted(callbackError.get() ?: throw error)
            }
        }
    }

    override suspend fun backup(): ByteArray = runRequest { it.backup() }
    override suspend fun backupToPath(destination: String) {
        val target = File(destination)
        val temporary = File.createTempFile(".oliphaunt-archive-", ".tmp", target.absoluteFile.parentFile)
        try {
            ParcelFileDescriptor.open(temporary, ParcelFileDescriptor.MODE_WRITE_ONLY).use { output ->
                runRequest { it.backupToFd(output.fd) }
                Os.fsync(output.fileDescriptor)
            }
            nativeOperation {
                dev.oliphaunt.bindings.publishBackup(temporary.absolutePath, target.absolutePath)
            }
            OliphauntAndroidRuntimeAssets.syncAndroidDirectory(target.absoluteFile.parentFile!!)
        } finally {
            temporary.delete()
        }
    }
    override suspend fun cancel() = nativeOperation { database.cancel() }
    override suspend fun close() = nativeOperation { database.detach() }
}

internal suspend fun <T> nativeOperation(block: suspend () -> T): T = try {
    block()
} catch (error: NativeException.Broker) {
    throw error.toPublicError()
} catch (error: NativeException.Database) {
    throw OliphauntException(error.detail)
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

internal fun android.content.pm.ApplicationInfo.liboliphauntSourceArchivePaths(): List<String> = buildList {
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
