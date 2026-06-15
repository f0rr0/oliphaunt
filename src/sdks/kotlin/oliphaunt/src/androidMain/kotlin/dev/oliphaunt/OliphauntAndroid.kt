package dev.oliphaunt

import android.content.Context
import java.io.File

public object OliphauntAndroid {
    public fun supportedModes(): List<EngineModeSupport> = OliphauntRuntimeSupport.nativeDirectOnly(
        brokerReason = "Android broker mode requires a platform broker adapter; it is not aliased to direct mode",
        serverReason = "Android server mode requires a platform server adapter; it is not aliased to direct mode",
    )

    public fun packageSizeReport(context: Context): OliphauntPackageSizeReport? = OliphauntAndroidRuntimeAssets.packageSizeReport(context.applicationContext.assets)

    public fun packageSizeReport(resourceRoot: File): OliphauntPackageSizeReport? = OliphauntAndroidRuntimeAssets.packageSizeReport(resourceRoot)

    public suspend fun open(
        context: Context,
        config: OliphauntConfig = OliphauntConfig(),
        libraryPath: String? = null,
        runtimeDirectory: String? = null,
        username: String = "postgres",
        database: String = "postgres",
    ): OliphauntDatabase = OliphauntDatabase.open(
        config = config,
        engine =
        AndroidNativeDirectEngine(
            context = context,
            libraryPath = libraryPath,
            runtimeDirectory = runtimeDirectory,
            username = username,
            database = database,
        ),
    )

    public suspend fun restore(
        context: Context,
        request: RestoreRequest,
        libraryPath: String? = null,
    ): String = AndroidNativeDirectEngine(
        context = context,
        libraryPath = libraryPath,
    ).restore(request)
}
