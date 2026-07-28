package dev.oliphaunt

public actual fun defaultOliphauntEngine(mode: EngineMode): OliphauntEngine = when (mode) {
    EngineMode.NativeDirect -> NativeDirectEngine()

    EngineMode.NativeBroker,
    EngineMode.NativeServer,
    -> RuntimeUnavailableEngine()
}
