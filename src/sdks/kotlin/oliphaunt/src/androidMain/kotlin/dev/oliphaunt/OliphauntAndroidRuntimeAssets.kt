package dev.oliphaunt

import android.content.Context
import android.content.res.AssetManager
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.Properties

internal data class OliphauntAndroidAssetPackage(
    val assetRoot: String,
    val cacheKey: String,
    val extensions: Set<String> = emptySet(),
    val runtimeFeatures: Set<String> = emptySet(),
    val sharedPreloadLibraries: Set<String> = emptySet(),
    val mobileStaticRegistryState: String? = null,
    val mobileStaticRegistryRegistered: Set<String> = emptySet(),
    val mobileStaticRegistryPending: Set<String> = emptySet(),
    val nativeModuleStems: Set<String> = emptySet(),
)

public data class OliphauntPackageSizeReport(
    val packageBytes: Long,
    val runtimeBytes: Long,
    val templatePgdataBytes: Long,
    val staticRegistryBytes: Long,
    val selectedExtensionBytes: Long,
    val extensions: List<OliphauntExtensionSizeReport>,
    val runtimeFeatures: List<String> = emptyList(),
    val mobileStaticRegistryState: String? = null,
    val mobileStaticRegistryRegistered: List<String> = emptyList(),
    val mobileStaticRegistryPending: List<String> = emptyList(),
    val nativeModuleStems: List<String> = emptyList(),
)

public data class OliphauntExtensionSizeReport(
    val name: String,
    val fileCount: Int,
    val bytes: Long,
)

internal data class OliphauntAndroidResolvedRuntime(
    val runtimeDirectory: String,
    val templatePgdata: OliphauntAndroidAssetPackage?,
)

internal object OliphauntAndroidRuntimeAssets {
    private const val RUNTIME_ASSET_ROOT = "oliphaunt/runtime"
    private const val TEMPLATE_PGDATA_ASSET_ROOT = "oliphaunt/template-pgdata"
    private const val PACKAGE_SIZE_REPORT_ASSET = "oliphaunt/package-size.tsv"
    private const val RUNTIME_RESOURCES_SCHEMA = "oliphaunt-runtime-resources-v1"
    private const val RUNTIME_PACKAGE_LAYOUT = "postgres-runtime-files-v1"
    private const val TEMPLATE_PGDATA_PACKAGE_LAYOUT = "postgres-template-pgdata-v1"
    private const val MANIFEST_NAME = "manifest.properties"
    private const val FILES_DIR_NAME = "files"
    private const val STAMP_NAME = ".liboliphaunt-asset-cache-key"
    private val requiredTemplatePgdataDirectories =
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

    fun resolve(
        context: Context,
        explicitRuntimeDirectory: String?,
        requestedExtensions: Collection<String> = emptyList(),
    ): OliphauntAndroidResolvedRuntime {
        val requestedExtensionSet = validateExtensionIds(requestedExtensions)
        val templatePgdata = packageManifestOrNull(context.assets, TEMPLATE_PGDATA_ASSET_ROOT)
        val runtimeDirectory =
            explicitRuntimeDirectory?.takeIf(String::isNotEmpty)
                ?: materializePackagedRuntime(context, requestedExtensionSet)
        return OliphauntAndroidResolvedRuntime(
            runtimeDirectory = runtimeDirectory,
            templatePgdata = templatePgdata,
        )
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
        templatePgdata: OliphauntAndroidAssetPackage?,
    ) {
        if (File(pgdata, "PG_VERSION").isFile) {
            return
        }
        if (templatePgdata == null) {
            throw OliphauntException(
                "Kotlin Android Oliphaunt requires packaged template PGDATA for new roots. " +
                    "Package oliphaunt/template-pgdata assets or open an existing root that already contains PG_VERSION.",
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

        val temp = File(parent, ".pgdata-template-${templatePgdata.cacheKey}-${System.nanoTime()}")
        temp.deleteRecursively()
        try {
            copyAssetTree(assetManager, "${templatePgdata.assetRoot}/$FILES_DIR_NAME", temp)
            ensureTemplatePgdataDirectoriesForAndroid(temp)
            normalizeTemplatePgdataForAndroid(temp)
            if (!File(temp, "PG_VERSION").isFile) {
                throw OliphauntException(
                    "packaged liboliphaunt template PGDATA ${templatePgdata.assetRoot} does not contain PG_VERSION",
                )
            }
            if (pgdata.exists() && !pgdata.delete()) {
                throw OliphauntException("failed to replace empty PGDATA at ${pgdata.absolutePath}")
            }
            if (!temp.renameTo(pgdata)) {
                throw OliphauntException("failed to publish template PGDATA at ${pgdata.absolutePath}")
            }
        } catch (error: Throwable) {
            temp.deleteRecursively()
            throw error
        }
    }

    private fun materializePackagedRuntime(
        context: Context,
        requestedExtensions: Set<String>,
    ): String {
        val runtimePackage =
            packageManifestOrNull(context.assets, RUNTIME_ASSET_ROOT)
                ?: throw OliphauntException(
                    "Kotlin Android Oliphaunt runtime resources are not present. " +
                        "Pass runtimeDirectory for local development or configure Gradle with " +
                        "-PoliphauntRuntimeDir=<postgres-install-root>.",
                )
        requirePackagedExtensions(runtimePackage, requestedExtensions)
        val runtimeRoot =
            File(
                context.noBackupFilesDir,
                "oliphaunt/runtime/${runtimePackage.cacheKey}",
            )
        materializeAssetPackage(context.assets, runtimePackage, runtimeRoot)
        return runtimeRoot.absolutePath
    }

    private fun packageManifestOrNull(
        assetManager: AssetManager,
        assetRoot: String,
    ): OliphauntAndroidAssetPackage? {
        val properties = Properties()
        try {
            assetManager.open("$assetRoot/$MANIFEST_NAME").use(properties::load)
        } catch (_: FileNotFoundException) {
            return null
        } catch (error: IOException) {
            throw OliphauntException("failed to read Oliphaunt asset manifest $assetRoot: ${error.message}")
        }
        return parseManifestProperties(assetRoot, properties)
    }

    internal fun parseManifestProperties(
        assetRoot: String,
        properties: Properties,
    ): OliphauntAndroidAssetPackage {
        val schema = properties.getProperty("schema")?.trim().orEmpty()
        if (schema != RUNTIME_RESOURCES_SCHEMA) {
            throw OliphauntException(
                "Oliphaunt asset manifest $assetRoot has unsupported runtime resource schema " +
                    "'${schema.ifEmpty { "<missing>" }}'; expected $RUNTIME_RESOURCES_SCHEMA",
            )
        }
        val layout = properties.getProperty("layout")?.trim().orEmpty()
        val expectedLayout = expectedLayout(assetRoot)
        if (layout != expectedLayout) {
            throw OliphauntException(
                "Oliphaunt asset manifest $assetRoot has unsupported layout " +
                    "'${layout.ifEmpty { "<missing>" }}'; expected $expectedLayout",
            )
        }
        val cacheKey = properties.getProperty("cacheKey")?.trim().orEmpty()
        if (!portableId.matches(cacheKey)) {
            throw OliphauntException("Oliphaunt asset manifest $assetRoot has invalid cacheKey '$cacheKey'")
        }
        val extensions =
            validateExtensionIds(
                properties.getProperty("extensions").orEmpty().split(','),
            )
        val runtimeFeatures =
            validateRuntimeFeatures(
                properties.getProperty("runtimeFeatures").orEmpty().split(','),
            )
        val mobileStaticRegistryState =
            validateMobileStaticRegistryState(
                properties.getProperty("mobileStaticRegistryState")?.trim(),
            )
        val mobileStaticRegistryPending =
            validatePortableIds(
                properties.getProperty("mobileStaticRegistryPending").orEmpty().split(','),
                label = "mobile static registry extension",
            )
        val mobileStaticRegistryRegistered =
            validatePortableIds(
                properties.getProperty("mobileStaticRegistryRegistered").orEmpty().split(','),
                label = "mobile static registry extension",
            )
        val nativeModuleStems =
            validatePortableIds(
                properties.getProperty("nativeModuleStems").orEmpty().split(','),
                label = "native module stem",
            )
        val sharedPreloadLibraries =
            validatePortableIds(
                properties.getProperty("sharedPreloadLibraries").orEmpty().split(','),
                label = "shared preload library",
            )
        validateMobileStaticRegistryManifest(
            state = mobileStaticRegistryState,
            registered = mobileStaticRegistryRegistered,
            pending = mobileStaticRegistryPending,
            nativeModuleStems = nativeModuleStems,
        )
        return OliphauntAndroidAssetPackage(
            assetRoot = assetRoot,
            cacheKey = cacheKey,
            extensions = extensions,
            runtimeFeatures = runtimeFeatures,
            sharedPreloadLibraries = sharedPreloadLibraries,
            mobileStaticRegistryState = mobileStaticRegistryState,
            mobileStaticRegistryRegistered = mobileStaticRegistryRegistered,
            mobileStaticRegistryPending = mobileStaticRegistryPending,
            nativeModuleStems = nativeModuleStems,
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
        val properties = Properties()
        manifest.inputStream().use(properties::load)
        return parseManifestProperties(assetRoot, properties)
    }

    private fun OliphauntPackageSizeReport.withRuntimeManifest(runtime: OliphauntAndroidAssetPackage?): OliphauntPackageSizeReport = if (runtime == null) {
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
        var templatePgdataBytes: Long? = null
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

                "package" to "template-pgdata" -> {
                    templatePgdataBytes =
                        setSizeReportValue(
                            current = templatePgdataBytes,
                            value = bytes,
                            row = "package/template-pgdata",
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
            templatePgdataBytes =
            requireSizeReportValue(
                templatePgdataBytes,
                "package/template-pgdata",
                source,
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

    internal fun ensureTemplatePgdataDirectoriesForAndroid(pgdata: File) {
        requiredTemplatePgdataDirectories.forEach { relative ->
            val directory = File(pgdata, relative)
            if (!directory.mkdirs() && !directory.isDirectory) {
                throw OliphauntException(
                    "failed to create Android template PGDATA directory ${directory.absolutePath}",
                )
            }
        }
    }

    private fun normalizeTemplatePgdataForAndroid(pgdata: File) {
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
        TEMPLATE_PGDATA_ASSET_ROOT -> TEMPLATE_PGDATA_PACKAGE_LAYOUT
        else -> throw OliphauntException("unsupported Oliphaunt asset root '$assetRoot'")
    }

    private fun requirePackagedExtensions(
        runtimePackage: OliphauntAndroidAssetPackage,
        requestedExtensions: Set<String>,
    ) {
        val missing =
            requestedExtensions
                .filterNot(runtimePackage.extensions::contains)
                .sorted()
        if (missing.isNotEmpty()) {
            val available = runtimePackage.extensions.sorted().joinToString(",")
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
    }

    private fun validateExtensionIds(values: Collection<String>): Set<String> = validatePortableIds(values, label = "extension id")

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
    ) {
        if (state == null) {
            throw OliphauntException("Oliphaunt mobile static-registry manifest omits mobileStaticRegistryState")
        }
        if (registered.intersect(pending).isNotEmpty()) {
            throw OliphauntException(
                "Oliphaunt mobile static-registry manifest lists the same extension as registered and pending",
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
        if (target.isDirectory && stamp.readTextOrNull() == assetPackage.cacheKey) {
            return
        }

        val parent =
            target.parentFile
                ?: throw OliphauntException("runtime target has no parent directory: ${target.absolutePath}")
        if (!parent.mkdirs() && !parent.isDirectory) {
            throw OliphauntException("failed to create runtime cache directory at ${parent.absolutePath}")
        }

        val temp = File(parent, ".${target.name}.tmp-${System.nanoTime()}")
        temp.deleteRecursively()
        try {
            copyAssetTree(assetManager, "${assetPackage.assetRoot}/$FILES_DIR_NAME", temp)
            markRuntimeExecutablePlaceholders(temp)
            File(temp, STAMP_NAME).writeText(assetPackage.cacheKey)
            if (target.exists()) {
                target.deleteRecursively()
            }
            if (!temp.renameTo(target)) {
                throw OliphauntException("failed to publish runtime assets at ${target.absolutePath}")
            }
        } catch (error: Throwable) {
            temp.deleteRecursively()
            throw error
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

    private fun File.readTextOrNull(): String? = try {
        if (isFile) readText() else null
    } catch (_: IOException) {
        null
    }
}
