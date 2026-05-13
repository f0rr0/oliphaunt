# SDKs

Language SDKs live here and follow the native package structure for their
ecosystem.

- `swift/`: Swift package over `libpglite`.
- `kotlin/`: Kotlin/Android Gradle project over `libpglite`.
- `react-native/`: React Native New Architecture module, expected to reuse the
  Swift/Kotlin native layers where practical.

The Rust SDK is canonical for now and lives in `crates/libpglite-oxide`.
