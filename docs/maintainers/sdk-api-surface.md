# SDK API references

Each SDK's source declarations and package documentation define its public API.
Compiler checks, protocol tests, and clean package consumers validate those APIs.
There is no separately maintained source parser or generated symbol-list gate.

| Product | Reference |
| --- | --- |
| Native C ABI | [Canonical header](../../runtimes/liboliphaunt-native/include/oliphaunt.h) |
| Rust SDK | [SDK guide](../../sdks/rust/sdk/README.md); `cargo doc -p oliphaunt --no-deps --open` |
| Rust build support | [Build crate guide](../../sdks/rust/sdk/crates/oliphaunt-build/README.md) |
| TypeScript SDK | [SDK guide](../../sdks/ts/sdk/README.md) |
| Swift SDK | [SDK guide](../../sdks/swift/README.md) |
| Kotlin SDK and Gradle plugin | [SDK guide](../../sdks/kotlin/README.md) |
| React Native SDK and Expo plugin | [SDK guide](../../sdks/react-native/README.md) |
| WASIX Rust binding | [Binding guide](../../sdks/rust-wasix/README.md) |
| WASIX TypeScript binding | [Binding guide](../../sdks/ts-wasix/sdk/README.md) |
| WASIX logical tools | [Tools guide](../../postgres-tools/wasix/ts/README.md) |

Run the affected project's `build`, `test`, and `package` tasks when changing
its API, plus the relevant installed-consumer or runtime test. Package producers
copy the canonical C header into distributables; consumer compilation and
package checks exercise that boundary. There is no separate header-layout gate.
