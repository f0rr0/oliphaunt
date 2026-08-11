package dev.oliphaunt.androidbrokerspike

import android.content.Context
import android.os.Process
import android.os.SystemClock
import dev.oliphaunt.PostgresException
import dev.oliphaunt.parseQueryResponse
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs

internal class BrokerExperiment(private val context: Context) {
    private data class SustainedSocketStall(
        val first: BrokerDiagnostics,
        val second: BrokerDiagnostics,
        val transientCandidatesRejected: Int,
    )

    private val checks = linkedSetOf<String>()
    private val workerPids = mutableListOf<Int>()
    private val workerEpochs = mutableListOf<UUID>()
    private val faultEvidence = JSONArray()

    suspend fun run(runNonce: String, strategy: String): JSONObject {
        require(strategy == "full") { "unsupported strategy $strategy" }
        require(runNonce.matches(Regex("[A-Za-z0-9._-]{1,128}"))) { "run nonce is not portable" }

        val started = SystemClock.elapsedRealtimeNanos()
        val client = BrokerClient(context)
        try {
            val initial = client.connect()
            recordGeneration(initial)
            require(initial.workerPid != Process.myPid()) { "broker reused the host process" }
            checks += "separateProcess"

            require(queryText(client, "SELECT 'healthy'::text AS status", "status") == "healthy")
            checks += "healthySql"

            runCancellation(client)
            checks += "outOfBandCancel"

            client.execute(
                "CREATE TABLE IF NOT EXISTS android_broker_markers " +
                    "(marker text PRIMARY KEY, execution_count bigint NOT NULL DEFAULT 0, " +
                    "created_at timestamptz NOT NULL DEFAULT now())",
            )
            // Preserve old experimental PGDATA while making repeated ambiguous
            // mutations observable instead of hiding replay behind a key error.
            client.execute(
                "ALTER TABLE android_broker_markers ADD COLUMN IF NOT EXISTS " +
                    "execution_count bigint NOT NULL DEFAULT 0",
            )
            val stableMarker = "stable-$runNonce"
            client.execute(
                "INSERT INTO android_broker_markers(marker) VALUES ('$stableMarker') " +
                    "ON CONFLICT (marker) DO NOTHING",
            )

            runFailStop(
                client = client,
                fault = BrokerFault.EXECUTOR_DEADLOCK_WITH_FAIL_STOP,
                sql = "SELECT 'executor-must-not-complete'::text AS status",
                label = "executorDeadlock",
                requireNativePostgresOutputWitness = false,
            )
            checks += "executorDeadlockFailStop"

            runFailStop(
                client = client,
                fault = BrokerFault.NATIVE_FAIL_STOP_WATCHDOG,
                sql = BrokerContract.NATIVE_POSTGRES_OUTPUT_WITNESS_SQL,
                label = "nativePgSleep",
                requireNativePostgresOutputWitness = true,
            )
            checks += "nativePgSleepFailStop"

            val ambiguousMarker = "ambiguous-$runNonce"
            runFailStop(
                client = client,
                fault = BrokerFault.AFTER_NATIVE_SUCCESS_BEFORE_COMPLETED,
                sql =
                    "INSERT INTO android_broker_markers(marker, execution_count) " +
                        "VALUES ('$ambiguousMarker', 1) " +
                        "ON CONFLICT (marker) DO UPDATE SET execution_count = " +
                        "android_broker_markers.execution_count + 1",
                label = "afterCommitBeforeCompleted",
                requireNativePostgresOutputWitness = false,
            )
            val ambiguousExecutionCount =
                queryText(
                    client,
                    "SELECT execution_count::text AS count FROM android_broker_markers " +
                        "WHERE marker = '$ambiguousMarker'",
                    "count",
                ).toLong()
            val replayCount = ambiguousExecutionCount - 1L
            require(replayCount == 0L) {
                "ambiguous mutation executed $ambiguousExecutionCount times; replay count is $replayCount"
            }
            checks += "outcomeUnknownNoReplay"

            require(
                queryText(
                    client,
                    "SELECT count(*)::text AS count FROM android_broker_markers " +
                        "WHERE marker = '$stableMarker'",
                    "count",
                ) == "1",
            ) { "stable marker did not survive worker replacement" }

            val slow8 = runSlowReader(client, rows = 1_024, expectedMinimumBytes = 8L * 1_024 * 1_024)
            checks += "boundedSlowReader8MiB"
            val slow32 = runSlowReader(client, rows = 4_096, expectedMinimumBytes = 32L * 1_024 * 1_024)
            val acceptedWireBoundDeltaBytes =
                abs(
                    slow32.getLong("acceptedWireBytesUpperBound") -
                        slow8.getLong("acceptedWireBytesUpperBound"),
                )
            require(acceptedWireBoundDeltaBytes <= MAXIMUM_ENCODED_FRAME_BYTES) {
                "32 MiB and 8 MiB pre-read socket bounds differ by " +
                    "$acceptedWireBoundDeltaBytes bytes"
            }
            checks += "boundedSlowReader32MiB"
            checks += "persistentRecovery"
            checks += "binderDeath"
            checks += "freshPidAndEpoch"

            require(workerPids.distinct().size == workerPids.size) { "adjacent worker PIDs were not fresh" }
            require(workerEpochs.distinct().size == workerEpochs.size) { "worker epochs were not fresh" }

            return JSONObject()
                .put("schema", "oliphaunt-android-native-broker-spike-v1")
                .put("status", "PASS")
                .put("runNonce", runNonce)
                .put("strategy", strategy)
                .put("hostPid", Process.myPid())
                .put("workerPids", JSONArray(workerPids))
                .put("workerEpochs", JSONArray(workerEpochs.map(UUID::toString)))
                .put("checks", JSONArray(checks.toList()))
                .put("faultEvidence", faultEvidence)
                .put("slowReader8MiB", slow8)
                .put("slowReader32MiB", slow32)
                .put("acceptedWireBoundDeltaBytes", acceptedWireBoundDeltaBytes)
                .put("maximumAcceptedWireBoundDeltaBytes", MAXIMUM_ENCODED_FRAME_BYTES)
                .put("replayCount", replayCount)
                .put("persistentMarkerSurvived", true)
                .put("ambiguousExecutionCount", ambiguousExecutionCount)
                .put("elapsedMilliseconds", nanosToMillis(SystemClock.elapsedRealtimeNanos() - started))
                .put("environment", "android-emulator")
                .put("physicalDeviceEvidence", false)
        } finally {
            client.close()
        }
    }

    private suspend fun runCancellation(client: BrokerClient) = coroutineScope {
        val before = client.diagnostics()
        val query = async { client.execute("SELECT pg_sleep(60)") }
        val active = awaitNativeDispatch(client)
        require(active.workerPid == before.workerPid && active.epoch == before.epoch)
        // nativeDispatchStarted is published immediately before the JNI call.
        // Give PostgreSQL the same short settle window used by the native ABI
        // cancellation smoke so the cancel targets the in-flight pg_sleep.
        delay(250)
        require(client.cancel()) { "worker did not acknowledge cancellation" }
        val bytes = withTimeout(10_000) { query.await() }
        val sqlstate =
            try {
                parseQueryResponse(bytes)
                error("canceled pg_sleep unexpectedly completed")
            } catch (error: PostgresException) {
                error.postgresError.sqlstate
            }
        require(sqlstate == "57014") { "cancel SQLSTATE is $sqlstate" }
        val after = client.diagnostics()
        require(after.workerPid == before.workerPid && after.epoch == before.epoch)
        require(queryText(client, "SELECT 'healthy'::text AS status", "status") == "healthy")
    }

    private suspend fun runFailStop(
        client: BrokerClient,
        fault: BrokerFault,
        sql: String,
        label: String,
        requireNativePostgresOutputWitness: Boolean,
    ) = coroutineScope {
        val before = client.connect()
        val binderDeath = async { client.awaitBinderDeath(before, 10_000) }
        val interruption = async { client.awaitDeath(10_000) }
        client.armFault(fault)
        val requestStarted = SystemClock.elapsedRealtimeNanos()
        val request: Deferred<Result<ByteArray>> = async { runCatching { client.execute(sql) } }
        val witness =
            if (requireNativePostgresOutputWitness) {
                awaitNativePostgresOutputWitness(client, before)
            } else {
                null
            }
        witness?.let {
            require(it.workerPid == before.workerPid && it.epoch == before.epoch)
        }
        val terminal = withTimeout(10_000) { request.await() }
        val failure = terminal.exceptionOrNull()
        require(failure is BrokerOutcomeUnknownException) {
            "$label did not terminate as outcomeUnknown: ${failure?.javaClass?.simpleName}"
        }
        witness?.let {
            require(it.nativePostgresOutputWitnessRequestId == failure.requestId) {
                "native PostgreSQL-output witness request " +
                    "${it.nativePostgresOutputWitnessRequestId} " +
                    "does not match terminal request ${failure.requestId}"
            }
        }
        val binderDeathAt = withTimeout(10_000) { binderDeath.await() }
        val death = withTimeout(10_000) { interruption.await() }
        require(death.workerPid == before.workerPid && death.epoch == before.epoch)
        val recovered = reconnectEventually(client)
        require(recovered.workerPid != before.workerPid) { "$label reused worker PID" }
        require(recovered.epoch != before.epoch) { "$label reused worker epoch" }
        recordGeneration(recovered)
        require(queryText(client, "SELECT 'healthy'::text AS status", "status") == "healthy")
        faultEvidence.put(
            JSONObject()
                .put("label", label)
                .put("fault", fault.wireValue)
                .put("initialWorkerPid", before.workerPid)
                .put("initialEpoch", before.epoch.toString())
                .put("recoveredWorkerPid", recovered.workerPid)
                .put("recoveredEpoch", recovered.epoch.toString())
                .put("requestId", failure.requestId)
                .put("terminal", "outcomeUnknown")
                .put("nativeDispatchObserved", witness != null)
                .put("nativePostgresOutputWitnessObserved", witness != null)
                .apply {
                    witness?.let {
                        put(
                            "nativePostgresOutputWitnessRequestId",
                            it.nativePostgresOutputWitnessRequestId,
                        )
                        put(
                            "nativePostgresOutputWitnessBackendBytes",
                            it.nativePostgresOutputWitnessBackendBytes,
                        )
                        put(
                            "nativePostgresOutputWitnessElapsedRealtimeNanos",
                            it.nativePostgresOutputWitnessElapsedRealtimeNanos,
                        )
                        put(
                            "nativePostgresOutputWatchdogDelayMilliseconds",
                            BrokerContract.NATIVE_POSTGRES_OUTPUT_WATCHDOG_DELAY_MILLIS,
                        )
                    }
                }
                .put("binderDeathObserved", true)
                .put("binderDeathElapsedRealtimeNanos", binderDeathAt)
                .put("interruptionReason", death.reason)
                .put(
                    "requestToRecoveryMilliseconds",
                    nanosToMillis(SystemClock.elapsedRealtimeNanos() - requestStarted),
                ),
        )
    }

    private suspend fun runSlowReader(
        client: BrokerClient,
        rows: Int,
        expectedMinimumBytes: Long,
    ): JSONObject = coroutineScope {
        val pssSamples = mutableListOf<Long>()
        val rssSamples = mutableListOf<Long>()
        val started = SystemClock.elapsedRealtimeNanos()
        val baseline = client.diagnostics()
        captureMemorySample(baseline, pssSamples, rssSamples)
        require(baseline.socketNonBlockingProbeSucceeded) {
            "socket blocking-mode probe failed before the slow-reader request"
        }
        require(baseline.socketNonBlocking == false) { "broker data socket is nonblocking" }
        require(baseline.socketPollSucceeded) {
            "socket POLLOUT probe failed before the slow-reader request"
        }
        val baselineWritesCompleted =
            baseline.socketWritesCompleted
                ?: error("missing baseline completed-write count")
        val baselineCompletedEncodedBytes =
            baseline.socketCompletedEncodedBytes
                ?: error("missing baseline completed-byte count")
        val readGateCreatedNanos = SystemClock.elapsedRealtimeNanos()
        val firstReadRelease = CompletableDeferred<Unit>()
        val stream =
            async {
                client.executeSlowReader(
                    sql = "SELECT repeat('s', 8192) FROM generate_series(1, $rows)",
                    firstReadRelease = firstReadRelease,
                    perFrameDelayMillis = 0,
                )
            }

        var readGateReleasedNanos = 0L
        val sustainedStall =
            try {
                val evidence = awaitSustainedBlockedSocketWrite(client)
                captureMemorySample(evidence.first, pssSamples, rssSamples)
                captureMemorySample(evidence.second, pssSamples, rssSamples)
                require(!stream.isCompleted) {
                    "stream completed while the host-controlled read gate was closed"
                }
                evidence
            } finally {
                readGateReleasedNanos = SystemClock.elapsedRealtimeNanos()
                firstReadRelease.complete(Unit)
            }
        val firstStall = sustainedStall.first
        val secondStall = sustainedStall.second
        val firstSampleNanos =
            firstStall.sampleElapsedRealtimeNanos
                ?: error("first stall sample omitted its timestamp")
        val activeWriteStartedNanos =
            firstStall.socketActiveWriteStartedElapsedRealtimeNanos
                ?: error("first stall sample omitted its write start")
        val activeWriteSequence =
            firstStall.socketActiveWriteSequence
                ?: error("first stall sample omitted its write sequence")
        val activeWriteRequestId =
            firstStall.socketActiveWriteRequestId
                ?: error("first stall sample omitted its request ID")
        val activeWriteEncodedBytes =
            firstStall.socketActiveWriteEncodedBytes
                ?: error("first stall sample omitted its encoded size")
        val firstWritesCompleted =
            firstStall.socketWritesCompleted
                ?: error("first stall sample omitted its completed-write count")
        val firstCompletedEncodedBytes =
            firstStall.socketCompletedEncodedBytes
                ?: error("first stall sample omitted its completed-byte count")
        val secondSampleNanos =
            secondStall.sampleElapsedRealtimeNanos
                ?: error("second stall sample omitted its timestamp")
        require(readGateReleasedNanos >= secondSampleNanos) {
            "host read gate was released before the second stall sample"
        }
        require(secondStall.workerPid == baseline.workerPid && secondStall.epoch == baseline.epoch) {
            "worker identity changed during the no-read window"
        }
        require(secondStall.state == "running" && secondStall.nativeDispatchStarted) {
            "worker was not still executing during the no-read window"
        }
        require(secondStall.socketNonBlockingProbeSucceeded) {
            "socket blocking-mode probe failed during the sustained stall"
        }
        require(secondStall.socketNonBlocking == false) {
            "broker data socket became nonblocking"
        }
        require(secondStall.socketPollSucceeded && secondStall.socketWritableNow == false) {
            "socket became writable while the host was not reading"
        }
        require(secondStall.socketWriteInProgress) {
            "synchronous socket write was no longer in progress"
        }
        require(secondStall.socketActiveWriteFrameType == OlpbFrameType.RESPONSE_BYTES) {
            "blocked write was not a responseBytes frame"
        }
        require(secondStall.socketActiveWriteRequestId == activeWriteRequestId) {
            "active request changed during the socket stall"
        }
        require(secondStall.socketActiveWriteSequence == activeWriteSequence) {
            "socket writer advanced during the no-read interval"
        }
        require(secondStall.socketActiveWriteStartedElapsedRealtimeNanos == activeWriteStartedNanos) {
            "socket write start changed during the no-read interval"
        }
        require(secondStall.socketActiveWriteEncodedBytes == activeWriteEncodedBytes) {
            "socket write size changed during the no-read interval"
        }
        require(secondStall.socketWritesCompleted == firstWritesCompleted) {
            "completed-write count advanced during the no-read interval"
        }
        require(secondStall.socketCompletedEncodedBytes == firstCompletedEncodedBytes) {
            "completed socket bytes advanced during the no-read interval"
        }
        require(secondSampleNanos - firstSampleNanos >= REQUIRED_STALL_NANOS) {
            "same-write socket stall lasted less than $REQUIRED_STALL_MILLIS ms"
        }
        require(secondSampleNanos - activeWriteStartedNanos >= REQUIRED_STALL_NANOS) {
            "active synchronous write was younger than the required stall"
        }

        val completedEncodedDeltaBeforeRead =
            firstCompletedEncodedBytes - baselineCompletedEncodedBytes
        require(completedEncodedDeltaBeforeRead >= 0) {
            "completed socket-byte counter regressed"
        }
        require(firstWritesCompleted >= baselineWritesCompleted) {
            "completed socket-write counter regressed"
        }
        val acceptedWireBytesUpperBound =
            Math.addExact(completedEncodedDeltaBeforeRead, activeWriteEncodedBytes.toLong())
        require(
            Math.addExact(acceptedWireBytesUpperBound, MAXIMUM_ENCODED_FRAME_BYTES) <
                expectedMinimumBytes,
        ) {
            "pre-read accepted-wire bound $acceptedWireBytesUpperBound is not below the " +
                "$expectedMinimumBytes-byte response by one maximum frame"
        }

        val stats =
            withTimeout(SLOW_READER_DRAIN_TIMEOUT_MILLIS) {
                while (!stream.isCompleted) {
                    runCatching { client.diagnostics() }.getOrNull()?.let {
                        captureMemorySample(it, pssSamples, rssSamples)
                    }
                    delay(100)
                }
                stream.await()
            }
        val afterDrain = client.diagnostics()
        captureMemorySample(afterDrain, pssSamples, rssSamples)
        require(stats.responseBytes >= expectedMinimumBytes) {
            "slow reader returned only ${stats.responseBytes} bytes"
        }
        require(stats.responseChunks > 1) { "slow reader did not observe multiple chunks" }
        require(stats.workerPid == baseline.workerPid && stats.epoch == baseline.epoch) {
            "slow reader completed in a different worker generation"
        }
        require(stats.requestId == activeWriteRequestId) {
            "completed request does not match the blocked write"
        }
        val afterDrainWritesCompleted =
            afterDrain.socketWritesCompleted
                ?: error("post-drain diagnostics omitted the completed-write count")
        val afterDrainCompletedEncodedBytes =
            afterDrain.socketCompletedEncodedBytes
                ?: error("post-drain diagnostics omitted the completed-byte count")
        require(afterDrainWritesCompleted >= activeWriteSequence) {
            "the blocked socket write did not complete after reads resumed"
        }
        require(
            afterDrainCompletedEncodedBytes - baselineCompletedEncodedBytes >= stats.responseBytes,
        ) {
            "post-drain encoded-byte count is smaller than the response payload"
        }
        require(pssSamples.isNotEmpty()) { "slow reader did not capture a PSS sample" }
        require(rssSamples.isNotEmpty()) { "slow reader did not capture an RSS sample" }
        val minimumPssBytes = pssSamples.minOrNull() ?: error("PSS sample invariant failed")
        val maximumPssBytes = pssSamples.maxOrNull() ?: error("PSS sample invariant failed")
        val minimumRssBytes = rssSamples.minOrNull() ?: error("RSS sample invariant failed")
        val maximumRssBytes = rssSamples.maxOrNull() ?: error("RSS sample invariant failed")
        JSONObject()
            .put("rows", rows)
            .put("responseBytes", stats.responseBytes)
            .put("responseChunks", stats.responseChunks)
            .put("elapsedMilliseconds", nanosToMillis(SystemClock.elapsedRealtimeNanos() - started))
            .put("sampleCount", pssSamples.size)
            .put("maximumPssBytes", maximumPssBytes)
            .put("minimumPssBytes", minimumPssBytes)
            .put("pssSpanBytes", maximumPssBytes - minimumPssBytes)
            .put("maximumRssBytes", maximumRssBytes)
            .put("minimumRssBytes", minimumRssBytes)
            .put("rssSpanBytes", maximumRssBytes - minimumRssBytes)
            .put("readReleaseMode", "hostControlledGate")
            .put("readGateReleasedAfterSecondSample", true)
            .put("readGateCreatedElapsedRealtimeNanos", readGateCreatedNanos)
            .put("readGateReleasedElapsedRealtimeNanos", readGateReleasedNanos)
            .put(
                "readGateHeldMilliseconds",
                nanosToMillis(readGateReleasedNanos - readGateCreatedNanos),
            )
            .put("stableStallSearchTimeoutMilliseconds", STALL_DISCOVERY_TIMEOUT_MILLIS)
            .put("stableStallPollIntervalMilliseconds", STALL_POLL_INTERVAL_MILLIS)
            .put(
                "transientStallCandidatesRejected",
                sustainedStall.transientCandidatesRejected,
            )
            .put("slowReaderDrainTimeoutMilliseconds", SLOW_READER_DRAIN_TIMEOUT_MILLIS)
            .put("requiredStallMilliseconds", REQUIRED_STALL_MILLIS)
            .put(
                "observedSameWriteStallMilliseconds",
                nanosToMillis(secondSampleNanos - firstSampleNanos),
            )
            .put(
                "activeWriteAgeAtSecondSampleMilliseconds",
                nanosToMillis(secondSampleNanos - activeWriteStartedNanos),
            )
            .put("socketNonBlockingProbeSucceeded", true)
            .put("socketNonBlocking", false)
            .put("firstSocketPollSucceeded", firstStall.socketPollSucceeded)
            .put("secondSocketPollSucceeded", secondStall.socketPollSucceeded)
            .put("firstSocketWritableNow", firstStall.socketWritableNow)
            .put("secondSocketWritableNow", secondStall.socketWritableNow)
            .put("firstSocketWriteInProgress", firstStall.socketWriteInProgress)
            .put("secondSocketWriteInProgress", secondStall.socketWriteInProgress)
            .put("firstSampleElapsedRealtimeNanos", firstSampleNanos)
            .put("secondSampleElapsedRealtimeNanos", secondSampleNanos)
            .put("activeWriteStartedElapsedRealtimeNanos", activeWriteStartedNanos)
            .put("activeWriteRequestId", activeWriteRequestId)
            .put("activeWriteFrameType", OlpbFrameType.RESPONSE_BYTES.name)
            .put("firstActiveWriteSequence", activeWriteSequence)
            .put("secondActiveWriteSequence", secondStall.socketActiveWriteSequence)
            .put("activeWriteEncodedBytes", activeWriteEncodedBytes)
            .put("baselineWritesCompleted", baselineWritesCompleted)
            .put("firstWritesCompleted", firstWritesCompleted)
            .put("secondWritesCompleted", secondStall.socketWritesCompleted)
            .put("afterDrainWritesCompleted", afterDrainWritesCompleted)
            .put("baselineCompletedEncodedBytes", baselineCompletedEncodedBytes)
            .put("firstCompletedEncodedBytes", firstCompletedEncodedBytes)
            .put("secondCompletedEncodedBytes", secondStall.socketCompletedEncodedBytes)
            .put("afterDrainCompletedEncodedBytes", afterDrainCompletedEncodedBytes)
            .put("completedEncodedDeltaBeforeRead", completedEncodedDeltaBeforeRead)
            .put("acceptedWireBytesUpperBound", acceptedWireBytesUpperBound)
            .put("maximumEncodedFrameBytes", MAXIMUM_ENCODED_FRAME_BYTES)
            .put(
                "requestedSocketSendBufferBytes",
                afterDrain.socketSendBufferBytes ?: -1,
            )
    }

    private suspend fun awaitSustainedBlockedSocketWrite(
        client: BrokerClient,
    ): SustainedSocketStall =
        withTimeout(STALL_DISCOVERY_TIMEOUT_MILLIS) {
            var candidate: BrokerDiagnostics? = null
            var transientCandidatesRejected = 0
            while (true) {
                val diagnostics = client.diagnostics()
                if (!diagnostics.isBlockedResponseWriteCandidate()) {
                    if (candidate != null) transientCandidatesRejected += 1
                    candidate = null
                    delay(STALL_POLL_INTERVAL_MILLIS)
                    continue
                }

                val first = candidate
                if (first == null || !first.isSameBlockedWriteAs(diagnostics)) {
                    if (first != null) transientCandidatesRejected += 1
                    candidate = diagnostics
                    delay(STALL_POLL_INTERVAL_MILLIS)
                    continue
                }

                val firstSample = first.sampleElapsedRealtimeNanos
                    ?: error("blocked-write candidate omitted its timestamp")
                val currentSample = diagnostics.sampleElapsedRealtimeNanos
                    ?: error("blocked-write sample omitted its timestamp")
                if (currentSample - firstSample >= REQUIRED_STALL_NANOS) {
                    return@withTimeout SustainedSocketStall(
                        first = first,
                        second = diagnostics,
                        transientCandidatesRejected = transientCandidatesRejected,
                    )
                }
                delay(STALL_POLL_INTERVAL_MILLIS)
            }
            error("unreachable")
        }

    private fun BrokerDiagnostics.isBlockedResponseWriteCandidate(): Boolean =
        state == "running" &&
            nativeDispatchStarted &&
            activeRequestId != null &&
            socketNonBlockingProbeSucceeded &&
            socketNonBlocking == false &&
            socketPollSucceeded &&
            socketWritableNow == false &&
            socketWriteInProgress &&
            socketActiveWriteFrameType == OlpbFrameType.RESPONSE_BYTES &&
            socketActiveWriteSequence != null &&
            socketActiveWriteRequestId == activeRequestId &&
            socketActiveWriteStartedElapsedRealtimeNanos != null &&
            socketActiveWriteEncodedBytes != null &&
            socketWritesCompleted != null &&
            socketCompletedEncodedBytes != null &&
            sampleElapsedRealtimeNanos != null

    private fun BrokerDiagnostics.isSameBlockedWriteAs(other: BrokerDiagnostics): Boolean =
        workerPid == other.workerPid &&
            epoch == other.epoch &&
            activeRequestId == other.activeRequestId &&
            socketWritableNow == other.socketWritableNow &&
            socketActiveWriteSequence == other.socketActiveWriteSequence &&
            socketActiveWriteRequestId == other.socketActiveWriteRequestId &&
            socketActiveWriteFrameType == other.socketActiveWriteFrameType &&
            socketActiveWriteStartedElapsedRealtimeNanos ==
                other.socketActiveWriteStartedElapsedRealtimeNanos &&
            socketActiveWriteEncodedBytes == other.socketActiveWriteEncodedBytes &&
            socketWritesCompleted == other.socketWritesCompleted &&
            socketCompletedEncodedBytes == other.socketCompletedEncodedBytes

    private fun captureMemorySample(
        diagnostics: BrokerDiagnostics,
        pssSamples: MutableList<Long>,
        rssSamples: MutableList<Long>,
    ) {
        diagnostics.currentPssBytes?.takeIf { it > 0 }?.let(pssSamples::add)
        diagnostics.currentRssBytes?.takeIf { it > 0 }?.let(rssSamples::add)
    }

    private suspend fun awaitNativeDispatch(client: BrokerClient): BrokerDiagnostics =
        withTimeout(5_000) {
            while (true) {
                val diagnostics = client.diagnostics()
                if (diagnostics.activeRequestId != null &&
                    diagnostics.activeRequestId != 0L &&
                    diagnostics.nativeDispatchStarted
                ) {
                    return@withTimeout diagnostics
                }
                delay(10)
            }
            error("unreachable")
        }

    private suspend fun awaitNativePostgresOutputWitness(
        client: BrokerClient,
        expectedGeneration: BrokerReady,
    ): BrokerDiagnostics =
        withTimeout(10_000) {
            while (true) {
                val diagnostics = client.diagnostics()
                require(
                    diagnostics.workerPid == expectedGeneration.workerPid &&
                        diagnostics.epoch == expectedGeneration.epoch,
                ) { "native PostgreSQL-output witness moved to a different worker generation" }
                if (diagnostics.nativePostgresOutputWitnessObserved) {
                    require(diagnostics.nativeDispatchStarted) {
                        "native PostgreSQL-output witness was published before native dispatch"
                    }
                    val activeRequestId =
                        requireNotNull(diagnostics.activeRequestId) {
                            "native PostgreSQL-output witness has no active request"
                        }
                    val witnessRequestId =
                        requireNotNull(diagnostics.nativePostgresOutputWitnessRequestId) {
                            "native PostgreSQL-output witness has no request marker"
                        }
                    require(witnessRequestId == activeRequestId) {
                        "native PostgreSQL-output witness request $witnessRequestId " +
                            "is not active request $activeRequestId"
                    }
                    val backendBytes =
                        requireNotNull(diagnostics.nativePostgresOutputWitnessBackendBytes) {
                            "native PostgreSQL-output witness has no backend-byte count"
                        }
                    require(
                        backendBytes >
                            BrokerContract.NATIVE_POSTGRES_OUTPUT_WITNESS_THRESHOLD_BYTES,
                    ) {
                        "native PostgreSQL-output witness followed only $backendBytes backend bytes"
                    }
                    requireNotNull(diagnostics.nativePostgresOutputWitnessElapsedRealtimeNanos) {
                        "native PostgreSQL-output witness has no monotonic timestamp"
                    }
                    return@withTimeout diagnostics
                }
                delay(10)
            }
            error("unreachable")
        }

    private suspend fun reconnectEventually(client: BrokerClient): BrokerReady =
        withTimeout(15_000) {
            var lastError: Throwable? = null
            while (true) {
                try {
                    return@withTimeout client.reconnect()
                } catch (error: Throwable) {
                    lastError = error
                    delay(100)
                }
            }
            throw lastError ?: IllegalStateException("recovery did not run")
        }

    private suspend fun queryText(client: BrokerClient, sql: String, column: String): String {
        val result = parseQueryResponse(client.execute(sql))
        return result.getText(0, column) ?: error("query returned NULL for $column")
    }

    private fun recordGeneration(ready: BrokerReady) {
        require(ready.workerPid > 0)
        require(ready.workerPid !in workerPids) { "worker PID ${ready.workerPid} was already observed" }
        require(ready.epoch !in workerEpochs) { "worker epoch ${ready.epoch} was already observed" }
        workerPids += ready.workerPid
        workerEpochs += ready.epoch
    }

    private fun nanosToMillis(nanos: Long): Long = nanos / 1_000_000L

    private companion object {
        const val REQUIRED_STALL_MILLIS = 300L
        const val REQUIRED_STALL_NANOS = REQUIRED_STALL_MILLIS * 1_000_000L
        const val STALL_DISCOVERY_TIMEOUT_MILLIS = 10_000L
        const val STALL_POLL_INTERVAL_MILLIS = 10L
        const val SLOW_READER_DRAIN_TIMEOUT_MILLIS = 30_000L
        const val MAXIMUM_ENCODED_FRAME_BYTES =
            (OlpbProtocol.HEADER_LENGTH + OlpbProtocol.MAXIMUM_FRAME_PAYLOAD).toLong()
    }
}
