package dev.oliphaunt

import android.content.Context
import android.content.res.AssetManager
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.util.Properties
import java.util.UUID

internal data class OliphauntAndroidAssetPackage(
    val assetRoot: String,
    val cacheKey: String,
    val resourceRoot: File? = null,
    val selectedExtensions: Set<String> = emptySet(),
    val extensions: Set<String> = emptySet(),
    val runtimeFeatures: Set<String> = emptySet(),
    val sharedPreloadLibraries: Set<String> = emptySet(),
    val mobileStaticRegistryState: String? = null,
    val mobileStaticRegistryRegistered: Set<String> = emptySet(),
    val mobileStaticRegistryPending: Set<String> = emptySet(),
    val nativeModuleStems: Set<String> = emptySet(),
    val clusterSeedTarget: String = "",
    val target: String = "",
    val compatibilityKey: String = "",
    val icuDataTreeSha256: String = "",
)

internal data class OliphauntPackageSizeReport(
    val packageBytes: Long,
    val runtimeBytes: Long,
    val clusterSeedBytes: Long,
    val staticRegistryBytes: Long,
    val selectedExtensionBytes: Long,
    val extensions: List<OliphauntExtensionSizeReport>,
    val runtimeFeatures: List<String> = emptyList(),
    val mobileStaticRegistryState: String? = null,
    val mobileStaticRegistryRegistered: List<String> = emptyList(),
    val mobileStaticRegistryPending: List<String> = emptyList(),
    val nativeModuleStems: List<String> = emptyList(),
)

internal data class OliphauntExtensionSizeReport(
    val name: String,
    val fileCount: Int,
    val bytes: Long,
)

internal data class OliphauntAndroidResolvedRuntime(
    val runtimeDirectory: String,
    val clusterSeed: OliphauntAndroidAssetPackage?,
    val sharedPreloadLibraries: Set<String> = emptySet(),
)

internal enum class AndroidPgdataPublication {
    Published,
    Existing,
}

internal fun <T> finishAndroidStaging(
    result: Result<T>,
    operation: String,
    cleanup: () -> Unit,
): T {
    try {
        cleanup()
    } catch (cleanupError: Throwable) {
        val primaryError = result.exceptionOrNull()
        throw OliphauntException(
            if (primaryError == null) {
                "$operation staging cleanup failed (${cleanupError.message})"
            } else {
                "$operation failed (${primaryError.message}); " +
                    "staging cleanup failed (${cleanupError.message})"
            },
        ).apply {
            if (primaryError != null) {
                addSuppressed(primaryError)
            }
            addSuppressed(cleanupError)
        }
    }
    return result.getOrThrow()
}

internal fun removeAndroidStagingIfPresent(staging: File) {
    if (isAndroidPathDefinitelyAbsent(staging)) return
    if (!staging.deleteRecursively()) {
        throw OliphauntException("failed to remove staging path at ${staging.absolutePath}")
    }
    val parent =
        staging.parentFile
            ?: throw OliphauntException("staging path has no parent: ${staging.absolutePath}")
    OliphauntAndroidRuntimeAssets.syncAndroidDirectory(parent)
}

internal object OliphauntAndroidRuntimeAssets {
    private const val RUNTIME_ASSET_ROOT = "oliphaunt/runtime"
    private const val CARRIER_MANIFEST_ASSET = "oliphaunt/manifest.properties"
    private const val CARRIER_SCHEMA = "oliphaunt-native-runtime-carrier-v1"
    private const val CLUSTER_SEED_TARGET = "android-datum64"
    private const val CLUSTER_SEED_COMPATIBILITY_KEY = "native-pg18-android-datum64-v1"
    private const val STANDARD_CLUSTER_SEED_ASSET_ROOT = "oliphaunt/cluster-seed"
    private const val ICU_CLUSTER_SEED_ASSET_ROOT = "oliphaunt/cluster-seed-icu"
    private const val PACKAGE_SIZE_REPORT_ASSET = "oliphaunt/package-size.tsv"
    private const val RUNTIME_RESOURCES_SCHEMA = "oliphaunt-runtime-resources-v1"
    private const val RUNTIME_PACKAGE_LAYOUT = "postgres-runtime-files-v1"
    private const val CLUSTER_SEED_PACKAGE_LAYOUT = "oliphaunt-cluster-seed-v1"
    private const val MANIFEST_NAME = "manifest.properties"
    private const val FILES_DIR_NAME = "files"
    private const val STAMP_NAME = ".liboliphaunt-asset-cache-key"
    private val requiredClusterSeedDirectories =
        listOf(
            "pg_commit_ts",
            "pg_dynshmem",
            "pg_logical/mappings",
            "pg_logical/snapshots",
            "pg_notify",
            "pg_replslot",
            "pg_serial",
            "pg_snapshots",
            "pg_stat_tmp",
            "pg_tblspc",
            "pg_twophase",
            "pg_wal/archive_status",
            "pg_wal/summaries",
        )
    private val portableId = Regex("[A-Za-z0-9._-]{1,128}")
    private val runtimeManifestKeys =
        setOf(
            "schema",
            "layout",
            "artifactRole",
            "catalogProfile",
            "clusterSeedTarget",
            "icuDataTreeSha256",
            "mode",
            "cacheKey",
            "selectedExtensions",
            "extensions",
            "runtimeFeatures",
            "sharedPreloadLibraries",
            "mobileStaticRegistryState",
            "mobileStaticRegistryRegistered",
            "mobileStaticRegistryPending",
            "nativeModuleStems",
            "mobileStaticRegistrySource",
        )
    private val clusterSeedManifestKeys =
        setOf(
            "schema",
            "layout",
            "artifactRole",
            "catalogProfile",
            "postgresMajor",
            "physicalFormat",
            "target",
            "compatibilityKey",
            "initialSuperuser",
            "runtimeFeatures",
            "icuDataVersion",
            "icuDataForm",
            "icuDataTreeSha256",
            "cacheKey",
        )

    fun resolve(
        context: Context,
        explicitRuntimeDirectory: String?,
        requestedExtensions: Collection<String> = emptyList(),
        resourceRoot: File? = null,
    ): OliphauntAndroidResolvedRuntime {
        val requestedExtensionSet = validateExtensionIds(requestedExtensions)
        val explicitRuntime = explicitRuntimeDirectory?.takeIf(String::isNotEmpty)
        if (explicitRuntime != null) {
            val sharedPreloadLibraries =
                validateExplicitRuntimeDirectory(
                    explicitRuntime,
                    requestedExtensionSet,
                )
            val runtimePackage = releaseShapedRuntimePackageForDirectory(explicitRuntime)
            val clusterSeed = runtimePackage?.let(::matchingReleaseShapedClusterSeed)
            return OliphauntAndroidResolvedRuntime(
                runtimeDirectory = explicitRuntime,
                clusterSeed = clusterSeed,
                sharedPreloadLibraries = sharedPreloadLibraries,
            )
        }

        if (resourceRoot == null) {
            validateCarrierReceipt(
                context.assets
                    .open(CARRIER_MANIFEST_ASSET)
                    .bufferedReader()
                    .use { it.readText() },
                CARRIER_MANIFEST_ASSET,
            )
        } else {
            val receipt = File(resourceRoot, CARRIER_MANIFEST_ASSET)
            validateCarrierReceipt(receipt.readText(), receipt.absolutePath)
        }
        val standardClusterSeed =
            if (resourceRoot == null) {
                packageManifestOrNull(context.assets, STANDARD_CLUSTER_SEED_ASSET_ROOT)
            } else {
                filePackageManifestOrNull(resourceRoot, STANDARD_CLUSTER_SEED_ASSET_ROOT)
            }
        val icuClusterSeed =
            if (resourceRoot == null) {
                packageManifestOrNull(context.assets, ICU_CLUSTER_SEED_ASSET_ROOT)
            } else {
                filePackageManifestOrNull(resourceRoot, ICU_CLUSTER_SEED_ASSET_ROOT)
            }
        val packagedRuntime =
            if (resourceRoot == null) {
                packageManifestOrNull(context.assets, RUNTIME_ASSET_ROOT)
            } else {
                filePackageManifestOrNull(resourceRoot, RUNTIME_ASSET_ROOT)
            }
        val clusterSeed = matchingClusterSeed(packagedRuntime, standardClusterSeed, icuClusterSeed)
        val runtimeDirectory = materializePackagedRuntime(context, requestedExtensionSet, packagedRuntime)
        return OliphauntAndroidResolvedRuntime(
            runtimeDirectory = runtimeDirectory,
            clusterSeed = clusterSeed,
            sharedPreloadLibraries = packagedRuntime?.sharedPreloadLibraries.orEmpty(),
        )
    }

    internal fun validateExplicitRuntimeDirectory(
        runtimeDirectory: String,
        requestedExtensions: Collection<String>,
    ): Set<String> {
        val requestedExtensionSet = validateExtensionIds(requestedExtensions)
        val runtimePackage = releaseShapedRuntimePackageForDirectory(runtimeDirectory)
        if (runtimePackage == null) {
            if (requestedExtensionSet.isEmpty()) {
                return emptySet()
            }
            throw OliphauntException(
                "Kotlin Android Oliphaunt extensions with explicit runtimeDirectory require " +
                    "release-shaped runtime resources at oliphaunt/runtime/files so selected extension " +
                    "files, mobile static registry metadata, and shared preload libraries can be validated.",
            )
        }
        requirePackagedExtensions(
            runtimePackage = runtimePackage,
            requestedExtensions = requestedExtensionSet,
            runtimeFiles = File(runtimeDirectory),
        )
        return runtimePackage.sharedPreloadLibraries
    }

    fun packageSizeReport(assetManager: AssetManager): OliphauntPackageSizeReport? = try {
        assetManager.open(PACKAGE_SIZE_REPORT_ASSET).bufferedReader().use { reader ->
            parsePackageSizeReport(reader.readText(), PACKAGE_SIZE_REPORT_ASSET)
                .withRuntimeManifest(packageManifestOrNull(assetManager, RUNTIME_ASSET_ROOT))
        }
    } catch (_: FileNotFoundException) {
        null
    } catch (error: IOException) {
        throw OliphauntException("failed to read Oliphaunt package size report: ${error.message}")
    }

    private fun matchingClusterSeed(
        runtime: OliphauntAndroidAssetPackage?,
        standard: OliphauntAndroidAssetPackage?,
        icu: OliphauntAndroidAssetPackage?,
    ): OliphauntAndroidAssetPackage {
        val resolvedRuntime =
            runtime
                ?: throw OliphauntException("Kotlin Android Oliphaunt runtime resources are not present")
        if (resolvedRuntime.clusterSeedTarget != CLUSTER_SEED_TARGET) {
            throw OliphauntException(
                "Kotlin Android Oliphaunt runtime resources do not carry cluster seeds for $CLUSTER_SEED_TARGET",
            )
        }
        val profile = if ("icu" in resolvedRuntime.runtimeFeatures) "icu" else "standard"
        val selected =
            (if (profile == "icu") icu else standard)
                ?: throw OliphauntException(
                    "Kotlin Android Oliphaunt runtime resources are missing the $profile cluster seed for $CLUSTER_SEED_TARGET",
                )
        if (profile == "icu" && resolvedRuntime.icuDataTreeSha256 != selected.icuDataTreeSha256) {
            throw OliphauntException(
                "Kotlin Android Oliphaunt ICU data does not match the $CLUSTER_SEED_TARGET ICU cluster seed",
            )
        }
        return selected
    }

    private fun matchingReleaseShapedClusterSeed(runtime: OliphauntAndroidAssetPackage): OliphauntAndroidAssetPackage {
        val resourceRoot =
            runtime.resourceRoot
                ?: throw OliphauntException("release-shaped Android runtime resources have no resource root")
        return matchingClusterSeed(
            runtime,
            filePackageManifestOrNull(resourceRoot, STANDARD_CLUSTER_SEED_ASSET_ROOT),
            filePackageManifestOrNull(resourceRoot, ICU_CLUSTER_SEED_ASSET_ROOT),
        )
    }

    fun packageSizeReport(resourceRoot: File): OliphauntPackageSizeReport? {
        val report = File(resourceRoot, "package-size.tsv")
        if (!report.isFile) {
            return null
        }
        return try {
            parsePackageSizeReport(report.readText(), report.absolutePath)
                .withRuntimeManifest(filePackageManifestOrNull(resourceRoot, RUNTIME_ASSET_ROOT))
        } catch (error: IOException) {
            throw OliphauntException(
                "failed to read Oliphaunt package size report ${report.absolutePath}: ${error.message}",
            )
        }
    }

    fun preparePgdata(
        assetManager: AssetManager,
        pgdata: File,
        clusterSeed: OliphauntAndroidAssetPackage?,
        didPublishDestination: () -> Unit,
    ): AndroidPgdataPublication {
        if (File(pgdata, "PG_VERSION").isFile) {
            validateCompleteAndroidPgdata(pgdata)
            return AndroidPgdataPublication.Existing
        }
        if (clusterSeed == null) {
            throw OliphauntException(
                "Kotlin Android Oliphaunt requires a packaged cluster seed for new storage. " +
                    "Package the target runtime resources or open storage whose pgdata directory already contains PG_VERSION.",
            )
        }
        if (pgdata.exists()) {
            if (!pgdata.isDirectory) {
                throw OliphauntException("PGDATA path exists but is not a directory: ${pgdata.absolutePath}")
            }
            val existing = pgdata.list()
            if (existing != null && existing.isNotEmpty()) {
                throw OliphauntException("PGDATA exists without PG_VERSION and is not empty: ${pgdata.absolutePath}")
            }
        }

        val parent =
            pgdata.parentFile
                ?: throw OliphauntException("PGDATA has no parent directory: ${pgdata.absolutePath}")
        if (!parent.mkdirs() && !parent.isDirectory) {
            throw OliphauntException("failed to create PGDATA parent at ${parent.absolutePath}")
        }

        val temp = File(parent, ".cluster-seed-${clusterSeed.cacheKey}-${UUID.randomUUID()}")
        temp.deleteRecursively()
        val result =
            runCatching {
                copyPackageTree(assetManager, clusterSeed, temp)
                ensureClusterSeedDirectoriesForAndroid(temp)
                normalizeClusterSeedForAndroid(temp)
                publishPreparedAndroidPgdata(temp, pgdata, didPublishDestination)
            }
        return finishAndroidStaging(result, operation = "PGDATA preparation") {
            removeAndroidStagingIfPresent(temp)
        }
    }

    internal fun publishPreparedAndroidPgdata(
        staging: File,
        destination: File,
        didPublishDestination: () -> Unit = {},
        syncPublicationTree: (File) -> Unit = ::syncAndroidPublicationTree,
        syncParentDirectory: (File) -> Unit = ::syncAndroidDirectory,
    ): AndroidPgdataPublication {
        validateCompleteAndroidPgdata(staging)
        if (isCompleteAndroidPgdata(destination)) return AndroidPgdataPublication.Existing
        syncPublicationTree(staging)

        if (destination.exists()) {
            val entries = destination.list()
            if (!destination.isDirectory || entries == null || entries.isNotEmpty()) {
                if (isCompleteAndroidPgdata(destination)) return AndroidPgdataPublication.Existing
                throw OliphauntException(
                    "PGDATA destination changed before publication: ${destination.absolutePath}",
                )
            }
            if (!destination.delete()) {
                if (isCompleteAndroidPgdata(destination)) return AndroidPgdataPublication.Existing
                throw OliphauntException(
                    "failed to remove empty PGDATA destination at ${destination.absolutePath}",
                )
            }
        }

        if (staging.renameTo(destination)) {
            didPublishDestination()
            syncParentDirectory(
                destination.parentFile
                    ?: throw OliphauntException("PGDATA has no parent directory: ${destination.absolutePath}"),
            )
            validateCompleteAndroidPgdata(destination)
            return AndroidPgdataPublication.Published
        }
        if (isCompleteAndroidPgdata(destination)) return AndroidPgdataPublication.Existing
        throw OliphauntException("failed to publish cluster seed at ${destination.absolutePath}")
    }

    private fun isCompleteAndroidPgdata(pgdata: File): Boolean = try {
        validateCompleteAndroidPgdata(pgdata)
        true
    } catch (_: Throwable) {
        false
    }

    internal fun syncAndroidPublicationTree(root: File) {
        syncAndroidPublicationEntry(root)
    }

    private fun syncAndroidPublicationEntry(entry: File) {
        if (isAndroidSymbolicLink(entry)) {
            throw OliphauntException("publication tree contains a symbolic link: ${entry.absolutePath}")
        }
        when {
            entry.isFile -> {
                FileInputStream(entry).use { input -> input.fd.sync() }
            }

            entry.isDirectory -> {
                val children =
                    entry.listFiles()
                        ?: throw OliphauntException("failed to inspect publication directory: ${entry.absolutePath}")
                children.sortedBy(File::getName).forEach(::syncAndroidPublicationEntry)
                syncAndroidDirectory(entry)
            }

            else -> {
                throw OliphauntException("publication tree contains a special entry: ${entry.absolutePath}")
            }
        }
    }

    internal fun syncAndroidDirectory(directory: File) {
        val descriptor =
            Os.open(
                directory.absolutePath,
                OsConstants.O_RDONLY,
                0,
            )
        try {
            Os.fsync(descriptor)
        } finally {
            Os.close(descriptor)
        }
    }

    private fun materializePackagedRuntime(
        context: Context,
        requestedExtensions: Set<String>,
        runtimePackage: OliphauntAndroidAssetPackage? = packageManifestOrNull(context.assets, RUNTIME_ASSET_ROOT),
    ): String {
        val runtimePackage =
            runtimePackage
                ?: throw OliphauntException(
                    "Kotlin Android Oliphaunt runtime resources are not present. " +
                        "Pass runtimeDirectory for local development or configure Gradle with " +
                        "-PoliphauntRuntimeResourcesDir=<runtime-resource output>.",
                )
        requirePackagedExtensions(runtimePackage, requestedExtensions)
        val runtimeRoot =
            File(
                context.noBackupFilesDir,
                "oliphaunt/runtime/${runtimePackage.cacheKey}",
            )
        materializeAssetPackage(context.assets, runtimePackage, runtimeRoot)
        requireExtensionInstallFiles(runtimePackage, requestedExtensions, runtimeRoot)
        return runtimeRoot.absolutePath
    }

    private fun packageManifestOrNull(
        assetManager: AssetManager,
        assetRoot: String,
    ): OliphauntAndroidAssetPackage? {
        try {
            val text = assetManager.open("$assetRoot/$MANIFEST_NAME").bufferedReader().use { it.readText() }
            return parseManifestProperties(assetRoot, parseManifestText(text, assetRoot))
        } catch (_: FileNotFoundException) {
            return null
        } catch (error: IOException) {
            throw OliphauntException("failed to read Oliphaunt asset manifest $assetRoot: ${error.message}")
        }
    }

    internal fun parseManifestText(
        text: String,
        source: String,
    ): Properties {
        val properties = Properties()
        text.lineSequence().forEachIndexed { index, raw ->
            if (raw.isEmpty()) return@forEachIndexed
            val separator = raw.indexOf('=')
            if (separator < 1) {
                throw OliphauntException("Oliphaunt asset manifest $source:${index + 1} is not key=value")
            }
            val key = raw.substring(0, separator)
            val value = raw.substring(separator + 1)
            if (key.isEmpty() || properties.containsKey(key)) {
                throw OliphauntException(
                    "Oliphaunt asset manifest $source:${index + 1} contains an invalid or duplicate property",
                )
            }
            properties.setProperty(key, value)
        }
        if (properties.isEmpty) {
            throw OliphauntException("Oliphaunt asset manifest $source is empty")
        }
        return properties
    }

    private fun validateCarrierReceipt(
        text: String,
        source: String,
    ) {
        val properties = parseManifestText(text, source)
        val expected =
            setOf(
                "schema",
                "clusterSeedTarget",
                "clusterSeedRelativePath",
                "icuClusterSeedRelativePath",
            )
        if (properties.stringPropertyNames() != expected ||
            properties.getProperty("schema") != CARRIER_SCHEMA ||
            properties.getProperty("clusterSeedTarget") != CLUSTER_SEED_TARGET ||
            properties.getProperty("clusterSeedRelativePath") != "cluster-seed" ||
            properties.getProperty("icuClusterSeedRelativePath") != "cluster-seed-icu"
        ) {
            throw OliphauntException(
                "Oliphaunt runtime carrier $source does not contain the exact $CLUSTER_SEED_TARGET seed receipt",
            )
        }
    }

    internal fun parseManifestProperties(
        assetRoot: String,
        properties: Properties,
        resourceRoot: File? = null,
    ): OliphauntAndroidAssetPackage {
        val expectedLayout = expectedLayout(assetRoot)
        val isRuntime = assetRoot == RUNTIME_ASSET_ROOT
        val allowedKeys = if (isRuntime) runtimeManifestKeys else clusterSeedManifestKeys
        val actualKeys = properties.stringPropertyNames()
        val unsupported = actualKeys.filterNot(allowedKeys::contains).sorted()
        val missing = allowedKeys.filterNot(actualKeys::contains).sorted()
        if (actualKeys != allowedKeys) {
            throw OliphauntException(
                "Oliphaunt asset manifest $assetRoot does not contain its exact canonical field set; " +
                    "missing=${missing.joinToString(",")}; unsupported=${unsupported.joinToString(",")}",
            )
        }
        val schema = properties.getProperty("schema").orEmpty()
        if (schema != RUNTIME_RESOURCES_SCHEMA) {
            throw OliphauntException(
                "Oliphaunt asset manifest $assetRoot has unsupported runtime resource schema " +
                    "'${schema.ifEmpty { "<missing>" }}'; expected $RUNTIME_RESOURCES_SCHEMA",
            )
        }
        val layout = properties.getProperty("layout").orEmpty()
        if (layout != expectedLayout) {
            throw OliphauntException(
                "Oliphaunt asset manifest $assetRoot has unsupported layout " +
                    "'${layout.ifEmpty { "<missing>" }}'; expected $expectedLayout",
            )
        }
        val cacheKey = properties.getProperty("cacheKey").orEmpty()
        if (!portableId.matches(cacheKey) || cacheKey == "." || cacheKey == "..") {
            throw OliphauntException("Oliphaunt asset manifest $assetRoot has invalid cacheKey '$cacheKey'")
        }
        if (isRuntime && properties.getProperty("mode") != "native-direct") {
            throw OliphauntException("Oliphaunt runtime manifest must declare mode=native-direct")
        }
        val extensions =
            if (isRuntime) {
                validateExtensionIds(properties.getProperty("extensions").orEmpty().split(','))
            } else {
                emptySet()
            }
        val selectedExtensions =
            if (isRuntime) {
                val value =
                    properties.getProperty("selectedExtensions")
                        ?: throw OliphauntException("Oliphaunt runtime manifest is missing selectedExtensions")
                validateExtensionIds(value.split(','))
            } else {
                emptySet()
            }
        if (!selectedExtensions.containsAll(extensions)) {
            throw OliphauntException(
                "Oliphaunt asset manifest $assetRoot extensions must be a subset of selectedExtensions",
            )
        }
        val runtimeFeatures =
            validateRuntimeFeatures(
                properties.getProperty("runtimeFeatures").orEmpty().split(','),
            )
        val clusterSeedTarget = properties.getProperty("clusterSeedTarget").orEmpty()
        val icuDataTreeSha256 = properties.getProperty("icuDataTreeSha256").orEmpty()
        val artifactRole = properties.getProperty("artifactRole").orEmpty()
        val catalogProfile = properties.getProperty("catalogProfile").orEmpty()
        if (isRuntime) {
            if (
                artifactRole != "runtime" ||
                catalogProfile.isNotEmpty() ||
                clusterSeedTarget != CLUSTER_SEED_TARGET
            ) {
                throw OliphauntException(
                    "Oliphaunt runtime manifest must declare artifactRole=runtime, an empty catalogProfile, " +
                        "and cluster seeds for $CLUSTER_SEED_TARGET",
                )
            }
            if ("icu" in runtimeFeatures) {
                if (!Regex("[0-9a-f]{64}").matches(icuDataTreeSha256)) {
                    throw OliphauntException(
                        "Oliphaunt ICU runtime manifest does not bind the canonical ICU data tree",
                    )
                }
            } else if (icuDataTreeSha256.isNotEmpty()) {
                throw OliphauntException(
                    "Oliphaunt standard runtime manifest must not select ICU data",
                )
            }
        } else {
            val expectedProfile = profileForClusterSeedAssetRoot(assetRoot)
            val expectedRuntimeFeatures = if (expectedProfile == "icu") setOf("icu") else emptySet()
            if (
                runtimeFeatures != expectedRuntimeFeatures ||
                artifactRole != "cluster-seed-$expectedProfile" ||
                catalogProfile != expectedProfile ||
                properties.getProperty("target") != CLUSTER_SEED_TARGET ||
                properties.getProperty("postgresMajor") != "18" ||
                properties.getProperty("physicalFormat") != "native-pg18-v1" ||
                properties.getProperty("compatibilityKey") != CLUSTER_SEED_COMPATIBILITY_KEY ||
                properties.getProperty("initialSuperuser") != "postgres"
            ) {
                throw OliphauntException(
                    "Oliphaunt cluster-seed manifest has an incompatible native catalog contract",
                )
            }
            val icuDataVersion = properties.getProperty("icuDataVersion").orEmpty()
            val icuDataForm = properties.getProperty("icuDataForm").orEmpty()
            if (expectedProfile == "icu") {
                if (
                    icuDataVersion != "76.1" ||
                    icuDataForm != "files-le" ||
                    !Regex("[0-9a-f]{64}").matches(icuDataTreeSha256)
                ) {
                    throw OliphauntException(
                        "Oliphaunt ICU cluster-seed manifest does not bind the canonical ICU data tree",
                    )
                }
            } else if (
                icuDataVersion.isNotEmpty() ||
                icuDataForm.isNotEmpty() ||
                icuDataTreeSha256.isNotEmpty()
            ) {
                throw OliphauntException(
                    "Oliphaunt standard cluster-seed manifest must not select ICU data",
                )
            }
        }
        val mobileStaticRegistryState: String?
        val mobileStaticRegistryPending: Set<String>
        val mobileStaticRegistryRegistered: Set<String>
        val nativeModuleStems: Set<String>
        if (isRuntime) {
            mobileStaticRegistryState =
                validateMobileStaticRegistryState(
                    properties.getProperty("mobileStaticRegistryState"),
                )
            val expectedRegistrySource =
                if (mobileStaticRegistryState == "complete") {
                    "static-registry/oliphaunt_static_registry.c"
                } else {
                    ""
                }
            if (properties.getProperty("mobileStaticRegistrySource") != expectedRegistrySource) {
                throw OliphauntException(
                    "Oliphaunt runtime manifest has mobileStaticRegistrySource inconsistent with " +
                        "mobileStaticRegistryState",
                )
            }
            mobileStaticRegistryPending =
                validatePortableIds(
                    properties.getProperty("mobileStaticRegistryPending").orEmpty().split(','),
                    label = "mobile static registry extension",
                )
            mobileStaticRegistryRegistered =
                validatePortableIds(
                    properties.getProperty("mobileStaticRegistryRegistered").orEmpty().split(','),
                    label = "mobile static registry extension",
                )
            nativeModuleStems =
                validatePortableIds(
                    properties.getProperty("nativeModuleStems").orEmpty().split(','),
                    label = "native module stem",
                )
            validateMobileStaticRegistryManifest(
                state = mobileStaticRegistryState,
                registered = mobileStaticRegistryRegistered,
                pending = mobileStaticRegistryPending,
                nativeModuleStems = nativeModuleStems,
                selectedExtensions = selectedExtensions,
            )
        } else {
            mobileStaticRegistryState = null
            mobileStaticRegistryPending = emptySet()
            mobileStaticRegistryRegistered = emptySet()
            nativeModuleStems = emptySet()
        }
        val sharedPreloadLibraries =
            validatePortableIds(
                properties.getProperty("sharedPreloadLibraries").orEmpty().split(','),
                label = "shared preload library",
            )
        return OliphauntAndroidAssetPackage(
            assetRoot = assetRoot,
            cacheKey = cacheKey,
            resourceRoot = resourceRoot,
            selectedExtensions = selectedExtensions,
            extensions = extensions,
            runtimeFeatures = runtimeFeatures,
            sharedPreloadLibraries = sharedPreloadLibraries,
            mobileStaticRegistryState = mobileStaticRegistryState,
            mobileStaticRegistryRegistered = mobileStaticRegistryRegistered,
            mobileStaticRegistryPending = mobileStaticRegistryPending,
            nativeModuleStems = nativeModuleStems,
            clusterSeedTarget = clusterSeedTarget,
            target = properties.getProperty("target").orEmpty(),
            compatibilityKey = properties.getProperty("compatibilityKey").orEmpty(),
            icuDataTreeSha256 = icuDataTreeSha256,
        )
    }

    private fun filePackageManifestOrNull(
        resourceRoot: File,
        assetRoot: String,
    ): OliphauntAndroidAssetPackage? {
        val manifest = File(resourceRoot, "$assetRoot/$MANIFEST_NAME")
        if (!manifest.isFile) {
            return null
        }
        val properties = parseManifestText(manifest.readText(), manifest.absolutePath)
        return parseManifestProperties(assetRoot, properties, resourceRoot = resourceRoot)
    }

    private fun OliphauntPackageSizeReport.withRuntimeManifest(runtime: OliphauntAndroidAssetPackage?): OliphauntPackageSizeReport = if (runtime ==
        null
    ) {
        this
    } else {
        copy(
            mobileStaticRegistryState = runtime.mobileStaticRegistryState,
            mobileStaticRegistryRegistered = runtime.mobileStaticRegistryRegistered.sorted(),
            mobileStaticRegistryPending = runtime.mobileStaticRegistryPending.sorted(),
            nativeModuleStems = runtime.nativeModuleStems.sorted(),
            runtimeFeatures = runtime.runtimeFeatures.sorted(),
        )
    }

    internal fun parsePackageSizeReport(
        text: String,
        source: String = PACKAGE_SIZE_REPORT_ASSET,
    ): OliphauntPackageSizeReport {
        val lines =
            text
                .lineSequence()
                .filter(String::isNotEmpty)
                .toList()
        if (lines.firstOrNull() != "kind\tid\textensions\tfiles\tbytes") {
            throw OliphauntException("Oliphaunt package size report $source has unsupported header")
        }

        var packageBytes: Long? = null
        var runtimeBytes: Long? = null
        var clusterSeedBytes: Long? = null
        var icuClusterSeedBytes: Long? = null
        var staticRegistryBytes: Long? = null
        var selectedExtensionBytes: Long? = null
        val extensionReports = mutableListOf<OliphauntExtensionSizeReport>()
        val seenExtensionIds = mutableSetOf<String>()

        lines.drop(1).forEachIndexed { index, line ->
            val lineNumber = index + 2
            val columns = line.split('\t')
            if (columns.size != 5) {
                throw OliphauntException(
                    "Oliphaunt package size report $source line $lineNumber must have 5 tab-separated columns",
                )
            }
            val bytes = parseSizeReportLong(columns[4], source, lineNumber, "bytes")
            when (columns[0] to columns[1]) {
                "package" to "total" -> {
                    packageBytes =
                        setSizeReportValue(
                            current = packageBytes,
                            value = bytes,
                            row = "package/total",
                            source = source,
                            line = lineNumber,
                        )
                }

                "package" to "runtime" -> {
                    runtimeBytes =
                        setSizeReportValue(
                            current = runtimeBytes,
                            value = bytes,
                            row = "package/runtime",
                            source = source,
                            line = lineNumber,
                        )
                }

                "package" to "cluster-seed" -> {
                    clusterSeedBytes =
                        setSizeReportValue(
                            current = clusterSeedBytes,
                            value = bytes,
                            row = "package/cluster-seed",
                            source = source,
                            line = lineNumber,
                        )
                }

                "package" to "cluster-seed-icu" -> {
                    icuClusterSeedBytes =
                        setSizeReportValue(
                            current = icuClusterSeedBytes,
                            value = bytes,
                            row = "package/cluster-seed-icu",
                            source = source,
                            line = lineNumber,
                        )
                }

                "package" to "static-registry" -> {
                    staticRegistryBytes =
                        setSizeReportValue(
                            current = staticRegistryBytes,
                            value = bytes,
                            row = "package/static-registry",
                            source = source,
                            line = lineNumber,
                        )
                }

                "extensions" to "selected" -> {
                    selectedExtensionBytes =
                        setSizeReportValue(
                            current = selectedExtensionBytes,
                            value = bytes,
                            row = "extensions/selected",
                            source = source,
                            line = lineNumber,
                        )
                }

                else -> {
                    if (columns[0] != "extension") {
                        throw OliphauntException(
                            "Oliphaunt package size report $source line $lineNumber has unknown row ${columns[0]}/${columns[1]}",
                        )
                    }
                    val name = columns[1]
                    if (!portableId.matches(name)) {
                        throw OliphauntException(
                            "Oliphaunt package size report $source line $lineNumber has invalid extension id '$name'",
                        )
                    }
                    if (!seenExtensionIds.add(name)) {
                        throw OliphauntException(
                            "Oliphaunt package size report $source line $lineNumber repeats extension row '$name'",
                        )
                    }
                    if (columns[2] != "-") {
                        throw OliphauntException(
                            "Oliphaunt package size report $source line $lineNumber extension rows must use '-' in the extensions column",
                        )
                    }
                    val fileCount = parseSizeReportInt(columns[3], source, lineNumber, "files")
                    extensionReports +=
                        OliphauntExtensionSizeReport(
                            name = name,
                            fileCount = fileCount,
                            bytes = bytes,
                        )
                }
            }
        }

        return OliphauntPackageSizeReport(
            packageBytes = requireSizeReportValue(packageBytes, "package/total", source),
            runtimeBytes = requireSizeReportValue(runtimeBytes, "package/runtime", source),
            clusterSeedBytes =
            Math.addExact(
                requireSizeReportValue(clusterSeedBytes, "package/cluster-seed", source),
                requireSizeReportValue(icuClusterSeedBytes, "package/cluster-seed-icu", source),
            ),
            staticRegistryBytes =
            requireSizeReportValue(
                staticRegistryBytes,
                "package/static-registry",
                source,
            ),
            selectedExtensionBytes =
            requireSizeReportValue(
                selectedExtensionBytes,
                "extensions/selected",
                source,
            ),
            extensions = extensionReports.sortedBy(OliphauntExtensionSizeReport::name),
        )
    }

    internal fun normalizePostgresqlConfigForAndroid(text: String): String {
        var normalized = setPostgresqlConfig(text, "shared_memory_type", "mmap")
        normalized = setPostgresqlConfig(normalized, "dynamic_shared_memory_type", "mmap")
        return normalized
    }

    internal fun ensureClusterSeedDirectoriesForAndroid(pgdata: File) {
        requiredClusterSeedDirectories.forEach { relative ->
            val directory = File(pgdata, relative)
            if (!directory.mkdirs() && !directory.isDirectory) {
                throw OliphauntException(
                    "failed to create Android cluster-seed directory ${directory.absolutePath}",
                )
            }
        }
    }

    private fun normalizeClusterSeedForAndroid(pgdata: File) {
        val config = File(pgdata, "postgresql.conf")
        if (!config.isFile) {
            return
        }
        val current = config.readText()
        val normalized = normalizePostgresqlConfigForAndroid(current)
        if (normalized != current) {
            config.writeText(normalized)
        }
    }

    private fun setPostgresqlConfig(
        text: String,
        key: String,
        value: String,
    ): String {
        val line = "$key = $value"
        val pattern = Regex("(?m)^\\s*$key\\s*=.*$")
        if (pattern.containsMatchIn(text)) {
            return pattern.replace(text, line)
        }
        val separator = if (text.endsWith('\n')) "" else "\n"
        return "$text$separator$line\n"
    }

    private fun setSizeReportValue(
        current: Long?,
        value: Long,
        row: String,
        source: String,
        line: Int,
    ): Long {
        if (current != null) {
            throw OliphauntException("Oliphaunt package size report $source line $line repeats required row $row")
        }
        return value
    }

    private fun requireSizeReportValue(
        value: Long?,
        row: String,
        source: String,
    ): Long = value ?: throw OliphauntException("Oliphaunt package size report $source is missing required row $row")

    private fun parseSizeReportLong(
        value: String,
        source: String,
        line: Int,
        field: String,
    ): Long = value.toLongOrNull()?.takeIf { it >= 0 }
        ?: throw OliphauntException(
            "Oliphaunt package size report $source line $line has invalid $field value '$value'",
        )

    private fun parseSizeReportInt(
        value: String,
        source: String,
        line: Int,
        field: String,
    ): Int = value.toIntOrNull()?.takeIf { it >= 0 }
        ?: throw OliphauntException(
            "Oliphaunt package size report $source line $line has invalid $field value '$value'",
        )

    private fun expectedLayout(assetRoot: String): String = when (assetRoot) {
        RUNTIME_ASSET_ROOT -> RUNTIME_PACKAGE_LAYOUT
        STANDARD_CLUSTER_SEED_ASSET_ROOT, ICU_CLUSTER_SEED_ASSET_ROOT -> CLUSTER_SEED_PACKAGE_LAYOUT
        else -> throw OliphauntException("unsupported Oliphaunt asset root '$assetRoot'")
    }

    private fun profileForClusterSeedAssetRoot(assetRoot: String): String = when (assetRoot) {
        STANDARD_CLUSTER_SEED_ASSET_ROOT -> "standard"
        ICU_CLUSTER_SEED_ASSET_ROOT -> "icu"
        else -> throw OliphauntException("unsupported Oliphaunt cluster-seed root '$assetRoot'")
    }

    private fun requirePackagedExtensions(
        runtimePackage: OliphauntAndroidAssetPackage,
        requestedExtensions: Set<String>,
        runtimeFiles: File? = null,
    ) {
        val missing =
            requestedExtensions
                .filterNot(runtimePackage.selectedExtensions::contains)
                .sorted()
        if (missing.isNotEmpty()) {
            val available = runtimePackage.selectedExtensions.sorted().joinToString(",")
            throw OliphauntException(
                "Kotlin Android Oliphaunt runtime resources ${runtimePackage.assetRoot} " +
                    "does not contain requested extension(s) ${missing.joinToString(",")}. " +
                    "Available extensions: ${available.ifEmpty { "<none>" }}.",
            )
        }
        if (requestedExtensions.isNotEmpty()) {
            val state =
                runtimePackage.mobileStaticRegistryState
                    ?: throw OliphauntException(
                        "Kotlin Android Oliphaunt runtime resources ${runtimePackage.assetRoot} " +
                            "does not declare mobileStaticRegistryState; rebuild it with the current oliphaunt runtime-resource generator.",
                    )
            if (state == "pending" || runtimePackage.mobileStaticRegistryPending.isNotEmpty()) {
                val pending = runtimePackage.mobileStaticRegistryPending.sorted().joinToString(",")
                throw OliphauntException(
                    "Kotlin Android Oliphaunt runtime resources ${runtimePackage.assetRoot} " +
                        "is not mobile static-registry ready for selected extension(s). " +
                        "Pending extension(s): ${pending.ifEmpty { "<unknown>" }}.",
                )
            }
        }
        requireExtensionInstallFiles(runtimePackage, requestedExtensions, runtimeFiles)
    }

    private fun requireExtensionInstallFiles(
        runtimePackage: OliphauntAndroidAssetPackage,
        requestedExtensions: Set<String>,
        runtimeFiles: File?,
    ) {
        if (requestedExtensions.isEmpty() || runtimeFiles == null) {
            return
        }
        val extensionDirectory = File(runtimeFiles, "share/postgresql/extension")
        requestedExtensions.sorted().forEach { extension ->
            val contract =
                generatedExtensionRuntimeContract(extension)
                    ?: throw OliphauntException(
                        "Kotlin Android Oliphaunt runtime resources cannot validate unknown extension $extension",
                    )
            if (!contract.createsExtension) {
                val moduleStem =
                    contract.nativeModuleStem
                        ?: throw OliphauntException(
                            "Kotlin Android Oliphaunt non-CREATE extension $extension has no canonical native module identity",
                        )
                if (moduleStem !in runtimePackage.nativeModuleStems) {
                    throw OliphauntException(
                        "Kotlin Android Oliphaunt runtime resources ${runtimePackage.assetRoot} " +
                            "declare non-CREATE extension $extension but do not list native module stem $moduleStem",
                    )
                }
                val module = File(runtimeFiles, "lib/postgresql/$moduleStem.so")
                if (!module.isFile) {
                    val completelyStaticallyRegistered =
                        runtimePackage.mobileStaticRegistryState == "complete" &&
                            extension in runtimePackage.mobileStaticRegistryRegistered &&
                            extension !in runtimePackage.mobileStaticRegistryPending &&
                            moduleStem in runtimePackage.nativeModuleStems
                    if (completelyStaticallyRegistered) {
                        return@forEach
                    }
                    throw OliphauntException(
                        "Kotlin Android Oliphaunt runtime resources ${runtimePackage.assetRoot} " +
                            "declare non-CREATE extension $extension but are missing native module $moduleStem.so " +
                            "and do not completely statically register extension $extension as module $moduleStem",
                    )
                }
                return@forEach
            }
            val control = File(extensionDirectory, "$extension.control")
            if (!control.isFile) {
                throw OliphauntException(
                    "Kotlin Android Oliphaunt runtime resources ${runtimePackage.assetRoot} " +
                        "declare extension $extension but are missing $extension.control",
                )
            }
            val installScripts =
                extensionDirectory
                    .listFiles { file -> file.isFile && file.name.startsWith("$extension--") && file.name.endsWith(".sql") }
                    .orEmpty()
            if (installScripts.isEmpty()) {
                throw OliphauntException(
                    "Kotlin Android Oliphaunt runtime resources ${runtimePackage.assetRoot} " +
                        "declare extension $extension but are missing $extension--*.sql",
                )
            }
        }
    }

    private fun releaseShapedRuntimePackageForDirectory(runtimeDirectory: String): OliphauntAndroidAssetPackage? {
        val filesDir = File(runtimeDirectory)
        if (filesDir.name != FILES_DIR_NAME) {
            return null
        }
        val runtimeRoot = filesDir.parentFile ?: return null
        if (runtimeRoot.name != "runtime") {
            return null
        }
        val oliphauntRoot = runtimeRoot.parentFile ?: return null
        if (oliphauntRoot.name != "oliphaunt") {
            return null
        }
        val resourceRoot = oliphauntRoot.parentFile ?: return null
        val expectedFiles = File(resourceRoot, "$RUNTIME_ASSET_ROOT/$FILES_DIR_NAME")
        if (filesDir.canonicalPathOrAbsolute() != expectedFiles.canonicalPathOrAbsolute()) {
            return null
        }
        val receipt = File(resourceRoot, CARRIER_MANIFEST_ASSET)
        if (!receipt.isFile) return null
        validateCarrierReceipt(receipt.readText(), receipt.absolutePath)
        return filePackageManifestOrNull(resourceRoot, RUNTIME_ASSET_ROOT)
    }

    private fun validateExtensionIds(values: Collection<String>): Set<String> = validateGeneratedExtensionIds(values, label = "liboliphaunt extension id").toSortedSet()

    private fun validateRuntimeFeatures(values: Collection<String>): Set<String> {
        val features = validatePortableIds(values, label = "runtime feature")
        val unsupported = features - setOf("icu")
        if (unsupported.isNotEmpty()) {
            throw OliphauntException(
                "liboliphaunt runtime feature(s) ${unsupported.sorted().joinToString(",")} are not supported by this SDK",
            )
        }
        return features
    }

    private fun validatePortableIds(
        values: Collection<String>,
        label: String,
    ): Set<String> = values
        .map(String::trim)
        .filter(String::isNotEmpty)
        .also { ids ->
            ids.forEach { value ->
                if (!portableId.matches(value)) {
                    throw OliphauntException(
                        "liboliphaunt $label '$value' must contain only ASCII letters, digits, '.', '_' or '-'",
                    )
                }
            }
        }.toSortedSet()

    private fun validateMobileStaticRegistryState(state: String?): String? {
        if (state.isNullOrEmpty()) {
            return null
        }
        if (state !in setOf("not-required", "complete", "pending")) {
            throw OliphauntException(
                "Oliphaunt mobileStaticRegistryState '$state' must be one of not-required, complete, or pending",
            )
        }
        return state
    }

    private fun validateMobileStaticRegistryManifest(
        state: String?,
        registered: Set<String>,
        pending: Set<String>,
        nativeModuleStems: Set<String>,
        selectedExtensions: Set<String>,
    ) {
        if (state == null) {
            throw OliphauntException("Oliphaunt mobile static-registry manifest omits mobileStaticRegistryState")
        }
        if (registered.intersect(pending).isNotEmpty()) {
            throw OliphauntException(
                "Oliphaunt mobile static-registry manifest lists the same extension as registered and pending",
            )
        }
        val unselected = (registered + pending) - selectedExtensions
        if (unselected.isNotEmpty()) {
            throw OliphauntException(
                "Oliphaunt mobile static-registry manifest lists extension(s) outside selectedExtensions: " +
                    unselected.sorted().joinToString(","),
            )
        }
        when (state) {
            "not-required" -> {
                if (registered.isNotEmpty() || pending.isNotEmpty() || nativeModuleStems.isNotEmpty()) {
                    throw OliphauntException(
                        "Oliphaunt mobileStaticRegistryState=not-required must not list registered, pending, or native module stems",
                    )
                }
            }

            "pending" -> {
                if (pending.isEmpty()) {
                    throw OliphauntException(
                        "Oliphaunt mobileStaticRegistryState=pending must list mobileStaticRegistryPending",
                    )
                }
            }

            "complete" -> {
                if (pending.isNotEmpty()) {
                    throw OliphauntException(
                        "Oliphaunt mobileStaticRegistryState=complete must not list mobileStaticRegistryPending",
                    )
                }
                if (registered.isEmpty() || nativeModuleStems.isEmpty()) {
                    throw OliphauntException(
                        "Oliphaunt mobileStaticRegistryState=complete must list mobileStaticRegistryRegistered and nativeModuleStems",
                    )
                }
            }
        }
    }

    private fun materializeAssetPackage(
        assetManager: AssetManager,
        assetPackage: OliphauntAndroidAssetPackage,
        target: File,
    ) {
        val stamp = File(target, STAMP_NAME)
        if (isAndroidRuntimeCacheReady(target, stamp, assetPackage.cacheKey)) {
            return
        }

        val parent =
            target.parentFile
                ?: throw OliphauntException("runtime target has no parent directory: ${target.absolutePath}")
        if (!parent.mkdirs() && !parent.isDirectory) {
            throw OliphauntException("failed to create runtime cache directory at ${parent.absolutePath}")
        }

        val temp = File(parent, ".${target.name}.tmp-${System.nanoTime()}")
        val result =
            runCatching {
                copyPackageTree(assetManager, assetPackage, temp)
                markRuntimeExecutablePlaceholders(temp)
                File(temp, STAMP_NAME).writeText(assetPackage.cacheKey)
                syncAndroidPublicationTree(temp)
                if (!temp.renameTo(target)) {
                    if (isAndroidRuntimeCacheReady(target, stamp, assetPackage.cacheKey)) {
                        return@runCatching
                    }
                    throw OliphauntException(
                        "failed to publish runtime assets at ${target.absolutePath}",
                    )
                }
                syncAndroidDirectory(parent)
            }
        finishAndroidStaging(result, operation = "runtime cache publication") {
            removeAndroidStagingIfPresent(temp)
        }
    }

    internal fun isAndroidRuntimeCacheReady(
        target: File,
        stamp: File,
        cacheKey: String,
        isSymbolicLink: (File) -> Boolean = ::isAndroidSymbolicLink,
    ): Boolean {
        val targetIsSymbolicLink = isSymbolicLink(target)
        if (target.isDirectory && !targetIsSymbolicLink && stamp.readTextOrNull() == cacheKey) {
            return true
        }
        if (target.exists() || targetIsSymbolicLink) {
            throw OliphauntException(
                "immutable Android Oliphaunt runtime cache has an invalid identity at ${target.absolutePath}",
            )
        }
        return false
    }

    private fun copyPackageTree(
        assetManager: AssetManager,
        assetPackage: OliphauntAndroidAssetPackage,
        destination: File,
    ) {
        val resourceRoot = assetPackage.resourceRoot
        if (resourceRoot == null) {
            copyAssetTree(assetManager, "${assetPackage.assetRoot}/$FILES_DIR_NAME", destination)
        } else {
            copyFileTree(File(resourceRoot, "${assetPackage.assetRoot}/$FILES_DIR_NAME"), destination)
        }
    }

    private fun markRuntimeExecutablePlaceholders(root: File) {
        val postgres = File(root, "bin/postgres")
        if (postgres.isFile) {
            postgres.setExecutable(true, false)
        }
    }

    private fun copyAssetTree(
        assetManager: AssetManager,
        assetPath: String,
        destination: File,
    ) {
        val children =
            assetManager.list(assetPath)
                ?: throw OliphauntException("failed to list Android asset path $assetPath")
        if (children.isEmpty()) {
            destination.parentFile?.mkdirs()
            try {
                assetManager.open(assetPath).use { input ->
                    destination.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
            } catch (error: FileNotFoundException) {
                throw OliphauntException("missing Android asset path $assetPath: ${error.message}")
            }
            return
        }

        if (!destination.mkdirs() && !destination.isDirectory) {
            throw OliphauntException("failed to create directory ${destination.absolutePath}")
        }
        children.sorted().forEach { child ->
            copyAssetTree(assetManager, "$assetPath/$child", File(destination, child))
        }
    }

    private fun copyFileTree(
        source: File,
        destination: File,
    ) {
        if (!source.exists()) {
            throw OliphauntException("missing Oliphaunt resource path ${source.absolutePath}")
        }
        if (source.isFile) {
            destination.parentFile?.mkdirs()
            source.inputStream().use { input ->
                destination.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            return
        }
        if (!source.isDirectory) {
            throw OliphauntException("Oliphaunt resource path is not a file or directory: ${source.absolutePath}")
        }
        if (!destination.mkdirs() && !destination.isDirectory) {
            throw OliphauntException("failed to create directory ${destination.absolutePath}")
        }
        source.listFiles().orEmpty().sortedBy(File::getName).forEach { child ->
            copyFileTree(child, File(destination, child.name))
        }
    }

    private fun File.readTextOrNull(): String? = try {
        if (isFile) readText() else null
    } catch (_: IOException) {
        null
    }

    private fun File.canonicalPathOrAbsolute(): String = try {
        canonicalPath
    } catch (_: IOException) {
        absolutePath
    }
}
