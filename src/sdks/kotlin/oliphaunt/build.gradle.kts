import groovy.json.JsonSlurper
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ArchiveOperations
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.FileSystemOperations
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.MapProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.jetbrains.dokka.gradle.engine.parameters.VisibilityModifier
import org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Properties
import javax.inject.Inject

plugins {
    id("com.android.library")
    alias(libs.plugins.detekt)
    alias(libs.plugins.dokka)
    id("org.jetbrains.kotlin.multiplatform")
    alias(libs.plugins.kover)
    alias(libs.plugins.maven.publish)
    alias(libs.plugins.spotless)
}

group = providers.gradleProperty("GROUP").orElse("dev.oliphaunt").get()
version = providers.gradleProperty("VERSION_NAME").orElse("0.1.0").get()

spotless {
    kotlin {
        target("src/**/*.kt")
        ktlint().editorConfigOverride(mapOf("ktlint_standard_property-naming" to "disabled"))
    }
    kotlinGradle {
        target("*.gradle.kts", "../*.gradle.kts")
        ktlint()
    }
}

detekt {
    buildUponDefaultConfig = true
    allRules = false
    basePath = rootProject.layout.projectDirectory.asFile
}

kover {
    reports {
        filters {
            includes {
                classes(
                    "dev.oliphaunt.AndroidContextRequiredEngine",
                    "dev.oliphaunt.Backup*",
                    "dev.oliphaunt.Engine*",
                    "dev.oliphaunt.Oliphaunt*",
                    "dev.oliphaunt.Protocol*",
                    "dev.oliphaunt.Query*",
                    "dev.oliphaunt.Restore*",
                )
            }
            excludes {
                classes(
                    "dev.oliphaunt.AndroidDirectTemporaryRoot",
                    "dev.oliphaunt.AndroidNativeDirectEngine",
                    "dev.oliphaunt.AndroidNativeDirectEngineKt",
                    "dev.oliphaunt.AndroidNativeDirectSession",
                    "dev.oliphaunt.OliphauntAndroid",
                    "dev.oliphaunt.OliphauntAndroidNativeBridge",
                    "dev.oliphaunt.OliphauntAndroidProtocolStreamSink",
                )
            }
        }
        verify {
            rule {
                minBound(80)
            }
        }
    }
}

dokka {
    dokkaPublications.html {
        moduleName.set("Oliphaunt Kotlin SDK")
        moduleVersion.set(project.version.toString())
        outputDirectory.set(rootProject.layout.projectDirectory.dir("../../target/docs/generated/api/kotlin/html"))
        failOnWarning.set(false)
        suppressObviousFunctions.set(true)
    }
    dokkaSourceSets.configureEach {
        documentedVisibilities.set(setOf(VisibilityModifier.Public))
        reportUndocumented.set(false)
        skipEmptyPackages.set(true)
        suppressGeneratedFiles.set(true)
        sourceLink {
            localDirectory.set(project.layout.projectDirectory.dir("src"))
            remoteUrl("https://github.com/f0rr0/oliphaunt/tree/main/src/sdks/kotlin/oliphaunt/src")
            remoteLineSuffix.set("#L")
        }
    }
}

val mavenCentralPublishRequested =
    gradle.startParameter.taskNames.any {
        it.contains("MavenCentral", ignoreCase = true)
    }
val explicitPublicationSigning =
    providers
        .gradleProperty("signAllPublications")
        .map { it.equals("true", ignoreCase = true) || it.equals("yes", ignoreCase = true) || it == "1" }
        .orElse(false)

mavenPublishing {
    publishToMavenCentral(automaticRelease = true)
    if (mavenCentralPublishRequested || explicitPublicationSigning.get()) {
        signAllPublications()
    }
    pom {
        name.set("Oliphaunt Kotlin SDK")
        description.set("Kotlin and Android SDK for native embedded PostgreSQL through liboliphaunt.")
        inceptionYear.set("2026")
        url.set("https://github.com/f0rr0/oliphaunt")
        licenses {
            license {
                name.set("MIT AND Apache-2.0 AND PostgreSQL")
                url.set("https://github.com/f0rr0/oliphaunt/blob/main/LICENSE")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("f0rr0")
                name.set("Oliphaunt Maintainers")
                url.set("https://github.com/f0rr0")
            }
        }
        scm {
            url.set("https://github.com/f0rr0/oliphaunt")
            connection.set("scm:git:https://github.com/f0rr0/oliphaunt.git")
            developerConnection.set("scm:git:ssh://git@github.com/f0rr0/oliphaunt.git")
        }
    }
}

val bridgeSource = layout.projectDirectory.file("src/nativeInterop/cinterop/oliphaunt_kotlin_bridge.c")
val bridgeHeader = layout.projectDirectory.file("src/nativeInterop/cinterop/oliphaunt_kotlin_bridge.h")
val bridgeOutputDir = layout.buildDirectory.dir("nativeBridge")
val bridgeArchive = bridgeOutputDir.map { it.file("liboliphaunt_kotlin_bridge.a") }
val generatedAndroidAssetsDir = layout.buildDirectory.dir("generated/oliphaunt-android-assets")
val generatedAndroidJniLibsDir = layout.buildDirectory.dir("generated/oliphaunt-android-jniLibs")
val resolvedReleaseAssetsDir = layout.buildDirectory.dir("generated/oliphaunt-release-assets")
val resolvedReleaseRuntimeResourcesDir = resolvedReleaseAssetsDir.map { it.dir("runtime-resources") }
val resolvedReleaseAndroidJniLibsDir = resolvedReleaseAssetsDir.map { it.dir("jniLibs") }
val resolvedReleaseAndroidExtensionArchivesDir = resolvedReleaseAssetsDir.map { it.dir("extensionArchives") }
val liboliphauntReleaseVersion =
    providers
        .gradleProperty("oliphauntLiboliphauntVersion")
        .orElse(providers.environmentVariable("OLIPHAUNT_LIBOLIPHAUNT_VERSION"))
val liboliphauntReleaseAssetBaseUrl =
    providers
        .gradleProperty("oliphauntAssetBaseUrl")
        .orElse(providers.environmentVariable("OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSET_BASE_URL"))
        .orElse(
            liboliphauntReleaseVersion.map { version ->
                "https://github.com/f0rr0/oliphaunt/releases/download/liboliphaunt-native-v$version"
            },
        )
val configuredCxxBuildRoot =
    (
        project.findProperty("oliphauntCxxBuildRoot")
            ?: System.getenv("OLIPHAUNT_CXX_BUILD_ROOT")
    )?.toString()
        ?.takeIf(String::isNotBlank)
        ?.let(::file)
val cxxBuildRoot =
    configuredCxxBuildRoot
        ?.resolve(if (path == ":") "root" else path.removePrefix(":").replace(':', '/'))
        ?: layout.buildDirectory
            .dir("cxx")
            .get()
            .asFile
val packagedRuntimeResourcesDir =
    (
        project.findProperty("oliphauntRuntimeResourcesDir")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_RUNTIME_RESOURCES_DIR")
            ?: System.getenv("OLIPHAUNT_ANDROID_RUNTIME_RESOURCES_DIR")
    )?.toString()
        ?: liboliphauntReleaseVersion.orNull?.let {
            resolvedReleaseRuntimeResourcesDir.get().asFile.absolutePath
        }
val packagedAndroidJniLibsDir =
    (
        project.findProperty("oliphauntAndroidJniLibsDir")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_JNI_LIBS_DIR")
    )?.toString()
        ?: liboliphauntReleaseVersion.orNull?.let {
            resolvedReleaseAndroidJniLibsDir.get().asFile.absolutePath
        }
val packagedAndroidExtensionArchivesDir =
    (
        project.findProperty("oliphauntAndroidExtensionArchivesDir")
            ?: project.findProperty("oliphauntExtensionArchivesDir")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_EXTENSION_ARCHIVES_DIR")
            ?: System.getenv("OLIPHAUNT_ANDROID_EXTENSION_ARCHIVES_DIR")
    )?.toString()
        ?: liboliphauntReleaseVersion.orNull?.let {
            resolvedReleaseAndroidExtensionArchivesDir.get().asFile.absolutePath
        }
val packagedAndroidLinkEvidenceFile =
    (
        project.findProperty("oliphauntAndroidLinkEvidenceFile")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_LINK_EVIDENCE_FILE")
            ?: System.getenv("OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE")
    )?.toString()
val explicitPackagedRuntimeDir =
    (
        project.findProperty("oliphauntRuntimeDir")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_RUNTIME_DIR")
    )?.toString()
val explicitPackagedTemplatePgdataDir =
    (
        project.findProperty("oliphauntTemplatePgdataDir")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_TEMPLATE_PGDATA_DIR")
    )?.toString()
val explicitPackagedExtensionsRaw =
    (
        project.findProperty("oliphauntExtensions")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_EXTENSIONS")
    )?.toString()
val explicitPackagedExtensionVersionsRaw =
    (
        project.findProperty("oliphauntExtensionVersions")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_EXTENSION_VERSIONS")
    )?.toString()
val explicitMobileStaticModulesRaw =
    (
        project.findProperty("oliphauntMobileStaticModules")
            ?: project.findProperty("oliphauntMobileStaticModuleStems")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_MOBILE_STATIC_MODULES")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_MOBILE_STATIC_MODULE_STEMS")
    )?.toString()
val explicitAndroidAbiFiltersRaw =
    (
        project.findProperty("oliphauntAndroidAbiFilters")
            ?: project.findProperty("oliphauntAndroidAbis")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_ABI_FILTERS")
            ?: System.getenv("OLIPHAUNT_ANDROID_ABI_FILTERS")
    )?.toString()

fun runtimeResourcesRoot(): File? {
    val root = packagedRuntimeResourcesDir?.takeIf(String::isNotBlank)?.let(::file) ?: return null
    val nested = root.resolve("oliphaunt")
    return when {
        nested.isDirectory -> nested
        root.resolve("runtime").isDirectory -> root
        else -> root.resolve("oliphaunt")
    }
}

fun runtimeResourceFiles(resourceName: String): String? =
    runtimeResourcesRoot()
        ?.resolve(resourceName)
        ?.resolve("files")
        ?.takeIf(File::isDirectory)
        ?.absolutePath

fun runtimeResourceManifestValue(
    resourceName: String,
    key: String,
): String? {
    val manifest =
        runtimeResourcesRoot()
            ?.resolve(resourceName)
            ?.resolve("manifest.properties")
            ?.takeIf(File::isFile)
            ?: return null
    val properties = Properties()
    manifest.inputStream().use(properties::load)
    return properties.getProperty(key)
}

val packagedRuntimeDir = runtimeResourceFiles("runtime") ?: explicitPackagedRuntimeDir
val packagedTemplatePgdataDir =
    runtimeResourceFiles("template-pgdata") ?: explicitPackagedTemplatePgdataDir
val packagedExtensionsRaw =
    explicitPackagedExtensionsRaw ?: runtimeResourceManifestValue("runtime", "extensions")
val packagedMobileStaticModulesRaw =
    explicitMobileStaticModulesRaw ?: runtimeResourceManifestValue("runtime", "nativeModuleStems")
val packagedStaticRegistrySource =
    runtimeResourceManifestValue("runtime", "mobileStaticRegistrySource")
        ?.takeIf(String::isNotBlank)
        ?.let { relative ->
            runtimeResourcesRoot()?.resolve(relative)?.takeIf(File::isFile)?.absolutePath
        }
val packagedResourceExtensionArchivesDir =
    runtimeResourcesRoot()
        ?.resolve("static-registry")
        ?.resolve("archives")
        ?.takeIf(File::isDirectory)
        ?.absolutePath
val effectiveAndroidExtensionArchivesDir =
    packagedAndroidExtensionArchivesDir?.takeIf(String::isNotBlank)
        ?: packagedResourceExtensionArchivesDir

abstract class PrepareOliphauntAndroidAssetsTask : DefaultTask() {
    @get:Input
    abstract val runtimeResourcesDirPath: Property<String>

    @get:Input
    abstract val runtimeDirPath: Property<String>

    @get:Input
    abstract val templatePgdataDirPath: Property<String>

    @get:Input
    abstract val selectedExtensions: ListProperty<String>

    @get:Input
    abstract val mobileStaticModuleStems: ListProperty<String>

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceDirectories: ConfigurableFileCollection

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val generatedExtensionMetadata: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    private val generatedExtensionMetadataBySqlName: Map<String, Map<String, Any?>> by lazy {
        val metadataFile = generatedExtensionMetadata.singleFile

        @Suppress("UNCHECKED_CAST")
        val parsed =
            JsonSlurper().parse(metadataFile) as? Map<String, Any?>
                ?: throw GradleException("generated extension metadata must be a JSON object: $metadataFile")
        val rows =
            parsed["extensions"] as? List<*>
                ?: throw GradleException("generated extension metadata must define extensions: $metadataFile")
        rows.associate { value ->
            val row =
                (value as? Map<*, *>)
                    ?.mapKeys { (key, _) -> key.toString() }
                    ?: throw GradleException("generated extension metadata rows must be JSON objects: $metadataFile")
            val sqlName =
                row["sql-name"] as? String
                    ?: throw GradleException("generated extension metadata rows must define sql-name: $metadataFile")
            sqlName to row
        }
    }

    @TaskAction
    fun prepare() {
        val output = outputDir.get().asFile
        deleteTree(output.toPath())
        output.mkdirs()

        val runtimeResourcesPath = runtimeResourcesDirPath.get().takeIf(String::isNotBlank)
        if (runtimeResourcesPath != null) {
            val sourceRuntimeResourcesRoot = runtimeResourcesRoot(File(runtimeResourcesPath))
            require(sourceRuntimeResourcesRoot.isDirectory) {
                "Oliphaunt Kotlin Android runtime resources are not a Oliphaunt resource root: $runtimeResourcesPath"
            }
            validateRuntimeResourcesSchema(sourceRuntimeResourcesRoot)
            copyTree(
                sourceRuntimeResourcesRoot.toPath(),
                output.resolve("oliphaunt").toPath(),
                excludedPrefixes = setOf("static-registry/archives"),
            )
            return
        }

        writeAndroidAssetPackage(
            name = "runtime",
            layout = "postgres-runtime-files-v1",
            sourcePath = runtimeDirPath.get().takeIf(String::isNotBlank),
            requestedExtensions = selectedExtensions.get(),
            mobileStaticModuleStems = mobileStaticModuleStems.get(),
            output = output,
        )
        writeAndroidAssetPackage(
            name = "template-pgdata",
            layout = "postgres-template-pgdata-v1",
            sourcePath = templatePgdataDirPath.get().takeIf(String::isNotBlank),
            requestedExtensions = emptyList(),
            mobileStaticModuleStems = emptyList(),
            output = output,
        )
    }

    private fun validateRuntimeResourcesSchema(root: File) {
        for (name in listOf("runtime", "template-pgdata")) {
            val manifest = root.resolve("$name/manifest.properties")
            require(manifest.isFile) {
                "Oliphaunt Kotlin Android runtime resources are missing $name/manifest.properties under ${root.absolutePath}"
            }
            val properties = Properties()
            manifest.inputStream().use(properties::load)
            val schema = properties.getProperty("schema")?.trim().orEmpty()
            require(schema == "oliphaunt-runtime-resources-v1") {
                "Oliphaunt Kotlin Android runtime resources $name manifest has unsupported schema '${schema.ifEmpty {
                    "<missing>"
                }}'; expected oliphaunt-runtime-resources-v1"
            }
        }
    }

    private fun runtimeResourcesRoot(root: File): File {
        val nested = root.resolve("oliphaunt")
        return when {
            nested.isDirectory -> nested
            root.resolve("runtime").isDirectory -> root
            else -> root.resolve("oliphaunt")
        }
    }

    private fun writeAndroidAssetPackage(
        name: String,
        layout: String,
        sourcePath: String?,
        requestedExtensions: List<String>,
        mobileStaticModuleStems: List<String>,
        output: File,
    ) {
        if (sourcePath.isNullOrBlank()) {
            require(requestedExtensions.isEmpty()) {
                "Oliphaunt Kotlin Android extensions require -PoliphauntRuntimeDir=<postgres-install-root>"
            }
            return
        }
        val source = File(sourcePath)
        require(source.isDirectory) {
            "Oliphaunt Kotlin Android $name assets source is not a directory: $source"
        }
        require(mobileStaticModuleStems.isEmpty()) {
            "Oliphaunt Kotlin Android split runtime packaging cannot declare mobile static module stems. " +
                "Use -PoliphauntRuntimeResourcesDir=<runtime-resource output> from " +
                "`oliphaunt-resources --mobile-static-module ...` so the runtime resources include the generated static-registry source."
        }
        val packageDir = output.resolve("oliphaunt/$name")
        val filesDir = packageDir.resolve("files")
        copyTree(source.toPath(), filesDir.toPath())
        val extensions = resolveExtensionSelection(requestedExtensions)
        val nativeModuleStems = nativeModuleStems(extensions)
        val registeredModuleStems = mobileStaticModuleStems.toSortedSet()
        val unknownRegisteredStems = registeredModuleStems - nativeModuleStems.toSet()
        require(unknownRegisteredStems.isEmpty()) {
            "Oliphaunt Kotlin Android mobile static module stem(s) were not selected by these runtime resources: " +
                unknownRegisteredStems.joinToString(",")
        }
        val registeredMobileExtensions = mobileStaticRegistryRegisteredExtensions(extensions, registeredModuleStems)
        val pendingMobileExtensions = mobileStaticRegistryPendingExtensions(extensions, registeredModuleStems)
        val mobileStaticRegistryState =
            when {
                nativeModuleStems.isEmpty() -> "not-required"
                pendingMobileExtensions.isEmpty() -> "complete"
                else -> "pending"
            }
        val manifest = packageDir.resolve("manifest.properties")
        manifest.parentFile.mkdirs()
        manifest.writeText(
            listOf(
                "schema=oliphaunt-runtime-resources-v1",
                "cacheKey=${sha256Directory(source)}",
                "layout=$layout",
                "source=${source.name}",
                "extensions=${extensions.joinToString(",")}",
                "sharedPreloadLibraries=${sharedPreloadLibraries(extensions).joinToString(",")}",
                "mobileStaticRegistryState=$mobileStaticRegistryState",
                "mobileStaticRegistryRegistered=${registeredMobileExtensions.joinToString(",")}",
                "mobileStaticRegistryPending=${pendingMobileExtensions.joinToString(",")}",
                "nativeModuleStems=${nativeModuleStems.joinToString(",")}",
                "mobileStaticRegistrySource=",
                "",
            ).joinToString("\n"),
        )
    }

    private fun resolveExtensionSelection(requestedExtensions: List<String>): List<String> {
        val extensions = linkedSetOf<String>()
        for (extension in requestedExtensions) {
            extensions.addAll(extensionDependencies(extension))
            extensions.add(extension)
        }
        return extensions.toSortedSet().onEach(::requireMobileReleaseReady).toList()
    }

    private fun extensionDependencies(extension: String): List<String> =
        generatedExtensionStringList(extension, "selected-extension-dependencies")

    private fun sharedPreloadLibraries(extensions: List<String>): List<String> =
        extensions
            .flatMap { extension -> generatedExtensionStringList(extension, "shared-preload-libraries") }
            .toSortedSet()
            .toList()

    private fun mobileStaticRegistryRegisteredExtensions(
        extensions: List<String>,
        registeredModuleStems: Set<String>,
    ): List<String> =
        extensions
            .filter { extension ->
                val stem = nativeModuleStem(extension)
                stem != null && stem in registeredModuleStems
            }.toSortedSet()
            .toList()

    private fun mobileStaticRegistryPendingExtensions(
        extensions: List<String>,
        registeredModuleStems: Set<String>,
    ): List<String> =
        extensions
            .filter { extension ->
                val stem = nativeModuleStem(extension)
                stem != null && stem !in registeredModuleStems
            }.toSortedSet()
            .toList()

    private fun nativeModuleStems(extensions: List<String>): List<String> =
        extensions
            .mapNotNull(::nativeModuleStem)
            .toSortedSet()
            .toList()

    private fun nativeModuleStem(extension: String): String? = generatedNativeModuleStem(extension)

    private fun generatedExtensionStringList(
        extension: String,
        field: String,
    ): List<String> =
        (generatedExtensionMetadataRow(extension)[field] as? List<*>)
            ?.map { value -> value.toString() }
            ?: emptyList()

    private fun generatedExtensionMetadataRow(extension: String): Map<String, Any?> =
        generatedExtensionMetadataBySqlName[extension]
            ?: throw GradleException(
                "Oliphaunt Kotlin Android split runtime packaging cannot select unknown extension '$extension'. " +
                    "Use a generated built-in extension name, or pass " +
                    "-PoliphauntRuntimeResourcesDir=<runtime-resource output> for custom prebuilt extension artifacts.",
            )

    private fun generatedNativeModuleStem(extension: String): String? {
        val row = generatedExtensionMetadataRow(extension)
        return row["native-module-stem"] as? String
    }

    private fun requireMobileReleaseReady(extension: String) {
        val row = generatedExtensionMetadataRow(extension)
        require(row["mobile-release-ready"] == true) {
            "Oliphaunt Kotlin Android split runtime packaging cannot select extension '$extension' because " +
                "it does not have release-ready Android/iOS artifacts in the generated exact-extension catalog."
        }
    }

    private fun sha256Directory(source: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val rootPath = source.toPath()
        Files.walk(rootPath).use { stream ->
            stream.sorted().forEach { path ->
                require(!Files.isSymbolicLink(path)) {
                    "Oliphaunt Android assets do not support symlinks: $path"
                }
                if (Files.isRegularFile(path)) {
                    val relative = rootPath.relativize(path).toString().replace(File.separatorChar, '/')
                    digest.update(relative.toByteArray(Charsets.UTF_8))
                    digest.update(0.toByte())
                    digest.update(Files.readAllBytes(path))
                    digest.update(0.toByte())
                }
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun copyTree(
        source: Path,
        target: Path,
        excludedPrefixes: Set<String> = emptySet(),
    ) {
        Files.walk(source).use { stream ->
            stream.sorted().forEach { path ->
                require(!Files.isSymbolicLink(path)) {
                    "Oliphaunt Android assets do not support symlinks: $path"
                }
                val relative = source.relativize(path)
                val relativeName = relative.toString().replace(File.separatorChar, '/')
                if (excludedPrefixes.any { prefix -> relativeName == prefix || relativeName.startsWith("$prefix/") }) {
                    return@forEach
                }
                val destination = target.resolve(relative)
                when {
                    Files.isDirectory(path) -> {
                        Files.createDirectories(destination)
                    }

                    Files.isRegularFile(path) -> {
                        Files.createDirectories(destination.parent)
                        Files.copy(path, destination, StandardCopyOption.REPLACE_EXISTING)
                    }
                }
            }
        }
    }

    private fun deleteTree(path: Path) {
        if (!Files.exists(path)) return
        Files.walk(path).use { stream ->
            stream.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
        }
    }
}

abstract class PrepareOliphauntAndroidJniLibsTask : DefaultTask() {
    @get:Input
    abstract val jniLibsDirPath: Property<String>

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceDirectories: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun prepare() {
        val output = outputDir.get().asFile
        deleteTree(output.toPath())
        val configured = jniLibsDirPath.get().takeIf(String::isNotBlank) ?: return
        val configuredRoot = File(configured)
        val source = configuredRoot.resolve("jniLibs").takeIf(File::isDirectory) ?: configuredRoot
        require(source.isDirectory) {
            "Oliphaunt Kotlin Android JNI libs source is not a directory: $source"
        }

        val abiDirs =
            source
                .listFiles()
                ?.filter(File::isDirectory)
                ?.sortedBy(File::getName)
                ?: emptyList()
        require(abiDirs.isNotEmpty()) {
            "Oliphaunt Kotlin Android JNI libs require ABI directories under $source"
        }

        var packagedLiboliphaunt = false
        for (abiDir in abiDirs) {
            require(abiDir.name in ANDROID_JNI_LIB_ABIS) {
                "unsupported Android ABI directory for Oliphaunt Kotlin package: ${abiDir.name}"
            }
            require(!Files.isSymbolicLink(abiDir.toPath())) {
                "Oliphaunt Kotlin Android JNI libs do not support symlink ABI directories: $abiDir"
            }
            val sharedLibraries =
                abiDir
                    .listFiles()
                    ?.filter { file ->
                        require(!Files.isSymbolicLink(file.toPath())) {
                            "Oliphaunt Kotlin Android JNI libs do not support symlinks: $file"
                        }
                        require(file.isFile) {
                            "Oliphaunt Kotlin Android JNI libs only support flat .so files under ABI directories: $file"
                        }
                        file.name.endsWith(".so")
                    }?.sortedBy(File::getName)
                    ?: emptyList()
            require(sharedLibraries.any { it.name == "liboliphaunt.so" }) {
                "Android ABI ${abiDir.name} is missing liboliphaunt.so"
            }
            packagedLiboliphaunt = true
            val destination = output.resolve(abiDir.name)
            destination.mkdirs()
            for (library in sharedLibraries) {
                Files.copy(
                    library.toPath(),
                    destination.resolve(library.name).toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                )
            }
        }
        require(packagedLiboliphaunt) {
            "Oliphaunt Kotlin Android JNI libs did not contain liboliphaunt.so for any ABI"
        }
    }

    private fun deleteTree(path: Path) {
        if (!Files.exists(path)) return
        Files.walk(path).use { stream ->
            stream.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
        }
    }

    companion object {
        private val ANDROID_JNI_LIB_ABIS = setOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
    }
}

abstract class ResolveOliphauntAndroidReleaseAssetsTask
    @Inject
    constructor(
        private val archiveOperations: ArchiveOperations,
        private val fileSystemOperations: FileSystemOperations,
    ) : DefaultTask() {
        @get:Input
        abstract val version: Property<String>

        @get:Input
        abstract val assetBaseUrl: Property<String>

        @get:Input
        abstract val selectedAbis: ListProperty<String>

        @get:Input
        abstract val selectedExtensions: ListProperty<String>

        @get:Input
        abstract val extensionVersions: MapProperty<String, String>

        @get:OutputDirectory
        abstract val assetCacheDir: DirectoryProperty

        @get:OutputDirectory
        abstract val runtimeResourcesDir: DirectoryProperty

        @get:OutputDirectory
        abstract val jniLibsDir: DirectoryProperty

        @get:OutputDirectory
        abstract val extensionArchivesDir: DirectoryProperty

        @TaskAction
        fun resolve() {
            val releaseVersion = version.get()
            validateReleaseVersion(releaseVersion)
            val cache = assetCacheDir.get().asFile
            cache.mkdirs()
            val checksumAsset = "liboliphaunt-$releaseVersion-release-assets.sha256"
            val checksumFile = downloadAsset(checksumAsset, cache)
            val checksums = parseChecksums(checksumFile)

            val assets =
                linkedSetOf(
                    "liboliphaunt-$releaseVersion-runtime-resources.tar.gz",
                )
            for (abi in selectedAbis.get().ifEmpty { listOf("arm64-v8a", "x86_64") }) {
                assets += androidBaseAsset(releaseVersion, abi)
            }

            val downloaded =
                assets
                    .associateWith { asset ->
                        downloadAndVerify(asset, cache, checksums)
                    }.toMutableMap()
            val extensionDownloaded = linkedMapOf<String, File>()
            val selectedExtensionRows =
                selectedExtensionRows(
                    releaseVersion,
                    cache,
                    extensionDownloaded,
                    selectedAbis.get().ifEmpty { listOf("arm64-v8a", "x86_64") },
                )

            unpackRuntimeResources(downloaded.getValue("liboliphaunt-$releaseVersion-runtime-resources.tar.gz"))
            mergeExtensionRuntimeArtifacts(extensionDownloaded, selectedExtensionRows)
            unpackAndroidJniLibs(downloaded, releaseVersion)
            unpackAndroidExtensionArchives(extensionDownloaded)
        }

        private fun validateReleaseVersion(releaseVersion: String) {
            require(releaseVersion.matches(Regex("[A-Za-z0-9._-]+"))) {
                "invalid liboliphaunt release version: $releaseVersion"
            }
        }

        private fun androidBaseAsset(
            releaseVersion: String,
            abi: String,
        ): String =
            when (abi) {
                "arm64-v8a" -> "liboliphaunt-$releaseVersion-android-arm64-v8a.tar.gz"

                "x86_64" -> "liboliphaunt-$releaseVersion-android-x86_64.tar.gz"

                else -> throw GradleException(
                    "liboliphaunt release assets are published for arm64-v8a and x86_64; got $abi",
                )
            }

        private fun selectedExtensionRows(
            defaultVersion: String,
            cache: File,
            downloaded: MutableMap<String, File>,
            abis: List<String>,
        ): List<Map<String, String>> {
            if (selectedExtensions.get().isEmpty()) return emptyList()
            val rows = linkedMapOf<String, Map<String, String>>()
            for (extension in selectedExtensions.get()) {
                selectExtension(defaultVersion, cache, downloaded, rows, extension, abis)
            }
            return rows.values.sortedBy { it.getValue("sql_name") }
        }

        private fun selectExtension(
            defaultVersion: String,
            cache: File,
            downloaded: MutableMap<String, File>,
            rows: MutableMap<String, Map<String, String>>,
            sqlName: String,
            abis: List<String>,
        ) {
            if (rows.containsKey(sqlName)) return
            val product = extensionProduct(sqlName)
            val extensionVersion = extensionVersion(sqlName, product, defaultVersion)
            val extensionCache = cache.resolve("$product-$extensionVersion")
            extensionCache.mkdirs()
            val extensionChecksums =
                parseChecksums(
                    downloadExtensionAsset(product, extensionVersion, "$product-$extensionVersion-release-assets.sha256", extensionCache),
                )
            val manifestAsset = "$product-$extensionVersion-manifest.properties"
            val manifestFile = downloadAndVerifyExtension(product, extensionVersion, manifestAsset, extensionCache, extensionChecksums)
            val manifest = Properties()
            manifestFile.inputStream().use(manifest::load)
            validateExtensionManifest(product, extensionVersion, sqlName, manifest)

            manifest
                .getProperty("dependencies")
                ?.split(',')
                ?.map(String::trim)
                ?.filter(String::isNotEmpty)
                ?.forEach { dependency ->
                    selectExtension(defaultVersion, cache, downloaded, rows, dependency, abis)
                }

            val runtimeAssets = linkedSetOf<String>()
            val archiveTargets = sortedSetOf<String>()
            val nativeModuleStem = manifest.getProperty("nativeModuleStem")?.trim().orEmpty()
            for (abi in abis) {
                val target = androidTarget(abi)
                val targetRuntimeAsset = requireExtensionAsset(manifest, product, target, "runtime", sqlName)
                runtimeAssets.add(targetRuntimeAsset)
                downloaded.getOrPut(targetRuntimeAsset) {
                    downloadAndVerifyExtension(product, extensionVersion, targetRuntimeAsset, extensionCache, extensionChecksums)
                }
                if (nativeModuleStem.isNotEmpty()) {
                    val staticArchiveAsset = requireExtensionAsset(manifest, product, target, "android-static-archive", sqlName)
                    downloaded.getOrPut(staticArchiveAsset) {
                        downloadAndVerifyExtension(product, extensionVersion, staticArchiveAsset, extensionCache, extensionChecksums)
                    }
                    archiveTargets.add(abi)
                }
            }
            require(runtimeAssets.isNotEmpty()) {
                "selected extension $sqlName did not resolve an Android runtime artifact"
            }
            validateEquivalentAndroidRuntimeAssets(product, extensionVersion, sqlName, runtimeAssets, extensionChecksums)
            rows[sqlName] =
                mapOf(
                    "sql_name" to sqlName,
                    "runtime_artifact" to runtimeAssets.first(),
                    "native_module_stem" to emptyToDash(manifest.getProperty("nativeModuleStem")),
                    "shared_preload" to emptyToDash(manifest.getProperty("sharedPreloadLibraries")),
                    "dependencies" to emptyToDash(manifest.getProperty("dependencies")),
                    "archive_targets" to if (archiveTargets.isEmpty()) "-" else archiveTargets.joinToString(","),
                )
        }

        private fun validateEquivalentAndroidRuntimeAssets(
            product: String,
            version: String,
            sqlName: String,
            runtimeAssets: Set<String>,
            checksums: Map<String, String>,
        ) {
            if (runtimeAssets.size <= 1) return
            var expectedChecksum: String? = null
            var expectedAsset: String? = null
            for (asset in runtimeAssets) {
                val checksum =
                    checksums[asset]
                        ?: throw GradleException("$product $version checksum manifest does not cover $asset")
                if (expectedChecksum == null) {
                    expectedChecksum = checksum
                    expectedAsset = asset
                } else if (expectedChecksum != checksum) {
                    throw GradleException(
                        "$product $version publishes different Android runtime artifacts for $sqlName: " +
                            "$expectedAsset and $asset. Android extension runtime payloads must be ABI-independent; " +
                            "put ABI-specific code in static archives.",
                    )
                }
            }
        }

        private fun extensionProduct(sqlName: String): String {
            require(sqlName.matches(Regex("[A-Za-z0-9._-]{1,128}"))) {
                "invalid Oliphaunt extension SQL name: $sqlName"
            }
            return "oliphaunt-extension-${sqlName.replace('_', '-')}"
        }

        private fun extensionVersion(
            sqlName: String,
            product: String,
            defaultVersion: String,
        ): String {
            val value = extensionVersions.get()[sqlName] ?: extensionVersions.get()[product] ?: defaultVersion
            validateReleaseVersion(value)
            return value
        }

        private fun androidTarget(abi: String): String =
            when (abi) {
                "arm64-v8a" -> "android-arm64-v8a"
                "x86_64" -> "android-x86_64"
                else -> throw GradleException("unsupported liboliphaunt Android ABI $abi")
            }

        private fun validateExtensionManifest(
            product: String,
            version: String,
            sqlName: String,
            manifest: Properties,
        ) {
            require(manifest.getProperty("schema") == "oliphaunt-extension-release-manifest-v1") {
                "$product $version extension manifest has unsupported schema"
            }
            require(manifest.getProperty("product") == product) {
                "$product $version extension manifest declares product ${manifest.getProperty("product")}"
            }
            require(manifest.getProperty("version") == version) {
                "$product $version extension manifest declares version ${manifest.getProperty("version")}"
            }
            require(manifest.getProperty("sqlName") == sqlName) {
                "$product $version extension manifest declares sqlName ${manifest.getProperty("sqlName")}"
            }
            require(manifest.getProperty("mobileReleaseReady") == "true") {
                "$sqlName is not marked mobileReleaseReady in $product $version"
            }
        }

        private fun requireExtensionAsset(
            manifest: Properties,
            product: String,
            target: String,
            kind: String,
            sqlName: String,
        ): String =
            manifest.getProperty("asset.native.$target.$kind")?.takeIf(String::isNotBlank)
                ?: throw GradleException("$product manifest has no $kind asset for $sqlName target $target")

        private fun mergeExtensionRuntimeArtifacts(
            downloaded: Map<String, File>,
            selectedRows: List<Map<String, String>>,
        ) {
            if (selectedRows.isEmpty()) return
            val root = runtimeResourcesRoot(runtimeResourcesDir.get().asFile)
            val runtimePackage = root.resolve("runtime")
            val runtimeFiles = runtimePackage.resolve("files")
            require(runtimeFiles.isDirectory) {
                "liboliphaunt runtime resources did not contain oliphaunt/runtime/files"
            }
            val extractedArtifacts =
                selectedRows.map { row ->
                    val sqlName = row.getValue("sql_name")
                    val artifact = downloaded.getValue(row.getValue("runtime_artifact"))
                    val artifactRoot = extractExtensionRuntimeArtifact(sqlName, artifact)
                    copyTree(artifactRoot.resolve("files").toPath(), runtimeFiles.toPath())
                    ExtensionRuntimeArtifact(
                        sqlName = sqlName,
                        nativeModuleStem = row["native_module_stem"]?.takeIf { it != "-" },
                        sharedPreload = row["shared_preload"]?.takeIf { it != "-" },
                    )
                }

            val nativeArtifacts = extractedArtifacts.filter { it.nativeModuleStem != null }
            val nativeModuleStems = nativeArtifacts.mapNotNull { it.nativeModuleStem }.toSortedSet().toList()
            val registeredExtensions = nativeArtifacts.map { it.sqlName }.toSortedSet().toList()
            val sharedPreloadLibraries =
                extractedArtifacts
                    .mapNotNull { it.sharedPreload }
                    .flatMap { it.split(',') }
                    .map(String::trim)
                    .filter(String::isNotEmpty)
                    .toSortedSet()
                    .toList()

            val staticRegistrySource =
                if (nativeArtifacts.isEmpty()) {
                    ""
                } else {
                    val staticRegistryDir = root.resolve("static-registry")
                    staticRegistryDir.mkdirs()
                    val source = staticRegistryDir.resolve("oliphaunt_static_registry.c")
                    source.writeText(staticRegistrySourceText(runtimeFiles, nativeArtifacts), Charsets.UTF_8)
                    writeStaticRegistryManifest(staticRegistryDir, nativeArtifacts)
                    "static-registry/oliphaunt_static_registry.c"
                }

            updateRuntimeManifest(
                runtimePackage.resolve("manifest.properties"),
                selectedRows.map { it.getValue("sql_name") }.toSortedSet().toList(),
                sharedPreloadLibraries,
                nativeModuleStems,
                registeredExtensions,
                staticRegistrySource,
            )
        }

        private data class ExtensionRuntimeArtifact(
            val sqlName: String,
            val nativeModuleStem: String?,
            val sharedPreload: String?,
        )

        private fun extractExtensionRuntimeArtifact(
            sqlName: String,
            artifact: File,
        ): File {
            require(artifact.name.endsWith(".tar.gz") || artifact.name.endsWith(".tgz")) {
                "liboliphaunt release runtime artifact for $sqlName must be a Gradle-native .tar.gz archive, got ${artifact.name}"
            }
            val extractRoot = temporaryDir.resolve("runtime-artifact-$sqlName-${artifact.nameWithoutExtension}")
            fileSystemOperations.delete { delete(extractRoot) }
            fileSystemOperations.copy {
                from(archiveOperations.tarTree(archiveOperations.gzip(artifact)))
                into(extractRoot)
            }
            val artifactRoot =
                when {
                    extractRoot.resolve("manifest.properties").isFile -> {
                        extractRoot
                    }

                    else -> {
                        extractRoot
                            .listFiles()
                            ?.filter { it.isDirectory && it.resolve("manifest.properties").isFile }
                            ?.singleOrNull()
                            ?: throw GradleException(
                                "liboliphaunt extension runtime artifact ${artifact.name} did not contain one manifest.properties root",
                            )
                    }
                }
            val manifest = Properties()
            artifactRoot.resolve("manifest.properties").inputStream().use(manifest::load)
            require(manifest.getProperty("packageLayout") == "oliphaunt-extension-artifact-v1") {
                "liboliphaunt extension runtime artifact ${artifact.name} has unsupported packageLayout"
            }
            require(manifest.getProperty("sqlName") == sqlName) {
                "liboliphaunt extension runtime artifact ${artifact.name} is for ${manifest.getProperty("sqlName")}, expected $sqlName"
            }
            require(artifactRoot.resolve("files").isDirectory) {
                "liboliphaunt extension runtime artifact ${artifact.name} is missing files/"
            }
            return artifactRoot
        }

        private fun updateRuntimeManifest(
            manifestFile: File,
            selectedExtensions: List<String>,
            sharedPreloadLibraries: List<String>,
            nativeModuleStems: List<String>,
            registeredExtensions: List<String>,
            staticRegistrySource: String,
        ) {
            val properties = Properties()
            if (manifestFile.isFile) {
                manifestFile.inputStream().use(properties::load)
            }
            properties.setProperty("schema", "oliphaunt-runtime-resources-v1")
            properties.setProperty("extensions", selectedExtensions.joinToString(","))
            properties.setProperty("sharedPreloadLibraries", sharedPreloadLibraries.joinToString(","))
            properties.setProperty(
                "mobileStaticRegistryState",
                if (nativeModuleStems.isEmpty()) "not-required" else "complete",
            )
            properties.setProperty("mobileStaticRegistryRegistered", registeredExtensions.joinToString(","))
            properties.setProperty("mobileStaticRegistryPending", "")
            properties.setProperty("nativeModuleStems", nativeModuleStems.joinToString(","))
            properties.setProperty("mobileStaticRegistrySource", staticRegistrySource)
            writeOrderedProperties(manifestFile, properties)
        }

        private fun writeStaticRegistryManifest(
            staticRegistryDir: File,
            artifacts: List<ExtensionRuntimeArtifact>,
        ) {
            val modules = artifacts.mapNotNull { it.nativeModuleStem }.toSortedSet().toList()
            val lines =
                mutableListOf(
                    "packageLayout=oliphaunt-static-registry-v1",
                    "abiVersion=1",
                    "state=complete",
                    "source=oliphaunt_static_registry.c",
                    "registeredExtensions=${artifacts.map { it.sqlName }.toSortedSet().joinToString(",")}",
                    "pendingExtensions=",
                    "nativeModuleStems=${modules.joinToString(",")}",
                    "modules=${modules.joinToString(",")}",
                    "archiveTargets=arm64-v8a,x86_64",
                )
            for (artifact in artifacts.sortedBy { it.nativeModuleStem }) {
                val stem = artifact.nativeModuleStem ?: continue
                lines += "module.$stem.extension=${artifact.sqlName}"
                lines += "module.$stem.symbolPrefix=${staticRegistrySymbolPrefix(stem)}"
                lines += "module.$stem.sqlSymbols="
                lines += "module.$stem.archiveTargets=arm64-v8a,x86_64"
                lines += "module.$stem.archive.arm64-v8a=archives/arm64-v8a/extensions/$stem/liboliphaunt_extension_$stem.a"
                lines += "module.$stem.archive.x86_64=archives/x86_64/extensions/$stem/liboliphaunt_extension_$stem.a"
            }
            staticRegistryDir.resolve("manifest.properties").writeText(lines.joinToString("\n", postfix = "\n"))
        }

        private fun writeOrderedProperties(
            file: File,
            properties: Properties,
        ) {
            file.parentFile.mkdirs()
            val preferred =
                listOf(
                    "schema",
                    "cacheKey",
                    "layout",
                    "source",
                    "extensions",
                    "sharedPreloadLibraries",
                    "mobileStaticRegistryState",
                    "mobileStaticRegistryRegistered",
                    "mobileStaticRegistryPending",
                    "nativeModuleStems",
                    "mobileStaticRegistrySource",
                )
            val keys = (preferred + properties.stringPropertyNames().sorted()).distinct()
            file.writeText(
                keys
                    .filter { properties.getProperty(it) != null }
                    .joinToString("\n", postfix = "\n") { key -> "$key=${properties.getProperty(key)}" },
                Charsets.UTF_8,
            )
        }

        private fun staticRegistrySourceText(
            runtimeFiles: File,
            artifacts: List<ExtensionRuntimeArtifact>,
        ): String {
            val modules =
                artifacts
                    .mapNotNull { artifact ->
                        val stem = artifact.nativeModuleStem ?: return@mapNotNull null
                        StaticRegistryModule(
                            extensionSqlName = artifact.sqlName,
                            moduleStem = stem,
                            symbolPrefix = staticRegistrySymbolPrefix(stem),
                            sqlSymbols = collectExtensionSqlSymbols(runtimeFiles, artifact.sqlName),
                        )
                    }.sortedBy { it.moduleStem }
            return buildString {
                append("/* Generated by Oliphaunt Android Gradle plugin. Do not edit by hand. */\n")
                append("#include <stddef.h>\n#include <stdint.h>\n#include \"oliphaunt.h\"\n\n")
                append("#if defined(__GNUC__) || defined(__clang__)\n")
                append("#define OLIPHAUNT_STATIC_OPTIONAL __attribute__((weak))\n")
                append("#else\n#define OLIPHAUNT_STATIC_OPTIONAL\n#endif\n\n")
                for (module in modules) {
                    append("extern const void *${module.symbolPrefix}_Pg_magic_func(void);\n")
                    append("extern void ${module.symbolPrefix}__PG_init(void) OLIPHAUNT_STATIC_OPTIONAL;\n")
                    for (symbol in module.sqlSymbols) {
                        append("extern void $symbol(void);\n")
                        append("extern void pg_finfo_$symbol(void);\n")
                    }
                    append('\n')
                }
                for (module in modules) {
                    append("static const OliphauntStaticExtensionSymbol ${module.symbolPrefix}_symbols[] = {\n")
                    for (symbol in module.sqlSymbols) {
                        append("    { .name = ${cStringLiteral(symbol)}, .address = (void *)$symbol },\n")
                        append(
                            "    { .name = ${cStringLiteral("pg_finfo_$symbol")}, .address = (void *)pg_finfo_$symbol },\n",
                        )
                    }
                    append("};\n\n")
                }
                append("static const OliphauntStaticExtension liboliphaunt_static_extensions[] = {\n")
                for (module in modules) {
                    append("    {\n")
                    append("        .abi_version = OLIPHAUNT_STATIC_EXTENSION_ABI_VERSION,\n")
                    append("        .name = ${cStringLiteral(module.moduleStem)},\n")
                    append("        .magic = ${module.symbolPrefix}_Pg_magic_func,\n")
                    append("        .init = ${module.symbolPrefix}__PG_init,\n")
                    append("        .symbols = ${module.symbolPrefix}_symbols,\n")
                    append(
                        "        .symbol_count = sizeof(${module.symbolPrefix}_symbols) / sizeof(${module.symbolPrefix}_symbols[0]),\n",
                    )
                    append("        .reserved_flags = 0,\n")
                    append("    },\n")
                }
                append("};\n\n")
                append("const OliphauntStaticExtension *liboliphaunt_selected_static_extensions(size_t *count) {\n")
                append("    if (count != NULL) {\n")
                append("        *count = sizeof(liboliphaunt_static_extensions) / sizeof(liboliphaunt_static_extensions[0]);\n")
                append("    }\n")
                append("    return liboliphaunt_static_extensions;\n")
                append("}\n")
            }
        }

        private data class StaticRegistryModule(
            val extensionSqlName: String,
            val moduleStem: String,
            val symbolPrefix: String,
            val sqlSymbols: List<String>,
        )

        private fun collectExtensionSqlSymbols(
            runtimeFiles: File,
            sqlName: String,
        ): List<String> {
            val extensionDir = runtimeFiles.resolve("share/postgresql/extension")
            val prefix = "$sqlName--"
            val sqlFiles =
                extensionDir
                    .listFiles()
                    ?.filter { it.isFile && it.name.startsWith(prefix) && it.name.endsWith(".sql") }
                    ?.sortedBy(File::getName)
                    ?: emptyList()
            require(sqlFiles.isNotEmpty()) {
                "selected extension $sqlName has no packaged SQL files in ${extensionDir.absolutePath}"
            }
            return sqlFiles
                .flatMap { file -> modulePathnameCSymbols(file.readText(Charsets.UTF_8)) }
                .toSortedSet()
                .toList()
        }

        private fun modulePathnameCSymbols(sql: String): List<String> =
            splitSqlStatements(stripSqlLineComments(sql))
                .filter { statement ->
                    statement.contains("module_pathname", ignoreCase = true) && hasLanguageC(statement)
                }.mapNotNull { statement ->
                    explicitModulePathnameSymbol(statement) ?: implicitFunctionSymbol(statement)
                }.onEach { symbol ->
                    require(symbol.matches(Regex("[A-Za-z_][A-Za-z0-9_]*"))) {
                        "extension SQL references non-portable C symbol '$symbol'"
                    }
                }.toSortedSet()
                .toList()

        private fun stripSqlLineComments(sql: String): String {
            val out = StringBuilder(sql.length)
            var index = 0
            var inString = false
            while (index < sql.length) {
                val ch = sql[index]
                if (ch == '\'') {
                    out.append(ch)
                    if (inString && index + 1 < sql.length && sql[index + 1] == '\'') {
                        index += 1
                        out.append(sql[index])
                    } else {
                        inString = !inString
                    }
                } else if (!inString && ch == '-' && index + 1 < sql.length && sql[index + 1] == '-') {
                    index += 2
                    while (index < sql.length && sql[index] != '\n') {
                        index += 1
                    }
                    if (index < sql.length) out.append('\n')
                } else {
                    out.append(ch)
                }
                index += 1
            }
            return out.toString()
        }

        private fun splitSqlStatements(sql: String): List<String> {
            val statements = mutableListOf<String>()
            var start = 0
            var index = 0
            var inString = false
            while (index < sql.length) {
                val ch = sql[index]
                if (ch == '\'') {
                    if (inString && index + 1 < sql.length && sql[index + 1] == '\'') {
                        index += 1
                    } else {
                        inString = !inString
                    }
                } else if (!inString && ch == ';') {
                    statements += sql.substring(start, index).trim()
                    start = index + 1
                }
                index += 1
            }
            if (start < sql.length) statements += sql.substring(start).trim()
            return statements.filter(String::isNotEmpty)
        }

        private fun explicitModulePathnameSymbol(statement: String): String? {
            val moduleIndex = statement.indexOf("module_pathname", ignoreCase = true)
            if (moduleIndex < 0) return null
            var rest = statement.substring(moduleIndex + "module_pathname".length).trimStart()
            if (rest.startsWith('\'')) {
                rest = rest.drop(1).trimStart()
            }
            if (!rest.startsWith(',')) return null
            return parseSqlSingleQuotedLiteral(rest.drop(1).trimStart())?.first
        }

        private fun implicitFunctionSymbol(statement: String): String? {
            val functionIndex = statement.indexOf("function", ignoreCase = true)
            if (functionIndex < 0) return null
            val afterFunction = statement.substring(functionIndex + "function".length)
            val nameEnd = afterFunction.indexOf('(')
            if (nameEnd < 0) return null
            return lastSqlIdentifier(afterFunction.substring(0, nameEnd).trim())?.takeIf(String::isNotEmpty)
        }

        private fun parseSqlSingleQuotedLiteral(value: String): Pair<String, String>? {
            if (!value.startsWith('\'')) return null
            val out = StringBuilder()
            var index = 1
            while (index < value.length) {
                val ch = value[index]
                if (ch == '\'') {
                    if (index + 1 < value.length && value[index + 1] == '\'') {
                        out.append('\'')
                        index += 2
                        continue
                    }
                    return out.toString() to value.substring(index + 1)
                }
                out.append(ch)
                index += 1
            }
            return null
        }

        private fun lastSqlIdentifier(rawName: String): String? {
            val parts = mutableListOf<String>()
            var start = 0
            var index = 0
            var inQuotes = false
            while (index < rawName.length) {
                val ch = rawName[index]
                if (ch == '"') {
                    if (inQuotes && index + 1 < rawName.length && rawName[index + 1] == '"') {
                        index += 1
                    } else {
                        inQuotes = !inQuotes
                    }
                } else if (!inQuotes && ch == '.') {
                    parts += rawName.substring(start, index).trim()
                    start = index + 1
                }
                index += 1
            }
            parts += rawName.substring(start).trim()
            val part = parts.lastOrNull()?.trim() ?: return null
            return if (part.startsWith('"') && part.endsWith('"') && part.length >= 2) {
                part.substring(1, part.length - 1).replace("\"\"", "\"")
            } else {
                part
            }
        }

        private fun hasLanguageC(statement: String): Boolean {
            val tokens =
                statement
                    .split(Regex("[^A-Za-z0-9_]+"))
                    .filter(String::isNotEmpty)
                    .map { it.lowercase() }
            return tokens.windowed(2).any { it[0] == "language" && it[1] == "c" }
        }

        private fun staticRegistrySymbolPrefix(moduleStem: String): String =
            buildString {
                append("oliphaunt_static_")
                for (ch in moduleStem) {
                    append(if (ch.isLetterOrDigit() || ch == '_') ch else '_')
                }
            }

        private fun cStringLiteral(value: String): String =
            buildString {
                append('"')
                for (ch in value) {
                    when (ch) {
                        '\\' -> append("\\\\")
                        '"' -> append("\\\"")
                        '\n' -> append("\\n")
                        '\r' -> append("\\r")
                        '\t' -> append("\\t")
                        else -> append(ch)
                    }
                }
                append('"')
            }

        private fun emptyToDash(value: String?): String = value?.takeIf(String::isNotBlank) ?: "-"

        private fun downloadAndVerify(
            asset: String,
            cache: File,
            checksums: Map<String, String>,
        ): File {
            val file = downloadAsset(asset, cache)
            val expected =
                checksums[asset]
                    ?: throw GradleException("liboliphaunt release checksum manifest does not cover $asset")
            val actual = sha256(file)
            if (actual != expected) {
                throw GradleException(
                    "liboliphaunt release asset checksum mismatch for $asset: expected $expected, got $actual",
                )
            }
            return file
        }

        private fun downloadAsset(
            asset: String,
            cache: File,
        ): File {
            require(!asset.contains('/') && !asset.contains('\\')) {
                "release asset name must be a plain file name: $asset"
            }
            val output = cache.resolve(asset)
            if (output.isFile) return output
            val tmp = cache.resolve(".$asset.tmp")
            val url = "${assetBaseUrl.get().trimEnd('/')}/$asset"
            URI(url).toURL().openStream().use { input ->
                tmp.outputStream().use { outputStream ->
                    input.copyTo(outputStream)
                }
            }
            Files.move(tmp.toPath(), output.toPath(), StandardCopyOption.REPLACE_EXISTING)
            return output
        }

        private fun downloadAndVerifyExtension(
            product: String,
            version: String,
            asset: String,
            cache: File,
            checksums: Map<String, String>,
        ): File {
            val file = downloadExtensionAsset(product, version, asset, cache)
            val expected =
                checksums[asset]
                    ?: throw GradleException("$product $version checksum manifest does not cover $asset")
            val actual = sha256(file)
            if (actual != expected) {
                throw GradleException(
                    "$product $version asset checksum mismatch for $asset: expected $expected, got $actual",
                )
            }
            return file
        }

        private fun downloadExtensionAsset(
            product: String,
            version: String,
            asset: String,
            cache: File,
        ): File {
            require(!asset.contains('/') && !asset.contains('\\')) {
                "extension release asset name must be a plain file name: $asset"
            }
            val output = cache.resolve(asset)
            if (output.isFile) return output
            val tmp = cache.resolve(".$asset.tmp")
            val url = "https://github.com/f0rr0/oliphaunt/releases/download/$product-v$version/$asset"
            URI(url).toURL().openStream().use { input ->
                tmp.outputStream().use { outputStream ->
                    input.copyTo(outputStream)
                }
            }
            Files.move(tmp.toPath(), output.toPath(), StandardCopyOption.REPLACE_EXISTING)
            return output
        }

        private fun parseChecksums(file: File): Map<String, String> =
            file
                .readLines()
                .filter(String::isNotBlank)
                .associate { line ->
                    val parts = line.trim().split(Regex("\\s+"))
                    require(parts.size == 2 && parts[1].startsWith("./")) {
                        "malformed liboliphaunt checksum line in ${file.absolutePath}: $line"
                    }
                    parts[1].removePrefix("./") to parts[0]
                }

        private fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }

        private fun unpackRuntimeResources(archive: File) {
            val output = runtimeResourcesDir.get().asFile
            fileSystemOperations.delete { delete(output) }
            fileSystemOperations.copy {
                from(archiveOperations.tarTree(archiveOperations.gzip(archive)))
                into(output)
            }
        }

        private fun unpackAndroidJniLibs(
            downloaded: Map<String, File>,
            releaseVersion: String,
        ) {
            val output = jniLibsDir.get().asFile
            fileSystemOperations.delete { delete(output) }
            for (abi in selectedAbis.get().ifEmpty { listOf("arm64-v8a", "x86_64") }) {
                val asset = androidBaseAsset(releaseVersion, abi)
                val extractRoot = temporaryDir.resolve("jni-$abi")
                fileSystemOperations.delete { delete(extractRoot) }
                fileSystemOperations.copy {
                    from(archiveOperations.tarTree(archiveOperations.gzip(downloaded.getValue(asset))))
                    into(extractRoot)
                }
                val source = extractRoot.resolve("jni/$abi")
                require(source.isDirectory) {
                    "liboliphaunt Android asset $asset did not contain jni/$abi"
                }
                fileSystemOperations.copy {
                    from(source)
                    into(output.resolve(abi))
                }
            }
        }

        private fun unpackAndroidExtensionArchives(downloaded: Map<String, File>) {
            val output = extensionArchivesDir.get().asFile
            fileSystemOperations.delete { delete(output) }
            for ((asset, archive) in downloaded) {
                val abi =
                    when {
                        asset.contains("-native-android-arm64-v8a-static.") -> "arm64-v8a"
                        asset.contains("-native-android-x86_64-static.") -> "x86_64"
                        else -> continue
                    }
                val extractRoot = temporaryDir.resolve("extension-$abi-${archive.nameWithoutExtension}")
                fileSystemOperations.delete { delete(extractRoot) }
                fileSystemOperations.copy {
                    from(archiveOperations.tarTree(archiveOperations.gzip(archive)))
                    into(extractRoot)
                }
                val source = extractRoot.resolve("extensions")
                require(source.isDirectory) {
                    "liboliphaunt Android extension asset $asset did not contain extensions/"
                }
                fileSystemOperations.copy {
                    from(source)
                    into(output.resolve("$abi/extensions"))
                }
            }
        }

        private fun runtimeResourcesRoot(root: File): File {
            val nested = root.resolve("oliphaunt")
            return when {
                nested.isDirectory -> nested
                root.resolve("runtime").isDirectory -> root
                else -> nested
            }
        }

        private fun copyTree(
            source: Path,
            target: Path,
        ) {
            Files.walk(source).use { stream ->
                stream.sorted().forEach { path ->
                    require(!Files.isSymbolicLink(path)) {
                        "Oliphaunt Android release assets do not support symlinks: $path"
                    }
                    val relative = source.relativize(path)
                    val destination = target.resolve(relative)
                    when {
                        Files.isDirectory(path) -> {
                            Files.createDirectories(destination)
                        }

                        Files.isRegularFile(path) -> {
                            Files.createDirectories(destination.parent)
                            Files.copy(path, destination, StandardCopyOption.REPLACE_EXISTING)
                        }
                    }
                }
            }
        }
    }

fun parseExtensions(raw: String?): List<String> = parsePortableList(raw, "extension name")

fun parseVersionMap(raw: String?): Map<String, String> {
    if (raw.isNullOrBlank()) return emptyMap()
    return raw
        .split(',')
        .map(String::trim)
        .filter(String::isNotEmpty)
        .associate { value ->
            val parts = value.split('=', limit = 2)
            require(parts.size == 2 && parts[0].isNotBlank() && parts[1].isNotBlank()) {
                "oliphauntExtensionVersions entries must use extension=version, got $value"
            }
            parts[0].trim() to parts[1].trim()
        }
}

fun parsePortableList(
    raw: String?,
    label: String,
): List<String> {
    if (raw.isNullOrBlank()) return emptyList()
    val portableId = Regex("[A-Za-z0-9._-]{1,128}")
    return raw
        .split(',')
        .map(String::trim)
        .filter(String::isNotEmpty)
        .toSortedSet()
        .onEach { value ->
            require(portableId.matches(value)) {
                "liboliphaunt $label '$value' must contain only ASCII letters, digits, '.', '_' or '-'"
            }
        }.toList()
}

val packagedExtensions = parseExtensions(packagedExtensionsRaw)
val packagedExtensionVersions = parseVersionMap(explicitPackagedExtensionVersionsRaw)
val packagedMobileStaticModules =
    parsePortableList(
        packagedMobileStaticModulesRaw,
        "mobile static module stem",
    )
val androidAbiFilters = parseAndroidAbiFilters(explicitAndroidAbiFiltersRaw)
val releaseAssetAbis =
    androidAbiFilters.ifEmpty {
        listOf("arm64-v8a", "x86_64")
    }

fun parseAndroidAbiFilters(raw: String?): List<String> {
    if (raw.isNullOrBlank() || raw.trim().equals("all", ignoreCase = true)) {
        return emptyList()
    }
    val supported = setOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
    return raw
        .split(',')
        .map(String::trim)
        .filter(String::isNotEmpty)
        .distinct()
        .onEach { value ->
            require(value in supported) {
                "Oliphaunt Android ABI filter '$value' is not supported; expected one of ${
                    supported.joinToString(", ")
                }"
            }
        }
}

val resolveOliphauntAndroidReleaseAssets by tasks.registering(ResolveOliphauntAndroidReleaseAssetsTask::class) {
    onlyIf {
        liboliphauntReleaseVersion.isPresent
    }
    version.set(liboliphauntReleaseVersion)
    assetBaseUrl.set(liboliphauntReleaseAssetBaseUrl)
    selectedAbis.set(releaseAssetAbis)
    selectedExtensions.set(packagedExtensions)
    extensionVersions.set(packagedExtensionVersions)
    assetCacheDir.set(layout.buildDirectory.dir("oliphaunt/release-asset-cache"))
    runtimeResourcesDir.set(resolvedReleaseRuntimeResourcesDir)
    jniLibsDir.set(resolvedReleaseAndroidJniLibsDir)
    extensionArchivesDir.set(resolvedReleaseAndroidExtensionArchivesDir)
}

val prepareOliphauntAndroidAssets by tasks.registering(PrepareOliphauntAndroidAssetsTask::class) {
    if (liboliphauntReleaseVersion.isPresent) {
        dependsOn(resolveOliphauntAndroidReleaseAssets)
    }
    runtimeResourcesDirPath.set(packagedRuntimeResourcesDir ?: "")
    runtimeDirPath.set(packagedRuntimeDir ?: "")
    templatePgdataDirPath.set(packagedTemplatePgdataDir ?: "")
    selectedExtensions.set(packagedExtensions)
    mobileStaticModuleStems.set(packagedMobileStaticModules)
    generatedExtensionMetadata.from(layout.projectDirectory.file("src/generated/extensions.json"))
    listOfNotNull(packagedRuntimeResourcesDir, packagedRuntimeDir, packagedTemplatePgdataDir)
        .filter(String::isNotBlank)
        .forEach { sourceDirectories.from(file(it)) }
    outputDir.set(generatedAndroidAssetsDir)
}

val prepareOliphauntAndroidJniLibs by tasks.registering(PrepareOliphauntAndroidJniLibsTask::class) {
    if (liboliphauntReleaseVersion.isPresent) {
        dependsOn(resolveOliphauntAndroidReleaseAssets)
    }
    jniLibsDirPath.set(packagedAndroidJniLibsDir ?: "")
    packagedAndroidJniLibsDir?.takeIf(String::isNotBlank)?.let { sourceDirectories.from(file(it)) }
    outputDir.set(generatedAndroidJniLibsDir)
}

val buildNativeBridge by tasks.registering(Exec::class) {
    inputs.files(
        bridgeSource,
        bridgeHeader,
        layout.projectDirectory.file("../../../runtimes/liboliphaunt/native/include/oliphaunt.h"),
    )
    outputs.file(bridgeArchive)
    commandLine(
        "sh",
        "-c",
        """
        set -eu
        mkdir -p "${bridgeOutputDir.get().asFile.absolutePath}"
        cc -std=c11 -fPIC -I"${project.layout.projectDirectory.dir(
            "src/nativeInterop/cinterop",
        ).asFile.absolutePath}" -I"${project.layout.projectDirectory.dir(
            "../../../runtimes/liboliphaunt/native/include",
        ).asFile.absolutePath}" -c "${bridgeSource.asFile.absolutePath}" -o "${bridgeOutputDir.get().file(
            "oliphaunt_kotlin_bridge.o",
        ).asFile.absolutePath}"
        ar rcs "${bridgeArchive.get().asFile.absolutePath}" "${bridgeOutputDir.get().file("oliphaunt_kotlin_bridge.o").asFile.absolutePath}"
        """.trimIndent(),
    )
}

val oliphauntJvmToolchainVersion =
    providers
        .gradleProperty("oliphauntJvmToolchain")
        .orElse("17")
        .map(String::toInt)

kotlin {
    jvmToolchain(oliphauntJvmToolchainVersion.get())

    androidTarget()
    jvm()
    when {
        System.getProperty("os.name").startsWith("Mac") -> macosArm64()
        System.getProperty("os.arch") == "aarch64" -> linuxArm64()
        else -> linuxX64()
    }

    targets.withType<KotlinNativeTarget>().configureEach {
        compilations["main"].cinterops.create("oliphaunt") {
            definitionFile.set(project.file("src/nativeInterop/cinterop/oliphaunt.def"))
            includeDirs(project.layout.projectDirectory.dir("../../../runtimes/liboliphaunt/native/include"))
            includeDirs(project.layout.projectDirectory.dir("src/nativeInterop/cinterop"))
            extraOpts(
                "-libraryPath",
                bridgeOutputDir.get().asFile.absolutePath,
                "-staticLibrary",
                bridgeArchive.get().asFile.name,
            )
        }
    }

    sourceSets {
        val nativeMain by creating {
            dependsOn(commonMain.get())
        }
        val nativeTest by creating {
            dependsOn(commonTest.get())
        }
        targets.withType<KotlinNativeTarget>().configureEach {
            compilations["main"].defaultSourceSet.dependsOn(nativeMain)
            compilations["test"].defaultSourceSet.dependsOn(nativeTest)
        }

        commonMain.dependencies {
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
            implementation(libs.kotlinx.serialization.json)
        }
    }
}

tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach {
    systemProperty(
        "oliphaunt.sharedFixturesDir",
        rootProject.layout.projectDirectory
            .dir("../../shared/fixtures")
            .asFile.absolutePath,
    )
}

tasks
    .matching {
        it.name.startsWith("cinteropOliphaunt") || it.name.startsWith("cinteropLiboliphaunt")
    }.configureEach {
        dependsOn(buildNativeBridge)
    }

android {
    namespace = "dev.oliphaunt"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        if (androidAbiFilters.isNotEmpty()) {
            ndk {
                abiFilters.addAll(androidAbiFilters)
            }
        }
        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++17"
                if (packagedMobileStaticModules.isNotEmpty()) {
                    arguments += "-DOLIPHAUNT_MOBILE_STATIC_MODULES=${packagedMobileStaticModules.joinToString(";")}"
                    packagedStaticRegistrySource?.let { source ->
                        arguments += "-DOLIPHAUNT_STATIC_REGISTRY_SOURCE=$source"
                    }
                    effectiveAndroidExtensionArchivesDir?.let { archiveRoot ->
                        arguments += "-DOLIPHAUNT_EXTENSION_ARCHIVES_ROOT=${file(archiveRoot).absolutePath}"
                    }
                    packagedAndroidJniLibsDir
                        ?.takeIf(String::isNotBlank)
                        ?.let { jniRoot ->
                            arguments += "-DOLIPHAUNT_ANDROID_JNI_LIBS_ROOT=${file(jniRoot).absolutePath}"
                        }
                    packagedAndroidLinkEvidenceFile
                        ?.takeIf(String::isNotBlank)
                        ?.let { evidenceFile ->
                            arguments += "-DOLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE=${file(evidenceFile).absolutePath}"
                        }
                }
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/androidMain/cpp/CMakeLists.txt")
            buildStagingDirectory = cxxBuildRoot
            version = "3.22.1"
        }
    }

    sourceSets["main"].assets.srcDir(generatedAndroidAssetsDir)
    sourceSets["main"].jniLibs.srcDir(generatedAndroidJniLibsDir)
}

tasks.named("preBuild") {
    dependsOn(prepareOliphauntAndroidAssets)
    dependsOn(prepareOliphauntAndroidJniLibs)
}
