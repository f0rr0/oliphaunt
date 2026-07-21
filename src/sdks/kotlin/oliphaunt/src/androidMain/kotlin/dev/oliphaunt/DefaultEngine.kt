package dev.oliphaunt

public actual fun defaultOliphauntEngine(mode: EngineMode): OliphauntEngine = AndroidContextRequiredEngine

private object AndroidContextRequiredEngine : OliphauntEngine {
    override fun supportedModes(): List<EngineModeSupport> = OliphauntAndroid.supportedModes()

    override suspend fun open(config: OliphauntConfig): OliphauntSession = throw when (config.mode) {
        EngineMode.NativeDirect -> {
            OliphauntException(
                "Android native-direct requires an android.content.Context; use OliphauntAndroid.open(context, config)",
            )
        }

        EngineMode.NativeBroker -> {
            OliphauntException(
                "Android broker mode requires a platform broker adapter; it is not aliased to direct mode",
            )
        }

        EngineMode.NativeServer -> {
            OliphauntException(
                "Android server mode requires a platform server adapter; it is not aliased to direct mode",
            )
        }
    }

    override suspend fun restore(request: RestoreRequest): String = throw OliphauntException(
        "Android restore requires an android.content.Context; use OliphauntAndroid.restore(context, request)",
    )
}
