plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

val consumerAar = providers.gradleProperty("oliphauntConsumerAar").orNull
    ?: error("oliphauntConsumerAar must point to the packaged Oliphaunt Android AAR")

layout.buildDirectory.set(
    file(
        providers.gradleProperty("oliphauntConsumerBuildRoot").orNull
            ?: error("oliphauntConsumerBuildRoot must point to a scratch directory"),
    ),
)

android {
    namespace = "dev.oliphaunt.consumer"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "consumer.pro")
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(files(consumerAar))
    implementation(libs.kotlinx.coroutines.core)
}

tasks.register("checkMinifiedCallbacks") {
    val callbackMapping = layout.buildDirectory.file("outputs/mapping/release/mapping.txt")
    dependsOn("assembleRelease")
    inputs.file(callbackMapping)
    doLast {
        val callbacks = callbackMapping.get().asFile.readLines().filter { "int " in it && it.endsWith(" -> onChunk") }
        check(callbacks.isNotEmpty()) {
            "R8 removed or renamed the JNI stream callback: $callbacks"
        }
    }
}
