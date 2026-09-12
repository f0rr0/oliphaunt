package dev.oliphaunt.reactnative

interface OliphauntJsiCallback {
  fun resolveBytes(response: ByteArray)

  fun resolveString(value: String)

  fun resolveUnit()

  fun reject(code: String, message: String?)
}
