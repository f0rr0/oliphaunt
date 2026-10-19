# SDK API references

Each SDK's source declarations and package documentation define its public API.
Compiler checks, protocol tests, and clean package consumers validate those APIs.
There is no separately maintained source parser or generated symbol-list gate.

| Product | Reference |
| --- | --- |
| Native C ABI | [Canonical header](../../native/runtime/include/oliphaunt.h) |
| Rust SDK | [SDK guide](../../native/sdks/rust/README.md); `cargo doc -p oliphaunt --no-deps --open` |
| Rust build support | [Build crate guide](../../native/sdks/rust/crates/oliphaunt-build/README.md) |
| TypeScript SDK | [SDK guide](../../native/sdks/ts/README.md) |
| Swift SDK | [SDK guide](../../native/sdks/swift/README.md) |
| Kotlin SDK and Gradle plugin | [SDK guide](../../native/sdks/kotlin/README.md) |
| React Native SDK and Expo plugin | [SDK guide](../../native/sdks/react-native/README.md) |
| WASIX Rust binding | [Binding guide](../../wasix/sdks/rust/README.md) |
| WASIX TypeScript binding | [Binding guide](../../wasix/sdks/ts/README.md) |
| WASIX logical tools | [Tools guide](../../wasix/postgres-tools/ts/README.md) |

Run the affected project's `build`, `test`, and `package` tasks when changing
its API, plus the relevant installed-consumer or runtime test. Package producers
copy the canonical C header into distributables; consumer compilation and
package checks exercise that boundary. There is no separate header-layout gate.
