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

    external fun execProtocolRawStreamNative(
        handle: Long,
        request: ByteArray,
        sink: OliphauntAndroidProtocolStreamSink,
    ): Boolean

    external fun backupNative(handle: Long): ByteArray

    external fun restoreNative(
        destination: String,
        bytes: ByteArray,
        libraryPath: String?,
    )

    external fun cancelNative(handle: Long)

    external fun closeNative(handle: Long)
}

internal fun interface OliphauntAndroidProtocolStreamSink {
    fun onChunk(chunk: ByteArray): Int
}
