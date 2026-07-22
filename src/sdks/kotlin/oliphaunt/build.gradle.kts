import groovy.json.JsonSlurper
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.publish.maven.tasks.AbstractPublishToMaven
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.api.tasks.bundling.AbstractArchiveTask
import org.jetbrains.dokka.gradle.engine.parameters.VisibilityModifier
import org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Properties

abstract class CheckMavenPublicationContractTask : DefaultTask() {
    @get:Input
    abstract val expectedPublicationName: Property<String>

    @get:Input
    abstract val expectedGroupId: Property<String>

    @get:Input
    abstract val expectedArtifactId: Property<String>

    @get:Input
    abstract val publicationNames: ListProperty<String>

    @get:Input
    abstract val actualGroupId: Property<String>

    @get:Input
    abstract val actualArtifactId: Property<String>

    @get:Input
    abstract val executableUnsupportedTasks: ListProperty<String>

    @TaskAction
    fun checkContract() {
        val expectedPublication = expectedPublicationName.get()
        require(publicationNames.get().contains(expectedPublication)) {
            "Oliphaunt Kotlin must expose the $expectedPublication Maven publication; got ${publicationNames.get()}"
        }
        require(actualGroupId.get() == expectedGroupId.get()) {
            "Android AAR publication group must be ${expectedGroupId.get()}; got ${actualGroupId.get()}"
        }
        require(actualArtifactId.get() == expectedArtifactId.get()) {
            "Android AAR publication artifact must be ${expectedArtifactId.get()}; got ${actualArtifactId.get()}"
        }
        require(executableUnsupportedTasks.get().isEmpty()) {
            "unsupported Kotlin/JVM/host-native publication tasks are enabled: ${executableUnsupportedTasks.get()}"
        }
    }
}

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
                    "dev.oliphaunt.GeneratedExtensionsKt",
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
                name.set("MIT License")
                url.set("https://github.com/f0rr0/oliphaunt/blob/oliphaunt-kotlin-v${project.version}/LICENSE")
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
        ?: layout.projectDirectory
            .dir(".cxx")
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
    explicitPackagedExtensionsRaw
        ?: runtimeResourceManifestValue("runtime", "selectedExtensions")
        ?: runtimeResourceManifestValue("runtime", "extensions")
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
            validateSelectedExtensionFiles(
                sourceRuntimeResourcesRoot,
                output.resolve("oliphaunt/runtime/files"),
                selectedExtensions.get(),
                mobileStaticModuleStems.get(),
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
        validateSelectedExtensionFiles(null, filesDir, extensions, mobileStaticModuleStems)
        val createableExtensions =
            extensions.filter { extension ->
                generatedExtensionMetadataRow(extension)["creates-extension"] as? Boolean
                    ?: throw GradleException(
                        "Oliphaunt Kotlin Android extension '$extension' must declare canonical creates-extension metadata",
                    )
            }
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
                "selectedExtensions=${extensions.joinToString(",")}",
                "extensions=${createableExtensions.joinToString(",")}",
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
        runtimeResourcesRoot: File?,
        filesDir: File,
        extensions: List<String>,
        effectiveMobileStaticModuleStems: List<String>,
    ) {
        if (extensions.isEmpty()) return
        val extensionDir = filesDir.resolve("share/postgresql/extension")
        for (extension in extensions) {
            val metadata = generatedExtensionMetadataRow(extension)
            val createsExtension =
                metadata["creates-extension"] as? Boolean
                    ?: throw GradleException(
                        "Oliphaunt Kotlin Android extension '$extension' must declare canonical creates-extension metadata",
                    )
            if (!createsExtension) {
                val moduleStem =
                    generatedNativeModuleStem(extension)
                        ?.takeIf(String::isNotBlank)
                        ?: throw GradleException(
                            "Oliphaunt Kotlin Android non-CREATE extension '$extension' must declare a native module stem",
                        )
                val module = filesDir.resolve("lib/postgresql/$moduleStem.so")
                if (!module.isFile) {
                    val staticRegistrationError =
                        incompleteMobileStaticRegistration(
                            runtimeResourcesRoot,
                            extension,
                            moduleStem,
                            effectiveMobileStaticModuleStems,
                        )
                    require(staticRegistrationError == null) {
                        "Oliphaunt Kotlin Android selected non-CREATE extension '$extension' is missing native module $module " +
                            "and a complete mobile static registration: $staticRegistrationError"
                    }
                }
                continue
            }
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

    private fun incompleteMobileStaticRegistration(
        runtimeResourcesRoot: File?,
        extension: String,
        moduleStem: String,
        effectiveMobileStaticModuleStems: List<String>,
    ): String? {
        if (runtimeResourcesRoot == null) {
            return "split runtime inputs do not provide a static-registry contract"
        }
        if (moduleStem !in effectiveMobileStaticModuleStems) {
            return "effective mobile static module stems do not include '$moduleStem'"
        }
        val runtimeManifestFile = runtimeResourcesRoot.resolve("runtime/manifest.properties")
        val staticRegistryDir = runtimeResourcesRoot.resolve("static-registry")
        val staticManifestFile = staticRegistryDir.resolve("manifest.properties")
        if (!runtimeManifestFile.isFile) return "runtime/manifest.properties is missing"
        if (!staticManifestFile.isFile) return "static-registry/manifest.properties is missing"

        val runtimeManifest = readProperties(runtimeManifestFile)
        val staticManifest = readProperties(staticManifestFile)
        if (runtimeManifest.getProperty("mobileStaticRegistryState", "") != "complete") {
            return "runtime manifest mobileStaticRegistryState is not complete"
        }
        if (extension !in manifestCsv(runtimeManifest, "mobileStaticRegistryRegistered")) {
            return "runtime manifest does not register extension '$extension'"
        }
        if (extension in manifestCsv(runtimeManifest, "mobileStaticRegistryPending")) {
            return "runtime manifest still marks extension '$extension' as pending"
        }
        if (moduleStem !in manifestCsv(runtimeManifest, "nativeModuleStems")) {
            return "runtime manifest does not declare native module stem '$moduleStem'"
        }
        if (staticManifest.getProperty("packageLayout", "") != "oliphaunt-static-registry-v1") {
            return "static registry has an unsupported packageLayout"
        }
        if (staticManifest.getProperty("abiVersion", "") != "1") {
            return "static registry has an unsupported abiVersion"
        }
        if (staticManifest.getProperty("state", "") != "complete") {
            return "static registry state is not complete"
        }
        if (extension !in manifestCsv(staticManifest, "registeredExtensions")) {
            return "static registry does not register extension '$extension'"
        }
        if (extension in manifestCsv(staticManifest, "pendingExtensions")) {
            return "static registry still marks extension '$extension' as pending"
        }
        if (moduleStem !in manifestCsv(staticManifest, "nativeModuleStems")) {
            return "static registry does not declare native module stem '$moduleStem'"
        }
        if (moduleStem !in manifestCsv(staticManifest, "modules")) {
            return "static registry does not include native module '$moduleStem'"
        }
        val registeredExtension = staticManifest.getProperty("module.$moduleStem.extension", "")
        if (registeredExtension != extension) {
            return "static registry maps native module '$moduleStem' to '${registeredExtension.ifEmpty { "<missing>" }}', " +
                "expected '$extension'"
        }
        val archiveTargets = manifestCsv(staticManifest, "module.$moduleStem.archiveTargets")
        if (archiveTargets.isEmpty()) {
            return "static registry does not declare archive targets for native module '$moduleStem'"
        }
        for (target in archiveTargets) {
            if (staticManifest.getProperty("module.$moduleStem.archive.$target", "").isBlank()) {
                return "static registry does not declare the '$target' archive for native module '$moduleStem'"
            }
        }

        val runtimeSource = runtimeManifest.getProperty("mobileStaticRegistrySource", "")
        val registrySource = staticManifest.getProperty("source", "")
        if (runtimeSource.isBlank() || registrySource.isBlank()) {
            return "static registry source metadata is missing"
        }
        val root = runtimeResourcesRoot.toPath().toAbsolutePath().normalize()
        val staticRegistryRoot = staticRegistryDir.toPath().toAbsolutePath().normalize()
        val runtimeSourcePath = root.resolve(runtimeSource).normalize()
        val registrySourcePath = staticRegistryRoot.resolve(registrySource).normalize()
        if (!runtimeSourcePath.startsWith(root) || !registrySourcePath.startsWith(staticRegistryRoot)) {
            return "static registry source metadata escapes the runtime resources root"
        }
        if (runtimeSourcePath != registrySourcePath) {
            return "runtime and static-registry manifests disagree on the registry source"
        }
        if (!Files.isRegularFile(runtimeSourcePath)) {
            return "declared static registry source is missing: $runtimeSourcePath"
        }
        return null
    }

    private fun readProperties(file: File): Properties = Properties().also { properties -> file.inputStream().use(properties::load) }

    private fun manifestCsv(
        properties: Properties,
        key: String,
    ): Set<String> =
        properties
            .getProperty(key, "")
            .split(',')
            .map(String::trim)
            .filter(String::isNotEmpty)
            .toSortedSet()

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

    androidTarget {
        // The JVM and host-native targets below exist to exercise the shared API
        // during development. Android is the only supported Maven consumer
        // surface, so only its release variant may become a publication.
        publishLibraryVariants("release")
    }
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

val supportedMavenPublication = "androidRelease"
val supportedMavenPublicationTaskToken = "AndroidRelease"
val baseReleaseNoticeFiles =
    files(
        rootProject.file("../../../LICENSE"),
        rootProject.file("../../../THIRD_PARTY_NOTICES.md"),
    )
val publishedArchiveTaskNames =
    setOf(
        "androidReleaseDokkaJavadocJar",
        "androidReleaseSourcesJar",
        "bundleReleaseAar",
    )

tasks.withType<AbstractArchiveTask>().configureEach {
    if (name in publishedArchiveTaskNames) {
        isPreserveFileTimestamps = false
        isReproducibleFileOrder = true
        from(baseReleaseNoticeFiles) {
            into("META-INF")
            filePermissions {
                unix("0644")
            }
        }
    }
}

val publicationTaskName =
    Regex(
        "^(?:publish|sign|generatePomFileFor|generateMetadataFileFor)" +
            "([A-Z][A-Za-z0-9]*)Publication(?:To[A-Z].*)?$",
    )

fun publicationTokenForTask(taskName: String): String? = publicationTaskName.matchEntire(taskName)?.groupValues?.get(1)

// Kotlin Multiplatform creates publications for every compilation target when a
// Maven publishing plugin is present. Those compilations are useful test
// surfaces, but publishing them would advertise runtimes that Oliphaunt does not
// ship. Keep the Android AAR publication and make every unsupported publication
// task non-executable, including when an aggregate Maven Central task is used.
tasks.configureEach {
    val publicationToken = publicationTokenForTask(name)
    if (publicationToken != null && publicationToken != supportedMavenPublicationTaskToken) {
        enabled = false
    }
}

tasks.withType<AbstractPublishToMaven>().configureEach {
    onlyIf("only the Android release AAR is a supported Maven publication") {
        publication.name == supportedMavenPublication
    }
}

// Keep the conventional aggregate entry points useful without pulling the
// compile/documentation graphs of development-only KMP targets into a release.
tasks.named("publishToMavenCentral").configure {
    setDependsOn(listOf("publishAndroidReleasePublicationToMavenCentralRepository"))
}
tasks.named("publishAllPublicationsToMavenCentralRepository").configure {
    setDependsOn(listOf("publishAndroidReleasePublicationToMavenCentralRepository"))
}
tasks.named("publishToMavenLocal").configure {
    setDependsOn(listOf("publishAndroidReleasePublicationToMavenLocal"))
}

val checkMavenPublicationContract =
    tasks.register<CheckMavenPublicationContractTask>("checkMavenPublicationContract") {
        group = "verification"
        description = "Verifies that only the supported Android AAR can be published."
        expectedPublicationName.set(supportedMavenPublication)
        expectedGroupId.set("dev.oliphaunt")
        expectedArtifactId.set("oliphaunt-android")
    }

// Publication objects and publication tasks are finalized by the Android/Kotlin
// publishing plugins late in configuration. Snapshot only plain strings into
// task inputs once configuration is complete so the verification action never
// reaches back into Project or Task state at execution time.
gradle.projectsEvaluated {
    val publications =
        project.extensions
            .getByType<org.gradle.api.publish.PublishingExtension>()
            .publications
    val supportedPublication =
        publications
            .withType<org.gradle.api.publish.maven.MavenPublication>()
            .findByName(supportedMavenPublication)

    val executableUnsupported =
        project.tasks
            .filter { task ->
                val publicationToken = publicationTokenForTask(task.name)
                task.enabled &&
                    publicationToken != null &&
                    publicationToken != supportedMavenPublicationTaskToken
            }.map { it.name }
            .sorted()

    checkMavenPublicationContract.configure {
        publicationNames.set(publications.names.sorted())
        actualGroupId.set(supportedPublication?.groupId ?: "<missing>")
        actualArtifactId.set(supportedPublication?.artifactId ?: "<missing>")
        executableUnsupportedTasks.set(executableUnsupported)
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
