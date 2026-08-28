package dev.oliphaunt

import kotlin.test.Test
import kotlin.test.assertEquals

class OliphauntAndroidTest {
    @Test
    fun publicConfigurationConversionSnapshotsMutableCollections() {
        val startupGucs = mutableListOf(PostgresStartupGuc("shared_buffers", "16MB"))
        val extensions = mutableListOf("pgtap")
        val converted =
            OliphauntConfig(
                startupGucs = startupGucs,
                extensions = extensions,
            ).toEngineConfig()

        startupGucs[0] = PostgresStartupGuc("work_mem", "64MB")
        extensions[0] = "vector"

        assertEquals(listOf(PostgresStartupGuc("shared_buffers", "16MB")), converted.startupGucs)
        assertEquals(listOf("pgtap"), converted.extensions)
    }
}
