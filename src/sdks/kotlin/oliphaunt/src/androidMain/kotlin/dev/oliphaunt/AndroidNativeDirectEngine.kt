package dev.oliphaunt

import android.content.Context
import android.os.Build
import android.os.Process
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import java.io.File
import java.io.FileOutputStream
import java.lang.ref.PhantomReference
import java.lang.ref.ReferenceQueue
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import java.util.zip.ZipFile
import kotlin.coroutines.suspendCoroutine

private const val OWNER_READ_WRITE_MODE = 384 // 0600

internal class AndroidNativeDirectEngine(
    context: Context,
    private val libraryPath: String? = null,
    private val runtimeDirectory: String? = null,
    private val resourceRoot: File? = null,
) : OliphauntEngine {
    private val appContext = context.applicationContext

    override suspend fun open(config: EngineConfig): OliphauntSession {
        val executionDispatcher =
            newAndroidNativeOwnerDispatcher("oliphaunt-android-direct")
        return try {
            runOnAndroidNativeOwner(executionDispatcher) {
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
                val storageDirectory =
                    when (val storage = config.storage) {
                        EngineStorage.TemporaryDirectory -> AndroidDirectTemporaryStorage.resolve(appContext)
                        is EngineStorage.Directory -> File(storage.path)
                    }
                var nativeOpenAttempted = false
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
                            var ownsPublishedPgdata = false
                            try {
                                OliphauntAndroidRuntimeAssets.preparePgdata(
                                    assetManager = appContext.assets,
                                    pgdata = pgdata,
                                    clusterSeed = runtime.clusterSeed,
                                    didPublishDestination = { ownsPublishedPgdata = true },
                                )
                                validateCompleteAndroidPgdata(pgdata)
                                writeAndroidManagedRootDescriptor(storageDirectory)
                            } catch (publicationError: Throwable) {
                                recoverAndroidManagedRootPublicationFailure(
                                    publicationError = publicationError,
                                    ownsPublishedPgdata = ownsPublishedPgdata,
                                    descriptorDefinitelyAbsent = {
                                        isAndroidPathDefinitelyAbsent(
                                            File(storageDirectory, ".oliphaunt.json"),
                                        )
                                    },
                                    removePublishedPgdata = {
                                        if (
                                            !isAndroidPathDefinitelyAbsent(pgdata) &&
                                            !pgdata.deleteRecursively()
                                        ) {
                                            throw OliphauntException(
                                                "failed to remove uncommitted PGDATA at ${pgdata.absolutePath}",
                                            )
                                        }
                                    },
                                    syncRoot = {
                                        OliphauntAndroidRuntimeAssets.syncAndroidDirectory(storageDirectory)
                                    },
                                )
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
                    nativeOpenAttempted = true
                    val nativeHandle =
                        OliphauntAndroidNativeBridge.openNative(
                            effectiveLibraryPath,
                            pgdata.absolutePath,
                            runtime.runtimeDirectory,
                            effectiveUsername,
                            effectiveDatabase,
                            config.postgresStartupArgs(runtime.sharedPreloadLibraries).toTypedArray(),
                        )
                    AndroidNativeDirectSession(
                        nativeHandle = nativeHandle,
                        executionDispatcher = executionDispatcher,
                    )
                } catch (error: Throwable) {
                    executionDispatcher.close()
                    // Preparation failures are safe to clean. Once control reaches the
                    // process-resident runtime, a rejected logical reopen may leave it
                    // owning the same directory.
                    if (config.storage == EngineStorage.TemporaryDirectory && !nativeOpenAttempted) {
                        storageDirectory.deleteRecursively()
                    }
                    throw error
                }
            }
        } catch (error: Throwable) {
            executionDispatcher.close()
            throw error
        }
    }

    override suspend fun restore(
        destination: String,
        bytes: ByteArray,
    ) {
        val owner = newAndroidNativeOwnerDispatcher("oliphaunt-android-direct-restore")
        runOnAndroidNativeOwner(owner) {
            try {
                validateDirectoryPath(destination, "restore destination")
                OliphauntAndroidNativeBridge.restoreNative(
                    destination = destination,
                    bytes = bytes,
                    libraryPath =
                    resolveAndroidLiboliphauntLibraryPath(
                        explicitLibraryPath = libraryPath,
                        nativeLibraryDirectory = appContext.applicationInfo.nativeLibraryDir,
                        sourceArchivePaths = appContext.applicationInfo.liboliphauntSourceArchivePaths(),
                        supportedAbis = Build.SUPPORTED_ABIS.asList(),
                    ),
                )
            } finally {
                owner.close()
            }
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

internal fun recoverAndroidManagedRootPublicationFailure(
    publicationError: Throwable,
    ownsPublishedPgdata: Boolean,
    descriptorDefinitelyAbsent: () -> Boolean,
    removePublishedPgdata: () -> Unit,
    syncRoot: () -> Unit,
): Nothing {
    if (!ownsPublishedPgdata) throw publicationError
    val descriptorIsAbsent =
        try {
            descriptorDefinitelyAbsent()
        } catch (inspectionError: Throwable) {
            throw OliphauntException(
                "database root descriptor publication failed (${publicationError.message}); " +
                    "preserved PGDATA because descriptor publication is uncertain (${inspectionError.message})",
            ).apply {
                addSuppressed(publicationError)
                addSuppressed(inspectionError)
            }
        }
    if (!descriptorIsAbsent) throw publicationError
    try {
        removePublishedPgdata()
        syncRoot()
    } catch (cleanupError: Throwable) {
        throw OliphauntException(
            "database root descriptor publication failed (${publicationError.message}); " +
                "failed to clean uncommitted PGDATA (${cleanupError.message})",
        ).apply {
            addSuppressed(publicationError)
            addSuppressed(cleanupError)
        }
    }
    throw publicationError
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

internal fun newAndroidNativeOwnerDispatcher(name: String): ExecutorCoroutineDispatcher = Executors
    .newSingleThreadExecutor { runnable ->
        Thread(runnable, name).apply { isDaemon = true }
    }.asCoroutineDispatcher()

/**
 * Dispatches work without linking native ownership to caller cancellation.
 * Once admitted, a native operation reaches a definite result before its
 * continuation resumes, so handle transitions are never half-applied.
 */
internal suspend fun <T> runOnAndroidNativeOwner(
    dispatcher: ExecutorCoroutineDispatcher,
    operation: () -> T,
): T = suspendCoroutine { continuation ->
    val task = Runnable { continuation.resumeWith(runCatching(operation)) }
    try {
        dispatcher.executor.execute(task)
    } catch (error: Throwable) {
        continuation.resumeWith(Result.failure(error))
    }
}

internal fun interface AndroidNativeCleanable {
    fun clean()
}

/**
 * Android's supported API floor predates `java.lang.ref.Cleaner`. This small
 * phantom-reference registry provides the same one-shot reachability signal
 * without finalizers. Cleanup actions must only enqueue work: its daemon must
 * never perform a blocking native close itself.
 */
internal object AndroidNativeCleaner {
    private val queue = ReferenceQueue<Any>()
    private val references = ConcurrentHashMap<CleanupReference, Unit>()

    init {
        Thread(
            cleanerLoop@{
                while (true) {
                    try {
                        (queue.remove() as CleanupReference).clean()
                    } catch (_: InterruptedException) {
                        Thread.currentThread().interrupt()
                        return@cleanerLoop
                    } catch (_: Throwable) {
                        // Best-effort forgotten-handle cleanup must not stop
                        // cleanup for later unreachable sessions.
                    }
                }
            },
            "oliphaunt-android-cleaner",
        ).apply {
            isDaemon = true
            start()
        }
    }

    fun register(
        owner: Any,
        cleanup: () -> Unit,
    ): AndroidNativeCleanable = CleanupReference(owner, cleanup).also { references[it] = Unit }

    private class CleanupReference(
        owner: Any,
        cleanup: () -> Unit,
    ) : PhantomReference<Any>(owner, queue),
        AndroidNativeCleanable {
        private val claimed = AtomicBoolean()
        private var cleanup: (() -> Unit)? = cleanup

        override fun clean() {
            if (!claimed.compareAndSet(false, true)) return
            references.remove(this)
            clear()
            val action = cleanup
            cleanup = null
            action?.invoke()
        }
    }
}

private object AndroidNativeCleanerFallbackOwner {
    private val executor =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "oliphaunt-android-cleaner-fallback").apply { isDaemon = true }
        }

    fun execute(task: Runnable) {
        executor.execute(task)
    }
}

private class AndroidNativeDirectSession(
    nativeHandle: Long,
    executionDispatcher: ExecutorCoroutineDispatcher,
) : OliphauntSession {
    private val cancellationDispatcher =
        newAndroidNativeOwnerDispatcher("oliphaunt-android-direct-cancel")
    private val state =
        AndroidNativeSessionState(
            nativeHandle = nativeHandle,
            executionDispatcher = executionDispatcher,
            cancellationDispatcher = cancellationDispatcher,
            closeNative = OliphauntAndroidNativeBridge::closeNative,
        )
    private val cleanable = AndroidNativeCleaner.register(this, state::scheduleForgottenClose)

    override suspend fun execProtocolRaw(request: ByteArray): ByteArray = state.runOnExecutionOwner { current ->
        OliphauntAndroidNativeBridge.execProtocolRawNative(current, request)
    }

    override suspend fun execProtocolRawStream(
        request: ByteArray,
        onChunk: (ByteArray) -> Unit,
    ): ProtocolStreamOutcome = state.runOnExecutionOwner { current ->
        var callbackError: Throwable? = null
        val callbackAborted =
            OliphauntAndroidNativeBridge.execProtocolRawStreamNative(
                current,
                request,
                OliphauntAndroidProtocolStreamSink { chunk ->
                    try {
                        onChunk(chunk)
                        0
                    } catch (error: Throwable) {
                        callbackError = error
                        -1
                    }
                },
            )
        when {
            !callbackAborted && callbackError == null -> ProtocolStreamOutcome.Complete

            callbackAborted && callbackError != null ->
                ProtocolStreamOutcome.CallbackAborted(requireNotNull(callbackError))

            callbackAborted ->
                throw OliphauntException(
                    "liboliphaunt reported a recovered callback abort without a callback failure",
                )

            else ->
                throw OliphauntException(
                    "liboliphaunt returned protocol stream success after the callback failed",
                )
        }
    }

    override suspend fun backup(): ByteArray = state.runOnExecutionOwner { current ->
        OliphauntAndroidNativeBridge.backupNative(current)
    }

    override suspend fun cancel() {
        state.runOnCancellationOwner { current ->
            OliphauntAndroidNativeBridge.cancelNative(current)
        }
    }

    override suspend fun close() {
        state.close()
        cleanable.clean()
    }
}

internal class AndroidNativeSessionState(
    nativeHandle: Long,
    private val executionDispatcher: ExecutorCoroutineDispatcher,
    private val cancellationDispatcher: ExecutorCoroutineDispatcher,
    private val closeNative: (Long) -> Unit,
) {
    private val lock = ReentrantLock()
    private val noActiveCalls = lock.newCondition()
    private var handle: Long = nativeHandle
    private var closing = false
    private var closed = false
    private var activeCalls = 0
    private val forgottenCloseScheduled = AtomicBoolean()

    suspend fun <T> runOnExecutionOwner(operation: (Long) -> T): T = runOnAndroidNativeOwner(executionDispatcher) {
        val current = beginCall()
        try {
            operation(current)
        } finally {
            endCall()
        }
    }

    suspend fun <T> runOnCancellationOwner(operation: (Long) -> T): T = runOnAndroidNativeOwner(cancellationDispatcher) {
        val current = beginCall()
        try {
            operation(current)
        } finally {
            endCall()
        }
    }

    suspend fun close() {
        runOnAndroidNativeOwner(executionDispatcher) {
            val current = beginClose() ?: return@runOnAndroidNativeOwner
            try {
                closeNative(current)
                finishClose(detached = true)
                cancellationDispatcher.close()
                executionDispatcher.close()
            } catch (error: Throwable) {
                finishClose(detached = false)
                throw error
            }
        }
    }

    /** Schedules best-effort close behind every operation already on the owner. */
    fun scheduleForgottenClose() {
        if (!forgottenCloseScheduled.compareAndSet(false, true)) return
        val task = Runnable { closeForgottenBestEffort() }
        try {
            executionDispatcher.executor.execute(task)
        } catch (_: Throwable) {
            if (!isClosed()) AndroidNativeCleanerFallbackOwner.execute(task)
        }
    }

    private fun closeForgottenBestEffort() {
        try {
            val current = beginClose() ?: return
            try {
                closeNative(current)
                finishClose(detached = true)
            } catch (_: Throwable) {
                finishClose(detached = false)
            }
        } finally {
            cancellationDispatcher.close()
            executionDispatcher.close()
        }
    }

    private fun isClosed(): Boolean {
        lock.lock()
        return try {
            closed || handle == 0L
        } finally {
            lock.unlock()
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
