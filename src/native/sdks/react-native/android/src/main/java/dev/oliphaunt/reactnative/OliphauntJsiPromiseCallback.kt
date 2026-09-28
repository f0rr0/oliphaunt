package dev.oliphaunt.reactnative

import com.facebook.proguard.annotations.DoNotStrip
import dev.oliphaunt.OliphauntBrokerException

@DoNotStrip
class OliphauntJsiPromiseCallback @DoNotStrip constructor(
  private val ownerId: Long,
  private val token: Long,
) : OliphauntJsiCallback {
  override fun resolveBytes(response: ByteArray) {
    nativeResolveBytes(ownerId, token, response)
  }

  override fun resolveString(value: String) {
    nativeResolveString(ownerId, token, value)
  }

  override fun resolveUnit() {
    nativeResolveUnit(ownerId, token)
  }

  override fun reject(code: String, message: String?) {
    nativeReject(ownerId, token, if (message.isNullOrBlank()) code else "$code: $message", "", "", false)
  }

  fun reject(error: Throwable) {
    val broker = error as? OliphauntBrokerException
    nativeReject(ownerId, token, error.message ?: "Oliphaunt operation failed",
      broker?.reason?.name?.replaceFirstChar { it.lowercaseChar() } ?: "",
      broker?.execution?.name?.replaceFirstChar { it.lowercaseChar() } ?: "",
      broker?.requiresReopen ?: false)
  }

  private external fun nativeResolveBytes(ownerId: Long, token: Long, response: ByteArray)

  private external fun nativeResolveString(ownerId: Long, token: Long, value: String)

  private external fun nativeResolveUnit(ownerId: Long, token: Long)

  private external fun nativeReject(ownerId: Long, token: Long, message: String, reason: String, execution: String, requiresReopen: Boolean)
}
