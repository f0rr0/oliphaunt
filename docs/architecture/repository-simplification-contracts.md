# Repository simplification: product and completion contracts

Planning companion to [the implementation plan](repository-simplification-plan.md).
These are target contracts, not claims that the commands or packages already
exist. The implementation plan owns task status and user decisions. This is
one-time migration review material; do not turn these tables into a second
dependency database, generated policy suite, or publishing framework.

## Coverage of the current checkout

On 2026-09-11, `git ls-files` enumerated 2,287 tracked paths, 55 `moon.yml`
files and 20 product `release.toml` declarations. Every tracked path falls in
one of the domains below. Counts include tracked paths regardless of rg ignore
rules. This establishes inventory coverage, not line-by-line correctness or
permission to delete unread implementations. Re-read exact callers and inputs
when implementing each disposition; account for later main changes in task 01.

| Current domain | Paths | Planned owner / disposition | Tasks |
| --- | ---: | --- | --- |
| `sdks/rust-wasix` | 53 | Rust WASIX SDK; extract proxy; share query crate | 07,11,22 |
| `sdks/ts-wasix/sdk` | 183 | TS WASIX SDK; browser host; tools facade; local integration tests | 08,12,14,23 |
| `docs` | 82 | One docs project, remove API-generation/version scaffolding | 23,23a |
| `extensions` | 139 | Contrib, seven external products, producer/consumer tests and owned metadata | 19,25 |
| `src/postgres` | 5 | Shared pinned PostgreSQL source | 06 |
| `broker` | 68 | Broker product and its carriers | 09,10 |
| `runtimes/liboliphaunt-native` | 172 | Native runtime, extracted tools/resources, local binary helpers | 06,14–19,22 |
| `runtimes/liboliphaunt-wasix` | 180 | WASIX runtime, extracted tools/resources, retained AOT compiler work | 06,14–19,22 |
| `runtimes/liboliphaunt-wasix-postmaster` | 156 | Postmaster runtime, executor, Wasmer preparation and binary analysis | 06,13,22 |
| `database-resources/icu/cargo` | 4 | Resource-owned Cargo data carrier | 15,16 |
| `src/runtimes/liboliphaunt/licenses` | 3 | Notices owned by actual producers/pinned sources | 06,19,21 |
| `sdks/ts/node-addon` | 27 | `sdks/ts/node-addon`; replace C++ implementation with napi-rs | 04,09a,09b,17,22 |
| `sdks/ts-wasix/node-addon` | 31 | `sdks/ts-wasix/node-addon` | 04,17,22 |
| `sdks/ts/sdk` | 65 | `sdks/ts/sdk`; consolidate host adapters/resolution | 04,08,09b,17 |
| `sdks/rust/sdk` | 63 | Rust SDK, shared embedding/query crates, legitimate build helper | 07,09,10,22 |
| `sdks/swift` | 103 | Swift SDK and native package integration | 20 |
| `sdks/kotlin` | 56 | Kotlin SDK/plugin; move runtime Maven assembly to producers | 20 |
| `sdks/react-native` | 99 | RN package/plugin/codegen; product-local app adapters | 20,23 |
| `src/shared` | 183 | Eight domains explicitly mapped in the plan; no generic shared owner | 07–09,15,19,21–23 |
| `src/sources` | 40 | Common PG/ICU pins, product-specific pins, minimal common fetch/install | 06 |
| `tools/dev` | 21 | Minimal local setup and optional hooks | 06,22,25; M01–03 |
| `tools/graph` | 4 | Moon-to-CI adapter; remove second scheduler | 24 |
| `tools/policy` | 14 | Delete low-signal checks; localize meaningful checks | 22,24,25 |
| `tools/release` | 169 | Version preparation, candidate coordination, registry transports/recovery | 27–29 |
| `tools/test` | 12 | Fixtures beside actual surviving consumers | 21,22,25 |
| `examples` | 119 | Single-SDK examples local; cross-product apps remain integration projects | 23 |
| `benchmarks` | 51 | Deliberate optional benchmarks; remove abandoned scaffolding | 23,25 |
| `docs` | 50 | Merge maintainer/architecture content into docs owner; retain planning records | 23,23a |
| `.github` | 97 | Seven workflows, local actions/scripts, security configuration and issue templates | 24–29 |
| `.moon` | 4 | One task/dependency graph and supported inference | 05,24 |
| `.codex` | 8 | Update three skills and references with implemented commands | 23,26,29 |
| `.config` | 1 | nextest settings retained only where Rust tests need them | 05,25 |
| Root files | 25 | Workspace manifests/locks, tool/quality config, release config, Swift entrypoint, docs/notices | 04–06,20,23–29 |

Root scope includes `.gitignore`, `.gitattributes`, `.prototools`, Rust toolchain,
Cargo/current pnpm workspace and locks (migrate pnpm to Bun in 06b), root package/Moon files, Biome/rustfmt/clippy/
markdownlint/deny configuration, prek/committed/Renovate, Release Please files,
root SwiftPM, README/CONTRIBUTING and license/notices. Preserve useful settings;
remove stale paths, overrides and dependencies only after finding their consumers.
Review executable bits, case-only renames and line endings during the move.
Generated extension metadata, native headers, test reports and upstream patches
are accounted for by their owning domains; generated output is not automatically
dead code. Upstream patches must be applied and exercised, not just relocated.

## Local command contract

Every buildable leaf has `moon run <id>:build`, usable from its directory, with
declared producer edges. There is one explicit workspace tool bootstrap;
individual builds do not install every ecosystem. Native commands below run
after their declared dependencies are prepared. No custom dependency walker.
Project README instructions state required host, setup, outputs and mutations.

| Profile | Native commands executed by the corresponding Moon tasks |
| --- | --- |
| TypeScript library | `format` / `format-check`: Biome format write/check; `lint`: Biome lint; `typecheck`: `tsc --noEmit`; `build`: `tsc -p <owned build config>` or the existing necessary bundler; `test`: `bun test` for retained source behaviour; `package`: `bun pm pack`; `test-consumer`: clean packed-package fixture |
| Rust crate/binary | `format` / `format-check`: `cargo fmt` / `cargo fmt --check`; `lint`: `cargo clippy --locked` for declared targets/features; `build`: `cargo build --locked`; `test`: `cargo test --locked` for the actual library/binary/integration/doc surfaces; `package`: `cargo package --locked` where publishable, or owned binary assembly; `test-consumer`: clean Cargo consumer |
| Native C/C++ runtime/extension | `format` / `lint`: retain applicable existing compiler/style tools only; `build`: local Bash invokes the existing necessary compiler/configure/make steps; `test`: focused source/helper tests; `test-integration`: built ABI/load/lifecycle behavior; `package`: owned assembly over finished binaries |
| Rust Node-API addon | Rust crate build/lint/test using existing pinned napi-rs; local Shell assembles the cdylib as the target .node carrier; TS handles metadata; common frozen-package consumer tests run under Node/Bun/Deno; no direct Node headers/C++ compiler setup for the adapter itself |
| Swift | `format` / `lint`: retained Swift tool configuration; `build`: `swift build` on supported macOS, `xcodebuild` for iOS/simulator schemes; `test`: `swift test`; `package`: owned SwiftPM/Apple artifact assembly; `test-consumer` / `test-device`: clean public SwiftPM and relevant simulator/device execution |
| Kotlin/Gradle | `format` / `format-check`: retained Gradle formatting tasks; `lint`: Android/plugin diagnostics; `build`: module `assemble`; `test`: JVM/unit Gradle tasks; `package`: Gradle publications assembled into local staging; `test-consumer`: isolated Gradle resolution/build; `test-device`: installed Android tests |
| React Native | TS format/lint/typecheck/build, `bun test` and `bun pm pack`; keep installed RN codegen CLI; native compile uses Kotlin/Swift producer outputs; Expo prebuild and platform build belong to the app; `test-device` consumes that built app |
| Docs | `dev`: Next dev; `format` / `lint`: Biome; `typecheck`: TypeScript after required Next/MDX type generation; `build`: Next build; `test-integration`: built routes/links; no SDK API-generator or compiler dependency |
| Data/upstream inputs | `prepare`: bounded verified source/tool acquisition; `build`: owned recipe if it produces data; `test`: contract/real initialization as appropriate; `package`: selected data archive/carrier; no fabricated lint/typecheck for data-only leaves |
| Integration app | Ecosystem-native app build, then separate `test-browser` / `test-device` / desktop `test-integration`; package-consumer setup explicitly chooses frozen candidates; retry never rebuilds the app |
| Tooling | Bash for command orchestration; TS for filesystem/data/HTTP; Rust for actual binary/compiler work. Focused tests only for retained behavior. No registry publication for maintainer helpers |

The profile is a vocabulary, not mandatory boilerplate. Do not create every task
on every project, duplicate Cargo compilation as a universal typecheck, or run
`bun pm pack` as a lint check. Bun owns maintainer TypeScript/source tests;
preserve native-language and real host/browser/device execution. Shell wrappers orchestrate CLI consumers; TS tests
do not launch Shell. All target/candidate arguments are explicit at the owning
task, not hidden in CI environment defaults.

## Product contracts

Each row owns its source, tests, local commands and outputs. Independent release
owners have one changelog and one version authority. Carriers inherit that
version and never acquire independent changelogs. Existing registry names and
product tag components are preserved through directory moves. New public names
below are planned identifiers subject to a read-only collision check before
publication; no public identity is reserved now.

| Leaf / group | Build dependencies and outputs | Release/version authority | Required proof and host scope |
| --- | --- | --- | --- |
| `runtimes/liboliphaunt-native` | PG source + native patches + compiled ICU; shared library, headers, server executable and required support files | Existing `liboliphaunt-native`, local VERSION; GitHub/npm/Cargo/Maven runtime carriers | Native C profile; ABI, direct lifecycle, server concurrency; desktop and Android/Apple declared binaries |
| `runtimes/liboliphaunt-wasix` | PG + WASIX toolchain/patches + compiled ICU where used; portable guest and declared AOT outputs | Existing `liboliphaunt-wasix`, VERSION; GitHub/npm/Cargo | Guest build on supported builder; portable guest execution, AOT compatibility and extension loading on declared hosts |
| `runtimes/liboliphaunt-wasix-postmaster` | PG + postmaster patches + pinned Wasmer/libc; sealed guest and compiler-free executor bundle | Existing runtime VERSION and GitHub assets | Concurrent clients, backend/process/shared-memory/recovery behavior; Linux x64/arm64 and macOS arm64 |
| `.../wasix-postmaster/executor` | Explicit prepared Wasmer dependencies + final guest; Cargo build/test | Internal build project, version follows postmaster; no extra registry release | Executor tests plus runtime integration; no compiler tools in consumer bundle |
| `.../wasix-postmaster/wasmer` | Pinned upstream/patches/compiler inputs; prepared source, sysroot and build tools | Internal upstream preparation, upstream identity separate from product SemVer | Patch/capability regressions when affected; compiler-bearing tools stay producer-only |
| `runtimes/wasix-browser-host` | Patched Rust/WASM host + wasm-pack; WASM/generated JS glue | Build project bundled by TS WASIX SDK; no separate public release/changelog | Host build and actual browser storage/query/worker lifecycle; edits release the consuming SDK |
| `sdks/ts/sdk` | TS query package + native addon/broker/runtime as required by entrypoints; JS/types | Existing `@oliphaunt/ts`, package.json | TS profile; packaged Node/Bun/Deno entrypoints and existing direct/broker/server behavior; relevant desktop embedding apps |
| `sdks/ts/node-addon` | Shared native Rust bindings + napi-rs; target `.node` files using the external native runtime | Existing `oliphaunt-node-direct` release owner, package.json; derive private Cargo version; target npm carriers | One addon per target under Node/Bun/Deno; ABI/error/cancel/stream/close, worker termination and generation cleanup; no runtime/resource embedding |
| `sdks/ts-wasix/sdk` | TS query package; browser host for browser, WASIX addon for server JS; JS/types/glue | Existing `@oliphaunt/wasix-ts`, package.json | TS profile; Node/Bun/Deno/Electron exports, browser worker and supported storage adapters; no native addon pulled into browser bundle |
| `sdks/ts-wasix/node-addon` | Rust WASIX SDK + Node-API adapter; target `.node` files | Existing `@oliphaunt/wasix-napi`, package.json; derive Cargo version | Cargo/Node-API build and clean target consumer; standard/ICU resources selected externally |
| `sdks/rust/sdk` | Rust query + shared native bindings + declared broker/runtime integration; Rust library | Existing `oliphaunt`, Cargo.toml | Rust profile; direct/broker/server semantics, public consumer and examples; desktop targets |
| `sdks/rust/sdk/crates/oliphaunt-build` if needed | Only necessary Cargo consumer integration; no producer orchestration | Existing `oliphaunt-build` identity/version follows Rust SDK; no independent notes | Clean downstream build proves retained metadata/link integration is needed; delete if no caller remains |
| `sdks/rust-wasix` | Rust query + runtime/AOT + supported Wasmer executor dependencies; Rust library | Existing `oliphaunt-wasix`, Cargo.toml | Rust profile; sync/async API, storage/recovery/cancel and selected assets on desktop targets |
| `sdks/ts-query` | TypeScript query/protocol source; JS/types | Normal published npm dependency, package.json, own notes; planned `@oliphaunt/ts-query` | Source cases and all actual SDK consumers; no bundled-source copy/version propagation engine |
| `sdks/rust-query` | Shared Rust query/protocol code; Rust crate | Normal Cargo dependency, Cargo.toml, own notes; planned `oliphaunt-query` | Rust tests plus both SDK type/behavior consumers |
| `sdks/rust/liboliphaunt-native` | Native C runtime + Rust bindings with embedded lifecycle handling; Rust crate | Normal Cargo dependency, Cargo.toml, own notes; planned `liboliphaunt-native-bindings` | Rust direct SDK, native napi-rs addon and broker share implementation; no public SDK dependency or transport/server spawning |
| `broker` | Shared embedded Rust crate + native runtime; child process executable | Existing `oliphaunt-broker` release owner/Cargo version and binary carriers | Authentication, IPC query/cancel/error, child death and shutdown; desktop targets |
| `pgwire-server` | Wire adapter library and WASIX CLI; native broker reuses proven common protocol code without pulling in Wasmer (10a/10b) | New Cargo product, Cargo.toml, own notes; planned `oliphaunt-pgwire-server`; no extra native broker executable | Ordinary PostgreSQL client query/error/reconnect/stop; real cancellation when advertised; retain backend-specific scheduling limits and desktop host support |
| `postgres-tools/native` | Matching PG/native build inputs; selected initdb and logical dump/restore binaries | Separate tools release owner, VERSION; preserve existing `oliphaunt-tools` / `@oliphaunt/tools` carrier identities | Actual initialize/dump/restore from clean desktop consumer; no tools in default SDK |
| `postgres-tools/wasix` | Matching guest/toolchain/AOT inputs; WASIX tools and TS facade | Separate tools release owner, VERSION; existing WASIX tools Cargo/npm identities derive this version | Actual tools execution through supported hosts; TS facade behavior on Node/Bun/Deno/browser where currently exposed |
| `database-resources` | Seed recipes use matching initialization tools; ICU data uses canonical data pin | One resource product, VERSION and one changelog; separately selectable seed/data carriers, preserve existing ICU identities | Four logical seeds, declared physical variants, shared compatible ICU data, safe initialization/reopen and no unselected downloads |
| `sdks/swift` | Native headers/binaries + selected resources/extensions through native package integration; Swift sources | Existing Swift VERSION/tag history; required root Package.swift; no second SDK-local public surface | Swift profile; macOS and iOS device/simulator declared surfaces; selected extension composition |
| `sdks/kotlin` | Native Android runtime + selected resources/extensions; AAR and integration plugin | Existing Kotlin VERSION; derive Gradle/module/plugin versions; Maven library/plugin/marker identities retained | Gradle profile; clean consumer, API floor, Android arm64-v8a/x86_64 |
| `sdks/kotlin/oliphaunt-android-gradle-plugin` | Gradle APIs and product-owned artifact configuration | Kotlin release-owned subproject, no independent version/changelog | Repeated configuration/build, ABI/resource selection, plugin marker resolution |
| `sdks/react-native` | TS query + Swift/Kotlin integration + RN codegen; package/plugin/native bindings | Existing `@oliphaunt/react-native`, package.json; derive podspec fields | TS/RN profile; Expo prebuild twice, add/remove assets, installed Android/iOS behavior |
| `extensions/contrib` | PG contrib source + matching runtime ABI; exact selectable members | Runtime-owned native/WASIX versions; no independent contrib/member release | Required actual extension lifecycle; selected-member packaging; shared changes select shipping runtimes |
| `extensions/external/pg_hashids` | Pinned extension source + compatible runtime | Existing independent VERSION/component | Build/package and actual load/lifecycle on each declared target |
| `extensions/external/pg_ivm` | Pinned extension source + compatible runtime | Existing independent VERSION/component | Same product-owned extension contract |
| `extensions/external/pg_textsearch` | Pinned extension source + compatible runtime | Existing independent VERSION/component | Same contract, including extension-specific operational constraints |
| `extensions/external/pg_uuidv7` | Pinned extension source + compatible runtime | Existing independent VERSION/component | Same product-owned extension contract |
| `extensions/external/pgtap` | Pinned extension source + compatible runtime | Existing independent VERSION/component | Same contract, including SQL-only behavior where applicable |
| `extensions/external/postgis` | Pinned PostGIS and native dependencies + compatible runtime | Existing independent VERSION/component | Same contract plus actual spatial operations and required dependency/notice closure |
| `extensions/external/vector` | Pinned vector source + compatible runtime | Existing independent VERSION/component | Same contract plus actual vector operations |
| `docs` | Written guides, site dependencies, explicit published-version input | Private site build/deploy; no docs-version archive, product SemVer, or package-release ceremony | Local site/type/link checks, actual Vercel refresh, no SDK compilation |

`oliphaunt-build` is a release-owned subproject only if its downstream purpose
survives; task 09/22 must record its retained caller or delete it. No other new
product is conditional on speculative future use. Packaging directories and
carrier manifests are build/distribution details, not additional products.
`sdks/rust` is a group with no package manifest; its SDK and bindings are sibling
Cargo workspace members. The bare liboliphaunt-native registry name is reserved
for the actual runtime distribution, not these Rust bindings. No new runtime
facade package is required merely to occupy that name.

## Supporting projects and ownership

| Owner | Contents / commands | Release effect |
| --- | --- | --- |
| `third-party/postgres` | One PG pin and common/WASIX-shared patches; each runtime owns its lane deltas and complete ordered series; `prepare` applies only that lane's explicit inputs | Actual changed producer inputs select shipping runtime/tool/extension products; no postmaster dependency on the embedded runtime's patch directory |
| `third-party/icu` | Shared compiled-library pin/recipe; target build variants explicit; ICU data recipe belongs to resources | Compiled library changes affect embedding runtime binaries; data changes affect resource product |
| Other third-party inputs | OpenSSL shared only where truly consumed; Windows ICU toolchain local to native; Wasmer/libc/testsuite pins owned by actual executor/browser/AOT consumers | No independently released upstream-source wrapper; dependency edges follow actual use |
| `extensions/tools` / `extensions/tests` | Only truly common catalog/selection/build helpers and cross-extension behavioral fixtures | Tests/tools alone do not bump products; shipping-byte recipe changes do |
| `test-fixtures` | Shared protocol/storage/SQL data used by multiple projects; single-consumer fixtures local | No release; dependency edges select tests, not SDK versions |
| Integration applications | Existing browser, Expo, Electron/native, Electron/WASIX, Tauri/native, Tauri/WASIX; single-SDK samples move local | No public release; owning app build plus installed execution, not every example on every SDK change |
| `benchmarks` | SQL/data, native runner, WASIX Node/browser comparisons; optional measure tasks | No release or mandatory performance gate |
| `tools/dev` | Thin setup/install/hook commands | No product version bump unless a changed pinned producer input changes shipped outputs |
| `tools/ci` / `.github` | Moon task projection, runner provisioning, artifact transfer, required aggregate and credentials | No hidden product check or second affectedness graph |
| `tools/packaging` | Only surviving multi-product archive/notice helpers | Input edges select affected packaging and releases when shipped bytes change |
| `tools/release` | Release Please adapter, dependency closure, frozen candidate, registry transports and recovery | No compilation; controller-only fix can resume original candidate under explicit recovery rules |
| Root / skills / contributor docs | Native workspace/lock/tool configuration; documented commands and operational contracts | No general repository version or blanket all-project task |

Internal Rust helpers such as AOT serialization, native packaging and sealing
remain with the producer that requires them. Remove empty Moon pseudo-projects
that only repeat file lists when native dependency declarations/task inputs cover
them. A shared recipe that embeds bytes in multiple products selects those
products; a normal published dependency update does not automatically release
every consumer. An explicit consumer dependency upgrade does release that consumer.

## Target preservation and capability proof

Preserve current declared support; do not expand or silently narrow it during
cleanup. Baseline authority: current product target metadata and
`docs/maintainers/release.md` Artifact and OS policy. Native desktop targets are
Linux x64/arm64 GNU, macOS arm64 and Windows x64 MSVC. Existing native ELF floors
are glibc 2.38 / GLIBCXX_3.4.30; direct macOS binaries target 11.0. Android uses
arm64-v8a/x86_64, API 24. Apple XCFrameworks have macOS arm64, iOS device arm64,
iOS simulator arm64; Swift SDK floors are macOS 14/iOS 17. WASIX portable/AOT
surfaces retain their declared desktop hosts. Postmaster currently declares
Linux x64/arm64 and macOS arm64, not Windows. TS facade host coverage includes
Node/Bun/Deno; WASIX also has browser and Electron entrypoints.

These are separate product floors, not a universal minimum. Preserve current
Node engine ranges and Node-API requirements per manifest; validate the final
supported minimum as well as the CI toolchain. Do not infer browser/mobile
support for a product from another product's target list. No new macOS x64,
Windows ARM64, musl, Android 32-bit or other Apple slices are in scope.

| Behavior | Required evidence | When selected |
| --- | --- | --- |
| Direct/native and WASIX semantics | Actual queries/parameters/results/errors, supported transactions, cancellation, close, persistence/reopen and existing backup/restore behavior | Owning execution/query/storage changes and changed runtime compatibility |
| Broker | Same shared execution plus authenticated IPC, process death, no ambiguous replay, shutdown | Broker/transport/shared execution changes |
| Native server / postmaster | Ordinary driver, multiple connections, process/backend lifecycle and recovery | Respective runtime/server changes |
| Optional resources/extensions | Standard/ICU selection, incompatible/corrupt data rejection before PGDATA mutation; selected extensions load and survive required lifecycle | Resource/extension/selection changes and dependent compatibility |
| Browser | Worker startup, query/cancel/close and implemented IndexedDB/OPFS storage behavior | Host/browser SDK/storage/build changes |
| Mobile | Real installed application, codegen/native integration, asset add/remove and existing isolation semantics | Native SDK/plugin/platform/resource changes |
| ABI/platform | Inspect final binary floors/exports/dependency closure plus actual target load/execute | Relevant binary/toolchain/target/packaging change |
| Package publication | Clean source/binary consumer, complete dependency closure, exact frozen payload identity | Every selected final package; reuse evidence only for identical package and relevant environment |

The source inventory supplies detailed existing capabilities rather than
inventing new ones. Task 01 records the concrete existing test/example that
demonstrates each supported behavior; task 30 cannot substitute a happy-path
query for cancellation, recovery or existing storage functionality.

## Completion record

For each numbered task and M01–M18, record in the main plan: final owner/paths,
responsibility removed or simplified, affected callers, exact commands and
results, and any unavailable platform/public-state evidence. A retained helper
needs a concrete consumer and failure it prevents. A deletion needs caller
review and either replacement behavior proof or evidence that it had no user.
Do not add tests merely to enforce this record.

Completion requires the final dependency graph, all product rows, every baseline
domain and the acceptance matrix to agree. Sample affectedness probes supplement
the graph/input review; they do not prove every possible path by themselves.
Tests required by the new contract must pass on the final candidate; unavailable
host/registry/deployment evidence remains incomplete. No removed feature or
weakened guarantee can be hidden by renaming a task or marking it optional.

No implementation, registry reservation, workflow dispatch or production deploy
is authorized merely by completing this planning document.

## Binding amendment — resource, query, patch and Bun consolidation

The plan's 2026-09-11 consolidation contracts are required acceptance criteria.
Tasks 15–20 move immutable resource composition into producers/app builds and
delete redundant SDK resource assemblers while preserving custom inputs and
safe mutable PGDATA initialization. Tasks 07/08 own shared query methods/errors;
23/25 use independent PostgreSQL behaviour where applicable, retaining only
necessary malformed-input and product-specific expectations. Task 11a replaces
the private native server smoke query client with an ordinary consumer and
narrows production readiness. Task 06 owns three ordered PostgreSQL patch lanes
and shared common/WASIX deltas, preserving current semantics and optimizations.
Task 06b migrates maintenance to Bun 1.4.2 (or a newly verified exact stable pin
at implementation start), Bun workspaces/lock, bun:test and Bun packing; removes
pnpm machinery; and proves Moon, installation policy, package consumers, docs
and release-PR lock refresh before cutover. Cargo/Swift/Gradle stay native.
Tasks 24–29 test shared behaviour once, boundary differences at their adapters
and actual final packages/platforms only where needed, without a second scheduler.

Issues #212 (browser-host vendor-patch extraction) and #213 (Wasmer family
alignment) are explicitly parked and do not block final acceptance. Task 12's
existing build ownership work remains required. Optimization tuning/deletion
is not added to this implementation scope.

## Binding amendment — broker PG wire, UniFFI and React Native

Tasks 10a/10b add native broker PG wire proof and cutover: ordinary query/result/
error/stream/cancel traffic uses PG wire; only necessary authenticated backup/
process shutdown management remains private. Preserve one-backend semantics,
real incremental protocol progress and native cancellation; the current WASIX
proxy's CancelRequest branch is not sufficient proof. The plan specifies the
native pump, protocol/auth boundaries, independent clients and cutover/deletion
criteria. No new HTTP/RPC service or pretend concurrent server.

Tasks 09c/09d prove then adopt UniFFI over the real Rust direct session/query
implementation, or take the minimal existing C _with_error fallback. A successful
path adds private sdks/rust/mobile-bindings, whose generated code/native artifacts
ship under Swift/Kotlin versions, with actual Cargo/Moon/Gradle/Swift input edges
and no independent release. Resolve linked Apple symbols/static extensions,
Android JNA/ABI loading, Swift strict concurrency, cancellation, disposal versus
shutdown, streaming and final consumer packaging before deleting the old bridge.
No unused UniFFI implementation remains after fallback. Task 20a shares RN JSI
mechanics under its own cpp directory with runtime-scoped ownership and thin
platform adapters, retaining actual SDK integration. Final task20 and acceptance
depend on these tasks. Generated bindings do not themselves implement mobile
process isolation or replace platform-specific application integration.
