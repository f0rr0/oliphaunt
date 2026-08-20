@file:OptIn(
    kotlinx.cinterop.ExperimentalForeignApi::class,
    kotlinx.coroutines.DelicateCoroutinesApi::class,
    kotlinx.coroutines.ExperimentalCoroutinesApi::class,
)

package dev.oliphaunt

import cnames.structs.OliphauntKotlinSession
import dev.oliphaunt.native.c.OLIPHAUNT_ABI_VERSION
import dev.oliphaunt.native.c.OliphauntResponse
import dev.oliphaunt.native.c.OliphauntRestoreOptions
import dev.oliphaunt.native.c.oliphaunt_kotlin_backup
import dev.oliphaunt.native.c.oliphaunt_kotlin_cancel
import dev.oliphaunt.native.c.oliphaunt_kotlin_close
import dev.oliphaunt.native.c.oliphaunt_kotlin_exec_protocol
import dev.oliphaunt.native.c.oliphaunt_kotlin_free_response
import dev.oliphaunt.native.c.oliphaunt_kotlin_initialize_root
import dev.oliphaunt.native.c.oliphaunt_kotlin_last_error
import dev.oliphaunt.native.c.oliphaunt_kotlin_open
import dev.oliphaunt.native.c.oliphaunt_kotlin_remove_tree
import dev.oliphaunt.native.c.oliphaunt_kotlin_restore
import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.CPointer
import kotlinx.cinterop.CPointerVar
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.UByteVar
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.allocArray
import kotlinx.cinterop.convert
import kotlinx.cinterop.cstr
import kotlinx.cinterop.get
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.readBytes
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.set
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

internal class NativeDirectEngine(
    private val libraryPath: String? = null,
    private val runtimeDirectory: String? = null,
) : OliphauntEngine {
    override suspend fun open(config: OliphauntConfig): OliphauntSession {
        validateDatabaseStorage(config.storage)
        validateStartupIdentity(config.username, "username")
        validateStartupIdentity(config.database, "database")
        validateStartupGucs(config.startupGucs)
        validateGeneratedExtensionIds(config.extensions, label = "Kotlin native-direct extension id")
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

        val storageDirectory = when (val storage = config.storage) {
            DatabaseStorage.TemporaryDirectory -> temporaryStorageDirectory()
            is DatabaseStorage.Directory -> storage.path
        }
        val pgdata = "$storageDirectory/pgdata"
        ensureDirectory(storageDirectory)
        val effectiveUsername = config.username ?: "postgres"
        val effectiveDatabase = config.database ?: "postgres"
        val ownerDispatcher = newSingleThreadContext("oliphaunt-native-owner")
        val session: CPointer<OliphauntKotlinSession> =
            try {
                withContext(ownerDispatcher) {
                    memScoped {
                        val initializeRc = oliphaunt_kotlin_initialize_root(
                            storageDirectory,
                            resolvedRuntimeDirectory,
                            effectiveUsername,
                        )
                        if (initializeRc != 0) throw OliphauntException(lastError(null))
                        val startupArgs = config.postgresStartupArgs()
                        val startupArgPointers = allocArray<CPointerVar<ByteVar>>(startupArgs.size)
                        startupArgs.forEachIndexed { index, arg ->
                            startupArgPointers[index] = arg.cstr.getPointer(this)
                        }
                        val nativeConfig =
                            alloc<NativeOliphauntConfig> {
                                abi_version = OLIPHAUNT_ABI_VERSION
                                this.pgdata = pgdata.cstr.getPointer(this@memScoped)
                                runtime_dir = resolvedRuntimeDirectory.cstr.getPointer(this@memScoped)
                                module_dir = null
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
                            // Native direct is process-resident and can retain
                            // this directory after rejecting a logical reopen.
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

    override suspend fun restore(destination: String, bytes: ByteArray) {
        validateDirectoryPath(destination, "restore destination")
        val resolvedLibrary = libraryPath ?: env("OLIPHAUNT_KOTLIN_LIBRARY") ?: env("LIBOLIPHAUNT_PATH")
        val rc =
            memScoped {
                bytes.usePinned { pinned ->
                    val options =
                        alloc<OliphauntRestoreOptions> {
                            abi_version = OLIPHAUNT_ABI_VERSION
                            this.destination = destination.cstr.getPointer(this@memScoped)
                            data =
                                if (bytes.isEmpty()) {
                                    null
                                } else {
                                    pinned.addressOf(0).reinterpret()
                                }
                            len = bytes.size.convert()
                        }
                    oliphaunt_kotlin_restore(resolvedLibrary, options.ptr)
                }
            }
        if (rc != 0) {
            throw OliphauntException(lastError(null))
        }
    }
}

private class NativeDirectSession(
    private var session: CPointer<OliphauntKotlinSession>?,
    private val ownerDispatcher: CloseableCoroutineDispatcher,
) : OliphauntSession {
    private val executionMutex = Mutex()
    private val stateMutex = Mutex()
    private var closing = false

    override suspend fun execProtocolRaw(request: ByteArray): ByteArray = withContext(ownerDispatcher) {
        executionMutex.withLock {
            val current = stateMutex.withLock { requireOpenSession() }
            memScoped {
                val response =
                    alloc<OliphauntResponse> {
                        data = null
                        len = 0u
                    }
                val rc =
                    request.usePinned { pinned ->
                        val requestPtr =
                            if (request.isEmpty()) {
                                null
                            } else {
                                pinned.addressOf(0).reinterpret<UByteVar>()
                            }
                        oliphaunt_kotlin_exec_protocol(
                            current,
                            requestPtr,
                            request.size.convert(),
                            response.ptr,
                        )
                    }
                if (rc != 0) {
                    throw OliphauntException(lastError(current))
                }
                try {
                    val responseData = response.data
                    if (responseData == null || response.len == 0uL) {
                        ByteArray(0)
                    } else {
                        responseData.readBytes(response.len.toInt())
                    }
                } finally {
                    oliphaunt_kotlin_free_response(current, response.ptr)
                }
            }
        }
    }

    override suspend fun backup(): ByteArray = withContext(ownerDispatcher) {
        executionMutex.withLock {
            val current = stateMutex.withLock { requireOpenSession() }
            memScoped {
                val response =
                    alloc<OliphauntResponse> {
                        data = null
                        len = 0u
                    }
                val rc =
                    oliphaunt_kotlin_backup(
                        current,
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
                    bytes
                } finally {
                    oliphaunt_kotlin_free_response(current, response.ptr)
                }
            }
        }
    }

    override suspend fun cancel() {
        val (returnCode, current) =
            stateMutex.withLock {
                val current = requireOpenSession()
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
                if (closing) {
                    throw OliphauntException("database close is already in progress")
                }
                closing = true
                current
            }
        val rc =
            try {
                withContext(ownerDispatcher) {
                    executionMutex.withLock {
                        oliphaunt_kotlin_close(current)
                    }
                }
            } catch (error: Throwable) {
                stateMutex.withLock {
                    closing = false
                }
                throw error
            }
        if (rc != 0) {
            val message = lastError(current)
            stateMutex.withLock {
                closing = false
            }
            throw OliphauntException(message)
        }
        stateMutex.withLock {
            session = null
            closing = false
        }
        ownerDispatcher.close()
    }

    private fun requireOpenSession(): CPointer<OliphauntKotlinSession> {
        if (closing) {
            throw OliphauntException("database is closed")
        }
        return session ?: throw OliphauntException("database is closed")
    }
}

private fun lastError(session: CPointer<OliphauntKotlinSession>?): String = oliphaunt_kotlin_last_error(session)?.toKString()?.takeIf(String::isNotEmpty)
    ?: "unknown liboliphaunt Kotlin runtime error"

private fun env(name: String): String? = getenv(name)?.toKString()?.takeIf(String::isNotEmpty)

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

private fun temporaryStorageDirectory(): String = ProcessTemporaryStorageDirectory.path

private object ProcessTemporaryStorageDirectory {
    val path: String by lazy {
        val base = env("TMPDIR") ?: "/tmp"
        "$base/oliphaunt-direct-${getpid()}-${Random.nextInt()}"
    }
}
