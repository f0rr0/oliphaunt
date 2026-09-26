package dev.oliphaunt.reactnative

import com.facebook.proguard.annotations.DoNotStrip

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
    nativeReject(ownerId, token, if (message.isNullOrBlank()) code else "$code: $message")
  }

  private external fun nativeResolveBytes(ownerId: Long, token: Long, response: ByteArray)

  private external fun nativeResolveString(ownerId: Long, token: Long, value: String)

  private external fun nativeResolveUnit(ownerId: Long, token: Long)

  private external fun nativeReject(ownerId: Long, token: Long, message: String)
}
