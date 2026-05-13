# Kotlin SDK

Future home of the Kotlin and Android SDK for `libpglite`.

Target shape:

```text
sdks/kotlin/
├── settings.gradle.kts
├── build.gradle.kts
├── libpglite-kotlin/
└── libpglite-android/
```

The Gradle build should be multi-project from the start so JVM desktop, Android,
and shared test utilities stay isolated while sharing native artifact metadata.
