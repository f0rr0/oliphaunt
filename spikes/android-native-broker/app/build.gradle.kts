plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "dev.oliphaunt.androidbrokerspike"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.oliphaunt.androidbrokerspike"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"

        testInstrumentationRunner = "android.test.InstrumentationTestRunner"
    }

    buildFeatures {
        aidl = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":oliphaunt"))
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.core)
    testImplementation(kotlin("test"))
}
