package dev.oliphaunt

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class AndroidNativeOwnerTest {
    @Test
    fun ownerUsesOneDedicatedThreadInsteadOfTheCallerThread() = runBlocking {
        val caller = Thread.currentThread()
        val owner = newAndroidNativeOwnerDispatcher("oliphaunt-owner-test")
        try {
            val threads =
                List(8) {
                    async { runOnAndroidNativeOwner(owner) { Thread.currentThread() } }
                }.awaitAll()

            assertEquals(1, threads.toSet().size)
            assertNotEquals(caller, threads.first())
        } finally {
            owner.close()
        }
    }

    @Test
    fun admittedOwnerWorkFinishesAfterCallerCancellation() = runBlocking {
        val owner = newAndroidNativeOwnerDispatcher("oliphaunt-owner-cancel-test")
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        try {
            val caller =
                launch(start = CoroutineStart.UNDISPATCHED) {
                    runOnAndroidNativeOwner(owner) {
                        started.countDown()
                        release.await()
                        finished.countDown()
                    }
                }

            assertTrue(started.await(5, TimeUnit.SECONDS))
            caller.cancel()
            release.countDown()
            assertTrue(finished.await(5, TimeUnit.SECONDS))
            caller.join()
        } finally {
            owner.close()
        }
    }

    @Test
    fun forgottenHandleCleanupIsOneShotAndRunsOnTheOwner() {
        val executionOwner = newAndroidNativeOwnerDispatcher("oliphaunt-owner-cleaner-test")
        val cancellationOwner = newAndroidNativeOwnerDispatcher("oliphaunt-owner-cleaner-cancel-test")
        val callerThread = Thread.currentThread().name
        val closeThread = AtomicReference<String>()
        val closeCount = AtomicInteger()
        val closed = CountDownLatch(1)
        val state =
            AndroidNativeSessionState(
                nativeHandle = 42,
                executionDispatcher = executionOwner,
                cancellationDispatcher = cancellationOwner,
                closeNative = {
                    closeThread.set(Thread.currentThread().name)
                    closeCount.incrementAndGet()
                    closed.countDown()
                },
            )

        state.scheduleForgottenClose()
        state.scheduleForgottenClose()

        assertTrue(closed.await(5, TimeUnit.SECONDS))
        assertEquals(1, closeCount.get())
        assertNotEquals(callerThread, closeThread.get())
    }

    @Test
    fun cleanerRegistrationClaimsItsActionOnlyOnce() {
        val calls = AtomicInteger()
        val cleanable = AndroidNativeCleaner.register(Any()) { calls.incrementAndGet() }

        cleanable.clean()
        cleanable.clean()

        assertEquals(1, calls.get())
    }

    @Test
    fun forgottenHandleCleanupDrainsPreviouslyAdmittedOwnerWork() = runBlocking {
        val executionOwner = newAndroidNativeOwnerDispatcher("oliphaunt-owner-cleaner-order-test")
        val cancellationOwner = newAndroidNativeOwnerDispatcher("oliphaunt-owner-cleaner-order-cancel-test")
        val operationStarted = CountDownLatch(1)
        val operationRelease = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val events = mutableListOf<String>()
        val state =
            AndroidNativeSessionState(
                nativeHandle = 42,
                executionDispatcher = executionOwner,
                cancellationDispatcher = cancellationOwner,
                closeNative = {
                    events += "close"
                    closed.countDown()
                },
            )

        val operation =
            launch(start = CoroutineStart.UNDISPATCHED) {
                state.runOnExecutionOwner {
                    events += "operation"
                    operationStarted.countDown()
                    operationRelease.await()
                    events += "operation-finished"
                }
            }
        assertTrue(operationStarted.await(5, TimeUnit.SECONDS))

        state.scheduleForgottenClose()
        assertEquals(1L, closed.count)
        operationRelease.countDown()

        operation.join()
        assertTrue(closed.await(5, TimeUnit.SECONDS))
        assertEquals(listOf("operation", "operation-finished", "close"), events)
    }
}
