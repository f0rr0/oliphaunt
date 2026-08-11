package dev.oliphaunt.androidbrokerspike

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.DeadObjectException
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.Process
import android.os.RemoteException
import android.os.SystemClock
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal data class BrokerReady(
    val epoch: UUID,
    val workerPid: Int,
    val protocolVersion: Int,
    val runtimeVersion: String?,
    val abiVersion: Long?,
    val postgresMajorVersion: Int?,
    val rootManifestDigest: String?,
)

internal data class BrokerDiagnostics(
    val epoch: UUID,
    val workerPid: Int,
    val state: String?,
    val activeRequestId: Long?,
    val nativeDispatchStarted: Boolean,
    val nativePostgresOutputWitnessObserved: Boolean,
    val nativePostgresOutputWitnessRequestId: Long?,
    val nativePostgresOutputWitnessBackendBytes: Long?,
    val nativePostgresOutputWitnessElapsedRealtimeNanos: Long?,
    val transactionStatus: String?,
    val currentPssBytes: Long?,
    val currentRssBytes: Long?,
    val socketSendBufferBytes: Int?,
    val sampleElapsedRealtimeNanos: Long?,
    val socketNonBlockingProbeSucceeded: Boolean,
    val socketNonBlocking: Boolean?,
    val socketPollSucceeded: Boolean,
    val socketWritableNow: Boolean?,
    val socketWriteInProgress: Boolean,
    val socketActiveWriteSequence: Long?,
    val socketActiveWriteRequestId: Long?,
    val socketActiveWriteFrameType: OlpbFrameType?,
    val socketActiveWriteStartedElapsedRealtimeNanos: Long?,
    val socketActiveWriteEncodedBytes: Int?,
    val socketWritesCompleted: Long?,
    val socketCompletedEncodedBytes: Long?,
)

internal data class BrokerExecutionStats(
    val epoch: UUID,
    val workerPid: Int,
    val requestId: Long,
    val responseBytes: Long,
    val responseChunks: Int,
    val transactionStatus: Byte,
)

internal data class BrokerDeath(
    val epoch: UUID,
    val workerPid: Int,
    val reason: String,
    val observedAtElapsedRealtimeNanos: Long,
)

private data class BinderDeathEvent(
    val epoch: UUID,
    val workerPid: Int,
    val observedAtElapsedRealtimeNanos: Long,
)

internal open class BrokerClientException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

internal class BrokerRejectedException(message: String) : BrokerClientException(message)

internal class BrokerOutcomeUnknownException(
    val epoch: UUID,
    val requestId: Long,
    cause: Throwable? = null,
) : BrokerClientException(
        "request outcome is unknown (epoch $epoch, request ${java.lang.Long.toUnsignedString(requestId)})",
        cause,
    )

/**
 * Experimental host for one remote broker generation.
 *
 * Connection establishment may be retried. An individual SQL request never is:
 * after the first socket write attempt, every transport or protocol loss is
 * surfaced as [BrokerOutcomeUnknownException].
 */
internal class BrokerClient(context: Context) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val connectionMutex = Mutex()
    private val executionMutex = Mutex()
    private val stateLock = Any()
    private val deathEvents = Channel<BrokerDeath>(Channel.UNLIMITED)
    private val binderDeathEvents = Channel<BinderDeathEvent>(Channel.UNLIMITED)

    private var connection: Connection? = null
    private var interruptedIdentity: BrokerReady? = null
    private var activeRequest: ActiveRequest? = null
    private var nextRequestId = 1L
    private var closed = false

    suspend fun connect(): BrokerReady = ensureConnection().ready

    suspend fun reconnect(): BrokerReady = ensureConnection().ready

    suspend fun execute(
        request: ByteArray,
        slowReadDelayMillis: Long = 0,
    ): ByteArray {
        val output = ByteArrayOutputStream()
        executeStreaming(
            request = request,
            slowReadDelayMillis = slowReadDelayMillis,
            onChunk = { chunk ->
                if (output.size().toLong() + chunk.size > MAXIMUM_RAW_RESPONSE_BYTES) {
                    throw BrokerClientException(
                        "raw broker response exceeds $MAXIMUM_RAW_RESPONSE_BYTES bytes; " +
                            "use executeStreaming",
                    )
                }
                output.write(chunk)
            },
        )
        return output.toByteArray()
    }

    suspend fun execute(
        sql: String,
        slowReadDelayMillis: Long = 0,
    ): ByteArray = execute(BrokerContract.simpleQuery(sql), slowReadDelayMillis)

    suspend fun executeSlowReader(
        sql: String,
        firstReadRelease: Deferred<Unit>,
        perFrameDelayMillis: Long,
    ): BrokerExecutionStats =
        executeStreaming(
            request = BrokerContract.simpleQuery(sql),
            slowReadDelayMillis = perFrameDelayMillis,
            firstReadRelease = firstReadRelease,
            onChunk = {},
        )

    suspend fun executeStreaming(
        request: ByteArray,
        slowReadDelayMillis: Long = 0,
        firstReadRelease: Deferred<Unit>? = null,
        onChunk: (ByteArray) -> Unit,
    ): BrokerExecutionStats = executionMutex.withLock {
        require(slowReadDelayMillis >= 0) { "slow-read delay must not be negative" }
        validateFrontendRequest(request)

        // Recovery may happen before admission. Nothing below this point retries.
        val generation = ensureConnection()
        val requestId = allocateRequestId()
        val attempt = RequestAttempt(generation.ready.epoch, requestId)
        synchronized(stateLock) {
            check(!closed) { "broker client is closed" }
            activeRequest = ActiveRequest(generation.token, generation.ready.epoch, requestId)
        }

        try {
            attempt.bytesMayHaveReachedWorker = true
            generation.channel.write(
                OlpbFrame(
                    protocolVersion = generation.ready.protocolVersion,
                    frameType = OlpbFrameType.REQUEST_BEGIN,
                    epoch = generation.ready.epoch,
                    requestId = requestId,
                ),
            )
            var offset = 0
            while (offset < request.size) {
                val end = minOf(request.size, offset + OlpbProtocol.MAXIMUM_FRAME_PAYLOAD)
                generation.channel.write(
                    OlpbFrame(
                        protocolVersion = generation.ready.protocolVersion,
                        frameType = OlpbFrameType.REQUEST_BYTES,
                        epoch = generation.ready.epoch,
                        requestId = requestId,
                        payload = request.copyOfRange(offset, end),
                    ),
                )
                offset = end
            }
            generation.channel.write(
                OlpbFrame(
                    protocolVersion = generation.ready.protocolVersion,
                    frameType = OlpbFrameType.REQUEST_END,
                    epoch = generation.ready.epoch,
                    requestId = requestId,
                ),
            )

            val backend = BackendTerminalObserver()
            var responseBytes = 0L
            var responseChunks = 0
            firstReadRelease?.await()
            while (true) {
                if (slowReadDelayMillis > 0) delay(slowReadDelayMillis)
                val frame = generation.channel.read(generation.ready.epoch)
                if (frame.header.frameType == OlpbFrameType.PROTOCOL_ERROR) {
                    throw OlpbProtocolException(
                        frame.payload.toString(Charsets.UTF_8).ifEmpty { "worker protocol error" },
                    )
                }
                if (frame.header.requestId != requestId) {
                    throw OlpbProtocolException(
                        "response request ID ${frame.header.requestId} does not match $requestId",
                    )
                }
                when (frame.header.frameType) {
                    OlpbFrameType.RESPONSE_BYTES -> {
                        backend.append(frame.payload)
                        responseBytes += frame.payload.size
                        responseChunks += 1
                        onChunk(frame.payload)
                    }

                    OlpbFrameType.CANCEL_OBSERVED -> {
                        requireEmptyPayload(frame)
                    }

                    OlpbFrameType.COMPLETED -> {
                        requireEmptyPayload(frame)
                        return@withLock BrokerExecutionStats(
                            epoch = generation.ready.epoch,
                            workerPid = generation.ready.workerPid,
                            requestId = requestId,
                            responseBytes = responseBytes,
                            responseChunks = responseChunks,
                            transactionStatus = backend.finish(),
                        )
                    }

                    OlpbFrameType.REJECTED -> {
                        throw BrokerRejectedException(
                            frame.payload.toString(Charsets.UTF_8).ifEmpty { "worker rejected request" },
                        )
                    }

                    OlpbFrameType.OUTCOME_UNKNOWN -> {
                        throw BrokerOutcomeUnknownException(generation.ready.epoch, requestId)
                    }

                    else -> {
                        throw OlpbProtocolException(
                            "illegal worker frame ${frame.header.frameType} while request is active",
                        )
                    }
                }
            }
            @Suppress("UNREACHABLE_CODE")
            throw OlpbProtocolException("response loop ended without a terminal frame")
        } catch (error: Throwable) {
            when (error) {
                is BrokerRejectedException -> throw error
                is BrokerOutcomeUnknownException -> {
                    interrupt(generation, "worker reported outcomeUnknown")
                    throw error
                }

                else -> {
                    if (attempt.bytesMayHaveReachedWorker) {
                        interrupt(generation, "request transport failed: ${error.javaClass.simpleName}")
                        throw BrokerOutcomeUnknownException(
                            epoch = generation.ready.epoch,
                            requestId = requestId,
                            cause = error,
                        )
                    }
                    throw error
                }
            }
        } finally {
            synchronized(stateLock) {
                if (activeRequest?.generation == generation.token &&
                    activeRequest?.requestId == requestId
                ) {
                    activeRequest = null
                }
            }
        }
    }

    /** Returns true only when the worker says cancellation was already observed. */
    suspend fun cancel(requestId: Long? = null): Boolean {
        val target = synchronized(stateLock) { activeRequest }
            ?: throw BrokerClientException("there is no active broker request")
        if (requestId != null && requestId != target.requestId) {
            throw BrokerClientException("request $requestId is not active")
        }
        val current = currentConnection(target.generation)
            ?: throw BrokerOutcomeUnknownException(target.epoch, target.requestId)
        val reply = callControl(
            current,
            BrokerContract.control(
                message = BrokerContract.CANCEL,
                epoch = target.epoch,
                requestId = target.requestId,
            ),
        )
        return when (val message = reply.getString(BrokerContract.MESSAGE)) {
            BrokerContract.CANCEL_OBSERVED -> true
            BrokerContract.CANCEL -> false
            else -> throw OlpbProtocolException("invalid cancellation reply $message")
        }
    }

    suspend fun armFault(fault: BrokerFault) {
        val current = ensureConnection()
        val reply = callControl(
            current,
            BrokerContract.control(
                message = BrokerContract.INJECT_FAULT,
                epoch = current.ready.epoch,
                fault = fault,
            ),
        )
        requireReply(reply, BrokerContract.INJECT_FAULT)
    }

    suspend fun diagnostics(): BrokerDiagnostics {
        val current = ensureConnection()
        val reply = callControl(
            current,
            BrokerContract.control(
                message = BrokerContract.DIAGNOSTICS,
                epoch = current.ready.epoch,
            ),
        )
        requireReply(reply, BrokerContract.DIAGNOSTICS)
        val epoch = requiredUuid(reply, BrokerContract.EPOCH)
        val workerPid = requiredPositiveInt(reply, BrokerContract.WORKER_PID)
        if (epoch != current.ready.epoch || workerPid != current.ready.workerPid) {
            interrupt(current, "diagnostics identity changed within one generation")
            throw OlpbProtocolException("diagnostics identity does not match Ready")
        }
        return BrokerDiagnostics(
            epoch = epoch,
            workerPid = workerPid,
            state = reply.getString(BrokerContract.STATE),
            activeRequestId = reply.optionalLong(BrokerContract.ACTIVE_REQUEST_ID),
            nativeDispatchStarted = reply.getBoolean(BrokerContract.NATIVE_DISPATCH_STARTED, false),
            nativePostgresOutputWitnessObserved =
                reply.getBoolean(
                    BrokerContract.NATIVE_POSTGRES_OUTPUT_WITNESS_OBSERVED,
                    false,
                ),
            nativePostgresOutputWitnessRequestId =
                reply.optionalLong(BrokerContract.NATIVE_POSTGRES_OUTPUT_WITNESS_REQUEST_ID),
            nativePostgresOutputWitnessBackendBytes =
                reply.optionalLong(BrokerContract.NATIVE_POSTGRES_OUTPUT_WITNESS_BACKEND_BYTES),
            nativePostgresOutputWitnessElapsedRealtimeNanos =
                reply.optionalLong(
                    BrokerContract.NATIVE_POSTGRES_OUTPUT_WITNESS_ELAPSED_REALTIME_NANOS,
                ),
            transactionStatus = reply.getString(BrokerContract.TRANSACTION_STATUS),
            currentPssBytes = reply.optionalLong(BrokerContract.CURRENT_PSS_BYTES),
            currentRssBytes = reply.optionalLong(BrokerContract.CURRENT_RSS_BYTES),
            socketSendBufferBytes = reply.optionalInt(BrokerContract.SOCKET_SEND_BUFFER_BYTES),
            sampleElapsedRealtimeNanos =
                reply.optionalLong(BrokerContract.DIAGNOSTICS_SAMPLE_ELAPSED_REALTIME_NANOS),
            socketNonBlockingProbeSucceeded =
                reply.getBoolean(BrokerContract.SOCKET_NON_BLOCKING_PROBE_SUCCEEDED, false),
            socketNonBlocking = reply.optionalBoolean(BrokerContract.SOCKET_NON_BLOCKING),
            socketPollSucceeded =
                reply.getBoolean(BrokerContract.SOCKET_POLL_SUCCEEDED, false),
            socketWritableNow = reply.optionalBoolean(BrokerContract.SOCKET_WRITABLE_NOW),
            socketWriteInProgress =
                reply.getBoolean(BrokerContract.SOCKET_WRITE_IN_PROGRESS, false),
            socketActiveWriteSequence =
                reply.optionalLong(BrokerContract.SOCKET_ACTIVE_WRITE_SEQUENCE),
            socketActiveWriteRequestId =
                reply.optionalLong(BrokerContract.SOCKET_ACTIVE_WRITE_REQUEST_ID),
            socketActiveWriteFrameType =
                reply.optionalInt(BrokerContract.SOCKET_ACTIVE_WRITE_FRAME_TYPE)?.let {
                    OlpbFrameType.fromWireValue(it)
                },
            socketActiveWriteStartedElapsedRealtimeNanos =
                reply.optionalLong(
                    BrokerContract.SOCKET_ACTIVE_WRITE_STARTED_ELAPSED_REALTIME_NANOS,
                ),
            socketActiveWriteEncodedBytes =
                reply.optionalInt(BrokerContract.SOCKET_ACTIVE_WRITE_ENCODED_BYTES),
            socketWritesCompleted =
                reply.optionalLong(BrokerContract.SOCKET_WRITES_COMPLETED),
            socketCompletedEncodedBytes =
                reply.optionalLong(BrokerContract.SOCKET_COMPLETED_ENCODED_BYTES),
        )
    }

    suspend fun awaitDeath(timeoutMillis: Long): BrokerDeath {
        require(timeoutMillis > 0) { "death timeout must be positive" }
        return withTimeout(timeoutMillis) { deathEvents.receive() }
    }

    suspend fun awaitBinderDeath(generation: BrokerReady, timeoutMillis: Long): Long {
        require(timeoutMillis > 0) { "Binder death timeout must be positive" }
        return withTimeout(timeoutMillis) {
            while (true) {
                val event = binderDeathEvents.receive()
                if (event.epoch == generation.epoch && event.workerPid == generation.workerPid) {
                    return@withTimeout event.observedAtElapsedRealtimeNanos
                }
            }
            error("unreachable")
        }
    }

    suspend fun close() {
        val current = synchronized(stateLock) {
            if (closed) return
            closed = true
            val value = connection
            connection = null
            activeRequest = null
            value
        }
        if (current != null) {
            try {
                callControl(
                    current,
                    BrokerContract.control(BrokerContract.DETACH, current.ready.epoch),
                )
            } catch (_: Throwable) {
                // Closing is terminal for this host handle.
            }
            current.close(appContext)
        }
        deathEvents.close()
        binderDeathEvents.close()
    }

    private suspend fun ensureConnection(): Connection = connectionMutex.withLock {
        synchronized(stateLock) {
            check(!closed) { "broker client is closed" }
            connection
        }?.let { current ->
            if (!current.interrupted.get() &&
                !current.bound.dead.get() &&
                current.binder.isBinderAlive
            ) {
                return@withLock current
            }
            interrupt(current, "binder was not alive during connection acquisition")
        }

        val stale = synchronized(stateLock) { interruptedIdentity }
        val token = UUID.randomUUID()
        val bound = bind(token)
        val sockets = ParcelFileDescriptor.createReliableSocketPair()
        val hostEndpoint = sockets[0]
        val workerEndpoint = sockets[1]
        var channel: HostDataChannel? = null
        try {
            val reply = withContext(Dispatchers.IO) {
                bound.remote.hello(BrokerContract.hello(), workerEndpoint)
            }
            workerEndpoint.close()
            val ready = decodeReady(reply)
            bound.setReady(ready)
            if (ready.workerPid == Process.myPid()) {
                throw OlpbProtocolException("broker service is not running in a separate process")
            }
            if (stale != null) {
                if (ready.epoch == stale.epoch) {
                    throw OlpbProtocolException("recovery reused stale epoch ${stale.epoch}")
                }
                if (ready.workerPid == stale.workerPid) {
                    throw OlpbProtocolException("recovery reused stale worker PID ${stale.workerPid}")
                }
            }
            if (bound.dead.get() || !bound.binder.isBinderAlive) {
                throw DeadObjectException()
            }
            channel = HostDataChannel(hostEndpoint)
            channel.healthCheck(ready)
            if (bound.dead.get() || !bound.binder.isBinderAlive) {
                throw DeadObjectException()
            }
            val established = Connection(token, bound, channel, ready)
            synchronized(stateLock) {
                check(!closed) { "broker client was closed during connection establishment" }
                connection = established
            }
            return@withLock established
        } catch (error: Throwable) {
            try {
                workerEndpoint.close()
            } catch (_: Throwable) {
            }
            if (channel == null) {
                try {
                    hostEndpoint.close()
                } catch (_: Throwable) {
                }
            } else {
                channel.close()
            }
            bound.close(appContext)
            throw BrokerClientException("failed to establish Android broker generation", error)
        }
    }

    private suspend fun bind(token: UUID): BoundService =
        suspendCancellableCoroutine { continuation ->
            val delivered = AtomicBoolean(false)
            lateinit var serviceConnection: ServiceConnection
            serviceConnection =
                object : ServiceConnection {
                    override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                        if (!delivered.compareAndSet(false, true)) return
                        val dead = AtomicBoolean(false)
                        val ready = AtomicReference<BrokerReady?>(null)
                        val deathRecipient = IBinder.DeathRecipient {
                            dead.set(true)
                            ready.get()?.let { identity ->
                                binderDeathEvents.trySend(
                                    BinderDeathEvent(
                                        epoch = identity.epoch,
                                        workerPid = identity.workerPid,
                                        observedAtElapsedRealtimeNanos =
                                            SystemClock.elapsedRealtimeNanos(),
                                    ),
                                )
                            }
                            signalInterruption(token, "binderDied")
                        }
                        try {
                            // Register before Hello so process death cannot hide in the handshake race.
                            binder.linkToDeath(deathRecipient, 0)
                            continuation.resume(
                                BoundService(
                                    remote = IOliphauntBroker.Stub.asInterface(binder),
                                    binder = binder,
                                    serviceConnection = serviceConnection,
                                    deathRecipient = deathRecipient,
                                    dead = dead,
                                    ready = ready,
                                ),
                            )
                        } catch (error: Throwable) {
                            safeUnbind(appContext, serviceConnection)
                            continuation.resumeWithException(error)
                        }
                    }

                    override fun onServiceDisconnected(name: ComponentName) {
                        if (delivered.get()) {
                            signalInterruption(token, "onServiceDisconnected")
                        } else if (delivered.compareAndSet(false, true)) {
                            continuation.resumeWithException(
                                BrokerClientException("broker service disconnected before binding"),
                            )
                        }
                    }

                    override fun onBindingDied(name: ComponentName) {
                        if (delivered.get()) {
                            signalInterruption(token, "onBindingDied")
                        } else if (delivered.compareAndSet(false, true)) {
                            continuation.resumeWithException(
                                BrokerClientException("broker service binding died"),
                            )
                        }
                    }

                    override fun onNullBinding(name: ComponentName) {
                        if (delivered.compareAndSet(false, true)) {
                            safeUnbind(appContext, serviceConnection)
                            continuation.resumeWithException(
                                BrokerClientException("broker service returned a null binding"),
                            )
                        }
                    }
                }

            val intent = Intent(appContext, BrokerService::class.java)
            val didBind = appContext.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
            if (!didBind && delivered.compareAndSet(false, true)) {
                continuation.resumeWithException(BrokerClientException("bindService returned false"))
            }
            continuation.invokeOnCancellation {
                if (delivered.compareAndSet(false, true)) safeUnbind(appContext, serviceConnection)
            }
        }

    private suspend fun callControl(current: Connection, request: Bundle): Bundle =
        try {
            val reply = withContext(Dispatchers.IO) { current.remote.control(request) }
            if (!reply.getBoolean(BrokerContract.SUCCESS, true) ||
                reply.getString(BrokerContract.MESSAGE) == BrokerContract.REJECTED
            ) {
                throw BrokerRejectedException(
                    reply.getString(BrokerContract.REASON) ?: "worker rejected control request",
                )
            }
            reply
        } catch (error: Throwable) {
            if (error is DeadObjectException || error is RemoteException) {
                interrupt(current, "Binder control failed: ${error.javaClass.simpleName}")
            }
            throw error
        }

    private fun signalInterruption(token: UUID, reason: String) {
        scope.launch {
            currentConnection(token)?.let { interrupt(it, reason) }
        }
    }

    private fun interrupt(current: Connection, reason: String) {
        if (!current.interrupted.compareAndSet(false, true)) return
        synchronized(stateLock) {
            if (connection?.token == current.token) {
                connection = null
                interruptedIdentity = current.ready
            }
        }
        current.channel.close()
        current.bound.unbind(appContext)
        if (current.bound.dead.get()) {
            current.bound.unlinkDeathRecipient()
        } else {
            // EOF can beat Binder death notification. Keep the proxy and recipient
            // linked briefly after unbinding so that death remains observable.
            scope.launch {
                delay(BINDER_DEATH_RETENTION_MILLIS)
                current.bound.unlinkDeathRecipient()
            }
        }
        deathEvents.trySend(
            BrokerDeath(
                epoch = current.ready.epoch,
                workerPid = current.ready.workerPid,
                reason = reason,
                observedAtElapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos(),
            ),
        )
    }

    private fun currentConnection(token: UUID): Connection? =
        synchronized(stateLock) { connection?.takeIf { it.token == token } }

    private fun allocateRequestId(): Long = synchronized(stateLock) {
        check(nextRequestId != 0L) { "broker request ID space exhausted" }
        val value = nextRequestId
        nextRequestId += 1
        value
    }

    private fun decodeReady(reply: Bundle): BrokerReady {
        val message = reply.getString(BrokerContract.MESSAGE)
        if (message == BrokerContract.REJECTED || !reply.getBoolean(BrokerContract.SUCCESS, true)) {
            throw BrokerRejectedException(
                reply.getString(BrokerContract.REASON) ?: "worker rejected Hello",
            )
        }
        if (message != BrokerContract.READY) {
            throw OlpbProtocolException("Hello expected ready, received $message")
        }
        val protocolVersion = reply.getInt(BrokerContract.SELECTED_PROTOCOL_VERSION, -1)
        if (protocolVersion !in OlpbProtocol.MINIMUM_VERSION..OlpbProtocol.MAXIMUM_VERSION) {
            throw OlpbProtocolException("worker selected unsupported protocol $protocolVersion")
        }
        return BrokerReady(
            epoch = requiredUuid(reply, BrokerContract.EPOCH),
            workerPid = requiredPositiveInt(reply, BrokerContract.WORKER_PID),
            protocolVersion = protocolVersion,
            runtimeVersion = reply.getString(BrokerContract.RUNTIME_VERSION),
            abiVersion = reply.optionalLong(BrokerContract.ABI_VERSION),
            postgresMajorVersion = reply.optionalInt(BrokerContract.POSTGRES_MAJOR_VERSION),
            rootManifestDigest = reply.getString(BrokerContract.ROOT_MANIFEST_DIGEST),
        )
    }

    private class RequestAttempt(
        val epoch: UUID,
        val requestId: Long,
        var bytesMayHaveReachedWorker: Boolean = false,
    )

    private data class ActiveRequest(
        val generation: UUID,
        val epoch: UUID,
        val requestId: Long,
    )

    private class BoundService(
        val remote: IOliphauntBroker,
        val binder: IBinder,
        val serviceConnection: ServiceConnection,
        val deathRecipient: IBinder.DeathRecipient,
        val dead: AtomicBoolean,
        private val ready: AtomicReference<BrokerReady?>,
    ) {
        private val unbound = AtomicBoolean(false)
        private val unlinked = AtomicBoolean(false)

        fun setReady(value: BrokerReady) {
            check(ready.compareAndSet(null, value)) { "broker identity was already assigned" }
        }

        fun unbind(context: Context) {
            if (unbound.compareAndSet(false, true)) safeUnbind(context, serviceConnection)
        }

        fun unlinkDeathRecipient() {
            if (!unlinked.compareAndSet(false, true)) return
            try {
                binder.unlinkToDeath(deathRecipient, 0)
            } catch (_: Throwable) {
            }
        }

        fun close(context: Context) {
            unlinkDeathRecipient()
            unbind(context)
        }
    }

    private class Connection(
        val token: UUID,
        val bound: BoundService,
        val channel: HostDataChannel,
        val ready: BrokerReady,
    ) {
        val interrupted = AtomicBoolean(false)
        val remote: IOliphauntBroker
            get() = bound.remote
        val binder: IBinder
            get() = bound.binder

        fun close(context: Context) {
            channel.close()
            bound.close(context)
        }
    }

    private companion object {
        const val BINDER_DEATH_RETENTION_MILLIS = 2_000L
        const val MAXIMUM_RAW_RESPONSE_BYTES = 8 * 1024 * 1024
    }
}

private class HostDataChannel(private val descriptor: ParcelFileDescriptor) {
    private val closed = AtomicBoolean(false)

    suspend fun healthCheck(ready: BrokerReady) {
        write(
            OlpbFrame(
                protocolVersion = ready.protocolVersion,
                frameType = OlpbFrameType.PING,
                epoch = ready.epoch,
                requestId = 0,
            ),
        )
        val pong = read(ready.epoch)
        if (pong.header.frameType != OlpbFrameType.PONG ||
            pong.header.requestId != 0L ||
            pong.payload.isNotEmpty()
        ) {
            throw OlpbProtocolException("broker health check did not receive an empty Pong")
        }
    }

    suspend fun write(frame: OlpbFrame) = withContext(Dispatchers.IO) {
        val bytes = OlpbFrameCodec.encode(frame)
        var offset = 0
        while (offset < bytes.size) {
            try {
                val count = Os.write(descriptor.fileDescriptor, bytes, offset, bytes.size - offset)
                if (count <= 0) throw EOFException("broker socket write returned $count")
                offset += count
            } catch (error: ErrnoException) {
                if (error.errno == OsConstants.EINTR) continue
                throw IOException("broker socket write failed", error)
            }
        }
    }

    suspend fun read(expectedEpoch: UUID): OlpbFrame = withContext(Dispatchers.IO) {
        val headerBytes = readExactly(OlpbProtocol.HEADER_LENGTH)
        val header = OlpbFrameCodec.decodeHeader(headerBytes, expectedEpoch)
        val payload = readExactly(header.payloadLength)
        OlpbFrame(header, payload)
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        try {
            Os.shutdown(descriptor.fileDescriptor, OsConstants.SHUT_RDWR)
        } catch (_: Throwable) {
        }
        try {
            descriptor.close()
        } catch (_: Throwable) {
        }
    }

    private fun readExactly(count: Int): ByteArray {
        if (count == 0) return ByteArray(0)
        val bytes = ByteArray(count)
        var offset = 0
        while (offset < count) {
            val read =
                try {
                    Os.read(descriptor.fileDescriptor, bytes, offset, count - offset)
                } catch (error: ErrnoException) {
                    if (error.errno == OsConstants.EINTR) continue
                    throw IOException("broker socket read failed", error)
                }
            if (read == 0) {
                try {
                    descriptor.checkError()
                } catch (error: IOException) {
                    throw IOException("reliable broker socket reported peer failure", error)
                }
                throw EOFException("broker socket reached EOF")
            }
            offset += read
        }
        return bytes
    }
}

/** Requires a structurally complete backend stream ending in ReadyForQuery. */
private class BackendTerminalObserver {
    private val header = ByteArray(5)
    private var headerBytes = 0
    private var messageType: Byte = 0
    private var remainingBodyBytes: Int? = null
    private var bodyOffset = 0
    private var lastCompletedMessageType: Byte? = null
    private var lastReadyStatus: Byte? = null

    fun append(bytes: ByteArray) {
        var offset = 0
        while (offset < bytes.size) {
            if (remainingBodyBytes == null) {
                val count = minOf(5 - headerBytes, bytes.size - offset)
                bytes.copyInto(header, destinationOffset = headerBytes, startIndex = offset, endIndex = offset + count)
                headerBytes += count
                offset += count
                if (headerBytes != 5) continue

                messageType = header[0]
                val length =
                    ((header[1].toLong() and 0xff) shl 24) or
                        ((header[2].toLong() and 0xff) shl 16) or
                        ((header[3].toLong() and 0xff) shl 8) or
                        (header[4].toLong() and 0xff)
                if (length < 4 || length - 4 > Int.MAX_VALUE) {
                    throw OlpbProtocolException("invalid PostgreSQL backend message length $length")
                }
                val bodyLength = (length - 4).toInt()
                if (messageType == READY_FOR_QUERY && bodyLength != 1) {
                    throw OlpbProtocolException("ReadyForQuery has invalid body length $bodyLength")
                }
                headerBytes = 0
                remainingBodyBytes = bodyLength
                bodyOffset = 0
                if (bodyLength == 0) {
                    lastCompletedMessageType = messageType
                    remainingBodyBytes = null
                }
                continue
            }

            val remaining = remainingBodyBytes ?: continue
            val count = minOf(remaining, bytes.size - offset)
            if (messageType == READY_FOR_QUERY && bodyOffset == 0 && count > 0) {
                val status = bytes[offset]
                if (status != IDLE && status != IN_TRANSACTION && status != FAILED_TRANSACTION) {
                    throw OlpbProtocolException("ReadyForQuery has unknown transaction status")
                }
                lastReadyStatus = status
            }
            offset += count
            bodyOffset += count
            val next = remaining - count
            if (next == 0) lastCompletedMessageType = messageType
            remainingBodyBytes = next.takeIf { it != 0 }
        }
    }

    fun finish(): Byte {
        if (headerBytes != 0 || remainingBodyBytes != null) {
            throw OlpbProtocolException("Completed arrived inside a PostgreSQL backend message")
        }
        if (lastCompletedMessageType != READY_FOR_QUERY || lastReadyStatus == null) {
            throw OlpbProtocolException("Completed arrived without terminal ReadyForQuery")
        }
        return lastReadyStatus!!
    }

    private companion object {
        const val READY_FOR_QUERY: Byte = 0x5a
        const val IDLE: Byte = 0x49
        const val IN_TRANSACTION: Byte = 0x54
        const val FAILED_TRANSACTION: Byte = 0x45
    }
}

private fun validateFrontendRequest(bytes: ByteArray) {
    val assembler = OlpbFrontendRequestAssembler()
    assembler.append(bytes)
    assembler.finish()
}

private fun requireEmptyPayload(frame: OlpbFrame) {
    if (frame.payload.isNotEmpty()) {
        throw OlpbProtocolException("${frame.header.frameType} must not contain a payload")
    }
}

private fun requireReply(reply: Bundle, expected: String) {
    val message = reply.getString(BrokerContract.MESSAGE)
    if (message != expected) {
        throw OlpbProtocolException("expected $expected control reply, received $message")
    }
}

private fun requiredUuid(bundle: Bundle, key: String): UUID {
    val raw = bundle.getString(key) ?: throw OlpbProtocolException("missing $key")
    return try {
        UUID.fromString(raw)
    } catch (error: IllegalArgumentException) {
        throw OlpbProtocolException("invalid $key UUID")
    }
}

private fun requiredPositiveInt(bundle: Bundle, key: String): Int {
    if (!bundle.containsKey(key)) throw OlpbProtocolException("missing $key")
    val value = bundle.getInt(key)
    if (value <= 0) throw OlpbProtocolException("invalid $key $value")
    return value
}

private fun Bundle.optionalLong(key: String): Long? =
    if (containsKey(key)) getLong(key) else null

private fun Bundle.optionalInt(key: String): Int? =
    if (containsKey(key)) getInt(key) else null

private fun Bundle.optionalBoolean(key: String): Boolean? =
    if (containsKey(key)) getBoolean(key) else null

private fun safeUnbind(context: Context, connection: ServiceConnection) {
    try {
        context.unbindService(connection)
    } catch (_: IllegalArgumentException) {
    }
}
