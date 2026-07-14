package dev.oliphaunt.reactnative

import com.facebook.proguard.annotations.DoNotStrip

@DoNotStrip
class OliphauntJsiStreamCallback @DoNotStrip constructor(
  private val token: Long,
) {
  fun emitChunk(chunk: ByteArray) {
    nativeEmitChunk(token, chunk)
  }

  fun resolveUnit() {
    nativeResolveUnit(token)
  }

  fun reject(code: String, message: String?) {
    nativeReject(token, if (message.isNullOrBlank()) code else "$code: $message")
  }

  private external fun nativeEmitChunk(token: Long, chunk: ByteArray)

  private external fun nativeResolveUnit(token: Long)

  private external fun nativeReject(token: Long, message: String)
}
