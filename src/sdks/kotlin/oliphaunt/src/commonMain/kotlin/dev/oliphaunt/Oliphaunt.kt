package dev.oliphaunt

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

public data class PostgresStartupGuc(
    val name: String,
    val value: String,
)

internal sealed interface EngineStorage {
    data object TemporaryDirectory : EngineStorage

    data class Directory(
        val path: String,
    ) : EngineStorage
}

internal data class EngineConfig(
    val storage: EngineStorage = EngineStorage.TemporaryDirectory,
    val startupGucs: List<PostgresStartupGuc> = emptyList(),
    val username: String? = null,
    val database: String? = null,
    val extensions: List<String> = emptyList(),
)

internal fun validateStartupIdentity(
    value: String?,
    label: String,
) {
    if (value == null) return
    if (value.isBlank()) throw OliphauntException("$label must not be empty")
    if (value.any { it.code == 0 }) throw OliphauntException("$label must not contain NUL bytes")
}

internal fun validateStartupGucs(gucs: List<PostgresStartupGuc>) {
    gucs.forEach { guc ->
        val name = guc.name.trim()
        if (name.isEmpty()) throw OliphauntException("PostgreSQL startup GUC name must not be empty")
        if (name.any { it.code == 0 } || guc.value.any { it.code == 0 }) {
            throw OliphauntException("PostgreSQL startup GUC must not contain NUL bytes")
        }
        if (!portableStartupGucName.matches(name)) {
            throw OliphauntException(
                "PostgreSQL startup GUC name '${guc.name}': each dot-separated component must start " +
                    "with an ASCII letter or '_', followed by ASCII letters, digits, '_', or '\$'",
            )
        }
        if (name.equals("config_file", ignoreCase = true) || name.equals("data_directory", ignoreCase = true)) {
            throw OliphauntException(
                "Oliphaunt owns PostgreSQL startup GUC '$name'; configure the database through Oliphaunt's storage API",
            )
        }
    }
}

private val portableStartupGucName = Regex("[A-Za-z_][A-Za-z0-9_\$]*(\\.[A-Za-z_][A-Za-z0-9_\$]*)*")

private val portableExtensionId = Regex("[A-Za-z0-9._-]{1,128}")

internal fun validateGeneratedExtensionIds(
    extensions: Collection<String>,
    label: String = "Kotlin Oliphaunt extension id",
): List<String> = extensions
    .map(String::trim)
    .filter(String::isNotEmpty)
    .onEach { extension ->
        if (!portableExtensionId.matches(extension)) {
            throw OliphauntException(
                "$label '$extension' must contain 1 to 128 ASCII letters, digits, '.', '_' or '-'",
            )
        }
        if (!generatedExtensionSqlNameExists(extension)) throw OliphauntException("unknown $label '$extension'")
    }

internal fun EngineConfig.postgresStartupArgs(sharedPreloadLibraries: Collection<String> = emptyList()): List<String> {
    val requiredPreloads = sharedPreloadLibraries.distinct().sorted()
    if (requiredPreloads.isEmpty()) {
        return startupGucs.flatMap { guc -> listOf("-c", "${guc.name.trim()}=${guc.value}") }
    }

    val configuredPreloads =
        startupGucs
            .lastOrNull { it.name.trim().equals("shared_preload_libraries", ignoreCase = true) }
            ?.value
            .orEmpty()
    val mergedPreloads = linkedSetOf<String>()
    configuredPreloads
        .split(',')
        .map(String::trim)
        .filter(String::isNotEmpty)
        .forEach(mergedPreloads::add)
    requiredPreloads.forEach(mergedPreloads::add)

    return startupGucs
        .filterNot { it.name.trim().equals("shared_preload_libraries", ignoreCase = true) }
        .flatMap { guc -> listOf("-c", "${guc.name.trim()}=${guc.value}") } +
        listOf("-c", "shared_preload_libraries=${mergedPreloads.joinToString(",")}")
}

internal fun validateDatabaseStorage(storage: EngineStorage) {
    if (storage is EngineStorage.Directory) validateDirectoryPath(storage.path, "database storage directory")
}

internal fun validateDirectoryPath(
    path: String,
    label: String,
) {
    if (path.isBlank()) throw OliphauntException("$label must not be empty")
    if (path.any { it.code == 0 }) throw OliphauntException("$label must not contain NUL bytes")
}

internal fun simpleQueryProtocol(sql: String): ByteArray {
    if (sql.any { it.code == 0 }) throw OliphauntException("simple query SQL must not contain NUL bytes")
    val body = sql.encodeToByteArray() + byteArrayOf(0)
    val length = body.size + 4
    return byteArrayOf(
        'Q'.code.toByte(),
        ((length ushr 24) and 0xff).toByte(),
        ((length ushr 16) and 0xff).toByte(),
        ((length ushr 8) and 0xff).toByte(),
        (length and 0xff).toByte(),
    ) + body
}

internal interface OliphauntEngine {
    suspend fun open(config: EngineConfig): OliphauntSession

    suspend fun restore(
        destination: String,
        bytes: ByteArray,
    )
}

internal interface OliphauntSession {
    suspend fun execProtocolRaw(request: ByteArray): ByteArray

    suspend fun execProtocolRawStream(
        request: ByteArray,
        onChunk: (ByteArray) -> Unit,
    ): ProtocolStreamOutcome

    suspend fun backup(): ByteArray

    suspend fun cancel()

    suspend fun close()
}

internal sealed interface ProtocolStreamOutcome {
    data object Complete : ProtocolStreamOutcome

    class CallbackAborted(
        val error: Throwable,
    ) : ProtocolStreamOutcome
}

public open class OliphauntException : RuntimeException {
    public constructor(message: String) : super(message)

    internal constructor(message: String, cause: Throwable) : super(message, cause)
}

public class OliphauntTransactionRollbackException internal constructor(
    public val callbackError: Throwable,
    public val rollbackError: Throwable,
) : OliphauntException(
    "transaction callback failed and automatic ROLLBACK did not complete; " +
        "close and reopen the database; callback: $callbackError; rollback: $rollbackError",
    callbackError,
) {
    init {
        addSuppressed(rollbackError)
    }
}

public class OliphauntTransactionDatabaseException internal constructor(
    public val callbackError: Throwable,
    public val databaseError: Throwable,
) : OliphauntException(
    "transaction callback failed after an independent database failure; " +
        "close and reopen the database; callback: $callbackError; database: $databaseError",
    callbackError,
) {
    init {
        addSuppressed(databaseError)
    }
}

public class PostgresException(
    public val postgresError: PostgresError,
) : OliphauntException(postgresError.toString())

public class OliphauntDatabase private constructor(
    private val session: OliphauntSession,
) {
    private sealed interface TransactionCompletion {
        data object Active : TransactionCompletion

        data object RollingBack : TransactionCompletion

        data object Committing : TransactionCompletion

        data object RolledBack : TransactionCompletion

        data object Committed : TransactionCompletion

        data class Failed(
            val message: String,
        ) : TransactionCompletion
    }

    private data class ActiveTransaction(
        val token: Long,
        val lease: TransactionLease,
        var completion: TransactionCompletion = TransactionCompletion.Active,
        var databaseFailure: Throwable? = null,
        var settlementCompletion: Deferred<Unit>? = null,
        var settlementFailure: Throwable? = null,
    )

    internal class TransactionLease {
        @Volatile
        var closed: Boolean = false
    }

    private data class Admission(
        val predecessor: Deferred<Unit>,
        val completion: CompletableDeferred<Unit>,
    )

    private data class BeginAdmission(
        val token: Long,
        val lease: TransactionLease,
        val operation: Admission,
    )

    private data class TransactionSeal(
        val completion: TransactionCompletion,
        val commitAdmission: Admission? = null,
        val rollbackAdmission: Admission? = null,
        val settlementCompletion: Deferred<Unit>? = null,
        val databaseFailure: Throwable? = null,
        val settlementFailure: Throwable? = null,
    )

    private val stateMutex = Mutex()
    private var admissionTail: Deferred<Unit> = CompletableDeferred(Unit)
    private var closing = false
    private var closeTeardownStarted = false
    private var activeCancellationCount = 0
    private var cancellationDrainWaiter: CompletableDeferred<Unit>? = null

    @Volatile
    private var closed = false

    @Volatile
    private var protocolStreamCallbackActive = false

    private var poisonedMessage: String? = null
    private var activeTransaction: ActiveTransaction? = null
    private var nextTransactionToken = 1L

    public val isClosed: Boolean get() = closed

    public suspend fun execProtocolRaw(request: ByteArray): ByteArray = execProtocolRawOwned(request.copyOf())

    public suspend fun execProtocolRawStream(
        request: ByteArray,
        onChunk: (ByteArray) -> Unit,
    ): Unit = execProtocolRawStreamOwned(request.copyOf(), onChunk)

    public suspend fun backup(): ByteArray = runAdmitted(admitOperation(transactionToken = null)) {
        ensureAdmittedOperationUsable()
        session.backup().copyOf()
    }

    public suspend fun <T> transaction(block: suspend (OliphauntTransaction) -> T): T {
        val beginAdmission =
            stateMutex.withLock {
                ensureNoProtocolStreamCallbackReentry()
                ensureOpenLocked()
                if (activeTransaction != null) throw OliphauntException(sessionPinnedMessage)
                val allocated = nextTransactionToken
                nextTransactionToken = if (nextTransactionToken == Long.MAX_VALUE) 1L else nextTransactionToken + 1
                val lease = TransactionLease()
                activeTransaction = ActiveTransaction(allocated, lease)
                BeginAdmission(allocated, lease, enqueueOperationLocked())
            }
        val token = beginAdmission.token
        val transaction = OliphauntTransaction(this, token, beginAdmission.lease)

        val result: T
        var began = false
        try {
            executeBegin(token, beginAdmission.operation) {
                // Record the protocol boundary in the non-cancellable admitted
                // phase. Cancellation delivered after BEGIN must roll it back,
                // while cancellation in the queue must skip BEGIN entirely.
                began = true
            }
            currentCoroutineContext().ensureActive()
            result = block(transaction)
            currentCoroutineContext().ensureActive()
        } catch (callbackError: Throwable) {
            finishFailedTransaction(token, transaction, began, callbackError)
        }

        return finishSuccessfulTransaction(token, transaction, result)
    }

    private suspend fun finishFailedTransaction(
        token: Long,
        transaction: OliphauntTransaction,
        began: Boolean,
        callbackError: Throwable,
    ): Nothing = withContext(NonCancellable) {
        transaction.expire()
        var rollbackError: Throwable? = null
        var state = if (began) planCallbackFailureSettlement(token) else snapshotTransaction(token)
        if (began && state.completion == TransactionCompletion.RollingBack) {
            val rollbackAdmission = state.rollbackAdmission
            if (rollbackAdmission == null) {
                state = awaitRollbackSettlement(token, state)
            } else {
                try {
                    executeRollbackTransaction(token, rollbackAdmission)
                } catch (_: Throwable) {
                    // State below distinguishes a failed rollback exchange from
                    // an earlier independently poisoning admitted operation.
                }
                state = snapshotTransaction(token)
            }
            when (state.completion) {
                TransactionCompletion.RolledBack -> Unit

                is TransactionCompletion.Failed -> {
                    rollbackError =
                        state.settlementFailure?.takeUnless { settlementError ->
                            failuresShareIdentity(callbackError, settlementError)
                        }
                }

                else -> {
                    val message =
                        "transaction rollback settlement state is inconsistent; close and reopen the database"
                    rollbackError = OliphauntException(message)
                    poisonTransaction(token, message, rollbackError)
                }
            }
        } else if (began) {
            when (state.completion) {
                TransactionCompletion.Active, TransactionCompletion.RollingBack -> {
                    val message =
                        "transaction rollback admission state is inconsistent; close and reopen the database"
                    rollbackError = OliphauntException(message)
                    poisonTransaction(token, message, rollbackError)
                }

                TransactionCompletion.RolledBack -> Unit

                is TransactionCompletion.Failed -> {
                    rollbackError =
                        state.settlementFailure?.takeUnless { settlementError ->
                            failuresShareIdentity(callbackError, settlementError)
                        }
                }

                TransactionCompletion.Committing, TransactionCompletion.Committed -> {
                    val message =
                        "transaction settlement state is inconsistent; close and reopen the database"
                    rollbackError = OliphauntException(message)
                    poisonTransaction(token, message, rollbackError)
                }
            }
        }
        val databaseError = snapshotTransaction(token).databaseFailure
        clearTransaction(token)
        if (rollbackError != null) {
            throw OliphauntTransactionRollbackException(callbackError, rollbackError)
        }
        if (began && databaseError != null && !failuresShareIdentity(callbackError, databaseError)) {
            throw OliphauntTransactionDatabaseException(callbackError, databaseError)
        }
        throw callbackError
    }

    private suspend fun <T> finishSuccessfulTransaction(
        token: Long,
        transaction: OliphauntTransaction,
        result: T,
    ): T = withContext(NonCancellable) {
        transaction.expire()
        var seal = sealTransactionCallback(token)
        if (seal.completion == TransactionCompletion.RollingBack) {
            seal = awaitRollbackSettlement(token, seal)
        }
        when (val completion = seal.completion) {
            TransactionCompletion.RolledBack -> {
                clearTransaction(token)
                return@withContext result
            }

            is TransactionCompletion.Failed -> {
                val databaseFailure = seal.databaseFailure
                clearTransaction(token)
                if (databaseFailure != null) throw databaseFailure
                throw OliphauntException(completion.message)
            }

            TransactionCompletion.Committing -> {
                Unit
            }

            TransactionCompletion.Active, TransactionCompletion.RollingBack, TransactionCompletion.Committed -> {
                val message = "transaction settlement state is inconsistent; close and reopen the database"
                poisonTransaction(token, message)
                clearTransaction(token)
                throw OliphauntException(message)
            }
        }

        val commit =
            try {
                commitTransaction(token, requireNotNull(seal.commitAdmission))
            } catch (error: Throwable) {
                clearTransaction(token)
                throw error
            }
        clearTransaction(token)
        if (commit.commandTag != "COMMIT") {
            if (commit.commandTag != "ROLLBACK") {
                val message =
                    "transaction COMMIT outcome is unknown after command tag ${commit.commandTag ?: "<none>"}; close and reopen the database"
                poisonTransaction(token, message)
            }
            throw OliphauntException("COMMIT returned unexpected command tag ${commit.commandTag ?: "<none>"}")
        }
        result
    }

    public suspend fun cancel() {
        stateMutex.withLock {
            if (closed || closeTeardownStarted) throw OliphauntException("database is closed")
            activeCancellationCount += 1
        }
        // Cancellation is out of band: it remains available while close is
        // only draining work admitted before its cutoff, and is the sole
        // same-handle action permitted from a raw-stream callback.
        try {
            session.cancel()
        } finally {
            finishCancellationAdmission()
        }
    }

    public suspend fun close() {
        val admission =
            stateMutex.withLock {
                ensureNoProtocolStreamCallbackReentry()
                when {
                    closed -> {
                        null
                    }

                    closing -> {
                        throw OliphauntException("database close is already in progress")
                    }

                    activeTransaction != null -> {
                        throw OliphauntException(sessionPinnedMessage)
                    }

                    else -> {
                        closing = true
                        enqueueOperationLocked()
                    }
                }
            }
        if (admission == null) return
        try {
            runAdmitted(admission) {
                val cancellationDrain =
                    stateMutex.withLock {
                        closeTeardownStarted = true
                        if (activeCancellationCount == 0) {
                            null
                        } else {
                            CompletableDeferred<Unit>().also { cancellationDrainWaiter = it }
                        }
                    }
                cancellationDrain?.await()
                session.close()
                stateMutex.withLock {
                    closing = false
                    closed = true
                }
            }
        } catch (error: Throwable) {
            withContext(NonCancellable) {
                stateMutex.withLock {
                    if (!closed) {
                        closeTeardownStarted = false
                        closing = false
                    }
                }
            }
            throw error
        }
    }

    private fun ensureOpenLocked() {
        if (closed || closing || closeTeardownStarted) throw OliphauntException("database is closed")
        poisonedMessage?.let { throw OliphauntException(it) }
    }

    private suspend fun executeBegin(
        token: Long,
        admission: Admission,
        markBegan: () -> Unit,
    ) = runAdmitted(admission) {
        ensureAdmittedOperationUsable()
        val response =
            try {
                session.execProtocolRaw(simpleQueryProtocol("BEGIN"))
            } catch (error: Throwable) {
                poisonUnknownOperation(token, error)
                throw error
            }
        val terminalStatus =
            try {
                inspectTerminalReadyStatus(response)
            } catch (error: Throwable) {
                poisonUnknownOperation(token, error)
                throw error
            }
        val result =
            try {
                parseCommandResponse(response, ExpectedProtocol.Simple)
            } catch (error: Throwable) {
                recoverFailedBeginBoundary(token, terminalStatus, error)
                throw error
            }
        if (
            terminalStatus == ReadyStatus.Transaction &&
            result.readyStatus == terminalStatus &&
            result.commandTag == "BEGIN"
        ) {
            markBegan()
            return@runAdmitted
        }
        val error =
            OliphauntException(
                "BEGIN returned command tag ${result.commandTag ?: "<none>"} " +
                    "with ReadyForQuery status $terminalStatus",
            )
        recoverFailedBeginBoundary(token, terminalStatus, error)
        throw error
    }

    private suspend fun recoverFailedBeginBoundary(
        token: Long,
        status: ReadyStatus,
        primaryError: Throwable,
    ) {
        if (status == ReadyStatus.Idle) return
        try {
            executeRollbackExchange()
        } catch (rollbackError: Throwable) {
            val message =
                "BEGIN failed after PostgreSQL entered ${status.statusLabel()}, and automatic ROLLBACK failed; " +
                    "close and reopen the database: $rollbackError"
            val combined = OliphauntException(message, primaryError)
            combined.addSuppressed(rollbackError)
            poisonTransaction(token, message, combined)
            throw combined
        }
    }

    internal suspend fun rollbackTransaction(token: Long) {
        val admission = admitSettlement(token, TransactionCompletion.RollingBack)
        withContext(NonCancellable) {
            executeRollbackTransaction(token, admission)
        }
        currentCoroutineContext().ensureActive()
    }

    private suspend fun executeRollbackTransaction(
        token: Long,
        admission: Admission,
    ) {
        runAdmitted(admission) {
            var rollbackStarted = false
            try {
                ensureAdmittedOperationUsable()
                ensureSettlement(token, TransactionCompletion.RollingBack)
                rollbackStarted = true
                executeRollbackExchange()
                finishSettlement(token, TransactionCompletion.RollingBack, TransactionCompletion.RolledBack)
            } catch (error: Throwable) {
                val message = "transaction rollback failed; close and reopen the database: $error"
                poisonTransaction(
                    token,
                    message,
                    error,
                    settlementFailure = error.takeIf { rollbackStarted },
                )
                throw error
            }
        }
    }

    private suspend fun executeRollbackExchange() {
        val response = session.execProtocolRaw(simpleQueryProtocol("ROLLBACK"))
        val terminalStatus = inspectTerminalReadyStatus(response)
        val result = parseCommandResponse(response, ExpectedProtocol.Simple)
        if (
            terminalStatus != ReadyStatus.Idle ||
            result.readyStatus != terminalStatus ||
            result.commandTag != "ROLLBACK"
        ) {
            throw OliphauntException("ROLLBACK returned unexpected command tag or ReadyForQuery status")
        }
    }

    private suspend fun commitTransaction(
        token: Long,
        admission: Admission,
    ): CommandResult = runAdmitted(admission) {
        try {
            ensureAdmittedOperationUsable()
            ensureSettlement(token, TransactionCompletion.Committing)
            val response = session.execProtocolRaw(simpleQueryProtocol("COMMIT"))
            val terminalStatus = inspectTerminalReadyStatus(response)
            val result = parseCommandResponse(response, ExpectedProtocol.Simple)
            if (terminalStatus != ReadyStatus.Idle || result.readyStatus != terminalStatus) {
                throw OliphauntException("COMMIT returned unexpected ReadyForQuery status $terminalStatus")
            }
            val completion =
                when (result.commandTag) {
                    "COMMIT" -> TransactionCompletion.Committed

                    "ROLLBACK" -> TransactionCompletion.RolledBack

                    else -> throw OliphauntException(
                        "COMMIT returned unexpected command tag ${result.commandTag ?: "<none>"}",
                    )
                }
            finishSettlement(token, TransactionCompletion.Committing, completion)
            result
        } catch (error: Throwable) {
            val message = "transaction COMMIT outcome is unknown; close and reopen the database: $error"
            poisonTransaction(token, message, error)
            throw error
        }
    }

    private suspend fun finishSettlement(
        token: Long,
        expected: TransactionCompletion,
        completion: TransactionCompletion,
    ) {
        stateMutex.withLock {
            val active = activeTransaction
            if (active?.token != token || active.completion != expected) {
                throw OliphauntException("transaction settlement is no longer active")
            }
            active.completion = completion
        }
    }

    private suspend fun admitSettlement(
        token: Long,
        completion: TransactionCompletion,
    ): Admission = stateMutex.withLock {
        ensureNoProtocolStreamCallbackReentry()
        ensureOpenLocked()
        val active = activeTransaction
        if (active?.token != token || active.completion != TransactionCompletion.Active) {
            throw OliphauntException("transaction is no longer active")
        }
        active.completion = completion
        enqueueOperationLocked().also { admission ->
            active.settlementCompletion = admission.completion
        }
    }

    private suspend fun ensureSettlement(
        token: Long,
        completion: TransactionCompletion,
    ) {
        stateMutex.withLock {
            val active = activeTransaction
            if (active?.token != token || active.completion != completion) {
                throw OliphauntException("transaction settlement is no longer active")
            }
        }
    }

    internal suspend fun <T> runTypedOperation(
        request: ByteArray,
        transactionToken: Long?,
        parser: (ByteArray) -> Pair<T, ReadyStatus>,
    ): T = runAdmitted(admitOperation(transactionToken)) {
        ensureAdmittedOperationUsable()
        val response =
            try {
                session.execProtocolRaw(request)
            } catch (error: Throwable) {
                poisonUnknownOperation(transactionToken, error)
                throw error
            }
        val transactionOutcome =
            if (transactionToken == null) {
                null
            } else {
                try {
                    inspectStructuredTransactionProtocolOutcome(response)
                } catch (error: Throwable) {
                    poisonUnknownOperation(transactionToken, error)
                    throw error
                }
            }
        val terminalStatus =
            transactionOutcome?.readyStatus ?: try {
                inspectTerminalReadyStatus(response)
            } catch (error: Throwable) {
                poisonUnknownOperation(transactionToken, error)
                throw error
            }
        val ownershipViolation = transactionOutcome?.ownershipViolationMessage()
        val parsed =
            try {
                parser(response)
            } catch (error: Throwable) {
                if (transactionToken != null && ownershipViolation != null) {
                    val lifecycleError = OliphauntException(
                        "$ownershipViolation; response parsing also failed: $error",
                        error,
                    )
                    poisonTransaction(
                        transactionToken,
                        requireNotNull(lifecycleError.message),
                        lifecycleError,
                    )
                    throw lifecycleError
                } else {
                    validateTypedFailureStatus(terminalStatus, transactionToken)
                }
                throw error
            }
        if (parsed.second != terminalStatus) {
            val error = OliphauntException("typed response parser disagreed with terminal ReadyForQuery status")
            if (transactionToken != null && ownershipViolation != null) {
                val lifecycleError = OliphauntException(
                    "$ownershipViolation; response parsing also failed: $error",
                    error,
                )
                poisonTransaction(
                    transactionToken,
                    requireNotNull(lifecycleError.message),
                    lifecycleError,
                )
                throw lifecycleError
            } else {
                validateTypedFailureStatus(terminalStatus, transactionToken)
            }
            throw error
        }
        if (transactionToken != null && ownershipViolation != null) {
            val lifecycleError = OliphauntException(ownershipViolation)
            poisonTransaction(transactionToken, ownershipViolation, lifecycleError)
            throw lifecycleError
        }
        validateTypedSuccessStatus(terminalStatus, transactionToken)
        parsed.first
    }

    private fun StructuredTransactionProtocolOutcome.ownershipViolationMessage(): String? = when {
        lifecycleCommandTag != null ->
            "transaction structured operation completed unsupported lifecycle command $lifecycleCommandTag; " +
                "transaction ownership is unknown, so close and reopen the database"

        readyStatus == ReadyStatus.Idle ->
            "transaction operation escaped callback ownership and left PostgreSQL idle; close and reopen the database"

        else -> null
    }

    private suspend fun validateTypedSuccessStatus(
        status: ReadyStatus,
        transactionToken: Long?,
    ) {
        if (transactionToken != null) {
            when (status) {
                ReadyStatus.Transaction -> return

                ReadyStatus.FailedTransaction -> throw OliphauntException(
                    "transaction operation left PostgreSQL in a failed transaction; the callback will roll back",
                )

                ReadyStatus.Idle -> throw poisonEscapedTransaction(transactionToken)
            }
        }
        if (status == ReadyStatus.Idle) return
        val label = status.statusLabel()
        recoverUnexpectedDatabaseTransaction(status)
        throw OliphauntException(
            "typed operation left PostgreSQL in $label; Oliphaunt rolled it back to preserve callback ownership",
        )
    }

    private suspend fun validateTypedFailureStatus(
        status: ReadyStatus,
        transactionToken: Long?,
    ) {
        if (transactionToken != null) {
            if (status == ReadyStatus.Idle) throw poisonEscapedTransaction(transactionToken)
            return
        }
        if (status != ReadyStatus.Idle) recoverUnexpectedDatabaseTransaction(status)
    }

    private suspend fun recoverUnexpectedDatabaseTransaction(status: ReadyStatus) {
        try {
            val response = session.execProtocolRaw(simpleQueryProtocol("ROLLBACK"))
            val terminalStatus = inspectTerminalReadyStatus(response)
            val rollback = parseCommandResponse(response, ExpectedProtocol.Simple)
            if (terminalStatus != ReadyStatus.Idle || rollback.readyStatus != terminalStatus || rollback.commandTag != "ROLLBACK") {
                throw OliphauntException("automatic ROLLBACK returned unexpected command tag or transaction status")
            }
        } catch (error: Throwable) {
            val message =
                "typed operation left PostgreSQL in ${status.statusLabel()}, and automatic ROLLBACK failed; " +
                    "close and reopen the database: $error"
            stateMutex.withLock { poisonedMessage = message }
            throw OliphauntException(message)
        }
    }

    private suspend fun poisonUnknownOperation(
        transactionToken: Long?,
        error: Throwable,
    ) {
        val message =
            "typed operation outcome is unknown before a complete ReadyForQuery boundary; close and reopen the database: $error"
        stateMutex.withLock {
            poisonedMessage = message
            val active = activeTransaction
            if (transactionToken != null && active?.token == transactionToken) {
                active.completion = TransactionCompletion.Failed(message)
                active.databaseFailure = error
                active.lease.closed = true
            }
        }
    }

    private suspend fun poisonEscapedTransaction(token: Long): OliphauntException {
        val message = "transaction operation escaped callback ownership and left PostgreSQL idle; close and reopen the database"
        val error = OliphauntException(message)
        poisonTransaction(token, message, error)
        return error
    }

    private suspend fun poisonTransaction(
        token: Long,
        message: String,
        error: Throwable? = null,
        settlementFailure: Throwable? = null,
    ) {
        stateMutex.withLock {
            poisonedMessage = message
            activeTransaction?.takeIf { it.token == token }?.let { active ->
                active.completion = TransactionCompletion.Failed(message)
                if (active.databaseFailure == null) active.databaseFailure = error
                if (settlementFailure != null) active.settlementFailure = settlementFailure
                active.lease.closed = true
            }
        }
    }

    private suspend fun sealTransactionCallback(token: Long): TransactionSeal = stateMutex.withLock {
        val active =
            activeTransaction?.takeIf { it.token == token }
                ?: return@withLock TransactionSeal(
                    TransactionCompletion.Failed("transaction state was lost; close and reopen the database"),
                )
        if (active.completion == TransactionCompletion.Active) {
            active.completion = TransactionCompletion.Committing
            return@withLock TransactionSeal(active.completion, enqueueOperationLocked())
        }
        TransactionSeal(
            completion = active.completion,
            settlementCompletion = active.settlementCompletion,
            databaseFailure = active.databaseFailure,
            settlementFailure = active.settlementFailure,
        )
    }

    private suspend fun planCallbackFailureSettlement(token: Long): TransactionSeal = stateMutex.withLock {
        val active =
            activeTransaction?.takeIf { it.token == token }
                ?: return@withLock TransactionSeal(
                    TransactionCompletion.Failed("transaction state was lost; close and reopen the database"),
                )
        if (active.completion == TransactionCompletion.Active) {
            val admission = enqueueOperationLocked()
            active.completion = TransactionCompletion.RollingBack
            active.settlementCompletion = admission.completion
            return@withLock TransactionSeal(
                completion = active.completion,
                rollbackAdmission = admission,
                settlementCompletion = admission.completion,
            )
        }
        TransactionSeal(
            completion = active.completion,
            settlementCompletion = active.settlementCompletion,
            databaseFailure = active.databaseFailure,
            settlementFailure = active.settlementFailure,
        )
    }

    private suspend fun snapshotTransaction(token: Long): TransactionSeal = stateMutex.withLock {
        activeTransaction?.takeIf { it.token == token }?.let { active ->
            TransactionSeal(
                completion = active.completion,
                settlementCompletion = active.settlementCompletion,
                databaseFailure = active.databaseFailure,
                settlementFailure = active.settlementFailure,
            )
        } ?: TransactionSeal(
            TransactionCompletion.Failed("transaction state was lost; close and reopen the database"),
        )
    }

    private suspend fun awaitRollbackSettlement(
        token: Long,
        state: TransactionSeal,
    ): TransactionSeal = withContext(NonCancellable) {
        val completion = state.settlementCompletion
        if (completion == null) {
            val message =
                "transaction rollback settlement was lost; close and reopen the database"
            val error = OliphauntException(message)
            poisonTransaction(token, message, error)
            return@withContext snapshotTransaction(token)
        }
        completion.await()
        snapshotTransaction(token)
    }

    private suspend fun clearTransaction(token: Long) {
        stateMutex.withLock {
            activeTransaction?.takeIf { it.token == token }?.let { active ->
                active.lease.closed = true
                activeTransaction = null
            }
        }
    }

    private suspend fun execProtocolRawOwned(
        ownedRequest: ByteArray,
    ): ByteArray = runAdmitted(admitOperation(transactionToken = null)) {
        ensureAdmittedOperationUsable()
        runRawProtocolOperation {
            session.execProtocolRaw(ownedRequest).copyOf()
        }
    }

    private suspend fun execProtocolRawStreamOwned(
        ownedRequest: ByteArray,
        onChunk: (ByteArray) -> Unit,
    ) {
        runAdmitted(admitOperation(transactionToken = null)) {
            ensureAdmittedOperationUsable()
            val outcome =
                runRawProtocolOperation {
                    session.execProtocolRawStream(ownedRequest) { chunk ->
                        withProtocolStreamCallback {
                            onChunk(chunk.copyOf())
                        }
                    }
                }
            when (outcome) {
                ProtocolStreamOutcome.Complete -> Unit
                is ProtocolStreamOutcome.CallbackAborted -> throw outcome.error
            }
        }
    }

    private suspend fun <T> runRawProtocolOperation(
        operation: suspend () -> T,
    ): T = try {
        operation()
    } catch (error: Throwable) {
        poisonUnknownRawProtocolOperation(error)
        throw error
    }

    private suspend fun poisonUnknownRawProtocolOperation(
        error: Throwable,
    ) {
        val message =
            "raw protocol operation outcome is unknown before confirmed recovery; " +
                "close and reopen the database: $error"
        stateMutex.withLock {
            poisonedMessage = message
        }
    }

    private suspend fun admitOperation(transactionToken: Long?): Admission = stateMutex.withLock {
        ensureNoProtocolStreamCallbackReentry()
        ensureOpenLocked()
        ensureTransactionAccessLocked(transactionToken)
        enqueueOperationLocked()
    }

    private fun enqueueOperationLocked(): Admission {
        val completion = CompletableDeferred<Unit>()
        return Admission(admissionTail, completion).also { admissionTail = completion }
    }

    private suspend fun ensureAdmittedOperationUsable() {
        stateMutex.withLock {
            if (closed) throw OliphauntException("database is closed")
            poisonedMessage?.let { throw OliphauntException(it) }
        }
    }

    private fun ensureTransactionAccessLocked(token: Long?) {
        if (token != null) {
            val active = activeTransaction
            if (active?.token != token || active.completion != TransactionCompletion.Active) {
                throw OliphauntException("transaction is no longer active")
            }
        } else if (activeTransaction != null) {
            throw OliphauntException(sessionPinnedMessage)
        }
    }

    private fun ensureNoProtocolStreamCallbackReentry() {
        if (protocolStreamCallbackActive) {
            throw OliphauntException(protocolStreamCallbackReentryMessage)
        }
    }

    private inline fun <T> withProtocolStreamCallback(block: () -> T): T {
        check(!protocolStreamCallbackActive)
        protocolStreamCallbackActive = true
        return try {
            block()
        } finally {
            protocolStreamCallbackActive = false
        }
    }

    private suspend fun finishCancellationAdmission() {
        val drainWaiter =
            stateMutex.withLock {
                check(activeCancellationCount > 0)
                activeCancellationCount -= 1
                if (activeCancellationCount == 0) {
                    cancellationDrainWaiter.also { cancellationDrainWaiter = null }
                } else {
                    null
                }
            }
        drainWaiter?.complete(Unit)
    }

    private suspend fun <T> runAdmitted(
        admission: Admission,
        operation: suspend () -> T,
    ): T {
        try {
            admission.predecessor.await()
            currentCoroutineContext().ensureActive()
        } catch (error: Throwable) {
            // A skipped node must remain behind its predecessor. Completing it
            // immediately would let a later admission overtake active work.
            admission.predecessor.invokeOnCompletion {
                admission.completion.complete(Unit)
            }
            throw error
        }

        val result =
            withContext(NonCancellable) {
                try {
                    operation()
                } finally {
                    admission.completion.complete(Unit)
                }
            }
        currentCoroutineContext().ensureActive()
        return result
    }

    public companion object {
        internal suspend fun open(
            config: EngineConfig,
            engine: OliphauntEngine,
        ): OliphauntDatabase {
            val startupGucs = config.startupGucs.toList()
            val extensions = config.extensions.toList()
            validateDatabaseStorage(config.storage)
            validateStartupIdentity(config.username, "username")
            validateStartupIdentity(config.database, "database")
            validateStartupGucs(startupGucs)
            val normalized =
                config.copy(
                    startupGucs = startupGucs,
                    extensions = validateGeneratedExtensionIds(extensions),
                )
            return OliphauntDatabase(engine.open(normalized))
        }

        internal suspend fun restore(
            destination: String,
            bytes: ByteArray,
            engine: OliphauntEngine,
        ) {
            validateDirectoryPath(destination, "restore destination")
            engine.restore(destination, bytes.copyOf())
        }

        private const val sessionPinnedMessage: String =
            "physical session is pinned; use the active OliphauntTransaction"

        private const val protocolStreamCallbackReentryMessage: String =
            "raw protocol stream callback must not reenter the same Oliphaunt database or transaction"
    }
}

public class OliphauntTransaction internal constructor(
    private val database: OliphauntDatabase,
    private val token: Long,
    private val lease: OliphauntDatabase.TransactionLease,
) {
    public val isClosed: Boolean get() = lease.closed

    public suspend fun rollback() {
        ensureActiveHandle()
        expire()
        database.rollbackTransaction(token)
    }

    internal suspend fun <T> runTypedOperation(
        request: ByteArray,
        parser: (ByteArray) -> Pair<T, ReadyStatus>,
    ): T {
        ensureActiveHandle()
        return database.runTypedOperation(request, token, parser)
    }

    private fun ensureActiveHandle() {
        if (lease.closed) throw OliphauntException("transaction is no longer active")
    }

    internal fun expire() {
        lease.closed = true
    }
}

private fun ReadyStatus.statusLabel(): String = when (this) {
    ReadyStatus.Transaction -> "an open transaction"
    ReadyStatus.FailedTransaction -> "a failed transaction"
    ReadyStatus.Idle -> "an idle transaction"
}

private fun failuresShareIdentity(
    first: Throwable,
    second: Throwable,
): Boolean {
    val firstCauses = mutableListOf<Throwable>()
    var current: Throwable? = first
    while (current != null && firstCauses.none { it === current }) {
        firstCauses += current
        current = current.cause
    }

    val visited = mutableListOf<Throwable>()
    current = second
    while (current != null && visited.none { it === current }) {
        if (firstCauses.any { it === current }) return true
        visited += current
        current = current.cause
    }
    return false
}
