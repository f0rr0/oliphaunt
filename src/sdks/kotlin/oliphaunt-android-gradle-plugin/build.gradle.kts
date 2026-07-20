plugins {
    `java-gradle-plugin`
    `maven-publish`
    alias(libs.plugins.maven.publish)
}

group = providers.gradleProperty("GROUP").orElse("dev.oliphaunt").get()
version = providers.gradleProperty("VERSION_NAME").orElse("0.0.0").get()

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

tasks.processResources {
    from(file("../../../runtimes/liboliphaunt/native/include/oliphaunt.h")) {
        into("dev/oliphaunt/android")
    }
    from(file("../../rust/extension-artifact-archive-policy.properties")) {
        into("dev/oliphaunt/android")
    }
}

val extensionCatalogContractTest by tasks.registering(JavaExec::class) {
    group = "verification"
    description = "Exercises generated extension ownership and version-resolution contracts."
    dependsOn(tasks.testClasses)
    classpath = sourceSets.test.get().runtimeClasspath
    mainClass.set("dev.oliphaunt.android.OliphauntExtensionCatalogContractTest")
    jvmArgs("--add-opens=java.base/java.lang=ALL-UNNAMED")
}

tasks.check {
    dependsOn(extensionCatalogContractTest)
}

gradlePlugin {
    plugins {
        create("oliphauntAndroid") {
            id = "dev.oliphaunt.android"
            implementationClass = "dev.oliphaunt.android.OliphauntAndroidPlugin"
            displayName = "Oliphaunt Android"
            description =
                "Resolves liboliphaunt Android runtime assets and exact PostgreSQL extensions for Android apps."
        }
    }
}

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
    pom {
        name.set("Oliphaunt Android Gradle Plugin")
        description.set("App-applied Gradle plugin for liboliphaunt Android runtime and exact extension packaging.")
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
