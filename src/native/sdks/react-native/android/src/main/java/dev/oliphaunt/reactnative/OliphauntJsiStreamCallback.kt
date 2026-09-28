package dev.oliphaunt.reactnative

import com.facebook.proguard.annotations.DoNotStrip
import dev.oliphaunt.OliphauntBrokerException

@DoNotStrip
class OliphauntJsiStreamCallback @DoNotStrip constructor(
  private val ownerId: Long,
  private val token: Long,
) {
  fun emitChunk(chunk: ByteArray) {
    nativeEmitChunk(ownerId, token, chunk)?.let { error ->
      throw IllegalStateException(error)
    }
  }

  fun resolveUnit() {
    nativeResolveUnit(ownerId, token)
  }

  fun rejectCallbackAborted(message: String?) {
    nativeRejectCallbackAborted(
      ownerId,
      token,
      message ?: "protocol stream callback aborted after recovery to ReadyForQuery",
    )
  }

  fun reject(code: String, message: String?) {
    nativeReject(ownerId, token, if (message.isNullOrBlank()) code else "$code: $message", "", "", false)
  }

  fun reject(error: Throwable) {
    val broker = error as? OliphauntBrokerException
    nativeReject(ownerId, token, error.message ?: "Oliphaunt operation failed",
      broker?.reason?.name?.replaceFirstChar { it.lowercaseChar() } ?: "",
      broker?.execution?.name?.replaceFirstChar { it.lowercaseChar() } ?: "",
      broker?.requiresReopen ?: false)
  }

  private external fun nativeEmitChunk(ownerId: Long, token: Long, chunk: ByteArray): String?

  private external fun nativeResolveUnit(ownerId: Long, token: Long)

  private external fun nativeRejectCallbackAborted(ownerId: Long, token: Long, message: String)

  private external fun nativeReject(ownerId: Long, token: Long, message: String, reason: String, execution: String, requiresReopen: Boolean)
}
