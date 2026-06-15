@file:OptIn(
    kotlinx.cinterop.ExperimentalForeignApi::class,
    kotlinx.coroutines.DelicateCoroutinesApi::class,
    kotlinx.coroutines.ExperimentalCoroutinesApi::class,
)

package dev.oliphaunt

import cnames.structs.OliphauntKotlinSession
import dev.oliphaunt.native.c.OLIPHAUNT_ABI_VERSION
import dev.oliphaunt.native.c.OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE
import dev.oliphaunt.native.c.OLIPHAUNT_CAP_BACKUP_RESTORE
import dev.oliphaunt.native.c.OLIPHAUNT_CAP_EXTENSIONS
import dev.oliphaunt.native.c.OLIPHAUNT_CAP_LOGICAL_REOPEN
import dev.oliphaunt.native.c.OLIPHAUNT_CAP_MULTI_INSTANCE
import dev.oliphaunt.native.c.OLIPHAUNT_CAP_PROTOCOL_RAW
import dev.oliphaunt.native.c.OLIPHAUNT_CAP_PROTOCOL_STREAM
import dev.oliphaunt.native.c.OLIPHAUNT_CAP_QUERY_CANCEL
import dev.oliphaunt.native.c.OLIPHAUNT_CAP_SIMPLE_QUERY
import dev.oliphaunt.native.c.OLIPHAUNT_RESTORE_REPLACE_EXISTING
import dev.oliphaunt.native.c.OliphauntResponse
import dev.oliphaunt.native.c.OliphauntRestoreOptions
import dev.oliphaunt.native.c.oliphaunt_kotlin_backup
import dev.oliphaunt.native.c.oliphaunt_kotlin_cancel
import dev.oliphaunt.native.c.oliphaunt_kotlin_capabilities
import dev.oliphaunt.native.c.oliphaunt_kotlin_close
import dev.oliphaunt.native.c.oliphaunt_kotlin_exec_protocol
import dev.oliphaunt.native.c.oliphaunt_kotlin_exec_protocol_stream
import dev.oliphaunt.native.c.oliphaunt_kotlin_free_response
import dev.oliphaunt.native.c.oliphaunt_kotlin_last_error
import dev.oliphaunt.native.c.oliphaunt_kotlin_open
import dev.oliphaunt.native.c.oliphaunt_kotlin_remove_tree
import dev.oliphaunt.native.c.oliphaunt_kotlin_restore
import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.COpaquePointer
import kotlinx.cinterop.CPointer
import kotlinx.cinterop.CPointerVar
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.StableRef
import kotlinx.cinterop.UByteVar
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.allocArray
import kotlinx.cinterop.asStableRef
import kotlinx.cinterop.convert
import kotlinx.cinterop.cstr
import kotlinx.cinterop.get
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.readBytes
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.set
import kotlinx.cinterop.staticCFunction
import kotlinx.cinterop.toKString
import kotlinx.cinterop.usePinned
import kotlinx.coroutines.CloseableCoroutineDispatcher
import kotlinx.coroutines.newSingleThreadContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import platform.posix.getenv
import platform.posix.getpid
import platform.posix.mkdir
import kotlin.random.Random
import dev.oliphaunt.native.c.OliphauntConfig as NativeOliphauntConfig

public class NativeDirectEngine(
    private val libraryPath: String? = null,
    private val runtimeDirectory: String? = null,
    private val username: String = "postgres",
    private val database: String = "postgres",
) : OliphauntEngine {
    override fun supportedModes(): List<EngineModeSupport> = OliphauntRuntimeSupport.nativeDirectOnly(
        brokerReason = "Kotlin/Native broker mode requires a platform broker adapter; it is not aliased to direct mode",
        serverReason = "Kotlin/Native server mode requires a platform server adapter; it is not aliased to direct mode",
    )

    override suspend fun open(config: OliphauntConfig): OliphauntSession {
        if (config.mode != EngineMode.NativeDirect) {
            throw OliphauntException("NativeDirectEngine supports NativeDirect, got ${config.mode}")
        }
        validateRootPath(config.root, "database root")
        validateStartupIdentity(config.username ?: username, "username")
        validateStartupIdentity(config.database ?: database, "database")
        validateStartupGucs(config.startupGucs)
        validateExtensionIds(config.extensions)
        val resolvedRuntimeDirectory =
            runtimeDirectory
                ?: env("OLIPHAUNT_INSTALL_DIR")
                ?: env("OLIPHAUNT_RUNTIME_DIR")
                ?: ""
        if (config.extensions.isNotEmpty() && resolvedRuntimeDirectory.isEmpty()) {
            throw OliphauntException(
                "Kotlin native-direct extensions require runtimeDirectory pointing at a liboliphaunt runtime built with the selected extensions",
            )
        }

        val root = config.root ?: temporaryRoot()
        val pgdata = "$root/pgdata"
        ensureDirectory(root)
        ensureDirectory(pgdata)
        val ownerDispatcher = newSingleThreadContext("oliphaunt-native-owner")
        val session: CPointer<OliphauntKotlinSession> =
            try {
                withContext(ownerDispatcher) {
                    memScoped {
                        val startupArgs = config.postgresStartupArgs()
                        val effectiveUsername = config.username ?: username
                        val effectiveDatabase = config.database ?: database
                        val startupArgPointers = allocArray<CPointerVar<ByteVar>>(startupArgs.size)
                        startupArgs.forEachIndexed { index, arg ->
                            startupArgPointers[index] = arg.cstr.getPointer(this)
                        }
                        val nativeConfig =
                            alloc<NativeOliphauntConfig> {
                                abi_version = OLIPHAUNT_ABI_VERSION
                                this.pgdata = pgdata.cstr.getPointer(this@memScoped)
                                runtime_dir = resolvedRuntimeDirectory.cstr.getPointer(this@memScoped)
                                this.username = effectiveUsername.cstr.getPointer(this@memScoped)
                                database = effectiveDatabase.cstr.getPointer(this@memScoped)
                                reserved_flags = 0u
                                startup_args = startupArgPointers
                                startup_arg_count = startupArgs.size.convert()
                            }
                        val resolvedLibrary = libraryPath ?: env("OLIPHAUNT_KOTLIN_LIBRARY") ?: env("LIBOLIPHAUNT_PATH")
                        oliphaunt_kotlin_open(
                            resolvedLibrary,
                            nativeConfig.ptr,
                        ) ?: run {
                            if (config.root == null) {
                                removeDirectoryBestEffort(root)
                            }
                            throw OliphauntException(lastError(null))
                        }
                    }
                }
            } catch (error: Throwable) {
                ownerDispatcher.close()
                throw error
            }
        return NativeDirectSession(
            session = session,
            ownerDispatcher = ownerDispatcher,
        )
    }

    override suspend fun restore(request: RestoreRequest): String {
        validateRootPath(request.root, "restore root")
        if (request.artifact.format != BackupFormat.PhysicalArchive) {
            throw OliphauntException("Kotlin native restore currently requires PhysicalArchive, got ${request.artifact.format}")
        }
        val resolvedLibrary = libraryPath ?: env("OLIPHAUNT_KOTLIN_LIBRARY") ?: env("LIBOLIPHAUNT_PATH")
        val flags =
            if (request.targetPolicy == RestoreTargetPolicy.ReplaceExisting) {
                OLIPHAUNT_RESTORE_REPLACE_EXISTING
            } else {
                0uL
            }
        val rc =
            memScoped {
                request.artifact.bytes.usePinned { pinned ->
                    val options =
                        alloc<OliphauntRestoreOptions> {
                            abi_version = OLIPHAUNT_ABI_VERSION
                            root = request.root.cstr.getPointer(this@memScoped)
                            format = OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE
                            data =
                                if (request.artifact.bytes.isEmpty()) {
                                    null
                                } else {
                                    pinned.addressOf(0).reinterpret()
                                }
                            len =
                                request.artifact.bytes.size
                                    .convert()
                            this.flags = flags
                        }
                    oliphaunt_kotlin_restore(resolvedLibrary, options.ptr)
                }
            }
        if (rc != 0) {
            throw OliphauntException(lastError(null))
        }
        return request.root
    }
}

private class NativeDirectSession(
    private var session: CPointer<OliphauntKotlinSession>?,
    private val ownerDispatcher: CloseableCoroutineDispatcher,
) : OliphauntSession {
    private val executionMutex = Mutex()
    private val stateMutex = Mutex()

    override suspend fun capabilities(): EngineCapabilities {
        val flags =
            withContext(ownerDispatcher) {
                executionMutex.withLock {
                    val current = stateMutex.withLock { session ?: throw OliphauntException("database is closed") }
                    oliphaunt_kotlin_capabilities(current)
                }
            }
        return nativeDirectCapabilities(flags)
    }

    override suspend fun execProtocolRaw(request: ProtocolRequest): ProtocolResponse = withContext(ownerDispatcher) {
        executionMutex.withLock {
            val current = stateMutex.withLock { session ?: throw OliphauntException("database is closed") }
            memScoped {
                val response =
                    alloc<OliphauntResponse> {
                        data = null
                        len = 0u
                    }
                val rc =
                    request.bytes.usePinned { pinned ->
                        val requestPtr =
                            if (request.bytes.isEmpty()) {
                                null
                            } else {
                                pinned.addressOf(0).reinterpret<UByteVar>()
                            }
                        oliphaunt_kotlin_exec_protocol(
                            current,
                            requestPtr,
                            request.bytes.size.convert(),
                            response.ptr,
                        )
                    }
                if (rc != 0) {
                    throw OliphauntException(lastError(current))
                }
                try {
                    val responseData = response.data
                    if (responseData == null || response.len == 0uL) {
                        ProtocolResponse(ByteArray(0))
                    } else {
                        ProtocolResponse(responseData.readBytes(response.len.toInt()))
                    }
                } finally {
                    oliphaunt_kotlin_free_response(current, response.ptr)
                }
            }
        }
    }

    override suspend fun execProtocolStream(
        request: ProtocolRequest,
        onChunk: (ProtocolResponse) -> Unit,
    ) {
        withContext(ownerDispatcher) {
            executionMutex.withLock {
                val current = stateMutex.withLock { session ?: throw OliphauntException("database is closed") }
                val callbackBox = NativeStreamCallbackBox(onChunk)
                val stableRef = StableRef.create(callbackBox)
                try {
                    val rc =
                        request.bytes.usePinned { pinned ->
                            val requestPtr =
                                if (request.bytes.isEmpty()) {
                                    null
                                } else {
                                    pinned.addressOf(0).reinterpret<UByteVar>()
                                }
                            oliphaunt_kotlin_exec_protocol_stream(
                                current,
                                requestPtr,
                                request.bytes.size.convert(),
                                nativeStreamCallback,
                                stableRef.asCPointer(),
                            )
                        }
                    callbackBox.error?.let { throw it }
                    if (rc != 0) {
                        throw OliphauntException(lastError(current))
                    }
                } finally {
                    stableRef.dispose()
                }
            }
        }
    }

    override suspend fun backup(request: BackupRequest): BackupArtifact {
        if (request.format != BackupFormat.PhysicalArchive) {
            throw OliphauntException("Kotlin native-direct backup currently supports PhysicalArchive, got ${request.format}")
        }
        return withContext(ownerDispatcher) {
            executionMutex.withLock {
                val current = stateMutex.withLock { session ?: throw OliphauntException("database is closed") }
                memScoped {
                    val response =
                        alloc<OliphauntResponse> {
                            data = null
                            len = 0u
                        }
                    val rc =
                        oliphaunt_kotlin_backup(
                            current,
                            OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE,
                            response.ptr,
                        )
                    if (rc != 0) {
                        throw OliphauntException(lastError(current))
                    }
                    try {
                        val responseData = response.data
                        val bytes =
                            if (responseData == null || response.len == 0uL) {
                                ByteArray(0)
                            } else {
                                responseData.readBytes(response.len.toInt())
                            }
                        BackupArtifact(BackupFormat.PhysicalArchive, bytes)
                    } finally {
                        oliphaunt_kotlin_free_response(current, response.ptr)
                    }
                }
            }
        }
    }

    override suspend fun cancel() {
        val (returnCode, current) =
            stateMutex.withLock {
                val current = session ?: throw OliphauntException("database is closed")
                oliphaunt_kotlin_cancel(current) to current
            }
        if (returnCode != 0) {
            throw OliphauntException(lastError(current))
        }
    }

    override suspend fun close() {
        val current =
            stateMutex.withLock {
                val current = session ?: return
                session = null
                current
            }
        val rc =
            try {
                withContext(ownerDispatcher) {
                    executionMutex.withLock {
                        oliphaunt_kotlin_close(current)
                    }
                }
            } finally {
                ownerDispatcher.close()
            }
        if (rc != 0) {
            throw OliphauntException(lastError(null))
        }
    }
}

private class NativeStreamCallbackBox(
    val onChunk: (ProtocolResponse) -> Unit,
) {
    var error: Throwable? = null
}

private val nativeStreamCallback =
    staticCFunction {
            context: COpaquePointer?,
            data: CPointer<UByteVar>?,
            len: ULong,
        ->
        val callbackBox = context?.asStableRef<NativeStreamCallbackBox>()?.get() ?: return@staticCFunction -1
        try {
            val bytes =
                if (data == null || len == 0uL) {
                    ByteArray(0)
                } else {
                    data.reinterpret<ByteVar>().readBytes(len.toInt())
                }
            callbackBox.onChunk(ProtocolResponse(bytes))
            0
        } catch (error: Throwable) {
            callbackBox.error = error
            -1
        }
    }

private fun nativeDirectCapabilities(flags: ULong): EngineCapabilities = EngineCapabilities(
    mode = EngineMode.NativeDirect,
    processIsolated = false,
    independentSessions = false,
    maxClientSessions = 1,
    multiRoot = flags and OLIPHAUNT_CAP_MULTI_INSTANCE != 0uL,
    reopenable = flags and OLIPHAUNT_CAP_LOGICAL_REOPEN != 0uL,
    sameRootLogicalReopen = flags and OLIPHAUNT_CAP_LOGICAL_REOPEN != 0uL,
    rootSwitchable = false,
    crashRestartable = false,
    protocolRaw = flags and OLIPHAUNT_CAP_PROTOCOL_RAW != 0uL,
    protocolStream = flags and OLIPHAUNT_CAP_PROTOCOL_STREAM != 0uL,
    queryCancel = flags and OLIPHAUNT_CAP_QUERY_CANCEL != 0uL,
    backupRestore = flags and OLIPHAUNT_CAP_BACKUP_RESTORE != 0uL,
    backupFormats = listOf(BackupFormat.PhysicalArchive),
    restoreFormats = listOf(BackupFormat.PhysicalArchive),
    simpleQuery = flags and OLIPHAUNT_CAP_SIMPLE_QUERY != 0uL,
    extensions = flags and OLIPHAUNT_CAP_EXTENSIONS != 0uL,
)

private fun lastError(session: CPointer<OliphauntKotlinSession>?): String = oliphaunt_kotlin_last_error(session)?.toKString()?.takeIf(String::isNotEmpty)
    ?: "unknown liboliphaunt Kotlin runtime error"

private fun env(name: String): String? = getenv(name)?.toKString()?.takeIf(String::isNotEmpty)

private fun validateExtensionIds(extensions: List<String>) {
    extensions
        .map(String::trim)
        .filter(String::isNotEmpty)
        .forEach { extension ->
            val valid =
                extension.length <= 128 &&
                    extension.all { char ->
                        char in 'A'..'Z' ||
                            char in 'a'..'z' ||
                            char in '0'..'9' ||
                            char == '.' ||
                            char == '_' ||
                            char == '-'
                    }
            if (!valid) {
                throw OliphauntException(
                    "Kotlin native-direct extension id '$extension' must contain only ASCII letters, digits, '.', '_' or '-'",
                )
            }
        }
}

private fun ensureDirectory(path: String) {
    val parts = path.split('/').filter(String::isNotEmpty)
    var current = if (path.startsWith('/')) "/" else ""
    for (part in parts) {
        current =
            when {
                current.isEmpty() -> part
                current == "/" -> "/$part"
                else -> "$current/$part"
            }
        mkdir(current, 0x1C0u)
    }
}

private fun temporaryRoot(): String = ProcessTemporaryRoot.path

private object ProcessTemporaryRoot {
    val path: String by lazy {
        val base = env("TMPDIR") ?: "/tmp"
        "$base/oliphaunt-direct-${getpid()}-${Random.nextInt()}"
    }
}

private fun removeDirectoryBestEffort(path: String) {
    oliphaunt_kotlin_remove_tree(path)
}
