package dev.oliphaunt

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

public data class PostgresStartupGuc(
    val name: String,
    val value: String,
)

internal sealed interface EngineStorage {
    data object TemporaryDirectory : EngineStorage

    data class Directory(val path: String) : EngineStorage
}

internal data class EngineConfig(
    val storage: EngineStorage = EngineStorage.TemporaryDirectory,
    val startupGucs: List<PostgresStartupGuc> = emptyList(),
    val username: String? = null,
    val database: String? = null,
    val extensions: List<String> = emptyList(),
)

internal fun validateStartupIdentity(value: String?, label: String) {
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
): List<String> = extensions.map(String::trim)
    .filter(String::isNotEmpty)
    .onEach { extension ->
        if (!portableExtensionId.matches(extension)) {
            throw OliphauntException(
                "$label '$extension' must contain 1 to 128 ASCII letters, digits, '.', '_' or '-'",
            )
        }
        if (!generatedExtensionSqlNameExists(extension)) {
            throw OliphauntException("unknown $label '$extension'")
        }
    }

internal fun EngineConfig.postgresStartupArgs(
    sharedPreloadLibraries: Collection<String> = emptyList(),
): List<String> = startupGucs.flatMap { guc -> listOf("-c", "${guc.name.trim()}=${guc.value}") } +
    sharedPreloadLibraries.distinct().sorted().takeIf(List<String>::isNotEmpty)
        ?.let { libraries -> listOf("-c", "shared_preload_libraries=${libraries.joinToString(",")}") }
        .orEmpty()

internal fun validateDatabaseStorage(storage: EngineStorage) {
    if (storage is EngineStorage.Directory) {
        validateDirectoryPath(storage.path, "database storage directory")
    }
}

internal fun validateDirectoryPath(path: String, label: String) {
    if (path.isBlank()) throw OliphauntException("$label must not be empty")
    if (path.any { it.code == 0 }) throw OliphauntException("$label must not contain NUL bytes")
}

internal fun simpleQueryProtocol(sql: String): ByteArray {
    if (sql.any { it.code == 0 }) {
        throw OliphauntException("simple query SQL must not contain NUL bytes")
    }
    val body = sql.encodeToByteArray() + byteArrayOf(0)
    val len = body.size + 4
    return byteArrayOf(
        'Q'.code.toByte(),
        ((len ushr 24) and 0xff).toByte(),
        ((len ushr 16) and 0xff).toByte(),
        ((len ushr 8) and 0xff).toByte(),
        (len and 0xff).toByte(),
    ) + body
}

internal interface OliphauntEngine {
    suspend fun open(config: EngineConfig): OliphauntSession
    suspend fun restore(destination: String, bytes: ByteArray)
}

internal interface OliphauntSession {
    suspend fun execProtocolRaw(request: ByteArray): ByteArray
    suspend fun execProtocolStream(request: ByteArray, onChunk: (ByteArray) -> Unit)
    suspend fun backup(): ByteArray
    suspend fun cancel()
    suspend fun close()
}

public open class OliphauntException(message: String) : RuntimeException(message)

public class PostgresException(
    public val postgresError: PostgresError,
) : OliphauntException(postgresError.toString())

public class OliphauntDatabase private constructor(
    private val session: OliphauntSession,
) {
    private val executionMutex = Mutex()
    private val stateMutex = Mutex()
    private var closing = false
    private var closed = false
    private var poisonedMessage: String? = null
    private var activeTransactionToken: Long? = null
    private var nextTransactionToken = 1L

    public suspend fun execProtocolRaw(request: ByteArray): ByteArray = executionMutex.withLock {
        ensureOpen()
        ensureTransactionAccess(null)
        session.execProtocolRaw(request)
    }

    public suspend fun execProtocolStream(
        request: ByteArray,
        onChunk: (ByteArray) -> Unit,
    ) {
        executionMutex.withLock {
            ensureOpen()
            ensureTransactionAccess(null)
            session.execProtocolStream(request, onChunk)
        }
    }

    public suspend fun backup(): ByteArray = executionMutex.withLock {
        ensureOpen()
        ensureTransactionAccess(null)
        session.backup()
    }

    public suspend fun checkpoint() {
        execute("CHECKPOINT")
    }

    public suspend fun <T> transaction(block: suspend (OliphauntTransaction) -> T): T {
        val token = stateMutex.withLock {
            ensureOpenLocked()
            if (activeTransactionToken != null) throw OliphauntException(sessionPinnedMessage)
            val allocated = nextTransactionToken
            nextTransactionToken = if (nextTransactionToken == Long.MAX_VALUE) 1L else nextTransactionToken + 1
            activeTransactionToken = allocated
            allocated
        }
        val transaction = OliphauntTransaction(this, token)
        try {
            val result =
                try {
                    val begin = executeTransactionControl(transaction, "BEGIN")
                    if (begin.commandTag != "BEGIN") {
                        throw OliphauntException("BEGIN returned unexpected command tag ${begin.commandTag ?: "<none>"}")
                    }
                    block(transaction)
                } catch (error: Throwable) {
                    try {
                        val rollback = executeTransactionControl(transaction, "ROLLBACK")
                        if (rollback.commandTag != "ROLLBACK") {
                            throw OliphauntException(
                                "ROLLBACK returned unexpected command tag ${rollback.commandTag ?: "<none>"}",
                            )
                        }
                    } catch (rollbackError: Throwable) {
                        stateMutex.withLock {
                            poisonedMessage = "transaction rollback failed; close and reopen the database: $rollbackError"
                        }
                    }
                    throw error
                }
            val commit =
                try {
                    executeTransactionControl(transaction, "COMMIT")
                } catch (error: Throwable) {
                    stateMutex.withLock {
                        poisonedMessage = "transaction COMMIT outcome is unknown; close and reopen the database: $error"
                    }
                    throw error
                }
            if (commit.commandTag != "COMMIT") {
                if (commit.commandTag != "ROLLBACK") {
                    stateMutex.withLock {
                        poisonedMessage =
                            "transaction COMMIT outcome is unknown after command tag ${commit.commandTag ?: "<none>"}; close and reopen the database"
                    }
                }
                throw OliphauntException("COMMIT returned unexpected command tag ${commit.commandTag ?: "<none>"}")
            }
            return result
        } finally {
            stateMutex.withLock {
                if (activeTransactionToken == token) activeTransactionToken = null
            }
        }
    }

    public suspend fun cancel() {
        stateMutex.withLock { ensureOpenLocked() }
        session.cancel()
    }

    public suspend fun close() {
        val shouldClose = stateMutex.withLock {
            if (closed) {
                false
            } else {
                if (closing) throw OliphauntException("database is closed")
                if (activeTransactionToken != null) throw OliphauntException(sessionPinnedMessage)
                closing = true
                true
            }
        }
        if (!shouldClose) return
        try {
            executionMutex.withLock { session.close() }
            stateMutex.withLock {
                closing = false
                closed = true
            }
        } catch (error: Throwable) {
            stateMutex.withLock { closing = false }
            throw error
        }
    }

    private suspend fun ensureOpen() {
        stateMutex.withLock { ensureOpenLocked() }
    }

    private fun ensureOpenLocked() {
        if (closed || closing) throw OliphauntException("database is closed")
        poisonedMessage?.let { throw OliphauntException(it) }
    }

    private suspend fun executeTransactionControl(
        transaction: OliphauntTransaction,
        sql: String,
    ): CommandResult = parseCommandResponse(
        transaction.execProtocolRaw(simpleQueryProtocol(sql)),
    )

    private suspend fun ensureTransactionAccess(token: Long?) {
        stateMutex.withLock {
            if (token != null) {
                if (activeTransactionToken != token) throw OliphauntException("transaction is no longer active")
            } else if (activeTransactionToken != null) {
                throw OliphauntException(sessionPinnedMessage)
            }
        }
    }

    internal suspend fun execProtocolRaw(
        request: ByteArray,
        transactionToken: Long,
    ): ByteArray = executionMutex.withLock {
        ensureOpen()
        ensureTransactionAccess(transactionToken)
        session.execProtocolRaw(request)
    }

    internal suspend fun execProtocolStream(
        request: ByteArray,
        transactionToken: Long,
        onChunk: (ByteArray) -> Unit,
    ) {
        executionMutex.withLock {
            ensureOpen()
            ensureTransactionAccess(transactionToken)
            session.execProtocolStream(request, onChunk)
        }
    }

    public companion object {
        internal suspend fun open(
            config: EngineConfig,
            engine: OliphauntEngine,
        ): OliphauntDatabase {
            validateDatabaseStorage(config.storage)
            validateStartupIdentity(config.username, "username")
            validateStartupIdentity(config.database, "database")
            validateStartupGucs(config.startupGucs)
            val normalized = config.copy(extensions = validateGeneratedExtensionIds(config.extensions))
            return OliphauntDatabase(engine.open(normalized))
        }

        internal suspend fun restore(
            destination: String,
            bytes: ByteArray,
            engine: OliphauntEngine,
        ) {
            validateDirectoryPath(destination, "restore destination")
            engine.restore(destination, bytes)
        }

        private const val sessionPinnedMessage: String =
            "physical session is pinned; use the active OliphauntTransaction"
    }
}

public class OliphauntTransaction internal constructor(
    private val database: OliphauntDatabase,
    private val token: Long,
) {
    public suspend fun execProtocolRaw(request: ByteArray): ByteArray = database.execProtocolRaw(request, transactionToken = token)

    public suspend fun execProtocolStream(
        request: ByteArray,
        onChunk: (ByteArray) -> Unit,
    ) {
        database.execProtocolStream(request, transactionToken = token, onChunk = onChunk)
    }
}
