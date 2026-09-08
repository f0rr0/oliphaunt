# SDK API references

Each SDK's source declarations and package documentation define its public API.
Compiler checks, protocol tests, and clean package consumers validate those APIs.
There is no separately maintained source parser or generated symbol-list gate.

| Product | Reference |
| --- | --- |
| Native C ABI | [Canonical header](../../src/runtimes/liboliphaunt/native/include/oliphaunt.h) |
| Rust SDK | [SDK guide](../../src/sdks/rust/README.md); `cargo doc -p oliphaunt --no-deps --open` |
| Rust build support | [Build crate guide](../../src/sdks/rust/crates/oliphaunt-build/README.md) |
| TypeScript SDK | [SDK guide](../../src/sdks/js/README.md) |
| Swift SDK | [SDK guide](../../src/sdks/swift/README.md) |
| Kotlin SDK and Gradle plugin | [SDK guide](../../src/sdks/kotlin/README.md) |
| React Native SDK and Expo plugin | [SDK guide](../../src/sdks/react-native/README.md) |
| WASIX Rust binding | [Binding guide](../../src/bindings/wasix-rust/crates/oliphaunt-wasix/README.md) |
| WASIX TypeScript binding | [Binding guide](../../src/bindings/wasix-ts/README.md) |
| WASIX logical tools | [Tools guide](../../src/bindings/wasix-ts/tools-package/README.md) |

Run the affected project's `compile`, `unit`, and `package` Moon tasks when
changing its API. Published C-header copies must match the canonical header;
`moon run liboliphaunt-native:headers` checks that boundary.
