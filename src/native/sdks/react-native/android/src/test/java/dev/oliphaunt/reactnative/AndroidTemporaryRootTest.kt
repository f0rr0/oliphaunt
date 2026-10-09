package dev.oliphaunt.reactnative

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import android.content.res.AssetManager
import dev.oliphaunt.Oliphaunt
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class AndroidTemporaryRootTest {
  @Test
  fun failedOverlappingPublicOpensPreserveAnotherPreparationsPublishedRoot() {
    val context = RuntimeEnvironment.getApplication()
    val preparing = CountDownLatch(1)
    val release = CountDownLatch(1)
    val executor = Executors.newSingleThreadExecutor()
    val runtime = File(context.cacheDir, "explicit-runtime").also { it.mkdirs() }
    val firstContext = object : ContextWrapper(context) {
      override fun getApplicationContext(): Context = this
      override fun getAssets(): AssetManager {
        preparing.countDown()
        check(release.await(10, TimeUnit.SECONDS)) { "preparation was not released" }
        throw IllegalStateException("seed read failed")
      }
    }
    val first = executor.submit<Throwable?> {
      runCatching { runBlocking { Oliphaunt.open(firstContext, runtimeDirectory = runtime) } }.exceptionOrNull()
    }
    var root: File? = null
    try {
      assertTrue("first open did not reach staging", preparing.await(10, TimeUnit.SECONDS))
      root = context.cacheDir.listFiles()!!.single { it.name.startsWith("oliphaunt-direct-") }
      val staging = context.cacheDir.listFiles()!!.single { it.name.startsWith(".oliphaunt-root-") }
      // Model the complete tree published by a concurrent initializer while
      // the first attempt is waiting for its seed. No native backend is mocked.
      val fixture = JSONObject(File("../../../../test-fixtures/storage/database-root.json").readText())
      val descriptors = fixture.getJSONArray("validDescriptors")
      val descriptor = (0 until descriptors.length()).map(descriptors::getJSONObject)
        .first { it.getString("engineFamily") == "native" }
      File(root, ".oliphaunt.json").writeText("$descriptor\n")
      val pgdata = File(root, "pgdata").also { it.mkdir() }
      File(pgdata, "PG_VERSION").writeText("18\n")
      File(pgdata, "global").mkdir()
      File(pgdata, "pg_wal").mkdir()
      val control = File(pgdata, "global/pg_control").also { it.writeText("published-owner") }
      val modified = control.lastModified()
      val secondContext = object : ContextWrapper(context) {
        override fun getApplicationContext(): Context = this
        override fun getApplicationInfo(): ApplicationInfo = throw IllegalStateException("library lookup failed")
      }
      val secondError = runCatching {
        runBlocking { Oliphaunt.open(secondContext, runtimeDirectory = runtime) }
      }.exceptionOrNull()
      assertEquals("library lookup failed", secondError?.message)
      release.countDown()
      assertTrue(first.get(10, TimeUnit.SECONDS)?.message.orEmpty().contains("seed read failed"))
      assertTrue("the failing attempt must remove only its staging directory", !staging.exists())
      assertEquals("published-owner", control.readText())
      assertEquals(modified, control.lastModified())
      assertEquals("18\n", File(pgdata, "PG_VERSION").readText())
      assertTrue(File(root, ".oliphaunt.json").isFile)
    } finally {
      release.countDown()
      executor.shutdownNow()
      root?.deleteRecursively()
      runtime.deleteRecursively()
    }
  }
}
