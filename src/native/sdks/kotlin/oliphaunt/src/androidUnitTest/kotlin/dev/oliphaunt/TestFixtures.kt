package dev.oliphaunt

import java.nio.file.Path

internal fun sharedFixtureDirectory(): String =
    System.getProperty("oliphaunt.sharedFixturesDir")?.takeIf(String::isNotBlank)
        ?: Path.of(
            checkNotNull(System.getenv("TEST_SRCDIR")) { "Shared fixtures require a declared test runfiles directory" },
            checkNotNull(System.getenv("TEST_WORKSPACE")),
            "src/test-fixtures",
        ).toString()
