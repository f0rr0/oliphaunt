package dev.oliphaunt.reactnative

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class NativeDirectProcessOwnerTest {
  @Test
  fun rejectsDuplicateUntilTheActiveClaimIsReleased() = runBlocking {
    val owner = NativeDirectProcessOwner<String>()
    val first = owner.acquire { fail("nothing should be retained") }

    assertFails<IllegalStateException> {
      owner.acquire { fail("nothing should be retained") }
    }

    owner.release(first)
    val second = owner.acquire { fail("nothing should be retained") }
    assertNotEquals(first, second)
  }

  @Test
  fun retainsAFailedCloseAndRecoversItBeforeTheNextOpen() = runBlocking {
    val owner = NativeDirectProcessOwner<String>()
    val first = owner.acquire { fail("nothing should be retained") }
    owner.retain(first, "database")
    val attempts = AtomicInteger(0)

    assertFails<IllegalStateException> {
      owner.acquire { retained ->
        assertEquals("database", retained)
        attempts.incrementAndGet()
        error("injected close failure")
      }
    }

    val recovered = owner.acquire { retained ->
      assertEquals("database", retained)
      attempts.incrementAndGet()
    }
    assertEquals(2, attempts.get())
    assertNotEquals(first, recovered)

    // A stale completion from the retained owner cannot release the new claim.
    owner.release(first)
    assertFails<IllegalStateException> {
      owner.acquire { fail("nothing should be retained") }
    }
    owner.release(recovered)
  }

  @Test
  fun admitsOnlyOneConcurrentOpenAcrossModuleInstances() {
    val owner = NativeDirectProcessOwner<String>()
    val start = CountDownLatch(1)
    val acquired = AtomicInteger(0)
    val contenders = List(16) {
      thread(start = false) {
        start.await()
        runBlocking {
          runCatching { owner.acquire {} }
            .onSuccess { acquired.incrementAndGet() }
        }
      }
    }

    contenders.forEach(Thread::start)
    start.countDown()
    contenders.forEach(Thread::join)

    assertEquals(1, acquired.get())
  }

  @Test
  fun moduleUsesProcessOwnershipAndRetainsInvalidationFailures() {
    val moduleSource = File(
      System.getProperty("user.dir"),
      "src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt",
    ).readText()
    val openSource = moduleSource.substringAfter("override fun open")
      .substringBefore("fun execProtocolRawBytes")
    val closeSource = moduleSource.substringAfter("override fun close")
      .substringBefore("override fun invalidate")
    val invalidateSource = moduleSource.substringAfter("override fun invalidate")
      .substringBefore("fun restoreBytes")

    assertTrue(openSource.contains("nativeDirectProcessOwner.acquire"))
    assertTrue(closeSource.contains("nativeDirectProcessOwner.release"))
    assertTrue(invalidateSource.contains("nativeDirectProcessOwner.retain"))
    assertTrue(invalidateSource.contains("openToJoin?.join()"))
    assertTrue(moduleSource.contains("private val nativeDirectProcessOwner"))
  }

  private suspend inline fun <reified T : Throwable> assertFails(
    crossinline block: suspend () -> Unit,
  ): T {
    try {
      block()
    } catch (error: Throwable) {
      if (error is T) return error
      throw error
    }
    throw AssertionError("expected ${T::class.java.simpleName}")
  }
}
