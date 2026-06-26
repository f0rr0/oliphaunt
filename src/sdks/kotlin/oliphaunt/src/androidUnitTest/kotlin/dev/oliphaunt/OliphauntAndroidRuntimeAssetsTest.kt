package dev.oliphaunt

import java.nio.file.Files
import java.util.Properties
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class OliphauntAndroidRuntimeAssetsTest {
    @Test
    fun parsesCurrentRuntimeManifestSchema() {
        val parsed =
            OliphauntAndroidRuntimeAssets.parseManifestProperties(
                "oliphaunt/runtime",
                manifestProperties(
                    "schema" to "oliphaunt-runtime-resources-v1",
                    "layout" to "postgres-runtime-files-v1",
                    "cacheKey" to "runtime-smoke",
                    "extensions" to "pg_trgm,vector",
                    "sharedPreloadLibraries" to "auto_explain",
                    "mobileStaticRegistryState" to "complete",
                    "mobileStaticRegistryRegistered" to "vector",
                    "mobileStaticRegistryPending" to "",
                    "nativeModuleStems" to "vector",
                ),
            )

        assertEquals("runtime-smoke", parsed.cacheKey)
        assertEquals(setOf("pg_trgm", "vector"), parsed.extensions)
        assertEquals(setOf("auto_explain"), parsed.sharedPreloadLibraries)
        assertEquals("complete", parsed.mobileStaticRegistryState)
    }

    @Test
    fun parsesPackageSizeReport() {
        val report =
            OliphauntAndroidRuntimeAssets.parsePackageSizeReport(
                """
                kind	id	extensions	files	bytes
                package	total	-	-	185
                package	runtime	-	-	100
                package	template-pgdata	-	-	40
                package	static-registry	-	-	45
                extensions	selected	-	-	30
                extension	hstore	-	2	12
                extension	vector	-	3	30
                """.trimIndent(),
                source = "test-package-size.tsv",
            )

        assertEquals(185L, report.packageBytes)
        assertEquals(100L, report.runtimeBytes)
        assertEquals(40L, report.templatePgdataBytes)
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
                package	total	-	-	185
                package	runtime	-	-	100
                package	template-pgdata	-	-	40
                package	static-registry	-	-	45
                extensions	selected	-	-	30
                extension	vector	-	3	30
                """.trimIndent(),
            )

            val report = OliphauntAndroidRuntimeAssets.packageSizeReport(resourceRoot)

            assertEquals(185L, report?.packageBytes)
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
                cacheKey=runtime-smoke
                extensions=hstore,vector
                sharedPreloadLibraries=
                mobileStaticRegistryState=complete
                mobileStaticRegistryRegistered=vector,hstore
                mobileStaticRegistryPending=
                nativeModuleStems=vector,hstore
                """.trimIndent(),
            )

            val report = OliphauntAndroidRuntimeAssets.packageSizeReport(resourceRoot)
            val facadeReport = OliphauntAndroid.packageSizeReport(resourceRoot)

            assertEquals("complete", report?.mobileStaticRegistryState)
            assertEquals(report, facadeReport)
            assertEquals(listOf("hstore", "vector"), report?.mobileStaticRegistryRegistered)
            assertEquals(emptyList(), report?.mobileStaticRegistryPending)
            assertEquals(listOf("hstore", "vector"), report?.nativeModuleStems)
        } finally {
            resourceRoot.deleteRecursively()
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
    fun restoresAndroidTemplatePgdataEmptyDirectories() {
        val pgdata = Files.createTempDirectory("liboliphaunt-android-pgdata").toFile()
        try {
            OliphauntAndroidRuntimeAssets.ensureTemplatePgdataDirectoriesForAndroid(pgdata)

            assertTrue(pgdata.resolve("pg_notify").isDirectory)
            assertTrue(pgdata.resolve("pg_wal/archive_status").isDirectory)
            assertTrue(pgdata.resolve("pg_logical/snapshots").isDirectory)
        } finally {
            pgdata.deleteRecursively()
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
                    package	template-pgdata	-	-	40
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
                    package	template-pgdata	-	-	40
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
    fun rejectsRuntimeManifestWithTemplateLayout() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-template-pgdata-v1",
                        "cacheKey" to "runtime-smoke",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("unsupported layout"))
    }

    @Test
    fun rejectsTemplateManifestWithRuntimeLayout() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/template-pgdata",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "template-smoke",
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
                        "mobileStaticRegistryState" to "almost",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("mobileStaticRegistryState"))
    }

    @Test
    fun rejectsManifestWithoutMobileStaticRegistryState() {
        val error =
            assertFailsWith<OliphauntException> {
                OliphauntAndroidRuntimeAssets.parseManifestProperties(
                    "oliphaunt/runtime",
                    manifestProperties(
                        "schema" to "oliphaunt-runtime-resources-v1",
                        "layout" to "postgres-runtime-files-v1",
                        "cacheKey" to "runtime-smoke",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("omits mobileStaticRegistryState"))
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
                        "mobileStaticRegistryState" to "not-required",
                        "nativeModuleStems" to "vector",
                    ),
                )
            }

        assertTrue(error.message.orEmpty().contains("not-required"))
    }
}

private fun manifestProperties(vararg entries: Pair<String, String>): Properties = Properties().apply {
    for ((key, value) in entries) {
        setProperty(key, value)
    }
}

private fun validPackageSizeReport(vararg extensionRows: String): String {
    val rows =
        listOf(
            "kind\tid\textensions\tfiles\tbytes",
            "package\ttotal\t-\t-\t185",
            "package\truntime\t-\t-\t100",
            "package\ttemplate-pgdata\t-\t-\t40",
            "package\tstatic-registry\t-\t-\t45",
            "extensions\tselected\t-\t-\t30",
        ) + extensionRows
    return rows.joinToString("\n")
}

private fun writeReleaseShapedRuntime(
    resourceRoot: java.io.File,
    extensions: String,
    sharedPreloadLibraries: String = "",
    includeControl: Boolean = true,
    includeSql: Boolean = true,
): java.io.File {
    val runtimeRoot = resourceRoot.resolve("oliphaunt/runtime")
    runtimeRoot.mkdirs()
    runtimeRoot.resolve("manifest.properties").writeText(
        """
        schema=oliphaunt-runtime-resources-v1
        layout=postgres-runtime-files-v1
        cacheKey=runtime-smoke
        extensions=$extensions
        sharedPreloadLibraries=$sharedPreloadLibraries
        mobileStaticRegistryState=complete
        mobileStaticRegistryRegistered=$extensions
        mobileStaticRegistryPending=
        nativeModuleStems=$extensions
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
    return runtimeRoot.resolve("files")
}
