package dev.oliphaunt.androidbrokerspike

import android.os.Bundle
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

/** Primitive-only Binder schema shared by the spike host and private service. */
internal object BrokerContract {
    const val EXPECTED_ABI = 6L
    const val ROOT_ID = "default"
    const val STARTUP_CONFIGURATION_DIGEST = "android-native-broker-spike-v1"

    const val MESSAGE = "message"
    const val MINIMUM_PROTOCOL_VERSION = "minimumProtocolVersion"
    const val MAXIMUM_PROTOCOL_VERSION = "maximumProtocolVersion"
    const val SELECTED_PROTOCOL_VERSION = "selectedProtocolVersion"
    const val EXPECTED_ABI_KEY = "expectedABI"
    const val EXPECTED_RUNTIME_VERSION = "expectedRuntimeVersion"
    const val ROOT_ID_KEY = "rootID"
    const val STARTUP_CONFIGURATION_DIGEST_KEY = "startupConfigurationDigest"
    const val REQUESTED_CAPABILITIES = "requestedCapabilities"
    const val EPOCH = "epoch"
    const val REQUEST_ID = "requestID"
    const val WORKER_PID = "workerPID"
    const val RUNTIME_VERSION = "runtimeVersion"
    const val ABI_VERSION = "abiVersion"
    const val POSTGRES_MAJOR_VERSION = "postgresMajorVersion"
    const val ROOT_MANIFEST_DIGEST = "rootManifestDigest"
    const val ACTUAL_CAPABILITIES = "actualCapabilities"
    const val ACTUAL_RUNTIME_CONFIGURATION = "actualRuntimeConfiguration"
    const val SUCCESS = "success"
    const val REASON = "reason"
    const val FAULT = "fault"
    const val STATE = "state"
    const val ACTIVE_REQUEST_ID = "activeRequestID"
    const val NATIVE_DISPATCH_STARTED = "nativeDispatchStarted"
    const val NATIVE_POSTGRES_OUTPUT_WITNESS_OBSERVED =
        "nativePostgresOutputWitnessObserved"
    const val NATIVE_POSTGRES_OUTPUT_WITNESS_REQUEST_ID =
        "nativePostgresOutputWitnessRequestID"
    const val NATIVE_POSTGRES_OUTPUT_WITNESS_BACKEND_BYTES =
        "nativePostgresOutputWitnessBackendBytes"
    const val NATIVE_POSTGRES_OUTPUT_WITNESS_ELAPSED_REALTIME_NANOS =
        "nativePostgresOutputWitnessElapsedRealtimeNanos"
    const val TRANSACTION_STATUS = "transactionStatus"
    const val CURRENT_PSS_BYTES = "currentPssBytes"
    const val CURRENT_RSS_BYTES = "currentRssBytes"
    const val REQUESTED_SOCKET_SEND_BUFFER_BYTES = "requestedSocketSendBufferBytes"
    const val DIAGNOSTICS_SAMPLE_ELAPSED_REALTIME_NANOS =
        "diagnosticsSampleElapsedRealtimeNanos"
    const val SOCKET_NON_BLOCKING_PROBE_SUCCEEDED = "socketNonBlockingProbeSucceeded"
    const val SOCKET_NON_BLOCKING = "socketNonBlocking"
    const val SOCKET_POLL_SUCCEEDED = "socketPollSucceeded"
    const val SOCKET_WRITABLE_NOW = "socketWritableNow"
    const val SOCKET_WRITE_IN_PROGRESS = "socketWriteInProgress"
    const val SOCKET_ACTIVE_WRITE_SEQUENCE = "socketActiveWriteSequence"
    const val SOCKET_ACTIVE_WRITE_REQUEST_ID = "socketActiveWriteRequestID"
    const val SOCKET_ACTIVE_WRITE_FRAME_TYPE = "socketActiveWriteFrameType"
    const val SOCKET_ACTIVE_WRITE_STARTED_ELAPSED_REALTIME_NANOS =
        "socketActiveWriteStartedElapsedRealtimeNanos"
    const val SOCKET_ACTIVE_WRITE_ENCODED_BYTES = "socketActiveWriteEncodedBytes"
    const val SOCKET_WRITES_COMPLETED = "socketWritesCompleted"
    const val SOCKET_COMPLETED_ENCODED_BYTES = "socketCompletedEncodedBytes"
    // BrokerClient keeps its experimental model name while the wire key and
    // published evidence state honestly that this is the requested value.
    const val SOCKET_SEND_BUFFER_BYTES = REQUESTED_SOCKET_SEND_BUFFER_BYTES

    const val HELLO = "hello"
    const val READY = "ready"
    const val REJECTED = "rejected"
    const val CANCEL = "cancel"
    const val CANCEL_OBSERVED = "cancelObserved"
    const val DIAGNOSTICS = "diagnostics"
    const val INJECT_FAULT = "injectFault"
    const val DETACH = "detach"

    const val NATIVE_POSTGRES_OUTPUT_WITNESS_THRESHOLD_BYTES = 4L * 1_024 * 1_024
    const val NATIVE_POSTGRES_OUTPUT_WATCHDOG_DELAY_MILLIS = 2_000L
    const val NATIVE_POSTGRES_OUTPUT_WITNESS_SQL =
        "SELECT repeat('w', 8192) AS witness FROM generate_series(1, 513) " +
            "UNION ALL SELECT ''::text FROM pg_sleep(60) AS blocker(ignored)"

    val requestedCapabilities =
        arrayOf(
            "processIsolated",
            "crashRestartable",
            "sameRootLogicalReopen",
            "protocolRaw",
            "protocolStream",
            "queryCancel",
        )

    fun hello(): Bundle =
        Bundle().apply {
            putString(MESSAGE, HELLO)
            putInt(MINIMUM_PROTOCOL_VERSION, OlpbProtocol.MINIMUM_VERSION)
            putInt(MAXIMUM_PROTOCOL_VERSION, OlpbProtocol.MAXIMUM_VERSION)
            putLong(EXPECTED_ABI_KEY, EXPECTED_ABI)
            putString(ROOT_ID_KEY, ROOT_ID)
            putString(STARTUP_CONFIGURATION_DIGEST_KEY, STARTUP_CONFIGURATION_DIGEST)
            putStringArray(REQUESTED_CAPABILITIES, requestedCapabilities)
        }

    fun control(
        message: String,
        epoch: UUID,
        requestId: Long? = null,
        fault: BrokerFault? = null,
    ): Bundle =
        Bundle().apply {
            putString(MESSAGE, message)
            putString(EPOCH, epoch.toString())
            requestId?.let { putLong(REQUEST_ID, it) }
            fault?.let { putString(FAULT, it.wireValue) }
        }

    fun simpleQuery(sql: String): ByteArray {
        require('\u0000' !in sql) { "SQL must not contain NUL bytes" }
        val body = sql.toByteArray(Charsets.UTF_8) + byteArrayOf(0)
        val messageLength = body.size + 4
        return ByteBuffer
            .allocate(1 + 4 + body.size)
            .order(ByteOrder.BIG_ENDIAN)
            .apply {
                put('Q'.code.toByte())
                putInt(messageLength)
                put(body)
            }.array()
    }
}

internal enum class BrokerFault(
    val wireValue: String,
) {
    EXECUTOR_DEADLOCK_WITH_FAIL_STOP("executorDeadlockWithFailStop"),
    NATIVE_FAIL_STOP_WATCHDOG("nativeFailStopWatchdog"),
    AFTER_NATIVE_SUCCESS_BEFORE_COMPLETED("afterNativeSuccessBeforeCompleted"),
}
