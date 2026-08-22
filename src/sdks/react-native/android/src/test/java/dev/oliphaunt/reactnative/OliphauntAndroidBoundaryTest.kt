package dev.oliphaunt.reactnative

import dev.oliphaunt.Oliphaunt
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OliphauntAndroidBoundaryTest {
  @Test
  fun turboModuleHandlesRequireFinitePositiveSafeIntegers() {
    assertEquals(1L, requireReactNativeHandle(1.0))
    assertEquals(
      REACT_NATIVE_MAX_SAFE_INTEGER_HANDLE,
      requireReactNativeHandle(REACT_NATIVE_MAX_SAFE_INTEGER_HANDLE.toDouble()),
    )

    listOf(
      Double.NaN,
      Double.POSITIVE_INFINITY,
      Double.NEGATIVE_INFINITY,
      -1.0,
      0.0,
      1.5,
      REACT_NATIVE_MAX_SAFE_INTEGER_HANDLE.toDouble() + 1.0,
    ).forEach(::assertInvalidReactNativeHandle)
    listOf(
      Long.MIN_VALUE,
      -1L,
      0L,
      REACT_NATIVE_MAX_SAFE_INTEGER_HANDLE + 1L,
      Long.MAX_VALUE,
    ).forEach(::assertInvalidReactNativeHandle)
  }

  @Test
  fun iosTurboModuleValidatesHandlesBeforeEveryLookupAndRemoval() {
    val iosSource = File(System.getProperty("user.dir"), "../ios/Oliphaunt.mm").readText()

    assertTrue(
      "React Native iOS must reject non-finite, fractional, and unsafe numeric handles",
      iosSource.contains("std::isfinite(handle)") &&
        iosSource.contains("std::trunc(handle) == handle") &&
        iosSource.contains("handle <= kOliphauntMaxSafeIntegerHandle"),
    )
    assertTrue(
      "React Native iOS must canonicalize validated handles through one checked helper",
      iosSource.contains("static NSNumber *_Nullable OliphauntHandleKey(double handle)") &&
        iosSource.contains("NSNumber *key = OliphauntHandleKey(handle);"),
    )
    assertFalse(
      "React Native iOS must not cast unchecked TurboModule doubles into dictionary keys",
      iosSource.contains("@(static_cast<uint64_t>(handle))") &&
        !iosSource.substringAfter("static NSNumber *_Nullable OliphauntHandleKey(double handle)")
          .substringBefore("#ifdef RCT_NEW_ARCH_ENABLED")
          .contains("OliphauntIsValidHandle(handle)"),
    )
  }

  @Test
  fun iosRetainsNativeDirectOwnershipAcrossModuleInvalidation() {
    val iosSource = File(System.getProperty("user.dir"), "../ios/Oliphaunt.mm").readText()

    assertTrue(iosSource.contains("static void OliphauntAcquireNativeDirect"))
    assertTrue(iosSource.contains("OliphauntRetainedNativeDirectDatabase = database"))
    assertTrue(iosSource.contains("static void OliphauntFinishNativeDirectCleanup"))
    assertTrue(iosSource.contains("BOOL retainOnFailure"))
    assertTrue(iosSource.contains("OliphauntNativeDirectCleanupAlreadyInFlight"))
    assertFalse(
      "iOS invalidation must not abandon an in-flight owner after an arbitrary timeout",
      iosSource.contains("dispatch_group_wait"),
    )
  }

  @Test
  fun iosProtocolStreamAcknowledgesEachCallback() {
    val iosSource = File(System.getProperty("user.dir"), "../ios/Oliphaunt.mm").readText()
    val adapterSource = File(
      System.getProperty("user.dir"),
      "../ios/OliphauntAdapter.swift",
    ).readText()

    assertTrue(
      "React Native iOS JSI must use the bounded callback contract",
      iosSource.contains("class OliphauntChunkAcknowledgement") &&
        iosSource.contains("acknowledgement->wait()") &&
        iosSource.contains("OliphauntProtocolStreamCallbackError") &&
        adapterSource.contains("if let error = chunkBox.value") &&
        adapterSource.contains("throw error"),
    )
  }

  @Test
  fun reactNativeAndroidDelegatesRuntimeToKotlinSdk() {
    assertEquals("dev.oliphaunt.Oliphaunt", Oliphaunt::class.java.name)

    val nativeSourceDir = File(System.getProperty("user.dir"), "src/main/cpp")
    val nativeSources = nativeSourceDir
      .takeIf(File::isDirectory)
      ?.walkTopDown()
      ?.filter(File::isFile)
      ?.toList()
      ?: emptyList()

    val nativeSourceNames = nativeSources
      .map { it.relativeTo(nativeSourceDir).invariantSeparatorsPath }
      .sorted()
    assertEquals(
      "React Native Android should only carry the JSI installer and must not duplicate the native C++ runtime",
      listOf("CMakeLists.txt", "OliphauntJsiBindings.cpp", "include/oliphaunt.h"),
      nativeSourceNames,
    )

    val moduleSource = File(
      System.getProperty("user.dir"),
      "src/main/java/dev/oliphaunt/reactnative/OliphauntModule.kt",
    ).readText()
    assertFalse(
      "React Native Android must not expose repository qualification APIs",
      moduleSource.contains("packageSizeReport") || moduleSource.contains("processMemory"),
    )
    assertTrue(
      "React Native Android must reject non-string extension entries before Kotlin SDK open",
      moduleSource.contains("extensions must be an array of strings"),
    )
    assertFalse(
      "React Native Android must not silently drop malformed extension entries",
      moduleSource.contains("getString(index)?.let(::add)"),
    )
    assertTrue(
      "React Native Android must reject invalid startup identity before Kotlin SDK open",
      moduleSource.contains("startupIdentity") &&
        moduleSource.contains("username must not contain NUL bytes"),
    )
    assertTrue(
      "React Native Android must reject malformed scalar config values before Kotlin SDK open",
      moduleSource.contains("getType(name) == ReadableType.String") &&
        moduleSource.contains("\$name must be a string"),
    )
    assertFalse(
      "React Native Android app configuration must not expose native path overrides",
      moduleSource.contains("config.pathOverride"),
    )
    assertTrue(
      "React Native Android must reject NUL-containing storage and restore paths before crossing the Kotlin SDK boundary",
      moduleSource.contains("validatePath") &&
        moduleSource.contains("must not contain NUL bytes"),
    )
    assertTrue(
      "React Native Android must expose a byte-array JSI hook that delegates to the Kotlin SDK session",
      moduleSource.contains("fun execProtocolRawBytes") &&
        moduleSource.contains("session.execProtocolRaw(request)"),
    )
    assertTrue(
      "React Native Android must stream through the Kotlin SDK and propagate acknowledged callback failures",
      moduleSource.contains("fun execProtocolStreamBytes") &&
        moduleSource.contains("session.execProtocolStream(request)") &&
        moduleSource.contains("callback.emitChunk(chunk)"),
    )
    assertTrue(
      "React Native Android must expose byte-array JSI backup/restore hooks instead of base64 TurboModule binary APIs",
      moduleSource.contains("fun backupBytes") &&
        moduleSource.contains("fun restoreBytes") &&
        !moduleSource.contains("Base64"),
    )
    assertTrue(
      "React Native Android must install a New Architecture JSI transport for ArrayBuffer protocol calls",
      moduleSource.contains("TurboModuleWithJSIBindings") &&
        moduleSource.contains("external override fun getBindingsInstaller()"),
    )
    assertFalse(
      "React Native Android must use the Kotlin SDK facade instead of constructing AndroidNativeDirectEngine",
      moduleSource.contains("AndroidNativeDirectEngine"),
    )

    val jsiSource = File(nativeSourceDir, "OliphauntJsiBindings.cpp").readText()
    assertTrue(
      "React Native Android JSI must validate handles before native Long casts",
      jsiSource.contains("copyHandleArgument") &&
        jsiSource.contains("positive safe integer") &&
        jsiSource.contains("std::isfinite"),
    )
    assertTrue(
      "React Native Android JSI must validate typed-array bounds before native size casts",
      jsiSource.contains("copySizeArgument") &&
        jsiSource.contains("typed-array byteOffset") &&
        jsiSource.contains("typed-array byteLength"),
    )
    assertTrue(
      "React Native Android JSI must acknowledge each stream callback before accepting another chunk",
      jsiSource.contains("class ChunkAcknowledgement") &&
        jsiSource.contains("acknowledgement->wait()") &&
        jsiSource.contains("protocol stream callback failed"),
    )
    val callbackSource = File(
      System.getProperty("user.dir"),
      "src/main/java/dev/oliphaunt/reactnative/OliphauntJsiStreamCallback.kt",
    ).readText()
    assertTrue(
      "React Native Android must surface a failed JSI acknowledgement to the Kotlin producer",
      callbackSource.contains("nativeEmitChunk(token, chunk)?.let") &&
        callbackSource.contains("throw IllegalStateException(error)"),
    )
  }

  private fun assertInvalidReactNativeHandle(handle: Double) {
    try {
      requireReactNativeHandle(handle)
      throw AssertionError("expected invalid React Native handle: $handle")
    } catch (error: IllegalArgumentException) {
      assertTrue(error.message.orEmpty().contains("positive safe integer"))
    }
  }

  private fun assertInvalidReactNativeHandle(handle: Long) {
    try {
      requireReactNativeHandle(handle)
      throw AssertionError("expected invalid React Native handle: $handle")
    } catch (error: IllegalArgumentException) {
      assertTrue(error.message.orEmpty().contains("positive safe integer"))
    }
  }
}
