package dev.oliphaunt

import android.content.Context
import java.io.File

public sealed interface DatabaseStorage {
    public data object TemporaryDirectory : DatabaseStorage

    public data class ApplicationData(val name: String) : DatabaseStorage

    public data class Directory(val path: File) : DatabaseStorage
}

public data class OliphauntConfig(
    val storage: DatabaseStorage = DatabaseStorage.TemporaryDirectory,
    val startupGucs: List<PostgresStartupGuc> = emptyList(),
    val username: String? = null,
    val database: String? = null,
    val extensions: List<OliphauntExtension> = emptyList(),
)

public object Oliphaunt {
    public suspend fun open(
        context: Context,
        config: OliphauntConfig = OliphauntConfig(),
        runtimeDirectory: File? = null,
        resourceRoot: File? = null,
    ): OliphauntDatabase = OliphauntDatabase.open(
        config = config.toEngineConfig(),
        engine =
        AndroidNativeDirectEngine(
            context = context,
            runtimeDirectory = runtimeDirectory?.absolutePath,
            resourceRoot = resourceRoot,
        ),
    )

    public suspend fun restore(
        context: Context,
        storage: DatabaseStorage,
        bytes: ByteArray,
    ) {
        require(storage !is DatabaseStorage.TemporaryDirectory) { "restore requires persistent storage" }
        val destination = resolveAndroidStorage(context.applicationContext, storage.toEngineStorage())
        restore(context, destination, bytes)
    }

    public suspend fun restore(
        context: Context,
        destination: File,
        bytes: ByteArray,
    ) {
        OliphauntDatabase.restore(
            destination = destination.absolutePath,
            bytes = bytes,
            engine = AndroidNativeDirectEngine(context = context),
        )
    }
}

internal fun OliphauntConfig.toEngineConfig(): EngineConfig = EngineConfig(
    storage = storage.toEngineStorage(),
    startupGucs = startupGucs.toList(),
    username = username,
    database = database,
    extensions = extensions.map(OliphauntExtension::sqlName),
)

internal fun DatabaseStorage.toEngineStorage(): EngineStorage = when (this) {
    DatabaseStorage.TemporaryDirectory -> EngineStorage.TemporaryDirectory
    is DatabaseStorage.Directory -> EngineStorage.Directory(path.absolutePath)
    is DatabaseStorage.ApplicationData -> EngineStorage.ApplicationData(name)
}

/** Publishes a complete archive to a new file without overwriting it. */
public suspend fun OliphauntDatabase.backup(destination: File): Unit = backupToPath(destination.absolutePath)

/** @suppress Used by the React Native bridge to include its admission queue in the deadline. */
@JvmSynthetic
public suspend fun <T> withOliphauntBridgeDeadline(milliseconds: Long, operation: suspend () -> T): T = if (milliseconds == 0L) operation() else kotlinx.coroutines.withContext(OliphauntBridgeDeadline(milliseconds)) { operation() }
