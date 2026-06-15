package dev.oliphaunt.reactnative

import com.facebook.proguard.annotations.DoNotStrip

@DoNotStrip
class OliphauntJsiPromiseCallback @DoNotStrip constructor(
  private val token: Long,
) : OliphauntJsiCallback {
  override fun resolveBytes(response: ByteArray) {
    nativeResolveBytes(token, response)
  }

  override fun resolveString(value: String) {
    nativeResolveString(token, value)
  }

  override fun reject(code: String, message: String?) {
    nativeReject(token, if (message.isNullOrBlank()) code else "$code: $message")
  }

  private external fun nativeResolveBytes(token: Long, response: ByteArray)

  private external fun nativeResolveString(token: Long, value: String)

  private external fun nativeReject(token: Long, message: String)
}
