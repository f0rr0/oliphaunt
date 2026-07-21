pluginManagement {
    repositories {
        google()
        maven {
            name = "GoogleCloudMavenCentralMirror"
            url = uri("https://maven-central.storage-download.googleapis.com/maven2/")
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        maven {
            name = "GoogleCloudMavenCentralMirror"
            url = uri("https://maven-central.storage-download.googleapis.com/maven2/")
        }
        mavenCentral()
    }
}

val oliphauntBuildRoot =
    providers.gradleProperty("oliphauntBuildRoot")
        .orElse(providers.environmentVariable("OLIPHAUNT_GRADLE_BUILD_ROOT"))
        .orNull
        ?.takeIf(String::isNotBlank)

if (oliphauntBuildRoot != null) {
    val buildRoot = file(oliphauntBuildRoot)
    gradle.beforeProject {
        val slug = if (path == ":") "root" else path.removePrefix(":").replace(':', '/')
        layout.buildDirectory.set(buildRoot.resolve(slug))
    }
}

rootProject.name = "oliphaunt-kotlin"
include(":oliphaunt")
include(":oliphaunt-android-gradle-plugin")
include(":oliphaunt-maven-artifacts")
