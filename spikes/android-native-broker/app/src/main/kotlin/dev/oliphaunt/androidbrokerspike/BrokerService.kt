package dev.oliphaunt.androidbrokerspike

import android.app.Service
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.os.Debug
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.Process
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.system.StructPollfd
import android.util.Log
import dev.oliphaunt.AndroidNativeDirectEngine
import dev.oliphaunt.DurabilityProfile
import dev.oliphaunt.EngineMode
import dev.oliphaunt.OliphauntConfig
import dev.oliphaunt.OliphauntSession
import dev.oliphaunt.ProtocolRequest
import kotlinx.coroutines.runBlocking
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Experimental worker intended to run as an unexported `android:process=":broker"` service.
 * Binder is the out-of-band control plane; the reliable socket is the bounded data plane.
 */
internal class BrokerService : Service() {
    private enum class WorkerState {
        CREATED,
        OPENING,
        READY,
        RUNNING,
        DETACHING,
        FAILED,
        CLOSED,
    }

    private data class ActiveRequest(
        val lifecycle: OlpbRequestLifecycle,
        val assembler: OlpbFrontendRequestAssembler,
    )

    private data class NativePostgresOutputWitness(
        val requestId: Long,
        val backendBytes: Long,
        val observedAtElapsedRealtimeNanos: Long,
    )

    private val epoch = UUID.randomUUID()
    private val workerPid = Process.myPid()
    private val attachStarted = AtomicBoolean(false)
    private val workerState = AtomicReference(WorkerState.CREATED)
    private val armedFault = AtomicReference<BrokerFault?>(null)
    private val nativePostgresOutputWitness =
        AtomicReference<NativePostgresOutputWitness?>(null)
    private val requestLock = Any()
    private val requestsStarted = AtomicLong(0)
    private val requestsCompleted = AtomicLong(0)
    private val cancellationRequests = AtomicLong(0)
    private val databaseExecutor =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "oliphaunt-broker-database").apply { isDaemon = true }
        }
    // This must never share the deliberately blockable database executor.
    private val watchdogExecutor =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "oliphaunt-broker-watchdog").apply { isDaemon = true }
        }

    @Volatile
    private var selectedProtocolVersion = OlpbProtocol.MAXIMUM_VERSION

    @Volatile
    private var endpoint: BrokerSocketEndpoint? = null

    @Volatile
    private var session: OliphauntSession? = null

    @Volatile
    private var activeRequestId = 0L

    @Volatile
    private var nativeDispatchStarted = false

    @Volatile
    private var lastError: String? = null

    @Volatile
    private var lastRequestId = 0L

    private var activeRequest: ActiveRequest? = null

    private val binder =
        object : IOliphauntBroker.Stub() {
            override fun hello(request: Bundle, dataChannel: ParcelFileDescriptor): Bundle =
                handleHello(request, dataChannel)

            override fun control(request: Bundle): Bundle = handleControl(request)
        }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        workerState.set(WorkerState.CLOSED)
        endpoint?.requestStop()
        endpoint = null
        watchdogExecutor.shutdownNow()
        databaseExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun handleHello(request: Bundle, dataChannel: ParcelFileDescriptor): Bundle {
        if (!attachStarted.compareAndSet(false, true)) {
            dataChannel.closeQuietly()
            return rejected("this worker epoch already accepted a data channel")
        }
        try {
            validateHello(request)
            selectedProtocolVersion =
                minOf(
                    request.getInt(
                        BrokerContract.MAXIMUM_PROTOCOL_VERSION,
                        OlpbProtocol.MAXIMUM_VERSION,
                    ),
                    OlpbProtocol.MAXIMUM_VERSION,
                )
            val ownedEndpoint = BrokerSocketEndpoint.takeOwnership(dataChannel)
            endpoint = ownedEndpoint
            workerState.set(WorkerState.OPENING)

            val openFuture =
                databaseExecutor.submit<OliphauntSession> {
                    val root =
                        File(
                            noBackupFilesDir,
                            "oliphaunt-android-broker/${BrokerContract.ROOT_ID}",
                        )
                    val engine = AndroidNativeDirectEngine(applicationContext)
                    runBlocking {
                        engine.open(
                            OliphauntConfig(
                                mode = EngineMode.NativeDirect,
                                root = root.absolutePath,
                                durability = DurabilityProfile.Safe,
                                username = "oliphaunt_broker",
                                database = "postgres",
                            ),
                        )
                    }
                }
            session = openFuture.get()
            workerState.set(WorkerState.READY)
            databaseExecutor.execute { runDataLoop(ownedEndpoint) }
            return ready()
        } catch (error: Throwable) {
            val reason = safeError(error)
            Log.e(TAG, "broker Hello/open failed: $reason", error)
            lastError = reason
            workerState.set(WorkerState.FAILED)
            endpoint?.requestStop()
            endpoint = null
            dataChannel.closeQuietly()
            return rejected(reason)
        }
    }

    private fun validateHello(request: Bundle) {
        if (request.getString(BrokerContract.MESSAGE) != BrokerContract.HELLO) {
            throw IllegalArgumentException("expected hello control message")
        }
        val minimum =
            request.getInt(
                BrokerContract.MINIMUM_PROTOCOL_VERSION,
                OlpbProtocol.MINIMUM_VERSION,
            )
        val maximum =
            request.getInt(
                BrokerContract.MAXIMUM_PROTOCOL_VERSION,
                OlpbProtocol.MAXIMUM_VERSION,
            )
        if (minimum > OlpbProtocol.MAXIMUM_VERSION || maximum < OlpbProtocol.MINIMUM_VERSION) {
            throw IllegalArgumentException("no supported OLPB protocol version")
        }
        if (request.getLong(BrokerContract.EXPECTED_ABI_KEY) != BrokerContract.EXPECTED_ABI) {
            throw IllegalArgumentException("liboliphaunt ABI mismatch")
        }
        if (request.getString(BrokerContract.ROOT_ID_KEY) != BrokerContract.ROOT_ID) {
            throw IllegalArgumentException("this spike supports only the default root")
        }
        if (
            request.getString(BrokerContract.STARTUP_CONFIGURATION_DIGEST_KEY) !=
            BrokerContract.STARTUP_CONFIGURATION_DIGEST
        ) {
            throw IllegalArgumentException("startup configuration digest mismatch")
        }
    }

    private fun handleControl(request: Bundle): Bundle {
        val message = request.getString(BrokerContract.MESSAGE)
            ?: return rejected("control message is missing")
        return when (message) {
            BrokerContract.DIAGNOSTICS -> withValidEpoch(request) { diagnostics() }
            BrokerContract.CANCEL -> withValidEpoch(request) { cancel(request) }
            BrokerContract.INJECT_FAULT -> withValidEpoch(request) { injectFault(request) }
            BrokerContract.DETACH -> withValidEpoch(request) { detach() }
            else -> rejected("unsupported control message $message")
        }
    }

    private inline fun withValidEpoch(request: Bundle, operation: () -> Bundle): Bundle {
        val expected = request.getString(BrokerContract.EPOCH)
        if (expected != epoch.toString()) {
            return rejected("stale worker epoch")
        }
        return operation()
    }

    /** Runs directly on a Binder thread, outside both database executors. */
    private fun cancel(request: Bundle): Bundle {
        val cancelStarted = android.os.SystemClock.elapsedRealtimeNanos()
        val requestedId =
            if (request.containsKey(BrokerContract.REQUEST_ID)) {
                request.getLong(BrokerContract.REQUEST_ID)
            } else {
                activeRequestId
            }
        val shouldCallNative =
            synchronized(requestLock) {
                val active = activeRequest
                    ?: return rejected("there is no active request")
                if (active.lifecycle.requestId != requestedId) {
                    return rejected("request $requestedId is not active")
                }
                active.lifecycle.requestCancellation() && active.lifecycle.nativeDispatchStarted
            }
        cancellationRequests.incrementAndGet()
        Log.i(
            TAG,
            "cancel request=$requestedId state=${workerState.get()} nativeDispatch=$nativeDispatchStarted " +
                "callNative=$shouldCallNative",
        )
        if (shouldCallNative) {
            val currentSession = session ?: return rejected("database session is unavailable")
            try {
                runBlocking { currentSession.cancel() }
            } catch (error: Throwable) {
                return rejected("native cancel failed: ${safeError(error)}")
            }
        }
        Log.i(
            TAG,
            "cancel acknowledged request=$requestedId elapsedMillis=" +
                ((android.os.SystemClock.elapsedRealtimeNanos() - cancelStarted) / 1_000_000L),
        )
        return success(BrokerContract.CANCEL_OBSERVED).apply {
            putLong(BrokerContract.REQUEST_ID, requestedId)
        }
    }

    /** Uses cached request state and process APIs only; it remains live if the DB executor wedges. */
    private fun diagnostics(): Bundle {
        val socket = endpoint?.diagnostics()
        val witness = nativePostgresOutputWitness.get()
        return success(BrokerContract.DIAGNOSTICS).apply {
            putString(BrokerContract.STATE, workerState.get().name.lowercase())
            activeRequestId.takeIf { it != 0L }?.let {
                putLong(BrokerContract.ACTIVE_REQUEST_ID, it)
            }
            putBoolean(BrokerContract.NATIVE_DISPATCH_STARTED, nativeDispatchStarted)
            putBoolean(
                BrokerContract.NATIVE_POSTGRES_OUTPUT_WITNESS_OBSERVED,
                witness != null,
            )
            witness?.let {
                putLong(
                    BrokerContract.NATIVE_POSTGRES_OUTPUT_WITNESS_REQUEST_ID,
                    it.requestId,
                )
                putLong(
                    BrokerContract.NATIVE_POSTGRES_OUTPUT_WITNESS_BACKEND_BYTES,
                    it.backendBytes,
                )
                putLong(
                    BrokerContract.NATIVE_POSTGRES_OUTPUT_WITNESS_ELAPSED_REALTIME_NANOS,
                    it.observedAtElapsedRealtimeNanos,
                )
            }
            putString(BrokerContract.TRANSACTION_STATUS, "unknown")
            putLong(BrokerContract.CURRENT_PSS_BYTES, Debug.getPss().toLong() * 1024L)
            putLong(BrokerContract.CURRENT_RSS_BYTES, currentRssBytes())
            putInt(
                BrokerContract.REQUESTED_SOCKET_SEND_BUFFER_BYTES,
                endpoint?.requestedSocketSendBufferBytes ?: -1,
            )
            socket?.let {
                putLong(
                    BrokerContract.DIAGNOSTICS_SAMPLE_ELAPSED_REALTIME_NANOS,
                    it.sampleElapsedRealtimeNanos,
                )
                putBoolean(
                    BrokerContract.SOCKET_NON_BLOCKING_PROBE_SUCCEEDED,
                    it.nonBlockingProbeSucceeded,
                )
                if (it.nonBlockingProbeSucceeded) {
                    putBoolean(BrokerContract.SOCKET_NON_BLOCKING, it.nonBlocking)
                }
                putBoolean(BrokerContract.SOCKET_POLL_SUCCEEDED, it.pollSucceeded)
                if (it.pollSucceeded) {
                    putBoolean(BrokerContract.SOCKET_WRITABLE_NOW, it.writableNow)
                }
                putBoolean(BrokerContract.SOCKET_WRITE_IN_PROGRESS, it.activeWrite != null)
                it.activeWrite?.let { activeWrite ->
                    putLong(
                        BrokerContract.SOCKET_ACTIVE_WRITE_SEQUENCE,
                        activeWrite.sequence,
                    )
                    putLong(
                        BrokerContract.SOCKET_ACTIVE_WRITE_REQUEST_ID,
                        activeWrite.requestId,
                    )
                    putInt(
                        BrokerContract.SOCKET_ACTIVE_WRITE_FRAME_TYPE,
                        activeWrite.frameType.wireValue,
                    )
                    putLong(
                        BrokerContract.SOCKET_ACTIVE_WRITE_STARTED_ELAPSED_REALTIME_NANOS,
                        activeWrite.startedElapsedRealtimeNanos,
                    )
                    putInt(
                        BrokerContract.SOCKET_ACTIVE_WRITE_ENCODED_BYTES,
                        activeWrite.encodedBytes,
                    )
                }
                putLong(BrokerContract.SOCKET_WRITES_COMPLETED, it.writesCompleted)
                putLong(
                    BrokerContract.SOCKET_COMPLETED_ENCODED_BYTES,
                    it.completedEncodedBytes,
                )
            }
            putLong("requestsStarted", requestsStarted.get())
            putLong("requestsCompleted", requestsCompleted.get())
            putLong("cancellationRequests", cancellationRequests.get())
            lastError?.let { putString(BrokerContract.REASON, it) }
        }
    }

    private fun injectFault(request: Bundle): Bundle {
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) {
            return rejected("fault injection requires a debuggable build")
        }
        val wireValue = request.getString(BrokerContract.FAULT)
            ?: return rejected("fault is missing")
        val fault = BrokerFault.entries.firstOrNull { it.wireValue == wireValue }
            ?: return rejected("unknown fault $wireValue")
        if (!armedFault.compareAndSet(null, fault)) {
            return rejected("another fault is already armed")
        }
        return success(BrokerContract.INJECT_FAULT).apply {
            putString(BrokerContract.FAULT, fault.wireValue)
        }
    }

    private fun detach(): Bundle {
        workerState.set(WorkerState.DETACHING)
        endpoint?.requestStop()
        return success(BrokerContract.DETACH)
    }

    private fun runDataLoop(channel: BrokerSocketEndpoint) {
        try {
            while (workerState.get() != WorkerState.DETACHING) {
                val frame = channel.readFrame(epoch)
                    ?: throw IOException("broker data channel closed without channelClose")
                if (frame.header.protocolVersion != selectedProtocolVersion) {
                    throw OlpbProtocolException(
                        "frame version ${frame.header.protocolVersion} does not match $selectedProtocolVersion",
                    )
                }
                when (frame.header.frameType) {
                    OlpbFrameType.REQUEST_BEGIN -> beginRequest(frame, channel)
                    OlpbFrameType.REQUEST_BYTES -> appendRequestBytes(frame, channel)
                    OlpbFrameType.REQUEST_END -> finishAndExecuteRequest(frame, channel)
                    OlpbFrameType.PING ->
                        channel.writeFrame(
                            OlpbFrame(
                                frameType = OlpbFrameType.PONG,
                                epoch = epoch,
                                requestId = 0,
                            ),
                        )
                    OlpbFrameType.CHANNEL_CLOSE -> {
                        workerState.set(WorkerState.DETACHING)
                        break
                    }
                    else ->
                        throw OlpbProtocolException(
                            "host sent illegal ${frame.header.frameType} frame",
                        )
                }
            }
        } catch (error: Throwable) {
            if (workerState.get() != WorkerState.DETACHING) {
                lastError = safeError(error)
                workerState.set(WorkerState.FAILED)
                try {
                    channel.writeFrame(
                        OlpbFrame(
                            frameType = OlpbFrameType.PROTOCOL_ERROR,
                            epoch = epoch,
                            requestId = 0,
                            payload = safeError(error).toByteArray(Charsets.UTF_8),
                        ),
                    )
                } catch (_: Throwable) {
                    // The socket itself is commonly the failure source.
                }
            }
        } finally {
            channel.requestStop()
            endpoint = null
            closeSession()
            synchronized(requestLock) { activeRequest = null }
            activeRequestId = 0
            nativeDispatchStarted = false
            if (workerState.get() == WorkerState.DETACHING) {
                workerState.set(WorkerState.CLOSED)
            }
            stopSelf()
        }
    }

    private fun beginRequest(frame: OlpbFrame, channel: BrokerSocketEndpoint) {
        if (frame.payload.isNotEmpty()) {
            channel.writeRejected(frame.header.requestId, epoch, "requestBegin payload must be empty")
            return
        }
        synchronized(requestLock) {
            if (activeRequest != null) {
                throw OlpbProtocolException("requestBegin while another request is active")
            }
            if (
                lastRequestId != 0L &&
                java.lang.Long.compareUnsigned(frame.header.requestId, lastRequestId) <= 0
            ) {
                throw OlpbProtocolException("request IDs must be strictly increasing")
            }
            val lifecycle = OlpbRequestLifecycle(epoch, frame.header.requestId)
            lifecycle.beginReceiving()
            nativePostgresOutputWitness.set(null)
            nativeDispatchStarted = false
            activeRequest = ActiveRequest(lifecycle, OlpbFrontendRequestAssembler())
            activeRequestId = frame.header.requestId
            lastRequestId = frame.header.requestId
            requestsStarted.incrementAndGet()
        }
    }

    private fun appendRequestBytes(frame: OlpbFrame, channel: BrokerSocketEndpoint) {
        val active = synchronized(requestLock) {
            activeRequest?.takeIf { it.lifecycle.requestId == frame.header.requestId }
                ?: throw OlpbProtocolException("requestBytes does not match the active request")
        }
        val canceled = synchronized(requestLock) {
            active.lifecycle.state == OlpbRequestState.TERMINAL &&
                active.lifecycle.terminalResult == OlpbTerminalResult.CANCELED
        }
        if (canceled) {
            return
        }
        try {
            active.assembler.append(frame.payload)
        } catch (error: Throwable) {
            synchronized(requestLock) {
                active.lifecycle.establishTerminal(OlpbTerminalResult.REJECTED)
                activeRequest = null
            }
            activeRequestId = 0
            channel.writeRejected(frame.header.requestId, epoch, safeError(error))
        }
    }

    private fun finishAndExecuteRequest(frame: OlpbFrame, channel: BrokerSocketEndpoint) {
        if (frame.payload.isNotEmpty()) {
            channel.writeRejected(frame.header.requestId, epoch, "requestEnd payload must be empty")
            clearActiveRequest(frame.header.requestId)
            return
        }
        val active = synchronized(requestLock) {
            activeRequest?.takeIf { it.lifecycle.requestId == frame.header.requestId }
                ?: throw OlpbProtocolException("requestEnd does not match the active request")
        }
        if (
            active.lifecycle.state == OlpbRequestState.TERMINAL &&
            active.lifecycle.terminalResult == OlpbTerminalResult.CANCELED
        ) {
            channel.writeRejected(frame.header.requestId, epoch, "request canceled before dispatch")
            clearActiveRequest(frame.header.requestId)
            return
        }

        val requestBytes =
            try {
                active.assembler.finish()
            } catch (error: Throwable) {
                synchronized(requestLock) {
                    active.lifecycle.establishTerminal(OlpbTerminalResult.REJECTED)
                }
                channel.writeRejected(frame.header.requestId, epoch, safeError(error))
                clearActiveRequest(frame.header.requestId)
                return
            }
        synchronized(requestLock) { active.lifecycle.finishReceiving() }
        workerState.set(WorkerState.RUNNING)
        val fault = armedFault.getAndSet(null)

        try {
            when (fault) {
                BrokerFault.EXECUTOR_DEADLOCK_WITH_FAIL_STOP -> triggerExecutorDeadlockFailStop()
                else -> Unit
            }
            val nativeRequest = ProtocolRequest(requestBytes)
            val nativeOutputWitnessCounter =
                if (fault == BrokerFault.NATIVE_FAIL_STOP_WATCHDOG) {
                    NativePostgresOutputWitnessCounter(
                        BrokerContract.NATIVE_POSTGRES_OUTPUT_WITNESS_THRESHOLD_BYTES,
                    )
                } else {
                    null
                }
            val currentSession = session ?: throw IllegalStateException("database session is unavailable")
            runBlocking {
                synchronized(requestLock) {
                    active.lifecycle.beginNativeDispatch()
                    nativeDispatchStarted = true
                }
                currentSession.execProtocolStream(nativeRequest) { response ->
                    val pendingOutputWitness =
                        nativeOutputWitnessCounter?.consume(response.bytes)
                    channel.writeResponseBytes(
                        requestId = frame.header.requestId,
                        epoch = epoch,
                        bytes = response.bytes,
                    )
                    pendingOutputWitness?.let { outputWitness ->
                        val witness =
                            NativePostgresOutputWitness(
                                requestId = frame.header.requestId,
                                backendBytes = outputWitness.backendBytes,
                                observedAtElapsedRealtimeNanos =
                                    android.os.SystemClock.elapsedRealtimeNanos(),
                            )
                        check(nativePostgresOutputWitness.compareAndSet(null, witness)) {
                            "native PostgreSQL-output witness was already published"
                        }
                        armFailStopWatchdog(
                            reason = "native pg_sleep after >4 MiB PostgreSQL output",
                            delayMillis =
                                BrokerContract.NATIVE_POSTGRES_OUTPUT_WATCHDOG_DELAY_MILLIS,
                        )
                    }
                }
            }
            if (fault == BrokerFault.AFTER_NATIVE_SUCCESS_BEFORE_COMPLETED) {
                armFailStopWatchdog("after native success", delayMillis = 1)
                CountDownLatch(1).await()
            }
            synchronized(requestLock) {
                active.lifecycle.establishTerminal(OlpbTerminalResult.COMPLETED)
            }
            channel.writeFrame(
                OlpbFrame(
                    frameType = OlpbFrameType.COMPLETED,
                    epoch = epoch,
                    requestId = frame.header.requestId,
                ),
            )
            requestsCompleted.incrementAndGet()
            clearActiveRequest(frame.header.requestId)
            workerState.set(WorkerState.READY)
        } catch (error: Throwable) {
            synchronized(requestLock) {
                active.lifecycle.establishTerminal(OlpbTerminalResult.OUTCOME_UNKNOWN)
            }
            try {
                channel.writeFrame(
                    OlpbFrame(
                        frameType = OlpbFrameType.OUTCOME_UNKNOWN,
                        epoch = epoch,
                        requestId = frame.header.requestId,
                    ),
                )
            } catch (_: Throwable) {
                // A failed or killed transport cannot carry the terminal marker.
            }
            clearActiveRequest(frame.header.requestId)
            throw error
        }
    }

    private fun triggerExecutorDeadlockFailStop(): Nothing {
        armFailStopWatchdog("database executor deadlock")
        CountDownLatch(1).await()
        error("unreachable after executor deadlock")
    }

    private fun armFailStopWatchdog(
        reason: String,
        delayMillis: Long = FAIL_STOP_DELAY_MILLIS,
    ) {
        lastError = "fail-stop watchdog armed: $reason"
        watchdogExecutor.schedule(
            {
                lastError = "fail-stop watchdog fired: $reason"
                try {
                    Os.kill(workerPid, OsConstants.SIGABRT)
                } catch (_: Throwable) {
                    Process.killProcess(workerPid)
                }
            },
            delayMillis,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun clearActiveRequest(requestId: Long) {
        synchronized(requestLock) {
            if (activeRequest?.lifecycle?.requestId == requestId) {
                activeRequest = null
            }
        }
        if (activeRequestId == requestId) activeRequestId = 0
        nativeDispatchStarted = false
    }

    private fun closeSession() {
        val current = session ?: return
        session = null
        try {
            runBlocking { current.close() }
        } catch (error: Throwable) {
            Log.w(TAG, "session close failed", error)
        }
    }

    private fun ready(): Bundle =
        success(BrokerContract.READY).apply {
            putInt(BrokerContract.SELECTED_PROTOCOL_VERSION, selectedProtocolVersion)
            putLong(BrokerContract.ABI_VERSION, BrokerContract.EXPECTED_ABI)
            putString(BrokerContract.RUNTIME_VERSION, "local-android-spike")
            putInt(BrokerContract.POSTGRES_MAJOR_VERSION, 18)
            putString(BrokerContract.ROOT_MANIFEST_DIGEST, BrokerContract.STARTUP_CONFIGURATION_DIGEST)
            putStringArray(BrokerContract.ACTUAL_CAPABILITIES, BrokerContract.requestedCapabilities)
            putString(BrokerContract.ACTUAL_RUNTIME_CONFIGURATION, BrokerContract.STARTUP_CONFIGURATION_DIGEST)
        }

    private fun success(message: String): Bundle =
        Bundle().apply {
            putString(BrokerContract.MESSAGE, message)
            putBoolean(BrokerContract.SUCCESS, true)
            putString(BrokerContract.EPOCH, epoch.toString())
            putInt(BrokerContract.WORKER_PID, workerPid)
        }

    private fun rejected(reason: String): Bundle =
        Bundle().apply {
            putString(BrokerContract.MESSAGE, BrokerContract.REJECTED)
            putBoolean(BrokerContract.SUCCESS, false)
            putString(BrokerContract.REASON, reason)
            putString(BrokerContract.EPOCH, epoch.toString())
            putInt(BrokerContract.WORKER_PID, workerPid)
        }

    private fun currentRssBytes(): Long =
        try {
            File("/proc/self/status").useLines { lines ->
                lines
                    .firstOrNull { it.startsWith("VmRSS:") }
                    ?.trim()
                    ?.split(Regex("\\s+"))
                    ?.getOrNull(1)
                    ?.toLongOrNull()
                    ?.times(1024L)
                    ?: -1L
            }
        } catch (_: Throwable) {
            -1L
        }

    private fun safeError(error: Throwable): String {
        val cause = error.cause ?: error
        return "${cause::class.java.simpleName}: ${cause.message ?: "unknown failure"}".take(512)
    }

    private companion object {
        const val TAG = "OliphauntBroker"
        const val FAIL_STOP_DELAY_MILLIS = 1_000L
    }
}

internal data class NativePostgresOutputWitnessSample(
    val backendBytes: Long,
)

/** Reports once when cumulative bytes emitted by the native PostgreSQL stream exceed the threshold. */
internal class NativePostgresOutputWitnessCounter(
    private val thresholdBytes: Long,
) {
    private var backendBytes = 0L
    private var witnessed = false

    init {
        require(thresholdBytes >= 0) { "native output threshold must not be negative" }
    }

    fun consume(bytes: ByteArray): NativePostgresOutputWitnessSample? {
        if (witnessed) return null
        backendBytes = Math.addExact(backendBytes, bytes.size.toLong())
        if (backendBytes <= thresholdBytes) return null
        witnessed = true
        return NativePostgresOutputWitnessSample(backendBytes)
    }
}

private data class ActiveSocketWrite(
    val sequence: Long,
    val requestId: Long,
    val frameType: OlpbFrameType,
    val startedElapsedRealtimeNanos: Long,
    val encodedBytes: Int,
)

private data class BrokerSocketDiagnostics(
    val sampleElapsedRealtimeNanos: Long,
    val nonBlockingProbeSucceeded: Boolean,
    val nonBlocking: Boolean,
    val pollSucceeded: Boolean,
    val writableNow: Boolean,
    val activeWrite: ActiveSocketWrite?,
    val writesCompleted: Long,
    val completedEncodedBytes: Long,
)

/** Owns two dup'd descriptors for one reliable full-duplex socket endpoint. */
private class BrokerSocketEndpoint private constructor(
    private val inputDescriptor: ParcelFileDescriptor,
    private val outputDescriptor: ParcelFileDescriptor,
    private val input: InputStream,
    private val output: OutputStream,
    val requestedSocketSendBufferBytes: Int,
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val writeLock = Any()
    private val nextWriteSequence = AtomicLong(0)
    private val activeWrite = AtomicReference<ActiveSocketWrite?>(null)
    private val writesCompleted = AtomicLong(0)
    private val completedEncodedBytes = AtomicLong(0)

    fun readFrame(expectedEpoch: UUID): OlpbFrame? {
        val headerBytes = input.readExactlyOrNull(OlpbProtocol.HEADER_LENGTH) ?: run {
            outputDescriptor.checkError()
            return null
        }
        val header = OlpbFrameCodec.decodeHeader(headerBytes, expectedEpoch)
        val payload = input.readExactly(header.payloadLength)
        return OlpbFrame(header, payload)
    }

    fun writeFrame(frame: OlpbFrame) {
        val encoded = OlpbFrameCodec.encode(frame)
        synchronized(writeLock) {
            check(!closed.get()) { "broker socket is closed" }
            val write =
                ActiveSocketWrite(
                    sequence = nextWriteSequence.incrementAndGet(),
                    requestId = frame.header.requestId,
                    frameType = frame.header.frameType,
                    startedElapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos(),
                    encodedBytes = encoded.size,
                )
            check(activeWrite.compareAndSet(null, write)) { "socket write probe is already active" }
            try {
                output.write(encoded)
                output.flush()
                completedEncodedBytes.addAndGet(encoded.size.toLong())
                writesCompleted.incrementAndGet()
            } finally {
                activeWrite.compareAndSet(write, null)
            }
        }
    }

    /** Samples the descriptor and atomic write counters without waiting for [writeLock]. */
    fun diagnostics(): BrokerSocketDiagnostics {
        val descriptor = outputDescriptor.fileDescriptor
        val flags =
            try {
                Os.fcntlInt(descriptor, OsConstants.F_GETFL, 0)
            } catch (_: Throwable) {
                null
            }
        val pollDescriptor =
            StructPollfd().apply {
                fd = descriptor
                events = OsConstants.POLLOUT.toShort()
            }
        var pollSucceeded = false
        var writableNow = false
        try {
            Os.poll(arrayOf(pollDescriptor), 0)
            pollSucceeded = true
            writableNow =
                pollDescriptor.revents.toInt() and OsConstants.POLLOUT != 0
        } catch (_: Throwable) {
            // The success bit keeps a probe failure distinct from backpressure.
        }
        return BrokerSocketDiagnostics(
            sampleElapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos(),
            nonBlockingProbeSucceeded = flags != null,
            nonBlocking = flags?.let { it and OsConstants.O_NONBLOCK != 0 } ?: false,
            pollSucceeded = pollSucceeded,
            writableNow = writableNow,
            activeWrite = activeWrite.get(),
            writesCompleted = writesCompleted.get(),
            completedEncodedBytes = completedEncodedBytes.get(),
        )
    }

    fun writeResponseBytes(requestId: Long, epoch: UUID, bytes: ByteArray) {
        if (bytes.isEmpty()) return
        var offset = 0
        while (offset < bytes.size) {
            val end = minOf(bytes.size, offset + OlpbProtocol.MAXIMUM_FRAME_PAYLOAD)
            writeFrame(
                OlpbFrame(
                    frameType = OlpbFrameType.RESPONSE_BYTES,
                    epoch = epoch,
                    requestId = requestId,
                    payload = bytes.copyOfRange(offset, end),
                ),
            )
            offset = end
        }
    }

    fun writeRejected(requestId: Long, epoch: UUID, reason: String) {
        writeFrame(
            OlpbFrame(
                frameType = OlpbFrameType.REJECTED,
                epoch = epoch,
                requestId = requestId,
                payload = reason.take(512).toByteArray(Charsets.UTF_8),
            ),
        )
    }

    fun requestStop() = close()

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        try {
            Os.shutdown(outputDescriptor.fileDescriptor, OsConstants.SHUT_RDWR)
        } catch (_: Throwable) {
            // Closing both owned descriptors is the fallback wakeup.
        }
        input.closeQuietly()
        output.closeQuietly()
        inputDescriptor.closeQuietly()
        outputDescriptor.closeQuietly()
    }

    companion object {
        private const val REQUESTED_SEND_BUFFER_BYTES = 512 * 1024

        fun takeOwnership(descriptor: ParcelFileDescriptor): BrokerSocketEndpoint {
            val inputDescriptor =
                try {
                    ParcelFileDescriptor.dup(descriptor.fileDescriptor)
                } catch (error: Throwable) {
                    descriptor.closeQuietly()
                    throw error
                }
            try {
                try {
                    Os.setsockoptInt(
                        descriptor.fileDescriptor,
                        OsConstants.SOL_SOCKET,
                        OsConstants.SO_SNDBUF,
                        REQUESTED_SEND_BUFFER_BYTES,
                    )
                } catch (_: Throwable) {
                    // The socket keeps its kernel default when the request fails.
                }
                return BrokerSocketEndpoint(
                    inputDescriptor = inputDescriptor,
                    outputDescriptor = descriptor,
                    input = ParcelFileDescriptor.AutoCloseInputStream(inputDescriptor),
                    output = ParcelFileDescriptor.AutoCloseOutputStream(descriptor),
                    // Android's public Os facade can set but not query SO_SNDBUF.
                    // This is the requested value, not a queried effective value.
                    // Slow-reader PSS/RSS spans are reported independently.
                    requestedSocketSendBufferBytes = REQUESTED_SEND_BUFFER_BYTES,
                )
            } catch (error: Throwable) {
                inputDescriptor.closeQuietly()
                descriptor.closeQuietly()
                throw error
            }
        }
    }
}

private fun InputStream.readExactlyOrNull(length: Int): ByteArray? {
    if (length == 0) return ByteArray(0)
    val result = ByteArray(length)
    val first = read()
    if (first < 0) return null
    result[0] = first.toByte()
    var offset = 1
    while (offset < length) {
        val count = read(result, offset, length - offset)
        if (count < 0) throw IOException("truncated broker frame")
        if (count == 0) continue
        offset += count
    }
    return result
}

private fun InputStream.readExactly(length: Int): ByteArray =
    readExactlyOrNull(length) ?: throw IOException("truncated broker frame")

private fun Closeable.closeQuietly() {
    try {
        close()
    } catch (_: Throwable) {
        // Best-effort experimental cleanup.
    }
}
