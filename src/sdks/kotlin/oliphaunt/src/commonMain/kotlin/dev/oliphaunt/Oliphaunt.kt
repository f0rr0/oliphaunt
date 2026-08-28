package dev.oliphaunt

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.NonCancellable
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

internal fun EngineConfig.postgresStartupArgs(sharedPreloadLibraries: Collection<String> = emptyList()): List<String> = startupGucs.flatMap { guc -> listOf("-c", "${guc.name.trim()}=${guc.value}") } +
    sharedPreloadLibraries
        .distinct()
        .sorted()
        .takeIf(List<String>::isNotEmpty)
        ?.let { libraries -> listOf("-c", "shared_preload_libraries=${libraries.joinToString(",")}") }
        .orEmpty()

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
        var completion: TransactionCompletion = TransactionCompletion.Active,
        var databaseFailure: Throwable? = null,
    )

    private data class Admission(
        val predecessor: Deferred<Unit>,
        val completion: CompletableDeferred<Unit>,
    )

    private data class BeginAdmission(
        val token: Long,
        val operation: Admission,
    )

    private data class TransactionSeal(
        val completion: TransactionCompletion,
        val commitAdmission: Admission? = null,
    )

    private val stateMutex = Mutex()
    private var admissionTail: Deferred<Unit> = CompletableDeferred(Unit)
    private var closing = false
    private var closeTeardownStarted = false
    private var activeCancellationCount = 0
    private var cancellationDrainWaiter: CompletableDeferred<Unit>? = null

    @Volatile
    private var closed = false

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
                activeTransaction = ActiveTransaction(allocated)
                BeginAdmission(allocated, enqueueOperationLocked())
            }
        val token = beginAdmission.token
        val transaction = OliphauntTransaction(this, token)

        val result: T
        var began = false
        try {
            val begin = executeBegin(token, beginAdmission.operation)
            if (begin.commandTag != "BEGIN") {
                throw OliphauntException("BEGIN returned unexpected command tag ${begin.commandTag ?: "<none>"}")
            }
            began = true
            result = block(transaction)
        } catch (callbackError: Throwable) {
            transaction.expire()
            val databaseError =
                stateMutex.withLock {
                    activeTransaction?.takeIf { it.token == token }?.databaseFailure
                }
            var rollbackError: Throwable? = null
            if (began && transactionIsActive(token)) {
                try {
                    withContext(NonCancellable) { rollbackTransaction(token) }
                } catch (error: Throwable) {
                    rollbackError = error
                }
            }
            clearTransaction(token)
            if (rollbackError != null) {
                throw OliphauntTransactionRollbackException(callbackError, rollbackError)
            }
            if (databaseError != null && databaseError !== callbackError) {
                throw OliphauntTransactionDatabaseException(callbackError, databaseError)
            }
            throw callbackError
        }

        transaction.expire()
        val seal = sealTransactionCallback(token)
        when (val completion = seal.completion) {
            TransactionCompletion.RolledBack -> {
                clearTransaction(token)
                return result
            }

            is TransactionCompletion.Failed -> {
                clearTransaction(token)
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
        return result
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
            try {
                session.close()
                stateMutex.withLock {
                    closing = false
                    closed = true
                }
            } catch (error: Throwable) {
                stateMutex.withLock {
                    closeTeardownStarted = false
                    closing = false
                }
                throw error
            }
        }
    }

    private fun ensureOpenLocked() {
        if (closed || closing || closeTeardownStarted) throw OliphauntException("database is closed")
        poisonedMessage?.let { throw OliphauntException(it) }
    }

    private suspend fun executeBegin(
        token: Long,
        admission: Admission,
    ): CommandResult = runAdmitted(admission) {
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
        val result = parseCommandResponse(response, ExpectedProtocol.Simple)
        if (terminalStatus != ReadyStatus.Transaction || result.readyStatus != terminalStatus) {
            throw OliphauntException("BEGIN returned unexpected ReadyForQuery status $terminalStatus")
        }
        result
    }

    internal suspend fun rollbackTransaction(token: Long) {
        val admission = admitSettlement(token, TransactionCompletion.RollingBack)
        runAdmitted(admission) {
            try {
                ensureAdmittedOperationUsable()
                ensureSettlement(token, TransactionCompletion.RollingBack)
                val response = session.execProtocolRaw(simpleQueryProtocol("ROLLBACK"))
                val terminalStatus = inspectTerminalReadyStatus(response)
                val result = parseCommandResponse(response, ExpectedProtocol.Simple)
                if (terminalStatus != ReadyStatus.Idle || result.readyStatus != terminalStatus || result.commandTag != "ROLLBACK") {
                    throw OliphauntException("ROLLBACK returned unexpected command tag or ReadyForQuery status")
                }
                finishSettlement(token, TransactionCompletion.RollingBack, TransactionCompletion.RolledBack)
            } catch (error: Throwable) {
                val message = "transaction rollback failed; close and reopen the database: $error"
                poisonTransaction(token, message, error)
                throw error
            }
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
        enqueueOperationLocked()
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
    ) {
        stateMutex.withLock {
            poisonedMessage = message
            activeTransaction?.takeIf { it.token == token }?.let { active ->
                active.completion = TransactionCompletion.Failed(message)
                if (active.databaseFailure == null) active.databaseFailure = error
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
        TransactionSeal(active.completion)
    }

    private suspend fun transactionIsActive(token: Long): Boolean = stateMutex.withLock {
        activeTransaction?.let { it.token == token && it.completion == TransactionCompletion.Active } == true
    }

    private suspend fun clearTransaction(token: Long) {
        stateMutex.withLock { if (activeTransaction?.token == token) activeTransaction = null }
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
                        withProtocolStreamCallbackContext(this) {
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
        if (currentProtocolStreamCallbackOwner() === this) {
            throw OliphauntException(protocolStreamCallbackReentryMessage)
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
    ): T = withContext(NonCancellable) {
        admission.predecessor.await()
        try {
            operation()
        } finally {
            admission.completion.complete(Unit)
        }
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
) {
    @Volatile
    private var expired = false

    public val isClosed: Boolean get() = expired

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
        if (expired) throw OliphauntException("transaction is no longer active")
    }

    internal fun expire() {
        expired = true
    }
}

private fun ReadyStatus.statusLabel(): String = when (this) {
    ReadyStatus.Transaction -> "an open transaction"
    ReadyStatus.FailedTransaction -> "a failed transaction"
    ReadyStatus.Idle -> "an idle transaction"
}
