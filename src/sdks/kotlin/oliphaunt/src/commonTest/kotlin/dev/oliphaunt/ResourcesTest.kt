package dev.oliphaunt

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ResourcesTest {
    @Test
    fun descriptorsValidateIdentityAndDeduplicateExactVersions() {
        val vector = ExtensionDescriptor("vector", "oliphaunt-extension-vector", "0.8.2")
        val contrib = Extensions.PG_TRGM
        assertEquals(listOf(vector, contrib), selectedExtensionDescriptors(listOf(vector, contrib, vector)))
        assertEquals("0.2.0-rc.1+build.2", IcuData("0.2.0-rc.1+build.2").version)
        assertFailsWith<IllegalArgumentException> {
            selectedExtensionDescriptors(listOf(vector, vector.copy(version = "0.8.3")))
        }
        for (sqlName in listOf("", "../vector", "Vector", "vector;")) {
            assertFailsWith<IllegalArgumentException> { vector.copy(sqlName = sqlName) }
        }
        for (product in listOf("", "vector", "oliphaunt-extension-../vector")) {
            assertFailsWith<IllegalArgumentException> { vector.copy(product = product) }
        }
        assertFailsWith<IllegalArgumentException> { vector.copy(version = null) }
        for (version in listOf("", "latest", "0.2", "../0.2.0")) {
            assertFailsWith<IllegalArgumentException> { vector.copy(version = version) }
            assertFailsWith<IllegalArgumentException> { IcuData(version) }
        }
    }

    @Test
    fun selectionIncludesDependenciesAndFiltersOnlyUnselectedResources() {
        val selected = selectedExtensionClosure(listOf("earthdistance", "vector", "earthdistance"))
        assertEquals(setOf("earthdistance", "cube", "vector"), selected)
        assertFailsWith<OliphauntException> { selectedExtensionClosure(listOf("unknown")) }
        for (file in listOf("vector.so", "cube.dylib", "plpgsql.so")) {
            assertTrue(includeSelectedRuntimeFile("lib/postgresql/$file", selected, false))
        }
        for (file in listOf("vector.control", "cube--1.5.sql", "earthdistance.sql", "unknown.control")) {
            assertTrue(includeSelectedRuntimeFile("share/postgresql/extension/$file", selected, false))
        }
        for (file in listOf("lib/postgresql/hstore.so", "share/postgresql/extension/hstore.control", "share/icu", "share/icu/icudt76l.dat")) {
            assertFalse(includeSelectedRuntimeFile(file, selected, false))
        }
        assertTrue(includeSelectedRuntimeFile("share/icu/icudt76l.dat", selected, true))
        assertTrue(includeSelectedRuntimeFile("share/postgresql/postgres.bki", selected, false))
    }
}
