plugins {
    id("com.android.application") version "8.11.1"
    id("org.jetbrains.kotlin.android") version "2.2.21"
}
android {
    namespace = "dev.oliphaunt.brokertest"
    compileSdk = 36
    defaultConfig { applicationId = "dev.oliphaunt.brokertest"; minSdk = 28; targetSdk = 35; versionCode = 1; versionName = "1.0" }
    sourceSets["main"].assets.srcDir(providers.gradleProperty("resources").get())
    sourceSets["main"].jniLibs.srcDir(providers.gradleProperty("nativeLibraries").get())
    packaging { jniLibs { useLegacyPackaging = true } }
}
kotlin { jvmToolchain(17) }
dependencies {
    implementation(files(providers.gradleProperty("aar").get()))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("net.java.dev.jna:jna:5.14.0@aar")
}
