package dev.oliphaunt.reactnative

import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.turbomodule.core.interfaces.BindingsInstallerHolder
import com.facebook.react.turbomodule.core.interfaces.TurboModuleWithJSIBindings
import com.facebook.soloader.SoLoader
import android.os.Debug
import dev.oliphaunt.BackupArtifact
import dev.oliphaunt.BackupFormat
import dev.oliphaunt.BackupRequest
import dev.oliphaunt.DatabaseStorage
import dev.oliphaunt.DurabilityProfile
import dev.oliphaunt.EngineCapabilities
import dev.oliphaunt.EngineMode
import dev.oliphaunt.EngineModeSupport
import dev.oliphaunt.OliphauntAndroid
import dev.oliphaunt.OliphauntConfig
import dev.oliphaunt.OliphauntDatabase
import dev.oliphaunt.OliphauntExtensionSizeReport
import dev.oliphaunt.OliphauntPackageSizeReport
import dev.oliphaunt.PostgresStartupGuc
import dev.oliphaunt.ProtocolRequest
import dev.oliphaunt.RestoreRequest
import dev.oliphaunt.RestoreDestinationPolicy
import dev.oliphaunt.RuntimeFootprintProfile
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Process-wide nativeDirect ownership, including a failed close retained for recovery. */
private val nativeDirectProcessOwner = NativeDirectProcessOwner<OliphauntDatabase>()

internal const val REACT_NATIVE_MAX_SAFE_INTEGER_HANDLE: Long = 9_007_199_254_740_991L

internal fun requireReactNativeHandle(handle: Double): Long {
  if (
    !handle.isFinite() ||
    handle <= 0.0 ||
    handle % 1.0 != 0.0 ||
    handle > REACT_NATIVE_MAX_SAFE_INTEGER_HANDLE.toDouble()
  ) {
    throw IllegalArgumentException("Oliphaunt handle must be a finite positive safe integer")
  }
  return handle.toLong()
}

internal fun requireReactNativeHandle(handle: Long): Long {
  if (handle !in 1..REACT_NATIVE_MAX_SAFE_INTEGER_HANDLE) {
    throw IllegalArgumentException("Oliphaunt handle must be a finite positive safe integer")
  }
  return handle
}

class OliphauntModule(
  private val reactContext: ReactApplicationContext,
) : NativeOliphauntSpec(reactContext), TurboModuleWithJSIBindings {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val nextHandle = AtomicLong(1)
  private val sessions = ConcurrentHashMap<Long, OliphauntDatabase>()
  private val sessionMutex = Mutex()
  private val invalidated = AtomicBoolean(false)
  private val pendingOpen = AtomicReference<Job?>(null)
  private val lifecycleLock = Any()
  private var nativeDirectClaim: NativeDirectProcessOwner.Claim? = null

  override fun getName(): String = NAME

  @DoNotStrip
  external override fun getBindingsInstaller(): BindingsInstallerHolder

  override fun supportedModes(promise: Promise) {
    promise.resolve(
      WritableNativeArray().apply {
        OliphauntAndroid.supportedModes().forEach { pushMap(it.toWritableMap()) }
      },
    )
  }

  override fun packageSizeReport(config: ReadableMap, promise: Promise) {
    scope.launch {
      runCatching {
        val configuredRoot = config.pathOverride("resourceRoot")
        val report = configuredRoot
          ?.let { root -> OliphauntAndroid.packageSizeReport(File(root)) }
          ?: OliphauntAndroid.packageSizeReport(reactContext)
        report?.toWritableMap()
      }.fold(
        onSuccess = promise::resolve,
        onFailure = { error -> promise.reject("liboliphaunt_package_size_failed", error.message, error) },
      )
    }
  }

  override fun processMemory(promise: Promise) {
    promise.resolve(processMemoryReport())
  }

  override fun open(config: ReadableMap, promise: Promise) {
    val job = scope.launch(start = CoroutineStart.LAZY) {
      runCatching {
        val openConfig = parseOpenConfig(config)
        sessionMutex.withLock {
          check(!invalidated.get()) { "React Native Oliphaunt module has been invalidated" }
          if (sessions.isNotEmpty()) {
            throw IllegalStateException(
              "React Native nativeDirect already has an active instance",
            )
          }
          val handle = requireReactNativeHandle(nextHandle.getAndIncrement())
          val claim = nativeDirectProcessOwner.acquire { retained -> retained.close() }
          val session = try {
            OliphauntAndroid.open(
              context = reactContext,
              config = openConfig.config,
              libraryPath = openConfig.libraryPath,
              runtimeDirectory = openConfig.runtimeDirectory,
              resourceRoot = openConfig.resourceRoot?.let(::File),
              username = openConfig.username,
              database = openConfig.database,
            )
          } catch (error: Throwable) {
            nativeDirectProcessOwner.release(claim)
            throw error
          }
          if (invalidated.get()) {
            try {
              session.close()
              nativeDirectProcessOwner.release(claim)
            } catch (closeError: Throwable) {
              nativeDirectProcessOwner.retain(claim, session)
              throw IllegalStateException(
                "React Native Oliphaunt module was invalidated while opening nativeDirect; cleanup failed and is retained for the next open",
                closeError,
              )
            }
            throw IllegalStateException(
              "React Native Oliphaunt module was invalidated while opening nativeDirect",
            )
          }
          nativeDirectClaim = claim
          sessions[handle] = session
          handle.toDouble()
        }
      }.fold(
        onSuccess = promise::resolve,
        onFailure = { error -> promise.reject("liboliphaunt_open_failed", error.message, error) },
      )
    }
    synchronized(lifecycleLock) {
      if (invalidated.get()) {
        job.cancel()
        val error = IllegalStateException("React Native Oliphaunt module has been invalidated")
        promise.reject("liboliphaunt_invalidated", error.message, error)
        return
      }
      if (!pendingOpen.compareAndSet(null, job)) {
        job.cancel()
        val error = IllegalStateException(
          "React Native nativeDirect already has an active or pending open; close the active instance before opening another",
        )
        promise.reject("liboliphaunt_open_failed", error.message, error)
        return
      }
      job.invokeOnCompletion { pendingOpen.compareAndSet(job, null) }
      job.start()
    }
  }

  @DoNotStrip
  fun execProtocolRawBytes(
    handle: Long,
    request: ByteArray,
    callback: OliphauntJsiPromiseCallback,
  ) {
    val key = try {
      requireReactNativeHandle(handle)
    } catch (error: IllegalArgumentException) {
      callback.reject("liboliphaunt_invalid_handle", error.message)
      return
    }
    val session = sessions[key]
    if (session == null) {
      callback.reject("liboliphaunt_unknown_handle", "unknown Oliphaunt handle")
      return
    }
    scope.launch {
      runCatching {
        session.execProtocolRaw(ProtocolRequest(request)).bytes
      }.fold(
        onSuccess = callback::resolveBytes,
        onFailure = { error -> callback.reject("liboliphaunt_exec_failed", error.message) },
      )
    }
  }

  @DoNotStrip
  fun execProtocolStreamBytes(
    handle: Long,
    request: ByteArray,
    callback: OliphauntJsiStreamCallback,
  ) {
    val key = try {
      requireReactNativeHandle(handle)
    } catch (error: IllegalArgumentException) {
      callback.reject("liboliphaunt_invalid_handle", error.message)
      return
    }
    val session = sessions[key]
    if (session == null) {
      callback.reject("liboliphaunt_unknown_handle", "unknown Oliphaunt handle")
      return
    }
    scope.launch {
      runCatching {
        session.execProtocolStream(ProtocolRequest(request)) { chunk ->
          callback.emitChunk(chunk.bytes)
        }
      }.fold(
        onSuccess = { callback.resolveUnit() },
        onFailure = { error -> callback.reject("liboliphaunt_stream_failed", error.message) },
      )
    }
  }

  @DoNotStrip
  fun backupBytes(
    handle: Long,
    format: String,
    callback: OliphauntJsiPromiseCallback,
  ) {
    val key = try {
      requireReactNativeHandle(handle)
    } catch (error: IllegalArgumentException) {
      callback.reject("liboliphaunt_invalid_handle", error.message)
      return
    }
    val session = sessions[key]
    if (session == null) {
      callback.reject("liboliphaunt_unknown_handle", "unknown Oliphaunt handle")
      return
    }
    scope.launch {
      runCatching {
        session.backup(BackupRequest(parseBackupFormat(format))).bytes
      }.fold(
        onSuccess = callback::resolveBytes,
        onFailure = { error -> callback.reject("liboliphaunt_backup_failed", error.message) },
      )
    }
  }

  override fun close(handle: Double, promise: Promise) {
    val key = try {
      requireReactNativeHandle(handle)
    } catch (error: IllegalArgumentException) {
      promise.reject("liboliphaunt_invalid_handle", error.message, error)
      return
    }
    scope.launch {
      runCatching {
        sessionMutex.withLock {
          val session = sessions[key]
          if (session != null) {
            session.close()
            if (sessions.remove(key, session)) {
              nativeDirectClaim?.let { claim -> nativeDirectProcessOwner.release(claim) }
              nativeDirectClaim = null
            }
          }
        }
      }.fold(
        onSuccess = { promise.resolve(null) },
        onFailure = { error -> promise.reject("liboliphaunt_close_failed", error.message, error) },
      )
    }
  }

  override fun invalidate() {
    val openToJoin = synchronized(lifecycleLock) {
      invalidated.set(true)
      pendingOpen.get()
    }
    runBlocking(Dispatchers.IO) {
      openToJoin?.join()
      val sessionsToClose = sessionMutex.withLock { sessions.entries.map { it.key to it.value } }
      sessionsToClose.forEach { (key, session) ->
        sessionMutex.withLock {
          val claim = nativeDirectClaim
          try {
            session.close()
            sessions.remove(key, session)
            if (claim != null) {
              nativeDirectProcessOwner.release(claim)
            }
          } catch (_: Throwable) {
            sessions.remove(key, session)
            if (claim != null) {
              nativeDirectProcessOwner.retain(claim, session)
            }
          }
          nativeDirectClaim = null
        }
      }
    }
    scope.cancel()
    super.invalidate()
  }

  @DoNotStrip
  fun restoreBytes(
    destination: String,
    format: String,
    artifact: ByteArray,
    replaceExisting: Boolean,
    libraryPath: String?,
    callback: OliphauntJsiPromiseCallback,
  ) {
    scope.launch {
      runCatching {
        validatePath(destination, "restore destination")
        val request = RestoreRequest(
          artifact = BackupArtifact(parseBackupFormat(format), artifact),
          destination = destination,
          destinationPolicy = if (replaceExisting) {
            RestoreDestinationPolicy.ReplaceExisting
          } else {
            RestoreDestinationPolicy.FailIfExists
          },
        )
        OliphauntAndroid.restore(
          context = reactContext,
          request = request,
          libraryPath = reactNativeLibraryPath(validatePathOverride(libraryPath, "libraryPath")),
        )
      }.fold(
        onSuccess = callback::resolveString,
        onFailure = { error -> callback.reject("liboliphaunt_restore_failed", error.message) },
      )
    }
  }

  override fun cancel(handle: Double, promise: Promise) {
    val session = sessionFor(handle, promise) ?: return
    scope.launch {
      runCatching {
        session.cancel()
      }.fold(
        onSuccess = { promise.resolve(null) },
        onFailure = { error -> promise.reject("liboliphaunt_cancel_failed", error.message, error) },
      )
    }
  }

  override fun capabilities(handle: Double, promise: Promise) {
    val session = sessionFor(handle, promise) ?: return
    scope.launch {
      runCatching {
        session.capabilities().toWritableMap()
      }.fold(
        onSuccess = promise::resolve,
        onFailure = { error -> promise.reject("liboliphaunt_capabilities_failed", error.message, error) },
      )
    }
  }

  private fun sessionFor(handle: Double, promise: Promise): OliphauntDatabase? {
    val key = try {
      requireReactNativeHandle(handle)
    } catch (error: IllegalArgumentException) {
      promise.reject("liboliphaunt_invalid_handle", error.message, error)
      return null
    }
    val session = sessions[key]
    if (session == null) {
      promise.reject("liboliphaunt_unknown_handle", "unknown Oliphaunt handle")
    }
    return session
  }

  private fun parseOpenConfig(config: ReadableMap): ReactNativeAndroidOpenConfig {
    val mode = parseEngineMode(config.string("engine") ?: "nativeDirect")
    if (mode != EngineMode.NativeDirect) {
      throw IllegalArgumentException("React Native Android currently supports NativeDirect, got $mode")
    }
    val storage = when (val kind = config.string("storageKind") ?: "temporaryDirectory") {
      "temporaryDirectory" -> DatabaseStorage.TemporaryDirectory
      "directory" -> DatabaseStorage.Directory(
        validatePath(config.string("storagePath"), "database storage directory"),
      )
      "applicationData" -> {
        val name = validateApplicationDataName(config.string("storageName"))
        DatabaseStorage.Directory(File(File(reactContext.filesDir, "Oliphaunt"), name).absolutePath)
      }
      else -> throw IllegalArgumentException("unknown database storage kind '$kind'")
    }
    val runtimeDirectory = reactNativeRuntimeDirectory(config.pathOverride("runtimeDirectory"))
    val libraryPath = reactNativeLibraryPath(config.pathOverride("libraryPath"))
    val resourceRoot = config.pathOverride("resourceRoot")
    val username = config.startupIdentity("username")
    val database = config.startupIdentity("database")

    return ReactNativeAndroidOpenConfig(
      config = OliphauntConfig(
        mode = mode,
        storage = storage,
        durability = parseDurability(config.string("durability") ?: "balanced"),
        runtimeFootprint = parseRuntimeFootprint(config.string("runtimeFootprint") ?: "balancedMobile"),
        startupGucs = config.startupGucs("startupGUCs"),
        username = username,
        database = database,
        extensions = config.stringList("extensions"),
      ),
      libraryPath = libraryPath,
      runtimeDirectory = runtimeDirectory,
      resourceRoot = resourceRoot,
      username = username ?: "postgres",
      database = database ?: "postgres",
    )
  }

  private data class ReactNativeAndroidOpenConfig(
    val config: OliphauntConfig,
    val libraryPath: String?,
    val runtimeDirectory: String?,
    val resourceRoot: String?,
    val username: String,
    val database: String,
  )

  companion object {
    const val NAME = "Oliphaunt"

    init {
      SoLoader.loadLibrary("oliphauntreactnative")
    }

    private fun ReadableMap.string(name: String): String? =
      when {
        !hasKey(name) || isNull(name) -> null
        getType(name) == ReadableType.String -> getString(name)
        else -> throw IllegalArgumentException("$name must be a string")
      }

    private fun ReadableMap.array(name: String): ReadableArray? =
      when {
        !hasKey(name) || isNull(name) -> null
        getType(name) == ReadableType.Array -> getArray(name)
        else -> throw IllegalArgumentException(arrayOfStringsMessage(name))
      }

    private fun ReadableMap.stringList(name: String): List<String> {
      val array = array(name) ?: return emptyList()
      return buildList {
        for (index in 0 until array.size()) {
          if (array.getType(index) != ReadableType.String) {
            throw IllegalArgumentException(arrayOfStringsMessage(name))
          }
          add(array.getString(index).orEmpty())
        }
      }
    }

    private fun ReadableMap.startupIdentity(name: String): String? {
      val value = string(name) ?: return null
      if (value.isBlank()) {
        throw IllegalArgumentException(startupIdentityMessage(name, StartupIdentityError.Empty))
      }
      if (value.any { it.code == 0 }) {
        throw IllegalArgumentException(startupIdentityMessage(name, StartupIdentityError.Nul))
      }
      return value
    }

    private fun ReadableMap.startupGucs(name: String): List<PostgresStartupGuc> =
      stringList(name).map { assignment ->
        val separator = assignment.indexOf('=')
        if (separator < 0) {
          throw IllegalArgumentException("PostgreSQL startup GUC string must use name=value")
        }
        PostgresStartupGuc(
          name = assignment.substring(0, separator),
          value = assignment.substring(separator + 1),
        )
      }

    private fun validatePath(value: String?, label: String): String {
      if (value.isNullOrBlank()) {
        throw IllegalArgumentException("$label must not be empty")
      }
      if (value.any { it.code == 0 }) {
        throw IllegalArgumentException("$label must not contain NUL bytes")
      }
      return value
    }

    private fun validateApplicationDataName(value: String?): String {
      val name = value?.trim().orEmpty()
      if (name == "." || name == ".." || !PORTABLE_STORAGE_NAME.matches(name)) {
        throw IllegalArgumentException(
          "applicationData storage name must contain 1 to 128 ASCII letters, digits, dot, underscore or hyphen",
        )
      }
      return name
    }

    private val PORTABLE_STORAGE_NAME = Regex("[A-Za-z0-9._-]{1,128}")

    private fun ReadableMap.pathOverride(name: String): String? =
      validatePathOverride(string(name), name)

    private fun validatePathOverride(value: String?, name: String): String? {
      if (value == null) {
        return null
      }
      if (value.isBlank()) {
        throw IllegalArgumentException(pathOverrideMessage(name, PathOverrideError.Empty))
      }
      if (value.any { it.code == 0 }) {
        throw IllegalArgumentException(pathOverrideMessage(name, PathOverrideError.Nul))
      }
      return value
    }

    private enum class PathOverrideError {
      Empty,
      Nul,
    }

    private fun pathOverrideMessage(name: String, error: PathOverrideError): String =
      when (name to error) {
        "libraryPath" to PathOverrideError.Empty -> "libraryPath must not be empty"
        "libraryPath" to PathOverrideError.Nul -> "libraryPath must not contain NUL bytes"
        "runtimeDirectory" to PathOverrideError.Empty -> "runtimeDirectory must not be empty"
        "runtimeDirectory" to PathOverrideError.Nul -> "runtimeDirectory must not contain NUL bytes"
        "resourceRoot" to PathOverrideError.Empty -> "resourceRoot must not be empty"
        "resourceRoot" to PathOverrideError.Nul -> "resourceRoot must not contain NUL bytes"
        else -> when (error) {
          PathOverrideError.Empty -> "$name must not be empty"
          PathOverrideError.Nul -> "$name must not contain NUL bytes"
        }
      }

    private enum class StartupIdentityError {
      Empty,
      Nul,
    }

    private fun startupIdentityMessage(name: String, error: StartupIdentityError): String =
      when (name to error) {
        "username" to StartupIdentityError.Empty -> "username must not be empty"
        "username" to StartupIdentityError.Nul -> "username must not contain NUL bytes"
        "database" to StartupIdentityError.Empty -> "database must not be empty"
        "database" to StartupIdentityError.Nul -> "database must not contain NUL bytes"
        else -> when (error) {
          StartupIdentityError.Empty -> "$name must not be empty"
          StartupIdentityError.Nul -> "$name must not contain NUL bytes"
        }
      }

    private fun arrayOfStringsMessage(name: String): String =
      when (name) {
        "extensions" -> "extensions must be an array of strings"
        "startupGUCs" -> "startupGUCs must be an array of strings"
        else -> "$name must be an array of strings"
      }

    private fun environment(name: String): String? =
      System.getenv(name)?.takeIf(String::isNotEmpty)

    private fun reactNativeLibraryPath(configured: String?): String? =
      configured
        ?: environment("OLIPHAUNT_REACT_NATIVE_ANDROID_LIBRARY")
        ?: environment("OLIPHAUNT_KOTLIN_ANDROID_LIBRARY")
        ?: environment("LIBOLIPHAUNT_PATH")
        ?: environment("OLIPHAUNT_LIBRARY")

    private fun reactNativeRuntimeDirectory(configured: String?): String? =
      configured
        ?: environment("OLIPHAUNT_REACT_NATIVE_ANDROID_RUNTIME_DIR")
        ?: environment("OLIPHAUNT_KOTLIN_ANDROID_RUNTIME_DIR")
        ?: environment("OLIPHAUNT_INSTALL_DIR")
        ?: environment("OLIPHAUNT_RUNTIME_DIR")

    private fun parseEngineMode(engine: String): EngineMode = when (engine) {
      "nativeDirect" -> EngineMode.NativeDirect
      "nativeBroker" -> EngineMode.NativeBroker
      "nativeServer" -> EngineMode.NativeServer
      else -> throw IllegalArgumentException("unknown liboliphaunt engine '$engine'")
    }

    private fun parseDurability(durability: String): DurabilityProfile = when (durability) {
      "safe" -> DurabilityProfile.Safe
      "balanced" -> DurabilityProfile.Balanced
      "fastDev" -> DurabilityProfile.FastDev
      else -> throw IllegalArgumentException("unknown liboliphaunt durability profile '$durability'")
    }

    private fun parseRuntimeFootprint(profile: String): RuntimeFootprintProfile = when (profile) {
      "throughput" -> RuntimeFootprintProfile.Throughput
      "balancedMobile" -> RuntimeFootprintProfile.BalancedMobile
      "smallMobile" -> RuntimeFootprintProfile.SmallMobile
      else -> throw IllegalArgumentException("unknown liboliphaunt runtime footprint profile '$profile'")
    }

    private fun parseBackupFormat(format: String): BackupFormat = when (format) {
      "sql" -> BackupFormat.Sql
      "physicalArchive" -> BackupFormat.PhysicalArchive
      "oliphauntArchive" -> BackupFormat.OliphauntArchive
      else -> throw IllegalArgumentException("unknown liboliphaunt backup format '$format'")
    }

    private fun EngineMode.wireName(): String = when (this) {
      EngineMode.NativeDirect -> "nativeDirect"
      EngineMode.NativeBroker -> "nativeBroker"
      EngineMode.NativeServer -> "nativeServer"
    }

    private fun EngineCapabilities.toWritableMap(): WritableNativeMap =
      WritableNativeMap().apply {
        putString("engine", mode.wireName())
        putBoolean("processIsolated", processIsolated)
        putBoolean("multipleInstances", multipleInstances)
        putBoolean("sameInstanceLogicalReopen", sameInstanceLogicalReopen)
        putBoolean("instanceSwitchable", instanceSwitchable)
        putBoolean("crashRestartable", crashRestartable)
        putBoolean("independentSessions", independentSessions)
        putInt("maxClientSessions", maxClientSessions)
        putBoolean("protocolRaw", protocolRaw)
        putBoolean("protocolStream", protocolStream)
        putBoolean("queryCancel", queryCancel)
        putBoolean("backupRestore", backupRestore)
        putArray("backupFormats", backupFormats.toWritableArray())
        putArray("restoreFormats", restoreFormats.toWritableArray())
        putBoolean("simpleQuery", simpleQuery)
        putBoolean("extensions", extensions)
        if (connectionString != null) {
          putString("connectionString", connectionString)
        }
        putString("rawProtocolTransport", "jsi-array-buffer")
      }

    private fun EngineModeSupport.toWritableMap(): WritableNativeMap =
      WritableNativeMap().apply {
        putString("engine", mode.wireName())
        putBoolean("available", available)
        putMap("capabilities", capabilities.toWritableMap())
        if (unavailableReason != null) {
          putString("unavailableReason", unavailableReason)
        }
      }

    private fun OliphauntPackageSizeReport.toWritableMap(): WritableNativeMap =
      WritableNativeMap().apply {
        putDouble("packageBytes", packageBytes.toDouble())
        putDouble("runtimeBytes", runtimeBytes.toDouble())
        putDouble("templatePgdataBytes", templatePgdataBytes.toDouble())
        putDouble("staticRegistryBytes", staticRegistryBytes.toDouble())
        putDouble("selectedExtensionBytes", selectedExtensionBytes.toDouble())
        mobileStaticRegistryState?.let { putString("mobileStaticRegistryState", it) }
        putArray(
          "mobileStaticRegistryRegistered",
          WritableNativeArray().apply {
            mobileStaticRegistryRegistered.forEach(::pushString)
          },
        )
        putArray(
          "mobileStaticRegistryPending",
          WritableNativeArray().apply {
            mobileStaticRegistryPending.forEach(::pushString)
          },
        )
        putArray(
          "nativeModuleStems",
          WritableNativeArray().apply {
            nativeModuleStems.forEach(::pushString)
          },
        )
        putArray(
          "runtimeFeatures",
          WritableNativeArray().apply {
            runtimeFeatures.forEach(::pushString)
          },
        )
        putArray(
          "extensions",
          WritableNativeArray().apply {
            extensions.forEach { pushMap(it.toWritableMap()) }
          },
        )
      }

    private fun OliphauntExtensionSizeReport.toWritableMap(): WritableNativeMap =
      WritableNativeMap().apply {
        putString("name", name)
        putInt("fileCount", fileCount)
        putDouble("bytes", bytes.toDouble())
      }

    private fun processMemoryReport(): WritableNativeMap {
      val info = Debug.MemoryInfo()
      Debug.getMemoryInfo(info)
      val runtime = Runtime.getRuntime()
      return WritableNativeMap().apply {
        putString("source", "android-debug-memory-info")
        putDouble("totalPssKb", info.totalPss.toDouble())
        putDouble("totalPrivateDirtyKb", info.totalPrivateDirty.toDouble())
        putDouble("totalSharedDirtyKb", info.totalSharedDirty.toDouble())
        putDouble("nativeHeapAllocatedBytes", Debug.getNativeHeapAllocatedSize().toDouble())
        putDouble("nativeHeapSizeBytes", Debug.getNativeHeapSize().toDouble())
        putDouble("runtimeTotalBytes", runtime.totalMemory().toDouble())
        putDouble("runtimeFreeBytes", runtime.freeMemory().toDouble())
      }
    }

    private fun List<BackupFormat>.toWritableArray(): WritableNativeArray =
      WritableNativeArray().apply {
        forEach { pushString(it.wireName()) }
      }

    private fun BackupFormat.wireName(): String = when (this) {
      BackupFormat.Sql -> "sql"
      BackupFormat.PhysicalArchive -> "physicalArchive"
      BackupFormat.OliphauntArchive -> "oliphauntArchive"
    }

  }
}
