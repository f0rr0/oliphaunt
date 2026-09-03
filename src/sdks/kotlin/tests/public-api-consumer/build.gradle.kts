plugins {
    alias(libs.plugins.android.library)
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
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(files(consumerAar))
}
