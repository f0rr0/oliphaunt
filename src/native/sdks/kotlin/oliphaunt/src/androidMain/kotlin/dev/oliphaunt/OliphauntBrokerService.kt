package dev.oliphaunt

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.Process
import dev.oliphaunt.bindings.BrokerRetirement
import dev.oliphaunt.bindings.NativeBrokerWorker
import dev.oliphaunt.broker.IBroker
import dev.oliphaunt.broker.IBrokerClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import java.util.UUID

/** Manifest-owned entry point. Applications bind through OliphauntBroker. */
public class OliphauntBrokerService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()
    private var owner: IBrokerClient? = null
    private var worker: NativeBrokerWorker? = null
    private var closed = false
    private val ownerDeath = IBinder.DeathRecipient { retireOwnedWorker() }

    override fun onCreate() {
        super.onCreate()
        check(OliphauntBroker.isWorkerProcess(this)) {
            "OliphauntBrokerService must run in its dedicated :oliphaunt process"
        }
    }

    override fun onBind(intent: Intent): IBinder = binder

    private val binder = object : IBroker.Stub() {
        override fun open(
            client: IBrokerClient,
            socket: ParcelFileDescriptor,
            name: String?,
            legacyExists: Boolean,
            restore: Boolean,
            gucNames: Array<String>,
            gucValues: Array<String>,
            username: String?,
            database: String?,
            extensions: Array<String>,
            startupTimeoutMillis: Long,
        ) {
            check(Binder.getCallingUid() == Process.myUid())
            val acquired = synchronized(lock) {
                if (owner != null || closed) {
                    false
                } else {
                    owner = client
                    true
                }
            }
            if (!acquired) {
                socket.close()
                client.failed("DatabaseInUse", "worker process is already owned or retired")
                return
            }
            try {
                client.asBinder().linkToDeath(ownerDeath, 0)
                require(startupTimeoutMillis > 0)
                val native = socket.use {
                    NativeBrokerWorker.create(
                        it.fd,
                        object : BrokerRetirement {
                            override fun retire() {
                                retireProcess()
                            }
                        },
                        startupTimeoutMillis.toULong(),
                    )
                }
                synchronized(lock) {
                    worker = native
                    if (closed) native.close(native.generation())
                }
                scope.launch {
                    try {
                        require(gucNames.size == gucValues.size && gucNames.size <= 1024 && extensions.size <= 1024)
                        require(
                            (gucNames.toList() + gucValues.toList() + extensions.toList() + listOfNotNull(name, username, database))
                                .sumOf { it.length.toLong() * 2 + 8 } <= 64 * 1024,
                        ) { "broker startup configuration exceeds 64 KiB" }
                        if (name != null) validateDatabaseName(name)
                        val root = if (name == null) {
                            File(cacheDir, "oliphaunt-broker-${UUID.randomUUID()}")
                        } else {
                            File(noBackupFilesDir, "Oliphaunt/$name")
                        }
                        if (!root.exists() && legacyExists && !restore) {
                            throw brokerError(
                                BrokerFailureReason.MigrationRequired,
                                "a direct database with this name exists; export, close, and restore it into broker storage",
                            )
                        }
                        val engine = AndroidNativeDirectEngine(this@OliphauntBrokerService)
                        if (restore) {
                            val library = resolveAndroidLiboliphauntLibraryPath(
                                null,
                                applicationInfo.nativeLibraryDir,
                                applicationInfo.liboliphauntSourceArchivePaths(),
                                Build.SUPPORTED_ABIS.asList(),
                            )
                            client.ready(native.generation(), 0, "")
                            native.restore(library, root.absolutePath)
                        } else {
                            val options = engine.prepare(
                                EngineConfig(
                                    storage = EngineStorage.Directory(root.absolutePath),
                                    startupGucs = gucNames.zip(gucValues) { key, value -> PostgresStartupGuc(key, value) },
                                    username = username,
                                    database = database,
                                    extensions = extensions.toList(),
                                ),
                            )
                            val ready = native.open(options)
                            client.ready(ready.generation, ready.abi.toInt(), ready.runtimeVersion)
                            native.serve()
                        }
                    } catch (error: Throwable) {
                        runCatching {
                            client.failed(
                                (error as? OliphauntBrokerException)?.reason?.name ?: "Database",
                                (error.message ?: "broker initialization failed").take(1024),
                            )
                        }
                        native.retire()
                    }
                }
            } catch (error: Throwable) {
                runCatching { socket.close() }
                runCatching { client.failed("Database", (error.message ?: "broker initialization failed").take(1024)) }
                retireProcess()
            }
        }

        override fun cancel(client: IBrokerClient, generation: ByteArray, request: Long) {
            synchronized(lock) {
                if (owner?.asBinder() == client.asBinder() && request > 0) {
                    worker?.cancelRequest(generation, request.toULong())
                }
            }
        }

        override fun close(client: IBrokerClient, generation: ByteArray?) {
            synchronized(lock) {
                if (owner?.asBinder() != client.asBinder()) return
                closed = true
                worker?.let { it.close(generation ?: it.generation()) }
            }
        }
    }

    private fun retireOwnedWorker() {
        synchronized(lock) {
            closed = true
            worker?.let { it.close(it.generation()) }
        }
    }

    private fun retireProcess() {
        // This entry point checked the dedicated process before installing the
        // callback. Host code cannot invoke native process retirement.
        synchronized(lock) { closed = true }
        Process.killProcess(Process.myPid())
    }

    override fun onUnbind(intent: Intent): Boolean {
        retireOwnedWorker()
        return false
    }

    override fun onDestroy() {
        retireOwnedWorker()
        scope.cancel()
        super.onDestroy()
    }
}
