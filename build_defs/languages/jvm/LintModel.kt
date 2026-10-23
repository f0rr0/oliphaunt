package dev.oliphaunt.build

import com.android.ide.common.repository.AgpVersion
import com.android.sdklib.AndroidVersion
import com.android.tools.lint.model.*
import com.google.gson.Gson
import java.io.File

/** Adapt actual Bazel library facts through the pinned official serializer. */
object LintModel {
    data class Library(
        val coordinate: String,
        val jars: List<String>,
        val dependencies: List<String>,
    )

    data class Configuration(
        val root: String,
        val destination: String,
        val agpVersion: String,
        val namespace: String,
        val jvmTarget: String,
        val compileSdk: Int,
        val minSdk: Int,
        val targetSdk: Int,
        val bootClasspath: List<String>,
        val classes: List<String>,
        val manifest: String,
        val mergedManifest: String,
        val sources: List<String>,
        val generatedSources: List<String>,
        val consumerProguard: List<String>,
        val libraries: List<Library>,
        val dependencies: List<String>,
    )

    @JvmStatic
    fun main(arguments: Array<String>) {
        require(arguments.size == 1) { "Lint model requires its declared native facts" }
        val config = Gson().fromJson(File(arguments[0]).readText(), Configuration::class.java)
        require(config.classes.isNotEmpty() && config.sources.isNotEmpty())
        val libraries = config.libraries.associate { library ->
            library.coordinate to DefaultLintModelJavaLibrary(
                identifier = library.coordinate,
                jarFiles = library.jars.map(::File),
                resolvedCoordinates = requireNotNull(LintModelMavenName.parse(library.coordinate)),
                provided = false,
            )
        }
        require(libraries.size == config.libraries.size) { "Duplicate native Maven coordinates" }
        val resolver = DefaultLintModelLibraryResolver(libraries)
        val descriptors = config.libraries.associateBy { it.coordinate }
        val memo = mutableMapOf<String, LintModelDependency>()
        val visiting = mutableSetOf<String>()
        fun dependency(coordinate: String): LintModelDependency {
            memo[coordinate]?.let { return it }
            require(visiting.add(coordinate)) { "Native Maven dependency cycle at $coordinate" }
            val library = requireNotNull(descriptors[coordinate]) { "Missing native Maven library $coordinate" }
            val artifact = requireNotNull(LintModelMavenName.parse(coordinate))
            val result = DefaultLintModelDependency(
                identifier = coordinate,
                artifactName = "${artifact.groupId}:${artifact.artifactId}",
                requestedCoordinates = coordinate,
                dependencies = library.dependencies.map(::dependency),
                libraryResolver = resolver,
            )
            visiting.remove(coordinate)
            return result.also { memo[coordinate] = it }
        }
        val graph = DefaultLintModelDependencyGraph(config.dependencies.map(::dependency), resolver)
        val dependencies = DefaultLintModelDependencies(graph, graph, resolver)
        val variants = mutableListOf<LintModelVariant>()
        val root = File(config.root)
        val module = DefaultLintModelModule(
            loader = LintModelSerialization,
            dir = root,
            modulePath = ":oliphaunt",
            type = LintModelModuleType.LIBRARY,
            mavenName = null,
            agpVersion = requireNotNull(AgpVersion.tryParse(config.agpVersion)),
            buildFolder = root.resolve("build"),
            lintOptions = DefaultLintModelLintOptions(),
            lintRuleJars = emptyList(),
            resourcePrefix = null,
            dynamicFeatures = emptyList(),
            bootClassPath = config.bootClasspath.map(::File),
            javaSourceLevel = config.jvmTarget,
            compileTarget = "android-${config.compileSdk}",
            variants = variants,
            neverShrinking = true,
        )
        variants.add(
            DefaultLintModelVariant(
                module = module,
                name = "debug",
                useSupportLibraryVectorDrawables = false,
                mainArtifactOrNull = DefaultLintModelAndroidArtifact(
                    applicationId = config.namespace,
                    generatedResourceFolders = emptyList(),
                    generatedSourceFolders = config.generatedSources.map(::File),
                    desugaredMethodsFiles = emptyList(),
                    dependencies = dependencies,
                    classOutputs = config.classes.map(::File),
                    type = LintModelArtifactType.MAIN,
                ),
                testArtifact = null,
                androidTestArtifact = null,
                testFixturesArtifact = null,
                mergedManifest = File(config.mergedManifest),
                manifestMergeReport = null,
                `package` = config.namespace,
                minSdkVersion = AndroidVersion(config.minSdk),
                targetSdkVersion = AndroidVersion(config.targetSdk),
                resValues = emptyMap(),
                manifestPlaceholders = emptyMap(),
                resourceConfigurations = emptyList(),
                proguardFiles = emptyList(),
                consumerProguardFiles = config.consumerProguard.map(::File),
                sourceProviders = listOf(
                    DefaultLintModelSourceProvider(
                        manifestFiles = listOf(File(config.manifest)),
                        javaDirectories = config.sources.map(::File),
                        resDirectories = emptyList(),
                        assetsDirectories = emptyList(),
                        debugOnly = false,
                        unitTestOnly = false,
                        instrumentationTestOnly = false,
                        testFixture = false,
                    ),
                ),
                testSourceProviders = emptyList(),
                testFixturesSourceProviders = emptyList(),
                debuggable = true,
                shrinkable = false,
                buildFeatures = DefaultLintModelBuildFeatures(
                    viewBinding = false,
                    coreLibraryDesugaringEnabled = false,
                    namespacingMode = LintModelNamespacingMode.DISABLED,
                ),
                libraryResolver = resolver,
                partialResultsDir = null,
                desugaredMethodsFiles = emptyList(),
            ),
        )
        File(config.destination).mkdirs()
        LintModelSerialization.writeModule(module, File(config.destination))
    }
}
