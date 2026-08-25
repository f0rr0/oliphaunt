package dev.oliphaunt

import org.json.JSONObject
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OliphauntAndroidRuntimeAssetsTest {
    @Test
    fun rejectsDuplicateManifestProperties() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestText(
                    "schema=oliphaunt-runtime-resources-v1\nschema=other\n",
                    "duplicate.properties",
                )
            }
        assertTrue(error.message.orEmpty().contains("duplicate"))
    }

    @Test
    fun rejectsSharedWhitespaceInvalidClusterSeedManifest() {
        val properties =
            OliphauntAndroidRuntimeAssets.parseManifestText(
                retargetNativeClusterSeedFixture(
                    "native-whitespace.invalid.properties",
                    "android-datum64",
                ),
                "native-whitespace.invalid.properties",
            )
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/cluster-seed",
                    properties,
                )
            }
        assertTrue(error.message.orEmpty().contains("cacheKey"))
    }

    @Test
    fun rejectsSharedPathTraversalClusterSeedCacheKeys() {
        for (fixture in listOf("native-dot-cache-key.invalid.properties", "native-dotdot-cache-key.invalid.properties")) {
            val properties =
                OliphauntAndroidRuntimeAssets.parseManifestText(
                    retargetNativeClusterSeedFixture(fixture, "android-datum64"),
                    fixture,
                )
            val error =
                assertFailsWith<OliphauntException> {
                    OliphauntAndroidRuntimeAssets.parseManifestProperties(
                        "oliphaunt/cluster-seed",
                        properties,
                    )
                }
            assertTrue(error.message.orEmpty().contains("invalid cacheKey"), fixture)
        }
    }

    @Test
    fun parsesCanonicalClusterSeedsWithoutRuntimeOnlyRegistryMetadata() {
        for ((profile, assetRoot) in listOf(
            "standard" to "oliphaunt/cluster-seed",
            "icu" to "oliphaunt/cluster-seed-icu",
        )) {
            val properties =
                OliphauntAndroidRuntimeAssets.parseManifestText(
                    nativeClusterSeedFixture(profile, "android-datum64", "a".repeat(64)),
                    "native-$profile.valid.properties",
                )
            val parsed =
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    assetRoot,
                    properties,
                )
            assertEquals(if (profile == "icu") setOf("icu") else emptySet(), parsed.runtimeFeatures)
            assertEquals(null, parsed.mobileStaticRegistryState)
            assertTrue(parsed.mobileStaticRegistryRegistered.isEmpty())
            assertTrue(parsed.mobileStaticRegistryPending.isEmpty())
            assertTrue(parsed.nativeModuleStems.isEmpty())
        }
    }

    @Test
    fun freshRootAcceptsOnlyFixedBootstrapRole() {
        requireAndroidFreshRootRole("postgres")
        assertFailsWith<OliphauntException> {
            requireAndroidFreshRootRole("alice")
        }
    }

    @Test
    fun parsesCurrentRuntimeManifestSchema() {
        val parsed =
            OliphauntAndroidRuntimeAssets.parseManifestProperties(
                "oliphaunt/runtime",
                manifestProperties(
                    "schema" to "oliphaunt-runtime-resources-v1",
                    "layout" to "postgres-runtime-files-v1",
                    "cacheKey" to "runtime-smoke",
                    "selectedExtensions" to "pg_trgm,vector",
                    "extensions" to "pg_trgm,vector",
                    "runtimeFeatures" to "icu",
                    "sharedPreloadLibraries" to "auto_explain",
                    "mobileStaticRegistryState" to "complete",
                    "mobileStaticRegistryRegistered" to "vector",
                    "mobileStaticRegistryPending" to "",
                    "nativeModuleStems" to "vector",
                ),
            )

        assertEquals("runtime-smoke", parsed.cacheKey)
        assertEquals(setOf("pg_trgm", "vector"), parsed.extensions)
        assertEquals(setOf("icu"), parsed.runtimeFeatures)
        assertEquals(setOf("auto_explain"), parsed.sharedPreloadLibraries)
        assertEquals("complete", parsed.mobileStaticRegistryState)
    }

    @Test
    fun rejectsStaticRegistryEntriesOutsideSelectedExtensions() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-unselected-registry",
                        "selectedExtensions" to "pg_trgm",
                        "extensions" to "pg_trgm",
                        "mobileStaticRegistryState" to "complete",
                        "mobileStaticRegistryRegistered" to "vector",
                        "nativeModuleStems" to "vector",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("outside selectedExtensions"))
    }

    @Test
    fun parsesPackageSizeReport() {
        val report =
            OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                """
                kind	id	extensions	files	bytes
                package	total	-	-	205
                package	runtime	-	-	100
                package	cluster-seed	-	-	40
                package	cluster-seed-icu	-	-	20
                package	static-registry	-	-	45
                extensions	selected	-	-	30
                extension	hstore	-	2	12
                extension	vector	-	3	30
                """.trimIndent(),
                source = "test-package-size.tsv",
            )

        assertEquals(205L, report.packageBytes)
        assertEquals(100L, report.runtimeBytes)
        assertEquals(60L, report.clusterSeedBytes)
        assertEquals(45L, report.staticRegistryBytes)
        assertEquals(30L, report.selectedExtensionBytes)
        assertEquals(
            listOf(
                OliphauntExtensionSizeReport(
                    name = "hstore",
                    fileCount = 2,
                    bytes = 12L,
                ),
                OliphauntExtensionSizeReport(
                    name = "vector",
                    fileCount = 3,
                    bytes = 30L,
                ),
            ),
            report.extensions,
        )
    }

    @Test
    fun parsesPackageSizeReportFromResourceRoot() {
        val resourceRoot = Files.createTempDirectory("liboliphaunt-resource-report").toFile()
        try {
            resourceRoot.resolve("package-size.tsv").writeText(
                """
                kind	id	extensions	files	bytes
                package	total	-	-	205
                package	runtime	-	-	100
                package	cluster-seed	-	-	40
                package	cluster-seed-icu	-	-	20
                package	static-registry	-	-	45
                extensions	selected	-	-	30
                extension	vector	-	3	30
                """.trimIndent(),
            )

            val report = OliphauntAndroidRuntimeAssets.packageSizeReport(resourceRoot)

            assertEquals(205L, report?.packageBytes)
            assertEquals(
                listOf(
                    OliphauntExtensionSizeReport(
                        name = "vector",
                        fileCount = 3,
                        bytes = 30L,
                    ),
                ),
                report?.extensions,
            )
        } finally {
            resourceRoot.deleteRecursively()
        }
    }

    @Test
    fun enrichesPackageSizeReportWithRuntimeManifestFromResourceRoot() {
        val resourceRoot = Files.createTempDirectory("liboliphaunt-resource-report-manifest").toFile()
        try {
            resourceRoot.resolve("package-size.tsv").writeText(validPackageSizeReport())
            val manifest = resourceRoot.resolve("oliphaunt/runtime/manifest.properties")
            requireNotNull(manifest.parentFile).mkdirs()
            manifest.writeText(
                """
                schema=oliphaunt-runtime-resources-v1
                layout=postgres-runtime-files-v1
                artifactRole=runtime
                catalogProfile=
                clusterSeedTarget=android-datum64
                icuDataTreeSha256=${"a".repeat(64)}
                mode=native-direct
                cacheKey=runtime-smoke
                selectedExtensions=hstore,vector
                extensions=hstore,vector
                runtimeFeatures=icu
                sharedPreloadLibraries=
                mobileStaticRegistryState=complete
                mobileStaticRegistryRegistered=vector,hstore
                mobileStaticRegistryPending=
                nativeModuleStems=vector,hstore
                mobileStaticRegistrySource=static-registry/oliphaunt_static_registry.c
                """.trimIndent(),
            )

            val report = OliphauntAndroidRuntimeAssets.packageSizeReport(resourceRoot)

            assertEquals("complete", report?.mobileStaticRegistryState)
            assertEquals(listOf("hstore", "vector"), report?.mobileStaticRegistryRegistered)
            assertEquals(emptyList(), report?.mobileStaticRegistryPending)
            assertEquals(listOf("hstore", "vector"), report?.nativeModuleStems)
            assertEquals(listOf("icu"), report?.runtimeFeatures)
        } finally {
            resourceRoot.deleteRecursively()
        }
    }

    @Test
    fun runtimeCacheNeverReplacesAnInvalidPublishedTarget() {
        val parent = Files.createTempDirectory("liboliphaunt-android-runtime-cache").toFile()
        val target = parent.resolve("runtime")
        val stamp = target.resolve(".liboliphaunt-asset-cache-key")
        try {
            target.mkdirs()
            stamp.writeText("runtime-smoke")
            assertTrue(
                OliphauntAndroidRuntimeAssets.isAndroidRuntimeCacheReady(
                    target,
                    stamp,
                    "runtime-smoke",
                    isSymbolicLink = { Files.isSymbolicLink(it.toPath()) },
                ),
            )
            val sentinel = target.resolve("sentinel").apply { writeText("preserve") }
            stamp.writeText("invalid")

            val error =
                assertFailsWith<OliphauntException> {
                    OliphauntAndroidRuntimeAssets.isAndroidRuntimeCacheReady(
                        target,
                        stamp,
                        "runtime-smoke",
                        isSymbolicLink = { Files.isSymbolicLink(it.toPath()) },
                    )
                }
            assertTrue(error.message.orEmpty().contains("immutable Android Oliphaunt runtime cache"))
            assertEquals("preserve", sentinel.readText())
        } finally {
            parent.deleteRecursively()
        }
    }

    @Test
    fun validatesExplicitRuntimeDirectoryAgainstReleaseShapedResources() {
        val resourceRoot = Files.createTempDirectory("liboliphaunt-explicit-runtime").toFile()
        try {
            val runtimeFiles =
                writeReleaseShapedRuntime(
                    resourceRoot,
                    extensions = "vector",
                    sharedPreloadLibraries = "pg_search",
                )

            val sharedPreloadLibraries =
                OliphauntAndroidRuntimeAssets.validateExplicitRuntimeDirectory(
                    runtimeFiles.absolutePath,
                    listOf("vector"),
                )

            assertEquals(setOf("pg_search"), sharedPreloadLibraries)
        } finally {
            resourceRoot.deleteRecursively()
        }
    }

    @Test
    fun validatesNonCreateExtensionByCanonicalCompleteStaticRegistration() {
        val resourceRoot = Files.createTempDirectory("liboliphaunt-explicit-auto-explain").toFile()
        try {
            val runtimeFiles =
                writeReleaseShapedRuntime(
                    resourceRoot,
                    extensions = "auto_explain",
                    createableExtensions = "",
                    nativeModuleStem = "auto_explain",
                    includeControl = false,
                    includeSql = false,
                    includeModule = false,
                )

            OliphauntAndroidRuntimeAssets.validateExplicitRuntimeDirectory(
                runtimeFiles.absolutePath,
                listOf("auto_explain"),
            )

            val manifest = resourceRoot.resolve("oliphaunt/runtime/manifest.properties")
            val completeManifest = manifest.readText()
            manifest.writeText(
                completeManifest.replace(
                    "nativeModuleStems=auto_explain",
                    "nativeModuleStems=wrong_module",
                ),
            )
            val stemError =
                assertFailsWith<OliphauntException> {
                    OliphauntAndroidRuntimeAssets.validateExplicitRuntimeDirectory(
                        runtimeFiles.absolutePath,
                        listOf("auto_explain"),
                    )
                }
            assertTrue(stemError.message.orEmpty().contains("do not list native module stem auto_explain"))

            manifest.writeText(
                completeManifest
                    .replace(
                        "selectedExtensions=auto_explain",
                        "selectedExtensions=auto_explain,vector",
                    ).replace(
                        "mobileStaticRegistryRegistered=auto_explain",
                        "mobileStaticRegistryRegistered=vector",
                    ),
            )
            val error =
                assertFailsWith<OliphauntException> {
                    OliphauntAndroidRuntimeAssets.validateExplicitRuntimeDirectory(
                        runtimeFiles.absolutePath,
                        listOf("auto_explain"),
                    )
                }
            assertTrue(error.message.orEmpty().contains("do not completely statically register"))
        } finally {
            resourceRoot.deleteRecursively()
        }
    }

    @Test
    fun rejectsExplicitRuntimeDirectoryWithoutReleaseShapedProofForExtensions() {
        val runtimeDirectory = Files.createTempDirectory("liboliphaunt-unproved-runtime").toFile()
        try {
            val error =
                assertFailsWith<OliphauntException> {
                    OliphauntAndroidRuntimeAssets.validateExplicitRuntimeDirectory(
                        runtimeDirectory.absolutePath,
                        listOf("vector"),
                    )
                }

            assertTrue(error.message.orEmpty().contains("release-shaped runtime resources"))
        } finally {
            runtimeDirectory.deleteRecursively()
        }
    }

    @Test
    fun rejectsExplicitRuntimeDirectoryWithMissingExtensionInstallFiles() {
        val resourceRoot = Files.createTempDirectory("liboliphaunt-explicit-runtime-missing-extension").toFile()
        try {
            val runtimeFiles =
                writeReleaseShapedRuntime(
                    resourceRoot,
                    extensions = "vector",
                    includeSql = false,
                )

            val error =
                assertFailsWith<OliphauntException> {
                    OliphauntAndroidRuntimeAssets.validateExplicitRuntimeDirectory(
                        runtimeFiles.absolutePath,
                        listOf("vector"),
                    )
                }

            assertTrue(error.message.orEmpty().contains("missing vector--*.sql"))
        } finally {
            resourceRoot.deleteRecursively()
        }
    }

    @Test
    fun returnsNullWhenPackageSizeReportIsAbsentFromResourceRoot() {
        val resourceRoot = Files.createTempDirectory("liboliphaunt-resource-report-absent").toFile()
        try {
            assertEquals(null, OliphauntAndroidRuntimeAssets.packageSizeReport(resourceRoot))
        } finally {
            resourceRoot.deleteRecursively()
        }
    }

    @Test
    fun normalizesAndroidPostgresqlConfigSharedMemory() {
        val normalized =
            OliphauntAndroidRuntimeAssets.normalizePostgresqlConfigForAndroid(
                """
                #shared_memory_type = mmap
                dynamic_shared_memory_type = posix	# initdb host default
                max_connections = 100
                """.trimIndent(),
            )

        assertTrue(normalized.contains("shared_memory_type = mmap"))
        assertTrue(normalized.contains("dynamic_shared_memory_type = mmap"))
        assertTrue(normalized.contains("max_connections = 100"))
    }

    @Test
    fun appendsAndroidPostgresqlSharedMemoryConfigWhenMissing() {
        val normalized = OliphauntAndroidRuntimeAssets.normalizePostgresqlConfigForAndroid("max_connections = 100")

        assertTrue(normalized.startsWith("max_connections = 100\n"))
        assertTrue(normalized.contains("shared_memory_type = mmap"))
        assertTrue(normalized.endsWith("dynamic_shared_memory_type = mmap\n"))
    }

    @Test
    fun restoresAndroidClusterSeedEmptyDirectories() {
        val pgdata = Files.createTempDirectory("liboliphaunt-android-pgdata").toFile()
        try {
            OliphauntAndroidRuntimeAssets.ensureClusterSeedDirectoriesForAndroid(pgdata)

            assertTrue(pgdata.resolve("pg_notify").isDirectory)
            assertTrue(pgdata.resolve("pg_wal/archive_status").isDirectory)
            assertTrue(pgdata.resolve("pg_logical/snapshots").isDirectory)
        } finally {
            pgdata.deleteRecursively()
        }
    }

    @Test
    fun pgdataPublicationAdoptsACompleteWinnerWithoutReplacingIt() {
        val parent = Files.createTempDirectory("liboliphaunt-android-publication").toFile()
        val staging = parent.resolve("staging")
        val destination = parent.resolve("pgdata")
        try {
            writeCompletePgdata(staging)
            writeCompletePgdata(destination)
            destination.resolve("winner").writeText("keep")

            val publication = OliphauntAndroidRuntimeAssets.publishPreparedAndroidPgdata(staging, destination)

            assertEquals(AndroidPgdataPublication.Existing, publication)
            assertEquals("keep", destination.resolve("winner").readText())
            assertTrue(staging.isDirectory)
        } finally {
            parent.deleteRecursively()
        }
    }

    @Test
    fun pgdataPublicationReportsAnOwnedDestination() {
        val parent = Files.createTempDirectory("liboliphaunt-android-owned-publication").toFile()
        val staging = parent.resolve("staging")
        val destination = parent.resolve("pgdata")
        try {
            writeCompletePgdata(staging)

            var didPublish = false
            val publication =
                OliphauntAndroidRuntimeAssets.publishPreparedAndroidPgdata(
                    staging,
                    destination,
                    didPublishDestination = { didPublish = true },
                    syncPublicationTree = {},
                    syncParentDirectory = {},
                )

            assertEquals(AndroidPgdataPublication.Published, publication)
            assertTrue(didPublish)
            assertFalse(staging.exists())
            validateCompleteAndroidPgdata(destination)
        } finally {
            parent.deleteRecursively()
        }
    }

    @Test
    fun stagingCleanupFailurePreventsSuccessAndComposesPrimaryFailure() {
        val successError =
            assertFailsWith<OliphauntException> {
                finishAndroidStaging(Result.success(1), operation = "PGDATA preparation") {
                    error("cleanup failed")
                }
            }
        assertTrue(successError.message.orEmpty().contains("PGDATA preparation staging cleanup failed"))
        assertEquals(1, successError.suppressed.size)

        val failureError =
            assertFailsWith<OliphauntException> {
                finishAndroidStaging(
                    Result.failure<Int>(ManagedRootPublicationTestException()),
                    operation = "PGDATA preparation",
                ) { error("cleanup failed") }
            }
        assertTrue(failureError.message.orEmpty().contains("PGDATA preparation failed"))
        assertTrue(failureError.message.orEmpty().contains("staging cleanup failed"))
        assertEquals(2, failureError.suppressed.size)
    }

    @Test
    fun managedRootFailureCleansOnlyWhenDescriptorIsDefinitelyAbsent() {
        data class Scenario(
            val owns: Boolean,
            val descriptorAbsent: Boolean,
            val expectedCalls: List<String>,
        )

        val scenarios =
            listOf(
                Scenario(owns = true, descriptorAbsent = true, expectedCalls = listOf("remove", "sync")),
                Scenario(owns = true, descriptorAbsent = false, expectedCalls = emptyList()),
                Scenario(owns = false, descriptorAbsent = true, expectedCalls = emptyList()),
            )
        for (scenario in scenarios) {
            val calls = mutableListOf<String>()
            assertFailsWith<ManagedRootPublicationTestException> {
                recoverAndroidManagedRootPublicationFailure(
                    publicationError = ManagedRootPublicationTestException(),
                    ownsPublishedPgdata = scenario.owns,
                    descriptorDefinitelyAbsent = { scenario.descriptorAbsent },
                    removePublishedPgdata = { calls += "remove" },
                    syncRoot = { calls += "sync" },
                )
            }
            assertEquals(scenario.expectedCalls, calls)
        }
    }

    @Test
    fun managedRootFailureSurfacesCleanupFailure() {
        val error =
            assertFailsWith<OliphauntException> {
                recoverAndroidManagedRootPublicationFailure(
                    publicationError = ManagedRootPublicationTestException(),
                    ownsPublishedPgdata = true,
                    descriptorDefinitelyAbsent = { true },
                    removePublishedPgdata = { error("cleanup failed") },
                    syncRoot = {},
                )
            }

        assertTrue(error.message.orEmpty().contains("descriptor publication failed"))
        assertTrue(error.message.orEmpty().contains("failed to clean uncommitted PGDATA"))
        assertEquals(2, error.suppressed.size)
    }

    @Test
    fun managedRootFailurePreservesPgdataWhenDescriptorInspectionIsUncertain() {
        val calls = mutableListOf<String>()
        val error =
            assertFailsWith<OliphauntException> {
                recoverAndroidManagedRootPublicationFailure(
                    publicationError = ManagedRootPublicationTestException(),
                    ownsPublishedPgdata = true,
                    descriptorDefinitelyAbsent = { error("inspection failed") },
                    removePublishedPgdata = { calls += "remove" },
                    syncRoot = { calls += "sync" },
                )
            }

        assertTrue(error.message.orEmpty().contains("descriptor publication is uncertain"))
        assertTrue(error.message.orEmpty().contains("publication failed"))
        assertTrue(calls.isEmpty())
        assertEquals(2, error.suppressed.size)
    }

    @Test
    fun managedRootDescriptorClassifiesACompletePgdata() {
        val fixture = databaseRootFixture()
        val descriptors = fixture.getJSONArray("validDescriptors")
        val nativeDescriptor =
            (0 until descriptors.length())
                .map(descriptors::getJSONObject)
                .single { it.getString("engineFamily") == "native" }
        val emittedDescriptor = JSONObject(NATIVE_ROOT_DESCRIPTOR)
        assertEquals(nativeDescriptor.length(), emittedDescriptor.length())
        for (key in nativeDescriptor.keys()) {
            assertEquals(nativeDescriptor.get(key), emittedDescriptor.get(key), key)
        }

        for (index in 0 until descriptors.length()) {
            val root = Files.createTempDirectory("liboliphaunt-android-descriptor").toFile()
            try {
                writeCompletePgdata(root.resolve("pgdata"))
                root.resolve(".oliphaunt.json").writeText(descriptors.getJSONObject(index).toString())
                assertEquals(AndroidManagedRootState.Managed, classifyAndroidManagedRoot(root))
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test
    fun managedRootDescriptorRejectsEverySharedInvalidFixture() {
        val fixture = databaseRootFixture()
        val invalid = fixture.getJSONArray("invalidDescriptors")
        val malformed = fixture.getJSONArray("malformedJson")
        val descriptors =
            buildList {
                for (index in 0 until invalid.length()) {
                    add(invalid.getJSONObject(index).getJSONObject("value").toString())
                }
                for (index in 0 until malformed.length()) {
                    add(malformed.getJSONObject(index).getString("value"))
                }
            }

        for (descriptor in descriptors) {
            val root = Files.createTempDirectory("liboliphaunt-android-invalid-descriptor").toFile()
            try {
                writeCompletePgdata(root.resolve("pgdata"))
                root.resolve(".oliphaunt.json").writeText(descriptor)
                assertFailsWith<OliphauntException> { classifyAndroidManagedRoot(root) }
            } finally {
                root.deleteRecursively()
            }
        }
    }

    @Test
    fun rejectsUnsupportedPackageSizeReportHeader() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                    "kind\tid\tbytes",
                    source = "test-package-size.tsv",
                )
            }

        assertTrue(error.message.orEmpty().contains("unsupported header"))
    }

    @Test
    fun rejectsPackageSizeReportWithWrongColumnCount() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                    """
                    kind	id	extensions	files	bytes
                    package	total	-	-
                    """.trimIndent(),
                    source = "test-package-size.tsv",
                )
            }

        assertTrue(error.message.orEmpty().contains("5 tab-separated columns"))
    }

    @Test
    fun rejectsMalformedPackageSizeReport() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                    """
                    kind	id	extensions	files	bytes
                    package	total	-	-	not-bytes
                    """.trimIndent(),
                    source = "test-package-size.tsv",
                )
            }

        assertTrue(error.message.orEmpty().contains("invalid bytes value"))
    }

    @Test
    fun rejectsNegativePackageSizeReportBytes() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                    """
                    kind	id	extensions	files	bytes
                    package	total	-	-	-1
                    """.trimIndent(),
                    source = "test-package-size.tsv",
                )
            }

        assertTrue(error.message.orEmpty().contains("invalid bytes value"))
    }

    @Test
    fun rejectsRepeatedPackageSizeRequiredRows() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                    """
                    kind	id	extensions	files	bytes
                    package	total	-	-	185
                    package	total	-	-	200
                    package	runtime	-	-	100
                    package	cluster-seed	-	-	40
                    package	static-registry	-	-	45
                    extensions	selected	-	-	30
                    """.trimIndent(),
                    source = "test-package-size.tsv",
                )
            }

        assertTrue(error.message.orEmpty().contains("repeats required row package/total"))
    }

    @Test
    fun rejectsPackageSizeReportMissingRequiredRows() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                    """
                    kind	id	extensions	files	bytes
                    package	total	-	-	185
                    package	cluster-seed	-	-	40
                    package	static-registry	-	-	45
                    extensions	selected	-	-	30
                    """.trimIndent(),
                    source = "test-package-size.tsv",
                )
            }

        assertTrue(error.message.orEmpty().contains("missing required row package/runtime"))
    }

    @Test
    fun rejectsUnknownPackageSizeRows() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                    """
                    kind	id	extensions	files	bytes
                    package	total	-	-	185
                    package	runtime	-	-	100
                    unknown	row	-	-	1
                    """.trimIndent(),
                    source = "test-package-size.tsv",
                )
            }

        assertTrue(error.message.orEmpty().contains("unknown row unknown/row"))
    }

    @Test
    fun rejectsInvalidPackageSizeExtensionRows() {
        val invalidId =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                    validPackageSizeReport("extension\tbad extension\t-\t1\t1"),
                    source = "test-package-size.tsv",
                )
            }
        assertTrue(invalidId.message.orEmpty().contains("invalid extension id"))

        val duplicate =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                    validPackageSizeReport(
                        "extension\tvector\t-\t1\t1",
                        "extension\tvector\t-\t1\t1",
                    ),
                    source = "test-package-size.tsv",
                )
            }
        assertTrue(duplicate.message.orEmpty().contains("repeats extension row"))

        val wrongExtensionsColumn =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                    validPackageSizeReport("extension\tvector\tvector\t1\t1"),
                    source = "test-package-size.tsv",
                )
            }
        assertTrue(wrongExtensionsColumn.message.orEmpty().contains("must use '-' in the extensions column"))

        val invalidFileCount =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                    validPackageSizeReport("extension\tvector\t-\tnope\t1"),
                    source = "test-package-size.tsv",
                )
            }
        assertTrue(invalidFileCount.message.orEmpty().contains("invalid files value"))
    }

    @Test
    fun rejectsMalformedSharedPreloadLibraryMetadata() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-smoke",
                        "selectedExtensions" to "vector",
                        "extensions" to "vector",
                        "sharedPreloadLibraries" to "pg search",
                        "mobileStaticRegistryState" to "complete",
                        "mobileStaticRegistryRegistered" to "vector",
                        "mobileStaticRegistryPending" to "",
                        "nativeModuleStems" to "vector",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("shared preload library"))
    }

    @Test
    fun rejectsRuntimeManifestWithMissingOrExtraField() {
        val missing = manifestProperties()
        missing.remove("selectedExtensions")
        val missingError =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    missing,
                )
            }
        assertTrue(missingError.message.orEmpty().contains("missing=selectedExtensions"))

        val extra = manifestProperties().apply { setProperty("legacy", "value") }
        val extraError =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    extra,
                )
            }
        assertTrue(extraError.message.orEmpty().contains("unsupported=legacy"))
    }

    @Test
    fun rejectsInvalidRuntimeManifestCacheKeyAndExtensions() {
        val badCacheKey =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime smoke",
                        "mobileStaticRegistryState" to "not-required",
                    ),
                )
            }
        assertTrue(badCacheKey.message.orEmpty().contains("invalid cacheKey"))

        for (cacheKey in listOf(".", "..")) {
            val pathTraversal =
                assertFailsWith<OliphauntException> {
                    OliphauntAndroidRuntimeAssets.parseManifestProperties(
                        "oliphaunt/runtime",
                        manifestProperties("cacheKey" to cacheKey),
                    )
                }
            assertTrue(pathTraversal.message.orEmpty().contains("invalid cacheKey"))
        }

        val badExtension =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-smoke",
                        "extensions" to "bad extension",
                        "mobileStaticRegistryState" to "not-required",
                    ),
                )
            }
        assertTrue(badExtension.message.orEmpty().contains("extension id"))
    }

    @Test
    fun rejectsRuntimeManifestModeAndStaticRegistrySourceMismatch() {
        val modeError =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties("mode" to "other"),
                )
            }
        assertTrue(modeError.message.orEmpty().contains("mode=native-direct"))

        val missingCompleteSource =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "mobileStaticRegistryState" to "complete",
                        "mobileStaticRegistrySource" to "",
                    ),
                )
            }
        assertTrue(missingCompleteSource.message.orEmpty().contains("mobileStaticRegistrySource"))

        val noncanonicalCompleteSource =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "mobileStaticRegistryState" to "complete",
                        "mobileStaticRegistrySource" to "swiftpm-linked-products",
                    ),
                )
            }
        assertTrue(noncanonicalCompleteSource.message.orEmpty().contains("mobileStaticRegistrySource"))

        val unexpectedSource =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "mobileStaticRegistryState" to "not-required",
                        "mobileStaticRegistrySource" to "static-registry/oliphaunt_static_registry.c",
                    ),
                )
            }
        assertTrue(unexpectedSource.message.orEmpty().contains("mobileStaticRegistrySource"))
    }

    @Test
    fun rejectsUnsupportedRuntimeFeatures() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-smoke",
                        "selectedExtensions" to "vector",
                        "extensions" to "vector",
                        "runtimeFeatures" to "jit",
                        "mobileStaticRegistryState" to "complete",
                        "mobileStaticRegistryRegistered" to "vector",
                        "mobileStaticRegistryPending" to "",
                        "nativeModuleStems" to "vector",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("runtime feature(s) jit are not supported"))
    }

    @Test
    fun rejectsUnsupportedRuntimeResourcesSchema() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v0",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-smoke",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("unsupported runtime resource schema"))
    }

    @Test
    fun rejectsRuntimeManifestWithClusterSeedLayout() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "oliphaunt-cluster-seed-v1",
                        "cacheKey" to "runtime-smoke",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("unsupported layout"))
    }

    @Test
    fun rejectsClusterSeedManifestWithRuntimeLayout() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/cluster-seed",
                    standardClusterSeedManifestProperties(
                        "layout" to "postgres-runtime-files-v1",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("unsupported layout"))
    }

    @Test
    fun rejectsUnknownRuntimeAssetRoot() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/unknown",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-smoke",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("unsupported Oliphaunt asset root"))
    }

    @Test
    fun rejectsInvalidMobileStaticRegistryState() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-smoke",
                        "selectedExtensions" to "",
                        "mobileStaticRegistryState" to "almost",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("mobileStaticRegistryState"))
    }

    @Test
    fun rejectsManifestWithoutMobileStaticRegistryState() {
        val manifest = manifestProperties()
        manifest.remove("mobileStaticRegistryState")
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifest,
                )
            }

        assertTrue(error.message.orEmpty().contains("missing=mobileStaticRegistryState"))
    }

    @Test
    fun rejectsCompleteMobileRegistryWithPendingEntries() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-smoke",
                        "selectedExtensions" to "vector",
                        "extensions" to "vector",
                        "mobileStaticRegistryState" to "complete",
                        "mobileStaticRegistryRegistered" to "vector",
                        "mobileStaticRegistryPending" to "vector",
                        "nativeModuleStems" to "vector",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("registered and pending"))
    }

    @Test
    fun rejectsPendingMobileRegistryWithoutPendingEntries() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-smoke",
                        "selectedExtensions" to "",
                        "mobileStaticRegistryState" to "pending",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("must list mobileStaticRegistryPending"))
    }

    @Test
    fun rejectsCompleteMobileRegistryWithoutRegisteredModules() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-smoke",
                        "selectedExtensions" to "vector",
                        "mobileStaticRegistryState" to "complete",
                        "mobileStaticRegistryRegistered" to "vector",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("must list mobileStaticRegistryRegistered and nativeModuleStems"))
    }

    @Test
    fun rejectsNotRequiredMobileRegistryWithNativeModules() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-smoke",
                        "selectedExtensions" to "vector",
                        "mobileStaticRegistryState" to "not-required",
                        "nativeModuleStems" to "vector",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("not-required"))
    }
}

private fun databaseRootFixture(): JSONObject {
    val configured =
        System
            .getProperty("oliphaunt.sharedFixturesDir")
            ?.takeIf(String::isNotBlank)
            ?.let { Path.of(it, "storage", "database-root.json") }
    val cwd = Path.of("").toAbsolutePath()
    val fixture =
        listOfNotNull(
            configured,
            cwd.resolve("src/shared/fixtures/storage/database-root.json").normalize(),
            cwd.resolve("../../shared/fixtures/storage/database-root.json").normalize(),
        ).firstOrNull(Files::isRegularFile)
    checkNotNull(fixture) { "shared database-root fixture was not found from the repository checkout" }
    return JSONObject(fixture.toFile().readText())
}

private fun manifestProperties(vararg entries: Pair<String, String>): Properties = Properties().apply {
    mapOf(
        "schema" to "oliphaunt-runtime-resources-v1",
        "layout" to "postgres-runtime-files-v1",
        "artifactRole" to "runtime",
        "catalogProfile" to "",
        "clusterSeedTarget" to "android-datum64",
        "icuDataTreeSha256" to "",
        "mode" to "native-direct",
        "cacheKey" to "runtime-smoke",
        "selectedExtensions" to "",
        "extensions" to "",
        "runtimeFeatures" to "",
        "sharedPreloadLibraries" to "",
        "mobileStaticRegistryState" to "not-required",
        "mobileStaticRegistryRegistered" to "",
        "mobileStaticRegistryPending" to "",
        "nativeModuleStems" to "",
    ).forEach { (key, value) -> setProperty(key, value) }
    for ((key, value) in entries) {
        setProperty(key, value)
    }
    if (getProperty("artifactRole") == "runtime") {
        putIfAbsent("clusterSeedTarget", "android-datum64")
        putIfAbsent(
            "mobileStaticRegistrySource",
            if (getProperty("mobileStaticRegistryState") == "complete") {
                "static-registry/oliphaunt_static_registry.c"
            } else {
                ""
            },
        )
        if (
            getProperty("runtimeFeatures").orEmpty().split(',').contains("icu") &&
            getProperty("icuDataTreeSha256").isNullOrEmpty()
        ) {
            setProperty("icuDataTreeSha256", "a".repeat(64))
        }
    }
}

private fun standardClusterSeedManifestProperties(vararg entries: Pair<String, String>): Properties = Properties().apply {
    load(java.io.StringReader(nativeClusterSeedFixture("standard", "android-datum64")))
    entries.forEach { (key, value) -> setProperty(key, value) }
}

private fun validPackageSizeReport(vararg extensionRows: String): String {
    val rows =
        listOf(
            "kind\tid\textensions\tfiles\tbytes",
            "package\ttotal\t-\t-\t205",
            "package\truntime\t-\t-\t100",
            "package\tcluster-seed\t-\t-\t40",
            "package\tcluster-seed-icu\t-\t-\t20",
            "package\tstatic-registry\t-\t-\t45",
            "extensions\tselected\t-\t-\t30",
        ) + extensionRows
    return rows.joinToString("\n")
}

private fun writeCompletePgdata(pgdata: java.io.File) {
    pgdata.resolve("global").mkdirs()
    pgdata.resolve("pg_wal").mkdirs()
    pgdata.resolve("PG_VERSION").writeText("18\n")
    pgdata.resolve("global/pg_control").writeText("control")
}

private class ManagedRootPublicationTestException : RuntimeException("publication failed")

private fun writeReleaseShapedRuntime(
    resourceRoot: java.io.File,
    extensions: String,
    createableExtensions: String = extensions,
    sharedPreloadLibraries: String = "",
    nativeModuleStem: String = extensions,
    includeControl: Boolean = true,
    includeSql: Boolean = true,
    includeModule: Boolean = false,
): java.io.File {
    val oliphauntRoot = resourceRoot.resolve("oliphaunt")
    oliphauntRoot.mkdirs()
    oliphauntRoot.resolve("manifest.properties").writeText(
        "schema=oliphaunt-native-runtime-carrier-v1\n" +
            "clusterSeedTarget=android-datum64\n" +
            "clusterSeedRelativePath=cluster-seed\n" +
            "icuClusterSeedRelativePath=cluster-seed-icu\n",
    )
    writeTestClusterSeed(oliphauntRoot.resolve("cluster-seed"), "standard", "")
    writeTestClusterSeed(oliphauntRoot.resolve("cluster-seed-icu"), "icu", "a".repeat(64))
    val runtimeRoot = oliphauntRoot.resolve("runtime")
    runtimeRoot.mkdirs()
    runtimeRoot.resolve("manifest.properties").writeText(
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        artifactRole=runtime
        catalogProfile=
        mode=native-direct
        cacheKey=runtime-smoke
        selectedExtensions=$extensions
        extensions=$createableExtensions
        runtimeFeatures=icu
        clusterSeedTarget=android-datum64
        icuDataTreeSha256=${"a".repeat(64)}
        sharedPreloadLibraries=$sharedPreloadLibraries
        mobileStaticRegistryState=complete
        mobileStaticRegistryRegistered=$extensions
        mobileStaticRegistryPending=
        nativeModuleStems=$nativeModuleStem
        mobileStaticRegistrySource=static-registry/oliphaunt_static_registry.c
        """.trimIndent(),
    )
    val extensionDirectory = runtimeRoot.resolve("files/share/postgresql/extension")
    extensionDirectory.mkdirs()
    if (includeControl) {
        extensionDirectory.resolve("vector.control").writeText("comment = 'vector smoke control'\n")
    }
    if (includeSql) {
        extensionDirectory.resolve("vector--1.0.sql").writeText("select 'vector smoke sql';\n")
    }
    if (includeModule) {
        runtimeRoot.resolve("files/lib/postgresql").mkdirs()
        runtimeRoot.resolve("files/lib/postgresql/$nativeModuleStem.so").writeText("module fixture\n")
    }
    return runtimeRoot.resolve("files")
}

private fun writeTestClusterSeed(
    root: java.io.File,
    profile: String,
    digest: String,
) {
    root.resolve("files/global").mkdirs()
    root.resolve("files/PG_VERSION").writeText("18\n")
    root.resolve("files/global/pg_control").writeText("control")
    root.resolve("manifest.properties").writeText(
        nativeClusterSeedFixture(profile, "android-datum64", digest),
    )
}

private fun nativeClusterSeedFixture(
    profile: String,
    target: String,
    icuDataTreeSha256: String = "",
): String = retargetNativeClusterSeedFixture(
    "native-$profile.valid.properties",
    target,
    if (profile == "icu") icuDataTreeSha256 else null,
)

private fun retargetNativeClusterSeedFixture(
    name: String,
    target: String,
    icuDataTreeSha256: String? = null,
): String {
    val fixtureRoot =
        System
            .getProperty("oliphaunt.clusterSeedFixturesDir")
            ?.takeIf(String::isNotBlank)
            ?.let(Path::of)
            ?: error("oliphaunt.clusterSeedFixturesDir is not configured")
    val overrides =
        buildMap {
            put("target", target)
            put("compatibilityKey", "native-pg18-$target-v1")
            if (icuDataTreeSha256 != null) put("icuDataTreeSha256", icuDataTreeSha256)
        }
    return fixtureRoot
        .resolve(name)
        .toFile()
        .readText()
        .lineSequence()
        .map { line ->
            val key = line.substringBefore('=', line)
            overrides[key]?.let { "$key=$it" } ?: line
        }.joinToString("\n", postfix = "\n")
}
