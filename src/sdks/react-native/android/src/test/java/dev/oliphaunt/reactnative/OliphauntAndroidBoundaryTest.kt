package dev.oliphaunt.reactnative

import dev.oliphaunt.OliphauntAndroid
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OliphauntAndroidBoundaryTest {
  @Test
  fun reactNativeAndroidDelegatesRuntimeToKotlinSdk() {
    assertEquals("dev.oliphaunt.OliphauntAndroid", OliphauntAndroid::class.java.name)

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
    assertTrue(
      "React Native Android must delegate package-size evidence to OliphauntAndroid",
      moduleSource.contains("OliphauntAndroid.packageSizeReport"),
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
    assertTrue(
      "React Native Android must reject blank native override paths before Kotlin SDK open",
      moduleSource.contains("pathOverride") &&
        moduleSource.contains("libraryPath must not be empty"),
    )
    assertTrue(
      "React Native Android must reject NUL-containing roots before Kotlin SDK open/restore",
      moduleSource.contains("validateRootPath") &&
        moduleSource.contains("must not contain NUL bytes"),
    )
    assertTrue(
      "React Native Android must expose a byte-array JSI hook that delegates to the Kotlin SDK session",
      moduleSource.contains("fun execProtocolRawBytes") &&
        moduleSource.contains("session.execProtocolRaw(ProtocolRequest(request)).bytes"),
    )
    assertTrue(
      "React Native Android must expose a true chunked JSI stream hook that delegates to the Kotlin SDK session",
      moduleSource.contains("fun execProtocolStreamBytes") &&
        moduleSource.contains("session.execProtocolStream(ProtocolRequest(request))") &&
        moduleSource.contains("callback.emitChunk(chunk.bytes)"),
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
      "React Native Android JSI must install a real chunked stream transport before protocolStream can be advertised",
      jsiSource.contains("\"execProtocolStream\"") &&
        jsiSource.contains("OliphauntJsiStreamCallback") &&
        jsiSource.contains("nativeEmitChunk"),
    )
  }
}
