# Native Bazel migration coverage inventory

Status: verified source inventory for the [proposed migration](bazel-migration-strategy.md), not active implementation.
Audited: 2026-10-11. Owner: repository maintainers.

Baseline: main `8316eb419999f47d6d4a61a8444e6c5ef32caf46`, tree `91138aa6cc458471d81769e9d6543a1e3f99f0dc`. Workspace `a43b10770ae0e843fe26b2dddc460c9db5cef981` has the identical tracked tree. Versions below are observed baseline values, not installation recommendations or proposed PR #294 versions.

## Verified counts and scope

| Inventory | Verified count | Evidence / scope |
|---|---:|---|
| Independent release products | 27 | Actual `loadPublicationCatalog()` and `loadProducts()` output |
| Declared registry identities | 265 | 121 Cargo + 119 npm + 25 Maven; identity minima, not an exhaustive dynamic frozen-candidate count |
| Moon projects | 56 | Actual pinned Moon project query |
| Release / other Moon projects | 27 / 29 | Resolved `project.metadata.release` |
| Configured task entries | 303 | Raw per-project `config.tasks` counts |
| Resolved task entries | 407 | Pinned Moon task graph, including inherited configuration |
| GitHub workflows / job declarations / composite actions | 8 / 83 / 15 | Before matrix expansion; 64 CI jobs and ten release jobs |
| Tracked Cargo manifests | 39 | 1 root workspace + 38 crate manifests |
| Root Cargo workspace members | 28 | Root `Cargo.toml` |
| Tracked npm manifests | 44 | Includes private applications and carrier templates |
| Tracked Swift manifests | 3 | Root, Swift SDK, public API consumer fixture |
| Gradle Kotlin DSL manifests | 6 builds + 3 settings | SDK producer, plugin, carrier renderer and two consumer fixtures; additional React Native Groovy Gradle files also exist |
| Exact SQL extension members | 39 | 32 PostgreSQL contrib + 7 external, actual generated extension catalog |
| Existing Bazel configuration | None located | No tracked `MODULE.bazel`, BUILD or `.bzl` configuration returned in the manifest search |

The 265 count excludes GitHub archives, the Swift source tag/release tree, and generated Cargo `-part-NNN` identities. The final publication lock, rather than this static count, must enumerate every physical artifact. Catalog target strings include ecosystem aliases; do not count `darwin-arm64` and `macos-arm64` as two machines.

## Coverage workstreams

These codes identify workstreams, not sequential cutover steps or permission to omit a surface. Follow the numbered gates in the migration strategy:

- **F: foundation:** Bzlmod/toolchains/platforms, pinned source acquisition, shared contract/source/file targets, test runners, artifact providers and inventory checks.
- **L: language libraries:** Rust/TypeScript implementation, shared unpublished tools, pure tests, source SDK build and package rendering.
- **N: native production:** PostgreSQL/OpenSSL/ICU builds, native runtimes/tools/extensions, platform prebuilds and resources.
- **W: WASIX production:** WASIX compiler/sysroot, portable modules, AOT, browser host and independent postmaster producer.
- **M: mobile and applications:** UniFFI, Swift/Kotlin/Android/iOS/React Native, real app integration, examples, browser/desktop performance and docs.
- **P: promotion integration:** exact-source CI outputs, installed frozen consumers, publication lock, existing protected publisher/recovery and docs refresh.

An independently versioned product can span workstreams. A non-release target can contribute bytes to several independently versioned products. Each product's final package root must name its own constructed outputs; the shared producer itself must not acquire an invented SemVer.

## All 27 release products

Registry columns are counts of declared Cargo/npm/Maven identities. `0` never means a product has no public artifacts.

| Product / current version | Path | Cargo / npm / Maven | Required Bazel build / package roots and proofs | Workstream |
|---|---|---:|---|---|
| `database-resources` 0.2.2 | `src/database-resources` | 15 / 15 / 3 | ICU data, native/WASIX standard and ICU cluster-seed producers; per-profile/per-target immutable resources; Cargo/npm/Maven rendering; metadata plus installed resource/profile identity checks | F,N,W,M,P |
| `liboliphaunt-native` 0.3.3 | `src/native/runtime` | 9 / 9 / 5 | Patched PostgreSQL/native C ABI, desktop dynamic runtime, Android ABI outputs, iOS XCFramework; runtime resources and owned native contrib facade/leaves; C/ABI/SQL/installed carrier checks | F,N,M,P |
| `liboliphaunt-native-bindings` 0.2.0 | `src/native/rust-bindings` | 1 / 0 / 0 | Rust source library, unit/integration targets and Cargo source envelope; reused source compilation in broker/addons/mobile must be explicit edges | L,N,P |
| `liboliphaunt-wasix` 0.3.2 | `src/wasix/runtime` | 10 / 2 / 0 | Shared C compiler output, portable runtime, host AOT modules; portable/AOT Cargo leaves and owned WASIX contrib facade/leaves; runtime/export/serializer/installed checks | F,W,P |
| `liboliphaunt-wasix-postmaster` 0.1.1 | `src/wasix/postmaster` | 0 / 0 / 0 | Separate patched PostgreSQL/Wasmer/libc/sysroot, sealed core, executor/compiler and host AOT carrier; GitHub-only sealed-postmaster archives; concurrency/recovery/export-contract tests | F,W,P |
| `oliphaunt-query` 0.1.1 | `src/query/rust` | 1 / 0 / 0 | Rust query encoding/decoding/types, Cargo source package, library/unit/consumer tests | L,P |
| `oliphaunt-query-ts` 0.1.1 | `src/query/ts` | 0 / 1 / 0 | TS library, ESM/CommonJS plus types, npm envelope/export tests | L,P |
| `postgres-tools-native` 0.2.2 | `src/native/postgres-tools` | 5 / 5 / 0 | PostgreSQL `pg_dump`/`pg_basebackup`/`psql` binaries and dynamic dependency closure from native producer, Cargo/npm facade/leaves, GitHub archives; executable/backup/restore/tool checks | N,P |
| `oliphaunt-broker` 0.3.1 | `src/native/broker` | 5 / 4 / 0 | Distinct Rust broker library and executable targets; host helper binary packages; Cargo facade plus four Cargo/npm helpers; socket/process/application tests. Mobile library consumers do not consume `main.rs` | L,N,P |
| `oliphaunt-extension-pg-hashids` 0.3.2 | `src/extensions/external/pg_hashids` | 10 / 10 / 2 | Pinned upstream/recipe, native dynamic/mobile static and portable/AOT producers; generated ecosystem facade/leaves, host descriptors, SQL lifecycle plus installed compositions | F,N,W,M,P |
| `oliphaunt-extension-pg-ivm` 0.3.2 | `src/extensions/external/pg_ivm` | 10 / 10 / 2 | Same family with its own source/patch/target support and preload/lifecycle rules | F,N,W,M,P |
| `oliphaunt-extension-pg-textsearch` 0.3.2 | `src/extensions/external/pg_textsearch` | 10 / 10 / 2 | Same family with its own compiled module and target/static-registry contract | F,N,W,M,P |
| `oliphaunt-extension-pg-uuidv7` 0.3.2 | `src/extensions/external/pg_uuidv7` | 10 / 10 / 2 | Same family with its own upstream pin and lifecycle fixture | F,N,W,M,P |
| `oliphaunt-extension-pgtap` 0.3.2 | `src/extensions/external/pgtap` | 6 / 6 / 2 | SQL-only resource package; native/mobile/portable targets require resource assembly, not invented C compilation or AOT module leaves; SQL installed checks | F,N,W,M,P |
| `oliphaunt-extension-postgis` 0.3.2 | `src/extensions/external/postgis` | 10 / 10 / 2 | PostGIS and its GEOS/PROJ/libxml2/libiconv/json-c/SQLite pinned dependencies; native/static/portable/AOT modules and additional SQL data/load order; independently packaged product | F,N,W,M,P |
| `oliphaunt-extension-vector` 0.3.2 | `src/extensions/external/vector` | 10 / 10 / 2 | Own source and all declared target recipes; carrier descriptor and installed SDK+extension SQL execution | F,N,W,M,P |
| `oliphaunt-kotlin` 0.3.3 | `src/native/sdks/kotlin` | 0 / 0 / 3 | Generated UniFFI Kotlin/JNI; Android AAR/POM/sources/javadoc, plugin JAR/POM/module/sources/javadoc, marker POM; signing at publication. Android/public-API/broker-app/resource acquisition tests; no Android module or extra KMP/JVM coordinates | L,N,M,P |
| `oliphaunt-node-direct` 0.2.2 | `src/native/node-addon` | 0 / 4 / 0 | Unpublished Rust cdylib producer, four Node-API `.node` platform leaves and GitHub archives, adapter dependency closure; separately loaded native runtime compatibility and Node/Bun/Deno installed SDK composition proofs | L,N,P |
| `oliphaunt-swift` 0.8.2 | `src/native/sdks/swift` | 0 / 0 / 0 | Generated UniFFI Swift/FFI + native bindings, Swift modules, public Package.swift/source tag, XCFramework/resources, frozen extension generator/catalog; empty default extension set and separately owned opt-in carriers; macOS/public API/iOS installed app proofs | L,N,M,P |
| `oliphaunt-wasix-rust` 0.3.2 | `src/wasix/sdks/rust` | 1 / 0 / 0 | Rust SDK and optional dump CLI/tool feature, published Cargo source package; runtime/ABI/SDK feature and installed composition checks | L,W,P |
| `oliphaunt-js` 0.3.1 | `src/native/sdks/ts` | 0 / 1 / 0 | TS source/library/default native and broker topology, npm envelope plus preserved conventional pins; Node/Bun/Deno and Electron/Tauri installed consumers | L,N,M,P |
| `oliphaunt-pgwire-server` 0.2.1 | `src/wasix/pgwire-server` | 1 / 0 / 0 | Rust library, feature-gated CLI, source crate, socket/client and SDK composition tests | L,W,P |
| `oliphaunt-react-native` 0.3.2 | `src/native/sdks/react-native` | 0 / 1 / 0 | TS API, C++ JSI/TurboModule/codegen, Android Kotlin/JNI and iOS Swift/podspec/template integration, Expo plugin/package; Android/iOS real app build/e2e plus installer/resource checks | L,N,M,P |
| `oliphaunt-rust` 0.3.2 | `src/native/sdks/rust` | 2 / 0 / 0 | Separate published `oliphaunt` SDK and `oliphaunt-build` helper roots sharing one product version; features/build scripts/runtime-resource CLI; actual staged native carrier pins and installed extension execution | L,N,P |
| `oliphaunt-wasix-napi` 0.2.1 | `src/wasix/node-addon` | 0 / 4 / 0 | Unpublished Rust cdylib producer, platform Node-API leaves, embedded WASIX runtime/tools/resources and provenance; four platform packages + GitHub archives | L,W,P |
| `oliphaunt-wasix-ts` 0.2.2 | `src/wasix/sdks/ts` | 0 / 1 / 0 | Universal SDK: browser Worker/Wasmer JS/WASM plus native N-API paths; source npm package with host machinery, browser and Node/Bun/Deno installed checks | L,W,M,P |
| `postgres-tools-wasix` 0.2.4 | `src/wasix/postgres-tools` | 5 / 6 / 0 | Portable tool modules, per-host AOT tool leaves, Cargo/npm facade/leaves and public TS wrapper from nested `ts/`; CLI, browser/Node SDK tool consumers | L,W,M,P |

Product registration must continue to include registry-free products (Swift/postmaster), and products with no physical checked-in carrier source directory (all generated facade/leaves). Product versions are not Bazel target versions or language crate versions by default.

## All 29 non-release Moon projects

| Existing project | Path | Existing role / task surface | Bazel ownership and verification role | Workstream |
|---|---|---|---|---|
| `artifact-packaging` | `tools/packaging` | Deterministic archive/manifest/license/carrier helpers; unit tests | Executable/library tool targets with declared runfiles; archive/cargo/npm/Maven generators consumed by product package actions; independent tests. Writer changes can affect owned deliverables, validator changes affect proofs | F,L,P |
| `benchmarks` | `src/benchmarks` | SQL fixtures, comparison baselines/report shape; no direct tasks | Data filegroups for consumers, explicitly separate measurement inputs from public production inputs | F,M |
| `ci-tools` | `tools/ci` | Current Moon-to-hosted-job planning, transfer and unit tests | Port necessary capability/host routing and proof tests; replace task selection/cache/transfer inference with Bazel targets/actions/remote cache; remove obsolete Moon adapters after all surfaces migrate | F,P |
| `ci-workflows` | `.github` | Workflow/security/cache/setup checks and LLVM installer unit tests | Retain security/admission and actual setup/toolchain contracts; delete tests of retired Moon, Docker and nested Cargo cache/setup bodies. Preserve GitHub permissions/environments/credentials orchestration outside build actions | F,P |
| `cluster-seed-contract` | `src/database-resources/contracts` | Standard/ICU seed + portable ICU identity formats and negative fixtures | Shared contract/data targets and tests consumed by resource producer and actual SDK installers | F,N,W,M |
| `dev-tools` | `tools/dev` | Pinned acquisition, tool bootstrap/hooks/smoke/mobile setup tests | Repository/module extensions and declared toolchains for build dependencies; local setup/hook `bazel run` utilities where useful; setup tests remain genuine tests | F,M |
| `docs` | `src/docs` | Next/Fumadocs generate/typecheck/build/static smoke/live metadata tools; dev server | Next/TS action graph, explicit authored/generated content inputs, static export artifact and smoke tests; snapshot completed releases as explicit input. Dev server runnable. Vercel trigger/live check remain uncached protected operations | L,M,P |
| `extension-artifacts-native` | `src/extensions/artifacts/native` | Native target producers and native packager/Rust unit checks | Per-extension/per-target action outputs plus artifact-contract tests; split compiler output from archive assembly; artifacts owned by external products or runtime contrib owners | N,M |
| `extension-artifacts-wasix` | `src/extensions/artifacts/wasix` | WASIX extension compiler output, portable package and AOT build | Declared compiler/sysroot/configured PostgreSQL headers/providers/module dependencies, separate portable and per-execution-platform AOT outputs | W |
| `extension-packages` | `src/extensions/artifacts/packages` | Ecosystem envelopes, mobile carriers, carrier validator/unit tests | Package roots per owner/configuration, generated manifest/assets providers; generated public crates/npm/Maven/Swift envelopes are not an independently versioned tool product | F,N,W,M,P |
| `extension-runtime-contract` | `src/extensions/contracts` | Runtime/extension contract TOML, target profiles, archive policy, validators | Contract filegroups/tool libraries and tests; used by actual loaders and package generators, not a second installed-version authority | F,N,W,M |
| `extensions` | `src/extensions` | Catalog generation, generated SDK/build/mobile/docs tables, license audits/lint/unit checks | Explicit generation actions from catalog/source/recipe inputs; generated outputs/providers and consistency tests. Distinguish build generation from runtime fixtures/proof tables | F,N,W,M |
| `integration-examples` | `src/examples` | Browser typecheck; Expo Android/iOS build/e2e/drills; shared harness tests | Separate application and integration-test targets per application/host; device/browser resources explicit; do not aggregate examples into product shipping ownership | L,M,P |
| `native-extension-lifecycle` | `src/extensions/tests/native` | Unpublished Rust extension proof; lifecycle and unit tests | Rust test/executable target observing constructed native SDK/runtime/extensions and SQL fixtures; never a shipping owner | N,P |
| `native-packaging` | `src/native/runtime/packaging` | Unpublished Rust `oliphaunt-resources` binary; Rust/TS tests/typecheck | Tool binary with typed resource/archive inputs, declared generated outputs and contract/unit tests; package writer is part of consumer artifacts' construction closure | F,L,N,M |
| `native-tools-proof` | `src/native/postgres-tools/tests` | Unpublished Rust cross-product SDK/server/tool conformance | Integration test target observing tool executable facade, server/socket/backup fixtures and SDK; does not own an independent release | N,P |
| `oliphaunt-extension-contrib-pg18` | `src/extensions/contrib` | 32 contrib declarations, PostgreSQL18 source linkage; no independent release | Logical bundle/data/producer targets; native and WASIX physical carriers inherit their runtime owners. Do not create a new versioned Bazel product | F,N,W,M,P |
| `oliphaunt-mobile-bindings` | `src/native/mobile-bindings` | Private Rust staticlib/cdylib and bindgen binary; UniFFI generation/native tests/license audit | Rust library configured for desktop/Android/Apple ABIs, host executable tool, generated Swift/Kotlin/FFI outputs; actual bytes ship in SDKs despite `publish=false` | L,N,M |
| `oliphaunt-wasix-tools-ts` | `src/wasix/postgres-tools/ts` | Public `@oliphaunt/wasix-tools` build/package/tests, no independent product version | TS library/npm package output root assigned to `postgres-tools-wasix`; conventional requirements preserved; CLI/browser installed tests | L,W,M,P |
| `perf-tools` | `src/benchmarks/perf` | Private Rust runner; native/Node/browser measurement, planner validation, lint | Runner/benchmark tools and plan unit tests; explicit manual/uncached measurement run targets and report outputs. PGlite/SQLite comparison dependencies belong to benchmark graph | L,M |
| `postgres18` | `src/third-party/postgres` | Source pin/checksum/shared patch set; no compile task itself | Pinned external repository/source target with patches; actual runtime and CLI target consumers both represented | F,N,W |
| `release-tools` | `tools/release` | Private Release Please library/tooling, metadata/graph/pin/check tests; protected controllers and verifiers | TS tool libraries/executables and tests; migrate input discovery/producer enumeration to declared Bazel providers; retain versions, frozen bytes, journal/reconciliation, credential and promotion boundaries | F,L,P |
| `repo` | `.` | Workspace/root metadata, JS format/lint, hooks and shared task groups | Root metadata/check/file targets; language dependency lockfiles and toolchains declaratively connected; keep formatting separate from shipping output invalidation | F,L |
| `shared-test-fixtures` | `src/test-fixtures` | Canonical protocol/storage/postgres/extension SQL files; no direct tasks | Shared test `data` filegroups, consumed by actual tests only unless a specific package deliberately ships a fixture | F,N,W,M |
| `source-inputs` | `src/third-party/tools` | Neutral source acquisition for native/WASIX/postmaster/extensions/ICU-data plus fetch tests | Bzlmod/module/repository acquisition with immutable URLs/commits/checksums; build actions consume declared extracted/patch outputs and have no opportunistic fetch; preserve bounded transport/extraction tests | F,N,W |
| `third-party-icu` | `src/third-party/icu` | ICU implementation pin; contract/fetch unit test | Pinned implementation repository and native/WASIX build toolchain/source targets; separate ICU data source under `database-resources/icu/source.toml` | F,N,W |
| `third-party-openssl` | `src/third-party/openssl` | OpenSSL implementation pin; no direct tasks | Pinned source repository and actual native/WASIX compiled library consumers | F,N,W |
| `wasix-browser-host` | `src/wasix/browser-host` | Patched Wasmer JS/WASIX/virtual-fs/virtual-mio build producing JS/Worker/WASM | Native Rust→WASM, matching wasm-bindgen, Binaryen and Rollup action outputs with pinned acquisition/toolchains; produced host artifacts explicitly consumed and shipped by WASIX TS SDK | F,L,W,M |
| `xtask` | `src/wasix/runtime/tools/xtask` | Private Rust build/generator utilities; AOT serializer typecheck and unit/lint checks | Host Rust executable/tool library plus generators and serializer contract tests; consumed by runtime/extensions/resources producers without creating runtime release merely for unrelated tool tests | F,L,W |

## Cargo manifests and private crates: complete group coverage

The root workspace has 28 members. Ten other crate manifests have isolated `[workspace]` roots, and root itself is the 39th manifest. Native carrier crates and example/postmaster crates must not accidentally be made root members or forced to share one Cargo feature set.

| Group / count of crate manifests | Paths or exact crate names | Publication / Bazel treatment |
|---|---|---|
| Public source libraries/SDKs/CLI, 7 | `src/query/rust`, `src/native/rust-bindings`, `src/native/broker`, `src/native/sdks/rust`, `src/native/sdks/rust/crates/oliphaunt-build`, `src/wasix/sdks/rust`, `src/wasix/pgwire-server` | Native Rust library/binary/test actions with explicit feature configurations; separate source package envelopes owned by catalog products |
| Resource/tool facade crates, 2 | `src/database-resources/icu/cargo`, `src/native/postgres-tools/crates/tools` | Rust source glue + immutable payload providers; packaging/build.rs resolver checks |
| Broker platform crate templates, 4 | `src/native/broker/crates/{linux-arm64-gnu,linux-x64-gnu,macos-arm64,windows-x64-msvc}` | Isolated Cargo source packages include generated binaries; no independent product version |
| Private checkout templates for public WASIX crates, 10 | Runtime `crates/assets` + four `crates/aot/*`; tools `crates/tools` + four `crates/aot/*` | `publish=false` protects checkout. Staged rendered crates are public catalog carriers; generate full source/build.rs/payload manifests and optional dynamic parts |
| Private production/tools/proofs, 11 | `oliphaunt-wasix-seed-producer`, `oliphaunt-mobile-bindings`, `oliphaunt-node-direct`, `oliphaunt-wasix-napi`, `oliphaunt-perf`, `oliphaunt-native-extension-proof`, `oliphaunt-native-packaging`, `oliphaunt-native-tools-proof`, `xtask`, `oliphaunt-wasix-postmaster-executor`, `oliphaunt-wasix-sealed-export-closure` | Private does not imply nonshipping: mobile/static/addon/postmaster producer outputs ship. Bench/proof/tools themselves remain private. Executor Cargo.lock is independent of root and sealer |
| Isolated app/consumer crates, 4 | `src/examples/native/tauri/src-tauri`, `src/examples/wasix/tauri/src-tauri`, `src/examples/wasix/electron/src-wasix`, `src/native/sdks/rust/tests/release-consumer` | Explicit app/test roots preserving actual installed versus checkout dependency resolution; Tauri build.rs/generated contexts and WASIX Electron sidecar included |

The postmaster executor manifest exposes four separately feature-gated binaries: product executor, product compiler, start-proof tool and memory-profile tool. The compiler is an execution tool while the executor is a release payload; feature constraints must not be collapsed into one generic Rust binary.

## npm, Swift, Gradle and C/C++ coverage

| Surface | Complete grouping and migration requirement |
|---|---|
| 44 npm manifests | 10 private repository/docs/release/perf/example apps; 2 private addon producer roots; 5 public TS/library/SDK roots; 1 public ICU resource package; 21 native/helper/addon platform or tool facade templates; 5 private WASIX tools carrier templates that render public carriers. Depend on final rendered manifest identity, not `private` or directory name |
| Root npm workspace | `package.json` + `bun.lock`: broad Bun workspace, dependency catalogs, overrides/trustedDependencies and pinned Bun. Private Electron/Tauri apps are not all root workspace members; their independent install closure matters. No new ad-hoc package resolver |
| 3 Swift manifests | Root `Package.swift`, `src/native/sdks/swift/Package.swift`, `src/native/sdks/swift/Tests/PublicApiConsumer/Package.swift`. Six public libraries: COliphaunt, Oliphaunt, OliphauntCore, OliphauntBroker, OliphauntBrokerExtension, OliphauntExtensionSupport. Generated FFI/native bindings also exist. Checkout manifest points at local generated `.build` outputs; published source-tree manifest is rendered differently. Preserve actual SwiftPM install/tag contract |
| Kotlin/Gradle | `src/native/sdks/kotlin` root, `oliphaunt` Android AAR, Java Android Gradle plugin and marker, `oliphaunt-maven-artifacts` renderer for runtime/resources/extensions; `tests/public-api-consumer`, `tests/broker-app`; wrapper JAR/properties/version catalog. Consumer plugin behavior is part of shipped product API even when producer uses Bazel |
| React Native | `src/native/sdks/react-native` source package: TS/C++ codegen/TurboModule/JSI, Android Groovy Gradle + JNI CMake, iOS podspecs/Swift integration, Expo plugin/templates. Preserve consumer Gradle/CocoaPods/RN codegen paths; Bazel producer cannot replace external consumers' conventional entrypoints |
| Native C/C++ | Native runtime C ABI/headers and patched PostgreSQL; native shared/CLI dependency libraries; Kotlin and RN JNI/CMake C++ sources; mobile static registries; Windows DLL/MSVC redistributable closure. Compile and binary/package ABI checks are distinct targets |
| Legal sources | Root `LICENSE`, `THIRD_PARTY_NOTICES.md`, product notices/upstream license data and generated THIRD_PARTY_LICENSES trees are actual package inputs. Explicit artifact action inputs; don't globally ignore Markdown |
| Generated carriers with no checked-in `src/` | Native runtime Cargo leaves, resource seeds, extension facades/native/portable/AOT leaves, dynamic Cargo split parts, npm platform packages, Maven POM/JAR/AAR and Swift resource source trees. Give the package generator declared outputs/provider metadata; don't invent source directories |

Conventional distribution manifests stay first-class outputs and consumer contracts. A Bazel implementation library need not be named/versioned like every package carrier, and private build libraries must not be mistaken for private installed packages.

## Non-product artifacts and operational paths that must not disappear

| Surface | Paths / outputs | Build, verification and operations |
|---|---|---|
| Native Electron example | `src/examples/native/electron` | TS main/renderer+Vite build; actual SDK/helper/tools/contrib installed closure; GUI/browser harness and broker SQL/tool scenarios. Private application, no product release |
| WASIX Electron example | `src/examples/wasix/electron`, nested `src-wasix` Rust sidecar | Independent JS install/build plus Rust sidecar binary; host application topology and pgwire integration; Electron target/ABI separate from Node source typecheck |
| Native Tauri example | `src/examples/native/tauri`, nested `src-tauri` | Frontend + Rust Tauri build.rs app context, WebDriver app staging/test harness; native SDK/extensions/resources/tools installed composition |
| WASIX Tauri example | `src/examples/wasix/tauri`, nested `src-tauri` | Frontend + Rust WASIX SDK/server topology, independent consumer manifests; actual WebDriver app execution |
| Browser example | `src/examples/wasix/browser` | Vite app, Worker/host WASM/static assets, browser smoke/integration and benchmark variants; cross-origin/runtime headers are meaningful test inputs |
| Expo example | `src/examples/native/react-native-expo` | Android/iOS generated app roots, extension staging, APK/IPA/app/simulator artifacts, real device/emulator test receipts, smoke/drill/crash/benchmark modes; local dev servers remain runnable operations |
| Performance | `src/benchmarks/{native/sql,wasix}` and `src/benchmarks/perf` | Private Rust native/PostgreSQL/SQLite runner and Node/browser WASIX/PGlite comparisons; result JSON/reports not immutable product artifacts; validate plans in CI, measurements explicitly uncached/manual with host information |
| Docs export | `src/docs` → `target/docs/build`, `target/docs/generated/routes.json`, generated Markdown/LLM/search/static assets | Published website is public though npm package is private. Explicit generator/build/static smoke targets; published-release snapshot an explicit external input. Ordinary docs source edits don't release SDKs |
| Docs refresh/deployment | `.github/workflows/release.yml:request-docs-refresh`, `src/docs/tools/request-refresh.sh`, `verify-live.mts` | Protected Vercel deploy hook after full promotion; completed product snapshot and live site evidence. Hook acceptance is not deployment success. Retry docs operation independently from publication; keep outside cacheable builds |
| Main/PR/device CI | `.github/workflows/ci.yml`, `mobile-e2e.yml`, hosted reusable producer workflows/actions | Bazel owns target construction/check graph; GitHub owns host allocation, device lifecycle, exact-source/protected context and artifact attestation/evidence. Required/Qualified semantics and causal failed-run diagnosis must survive |
| Frozen release transaction | `tools/release` + `.github/workflows/release.yml` | Candidate, exhaustive publication lock, consumer proof, original SHA/tree, transport tag, staged archives and approved capsule remain. Bazel output collection replaces Moon artifact transfer; immutable publication/recovery must not rebuild or substitute source |
| Installed/public consumers | Product-owned `tools/frozen-consumer*`, tests/public API fixtures, `tools/release/frozen-consumer.mts`, `public-consumer-smoke.mts` | Distinct staged package resolver checks and anonymous postpublication registry checks. Running Bazel source tests cannot replace genuine Cargo/npm/SwiftPM/Gradle consumer resolution |
| Source acquisition | `src/third-party/tools`, all `source.toml` and postmaster `sources/*.toml`, `src/wasix/browser-host/source.toml`, extension-owned dependency pins | Immutable acquisition/checksum/patch/extraction outputs with declared repository ownership; product-specific pins retained. No action fetches undeclared current network state |
| Developer/bootstrap workflow | `tools/dev`, `.prototools`, `.moon/toolchains.yml`, `.moon/tasks`, `rust-toolchain.toml`, setup GitHub actions | Pin toolchains/runners/build images/native SDKs and migrate users' commands/hooks; remove obsolete Moon/proto/bootstrap duplication only after equivalent local and hosted paths work |

## Configuration and target surfaces

- **Desktop:** Linux x86_64/aarch64 GNU, macOS arm64, Windows x86_64 MSVC. npm aliases are darwin/win32, Cargo aliases are Rust triples; preserve one normalized platform identity with rendered ecosystem names.
- **Native mobile:** Android arm64-v8a and x86_64; iOS XCFramework is an aggregate artifact, not one architecture. iOS device/simulator component selection and macOS consumer execution need explicit configuration, not host OS guessing.
- **WASIX:** Portable producer modules and host-specific AOT serialization are different outputs/configurations. WASIX portable extension runtime and shared AOT serializer ABI/toolchain rules stay explicit.
- **Postmaster:** Its declared release targets are Linux arm64/x64 and macOS arm64. It has a separate patched Wasmer/libc/source closure, independent locks, executor/compiler and concurrency qualification. Do not inherit ordinary WASIX Windows support.
- **Extension resources:** SQL-only pgtap and contrib resource sets do not require compiled modules solely because other extensions do. Extension target support remains catalog/recipe-driven, not assumed from runtime support.
- **Database profiles:** Standard versus ICU, native platform/mobile datum64 versus WASIX seeds, shared ICU data versus ICU compiled library. Profile/resource identity must survive producer and consumer tests.
- **SDK/runtime modes:** Rust feature gates, Node/Bun/Deno/browser placements, native direct/broker/server topology, RN generated/native configs, Swift module/resource variants. A single broad all-features build does not prove each shipped mode.
- **Tools vs targets:** Host compilers/generators/bindgen/Wasmer serializers and target libraries/binaries require distinct execution/target platforms. Downloaded compiler images/sysroots/toolchain pins are inputs.

## Minimal complete Bazel ownership requirements

1. Every compiled/generated output has one producer action and declared inputs. Product package roots consume producers, version/manifests, legal files and resource providers. Tests consume outputs and fixtures without becoming package prerequisites or output owners.
2. Each of the 27 release roots exports an exhaustive artifact manifest/provider. Enforce one owner for all 265 declared registry identities plus every dynamically generated part/GitHub/source-tag artifact. A private or absent checkout source directory does not exempt a carrier.
3. Keep public Cargo/npm/Gradle/SwiftPM contracts conventional. Source-native Bazel build dependencies describe actual checkout compilation; rendered installed requirements describe historical/candidate package resolution. Never infer one from the other.
4. Source/upstream pins are immutable repository/module inputs. Network/secret/device/publication/live-docs operations are explicit uncached run/hosted operations, not hidden cacheable action effects.
5. Cut over by dependency families but require all 56 rows and the non-product surfaces above before deleting Moon. A collection of shell/cargo/gradle wrappers with broad repository inputs is a transition harness, not a complete native Bazel migration.
6. Verify through independent inventory equality, real file-change expected-impact fixtures, actual rendered envelope contents/resolution, platform/feature installed consumers, and end-to-end frozen-candidate/recovery tests. A Bazel graph query proves declared reachability; sandboxed clean execution and actual consumers provide evidence that declarations are complete.

This inventory was validated against the actual catalog and resolved projects. No producer builds or hosted qualification were run for the audit. Native rule implementations and toolchain feasibility require execution evidence at the strategy's acceptance gates.

## Every existing workflow job

These are source job IDs before matrix expansion. The strategy's workflow disposition table states what replaces their construction, proof, or operational role. Existing aggregator names are not a requirement to retain separate jobs.

| Workflow | Complete current job set |
| --- | --- |
| `broker-runtime.yml` | `build` |
| `ci.yml` | `affected`, `release-intent`, `check-targets`, `policy-targets`, `checks`, `test-targets`, `tests`, `extension-artifacts-native-linux`, `extension-artifacts-native-android-static`, `extension-artifacts-native-android`, `extension-artifacts-native-ios`, `extension-artifacts-native-other`, `extension-artifacts-native`, `extension-artifacts-wasix`, `extension-packages`, `mobile-extension-packages-android`, `mobile-extension-packages-ios`, `mobile-extension-packages`, `liboliphaunt-native-desktop-linux`, `liboliphaunt-native-desktop-other`, `liboliphaunt-native-desktop`, `liboliphaunt-native-android`, `liboliphaunt-native-ios`, `liboliphaunt-native-android-abi`, `liboliphaunt-native-ios-abi`, `liboliphaunt-native-release-assets`, `rust-sdk-package`, `broker-runtime-linux`, `broker-runtime-other`, `broker-runtime`, `node-direct`, `broker-release-assets`, `node-direct-release-assets`, `wasix-napi`, `wasix-napi-release-assets`, `swift-bindings`, `swift-sdk-package`, `kotlin-sdk-package`, `kotlin-maven-staging`, `react-native-sdk-package`, `js-sdk-package`, `native-consumers`, `wasix-ts-package`, `wasix-ts-sdk-package`, `wasix-rust-package`, `liboliphaunt-wasix-runtime`, `wasix-host-linux`, `wasix-host-other`, `liboliphaunt-wasix-aot`, `liboliphaunt-wasix-release-assets`, `wasix-postmaster-portable`, `wasix-postmaster-target`, `wasix-postmaster`, `native-extension-lifecycle`, `native-extension-lifecycle-aggregate`, `wasix-release-regression`, `mobile-build-android`, `mobile-build-ios`, `builds`, `mobile-e2e-android`, `mobile-e2e-ios`, `e2e`, `required`, `qualified` |
| `extension-artifacts-native.yml` | `build` |
| `liboliphaunt-native-desktop.yml` | `build` |
| `mobile-e2e.yml` | `resolve`, `android`, `ios`, `required` |
| `mobile-extension-packages.yml` | `package` |
| `release.yml` | `validate-inputs`, `prepare-release-pr`, `plan-candidate`, `request-qualification`, `prepare-candidate`, `frozen-consumers`, `publication-ready`, `publish-bootstrap`, `publish`, `request-docs-refresh` |
| `wasix-host.yml` | `build` |

## Every composite action

These are all 15 current action directories under `.github/actions`. Operational setup can survive only for its stated external role; compilation inputs move into registered toolchains.

| Current action | Final role |
| --- | --- |
| `setup-moon` | Delete after all construction and operational tool entrypoints migrate |
| `setup-node-runtime`, `setup-bun`, `setup-node-bun`, `setup-deno` | Declared build/test runtimes; narrow remaining controller/device setup uses the same pins |
| `setup-rust`, `setup-rust-tools` | Native Rust/tool/test rules; retain exact conventional Cargo tooling for installed consumers |
| `setup-swift` | Declared Swift compiler; conventional SwiftPM remains an installed-consumer test tool |
| `setup-apple` | Exact Xcode/SDK registration and device facilities; remove ambient Homebrew production dependencies |
| `setup-android` | Explicit SDK/NDK/JVM compile toolchains; keep emulator/ADB/KVM/licensing operations |
| `setup-msvc` | Register observed exact MSVC/Windows SDK; no invisible PATH-only production contract |
| `setup-wasmer-llvm` | Pinned repository/toolchain dependency replaces installer/cache setup |
| `setup-wasix-builder` | Remove Docker Buildx construction engine; pinned Linux execution environment is registered infrastructure |
| `setup-npm-publisher` | Retain trusted-publishing client/auth readiness at protected mutation boundary |
| `run-mobile-e2e` | Retain shared fresh installed-app harness with exact app digest and no build fallback |

## Every CI-tagged task assignment

The 84 rows map existing task-to-CI-group assignments to source owners. These labels are proposed migration references, not implemented BUILD targets or a requirement for one target per Moon task. The strategy's [minimal verification policy](bazel-migration-strategy.md#minimal-checks-tests-and-builds) governs what survives: delete tests of retired machinery, merge repeated guarantees and retain distinct consumer/trust contracts. Inherited checks and untagged developer/tool tasks are covered by the 56-project inventory and the 407-entry resolved task snapshot; each must have a surviving owner, native replacement guarantee or justified deletion before Moon removal.

| Current CI group | Current task | Proposed source-local native label | Native role |
| --- | --- | --- | --- |
| `broker-release-assets` | `oliphaunt-broker:finalize-release-assets` | `//src/native/broker:finalize-release-assets` | replace in-place finalizer with pure declared archive/index output |
| `broker-runtime` | `oliphaunt-broker:build-release-assets` | `//src/native/broker:build-release-assets` | native production action/output |
| `extension-artifacts-native` | `extension-artifacts-native:build-target` | `//src/extensions/artifacts/native:build-target` | native production action/output |
| `extension-artifacts-wasix` | `extension-artifacts-wasix:build-target` | `//src/extensions/artifacts/wasix:build-target` | native production action/output |
| `extension-packages` | `extension-packages:package` | `//src/extensions/artifacts/packages:package` | native production action/output |
| `js-sdk-package` | `database-resources:package-icu` | `//src/database-resources:package-icu` | native production action/output |
| `js-sdk-package` | `oliphaunt-js:package` | `//src/native/sdks/ts:package` | native production action/output |
| `js-sdk-package` | `oliphaunt-query-ts:package` | `//src/query/ts:package` | native production action/output |
| `js-sdk-package` | `oliphaunt-wasix-tools-ts:package` | `//src/wasix/postgres-tools/ts:package` | native production action/output |
| `kotlin-maven-staging` | `oliphaunt-kotlin:maven-staging` | `//src/native/sdks/kotlin:maven-staging` | native production action/output |
| `kotlin-sdk-package` | `oliphaunt-kotlin:package` | `//src/native/sdks/kotlin:package` | native production action/output |
| `liboliphaunt-native-android` | `liboliphaunt-native:build-runtime-android-arm64-v8a` | `//src/native/runtime:build-runtime-android-arm64-v8a` | native production action/output |
| `liboliphaunt-native-android` | `liboliphaunt-native:build-runtime-android-x86_64` | `//src/native/runtime:build-runtime-android-x86_64` | native production action/output |
| `liboliphaunt-native-android` | `liboliphaunt-native:package-runtime-android-arm64-v8a` | `//src/native/runtime:package-runtime-android-arm64-v8a` | native production action/output |
| `liboliphaunt-native-android` | `liboliphaunt-native:package-runtime-android-x86_64` | `//src/native/runtime:package-runtime-android-x86_64` | native production action/output |
| `liboliphaunt-native-android-abi` | `database-resources:build-native-android-icu` | `//src/database-resources:build-native-android-icu` | native production action/output |
| `liboliphaunt-native-android-abi` | `database-resources:build-native-android-standard` | `//src/database-resources:build-native-android-standard` | native production action/output |
| `liboliphaunt-native-android-abi` | `liboliphaunt-native:finalize-runtime-android-abi` | `//src/native/runtime:finalize-runtime-android-abi` | replace in-place finalizer with pure declared archive/index output |
| `liboliphaunt-native-desktop` | `database-resources:build-native-icu` | `//src/database-resources:build-native-icu` | native production action/output |
| `liboliphaunt-native-desktop` | `database-resources:build-native-standard` | `//src/database-resources:build-native-standard` | native production action/output |
| `liboliphaunt-native-desktop` | `liboliphaunt-native:package-runtime-desktop-target` | `//src/native/runtime:package-runtime-desktop-target` | native production action/output |
| `liboliphaunt-native-desktop` | `liboliphaunt-native:test-artifacts-desktop-target` | `//src/native/runtime:test-artifacts-desktop-target` | test-only native consumer/check |
| `liboliphaunt-native-desktop` | `postgres-tools-native:package-assets` | `//src/native/postgres-tools:package-assets` | native production action/output |
| `liboliphaunt-native-desktop` | `postgres-tools-native:test-assets` | `//src/native/postgres-tools:test-assets` | test-only native consumer/check |
| `liboliphaunt-native-ios` | `liboliphaunt-native:build-runtime-ios-xcframework` | `//src/native/runtime:build-runtime-ios-xcframework` | native production action/output |
| `liboliphaunt-native-ios` | `liboliphaunt-native:package-runtime-ios-xcframework` | `//src/native/runtime:package-runtime-ios-xcframework` | native production action/output |
| `liboliphaunt-native-ios-abi` | `database-resources:build-native-ios-icu` | `//src/database-resources:build-native-ios-icu` | native production action/output |
| `liboliphaunt-native-ios-abi` | `database-resources:build-native-ios-standard` | `//src/database-resources:build-native-ios-standard` | native production action/output |
| `liboliphaunt-native-ios-abi` | `liboliphaunt-native:finalize-runtime-ios-abi` | `//src/native/runtime:finalize-runtime-ios-abi` | replace in-place finalizer with pure declared archive/index output |
| `liboliphaunt-native-release-assets` | `liboliphaunt-native:release-assets` | `//src/native/runtime:release-assets` | replace in-place finalizer with pure declared archive/index output |
| `liboliphaunt-wasix-aot` | `extension-artifacts-wasix:build-aot` | `//src/extensions/artifacts/wasix:build-aot` | native production action/output |
| `liboliphaunt-wasix-aot` | `liboliphaunt-wasix:runtime-aot` | `//src/wasix/runtime:runtime-aot` | native production action/output |
| `liboliphaunt-wasix-aot` | `oliphaunt-pgwire-server:test-aot` | `//src/wasix/pgwire-server:test-aot` | test-only native consumer/check |
| `liboliphaunt-wasix-aot` | `oliphaunt-pgwire-server:test-integration` | `//src/wasix/pgwire-server:test-integration` | test-only native consumer/check |
| `liboliphaunt-wasix-aot` | `oliphaunt-wasix-rust:test-aot` | `//src/wasix/sdks/rust:test-aot` | test-only native consumer/check |
| `liboliphaunt-wasix-aot` | `postgres-tools-wasix:build-aot` | `//src/wasix/postgres-tools:build-aot` | native production action/output |
| `liboliphaunt-wasix-aot` | `postgres-tools-wasix:package-aot` | `//src/wasix/postgres-tools:package-aot` | native production action/output |
| `liboliphaunt-wasix-release-assets` | `liboliphaunt-wasix:release-assets` | `//src/wasix/runtime:release-assets` | replace in-place finalizer with pure declared archive/index output |
| `liboliphaunt-wasix-runtime` | `database-resources:build-wasix-icu` | `//src/database-resources:build-wasix-icu` | native production action/output |
| `liboliphaunt-wasix-runtime` | `database-resources:build-wasix-standard` | `//src/database-resources:build-wasix-standard` | native production action/output |
| `liboliphaunt-wasix-runtime` | `extension-artifacts-wasix:compiler-output` | `//src/extensions/artifacts/wasix:compiler-output` | native production action/output |
| `liboliphaunt-wasix-runtime` | `liboliphaunt-wasix:runtime-portable` | `//src/wasix/runtime:runtime-portable` | native production action/output |
| `liboliphaunt-wasix-runtime` | `postgres-tools-wasix:compiler-output` | `//src/wasix/postgres-tools:compiler-output` | native production action/output |
| `liboliphaunt-wasix-runtime` | `postgres-tools-wasix:package-portable` | `//src/wasix/postgres-tools:package-portable` | native production action/output |
| `mobile-build-android` | `integration-examples:react-native-android-build` | `//src/examples:react-native-android-build` | native production action/output |
| `mobile-build-ios` | `integration-examples:react-native-ios-build` | `//src/examples:react-native-ios-build` | native production action/output |
| `mobile-extension-packages` | `extension-packages:package-mobile` | `//src/extensions/artifacts/packages:package-mobile` | native production action/output |
| `native-consumers` | `oliphaunt-broker:test-consumer` | `//src/native/broker:test-consumer` | test-only native consumer/check |
| `native-consumers` | `oliphaunt-js:test-consumer` | `//src/native/sdks/ts:test-consumer` | test-only native consumer/check |
| `native-consumers` | `oliphaunt-js:test-consumer-published` | `//src/native/sdks/ts:test-consumer-published` | test-only native consumer/check |
| `native-consumers` | `oliphaunt-kotlin:test-native-bindings` | `//src/native/sdks/kotlin:test-native-bindings` | test-only native consumer/check |
| `native-consumers` | `oliphaunt-mobile-bindings:test-native` | `//src/native/mobile-bindings:test-native` | test-only native consumer/check |
| `native-consumers` | `oliphaunt-rust:test-consumer-runtime` | `//src/native/sdks/rust:test-consumer-runtime` | test-only native consumer/check |
| `native-consumers` | `oliphaunt-rust:test-integration` | `//src/native/sdks/rust:test-integration` | test-only native consumer/check |
| `native-consumers` | `oliphaunt-swift:test-native` | `//src/native/sdks/swift:test-native` | test-only native consumer/check |
| `native-extension-lifecycle` | `native-extension-lifecycle:lifecycle` | `//src/extensions/tests/native:lifecycle` | test-only native consumer/check |
| `node-direct` | `oliphaunt-node-direct:build-release-assets` | `//src/native/node-addon:build-release-assets` | native production action/output |
| `node-direct` | `oliphaunt-node-direct:qualify` | `//src/native/node-addon:qualify` | test-only native consumer/check |
| `node-direct-release-assets` | `oliphaunt-node-direct:finalize-release-assets` | `//src/native/node-addon:finalize-release-assets` | replace in-place finalizer with pure declared archive/index output |
| `react-native-sdk-package` | `oliphaunt-react-native:package` | `//src/native/sdks/react-native:package` | native production action/output |
| `react-native-sdk-package` | `oliphaunt-react-native:test-consumer` | `//src/native/sdks/react-native:test-consumer` | test-only native consumer/check |
| `rust-sdk-package` | `liboliphaunt-native-bindings:package` | `//src/native/rust-bindings:package` | native production action/output |
| `rust-sdk-package` | `oliphaunt-broker:package` | `//src/native/broker:package` | native production action/output |
| `rust-sdk-package` | `oliphaunt-query:package` | `//src/query/rust:package` | native production action/output |
| `rust-sdk-package` | `oliphaunt-rust:package` | `//src/native/sdks/rust:package` | native production action/output |
| `rust-sdk-package` | `oliphaunt-rust:test-consumer` | `//src/native/sdks/rust:test-consumer` | test-only native consumer/check |
| `swift-bindings` | `oliphaunt-swift:package-bindings` | `//src/native/sdks/swift:package-bindings` | native production action/output |
| `swift-sdk-package` | `oliphaunt-swift:package` | `//src/native/sdks/swift:package` | native production action/output |
| `wasix-napi` | `oliphaunt-wasix-napi:build-release-assets` | `//src/wasix/node-addon:build-release-assets` | native production action/output |
| `wasix-napi-release-assets` | `oliphaunt-wasix-napi:finalize-release-assets` | `//src/wasix/node-addon:finalize-release-assets` | replace in-place finalizer with pure declared archive/index output |
| `wasix-postmaster` | `liboliphaunt-wasix-postmaster:finalize-release-assets` | `//src/wasix/postmaster:finalize-release-assets` | replace in-place finalizer with pure declared archive/index output |
| `wasix-postmaster` | `liboliphaunt-wasix-postmaster:portable-inputs` | `//src/wasix/postmaster:portable-inputs` | native declared portable prerequisites; Linux execution |
| `wasix-postmaster` | `liboliphaunt-wasix-postmaster:release-assets` | `//src/wasix/postmaster:release-assets` | replace in-place finalizer with pure declared archive/index output |
| `wasix-release-regression` | `oliphaunt-wasix-rust:test-integration` | `//src/wasix/sdks/rust:test-integration` | test-only native consumer/check |
| `wasix-release-regression` | `oliphaunt-wasix-rust:test-regression` | `//src/wasix/sdks/rust:test-regression` | test-only native consumer/check |
| `wasix-rust-package` | `oliphaunt-pgwire-server:package` | `//src/wasix/pgwire-server:package` | native production action/output |
| `wasix-rust-package` | `oliphaunt-pgwire-server:test-consumer` | `//src/wasix/pgwire-server:test-consumer` | test-only native consumer/check |
| `wasix-rust-package` | `oliphaunt-wasix-rust:package` | `//src/wasix/sdks/rust:package` | native production action/output |
| `wasix-rust-package` | `oliphaunt-wasix-rust:test-consumer` | `//src/wasix/sdks/rust:test-consumer` | test-only native consumer/check |
| `wasix-ts-package` | `oliphaunt-wasix-ts:package` | `//src/wasix/sdks/ts:package` | native production action/output |
| `wasix-ts-sdk-package` | `oliphaunt-wasix-ts:test-browser` | `//src/wasix/sdks/ts:test-browser` | test-only native consumer/check |
| `wasix-ts-sdk-package` | `oliphaunt-wasix-ts:test-consumer` | `//src/wasix/sdks/ts:test-consumer` | test-only native consumer/check |
| `wasix-ts-sdk-package` | `postgres-tools-wasix:test-browser` | `//src/wasix/postgres-tools:test-browser` | test-only native consumer/check |
| `wasix-ts-sdk-package` | `postgres-tools-wasix:test-consumer` | `//src/wasix/postgres-tools:test-consumer` | test-only native consumer/check |
