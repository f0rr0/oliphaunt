package dev.oliphaunt

internal object OliphauntAndroidNativeBridge {
    init {
        System.loadLibrary("oliphaunt_kotlin_android")
    }

    external fun openNative(
        libraryPath: String?,
        pgdata: String,
        runtimeDirectory: String,
        username: String,
        database: String,
        startupArgs: Array<String>,
    ): Long

    external fun execProtocolRawNative(
        handle: Long,
        request: ByteArray,
    ): ByteArray

    external fun execProtocolStreamNative(
        handle: Long,
        request: ByteArray,
        sink: OliphauntAndroidProtocolStreamSink,
    )

    external fun backupNative(
        handle: Long,
        format: String,
    ): ByteArray

    external fun restoreNative(
        root: String,
        format: String,
        artifact: ByteArray,
        replaceExisting: Boolean,
        libraryPath: String?,
    )

    external fun cancelNative(handle: Long)

    external fun closeNative(handle: Long)

    external fun capabilitiesNative(handle: Long): Long
}

internal fun interface OliphauntAndroidProtocolStreamSink {
    fun onChunk(chunk: ByteArray): Int
}
