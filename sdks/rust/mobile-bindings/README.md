# Mobile native bindings

Private UniFFI adapter for the Swift and Kotlin SDKs. It uses the existing Rust
SDK owner, shared native ABI bindings and request cancellation. It has no public
registry version or separate release. Runtime binaries and database resources
remain separate inputs.

Run `cargo build --lib` or `bash tools/generate.sh` here. Generation writes Swift
and Kotlin source under `target/mobile-bindings/generated`; generated files are
not maintained source. Cross-compile the library with ordinary Cargo targets
and the platform linker. Android outputs retain 16 KiB page alignment.

For Android, install the required Rust target, set `ANDROID_NDK_HOME`, and run
`bash tools/build-android.sh arm64-v8a` (or the requested ABI). It uses API 24,
matching the Kotlin SDK minimum, and writes ordinary Cargo target outputs.
The Swift owner assembles its supported Apple slices with
`bash sdks/swift/tools/build-bindings-xcframework.sh` from the workspace root;
that command requires Xcode and the corresponding Rust targets.

Swift wraps a generated request with `withTaskCancellationHandler`; UniFFI does
not propagate Swift task cancellation itself. Kotlin carries the caller's Job
across its existing noncancellable admission wrapper. Both target the individual
Rust request and await its confirmed outcome. Unsubmitted cancellation leaves
SQL untouched; completed protocol bytes retain their ReadyForQuery boundary.
The ordinary database `cancel` method separately targets current database work.

The Swift and Kotlin SDKs now use this bridge. Linux validates their generated
facades against real PostgreSQL and builds Android AARs; actual Apple framework
and mobile device execution remain platform qualification gates.

The adapter source is MIT licensed. Compiled mobile libraries include dependencies under MIT, ISC, Unicode-3.0, BSD-3-Clause, and MPL-2.0. Platform packages carry the selected target’s exact license texts and an inventory with source-download URLs under `THIRD_PARTY_LICENSES/rust`. UniFFI is used unmodified; its MPL-2.0 source remains available through those pinned package URLs. The six UniFFI registry crates omit LICENSE, so the contract includes the full upstream file from their recorded source commit.

Run `moon run oliphaunt-mobile-bindings:dependency-license-audit` to compare every released target’s normal Cargo graph with the pinned source and license inventory. No platform compiler is needed for that audit.
