import groovy.json.JsonSlurper
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.jetbrains.dokka.gradle.engine.parameters.VisibilityModifier
import org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Properties

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
version = providers.gradleProperty("VERSION_NAME").orElse("0.0.0").get()

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

fun oliphauntProperty(name: String): Any? =
    project.findProperty(name)
        ?: name
            .takeIf { it.startsWith("oliphaunt") }
            ?.let { project.findProperty("O${it.drop(1)}") }

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
val configuredCxxBuildRoot =
    (
        oliphauntProperty("oliphauntCxxBuildRoot")
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
        oliphauntProperty("oliphauntRuntimeResourcesDir")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_RUNTIME_RESOURCES_DIR")
            ?: System.getenv("OLIPHAUNT_ANDROID_RUNTIME_RESOURCES_DIR")
    )?.toString()
val packagedAndroidJniLibsDir =
    (
        oliphauntProperty("oliphauntAndroidJniLibsDir")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_JNI_LIBS_DIR")
    )?.toString()
val packagedAndroidExtensionArchivesDir =
    (
        oliphauntProperty("oliphauntAndroidExtensionArchivesDir")
            ?: oliphauntProperty("oliphauntExtensionArchivesDir")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_EXTENSION_ARCHIVES_DIR")
            ?: System.getenv("OLIPHAUNT_ANDROID_EXTENSION_ARCHIVES_DIR")
    )?.toString()
val packagedAndroidLinkEvidenceFile =
    (
        oliphauntProperty("oliphauntAndroidLinkEvidenceFile")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_LINK_EVIDENCE_FILE")
            ?: System.getenv("OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE")
    )?.toString()
val explicitPackagedRuntimeDir =
    (
        oliphauntProperty("oliphauntRuntimeDir")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_RUNTIME_DIR")
    )?.toString()
val explicitPackagedTemplatePgdataDir =
    (
        oliphauntProperty("oliphauntTemplatePgdataDir")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_TEMPLATE_PGDATA_DIR")
    )?.toString()
val explicitPackagedExtensionsRaw =
    (
        oliphauntProperty("oliphauntExtensions")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_EXTENSIONS")
    )?.toString()
val explicitMobileStaticModulesRaw =
    (
        oliphauntProperty("oliphauntMobileStaticModules")
            ?: oliphauntProperty("oliphauntMobileStaticModuleStems")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_MOBILE_STATIC_MODULES")
            ?: System.getenv("OLIPHAUNT_KOTLIN_ANDROID_MOBILE_STATIC_MODULE_STEMS")
    )?.toString()
val explicitAndroidAbiFiltersRaw =
    (
        oliphauntProperty("oliphauntAndroidAbiFilters")
            ?: oliphauntProperty("oliphauntAndroidAbis")
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
            validateSelectedExtensionFiles(output.resolve("oliphaunt/runtime/files"), selectedExtensions.get())
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
        validateSelectedExtensionFiles(filesDir, extensions)
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
                "runtimeFeatures=",
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

    private fun validateSelectedExtensionFiles(
        filesDir: File,
        extensions: List<String>,
    ) {
        if (extensions.isEmpty()) return
        val extensionDir = filesDir.resolve("share/postgresql/extension")
        for (extension in extensions) {
            val control = extensionDir.resolve("$extension.control")
            require(control.isFile) {
                "Oliphaunt Kotlin Android selected extension '$extension' is missing control file " +
                    control
            }
            val sqlFiles =
                extensionDir.listFiles { file ->
                    file.isFile && file.name.startsWith("$extension--") && file.name.endsWith(".sql")
                } ?: emptyArray()
            require(sqlFiles.isNotEmpty()) {
                "Oliphaunt Kotlin Android selected extension '$extension' has no packaged SQL files in " +
                    extensionDir
            }
        }
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

fun parseExtensions(raw: String?): List<String> = parsePortableList(raw, "extension name")

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
val packagedMobileStaticModules =
    parsePortableList(
        packagedMobileStaticModulesRaw,
        "mobile static module stem",
    )
val androidAbiFilters = parseAndroidAbiFilters(explicitAndroidAbiFiltersRaw)

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

val prepareOliphauntAndroidAssets by tasks.registering(PrepareOliphauntAndroidAssetsTask::class) {
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
