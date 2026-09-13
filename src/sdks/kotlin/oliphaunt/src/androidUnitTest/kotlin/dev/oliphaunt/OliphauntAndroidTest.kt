package dev.oliphaunt

import java.util.Properties
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OliphauntAndroidTest {
    @Test
    fun publicConfigurationConversionSnapshotsMutableCollections() {
        val startupGucs = mutableMapOf("shared_buffers" to "16MB")
        val extensions = mutableListOf(ExtensionDescriptor("pgtap", "oliphaunt-extension-pgtap", "1.3.4"))
        val converted =
            OliphauntConfig(
                startupGucs = startupGucs,
                extensions = extensions,
            ).toEngineConfig()

        startupGucs["shared_buffers"] = "64MB"
        extensions[0] = ExtensionDescriptor("vector", "oliphaunt-extension-vector", "0.8.2")

        assertEquals(listOf(PostgresStartupGuc("shared_buffers", "16MB")), converted.startupGucs)
        assertEquals(listOf("pgtap"), converted.extensions)
    }

    @Test
    fun selectedResourcesKeepDependenciesAndRejectVersionSubstitution() {
        val selected = selectedExtensionClosure(setOf("earthdistance", "vector"))
        assertTrue("cube" in selected)
        assertTrue(includeSelectedRuntimeFile("lib/postgresql/vector.so", selected, false))
        assertTrue(includeSelectedRuntimeFile("share/postgresql/extension/cube--1.5.sql", selected, false))
        assertFalse(includeSelectedRuntimeFile("share/postgresql/extension/hstore.control", selected, false))
        assertFalse(includeSelectedRuntimeFile("lib/postgresql/hstore.so", selected, false))
        assertFalse(includeSelectedRuntimeFile("share/icu/icudt.dat", selected, false))
        val receipt = Properties().apply {
            setProperty("schema", "oliphaunt-sdk-resources-v1")
            setProperty("extension.vector.product", "oliphaunt-extension-vector")
            setProperty("extension.vector.version", "0.8.2")
        }
        OliphauntAndroidRuntimeAssets.validateSelectedResourceReceipt(
            receipt,
            listOf(ExtensionDescriptor("vector", "oliphaunt-extension-vector", "0.8.2")),
            null,
        )
        assertFailsWith<OliphauntException> {
            OliphauntAndroidRuntimeAssets.validateSelectedResourceReceipt(
                receipt,
                listOf(ExtensionDescriptor("vector", "oliphaunt-extension-vector", "0.8.3")),
                null,
            )
        }
    }
}
