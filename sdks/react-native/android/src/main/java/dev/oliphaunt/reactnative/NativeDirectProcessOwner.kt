package dev.oliphaunt.reactnative

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Process-wide nativeDirect ownership, including a failed close retained for recovery. */
internal class NativeDirectProcessOwner<T : Any> {
  internal class Claim internal constructor(internal val generation: Long)

  private data class Retained<T>(val claim: Claim, val value: T)

  private val mutex = Mutex()
  private var generation = 0L
  private var current: Claim? = null
  private var retained: Retained<T>? = null

  suspend fun acquire(closeRetained: suspend (T) -> Unit): Claim {
    mutex.lock()
    try {
      retained?.let { previous ->
        try {
          closeRetained(previous.value)
        } catch (error: Throwable) {
          throw IllegalStateException(
            "React Native nativeDirect could not recover the previously retained instance",
            error,
          )
        }
        retained = null
        current = null
      }
      check(current == null) {
        "React Native nativeDirect already has an active or pending open; close the active instance before opening another"
      }
      return Claim(++generation).also { current = it }
    } finally {
      mutex.unlock()
    }
  }

  suspend fun retain(claim: Claim, value: T) = mutex.withLock {
    check(current == claim) { "React Native nativeDirect ownership changed while retaining a failed close" }
    val previous = retained
    check(previous == null || previous.claim == claim && previous.value === value) {
      "React Native nativeDirect already retains a different failed close"
    }
    retained = Retained(claim, value)
  }

  suspend fun release(claim: Claim) = mutex.withLock {
    if (current == claim && retained?.claim != claim) {
      current = null
    }
  }
}
