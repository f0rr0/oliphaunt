# Native migration checks

Run the portable package and dependency checks on the declared Linux profile:

```sh
profile=//build_defs/native:linux_x86_64_glibc_2_28
bash tools/dev/bazel.sh test //:portable_tests \
  --platforms="$profile" --host_platform="$profile" --jobs=2
bash tools/dev/bazel.sh run //tools/bazel:conformance --jobs=2
```

The conformance command uses an isolated source copy and output base. It builds
real shared-library consumers, consumes their assembled packages, then compares
physical results with an independent scenario table and native execution logs.
It covers zero/few/many changes, different completed baselines, shared version
owners, package-only and test-only changes, deletion/rename and invalid facts.
Failed cases preserve their scratch directory and seed. Identical reruns must
execute no compiler, package or test actions.

The same isolated run constructs the real query archives and checks their
manifests and combined action graph. A major Cargo query version bump leaves
the four SDK/helper consumers on their held registry query dependency and runs
one archive action; an identical request runs no processes. Package versions,
carrier ownership and extension control metadata
must leave source and language acquisition locks unchanged.

The query consumer tests unpack the actual crate/npm archives into temporary
installations. Rust uses the registered toolchain and an isolated offline Cargo
home; Node checks both ESM and CommonJS. A nested-module fixture checks that
packaging preserves generated module and declaration paths.

Run Linux PostgreSQL, ICU, frontends, crypto, extension SQL and the Gradle
plugin contract together:

```sh
profile=//build_defs/native:linux_x86_64_glibc_2_28
bash tools/dev/bazel.sh test -c opt //:native_linux_tests \
  --platforms="$profile" --host_platform="$profile" \
  --java_runtime_version=remotejdk_17 --tool_java_runtime_version=remotejdk_17 --jobs=2
```

This profile uses declared Zig, Bison, Flex, Perl, PostgreSQL, ICU and OpenSSL
inputs. The installed smoke exercises fresh initialization,
SQL, persistence, backup/recovery, managed ICU and separate embedded/server
extension modules. Linux ARM64 and Android have separate configured targets.
Cross-compilation proves construction and binary contracts; runtime behavior
still requires the actual host or device.

Run CI's installed Rust, Node and Android package cohort locally with the same
Linux profile and optimized package construction:

```sh
profile=//build_defs/native:linux_x86_64_glibc_2_28
bash tools/dev/bazel.sh test -c opt \
  //build_defs/languages/installed:consumer_test \
  //build_defs/languages/carriers:installed_sql_test \
  //src/native/sdks/kotlin:android_maven \
  //src/native/sdks/kotlin:installed_public_api_consumer \
  //src/native/sdks/kotlin:android_test \
  //src/native/sdks/kotlin/oliphaunt-android-gradle-plugin:plugin_maven \
  //src/native/sdks/kotlin/oliphaunt-android-gradle-plugin:marker_maven \
  --platforms="$profile" --host_platform="$profile" \
  --java_runtime_version=remotejdk_17 --tool_java_runtime_version=remotejdk_17 --jobs=2
```

These tests consume the constructed archives, verify direct and broker SQL and
reopening, and check the actual installed dependency versions. Packaging-only
edits reuse the compiler outputs; unchanged requests execute zero actions.

WASIX AOT construction uses `--config=wasix-aot` to declare the Linux LLVM
execution platform. Its build tools require glibc 2.34; public native Linux
packages retain their glibc 2.28 target profile. Cross-target AOT construction
still needs deserialization and runtime checks on each supported host.

The `Native Bazel qualification` workflow uses the same Linux commands and
declared profiles, alongside native macOS/Windows SDK and installed package
checks. Those hosted checks must pass for the exact source commit. This migration
workflow does not supply publication evidence. Existing Required/Qualified and frozen
publication checks remain authoritative until every product/platform's native
construction and final carrier gate passes.

`@oliphaunt_metadata` imports existing release and extension manifests. Its
identity targets have no payload dependencies. Construction exports describe
actual output roots; their `scope: construction` cannot certify payload versions,
compatibility, complete rule/acquisition provenance or publication. The aquery
adapter requires per-product baseline deltas and reports unclassified paths.
Acquisition metadata excludes unrelated public versions, so release bumps do
not rewrite the external dependency lock.

The real query construction exports are `//src/query/rust:shipping_export` and
`//src/query/ts:shipping_export`. Their respective `:shipping_package` roots
construct the archives; exports alone record analysis metadata. Conformance
checks both actual package manifests and their action-input closures. Active
release preparation still uses the existing ownership graph; the native adapter
does not yet decide release scope.

Tool/rule repins intentionally update `MODULE.bazel.lock`:

```sh
bash tools/dev/bazel.sh mod deps --lockfile_mode=update
```

Ordinary commands verify that lock. Linux-first construction makes shared CI
failures reproducible locally; no hosted executor or cache is required. See the
[migration strategy](../../src/docs/architecture/bazel-migration-strategy.md)
for remaining product coverage and cutover gates.
