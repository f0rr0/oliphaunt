package dev.oliphaunt

import java.nio.file.Path

internal fun sharedFixtureDirectory(): String = System.getProperty("oliphaunt.sharedFixturesDir")?.takeIf(String::isNotBlank)
    ?: Path.of(
        checkNotNull(System.getenv("TEST_SRCDIR")) { "Shared fixtures require a declared test runfiles directory" },
        checkNotNull(System.getenv("TEST_WORKSPACE")),
        "src/test-fixtures",
    ).toString()

internal fun clusterSeedFixtureDirectory(): Path = System.getProperty("oliphaunt.clusterSeedFixturesDir")?.takeIf(String::isNotBlank)?.let(Path::of)
    ?: Path.of(
        checkNotNull(System.getenv("TEST_SRCDIR")) { "Cluster-seed fixtures require a declared test runfiles directory" },
        checkNotNull(System.getenv("TEST_WORKSPACE")),
        "src/database-resources/contracts/fixtures",
    )
