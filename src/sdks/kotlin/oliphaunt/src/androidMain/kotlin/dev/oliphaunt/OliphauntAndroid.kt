package dev.oliphaunt

import android.content.Context
import java.io.File

public sealed interface DatabaseStorage {
    public data object TemporaryDirectory : DatabaseStorage

    public data class Directory(val path: File) : DatabaseStorage
}

public data class OliphauntConfig(
    val storage: DatabaseStorage = DatabaseStorage.TemporaryDirectory,
    val startupGucs: List<PostgresStartupGuc> = emptyList(),
    val username: String? = null,
    val database: String? = null,
    val extensions: List<String> = emptyList(),
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
        destination: File,
        bytes: ByteArray,
    ) {
        AndroidNativeDirectEngine(context = context).restore(destination.absolutePath, bytes)
    }
}

private fun OliphauntConfig.toEngineConfig(): EngineConfig = EngineConfig(
    storage = when (val selected = storage) {
        DatabaseStorage.TemporaryDirectory -> EngineStorage.TemporaryDirectory
        is DatabaseStorage.Directory -> EngineStorage.Directory(selected.path.absolutePath)
    },
    startupGucs = startupGucs,
    username = username,
    database = database,
    extensions = extensions,
)
