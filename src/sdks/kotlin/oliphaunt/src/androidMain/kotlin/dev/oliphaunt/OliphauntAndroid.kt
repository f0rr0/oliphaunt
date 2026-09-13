package dev.oliphaunt

import android.content.Context
import java.io.File

public sealed interface DatabaseStorage {
    public data object TemporaryDirectory : DatabaseStorage

    public data class Directory(val path: File) : DatabaseStorage
}

public data class OliphauntConfig(
    val storage: DatabaseStorage = DatabaseStorage.TemporaryDirectory,
    val startupGucs: Map<String, String> = emptyMap(),
    val username: String? = null,
    val database: String? = null,
    val extensions: List<ExtensionDescriptor> = emptyList(),
    val icu: IcuData? = null,
) {
    public companion object {
        @JvmStatic
        public fun builder(): Builder = Builder()
    }

    public class Builder internal constructor() {
        private var storage: DatabaseStorage = DatabaseStorage.TemporaryDirectory
        private var username: String? = null
        private var database: String? = null
        private var icu: IcuData? = null
        private val gucs = linkedMapOf<String, String>()
        private val extensions = mutableListOf<ExtensionDescriptor>()

        public fun storage(value: DatabaseStorage): Builder = apply { storage = value }
        public fun username(value: String): Builder = apply { username = value }
        public fun database(value: String): Builder = apply { database = value }
        public fun icu(value: IcuData): Builder = apply { icu = value }
        public fun startupGuc(name: String, value: String): Builder = apply { gucs[name] = value }
        public fun startupGucs(values: Map<String, String>): Builder = apply { gucs.putAll(values) }
        public fun extensions(vararg values: ExtensionDescriptor): Builder = apply { extensions.addAll(values) }
        public fun build(): OliphauntConfig = OliphauntConfig(
            storage,
            gucs.toMap(),
            username,
            database,
            selectedExtensionDescriptors(extensions),
            icu,
        )
    }
}

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
        OliphauntDatabase.restore(
            destination = destination.absolutePath,
            bytes = bytes,
            engine = AndroidNativeDirectEngine(context = context),
        )
    }
}

internal fun OliphauntConfig.toEngineConfig(): EngineConfig = EngineConfig(
    storage = when (val selected = storage) {
        DatabaseStorage.TemporaryDirectory -> EngineStorage.TemporaryDirectory
        is DatabaseStorage.Directory -> EngineStorage.Directory(selected.path.absolutePath)
    },
    startupGucs = startupGucs.map { (name, value) -> PostgresStartupGuc(name, value) },
    username = username,
    database = database,
    extensions = selectedExtensionDescriptors(extensions).map { it.sqlName },
    extensionDescriptors = selectedExtensionDescriptors(extensions),
    icu = icu,
)
