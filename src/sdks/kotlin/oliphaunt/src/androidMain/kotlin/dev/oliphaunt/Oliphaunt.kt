package dev.oliphaunt

import android.content.Context
import java.io.File

public object Oliphaunt {
    public suspend fun open(
        context: Context,
        config: OliphauntConfig = OliphauntConfig(),
        runtimeDirectory: String? = null,
        resourceRoot: File? = null,
    ): OliphauntDatabase = OliphauntDatabase.open(
        config = config,
        engine =
        AndroidNativeDirectEngine(
            context = context,
            runtimeDirectory = runtimeDirectory,
            resourceRoot = resourceRoot,
        ),
    )

    public suspend fun restore(
        context: Context,
        destination: String,
        bytes: ByteArray,
    ) {
        AndroidNativeDirectEngine(context = context).restore(destination, bytes)
    }
}
