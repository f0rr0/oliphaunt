package dev.oliphaunt

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

public enum class EngineMode {
    NativeDirect,
    NativeBroker,
    NativeServer,
}

public enum class DurabilityProfile {
    Safe,
    Balanced,
    FastDev,
}

public enum class RuntimeFootprintProfile {
    Throughput,
    BalancedMobile,
    SmallMobile,
}

public data class PostgresStartupGuc(
    val name: String,
    val value: String,
)

public data class EngineCapabilities(
    val mode: EngineMode,
    val processIsolated: Boolean,
    val independentSessions: Boolean,
    val maxClientSessions: Int,
    val multiRoot: Boolean = false,
    val reopenable: Boolean = processIsolated,
    val sameRootLogicalReopen: Boolean = !processIsolated && reopenable,
    val rootSwitchable: Boolean = processIsolated,
    val crashRestartable: Boolean = false,
    val protocolRaw: Boolean = true,
    val protocolStream: Boolean = true,
    val queryCancel: Boolean = true,
    val backupRestore: Boolean = true,
    val backupFormats: List<BackupFormat> = listOf(BackupFormat.PhysicalArchive),
    val restoreFormats: List<BackupFormat> = listOf(BackupFormat.PhysicalArchive),
    val simpleQuery: Boolean = true,
    val extensions: Boolean = true,
    val connectionString: String? = null,
) {
    public fun supportsBackupFormat(format: BackupFormat): Boolean = backupRestore && backupFormats.contains(format)

    public fun supportsRestoreFormat(format: BackupFormat): Boolean = backupRestore && restoreFormats.contains(format)
}

public data class EngineModeSupport(
    val mode: EngineMode,
    val available: Boolean,
    val capabilities: EngineCapabilities,
    val unavailableReason: String? = null,
)

public object OliphauntRuntimeSupport {
    public val allModes: List<EngineMode> = listOf(
        EngineMode.NativeDirect,
        EngineMode.NativeBroker,
        EngineMode.NativeServer,
    )

    public fun capabilitiesFor(mode: EngineMode): EngineCapabilities = when (mode) {
        EngineMode.NativeDirect -> EngineCapabilities(
            mode = mode,
            processIsolated = false,
            independentSessions = false,
            maxClientSessions = 1,
            reopenable = true,
            sameRootLogicalReopen = true,
            rootSwitchable = false,
            crashRestartable = false,
        )

        EngineMode.NativeBroker -> EngineCapabilities(
            mode = mode,
            processIsolated = true,
            multiRoot = true,
            independentSessions = false,
            maxClientSessions = 1,
            reopenable = true,
            sameRootLogicalReopen = false,
            rootSwitchable = true,
            crashRestartable = true,
        )

        EngineMode.NativeServer -> EngineCapabilities(
            mode = mode,
            processIsolated = true,
            independentSessions = true,
            maxClientSessions = 32,
            reopenable = true,
            sameRootLogicalReopen = false,
            rootSwitchable = true,
            crashRestartable = false,
            backupFormats = listOf(BackupFormat.Sql, BackupFormat.PhysicalArchive),
        )
    }

    public fun nativeDirectOnly(
        brokerReason: String,
        serverReason: String,
    ): List<EngineModeSupport> = listOf(
        EngineModeSupport(
            mode = EngineMode.NativeDirect,
            available = true,
            capabilities = capabilitiesFor(EngineMode.NativeDirect),
        ),
        EngineModeSupport(
            mode = EngineMode.NativeBroker,
            available = false,
            capabilities = capabilitiesFor(EngineMode.NativeBroker),
            unavailableReason = brokerReason,
        ),
        EngineModeSupport(
            mode = EngineMode.NativeServer,
            available = false,
            capabilities = capabilitiesFor(EngineMode.NativeServer),
            unavailableReason = serverReason,
        ),
    )

    public fun unavailable(reason: String): List<EngineModeSupport> = allModes.map { mode ->
        EngineModeSupport(
            mode = mode,
            available = false,
            capabilities = capabilitiesFor(mode),
            unavailableReason = reason,
        )
    }
}

public data class OliphauntConfig(
    val mode: EngineMode = EngineMode.NativeDirect,
    val root: String? = null,
    val durability: DurabilityProfile = DurabilityProfile.Balanced,
    val runtimeFootprint: RuntimeFootprintProfile = RuntimeFootprintProfile.BalancedMobile,
    val startupGucs: List<PostgresStartupGuc> = emptyList(),
    val username: String? = null,
    val database: String? = null,
    val extensions: List<String> = emptyList(),
)

internal fun validateStartupIdentity(value: String?, label: String) {
    if (value == null) {
        return
    }
    if (value.isBlank()) {
        throw OliphauntException("$label must not be empty")
    }
    if (value.any { it.code == 0 }) {
        throw OliphauntException("$label must not contain NUL bytes")
    }
}

internal fun validateStartupGucs(gucs: List<PostgresStartupGuc>) {
    gucs.forEach { guc ->
        val name = guc.name.trim()
        if (name.isEmpty()) {
            throw OliphauntException("PostgreSQL startup GUC name must not be empty")
        }
        if (name.any { it.code == 0 } || guc.value.any { it.code == 0 }) {
            throw OliphauntException("PostgreSQL startup GUC must not contain NUL bytes")
        }
        if (!name.all { it.isLetterOrDigit() || it == '_' || it == '.' } ||
            !name.all { it.code in 0..127 }
        ) {
            throw OliphauntException(
                "PostgreSQL startup GUC name '${guc.name}' must contain only ASCII letters, digits, '_' or '.'",
            )
        }
        if (guc.value.isBlank()) {
            throw OliphauntException("PostgreSQL startup GUC '${guc.name}' value must not be empty")
        }
    }
}

internal fun OliphauntConfig.postgresStartupArgs(): List<String> = runtimeFootprint.postgresStartupArgs() +
    durability.postgresStartupArgs() +
    startupGucs.flatMap { guc -> listOf("-c", "${guc.name.trim()}=${guc.value}") }

private fun RuntimeFootprintProfile.postgresStartupArgs(): List<String> = when (this) {
    RuntimeFootprintProfile.Throughput -> listOf(
        "-c",
        "shared_buffers=128MB",
        "-c",
        "wal_buffers=4MB",
        "-c",
        "min_wal_size=80MB",
    )

    RuntimeFootprintProfile.BalancedMobile -> listOf(
        "-c", "max_connections=1",
        "-c", "superuser_reserved_connections=0",
        "-c", "reserved_connections=0",
        "-c", "autovacuum_worker_slots=1",
        "-c", "max_wal_senders=0",
        "-c", "max_replication_slots=0",
        "-c", "shared_buffers=32MB",
        "-c", "wal_buffers=-1",
        "-c", "min_wal_size=32MB",
        "-c", "max_wal_size=64MB",
        "-c", "io_method=sync",
        "-c", "io_max_concurrency=1",
    )

    RuntimeFootprintProfile.SmallMobile -> listOf(
        "-c", "max_connections=1",
        "-c", "superuser_reserved_connections=0",
        "-c", "reserved_connections=0",
        "-c", "autovacuum_worker_slots=1",
        "-c", "max_wal_senders=0",
        "-c", "max_replication_slots=0",
        "-c", "shared_buffers=8MB",
        "-c", "wal_buffers=256kB",
        "-c", "min_wal_size=32MB",
        "-c", "max_wal_size=64MB",
        "-c", "work_mem=1MB",
        "-c", "maintenance_work_mem=16MB",
        "-c", "io_method=sync",
        "-c", "io_max_concurrency=1",
    )
}

private fun DurabilityProfile.postgresStartupArgs(): List<String> = when (this) {
    DurabilityProfile.Safe -> listOf(
        "-c",
        "fsync=on",
        "-c",
        "full_page_writes=on",
        "-c",
        "synchronous_commit=on",
    )

    DurabilityProfile.Balanced -> listOf(
        "-c",
        "fsync=on",
        "-c",
        "full_page_writes=on",
        "-c",
        "synchronous_commit=off",
    )

    DurabilityProfile.FastDev -> listOf(
        "-c",
        "fsync=off",
        "-c",
        "full_page_writes=off",
        "-c",
        "synchronous_commit=off",
    )
}

internal fun validateRootPath(root: String?, label: String) {
    if (root == null) {
        return
    }
    if (root.isBlank()) {
        throw OliphauntException("$label must not be empty")
    }
    if (root.any { it.code == 0 }) {
        throw OliphauntException("$label must not contain NUL bytes")
    }
}

public enum class BackupFormat {
    Sql,
    PhysicalArchive,
    OliphauntArchive,
}

public data class BackupRequest(
    val format: BackupFormat = BackupFormat.PhysicalArchive,
)

public data class BackupArtifact(
    val format: BackupFormat,
    val bytes: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is BackupArtifact) return false
        return format == other.format && bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int = 31 * format.hashCode() + bytes.contentHashCode()
}

public enum class RestoreTargetPolicy {
    FailIfExists,
    ReplaceExisting,
}

public data class RestoreRequest(
    val artifact: BackupArtifact,
    val root: String,
    val targetPolicy: RestoreTargetPolicy = RestoreTargetPolicy.FailIfExists,
) {
    public fun replaceExisting(): RestoreRequest = copy(
        targetPolicy = RestoreTargetPolicy.ReplaceExisting,
    )
}

public class ProtocolRequest(public val bytes: ByteArray) {
    public companion object {
        public fun simpleQuery(sql: String): ProtocolRequest {
            if (sql.any { it.code == 0 }) {
                throw OliphauntException("simple query SQL must not contain NUL bytes")
            }
            val body = sql.encodeToByteArray() + byteArrayOf(0)
            val len = body.size + 4
            val header = byteArrayOf(
                'Q'.code.toByte(),
                ((len ushr 24) and 0xff).toByte(),
                ((len ushr 16) and 0xff).toByte(),
                ((len ushr 8) and 0xff).toByte(),
                (len and 0xff).toByte(),
            )
            return ProtocolRequest(header + body)
        }
    }
}

public class ProtocolResponse(public val bytes: ByteArray)

public interface OliphauntEngine {
    public fun supportedModes(): List<EngineModeSupport> = OliphauntRuntimeSupport.unavailable("engine does not publish static mode support")

    public suspend fun open(config: OliphauntConfig): OliphauntSession
    public suspend fun restore(request: RestoreRequest): String
}

public interface OliphauntSession {
    public suspend fun capabilities(): EngineCapabilities
    public suspend fun execProtocolRaw(request: ProtocolRequest): ProtocolResponse
    public suspend fun execProtocolStream(
        request: ProtocolRequest,
        onChunk: (ProtocolResponse) -> Unit,
    ) {
        onChunk(execProtocolRaw(request))
    }
    public suspend fun backup(request: BackupRequest): BackupArtifact
    public suspend fun cancel()
    public suspend fun close()
}

public class RuntimeUnavailableEngine : OliphauntEngine {
    override fun supportedModes(): List<EngineModeSupport> = OliphauntRuntimeSupport.unavailable("no Kotlin runtime is linked")

    override suspend fun open(config: OliphauntConfig): OliphauntSession = throw OliphauntException("no Kotlin runtime is linked for ${config.mode}")

    override suspend fun restore(request: RestoreRequest): String = throw OliphauntException("no Kotlin restore runtime is linked for ${request.artifact.format}")
}

public open class OliphauntException(message: String) : RuntimeException(message)

public class PostgresException(
    public val postgresError: PostgresError,
) : OliphauntException(postgresError.toString())

public data class BackgroundPreparationOptions(
    val cancelActiveWork: Boolean = true,
    val checkpointWhenIdle: Boolean = true,
)

public enum class BackgroundCheckpointSkipReason {
    ActiveWork,
    TransactionActive,
}

public data class BackgroundPreparationResult(
    val cancelledActiveWork: Boolean,
    val checkpointed: Boolean,
    val skippedCheckpointReason: BackgroundCheckpointSkipReason? = null,
)

public expect fun defaultOliphauntEngine(mode: EngineMode): OliphauntEngine

public class OliphauntDatabase private constructor(
    private val session: OliphauntSession,
) {
    private val executionMutex = Mutex()
    private val stateMutex = Mutex()
    private var closed = false
    private var activeTransactionToken: Long? = null
    private var nextTransactionToken = 1L
    private var activeOperationCount = 0

    public suspend fun capabilities(): EngineCapabilities = executionMutex.withLock {
        ensureOpen()
        session.capabilities()
    }

    public suspend fun connectionString(): String? = capabilities().connectionString

    public suspend fun supportsBackupFormat(format: BackupFormat): Boolean = capabilities().supportsBackupFormat(format)

    public suspend fun supportsRestoreFormat(format: BackupFormat): Boolean = capabilities().supportsRestoreFormat(format)

    public suspend fun execProtocolRaw(request: ProtocolRequest): ProtocolResponse = executionMutex.withLock {
        ensureOpen()
        ensureTransactionAccess(null)
        runSessionOperation {
            session.execProtocolRaw(request)
        }
    }

    public suspend fun execute(sql: String): ProtocolResponse = execProtocolRaw(ProtocolRequest.simpleQuery(sql))

    public suspend fun execProtocolStream(
        request: ProtocolRequest,
        onChunk: (ProtocolResponse) -> Unit,
    ) {
        executionMutex.withLock {
            ensureOpen()
            ensureTransactionAccess(null)
            runSessionOperation {
                session.execProtocolStream(request, onChunk)
            }
        }
    }

    public suspend fun backup(request: BackupRequest = BackupRequest()): BackupArtifact = executionMutex.withLock {
        ensureOpen()
        ensureTransactionAccess(null)
        val capabilities = session.capabilities()
        if (!capabilities.supportsBackupFormat(request.format)) {
            throw OliphauntException("${request.format} backup is not supported by ${capabilities.mode}")
        }
        runSessionOperation {
            session.backup(request)
        }
    }

    public suspend fun checkpoint() {
        execProtocolRaw(ProtocolRequest.simpleQuery("CHECKPOINT"))
    }

    public suspend fun prepareForBackground(
        options: BackgroundPreparationOptions = BackgroundPreparationOptions(),
    ): BackgroundPreparationResult {
        val snapshot = stateMutex.withLock {
            if (closed) {
                throw OliphauntException("database is closed")
            }
            activeOperationCount to activeTransactionToken
        }
        val hadActiveWork = snapshot.first > 0
        val cancelledActiveWork = if (options.cancelActiveWork && hadActiveWork) {
            session.cancel()
            true
        } else {
            false
        }
        if (!options.checkpointWhenIdle) {
            return BackgroundPreparationResult(
                cancelledActiveWork = cancelledActiveWork,
                checkpointed = false,
            )
        }
        if (snapshot.second != null) {
            return BackgroundPreparationResult(
                cancelledActiveWork = cancelledActiveWork,
                checkpointed = false,
                skippedCheckpointReason = BackgroundCheckpointSkipReason.TransactionActive,
            )
        }
        val stillActive = stateMutex.withLock { activeOperationCount > 0 }
        if (hadActiveWork || stillActive) {
            return BackgroundPreparationResult(
                cancelledActiveWork = cancelledActiveWork,
                checkpointed = false,
                skippedCheckpointReason = BackgroundCheckpointSkipReason.ActiveWork,
            )
        }
        checkpoint()
        return BackgroundPreparationResult(
            cancelledActiveWork = cancelledActiveWork,
            checkpointed = true,
        )
    }

    public suspend fun resumeFromBackground() {
        execute("SELECT 1")
    }

    public suspend fun <T> transaction(block: suspend (OliphauntTransaction) -> T): T {
        val token = stateMutex.withLock {
            if (closed) {
                throw OliphauntException("database is closed")
            }
            if (activeTransactionToken != null) {
                throw OliphauntException(sessionPinnedMessage)
            }
            val allocated = nextTransactionToken
            nextTransactionToken = if (nextTransactionToken == Long.MAX_VALUE) 1L else nextTransactionToken + 1
            activeTransactionToken = allocated
            allocated
        }
        val transaction = OliphauntTransaction(this, token)
        try {
            execProtocolRaw(request = ProtocolRequest.simpleQuery("BEGIN"), transactionToken = token)
            val result = block(transaction)
            execProtocolRaw(request = ProtocolRequest.simpleQuery("COMMIT"), transactionToken = token)
            return result
        } catch (error: Throwable) {
            runCatching {
                execProtocolRaw(request = ProtocolRequest.simpleQuery("ROLLBACK"), transactionToken = token)
            }
            throw error
        } finally {
            stateMutex.withLock {
                if (activeTransactionToken == token) {
                    activeTransactionToken = null
                }
            }
        }
    }

    public suspend fun cancel() {
        stateMutex.withLock {
            if (closed) {
                throw OliphauntException("database is closed")
            }
        }
        session.cancel()
    }

    public suspend fun close() {
        val shouldClose = stateMutex.withLock {
            if (closed) {
                false
            } else {
                closed = true
                activeTransactionToken = null
                true
            }
        }
        if (!shouldClose) {
            return
        }
        executionMutex.withLock {
            session.close()
        }
    }

    private suspend fun ensureOpen() {
        val isClosed = stateMutex.withLock { closed }
        if (isClosed) {
            throw OliphauntException("database is closed")
        }
    }

    private suspend fun ensureTransactionAccess(token: Long?) {
        stateMutex.withLock {
            if (token != null) {
                if (activeTransactionToken != token) {
                    throw OliphauntException("transaction is no longer active")
                }
            } else if (activeTransactionToken != null) {
                throw OliphauntException(sessionPinnedMessage)
            }
        }
    }

    internal suspend fun execProtocolRaw(
        request: ProtocolRequest,
        transactionToken: Long,
    ): ProtocolResponse = executionMutex.withLock {
        ensureOpen()
        ensureTransactionAccess(transactionToken)
        runSessionOperation {
            session.execProtocolRaw(request)
        }
    }

    internal suspend fun execProtocolStream(
        request: ProtocolRequest,
        transactionToken: Long,
        onChunk: (ProtocolResponse) -> Unit,
    ) {
        executionMutex.withLock {
            ensureOpen()
            ensureTransactionAccess(transactionToken)
            runSessionOperation {
                session.execProtocolStream(request, onChunk)
            }
        }
    }

    private suspend fun <T> runSessionOperation(block: suspend () -> T): T {
        stateMutex.withLock {
            activeOperationCount += 1
        }
        try {
            return block()
        } finally {
            stateMutex.withLock {
                activeOperationCount -= 1
            }
        }
    }

    public companion object {
        public suspend fun open(
            config: OliphauntConfig,
            engine: OliphauntEngine = defaultOliphauntEngine(config.mode),
        ): OliphauntDatabase {
            validateRootPath(config.root, "database root")
            validateStartupIdentity(config.username, "username")
            validateStartupIdentity(config.database, "database")
            validateStartupGucs(config.startupGucs)
            val normalizedConfig = config.copy(
                extensions = validateExtensionIds(config.extensions),
            )
            return OliphauntDatabase(engine.open(normalizedConfig))
        }

        public suspend fun restore(
            request: RestoreRequest,
            engine: OliphauntEngine = defaultOliphauntEngine(EngineMode.NativeDirect),
        ): String {
            validateRootPath(request.root, "restore root")
            if (request.artifact.format != BackupFormat.PhysicalArchive) {
                throw OliphauntException(
                    "restore currently requires a PhysicalArchive artifact, got ${request.artifact.format}",
                )
            }
            return engine.restore(request)
        }

        public fun supportedModes(
            engine: OliphauntEngine = defaultOliphauntEngine(EngineMode.NativeDirect),
        ): List<EngineModeSupport> = engine.supportedModes()

        private fun validateExtensionIds(extensions: Collection<String>): List<String> = extensions.map(String::trim)
            .filter(String::isNotEmpty)
            .onEach { extension ->
                if (!portableId.matches(extension)) {
                    throw OliphauntException(
                        "Kotlin Oliphaunt extension id '$extension' must contain only ASCII letters, digits, '.', '_' or '-'",
                    )
                }
            }

        private val portableId = Regex("[A-Za-z0-9._-]{1,128}")

        private const val sessionPinnedMessage: String =
            "physical session is pinned; use the active OliphauntTransaction"
    }
}

public class OliphauntTransaction internal constructor(
    private val database: OliphauntDatabase,
    private val token: Long,
) {
    public suspend fun execProtocolRaw(request: ProtocolRequest): ProtocolResponse = database.execProtocolRaw(request, transactionToken = token)

    public suspend fun execProtocolStream(
        request: ProtocolRequest,
        onChunk: (ProtocolResponse) -> Unit,
    ) {
        database.execProtocolStream(request, transactionToken = token, onChunk = onChunk)
    }

    public suspend fun execute(sql: String): ProtocolResponse = execProtocolRaw(ProtocolRequest.simpleQuery(sql))
}
