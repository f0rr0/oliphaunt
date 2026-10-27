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

Run Linux PostgreSQL, ICU, frontends, crypto and extension SQL together:

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

Installed SDK checks also consume the completed dependencies declared by their
manifests. With an existing GitHub CLI login, acquire their source-bound public
input snapshot once:

```sh
inputs_root="$(mktemp -d)"
public_inputs="$(GH_TOKEN="$(gh auth token)" bash tools/release/with-source.sh HEAD \
  bash tools/dev/bun.sh tools/release/native-release-preparation.mts \
  --publication-inputs --output-directory "$inputs_root/public")"
```

Only acquisition receives the credential; Bazel receives the snapshot path. CI
acquires this snapshot once before its producer jobs. Reuse it for the following
installed-package checks with the same Linux profile and optimized construction:

```sh
profile=//build_defs/native:linux_x86_64_glibc_2_28
bash tools/dev/bazel.sh test -c opt \
  //build_defs/languages/installed:consumer_test \
  //build_defs/languages/carriers:installed_sql_test \
  //src/native/rust-bindings:unit_test \
  //build_defs/native/carriers:package_test \
  //src/native/runtime:npm \
  //src/native/runtime:installed_cargo_test \
  //src/native/postgres-tools:cargo_facade \
  //src/native/postgres-tools:installed_cargo_test \
  //src/native/postgres-tools:installed_carrier_test \
  //build_defs/resources:resource_contract_test \
  //src/database-resources:linux_resource_test \
  //src/database-resources:android_datum64_standard_carriers \
  //src/database-resources:android_datum64_icu_carriers \
  //src/native/sdks/react-native:source_consumer_test \
  //src/native/sdks/react-native:lifecycle_test \
  //src/examples/native/react-native-expo:autolinking_consumer_test \
  //src/native/sdks/kotlin:android_maven \
  //src/native/sdks/kotlin:installed_public_api_consumer \
  //src/native/sdks/kotlin:android_test \
  //src/native/sdks/kotlin/oliphaunt-android-gradle-plugin:contract_test \
  //src/native/sdks/kotlin/oliphaunt-android-gradle-plugin:plugin_maven \
  //src/native/sdks/kotlin/oliphaunt-android-gradle-plugin:marker_maven \
  --repo_env=OLIPHAUNT_NATIVE_PUBLICATION_INPUTS="$public_inputs" \
  --platforms="$profile" --host_platform="$profile" \
  --java_runtime_version=remotejdk_17 --tool_java_runtime_version=remotejdk_17 --jobs=2
```

These tests consume the constructed archives, verify direct and broker SQL and
reopening, and check the actual installed dependency versions. Packaging-only
edits reuse the compiler outputs; unchanged requests execute zero actions.
The resource tests reopen the exact frozen seed bytes with the candidate Linux
runtime. Android carrier construction checks actual configured runtime ABI
receipts; device execution remains a separate qualification requirement.

WASIX AOT construction uses `--config=wasix-aot` to declare the Linux LLVM
execution platform. Its build tools require glibc 2.34; public native Linux
packages retain their glibc 2.28 target profile. Cross-target AOT construction
still needs deserialization and runtime checks on each supported host.

Construct the four Linux x64 AOT images and exercise the Rust and TypeScript SDKs
locally, reusing the public input snapshot above:

```sh
sdk_cache="$(mktemp -d)"
bash tools/dev/bazel.sh test --config=wasix-aot \
  //src/wasix/runtime:aot_linux_x64_gnu_payload \
  //src/wasix/sdks/rust:postgres_regression_test \
  //src/wasix/sdks/ts:installed_host_test \
  --repo_env=OLIPHAUNT_NATIVE_PUBLICATION_INPUTS="$public_inputs" \
  --platforms=//build_defs/native:linux_x86_64_glibc_2_28 \
  --host_platform=//build_defs/native:linux_x86_64_glibc_2_28 --jobs=1 --local_test_jobs=1 \
  --test_env=OLIPHAUNT_WASM_AOT_VERIFY=full \
  --test_env=XDG_CACHE_HOME="$sdk_cache" --test_env=RUST_TEST_THREADS=1
```

With Chrome or Chromium installed, run the same actual browser consumer locally:

```sh
profile=//build_defs/native:linux_x86_64_glibc_2_28
receipt_dir="$(mktemp -d)"
chrome_binary="$(bash tools/dev/bun.sh build_defs/wasix/browser/chrome-receipt.mts \
  "$receipt_dir/chrome-host.json" local-linux unmanaged)"
bash tools/dev/bazel.sh run --config=wasix-aot //src/wasix/sdks/ts:browser_sql_consumer \
  --platforms="$profile" --host_platform="$profile" --jobs=2 \
  -- "$chrome_binary" "$receipt_dir/chrome-host.json"
```

The local labels identify an unmanaged workstation. The receipt records and
rechecks the actual browser executable SHA, version, kernel and OS release hash.
CI supplies its runner image/version labels through the same helper. This test
installs the constructed SDK/query/runtime archives, executes both default and
worker exports, and qualifies OPFS persistence, synchronous Worker transport and
crash recovery against the declared standard seed. It preserves its scratch
directory and receipts on failure.

The `Native Bazel qualification` workflow uses the same Linux commands and
declared profiles, alongside native macOS/Windows SDK and installed package
checks. Its authenticated construction evidence binds original final archives,
configured production inputs and required tests to the exact source commit.
The native release entrypoints consume this evidence and reject incomplete
product/platform coverage. Frozen installed consumers and publication readiness
remain separate gates. The migration still requires complete hosted qualification
and the seed adoption anchor before retiring legacy CI; a passing local command
or an individual platform job cannot authorize publication.

Shared construction stays on Linux to reproduce CI locally. macOS/Windows jobs
provide licensed SDK construction and native execution where required. Cross-host
consumers receive exact final archives with their source, target and hash receipts
through GitHub artifacts. Apple package exports and their macOS/iOS ABI consumers
share one job and compiler base, running alongside the native macOS host checks
and final carriers. Each job saves its own bounded action cache; a cache miss
does not change its required requests or evidence. The WASIX producer captures
complete core, contrib and tools Cargo families from actual shipping roots;
native host jobs download that producing job's immutable
artifact ID and require the checkout commit to match its source receipt. The importer
verifies each archive and compiles its extracted Rust sources and build script.
macOS, Windows and Linux ARM64 then run the same seven SDK SQL scenarios without
requesting Linux WASIX or AOT producers. This is a matching-source construction
handoff; it does not select historical published versions or admit a release.
Foreign-host execution and full carrier coverage must pass before cutover. No remote
executor is needed for this handoff.

The Node-API release build compiles the workspace Rust SDK and embeds the
constructed core and contrib payloads. Linux constructs those payloads once;
other hosts consume the original captured archives. Cargo path/version
requirements and the addon's exact npm compatibility metadata describe these
relationships. The public Rust SDK's minimum runtime requirement can remain
held while the addon embeds a newer compatible runtime.

Reproduce an imported Linux SDK consumer using a captured directory locally:

```sh
profile=//build_defs/native:linux_x86_64_glibc_2_28
inputs=/absolute/path/to/wasix-cargo-construction
source_commit="$(git rev-parse HEAD)"
sdk_cache="$(mktemp -d)"
bash tools/dev/bazel.sh test //src/wasix/sdks/rust:postgres_regression_test \
  --platforms="$profile" --host_platform="$profile" \
  --repo_env=OLIPHAUNT_WASIX_CARGO_INPUTS="$inputs" \
  --repo_env=OLIPHAUNT_WASIX_SOURCE_COMMIT="$source_commit" \
  --jobs=2 --local_test_jobs=1 \
  --test_env=OLIPHAUNT_WASM_AOT_VERIFY=full \
  --test_env=XDG_CACHE_HOME="$sdk_cache" --test_env=RUST_TEST_THREADS=1
```

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
checks both actual package manifests and their action-input closures.
`tools/release/prepare-release-pr.sh` invokes native release preparation. It
compares authenticated deliveries with each product's completed publication,
closes necessary compatibility adoption and passes those selected owners to
Release Please for version calculation. Missing historical facts block a decision;
the old ownership graph is not a fallback selector.

Compiled external WASIX extensions first link against their declared completed
runtime. When that floor equals the workspace runtime version, source
qualification can also prove that new imports require the current core. It
records both physical inputs and the missing exports. Preparation uses this
proof to retarget a necessary extension/runtime release pair; it does not select
either product solely from ABI reachability. Generated release trees require
the final exact host and cannot use this source probe as publication evidence.

Tool/rule repins intentionally update `MODULE.bazel.lock`:

```sh
bash tools/dev/bazel.sh mod deps --lockfile_mode=update
```

Ordinary commands verify that lock. See the
[migration strategy](../../src/docs/architecture/bazel-migration-strategy.md)
for remaining product coverage and cutover gates.
