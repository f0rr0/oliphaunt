import org.gradle.api.GradleException
import org.gradle.api.publish.maven.MavenPublication
import java.util.Locale

plugins {
    `maven-publish`
    alias(libs.plugins.maven.publish)
}

data class OliphauntMavenArtifact(
    val groupId: String,
    val artifactId: String,
    val version: String,
    val file: File,
    val name: String,
    val description: String,
    val runtimeProduct: String?,
    val runtimeVersion: String?,
)

val manifestPath =
    providers
        .gradleProperty("oliphauntMavenArtifactsManifest")
        .orElse(providers.environmentVariable("OLIPHAUNT_MAVEN_ARTIFACTS_MANIFEST"))
val repositoryRoot = rootDir.toPath().resolve("../../..").normalize().toFile()

fun manifestFilePath(value: String): File {
    val path = File(value)
    return if (path.isAbsolute) path else repositoryRoot.resolve(value)
}

fun parseArtifactManifest(path: File): List<OliphauntMavenArtifact> {
    if (!path.isFile) {
        throw GradleException("Oliphaunt Maven artifact manifest is missing: $path")
    }
    val rows =
        path.readLines(Charsets.UTF_8)
            .filter { it.isNotBlank() && !it.startsWith("#") }
    if (rows.isEmpty()) {
        throw GradleException("Oliphaunt Maven artifact manifest is empty: $path")
    }
    val artifacts =
        rows.mapIndexed { index, line ->
            val parts = line.split('\t')
            if (parts.size != 8) {
                throw GradleException(
                    "Oliphaunt Maven artifact manifest ${path.relativeToOrSelf(rootDir)} line ${index + 1} must have 8 tab-separated fields",
                )
            }
            val file = manifestFilePath(parts[3])
            OliphauntMavenArtifact(
                groupId = parts[0],
                artifactId = parts[1],
                version = parts[2],
                file = file,
                name = parts[4],
                description = parts[5],
                runtimeProduct = parts[6].ifBlank { null },
                runtimeVersion = parts[7].ifBlank { null },
            )
        }
    val duplicateCoordinates =
        artifacts
            .groupBy { "${it.groupId}:${it.artifactId}:${it.version}" }
            .filterValues { it.size > 1 }
            .keys
            .sorted()
    if (duplicateCoordinates.isNotEmpty()) {
        throw GradleException("Oliphaunt Maven artifact manifest contains duplicate coordinates: $duplicateCoordinates")
    }
    return artifacts
}

fun publicationName(artifact: OliphauntMavenArtifact): String =
    artifact.artifactId
        .split('-', '_', '.')
        .filter { it.isNotBlank() }
        .joinToString("") { segment ->
            segment.replaceFirstChar { char ->
                if (char.isLowerCase()) char.titlecase(Locale.ROOT) else char.toString()
            }
        }
        .replaceFirstChar { char -> char.lowercase(Locale.ROOT) }

val oliphauntArtifacts = manifestPath.orNull?.let { parseArtifactManifest(file(it)) }.orEmpty()

mavenPublishing {
    publishToMavenCentral(automaticRelease = true)
    if (
        gradle.startParameter.taskNames.any { it.contains("MavenCentral", ignoreCase = true) } ||
        providers.gradleProperty("signAllPublications").map {
            it.equals("true", ignoreCase = true) || it.equals("yes", ignoreCase = true) || it == "1"
        }.orElse(false).get()
    ) {
        signAllPublications()
    }
}

publishing {
    publications {
        oliphauntArtifacts.forEach { artifact ->
            create<MavenPublication>(publicationName(artifact)) {
                groupId = artifact.groupId
                artifactId = artifact.artifactId
                version = artifact.version
                artifact(artifact.file) {
                    extension = "tar.gz"
                }
                pom {
                    name.set(artifact.name)
                    description.set(artifact.description)
                    if (artifact.runtimeProduct != null && artifact.runtimeVersion != null) {
                        properties.set(
                            mapOf(
                                "oliphaunt.runtime.product" to artifact.runtimeProduct,
                                "oliphaunt.runtime.version" to artifact.runtimeVersion,
                            ),
                        )
                    }
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
                        developerConnection.set("scm:git:ssh://git@github.com:f0rr0/oliphaunt.git")
                    }
                }
            }
        }
    }
}

tasks.register("validateOliphauntMavenArtifacts") {
    if (manifestPath.isPresent) {
        inputs.file(manifestPath)
    }
    oliphauntArtifacts.forEach { artifact ->
        inputs.file(artifact.file)
    }
    doLast {
        if (oliphauntArtifacts.isEmpty()) {
            throw GradleException(
                "Set -PoliphauntMavenArtifactsManifest or OLIPHAUNT_MAVEN_ARTIFACTS_MANIFEST before publishing Oliphaunt Maven artifact packages.",
            )
        }
        for (artifact in oliphauntArtifacts) {
            if (!artifact.groupId.matches(Regex("[A-Za-z0-9_.-]+"))) {
                throw GradleException("Invalid Maven groupId: ${artifact.groupId}")
            }
            if (!artifact.artifactId.matches(Regex("[A-Za-z0-9_.-]+"))) {
                throw GradleException("Invalid Maven artifactId: ${artifact.artifactId}")
            }
            if (!artifact.version.matches(Regex("[A-Za-z0-9_.-]+"))) {
                throw GradleException("Invalid Maven version for ${artifact.groupId}:${artifact.artifactId}: ${artifact.version}")
            }
            if (!artifact.file.isFile) {
                throw GradleException("Missing Maven artifact file for ${artifact.groupId}:${artifact.artifactId}: ${artifact.file}")
            }
            if (!artifact.file.name.endsWith(".tar.gz")) {
                throw GradleException("Oliphaunt Maven artifact ${artifact.file} must be a .tar.gz file")
            }
            if ((artifact.runtimeProduct == null) != (artifact.runtimeVersion == null)) {
                throw GradleException(
                    "Oliphaunt Maven artifact ${artifact.groupId}:${artifact.artifactId} must declare both runtime product and version or neither",
                )
            }
            if (artifact.groupId == "dev.oliphaunt.extensions" &&
                (artifact.runtimeProduct != "liboliphaunt-native" ||
                    artifact.runtimeVersion?.matches(Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")) != true)
            ) {
                throw GradleException(
                    "Oliphaunt Maven extension artifact ${artifact.artifactId} must bind an exact stable liboliphaunt-native runtime version",
                )
            }
        }
    }
}

tasks.matching { it.name.startsWith("publish") }.configureEach {
    dependsOn("validateOliphauntMavenArtifacts")
}
