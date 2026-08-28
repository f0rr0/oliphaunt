package dev.oliphaunt.reactnative

import com.facebook.proguard.annotations.DoNotStrip

@DoNotStrip
class OliphauntJsiStreamCallback @DoNotStrip constructor(
  private val token: Long,
) {
  fun emitChunk(chunk: ByteArray) {
    nativeEmitChunk(token, chunk)?.let { error ->
      throw IllegalStateException(error)
    }
  }

  fun resolveUnit() {
    nativeResolveUnit(token)
  }

  fun rejectCallbackAborted(message: String?) {
    nativeRejectCallbackAborted(
      token,
      message ?: "protocol stream callback aborted after recovery to ReadyForQuery",
    )
  }

  fun reject(code: String, message: String?) {
    nativeReject(token, if (message.isNullOrBlank()) code else "$code: $message")
  }

  private external fun nativeEmitChunk(token: Long, chunk: ByteArray): String?

  private external fun nativeResolveUnit(token: Long)

  private external fun nativeRejectCallbackAborted(token: Long, message: String)

  private external fun nativeReject(token: Long, message: String)
}
