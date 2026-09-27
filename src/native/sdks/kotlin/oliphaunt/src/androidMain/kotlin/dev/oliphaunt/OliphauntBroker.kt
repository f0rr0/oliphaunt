package dev.oliphaunt

import android.app.ActivityManager
import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.Process
import android.os.SystemClock
import dev.oliphaunt.bindings.BrokerControl
import dev.oliphaunt.bindings.NativeDatabase
import dev.oliphaunt.broker.IBroker
import dev.oliphaunt.broker.IBrokerClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean

public data class OliphauntBrokerOptions(
    val startupTimeoutMillis: Long = 30_000,
    val operationTimeoutMillis: Long? = null,
) {
    init {
        require(startupTimeoutMillis in 1..Long.MAX_VALUE / 2)
        require(operationTimeoutMillis == null || operationTimeoutMillis in 1..Long.MAX_VALUE / 2)
    }
}

/** One app-owned handle. Recovery is an explicit new open after closing it. */
public object OliphauntBroker {
    private val owned = AtomicBoolean()

    /** Use this in Application.onCreate before initializing unrelated frameworks. */
    public fun isWorkerProcess(context: Context): Boolean {
        val name = if (Build.VERSION.SDK_INT >= 28) {
            Application.getProcessName()
        } else {
            (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager)
                .runningAppProcesses?.firstOrNull { it.pid == Process.myPid() }?.processName
        }
        return name == "${context.packageName}:oliphaunt"
    }

    public suspend fun open(
        context: Context,
        config: OliphauntConfig = OliphauntConfig(),
        options: OliphauntBrokerOptions = OliphauntBrokerOptions(),
    ): OliphauntDatabase {
        validateBrokerConfig(config)
        return OliphauntDatabase.open(
            config.toEngineConfig(),
            object : OliphauntEngine {
                override suspend fun open(config: EngineConfig): OliphauntSession {
                    val binding = acquire(context, config, options, restore = false)
                    try {
                        val database = withContext(NonCancellable) {
                            NativeDatabase.connectBroker(
                                binding.socket.fd,
                                binding.generation,
                                binding,
                                options.operationTimeoutMillis?.toULong(),
                            )
                        }
                        binding.attach(database)
                        currentCoroutineContext().ensureActive()
                        val session = AndroidNativeDirectSession(database)
                        if (!database.brokerIsUsable()) throw brokerError(BrokerFailureReason.WorkerInterrupted, "worker exited during startup")
                        return object : OliphauntSession by session {
                            override val operationTimeoutMillis: Long? = options.operationTimeoutMillis
                            override fun operationTimeMillis(): Long = SystemClock.elapsedRealtime()
                            override fun beginOperation(remainingMillis: Long?) {
                                database.brokerOperationBudget(remainingMillis?.toULong())
                            }
                            override fun isUsable(): Boolean = database.brokerIsUsable()
                            override fun beginClose() {
                                database.brokerBeginClose()
                            }
                            override suspend fun close() {
                                try {
                                    session.close()
                                } finally {
                                    binding.close()
                                }
                            }
                        }
                    } catch (error: Throwable) {
                        binding.close()
                        throw if (error is dev.oliphaunt.bindings.NativeException.Broker) error.toPublicError() else error
                    }
                }
                override suspend fun restore(destination: String, bytes: ByteArray): Unit = error("use OliphauntBroker.restore")
            },
        )
    }

    public suspend fun restore(
        context: Context,
        storage: DatabaseStorage,
        source: File,
        options: OliphauntBrokerOptions = OliphauntBrokerOptions(),
    ) {
        val config = OliphauntConfig(storage = storage)
        validateBrokerConfig(config)
        ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY).use { input ->
            val binding = acquire(context, config.toEngineConfig(), options, restore = true)
            try {
                nativeOperation {
                    dev.oliphaunt.bindings.brokerRestore(
                        binding.socket.fd,
                        binding.generation,
                        binding,
                        options.operationTimeoutMillis?.toULong(),
                        input.fd,
                    )
                }
            } finally {
                binding.close()
            }
        }
    }

    private fun validateBrokerConfig(config: OliphauntConfig) {
        require(config.storage !is DatabaseStorage.Directory) {
            "broker storage must be ApplicationData(name) or TemporaryDirectory"
        }
        validateDatabaseStorage(config.toEngineConfig().storage)
        validateStartupGucs(config.startupGucs)
        validateStartupIdentity(config.username, "username")
        validateStartupIdentity(config.database, "database")
        validateGeneratedExtensionIds(config.extensions.map { it.sqlName })
        val strings = config.startupGucs.flatMap { listOf(it.name, it.value) } +
            config.extensions.map { it.sqlName } + listOfNotNull(config.username, config.database)
        require(
            config.startupGucs.size <= 1024 && config.extensions.size <= 1024 &&
                strings.sumOf { it.length.toLong() * 2 + 8 } <= 64 * 1024,
        ) { "broker startup configuration exceeds 64 KiB" }
    }

    private suspend fun acquire(
        context: Context,
        config: EngineConfig,
        options: OliphauntBrokerOptions,
        restore: Boolean,
    ): BrokerBinding {
        if (!owned.compareAndSet(false, true)) {
            throw brokerError(BrokerFailureReason.DatabaseInUse, "one broker handle is already open in this application")
        }
        val binding = try {
            BrokerBinding(context.applicationContext) { owned.set(false) }
        } catch (error: Throwable) {
            owned.set(false)
            throw error
        }
        try {
            binding.open(config, options, restore)
            return binding
        } catch (error: Throwable) {
            binding.close()
            throw error
        }
    }
}

private class BrokerBinding(
    private val context: Context,
    private val release: () -> Unit,
) : ServiceConnection,
    BrokerControl {
    private val pair = ParcelFileDescriptor.createSocketPair()
    val socket: ParcelFileDescriptor get() = pair[0]
    lateinit var generation: ByteArray
        private set
    private val connected = CompletableDeferred<IBroker>()
    private val ready = CompletableDeferred<ByteArray>()
    private val closed = AtomicBoolean()
    private val dead = AtomicBoolean()
    private var bound = false

    @Volatile private var service: IBroker? = null

    @Volatile private var database = WeakReference<NativeDatabase>(null)
    private var restoring = false
    private val death = IBinder.DeathRecipient { interrupted() }
    private val client = object : IBrokerClient.Stub() {
        override fun ready(generation: ByteArray, abi: Int, runtimeVersion: String) {
            if (generation.size != 16 || (!restoring && (abi != 12 || runtimeVersion.isBlank()))) {
                ready.completeExceptionally(brokerError(BrokerFailureReason.IncompatibleResources, "incompatible worker runtime"))
            } else {
                ready.complete(generation)
            }
        }
        override fun failed(reason: String, detail: String) {
            ready.completeExceptionally(brokerError(BrokerFailureReason.entries.firstOrNull { it.name == reason } ?: BrokerFailureReason.Database, detail))
            database.get()?.brokerInterrupted()
        }
    }

    suspend fun open(config: EngineConfig, options: OliphauntBrokerOptions, restore: Boolean) {
        restoring = restore
        val deadline = SystemClock.elapsedRealtime() + options.startupTimeoutMillis
        withContext(Dispatchers.IO + NonCancellable) {
            bound = context.bindService(Intent(context, OliphauntBrokerService::class.java), this@BrokerBinding, Context.BIND_AUTO_CREATE)
        }
        if (!bound) throw brokerError(BrokerFailureReason.WorkerInterrupted, "could not bind Oliphaunt worker")
        val remote = awaitUntil(connected, deadline)
        val name = (config.storage as? EngineStorage.ApplicationData)?.name
        val legacy = name?.let { File(context.filesDir, "Oliphaunt/$it/.oliphaunt.json").isFile } ?: false
        val remaining = deadline - SystemClock.elapsedRealtime()
        if (remaining <= 0) throw brokerError(BrokerFailureReason.Deadline, "broker startup deadline exceeded")
        try {
            remote.open(
                client, pair[1], name, legacy, restore,
                config.startupGucs.map { it.name }.toTypedArray(), config.startupGucs.map { it.value }.toTypedArray(),
                config.username, config.database, config.extensions.toTypedArray(), remaining,
            )
        } finally {
            pair[1].close()
        }
        generation = awaitUntil(ready, deadline)
    }

    fun attach(value: NativeDatabase) {
        database = WeakReference(value)
        socket.close()
        if (dead.get()) value.brokerInterrupted()
    }

    override fun onServiceConnected(name: ComponentName, binder: IBinder) {
        if (closed.get() || dead.get()) return
        try {
            binder.linkToDeath(death, 0)
            val remote = IBroker.Stub.asInterface(binder)
            service = remote
            connected.complete(remote)
        } catch (_: Throwable) {
            interrupted()
        }
    }
    override fun onServiceDisconnected(name: ComponentName) {
        interrupted()
    }
    override fun onBindingDied(name: ComponentName) {
        interrupted()
    }
    override fun onNullBinding(name: ComponentName) {
        interrupted()
    }

    private fun interrupted() {
        if (!dead.compareAndSet(false, true)) return
        val error = brokerError(BrokerFailureReason.WorkerInterrupted, "broker worker exited; close and reopen the database")
        connected.completeExceptionally(error)
        ready.completeExceptionally(error)
        database.get()?.brokerInterrupted()
    }

    override fun cancelRequest(epoch: ByteArray, request: ULong): Boolean = runCatching {
        check(!closed.get())
        checkNotNull(service).cancel(client, epoch, request.toLong())
    }.isSuccess
    override fun closeWorker(epoch: ByteArray): Boolean = runCatching {
        checkNotNull(service).close(client, epoch)
    }.isSuccess

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        database.get()?.brokerBeginClose()
        runCatching { service?.close(client, if (::generation.isInitialized) generation else null) }
        runCatching { service?.asBinder()?.unlinkToDeath(death, 0) }
        if (bound) runCatching { context.unbindService(this) }
        pair.forEach { runCatching { it.close() } }
        release()
    }
}

private suspend fun <T> awaitUntil(value: CompletableDeferred<T>, deadline: Long): T {
    while (true) {
        val remaining = deadline - SystemClock.elapsedRealtime()
        if (remaining <= 0) throw brokerError(BrokerFailureReason.Deadline, "broker startup deadline exceeded")
        val result = withTimeoutOrNull(minOf(remaining, 100)) { value.await() }
        if (result != null) return result
    }
}
