import groovy.json.JsonSlurper
import org.gradle.api.GradleException
import org.gradle.api.publish.maven.MavenPublication
import org.gradle.api.tasks.bundling.Jar
import java.util.Locale

plugins {
    `maven-publish`
    alias(libs.plugins.maven.publish)
}

data class OliphauntMavenLicense(
    val name: String,
    val url: String,
    val distribution: String,
)

data class OliphauntMavenArtifact(
    val groupId: String,
    val artifactId: String,
    val version: String,
    val file: File,
    val name: String,
    val description: String,
    val runtimeProduct: String?,
    val runtimeVersion: String?,
    val licenseSpdx: String,
    val licenses: List<OliphauntMavenLicense>,
)

val manifestPath =
    providers
        .gradleProperty("oliphauntMavenArtifactsManifest")
        .orElse(providers.environmentVariable("OLIPHAUNT_MAVEN_ARTIFACTS_MANIFEST"))
val repositoryRoot = rootDir.toPath().resolve("../../..").normalize().toFile()
val baseReleaseNoticeFiles =
    files(
        repositoryRoot.resolve("LICENSE"),
        repositoryRoot.resolve("THIRD_PARTY_NOTICES.md"),
    )

fun manifestFilePath(value: String): File {
    val path = File(value)
    return if (path.isAbsolute) path else repositoryRoot.resolve(value)
}

fun parseLicenses(value: String, label: String): List<OliphauntMavenLicense> {
    val parsed =
        try {
            JsonSlurper().parseText(value)
        } catch (cause: Exception) {
            throw GradleException("$label must be valid JSON", cause)
        }
    if (parsed !is List<*> || parsed.isEmpty()) {
        throw GradleException("$label must be a non-empty JSON array")
    }
    return parsed.mapIndexed { index, raw ->
        if (raw !is Map<*, *>) {
            throw GradleException("$label entry ${index + 1} must be a JSON object")
        }
        val expectedKeys = setOf("name", "url", "distribution")
        val actualKeys = raw.keys.map { it?.toString() }.toSet()
        if (actualKeys != expectedKeys) {
            throw GradleException("$label entry ${index + 1} must contain exactly $expectedKeys")
        }
        fun requiredString(key: String): String =
            (raw[key] as? String)?.takeIf { it.isNotBlank() }
                ?: throw GradleException("$label entry ${index + 1}.$key must be a non-empty string")
        OliphauntMavenLicense(
            name = requiredString("name"),
            url = requiredString("url"),
            distribution = requiredString("distribution"),
        )
    }
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
            if (parts.size != 10) {
                throw GradleException(
                    "Oliphaunt Maven artifact manifest ${path.relativeToOrSelf(rootDir)} line ${index + 1} must have 10 tab-separated fields",
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
                licenseSpdx = parts[8],
                licenses = parseLicenses(parts[9], "Oliphaunt Maven artifact manifest line ${index + 1} licenses"),
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
            val publicationName = publicationName(artifact)
            val placeholderRoot = layout.buildDirectory.dir("generated/oliphaunt-maven-artifacts/$publicationName")
            val placeholderSources = placeholderRoot.map { it.file("sources/README.md") }
            val placeholderJavadocs = placeholderRoot.map { it.file("javadoc/index.html") }
            val generatePlaceholders =
                tasks.register("${publicationName}GenerateCentralPlaceholders") {
                    outputs.files(placeholderSources, placeholderJavadocs)
                    doLast {
                        val coordinate = "${artifact.groupId}:${artifact.artifactId}:${artifact.version}"
                        placeholderSources.get().asFile.apply {
                            parentFile.mkdirs()
                            writeText("# $coordinate\n\nThis binary carrier has no source API. See https://github.com/f0rr0/oliphaunt.\n")
                        }
                        placeholderJavadocs.get().asFile.apply {
                            parentFile.mkdirs()
                            writeText("<!doctype html><meta charset=\"utf-8\"><title>$coordinate</title><p>This binary carrier has no Java API.</p>\n")
                        }
                    }
                }
            val sourcesJar =
                tasks.register<Jar>("${publicationName}SourcesJar") {
                    dependsOn(generatePlaceholders)
                    archiveBaseName.set(artifact.artifactId)
                    archiveVersion.set(artifact.version)
                    archiveClassifier.set("sources")
                    destinationDirectory.set(layout.buildDirectory.dir("oliphaunt-maven-artifacts/$publicationName"))
                    isPreserveFileTimestamps = false
                    isReproducibleFileOrder = true
                    from(placeholderSources)
                    from(baseReleaseNoticeFiles) {
                        into("META-INF")
                        filePermissions {
                            unix("0644")
                        }
                    }
                }
            val javadocJar =
                tasks.register<Jar>("${publicationName}JavadocJar") {
                    dependsOn(generatePlaceholders)
                    archiveBaseName.set(artifact.artifactId)
                    archiveVersion.set(artifact.version)
                    archiveClassifier.set("javadoc")
                    destinationDirectory.set(layout.buildDirectory.dir("oliphaunt-maven-artifacts/$publicationName"))
                    isPreserveFileTimestamps = false
                    isReproducibleFileOrder = true
                    from(placeholderJavadocs)
                    from(baseReleaseNoticeFiles) {
                        into("META-INF")
                        filePermissions {
                            unix("0644")
                        }
                    }
                }
            create<MavenPublication>(publicationName) {
                groupId = artifact.groupId
                artifactId = artifact.artifactId
                version = artifact.version
                artifact(artifact.file) {
                    extension = "tar.gz"
                }
                artifact(sourcesJar)
                artifact(javadocJar)
                pom {
                    name.set(artifact.name)
                    description.set(artifact.description)
                    val publicationProperties = mutableMapOf("oliphaunt.license.spdx" to artifact.licenseSpdx)
                    if (artifact.runtimeProduct != null && artifact.runtimeVersion != null) {
                        publicationProperties["oliphaunt.runtime.product"] = artifact.runtimeProduct
                        publicationProperties["oliphaunt.runtime.version"] = artifact.runtimeVersion
                    }
                    properties.set(publicationProperties)
                    inceptionYear.set("2026")
                    url.set("https://github.com/f0rr0/oliphaunt")
                    licenses {
                        artifact.licenses.forEach { declaredLicense ->
                            license {
                                name.set(declaredLicense.name)
                                url.set(declaredLicense.url)
                                distribution.set(declaredLicense.distribution)
                            }
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
            if (artifact.licenseSpdx.isBlank() || artifact.licenseSpdx.any { it.isISOControl() }) {
                throw GradleException(
                    "Oliphaunt Maven artifact ${artifact.groupId}:${artifact.artifactId} must declare a non-empty SPDX expression",
                )
            }
            for (license in artifact.licenses) {
                if (license.name.isBlank() || license.name.any { it.isISOControl() }) {
                    throw GradleException(
                        "Oliphaunt Maven artifact ${artifact.groupId}:${artifact.artifactId} has an invalid license name",
                    )
                }
                if (!license.url.startsWith("https://") || license.url.any { it.isISOControl() }) {
                    throw GradleException(
                        "Oliphaunt Maven artifact ${artifact.groupId}:${artifact.artifactId} license URLs must use HTTPS",
                    )
                }
                if (license.distribution != "repo") {
                    throw GradleException(
                        "Oliphaunt Maven artifact ${artifact.groupId}:${artifact.artifactId} licenses must use distribution=repo",
                    )
                }
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
