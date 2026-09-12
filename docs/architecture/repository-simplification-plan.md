# Repository simplification implementation plan

Status: implementation in progress. The layout migration, product/resource
separation, broker PostgreSQL wire transport, and substantial local CI/release
checks are implemented. Mobile bridges and release PR convergence have local
consumer proof. Dependency-input/cache fixes and source-acquisition test cleanup
are implemented; the current pass is verifying combined CI and independent
version-transition consumers. Platform qualification,
Deno addon teardown, native cross-commit reuse and external cutover remain open.
Checkpoints below record actual proof;
unchecked acceptance items must not be inferred complete from source changes.
Baseline inspected: 2026-09-11. This document records the current discussion's
decisions and supersedes conflicting proposed layouts in that discussion. The
existing source-architecture document continues to describe current behavior
until the corresponding implementation changes land.

## Objective and scope

Preserve product capabilities while removing unnecessary tooling, hidden
dependencies, bundled optional payloads, duplicated checks, and release steps.
Make each product understandable and buildable through its own ecosystem;
Moon supplies cross-project task ordering and affectedness. This work does not
merge the native and WASIX SDK APIs, remove the desktop broker, rename the
three runtimes, add postmaster direct mode, or ship the mobile isolation spike.

The user subsequently authorized implementation of this plan. Production code,
local package metadata and workflows are now being changed in the working tree;
no publication, tag push or deployment is implied by these local changes.
The [product and completion contracts](repository-simplification-contracts.md)
are part of this plan: they enumerate the current domains, define commands and
release ownership for the target leaves, and preserve supported target behavior.

## Verified starting point

- Branch: `f0rr0/simplify-product-tooling`.
- HEAD: `e425160984872b725debd82961aaef0d9054813b`.
- Freshly fetched `origin/main`: `f4b7a5c71c8e244f77cc08d474e06e47fe336287`.
- Before this document: 38 modified tracked files, 295 insertions and 337
  deletions. These include partial task normalization and postmaster asset
  finalization changes. Preserve and review them; do not reset or count them as
  validated completion of this plan.
- [CI for HEAD](https://github.com/f0rr0/oliphaunt/actions/runs/34370136091)
  failed. The two failing producer jobs are WASIX TypeScript SDK and iOS App;
  E2E, Builds and Required also failed as aggregate consequences.
- Browser log: `browser endpoint did not become ready` for Chromium's
  `/json/list` endpoint. Root cause remains to be fixed, not assumed to be a
  timeout setting.
- iOS log: Hermes compilation cannot find `facebook::jsi::TypedArray`.
  React Native/Hermes/Expo dependency coherence needs a targeted fix.
- Tracked `*.js`, `*.mjs`, `*.cjs`, and `*.py` inventory returned no files.
  The remaining language violation includes TypeScript launching commands in
  release implementation and tests. Generated/upstream JavaScript remains
  permitted; do not convert upstream dependencies solely for language purity.
- `tools/release` currently has 169 files, `src/shared/artifact-packaging` 61,
  `src/shared/product-metadata` 17, and `tools/policy` 14 (file counts, not LOC
  or a deletion estimate). There is significant tooling left to review.

Specific source findings:

| Area | Current evidence | Gap |
| --- | --- | --- |
| Native runtime | `src/runtimes/liboliphaunt/native` | Source, resources, tools and release carriers share one owner |
| WASIX runtime | `src/runtimes/liboliphaunt/wasix/tools/wasix-runtime-npm-carrier.mts` | Standard seed is part of runtime packaging |
| WASIX addon | `src/runtimes/wasix-napi/Cargo.toml`, `build.rs` | Unconditional ICU dependency; both seeds required; release enables tools/extensions |
| ICU | Native and WASIX `release.toml`; `native/bin/icu.sh` | npm/Maven and Cargo owners differ; WASIX imports native-owned common helper |
| Rust query sharing | Both SDK `build.rs`, `src/shared/rust-query-core/query_core.rs` | Source copying/include mechanism instead of a registry dependency |
| Broker | `src/runtimes/broker/Cargo.toml`; native SDK `broker*.rs` | Executable depends on public SDK internal feature |
| Socket server | WASIX Rust `Cargo.toml`, `src/bin/oliphaunt_wasix_proxy.rs`, `src/oliphaunt/proxy.rs` | Existing library/CLI behavior is embedded in SDK ownership |
| Browser host | `src/bindings/wasix-ts/host/build-sdk.sh`, `patches/0007-*` | Patches Rust, builds with wasm-pack, emits WASM and JS; wrongly placed under TypeScript |
| Postmaster executor | `runtime/executor/Cargo.toml.in` | Injected into upstream Wasmer workspace; cannot simply run Cargo in source directory |
| Swift | Root and SDK-local `Package.swift` | Different public product surfaces; potential development/publication drift |
| Qualification | `.github/workflows/ci.yml` job `qualified` | Requires manual dispatch with all native/WASM/mobile selectors, regardless of selected release products |
| Release | `.github/workflows/release.yml` | Already exposes only prepare-release-pr and publish; publish already conditionally bootstraps missing identities |

Follow-up workflow review identified additional implementation obligations:

- CI listens to PR open/synchronize/reopen/close, merge-group, main push and
  manual dispatch. Each event needs explicit immutable base/head semantics.
- Planning currently waits for release-intent validation. Release PRs have a
  generated-metadata admission check before expensive planning; keep its useful
  behavior without making source PR testing depend on publication readiness.
- Release PR preparation creates/updates the bot PR, normalizes it to a single
  commit and pushes with a lease. A transient raw PR update can otherwise cause
  duplicate expensive CI or stale results.
- Six reusable/secondary workflows accompany ci.yml: broker-runtime,
  liboliphaunt-native-desktop, extension-artifacts-native,
  mobile-extension-packages, mobile-e2e and release. Their paths, permissions,
  artifact interfaces and gate semantics must change together where affected.
- Candidate/ledger retention is explicitly 90 days at several release upload
  points. Safe retries depend on those bytes remaining available.
- The release-controls implementation expects `Required` as the sole protected
  branch check. This is source policy, not a fresh verification of remote
  settings; task 24c includes that read-only inventory before cutover.

The planning coverage pass enumerated all 2,287 tracked paths, 55 Moon manifests
and 20 release declarations; the companion contracts account for every domain,
including root/hidden configuration and generated-source/tooling seams. This
is not a claim that every implementation line or platform has been validated.
Task 01 refreshes this ledger against the implementation checkout; each task
must read the exact code/callers it changes before deletion.

## Decisions and names

Agreed:

- Keep `liboliphaunt-native`, `liboliphaunt-wasix`, and
  `liboliphaunt-wasix-postmaster`.
- Keep broker; extract its shared native Rust implementation cleanly.
- One project owns database seeds and ICU data; neither payload belongs in a
  default runtime/SDK/addon package. Compiled ICU libraries are a different,
  runtime-build dependency.
- Four logical seeds: native standard, native ICU, WASIX standard, WASIX ICU.
  Native physical compatibility variants remain explicit. No postmaster seed
  support is promised until produced and verified.
- ICU seeds reference the same compatible ICU data package; standard seeds do
  not depend on it. ICU data can also be selected without a seed.
- Publish shared Rust crates needed by published crates. Eliminate bespoke
  source copying used solely to avoid publishing dependencies.
- Name the SDKs `sdks/ts`, `sdks/ts-wasix`, `sdks/rust`, and
  `sdks/rust-wasix`. Unsuffixed SDKs use the native runtime.
- `sdks/rust` is a grouping directory: `sdk/` owns the public Rust SDK and
  `liboliphaunt-native/` owns its shared native Rust bindings. Both are normal
  Cargo workspace members; the group itself has no Cargo.toml. Reserve the bare
  `liboliphaunt-native` package name for runtime distribution; the bindings crate
  is `liboliphaunt-native-bindings`, subject to registry availability.
- Each TypeScript product group contains `sdk/` and `node-addon/`. Keep the
  addon beside its consuming API regardless of implementation language;
  grouping directories are not packages. Remove `bindings` and the
  miscellaneous `shared` grouping.
- Browser users consume `sdks/ts-wasix/sdk`; there is no separate browser SDK.
  Its execution host lives at `runtimes/wasix-browser-host`, outside SDKs.
  Placement follows responsibility, not implementation language alone.
- Keep ordinary root workspaces/lockfiles and the required Swift publication
  entrypoint. Target Bun workspaces/bun.lock for TypeScript and Cargo for Rust;
  Bun is the maintainer TypeScript runtime and test runner. Preserve
  platform-native tooling inside each SDK. Task 06b owns pnpm retirement.
- No committed JavaScript/Python scripting. Shell runs commands; TypeScript
  processes data. Product Rust/C/C++/Swift/Kotlin remains appropriate. Sudo is
  allowed only in explicit CI machine setup.

Names approved in the follow-up planning review; the shared Rust name applies
the user's requirement to include liboliphaunt-native:

| Name | Meaning and limit |
| --- | --- |
| `database-resources` | One owner for `seeds/` and `icu/`; no unrelated assets. Public seed descriptions say “pre-initialized PostgreSQL data directory.” |
| `pgwire-server` | PostgreSQL wire-protocol server library and CLI over the existing WASIX SDK. It does not promise native support or postmaster concurrency. |
| `sdks/ts-query`, `sdks/rust-query` | Approved shared query package folders beside their consuming SDKs. |
| `sdks/rust/liboliphaunt-native` | Rust bindings to the native C runtime used by direct SDK and broker: open, execute, cancellation, backup and close; excludes server spawning and broker transport. Cargo name: `liboliphaunt-native-bindings`, subject to registry availability. |

Folder names do not automatically rename existing registry packages. Check
existing public identities before introducing new ones. No compatibility
aliases are required merely for this research project's old API, but immutable
public versions/tags must never be overwritten.

Decisions resolved for implementation without another architecture-selection phase:

- Retain Release Please as the sole candidate version/changelog/PR engine.
  Use native strategies and minimal derived-file updates. Task 27b verifies the
  pinned integration, rather than launching an open-ended replacement project.
  Shared shipped-byte impact is computed from the declared producer graph and
  supplied to that one candidate path; no second SemVer/changelog writer.
- Publish TS query code as a normal npm dependency, and the shared Rust query
  and embedded-operation code as normal Cargo dependencies. Stop bundling source
  merely to avoid publishing these dependencies. Preserve consumer behavior.
- Consolidate native Node/Bun/Deno direct execution through one Rust napi-rs
  addon at sdks/ts/node-addon, depending on sdks/rust/liboliphaunt-native.
  Rust direct SDK and broker use that same bindings crate directly. Remove the
  C++ addon and Deno-specific FFI implementation after replacement behavior is
  proven. Use Node-API 8 and the existing pinned napi-rs family initially.
  Keep native and WASIX addons as separate products; share small proven adapter
  facilities only where semantics coincide, never a universal backend framework.
  Deno uses npm with a local node_modules directory and explicit FFI permission;
  document this installation change rather than retaining a second FFI backend.
- Browser host is its own build project and is bundled/released with the WASIX
  TS SDK. It gets no independent public package/version/changelog in this scope.
- Native and WASIX PostgreSQL tools are separate release owners. Their existing
  carrier names are transferred deliberately; old published versions stay intact.
- Database resources are one release product/version/changelog, with separate
  seed/profile/target and shared ICU-data carriers. Do not create an all-assets
  facade. Native and WASIX ICU seeds reference one compatible ICU-data identity.
- Keep normal root workspaces/locks. Local native manifests represent language
  dependencies; Moon edges represent cross-language build outputs. Shared data
  and build recipes have declared owners, not a parallel file-impact whitelist.
- Use existing supported tool managers and archive facilities first. Choosing
  the smallest platform-compatible implementation is routine engineering; it
  does not require user approval. Keep narrow custom handling only with a
  demonstrated constraint and a meaningful behavior check.
- User approved docs from main on docs changes and after product releases,
  with installation versions taken only from completed public releases. No
  historical docs/version selector. See the explicit deployment contract below.
- No target/API capability is dropped to simplify CI. Optional assets become
  explicit inputs; migration examples explain that intentional API/install change.

User decisions resolved: database-resources, pgwire-server, ts-query and rust-query
were approved; the shared Rust package must include liboliphaunt-native in its
name and live inside the Rust group, implemented here as
sdks/rust/liboliphaunt-native with Cargo name liboliphaunt-native-bindings.
The bare liboliphaunt-native identity remains reserved for runtime distribution.
Docs use main guides and
published versions. No unanswered user preference currently blocks this plan.

Registry availability, actual Vercel settings, native-host results and publication
permissions are facts to verify, not preference questions. If access is missing,
record the exact missing evidence; never silently mark the corresponding task done.

## Target shape

```text
/
  Cargo.toml, Cargo.lock
  package.json, bun.lock, bunfig.toml
  Package.swift
  .moon/, .github/
  runtimes/
    liboliphaunt-native/
    liboliphaunt-wasix/
    liboliphaunt-wasix-postmaster/
      executor/
      wasmer/                         # pins, patches, host production
    wasix-browser-host/               # Rust/WASM execution host, not an SDK
  database-resources/
    seeds/native/
    seeds/wasix/
    icu/
    packaging/{cargo,npm,swift,maven}/
  sdks/
    ts/
      sdk/
      node-addon/
    ts-wasix/
      sdk/                            # browser and supported server-side JS
      node-addon/
    rust/                             # grouping directory, not a package
      sdk/                            # Cargo package: oliphaunt
      liboliphaunt-native/             # Cargo: liboliphaunt-native-bindings
      mobile-bindings/                # private UniFFI adapter shared by Swift/Kotlin
    rust-wasix/
    ts-query/
    rust-query/
    swift/
    kotlin/
    react-native/
  broker/
  pgwire-server/
  postgres-tools/{native,wasix}/
  extensions/{contrib,external,tests,tools}/
  third-party/{postgres,icu,...}/
  docs/{src,content,public}/
  examples/
  benchmarks/
  test-fixtures/
  tools/{dev,ci,packaging,release}/
```

Grouping directories are not packages. Leaf projects own relevant native
manifests, source/tests/examples, README and Moon tasks. Only real public
release boundaries own release metadata and changelogs. Generated registry
staging trees, archives, upstream worktrees and caches are ignored outputs.
The browser host is a build project released as part of the WASIX TS SDK.
Grouping directories such as sdks/ts, sdks/rust and postgres-tools have no package
manifest. Shared Rust query code remains at sdks/rust-query because both native
and WASIX SDKs consume it.

Path disposition, beyond the obvious SDK/runtime moves:

| Current path | Destination or action |
| --- | --- |
| `src/sdks/js` | `sdks/ts/sdk` |
| `src/runtimes/node-direct` | `sdks/ts/node-addon` |
| `src/bindings/wasix-ts` SDK source | `sdks/ts-wasix/sdk` |
| `src/runtimes/wasix-napi` | `sdks/ts-wasix/node-addon` |
| `src/bindings/wasix-ts/host` | `runtimes/wasix-browser-host` |
| `src/sdks/rust` | `sdks/rust/sdk`, with native bindings extracted to `sdks/rust/liboliphaunt-native` |
| `src/bindings/wasix-rust` | `sdks/rust-wasix`, removing unnecessary wrapper nesting |
| `src/sdks/rust/crates/oliphaunt-build` | `sdks/rust/sdk/crates/oliphaunt-build` if still needed for consumer build integration; remove asset-production responsibilities |
| `src/bindings/wasix-ts/tools-package` | `postgres-tools/wasix` owns product; language facade stays with its packaging |
| Native/WASIX runtime tools crates and npm packages | `postgres-tools/native` and `postgres-tools/wasix` |
| Native resource packager | Split seed/data production to database-resources; extension selection to extensions; app assembly remains consumer-owned |
| `src/postgres/versions/18` and common PG source pins | `third-party/postgres`; one upstream identity |
| `src/sources/third-party` | Common pins to third-party; product-only pins/patches to their owner |
| `src/sources/toolchains` | Product-only toolchains local; common installer entrypoints in tools/dev |
| `src/shared/js-core`, `rust-query-core` | `sdks/ts-query` and `sdks/rust-query` packages |
| `src/shared/cluster-seed-contract` | database-resources |
| `src/shared/extension-runtime-contract` | extensions |
| `src/shared/artifact-packaging` | Product-specific files local; proven reusable remainder in tools/packaging |
| `src/shared/product-metadata` | Native package manifests plus minimal release-only readers in tools/release |
| `src/shared/mobile-tools` | SDK-owned local launchers; CI provisioning only in tools/ci |
| `src/shared/fixtures` | test-fixtures, after moving single-consumer data locally |
| `tools/graph`, workflow policy/fixtures | Minimal CI adapter in tools/ci; delete duplicate graph logic where Moon suffices |
| `tools/test` | Tests/fixtures beside the release/CI/packaging code that uses them |
| `tools/perf`, `benchmarks/perf` | One benchmarks owner; keep only maintained measurement tools |
| `src/docs` plus root `docs` | One docs project; preserve URLs and maintainer content |
| Root examples | Keep multi-product applications; move single-product examples to their SDK |
| `.codex/skills` and contributor docs | Update commands and contracts with their implementation, not ahead of it |

## Dependency and task contract

Use package/Cargo/Gradle/Swift manifests for dependencies they can represent.
Use explicit Moon task edges for cross-language artifacts. Do not build another
task scheduler or encode all dependencies in release metadata. Every product
must have one documented command that builds its required dependency outputs
automatically. `moon run <product>:build` is the common checkout entrypoint,
usable from the product directory. Native ecosystem commands use their own
declared prerequisites; they must not pretend to provide orchestration they do
not implement. `bun run build` alone does not magically traverse Moon edges.
Where a package script exposes the orchestrated build, it delegates directly to
Moon and Moon invokes a distinct native compiler command, avoiding recursion.
No custom dependency walker or manual list of prerequisite builds is acceptable.

Required directions (arrows mean “requires”):

```text
runtime build → pinned PostgreSQL + selected patches + compiled ICU where used
seed build → matching runtime initialization tools + seed recipe
ICU seed build → compatible ICU data
SDK → selected runtime + shared query/embedding libraries
application → SDK + explicitly selected seed/data/extensions/tools
sdks/rust/sdk → sdks/rust/liboliphaunt-native → runtimes/liboliphaunt-native
broker → sdks/rust/liboliphaunt-native → runtimes/liboliphaunt-native
pgwire-server → WASIX Rust SDK → WASIX runtime
sdks/ts-wasix/sdk (browser) → runtimes/wasix-browser-host + liboliphaunt-wasix
sdks/ts-wasix/sdk (Node-API) → sdks/ts-wasix/node-addon → sdks/rust-wasix
sdks/ts/sdk (Node/Bun/Deno direct) → sdks/ts/node-addon (Rust napi-rs)
  → sdks/rust/liboliphaunt-native → runtimes/liboliphaunt-native
sdks/ts/sdk (broker) → TypeScript IPC client → broker executable
React Native → Swift/Kotlin SDKs + TypeScript query code
```

No runtime-to-seed build edge, no SDK-to-pgwire-server edge, no broker-to-public
SDK edge. Browser host compiler prerequisites must not pull seed production into
its build. Platform-specific Wasmer versions remain explicit.

| Task | Behavior |
| --- | --- |
| format / format-check | Rewrite / check formatting |
| lint | Static diagnostics, no package installation smoke tests |
| typecheck | Separate type analysis when useful; do not duplicate Rust build work without benefit |
| build | Produce project outputs with necessary producer prerequisites |
| test | Project tests; compilation is allowed where required by the ecosystem |
| test-integration | Built product against actual dependencies |
| test-artifacts | Verify the final distributable with its owning product's harness |
| test-consumer | Install packaged public surface in a clean consumer |
| test-browser / test-device | Real browser or mobile application behavior |
| package | Assemble distributable outputs; no hidden whole-product qualification |
| publish | Upload prepared, verified bytes; no compiler invocation |

Map these to Cargo, package scripts, SwiftPM and Gradle without manufacturing
empty tasks. Internal target-specific names may be more precise. Document what
each command produces, requires, modifies and needs from its host.

## Ordered implementation backlog

The checklist below tracks final-state completion; the implementation log records
completed chunks whose wider prerequisites remain open. Each task must record changed paths and actual check
results when completed. A plan, moved directory or passing metadata check is
not implementation evidence. Dependencies use task IDs.
The machinery dispositions below are part of their linked tasks, not a second
implementation phase. Close each disposition with its owner task and include
the resulting evidence in task 30.

### Phase A — close the inventory and settle boundaries

- [ ] **01 — Complete the baseline ledger.** Inspect every tracked source,
  workflow, package/build manifest, product registry surface and remaining
  tooling caller. Classify product code, necessary production tooling, test,
  generated output, duplicate or deletion candidate. Record supported product
  behavior and shipped asset inventory before changes. Read existing partial
  diff and preserve useful work. **Done:** every current product/source domain
  has an owner and destination; deletions cite callers and replacement proof.
  Do not create a permanent file-by-file policy checker from this ledger.
  Start from the companion's complete domain enumeration; refresh it for main
  movement and the existing partial diff, and record concrete behavior witnesses
  before moving their owners. Implementation reads happen at each changing seam.
- [ ] **02 — Finalize names and release boundaries.** Depends 01. Use the
  names and ownership decisions above; report an actual registry collision
  before altering a public identity. Preserve the agreed SDK/browser-host paths. Inventory
  existing public identities read-only. Fix product vs
  carrier classification; list exact manifests/derived version fields. Keep
  native and WASIX SDKs separate for this migration. **Done:** one reviewed
  current-to-target map, dependency graph and version authority per product;
  no unresolved placeholder in the implementation tree.
- [ ] **02a — Map existing publication history to final owners.** Depends 02.
  Existing-component lineage and captured pending notes are recorded in
  [release-owner-migration-lineage.md](release-owner-migration-lineage.md).
  Refresh the one-time capture at cutover; carrier transfers and ecosystem
  updater qualification remain open as specified there.
  Preserve the 20 current release components, immutable tags and public versions;
  record transfers of tools/ICU/resource carriers and new shared/proxy products.
  Keep existing registry names where possible. Initialize a transferred owner's
  next version above already-published carrier versions; do not restart at 0.1.0
  or replay all pre-move history. Record source/tag/changelog lineage explicitly.
  **Done:** every existing carrier has exactly one final owner, new identities
  have collision checks, and a disposable first post-move release selects the
  right products without duplicate notes, forgotten pending releases or version
  reuse. No actual registry mutation is needed to complete the mapping.
- [ ] **03 — Capture minimal failing reproductions.** Depends 01. Browser:
  trace startup/process stderr/endpoint lifecycle on the actual browser lane.
  iOS: trace Expo/RN/Hermes/JSI dependency and header selection. **Done:** each
  failure has a causal diagnosis and narrow reproduction, without raising
  timeouts or launching another exhaustive CI run as the diagnostic method.

### Phase B — establish the readable ownership layout once

- [x] **04 — Move existing products and update references.** Depends 02a,27b.
  Apply the target tree in a coordinated structural pass. Update workspace
  members, local package paths, Moon roots, release paths, native build paths,
  include paths, source pins, workflows and docs links together. Do not leave
  forwarding script forests or compatibility directories. **Done:** manifests
  parse, native dependency queries and Moon project/task discovery resolve;
  no active build reference points at a removed path. Deeper extraction follows
  below; a moved product is not marked functionally complete yet.
- [ ] **05 — Normalize project commands and task edges.** Depends 04,06b. Replace
  ambiguous compile/unit/smoke/regression/release-package aliases with the
  vocabulary above after inspecting actual commands. Keep necessary internal
  tasks. Fix ordering at data dependencies, not via global prerequisites.
  **Done:** each leaf README has exact local commands and prerequisites;
  action-graph inspection shows producer-before-consumer and no duplicate
  inherited checks. Repeat build/package invocations have explicit semantics.
- [ ] **06 — Consolidate source/toolchain preparation.** Depends 04. Keep one
  immutable PG source authority, common ICU library build helper, product-local
  Wasmer/toolchain pins. Preserve exact-pin and transactional fetch behavior.
  Remove guessed mirrors and silent PATH fallback. **Done:** clean/repeated/
  interrupted preparation tested at the owning boundary; missing prerequisites
  fail clearly; no product command needs sudo or all-repo setup.
  Apply the three-lane PostgreSQL patch hierarchy below: one common source and
  shared patch authority, explicit ordered lane series, no postmaster borrowing
  files from the embedded WASIX product. Preserve the selected deltas and their
  build guards; classification is not permission to drop optimizations.
  ICU checkpoint: native and WASIX now consume
  `third-party/icu/tools/build.sh` through the existing ICU source dependency.
  Native tools retain their configured absolute path and restore the previous
  build on failure; target installs validate a `DESTDIR` stage before replacing
  the installed prefix. The owner test proves repeat/changed-input behavior and
  configure/build/install failure retention; real cached Linux ICU installation
  preserves library bytes. This does not establish crash-safe concurrent cache
  publication or replace the remaining platform qualification.
- [ ] **06b — Consolidate TypeScript tooling on Bun and retire pnpm.** Depends
  04. Follow the Bun migration contract below. Bun is the maintainer TypeScript
  runtime and test runner; target Bun workspaces, one root bun.lock and no pnpm
  machinery. Pin stable 1.4.2 as verified on 2026-09-11; reassess the latest stable
  release at implementation start, then freeze one exact version for the change.
  **Done:** clean/frozen/repeated installs, leaf commands, Moon dependency
  discovery, packed workspace/catalog dependencies, docs and native integration
  consumers work. Remove pnpm installers/scoped-workspace writers/configuration,
  stale locks, caches and CI steps; migrate useful Vitest tests to bun:test and
  delete redundant ones. Keep required browser/device harnesses and host-specific
  product execution. Record an actual blocker before retaining any exception;
  do not implement a package-manager compatibility layer.

### Phase C — fix genuine package boundaries

- [x] **07 — Create the shared Rust query crate.** Depends 04–05. Replace
  include/copy build-script paths in both SDKs with a versioned path+registry
  dependency. Publish as a normal dependency; retain public type behavior.
  **Done:** both SDKs build/test; clean packaged consumers resolve the crate;
  source-copy infrastructure is deleted and cross-SDK types are intentional.
  Move QueryResult/QueryRow inherent methods into the owning query crate:
  consumers cannot add inherent methods after these types become external.
  Use shared query/decode errors and direct SDK-boundary conversion; delete
  duplicate text accessors and unnecessary anyhow/public-error round trips.
  Preserve meaningful behaviour, not the existing arrangement of wrappers.
  Apply the behaviour-based query proof contract below with 08,23,25.
- [x] **08 — Finish the TypeScript query package.** Depends 04–05. Keep only
  reusable query/protocol code. Native/WASIX/RN consume the declared workspace
  package as a normal published npm dependency; remove bundled-source copies;
  no invisible unpublished dependency in a published package. **Done:** clean
  packed consumers work; shared changes select all actual consumers; no SDK
  copies a parallel hand-maintained query implementation.
  Use the same behaviour-based query proof contract as 07. Browser/RN adapters
  keep only their conversion and host-specific checks; no duplicate decoder
  suite in every SDK or assertions against implementation source text.
- [x] **09 — Extract shared native Rust execution.** Depends 07. Move the
  minimal actual native embedded lifecycle/session API out of the public SDK.
  Keep server spawning and broker transport out. Trace config/error/resources
  and cancellation types before extraction to avoid circular dependencies.
  **Done:** direct SDK and broker both use the new publishable crate; preserve
  close, cancellation, error behavior, resource lifetimes and data persistence.
  Include the Node/Deno lifecycle requirements identified in the consolidation
  review below: generation-aware cleanup, resident-library lifetime, operation
  error capture and raw-stream completion. Do not extract an SDK-dependent API
  that forces the addon or broker to import the public SDK again.
- [ ] **09a — Replace the native C++ addon with a Rust napi-rs boundary.**
  Depends 09. Add a normal Cargo cdylib manifest to sdks/ts/node-addon and consume
  liboliphaunt-native-bindings. Keep JS conversion/promises/callbacks/environment
  cleanup in the addon; shared native operations belong to the bindings crate.
  Reuse the existing napi/napi-derive/napi-build versions and Node-API 8 target;
  avoid another per-adapter executor, Tokio runtime or generic backend framework.
  **Done:** existing native behavior tests pass through the new addon, including
  long-query responsiveness/cancel, raw streaming/error recovery, close/reopen,
  forgotten/stale handles and worker termination with pending work. No callbacks
  access a destroyed environment, stale generation closes a new session, or
  runtime image unloads while native work remains. Package per existing desktop
  target; compare installed closure/build cost to the old addon. This task closes
  the replacement adapter implementation and focused native proof. Task 09b owns
  final cross-host cutover and deletion of the old implementation; temporary
  comparison fixtures are not a shipped fallback or an extra permanent backend.
- [ ] **09b — Consolidate Node/Bun/Deno loading and retire duplicate native FFI.**
  Depends 09a,18,19. One TypeScript package resolver and one napi-rs addon per
  native target serve all three hosts. Remove Deno.dlopen/UnsafePointer/callback
  code and handwritten ABI layouts; migrate broker/server callers before removing
  assets-deno.ts. Use node: filesystem/module/process/socket compatibility APIs
  where they work; keep only demonstrated host differences. Keep broker/server
  clients addon-free and preserve explicit local runtime/asset overrides.
  **Done:** frozen native packages install and execute under pinned Node/Bun/Deno
  on each declared desktop target, without Rust/C++ compilation or postinstall
  downloads. Document/test Deno node_modules and scoped permissions, missing-addon
  errors, optional resources/extensions and package exports. Existing supported
  behavior survives; no silent fallback to the deleted FFI backend. Port actual
  lifecycle/failure tests instead of retaining source-spelling assertions. Delete
  the C++ addon, Node-header acquisition and exclusive build/tests after parity;
  preserve any C ABI fault fixture still needed by the shared bindings. Apply
  the CI/release/version and browser/mobile separation rules in the review below.
- [ ] **09c — Prove generated Swift/Kotlin bindings over shared Rust.** Depends
  09. Run the bounded UniFFI feasibility work specified below before rewriting
  mobile bridges. **Done:** record actual Android/Apple build and behavioural
  evidence, packaging/dependency/size costs, and a go/no-go decision per supported
  surface. A generated hello-world or desktop Rust test does not close this task.
  **Implemented/proven:** shared Rust owner, request-scoped cancellation,
  generated Swift 6 strict-concurrency and Kotlin public-facade execution on
  Linux; both shipped Android ABI libraries and actual Maven carriers build.
  **Remaining:** Apple framework/installed SwiftPM execution, Android device/R8
  qualification, and the requested shipping size/copy/build-cost comparison.
- [ ] **09d — Consolidate mobile execution or apply the minimal C fallback.**
  Depends 09c,18,19. On successful proof, replace handwritten native bridges and
  duplicated proven-shareable query/session behaviour with Rust plus generated
  Swift/Kotlin bindings. Otherwise retain the minimal platform bridges and
  migrate operations to the existing _with_error C ABI. **Done:** the chosen
  path preserves all declared mobile/desktop SDK behaviour, uses ordinary
  manifests and final carriers, and deletes the superseded implementation/tests.
  No permanent dual backend, platform-wide rewrite or extra generated SDK layer.
  **Implemented:** production Swift/Kotlin use the private UniFFI adapter;
  handwritten Swift C/JNI session bridges are deleted. Shared Rust owns execution,
  shutdown and cancellation, while idiomatic facades retain admission and resource
  preparation. Android carriers include generated bindings and per-target legal
  inventories; Swift generated source and framework publication are wired.
  **Remaining:** the unavailable Apple and Android device gates in 09c; do not
  repeat the completed bridge migration or mark platform parity proven by Linux.
- [ ] **10a — Prove PG wire for the native broker.** Depends 09,11. Follow the
  broker contract below: native incremental protocol boundary, standard startup/
  auth/cancel, one active backend and a tiny separate management channel.
  **Done:** independent ordinary clients, fragmented extended-query/Flush/Sync
  traffic, streaming/backpressure/cancel and malformed/disconnect cases work on
  the real native engine. Record maintained-code/dependency cost versus current
  framing. Do not treat the existing WASIX proxy as a working native adapter.
  **Implemented/proven on Linux:** production broker and Rust/TypeScript clients
  use standard startup/password authentication, BackendKeyData/CancelRequest and
  SQL PG wire, with separate lifecycle management. Native incremental input is
  bounded at 128 MiB to preserve the prior request limit; real clients pass
  >4 MiB Bind, later Flush/Sync, COPY/CopyFail recovery and cancellation.
  Stream tokens reject stale feeds. Completed disconnects reset safely; partial
  batch disconnects terminally close the helper instead of hanging or replaying
  uncertain work. Native Linux cancellation wakeups use PostgreSQL's self-pipe.
  Final Linux broker/native archive consumers and Node/Bun/Deno direct/broker
  query and backup/restore contracts pass.
  **Remaining:** shipped Windows/macOS transport qualification and the requested
  maintained-code/dependency comparison. Do not repeat the completed prototype
  or consumer cutover.
- [ ] **10 — Clean the retained desktop broker.** Depends 09,10a. Remove public
  SDK internal-feature dependency. Keep the child executable and necessary
  authenticated IPC operations; review redundant framing/adapters. Do not
  introduce a new RPC stack without a demonstrated reduction. **Done:** direct
  and broker semantic checks pass; invalid authentication, cancellation,
  child death and shutdown remain correct; no ambiguous SQL replay.
  **Implemented:** shared native bindings replace the public SDK internal-feature
  dependency, and production SQL traffic uses PG wire. Final Linux archive
  consumers pass; Windows/macOS shipped transport qualification remains open.
- [ ] **10b — Cut broker consumers over to PG wire and remove query envelopes.**
  Depends 10. Use the proven protocol boundary and common pgwire-server library
  where it actually removes duplication; keep broker process/config/control
  ownership local. Migrate Rust/TS clients, package/version dependencies and
  standard-client qualification. **Done:** delete PGOB query/chunk/cancel paths
  and duplicate adapters after equivalent public behaviour; retain only required
  management operations. No second binary, HTTP/RPC framework or falsely
  advertised concurrent server is introduced by the protocol change.
  **Implemented:** Rust and TypeScript clients use the production PG wire path;
  SQL/query/chunk/cancel envelopes are removed. Lifecycle control stays separate.
  **Remaining:** final supported-platform packaged consumer qualification; Linux
  and its Node/Bun/Deno host matrix already pass.
- [x] **11 — Extract pgwire-server library and CLI.** Depends 07. Move the
  existing WASIX proxy and CLI under one independently versioned owner. Remove
  SDK back-dependencies by passing existing public/runtime facilities. Preserve
  the currently supported connection scheduling, protocol and storage behavior.
  **Done:** a standard PostgreSQL client connects to the installed CLI; query,
  disconnect/reconnect, error and shutdown tests pass; no concurrency claims
  beyond observed behavior. No extra standalone daemon framework.
- [ ] **11a — Simplify native server readiness and consumer proof.** Depends
  14. Trace Rust/TS readiness and smoke-client callers. Keep only the bounded
  connection/child-lifecycle behaviour production needs; remove the TS private
  query client path after moving server smoke queries to an ordinary PostgreSQL
  driver (reuse an existing dev dependency where possible). Do not introduce a
  production driver just for tests or weaken readiness to an open-port probe.
  **Done:** a clean packaged server is queried by a standard external client;
  requested database/user readiness, child exit, timeout, endpoint ownership
  and cleanup failures retain meaningful coverage. No published query machinery
  exists solely to serve a smoke test; server mode still exposes its endpoint.
- [ ] **12 — Make the browser host a real owned build project.** Depends
  03,05,06. Put it under runtimes/wasix-browser-host, retain its Rust/WASM pins and
  JS packaging. Make preparation and build inputs visible; keep consumption by
  sdks/ts-wasix/sdk explicit. Do not create another browser SDK. Fix the browser
  failure diagnosed in 03 at its actual owner.
  **Done:** standalone host build produces pinned WASM/glue; SDK browser test
  consumes it; failed browser startup surfaces process failure immediately;
  storage/query/close behavior is checked in the supported browser lane.
  Deeper extraction of implementation from vendor patches is parked in #212;
  Wasmer family convergence is parked in #213. Neither blocks this task.
- [ ] **13 — Make the postmaster executor locally buildable.** Depends 06.
  Replace or minimize workspace injection through Cargo.toml.in. Prefer an
  ordinary product-owned manifest with explicit prepared Wasmer dependencies;
  keep any unavoidable generated path configuration minimal and documented.
  Preserve compiler-free executor versus compiler-bearing producer separation.
  **Done:** documented preparation then Cargo/Moon build works from its owner;
  packaged executor excludes compiler tools; concurrent backend behavior and
  required host capabilities pass their focused behavioral checks.
- [ ] **14 — Separate PostgreSQL tools ownership.** Depends 04–06. Move
  native/WASIX tool packages and TypeScript tools facade to their owning products;
  retain initdb/dump/restore and supported targets. Remove automatic SDK/addon
  inclusion. **Done:** clean selected tools consumer can initialize and perform
  logical dump/restore; default SDK install excludes utility binaries.
  - [x] Native and WASIX utility archives, Rust carriers and npm carriers have
    independent `postgres-tools/native` and `postgres-tools/wasix` owners.
    Existing registry identities retain their history; transferred versions
    start at 0.2.1. Runtime compatibility versions remain separate.
  - [x] Native tools archive carries its own shared-library closure. Linux
    packaged consumers completed logical roundtrips on Node, Bun and Deno
    without borrowing runtime libraries; repeated archive bytes matched.
  - [x] WASIX addon exposes execution-only tooling through ABI 2. Optional
    tools supply portable bytes plus trusted target AOT bytes/manifest;
    Rust checks module hashes, engine, target and source identity. Default
    addon dependency closure excludes utility asset crates.
  - [x] Portable npm descriptors derive hashes and sizes from owner archives.
    Four optional target npm carriers supply native AOT; browser exports use
    portable bytes. SDK/facade versions are no longer coupled.
  - [x] Tools facade package and host/browser behavior tests have their own
    tasks. SDK tests no longer pull utilities; tools tests depend on SDK
    outputs. Browser logical roundtrip duplication is removed and its direct
    and Worker cases remain in the tools-owned browser entry.
  - [x] CI and release preparation transfer separately owned tool artifacts;
    publication reuses existing carrier assembly and source-package downloads
    instead of adding a tools aggregate job or another release procedure.
  - [ ] Rebuild matching WASIX portable/AOT outputs after structural changes
    settle, then run the tools owner's native and browser consumer tasks.
    Cached pre-move WASIX artifacts currently fail the preserved source
    fingerprint guard; source/package fixtures do not replace this proof.
  - [ ] Complete target artifact qualification on macOS/Windows and the final
    publication-lock/dry-run aggregate with the independently owned archives.

### Phase D — selectable database resources and extensions

- [ ] **15 — Establish the database-resources producer.** Depends 06,14.
  Move seed recipes/contracts and ICU data pin/packaging under one owner.
  Decouple native resource packager responsibilities. Define one asset manifest
  with profile, physical compatibility, producer identity, ICU requirement and
  checksum. **Done:** seed production requires runtime tools, never vice versa;
  standard/ICU seeds can be produced independently; one canonical ICU data tree.
  - [x] Mobile CI transfers the existing native build outputs and ABI receipts
    into seed tasks without selecting runtime packages or recompiling native
    code. iOS seed execution uses macOS; receipt-only validation stays on Linux.
    Target handoffs preserve executable modes and symlinks in tar envelopes.
    The local workflow aggregate passes, including real handoff execution and
    Android/iOS seed-only dependency plans; actual mobile seed qualification
    still requires the corresponding native runner outputs.
- [ ] **16 — Package independently selectable resources.** Depends 15. Produce
  separate installable seed carriers by runtime/profile/required target plus
  one compatible shared ICU data carrier per ecosystem. ICU seed depends on
  data, without copying it. Add no default all-assets package. **Done:** clean
  consumers install standard only, ICU only, and native+WASIX ICU selections;
  package/download/application sizes demonstrate absence of unselected assets
  and reuse of identical ICU data. Record Swift source-fetch limitations rather
  than calling linker omission “selective download.”
- [ ] **17 — Remove runtime and addon payload embedding.** Depends 16.
  Update native/WASIX Cargo/npm carriers, WASIX addon build.rs and mobile
  resource assembly. SDK initialization consumes explicit seed/data inputs.
  Existing databases need no seed; supported desktop initdb paths remain.
  **Done:** default SDK/runtime/addon artifacts contain neither seed nor ICU
  data; missing required seed/data gives a useful error; standard and ICU
  initialization/reopen work on declared surfaces without runtime downloads.
  Apply the resource-consumption contract below: move immutable composition to
  producers and native application build integration, delete SDK-local package
  assemblers/duplicated catalog-cache logic, and retain only necessary runtime
  location, compatibility and mutable-storage operations. Trace explicit custom
  resources/extensions as well as defaults before deleting any branch.
- [ ] **18 — Preserve compatibility and safe initialization.** Depends 17.
  Reject wrong runtime/physical format/ICU data and corrupted archives before
  touching existing PGDATA. Preserve staging, concurrency locks and interrupted
  initialization recovery. Do not assume postmaster accepts lightweight seeds.
  **Done:** real packaged seeds boot, persist, reopen and support ICU collations
  as selected; wrong/corrupt inputs preserve existing data. Repeated producer
  invocations do not duplicate publication work. Freeze verified seed bytes;
  do not assert byte-reproducible initdb without demonstrating it.
- [ ] **19 — Localize extension model and selection.** Depends 04,16–17.
  Move extension contracts and product-specific packaging from shared/root
  tooling. Preserve contrib distribution versus independent external products,
  upstream-bound versions, source pins and per-product notices. Remove addon
  defaults that include every extension. **Done:** two selected contrib members
  plus an external member stage only selected members; every declared carrier
  exists and loads on its promised target; unsupported selection fails clearly.
  Follow add-oliphaunt-extension evidence requirements when changing support.

### Phase E — ecosystem consumers and repository cleanup

- [ ] **20a — Share React Native JSI mechanics.** Depends 03,08,09d. Apply the RN
  contract below after deciding the mobile boundary. Share platform-independent
  buffer/promise/stream acknowledgement/teardown logic in RN-owned C++; keep
  JNI/Objective-C++ and actual platform SDK calls thin. **Done:** final Android/
  iOS RN apps prove binary ranges/lifetimes, callback abort, cancellation,
  shutdown and JS runtime destruction. Remove duplicated machinery and tests;
  retain platform differences supported by source and actual behaviour.
  **Implemented:** Android and iOS include RN-owned `cpp/Jsi.h` and
  `cpp/Lifecycle.h`; common lifecycle behavior has one C++ test owner.
  **Remaining:** final Android/iOS/Hermes application tests for callback waits,
  cancellation, reload and runtime destruction. Shared helper tests alone do not
  close the platform integration acceptance.
- [ ] **20 — Finish Swift, Kotlin and React Native integration.** Depends
  08,09b,09d,20a,17–19. Reconcile root/local Swift public products from one authority;
  preserve required root SwiftPM publication. Move Maven artifact assembly out
  of the SDK where it is runtime-owned; retain useful Gradle integration.
  Fix the actual RN/Hermes/JSI inconsistency diagnosed in 03. **Done:** packaged
  Swift/Gradle/RN consumers build; real simulator/device tests exercise selected
  assets. Current direct-mode mobile behavior is preserved; PR #126 isolation
  research remains documented separately, not silently advertised as shipped.
  **Implemented:** Swift source/binary carrier wiring and root manifest rendering,
  Android Maven carrier integration, and separately selected mobile seed/ICU
  resources. APK reporting accepts one matching seed or seedless existing storage;
  actual archive fixtures and seedless Gradle resolver tests pass.
  Kotlin source qualification now excludes Android native payload builds;
  real AAR tasks retain both ABI producers before resource merging. UniFFI's
  existing JNA cleaner preserves Android API 24 support. Lint, JVM/Android unit
  tests, configuration-cache serialization and native binding behavior pass
  locally; these do not substitute for installed-device qualification.
  **Remaining:** installed Apple SwiftPM/app and Android/iOS RN device qualification,
  including the shared JSI lifecycle gates in 20a. No new process isolation claim.
- [x] **21 — Delete remaining generic shared ownership.** Depends 07–20.
  Apply every shared-domain disposition above. Review all import/call sites;
  localize single-consumer helpers; retain only proven common packaging code.
  **Done:** no miscellaneous shared product holds unrelated policy, product
  behavior and packaging. Necessary shared code has normal declared consumers.
- [x] **22 — Remove command orchestration from TypeScript and excess xtask.**
  Depends 21. Include test setup and child_process calls, not only production
  scripts. Shell fixtures invoke commands and pass data to TS checks; TS uses
  native filesystem/HTTP APIs. Keep Rust where it implements actual compiler,
  runtime or binary-format work. **Done:** no TS-through-Shell orchestration or
  owned JS/Python source; deleted wrappers have a verified replacement or no
  remaining caller. Do not wrap every command in a new helper library.
  **Local completion:** maintainer/test commands run from Shell; shared archive,
  Git and release checks use owner-local data assertions. The complete release
  aggregate and source-fetch archive/Git fault suite pass. Remaining TypeScript
  process calls implement product runtime/tool execution or isolated Node addon
  lifecycle consumers, not maintenance orchestration.
- [ ] **23 — Consolidate docs, examples, fixtures and benchmarks.** Depends
  04,20–22. Move single-owner examples/tests local, retain real integration apps
  at root, combine docs source and maintainer content without changing URLs.
  Remove abandoned benchmarks and fixture frameworks only after caller review.
  Update architecture documents and skills to actual new commands/contracts.
  **Done:** docs build, relevant examples build/run, relative links resolve;
  no old architecture is still labelled canonical after its replacement lands.
- [ ] **23a — Simplify the docs product and release freshness.** Depends 23,29a.
  Local cleanup can start after 23; close the release/deploy integration after
  29a. Follow the docs review below: remove API-generation
  coupling and docs-version scaffolding, retain useful written guides, and
  define published-version lookup and Vercel deployment behavior. **Done:**
  local docs tasks need no SDK build; each remaining input has an actual
  consumer; release candidates cannot masquerade as published product versions;
  guide updates reach oliphaunt.dev through a documented, retryable process.
- [ ] **30a — Re-audit docs against the final repository and principles.**
  Depends 23a,29a. Run after implementation and before final acceptance task 30.
  Re-read the final
  docs manifests, task graph, release PR updater, CI and Vercel configuration.
  Verify that later refactoring has not restored SDK compilation dependencies,
  duplicated checks, version snapshots, hardcoded candidate-version drift, or
  an independent docs release bureaucracy. Exercise local build and exported
  links, representative affectedness, a product release and a docs-only update,
  and failed-deployment recovery. Reuse existing meaningful checks and release
  evidence; this is a completion review, not a new permanent meta-check suite.
  **Done:** record evidence and unresolved limitations against the final state;
  an earlier docs build or directory move alone does not close this task.

### Phase F — predictable local checks and CI

- [ ] **24 — Replace duplicated CI graph machinery.** Depends 05,21–22.
  Reduce tools/graph to projecting Moon-selected tasks onto required runner
  capabilities and artifact transfers. Move workflow behavior tests beside that
  adapter. Keep stable required job names and correct skipped/failed behavior.
  **Done:** representative changes select exactly required producers/consumers;
  no path-regex second scheduler; downloaded qualified artifacts are consumed
  without producer rebuilds; cold and warm runs have the same semantics.
- [ ] **24a — Define every PR/main event and comparison.** Depends 24. Cover
  normal and fork PRs, release PRs, merge groups, main pushes, manual diagnostics
  and PR closure. Bind the planned tree and checked-out tree to the same exact
  revision. Use a valid immutable comparison base; handle shallow history,
  initial/all-zero push bases, renames/deletions and generated changes. Separate
  PR integration proof from release eligibility: PR-head success does not prove
  a different merge SHA. **Done:** event tests cover base movement, fork PR,
  merge-group revision, docs-only/empty selection and invalid comparison; no
  accidental self-comparison or false-empty plan. Ordinary PR checks require
  no release credentials, registry setup or publication-ready history.
- [ ] **24b — Make workflow execution and artifacts predictable.** Depends
  24a. Review all seven workflow files, local actions and .github/scripts; remove
  duplicate builders between reusable workflows and parent jobs. Declare runner
  setup at the narrowest task, isolate concurrent output directories, and keep
  cache keys tied to actual compiler/target/input identities. Cancel superseded
  PR work and make PR closure allocate no runners; avoid duplicate main-push and
  manual qualification for one candidate. **Done:** cold/warm and concurrent
  runs agree; failed/missing artifacts cannot appear successful; consumer jobs
  never rebuild transferred producers; useful failure logs survive failure.
  Source-failure checkpoint: producer jobs wait for source checks and tests;
  downstream platform aggregates and consumers also reject failed ancestors,
  while allowing intentionally unselected platform jobs to remain skipped.
  This removes the observed missing-artifact cascades after source failures.
  Offline Cargo consumers seed resolution from the candidate lockfile instead
  of selecting newer registry versions; isolated locked-version caches pass.
- [ ] **24c — Migrate required checks and trust settings together.** Depends
  24a–24b. Inspect actual remote branch/ruleset settings, bot permissions,
  protected release environments and trusted-publisher workflow identities.
  Preserve read-only untrusted PR execution, isolate privileged publication,
  and do not use elevated PR events to run untrusted source. Keep `Required`
  stable unless an intentional settings migration is necessary. **Done:**
  required jobs fail on failed/cancelled/missing selected work, accept only
  intentionally unselected jobs, and do not wait forever on removed checks.
  Prepare any necessary remote-setting change as a concrete cutover step;
  deleting a local policy test does not silently weaken remote controls.
- [ ] **24d — Make Windows product orchestration Bash-based.** Depends 06,14,
  17,24b. Split build-postgres18-windows.ps1 and
  package-liboliphaunt-windows-assets.ps1 by actual responsibilities, then move
  shared orchestration to Bash and data processing to TypeScript. Retain the
  supported MSVC target, Windows SDK, import libraries and VC runtime closure;
  do not switch to MinGW/MSYS-linked products to simplify scripts. Initialize
  Visual Studio once through its provided developer command launcher; prefer a
  minimal cmd-to-Bash setup boundary over reimplementing the environment.
  Remove the separate PowerShell build-time MSVC discovery path. **Done:**
  native Windows build and clean packaged-consumer tests pass with no Bash,
  Git/MSYS or WSL dependency for the end user; no new runtime DLL dependency.
  Exercise spaces/Unicode paths, slash-prefixed compiler arguments, PATH tool
  collisions, native exit codes and repeated setup. Any remaining setup-only
  PowerShell shim must have an explicit necessary purpose and minimal scope.
- [ ] **24e — Split host-neutral work from native host proof.** Depends 24d,
  15–20. Inventory every Windows/macOS task and subcommand by its actual need:
  native compiler/SDK, target execution, OS semantics, or portable processing.
  Move portable packaging, metadata, checksums, archive/binary inspection and
  release coordination to Linux. Keep native compilation/Apple SDK builds,
  Windows/macOS runtime tests and simulator/device tests on their required
  hosts. Package consumes finished outputs and never runs native smoke/initdb
  implicitly. **Done:** narrow native producers feed Linux assembly/inspection,
  followed by native consumer proof of the final package when needed; no OS
  test is claimed complete because a binary parser succeeded. Local Linux
  commands run the same portable logic, using explicitly supplied native
  artifacts where required. No new mandatory cross-compilation project.
- [ ] **24f — Align local capabilities with hosted setup.** Depends 24e.
  Remove GITHUB_ENV/ImageOS/ImageVersion requirements from ordinary local
  toolchain selection and verification; CI adapters record hosted provenance.
  Keep precise runner/toolchain pins for hosted release evidence. Distinguish
  Windows/macOS execution, Apple SDK, Android SDK/KVM, compiler and packaging
  capabilities in existing Moon metadata only where real tasks need them.
  **Done:** a Linux maintainer can run all portable checks without pretending
  to be GitHub Actions; unsupported native checks report their exact prerequisite;
  command capability and resulting runner selection agree. A Windows/macOS
  contributor can use locally installed supported tools without runner-image
  variables. Sudo remains confined to explicit CI provisioning.
- [ ] **24g — Repair affectedness precision and missing setup edges.** Depends
  04–06,24,24f. Replace detached CI project allowlists and command-string
  classification with declared task/project relationships. Localize broad
  mixed-platform source groups and reference shared owners rather than duplicate
  individual file lists. Declare actual setup/toolchain consumption for native
  proof. Prefer ecosystem dependency inference where supported, but explicitly
  declare cross-language inputs that cannot be inferred. **Done:** the probe
  cases below select necessary consumers without unrelated target builds; a
  new source file under an owned source directory is covered without editing a
  whitelist; shared-input and setup changes cannot silently skip their consumers.
  Exercise rename/deletion and exact Git-range selection as well as direct-file
  probes. Inspect unowned changed files through existing graph diagnostics;
  do not add a parallel permanent file-to-product classification database.
- [ ] **25 — Remove low-value and duplicate checks.** Depends 24g. Inventory
  every task/test's failure it prevents. Delete source-spelling, document/task
  existence and duplicate metadata assertions; retain behavioral tests around
  data loss, package selection, invalid external inputs and publication. Run
  source checks before expensive builds, consumer/device checks after outputs.
  **Done:** one appropriate owner per guarantee; no release automatically runs
  every benchmark/example/coverage job. Removed checks have recorded rationale.
- [ ] **25a — Justify and place every blocking check.** Depends 25. Make a
  one-time review ledger of CI/release assertions: consequential failure caught,
  owning project/task, actual inputs, earliest useful execution point and later
  consumers of its result. Delete rules about incidental layout/source spelling
  unless an actual external consumer requires that exact shape. Narrow real
  package-shape checks to public archives/interfaces. Move example validation
  to example tasks and source acquisition tests to source preparation owners.
  **Done:** every retained blocking check has a meaningful failure and defined
  task; workflow steps introduce no hidden product validation. Hosted-only gate,
  credential and artifact-transfer operations remain small explicit CI adapters.
  This ledger is migration review material, not a new permanent checker for
  check ownership or a new test policy framework.
- [ ] **25b — Reuse proof at the right boundary.** Depends 25a,26a. Run source
  formatting/lint/unit/tooling tests when their actual inputs change, before
  expensive product work. Verify final package bytes after assembly. Publish
  consumes these results for the frozen candidate and does not rerun repository
  layout checks or all release-tool unit tests. Revalidate only facts that can
  change after qualification, or bytes crossing a trust/transfer boundary.
  **Done:** an execution trace shows each selected source check once; changing
  an unrelated example cannot block an SDK publication; publishing reruns no
  compiler/source suite; corrupted transferred artifacts and conflicting public
  versions still fail. Do not infer evidence validity from a cache hit alone.
- [ ] **26 — Make release qualification product-scoped.** Depends 19–20,24g,25a.
  Replace the unconditional all-platform manual gate with exact-candidate
  qualification of selected products, required dependencies, affected consumer
  compatibility and each selected product's declared target surface. Keep a
  separately runnable exhaustive audit. Reuse unchanged published dependencies
  by verified identity; don't accept arbitrary old green runs for changed code.
  **Done:** SDK-only release does not rebuild unrelated runtimes/mobile apps;
  runtime changes select dependent behavior; extension source changes retain
  required same-run lifecycle evidence; missing selected target proof blocks
  publication. Update qualify/release skills and branch protection expectations
  together; their current all-target requirements describe the old contract.
- [ ] **26a — Bind artifact reuse to the release candidate.** Depends 26.
  Extend existing candidate/qualification records rather than add a second
  provenance system. Record selected products, exact candidate SHA/tree,
  required tasks/targets, immutable artifact IDs/digests and producer run/attempt.
  Distinguish source changes, unchanged published dependencies and envelope-only
  changes. Cross-commit producer reuse requires verified unchanged producer
  inputs/toolchain and compatibility, not merely a matching branch or version.
  **Done:** stale/missing/mismatched/wrong-attempt evidence blocks release;
  valid unchanged binary reuse avoids recompilation; package-consumer checks
  still cover the final envelope. Preserve extension same-run evidence rules.

  **Reuse investigation:** pinned Moon 2.5.4 was exercised in a disposable Git
  project with a real producer dependency. Unchanged task inputs across commits
  retain the same hash; changing a declared compiler input changes it. However,
  `--upstream none` records the dependency hash as literal `passthrough`, and
  `cache: false` native compiler tasks have an empty last-run hash. System tasks
  do not implicitly fingerprint OS, architecture or installed compiler versions.
  Therefore a reusable receipt must reject empty/passthrough ancestry, bind the
  actual target/compiler identity and the original immutable artifact/run/attempt,
  and retain candidate-side consumer checks. An old task hash or published version
  alone is insufficient. No cross-commit SHA check was relaxed. Before enabling
  reuse, opt a concrete producer into complete native Moon hashing and receipt
  capture; do not introduce a parallel file whitelist or accept cache presence as
  qualification. The disposable proof is local evidence, not hosted qualification.

  **Portable producer receipt pilot:** the existing shared TypeScript query SDK
  package job now records its complete Moon build/package hash ancestry, actual
  Moon/Bun/TypeScript versions, whether execution ran or restored from CAS, and
  the uploaded artifact's immutable ID, digest, size, source SHA and run attempt.
  Qualified embeds that receipt in the existing candidate record. Missing,
  failed, unhashed or passthrough chains report a non-reusable reason; candidate
  validation rejects incomplete chains and wrong attempts. No alternate artifact
  restore engine or cross-SHA downloader exception was added. The real package
  build completed in 2.4 seconds and an unchanged repeat restored both tasks in
  175 milliseconds with identical hashes. Twelve receipt/candidate tests pass.
  This pilots the existing Moon CAS path only: it does not prove native compiler
  reuse, original execution provenance for arbitrary historical cache entries,
  or hosted release qualification.

  **Product-scope checkpoint:** CI accepts `release_products_json` with known
  stable product IDs. Moon owner tasks, downstream consumers and producer
  dependencies determine selected builder tasks; source-check matrices use the
  same scope. The existing qualification record binds product IDs, tasks and
  candidate SHA, and publication rejects uncovered requested products. An empty
  selection retains the exhaustive audit. All producer dependencies still run
  in the same candidate run: cross-commit binary reuse is not implemented.
  Generated same-repository Release PRs and merged main release commits now
  derive the same selection from Release Please's actual manifest transition.
  Main push writes qualification only after Plan and Required succeed; PRs
  cannot create publishable evidence. Missing-run request/reuse is implemented
  below; no hosted qualification has been claimed from local graph tests.
  Local evidence: disposable Git histories prove identical PR/main product
  selection and rejection of an unknown manifest owner; 52 workflow/task-graph
  tests pass, as do 20 candidate/matrix/gate tests, seven strict release-history
  tests and four release-intent tests. The obsolete Cargo-only version scan
  was removed from release intent; manifest transition ownership and canonical
  package-version/publication validation remain at their existing seams.
- [ ] **26b — Remove the mandatory manual qualification ceremony.** Depends
  26a,27a. Final main-candidate qualification should run automatically for its
  selected release scope. If publish finds required evidence absent, it can
  request the existing CI workflow for that exact candidate and await it once,
  before entering credential-bearing publication. Reuse an already running or
  completed eligible run; fail with its causal log instead of an infinite wait.
  **Done:** the maintainer needs prepare-release-pr, review/merge, then publish;
  no obligatory separate full-qualification or dry-run dispatch. Missing
  qualification never authorizes publishing, and publishers never compile.

  **Request/reuse checkpoint:** readonly planning inspects exact-source CI and
  digest-verified product coverage. A small Actions-write job, with no cross-run
  artifact consumption, dispatches missing qualification; readonly preparation
  waits for and verifies the result. The request binds the candidate SHA and
  sorted product set. Running causal work is reused; failed work reports its URL;
  an ambiguous dispatch is not retried. The returned run ID and SHA are checked,
  and CI checks the request binding before builders execute. Requests require
  main to still equal the candidate: historical candidates must reuse or rerun
  their existing exact-source run. The existing release concurrency group
  serializes requests. Local three-phase fixtures cover reuse, active work,
  absence, uncovered products, failed CI, advanced main, ambiguous dispatch and
  a dispatch ref race. Fourteen waiter tests pass, including actual ZIP digest
  and candidate coverage validation. Actionlint, zizmor and permission checks
  pass; no hosted dispatch or publication was performed. Cross-commit reuse and
  final hosted qualification remain open, so this checklist item stays open.

### Phase G — release and bootstrap simplification

Implementation checkpoint: candidate preparation no longer calls the overloaded
`release-dry-run.sh` wrapper. Its qualification-record and registry checks were
duplicates of earlier steps in the same job; those earlier checks remain. The
separate clean exact-source check remains immediately before carrier assembly,
and publication still rechecks mutable registry state at its mutation boundary.
The wrapper never generated packages: local equivalents are the existing
release metadata/tool-test command and selected registry preflight, with owner
package/artifact tasks for actual package rehearsal. Removed the wrapper's
routing-only fixture and obsolete hosted-only argument; exact SHA, dirty-tree,
index-suppression and frozen-candidate behavior tests remain. The historical
`release-dry-run` environment name is retained; no remote environment migration
or publication operation was performed.
Validation: the full workflow aggregate passes, and eight focused source-state
and CLI tests pass. The release mutation aggregate ran 532 tests: 531 passed;
the sole failure was an old ICU-owner expectation left after the resources move.
That expectation was corrected to the actual independent resources owner and
its complete seven-test publication-plan file passes. This does not complete
product-scoped qualification or automatic qualification dispatch (26–26b).

- [ ] **27 — Make version preparation converge once.** Depends 23,27b,27c,27d.
  Use Release Please as the candidate version authority.
  Remove independent mirrored
  version authorities and unnecessary string surgery. Use native manifest
  versions where supported; derive unavoidable carriers/POM/podspec fields.
  Shared source bundled into a consumer must select that consumer for release;
  ordinary independent dependency edges alone must not bump every consumer.
  **Done:** prepare twice produces no second diff; locks/dependencies resolve;
  new resources/query/server products are modeled once; a metadata-only release
  does not recompile unchanged PostgreSQL/WASIX artifacts without need.
  **Implemented:** one pinned Release Please candidate authority and a derived
  compatibility/lock closer; local repeat preparation and source-package
  transition tests pass. **Remaining:** 27c's deliberately different product
  versions through installed consumers and 27d's reviewed product notes.
- [ ] **27a — Make the entire release-PR lifecycle converge.** Depends 27,24a.
  Cover creation, repeat preparation, new main commits, dependency/lock updates,
  PR conflicts, closed-unmerged/reopened PRs and merged-but-unpublished releases.
  Retain only necessary normalization; do not require an exact commit count for
  aesthetics. Ensure the bot's final update actually triggers required CI and
  obsolete raw/generated heads do not launch duplicate heavy qualification.
  Reconcile `autorelease: pending`/`tagged` only against verified publication.
  **Done:** preparation has one stable final tree; no-op prepare neither pushes
  nor restarts CI; no releasable changes creates no PR; main movement cannot
  overwrite unrelated edits; merged release PRs cannot be lost or marked
  published prematurely. Update release-intent checks for moved/new products.
  **Local proof:** disposable Git/PR fixtures cover no-op SHA reuse, main movement,
  lost-response recovery, reserved-branch conflicts and pending publication; the
  full release aggregate passes. **Remaining:** hosted bot-token creation/update,
  closed/reopened PR handling and proof that only the final candidate triggers
  the configured required checks. No remote mutation has been performed.
- [x] **27b — Verify the retained Release Please integration.** Depends
  02a. Before structural moves, verify the minimal retained configuration with
  representative Rust, TypeScript, Swift, Gradle, runtime-carrier and shared-source
  updates using disposable inputs. Consult
  the pinned action's actual bundled implementation, not only latest upstream
  docs. Evaluate workspace plugins against independent-release semantics rather
  than blindly enabling dependent bumps. **Done:** one authority for
  candidate versions/notes; no two independent engines editing the same version
  or changelog; shared source selects the correct released consumers. A
  source-bound compatibility closer may derive fields but never choose an
  independent version or write a second changelog. A demonstrated blocker is
  reported with a minimal reproduction; do not silently introduce another engine.
  **Verified locally:** the pinned Release Please library handles Rust/npm/Swift/
  Gradle updates, shared shipped-source selection and repeat output. The separate
  contrib bump/changelog engine is deleted; the closer only derives compatibility
  and lock fields. Actual library and disposable Git lifecycle tests pass.
- [x] **27c — Remove live-version literals and prove version transitions.**
  Depends 07–20,27b. Inventory every version-bearing manifest, generated file,
  source constant, example, test and public install snippet. Classify product
  version, dependency compatibility, immutable upstream pin, protocol/data
  schema, historical fixture or synthetic fixture. Generate package-internal
  version constants from the authoritative manifest; consume candidate metadata
  in live consumer checks. Keep intentionally independent fixture expectations.
  Prefer native lock regeneration over text surgery where compatible with the
  staged publication graph. **Done:** a disposable representative release bump
  uses deliberately different SDK/runtime/extension/resource versions, runs
  actual affected tests and package consumers, and prepares twice with no
  second diff. Wrong-version negative tests still fail. Do not update all
  numbers by regex or derive both actual and expected from the same helper.
  **Verified locally:** a disposable pinned Release Please candidate used TS
  SDK 2.3.4, native runtime 3.4.5, pgTAP packaging 4.5.6 and ICU resources 5.6.7.
  Actual installed packages passed SQL, pgTAP and ICU operations on Node 22,
  Bun 1.4.2 and Deno 2.8.1. A Cargo consumer compiled the 2.4.6 build helper
  with runtime 3.4.5 and independently versioned tools 0.2.1. Repeated metadata
  and lock preparation produced identical Git trees; repository versions were
  unchanged. Existing wrong-version and failed-transition checks remain.
  The rehearsal fixed Linux-only extension staging unnecessarily requiring
  Apple metadata, and the SDK rejecting Bun's ordinary 0664 license-file mode.
  Full meta carriers still require their Apple records; license digests and
  unsafe executable/special/world-writable mode rejection remain. This is a
  representative Linux consumer proof, not multi-platform publication.
- [ ] **27d — Fix product changelog ownership and relevance.** Depends 27b.
  Preserve existing published history and identify inaccurate existing entries
  explicitly. New release notes describe product-visible behavior and scoped
  dependency changes, not arbitrary shared commit bodies or CI churn. Review
  multi-product/breaking changes per product. **Done:** one changelog per real
  release product, no per-carrier/contrib-member changelogs; Swift/vector notes
  do not inherit unrelated browser/Rust storage warnings. A cross-product
  change has accurate product-specific notes and correct version impact.
  Prefer a reviewed release-PR editorial step or supported tooling over a
  custom semantic changelog classifier or regex assertions of prose.
  **Implemented:** release products own changelogs and Release Please is the sole
  candidate version-note writer. All 27 owner/config/history mappings were reviewed;
  each has one changelog and there are no extra carrier/contrib-member changelogs.
  Four newly extracted products label their working notes Unreleased instead of
  implying publication. The copied Rust WASIX/browser storage warning was removed
  from 17 unrelated owners' current changelogs; the two affected SDKs retain it.
  This editorial correction changes no other notes, headers, dates or commit links,
  and leaves immutable historical tags and published release assets untouched.
  **Remaining:** editorial review of the actual cross-product release candidate's
  product-specific notes and version impact. No semantic prose-checking engine.
- [ ] **28 — Shrink candidate assembly and publication.** Depends 25b,26b,27a.
  Preserve existing prepare-release-pr/publish operations. Publish stages one
  candidate from producer outputs with eligible producer evidence, freezes exact
  package bytes, qualifies those packages, then publishes in dependency order,
  verifies public consumers and promotes last. Follow the sequence below; never
  treat producer proof as final-package qualification. Remove duplicate
  dry-run/preparation/check layers only after tracing all callers. **Done:**
  no routine manual dry-run/bootstrap chain, no compiler in publication, and
  all ecosystem carriers derive from the same staged verified bytes.
  **Local proof:** preparation consumes qualified outputs on Linux without Rust
  or Apple/Android toolchains, freezes exact bytes and preserves dependency-order
  publication. Duplicate dry-run and setup layers are removed; the complete
  release aggregate passes. **Remaining:** final selected-product qualification
  and public distribution/visibility evidence in 26b/28a; no hosted publication
  is inferred from local transport fixtures.
- [ ] **28a — Finish distribution and release finalization boundaries.**
  Depends 28,26b,27a. Keep source package tags, binary GitHub assets, npm tags,
  Cargo dependencies and Maven visibility coherent with the selected candidate.
  Explicitly resolve SwiftPM's source-tag/binary-asset availability order; draft
  assets must not be treated as anonymously downloadable. Stage required
  headers/notices/checksums and preserve consumer selection for the new products.
  **Done:** every declared registry entry installs from a clean consumer when
  advertised available; no dependency points at an unpublished version; a
  partial public release is reported accurately and final PR labels/promotion
  happen only after their required evidence. Registry publication remains
  resumable, not an invented all-registry atomic transaction.
- [ ] **29 — Simplify bootstrap and retry without losing recovery.** Depends
  28a. Retain conditional first-name bootstrap already present. Audit the 169
  release-tool files and both normal/bootstrap state machines for duplicate
  ledgers, transport wrappers, speculative pacing and rechecks. Keep registry
  authentication, immutable byte reconciliation, dependency ordering, valid
  Retry-After handling and necessary interruption state. **Done:** fault tests
  cover no-op rerun, partial success, ambiguous upload and conflicting public
  bytes; only missing exact versions upload; mismatch stops; scoped credentials
  are used only for required missing identities. Do not promise atomic
  publication across independent registries or remove checkpoints blindly.
  **Local proof:** conditional missing-name bootstrap, no-op/partial-success
  recovery, ambiguous uploads, conflicting public bytes, dependency ordering and
  credential isolation pass the complete release aggregate. M06's bounded state
  has separate concurrency/recovery proof. **Remaining:** 29a's final retention
  and hosted recovery cutover.
- [ ] **29a — Define retention, main movement and recovery cutover.** Depends
  29,28a. Keep the candidate immutable after any public mutation. Document the
  supported rerun window and retain candidate/lock/receipts for that window;
  expired evidence is an explicit stop, never permission to rebuild different
  bytes under an existing version. Preserve distinction between product fixes
  requiring a new version and publication-controller fixes using an unchanged
  approved candidate. **Done:** retry after main advances, credentials expire,
  artifacts disappear, or a final promotion fails is deterministic; concurrent
  release dispatches cannot replace the active candidate. First-name bootstrap
  followed by ordinary trusted publication is covered, including newly created
  carrier names, exact publisher identities and credential cleanup.

### Phase H — close the gap with actual evidence

- [ ] **30 — Run the migration acceptance matrix.** Depends 29a,30a and all
  preceding implementation tasks/dispositions in the execution order below.
  Use the
  matrix below, first local/targeted, then hosted platform proof. Record outputs,
  graph closures, elapsed time, artifact sizes, compiler invocations and repeat
  behavior. **Done:** both baseline CI defects are fixed and verified, all
  retained products/functions have evidence, no unaccounted source domain or
  carrier is left behind, documentation matches actual commands, and the final
  exact commit passes the new required qualification contract. Report any
  unavailable device/registry proof as incomplete, never inferred green.

## Execution order and prerequisites

This table is the authoritative prerequisite order. Task numbers identify scope;
their numeric order alone is not a schedule. A range in descriptive prose means
numbered tasks only, never an implicit dependency on all their lettered follow-ups.
The early 27b checkpoint exercises existing configuration with disposable inputs;
the final post-move version transition is proven by 27c/27. M01–M18 close with
their linked owner tasks and are all reviewed by 30. No dependency points from
implementation back to final acceptance. This is a planning table, not a runner.

| Task | Prerequisites |
| --- | --- |
| 01 | none |
| 02 | 01 |
| 02a | 02 |
| 03 | 01 |
| 27b | 02a |
| 04 | 02a,27b |
| 06b | 04 |
| 05 | 04,06b |
| 06 | 04 |
| 07 | 05 |
| 08 | 05 |
| 09 | 07 |
| 09a | 09 |
| 09c | 09 |
| 09d | 09c,18,19 |
| 10a | 09,11 |
| 10 | 09,10a |
| 10b | 10 |
| 11 | 07 |
| 12 | 03,05,06 |
| 13 | 06 |
| 14 | 05,06 |
| 11a | 14 |
| 15 | 06,14 |
| 16 | 15 |
| 17 | 16 |
| 18 | 17 |
| 19 | 04,16,17 |
| 09b | 09a,18,19 |
| 20a | 03,08,09d |
| 20 | 03,08,09b,09d,20a,18,19 |
| 21 | 07,08,09,10,10b,11,11a,12,13,14,15,16,17,18,19,20 |
| 22 | 21 |
| 23 | 04,20,22 |
| 24 | 05,21,22 |
| 24a | 24 |
| 24b | 24a |
| 24c | 24a,24b |
| 24d | 06,14,17,24b |
| 24e | 15,16,17,18,19,20,24d |
| 24f | 24e |
| 24g | 05,06,24,24f |
| 25 | 24g |
| 25a | 25 |
| 26 | 19,20,24g,25a |
| 26a | 26 |
| 25b | 25a,26a |
| 27c | 07,08,09,10,11,12,13,14,15,16,17,18,19,20,27b |
| 27d | 27b |
| 27 | 23,27b,27c,27d |
| 27a | 27,24a |
| 26b | 26a,27a |
| 28 | 25b,26b,27a |
| 28a | 28,26b,27a |
| 29 | 28a |
| 29a | 29,28a |
| 23a | 23,29a |
| 30a | 23a,29a |
| 30 | 24c,25b,29a,30a |

The listed transitive closure covers every numbered task. Work independent of
an unfinished prerequisite may be prepared early, but the task cannot close
until its full contract and prerequisite evidence exist. Local docs cleanup can
begin after 23; 23a closes only after release/deployment integration is verified.
Remote setting changes and public publication remain separate explicitly
authorized operations during implementation, not actions performed for this plan.

## Exact release and qualification sequence

The same product tasks serve local development, PR checks and release work.
Qualification is an aggregation of applicable evidence, not a new test suite.
Use existing candidate records; do not implement a second provenance platform.

1. **Prepare the release PR.** Release Please selects product versions and
   notes. The narrow closer derives compatibility fields, carrier versions and
   native locks once. No-change preparation exits before platform setup. The
   final PR tree receives affected checks; public versions remain unchanged.
2. **Fix the merged candidate identity.** On merge, record the exact SHA/tree,
   selected products, dependency versions and declared target surface. A PR head
   is not a substitute for this merge. Unchanged published dependencies retain
   their verified identities; a newly selected dependency must be produced.
3. **Run applicable source checks and producers.** Reuse eligible evidence for
   unchanged inputs; build missing outputs through the declared project graph.
   Run actual producer ABI/runtime checks where needed. These results alone do
   not establish that a final registry package is usable.
4. **Assemble the final packages.** Owning package tasks consume producer outputs
   and create Cargo/npm/Maven/Swift/GitHub distributions, resources, headers and
   notices. Apply any required payload-changing signing before freezing. Pure
   packaging runs on Linux where possible; necessary native signing stays on
   its required host. Unpublished sibling candidates use a narrow local
   dependency source/overlay for testing, never an accidental public fallback.
5. **Freeze the candidate bytes.** Record exact files/digests, versions,
   dependencies and target identity. The complete candidate is immutable from
   here. Registry envelopes must already be prepared; any registry-mandated
   transformation needs a defined ecosystem integrity comparison. No uncontrolled
   repacking or modification may occur between package tests and upload.
6. **Qualify those packages.** Install the frozen packages in clean consumers;
   test the applicable browser/device/native surfaces with those payloads.
   Consumer compilation is legitimate here; rebuilding the frozen runtime or
   SDK package is not. Bind successful source/producer/package evidence to the
   exact candidate and its required targets. Failure blocks publication. If
   package bytes change, form a new pre-publication candidate and repeat affected
   checks; never relabel old results as proof of different bytes.
7. **Publish the qualified bytes.** The publish operation requests or reuses
   missing exact-candidate CI before entering mutation. Protected upload jobs
   only reconcile remote state and upload absent matching artifacts in dependency
   order. Conditional first-name bootstrap uses these same bytes. Authentication,
   current remote availability and conflicting versions are checked at mutation;
   source/compiler/whole-repo suites are not replayed inside publishers. When
   dependent packages require public GitHub binary URLs, expose frozen assets
   through a public prerelease before uploading those dependent packages. That
   is already irreversible public state and follows the same reconciliation
   rules. Draft URLs are never treated as anonymously downloadable dependencies.
8. **Verify public resolution and finalize.** Separate small consumer jobs may
   compile a fresh application to prove real registry resolution. They never
   rebuild packages to publish. For SwiftPM, the assets exposed in step 7 must
   precede dependent source-tag/manifest availability. Verify the public prerelease
   mechanism against actual GitHub/Swift behavior in 28a. Finalize notes/labels/stable promotion
   only after required public-consumer evidence. Registry-specific automatic
   tags/visibility mean there is no all-registry atomic visibility promise.
9. **Refresh docs independently.** After completed product publication, refresh
   published-version inputs and request the docs deployment once for the release
   operation. A docs failure is reported/retried separately and never republishes
   packages or falsely marks their publication incomplete.

If interrupted after any public mutation, keep the same candidate; reconcile
and skip matching versions, upload only missing versions, and stop on conflict.
Use the existing 90-day retained-candidate window as the initial recovery
contract; expired or missing evidence requires explicit recovery investigation,
never a rebuild under an already-public version. A product fix requires a new
version. A controller-only fix records its own execution identity while retaining
the approved product candidate. Concurrent release attempts cannot substitute
each other's candidate or checkpoint.

Public consumer compilation in step 8 is verification with read-only credentials,
separate from step 7 upload jobs. This resolves the distinction between
compiler-free publication and proving that a real consumer can install packages.
Local no-upload rehearsal covers steps 1–6 using disposable version inputs and
appropriate native artifacts; it is optional and is not another mandatory
maintainer dispatch between preparing the PR and publishing.

## Native Rust / Node / Bun / Deno consolidation

Decision: viable and included in 09,09a,09b. Use the existing napi-rs approach
for the native addon and remove duplicate C++/Deno FFI maintenance after parity
proof. This is an architectural decision with implementation acceptance gates;
the replacement has not been written or qualified. No additional user decision
is needed for the documented Deno npm/Node-API installation requirement.

Evidence from the current source:

| Current implementation | What it establishes / required change |
| --- | --- |
| `src/sdks/js/src/native/default.ts` | Bun already selects the Node addon; Deno alone selects a separate FFI implementation |
| `src/runtimes/wasix-napi/Cargo.toml`, `src/lib.rs` | Existing Rust cdylib uses napi 3.12.2, napi-derive 3.6.3, napi-build 2.4.1 and Node-API 8; this toolchain is already a repo dependency |
| Native `oliphaunt_node.cc` (2,444 lines at review) | Library loading, raw C operations, request bridges, generation-aware handles, worker/environment teardown; replace with shared Rust operations plus a small JS boundary, not a line-for-line translation |
| `native/deno.ts` (540 lines), `ffi-layout.ts` (143) | Separate symbols, pointers, packed structs, nonblocking FFI, callback/error/free-response and cleanup logic; remove after common addon parity |
| `native/assets-deno.ts` (534 lines) | Separate package/asset resolver also used by broker and server; migrate every caller, not just direct mode |
| Rust `liboliphaunt/ffi.rs` and `mod.rs` | Captured operation errors, retained library lifetime, handle locking and logical detach exist; generation-safe environment cleanup is not yet the same contract as the Node/Deno paths |
| WASIX integration `smoke-node.sh` and `verify-host.mts` | Existing packed Node/Bun/Deno/Electron host harness provides a starting point; do not add a second unrelated test-runner framework |

Local viability probe on Linux x64: the same existing
`target/oliphaunt-wasix-napi/prebuilds/linux-x64-gnu/oliphaunt_wasix_napi.node`
loaded successfully under Node **22.22.3**, Bun **1.4.2** and Deno **2.8.1**.
Each opened a standard in-memory database through NativeWasixActorDatabase,
executed `SELECT 42::int AS answer`, validated the PostgreSQL DataRow and
ReadyForQuery messages, awaited close and exited successfully. The binary's
SHA-256 was `950a6f8f6904ce0262387d53d5ee6587d577d66110fe68019a7f498ae6f56abd`.
Shell invoked a disposable `/tmp/oliphaunt-napi-viability.mts` using each pinned
executable and a 40-second timeout. Deno used `--no-config --allow-env --allow-read
--allow-ffi`; no network access was needed. No addon or runtime was rebuilt.

This proves a working Rust Node-API path through all three installed hosts,
including promises and byte-buffer results. It does not prove native-runtime
parity, npm installation, worker termination, unsupported/older host versions,
or Windows/macOS correctness. The pre-existing artifact's build provenance was
not requalified. Do not mark 09a/09b complete using this probe alone.

Target responsibilities:

- Shared bindings own C ABI access, runtime/session lifetimes, native operation
  error capture, cancellation, raw request/stream completion, backup/restore and
  safe close/reopen. Resource preparation is consumed through the resource
  project's contract; package-manager discovery is not moved into Rust.
- Node addon owns JS argument/result conversion, asynchronous completion,
  streaming delivery and environment cleanup. Keep blocking database work off
  the JS thread and cancellation available during it. Reuse proven napi-rs
  facilities; do not recreate the C++ threadsafe-function implementation in Rust
  or create multiple stacked executors merely to settle promises.
- C runtime remains authoritative for process-global lifecycle. Multiple Node
  workers/addon instances must not gain conflicting ownership because each Rust
  library image has its own static state. A stale finalizer cannot close a newer
  generation; teardown cannot unload code while threads/callbacks can execute it.
  Rust bindings must expose the narrow lifecycle operations needed to prove this.
- Node/Bun/Deno use one native package loader and normal node: module/filesystem
  APIs. Unify resource selection and validation across direct/broker/server
  callers. Preserve explicit path/PGDATA overrides and corruption checks. Remove
  Deno-only restrictions on automatic extension assembly only after the common
  path demonstrates it; do not advertise new support based on removing a guard.
- Broker/server remain TypeScript process/socket clients with no addon required
  to launch the executable. Direct executable spawn is product functionality;
  invoking Shell scripts from TS for build/test orchestration remains prohibited.
- Rust callers use the bindings crate directly and acquire no napi/JS runtime
  dependency. Swift/Kotlin/RN retain their platform-native C integration. Browser
  still uses the Rust/WASM browser host. Native and WASIX addons stay separate;
  reuse small proven Promise/byte/error helpers only if it reduces total code.
  Query APIs remain ecosystem-owned; routing every query through Rust would make
  broker/browser consumers unnecessarily depend on a native addon.

Required cutover evidence (extend existing tests at their meaningful boundaries):

| Boundary | Acceptance |
| --- | --- |
| Operations | Parameter/result/error parity, raw streaming, callback exception recovery, backup/restore, persistence, close/reopen and existing initialization safety |
| Concurrency/lifetime | Timers remain responsive during a long query; out-of-band cancellation completes; concurrent close/cancel and worker termination during pending operation/stream do not deadlock, crash or call into a destroyed JS environment |
| Ownership | Forgotten handle recovery, stale generation token and later reopen; process-global direct admission, library pinning, callback buffer lifetime and response freeing remain correct |
| Native consumers | Same final target addon under pinned Node/Bun/Deno, supported minimum versions and relevant Electron embedding; Linux x64/arm64, macOS arm64 and Windows x64 MSVC |
| Installation | Clean npm/pnpm/Deno consumers select correct target and versions; Deno local node_modules and --allow-ffi are explicit; required read/write/env/run/net permissions follow actual chosen operations, with no blanket -A requirement |
| Distribution | Prebuilt addon; no consumer Rust/C++ compiler, Shell setup, header download or postinstall build; correct DLL/shared-library closure and ABI floors; default resources remain absent |
| Independent modes | Broker/server can run with the direct addon omitted; a missing direct addon fails clearly; no fallback to old Deno FFI or a different topology |
| Cost | Record old/new maintained adapter code/dependencies and target build/installed size; compare basic query/startup behavior and long-query responsiveness. No claimed deletion or performance win solely from changing language |

CI/release integration: compile one native addon per OS/architecture/ABI, then
reuse that exact file across host tests; do not build separate Node/Bun/Deno
variants. Pure TS query changes do not rebuild the addon. Bindings changes select
Rust/broker/addon compatibility checks and releases of binaries that embed the
changed Rust code. Normal published Rust dependency edges do not automatically
bump every SDK; an explicit SDK dependency upgrade selects that SDK. The existing
oliphaunt-node-direct release owner/npm carrier names remain, with one canonical
package version and derived private Cargo version; no new public addon crate.
Final-package host tests occur after candidate freezing and before publication.
Update Moon inputs, Cargo locks, producer actions, notices, release preparation,
consumer fixtures and docs together. Delete old C++ build/header-fetch commands,
Deno FFI exports and exclusive tests only after their last callers and necessary
guarantees have moved. An incompatible host result is a blocking implementation
finding, not permission to silently retain two permanent backends or drop support.

Primary references: [Deno Node-API requirements](https://docs.deno.com/runtime/fundamentals/node/)
and [Bun Node-API support](https://bun.sh/docs/runtime/node-api). These document
the supported mechanism; the concrete repo-version Linux probe provides narrower
execution evidence. Recheck exact napi-rs/host capabilities when implementing
cleanup behavior rather than assuming nominal Node-API support proves parity.

## Additional machinery dispositions

Status: incorporated after the source review and the user's broad agreement.
These are planned dispositions, not completed changes or blanket approval of
every replacement choice. Verify the remaining choices against actual callers,
platform support and consumer behavior before selecting an implementation.
Use the established task order; remove obsolete tests with their mechanisms.

- [x] **M01 — Local hooks (05,25).** Keep optional cheap correctness/security
  checks; scope formatting to owning projects and reuse their commands. Root
  prek is already local-only; do not add a hosted all-hooks gate. Review commit
  conventions against the actual squash/release input. **Done:** unrelated
  changes do not run global format suites; useful local checks remain available.
- [ ] **M02 — Dependency updates (06,24,27).** Keep Renovate, group only actual
  coordinated dependencies, and consolidate version/digest authorities. Use
  native managers first; custom pin updates must update all required hashes
  coherently. **Done:** representative ordinary and special-tool updates resolve
  and select appropriate checks; no half-updated pin or unrelated ecosystem
  failure blocks an independent update.
- [ ] **M03 — Tool installation (06,22).** Replace ordinary custom installers
  with existing Moon/proto or ecosystem mechanisms where supported. Retain
  narrow verified installation for special toolchains. Remove upstream README
  inventory contracts and redundant installation receipts; preserve download
  integrity and safe interrupted installation. **Done:** clean/repeated/failed
  setup works on supported hosts, installs only requested prerequisites, and
  uses the same underlying mechanism locally and in CI.
- [x] **M04 — Machinery tests (21,22,25).** Retain tests for corrupt inputs,
  failed extraction, partial publication and conflicting public bytes. Delete
  source-layout, duplicate-copy and obsolete receipt-protocol assertions with
  their owners. Localize fixtures; share only proven multiple-consumer helpers.
  **Done:** surviving tests exercise consequential behavior at its owner;
  removed helpers have no callers and no orphan fixture framework remains.
  **Completed locally:** generic policy/test projects and orphan wrappers are
  removed; fixture helpers live with their owner or the shared archive layer.
  Release, packaging, SDK-carrier and source-fetch suites retain actual corrupt
  bytes, unsafe paths, failed promotion, retry and publication conflict checks.
- [ ] **M05 — Consumer workspaces (15–20,23,25).** Remove host-runtime builds,
  seed normalization and permission repair from Expo/test setup. Consume declared
  producer outputs. Separate normal workspace integration from clean packaged
  consumers; the latter cannot borrow checkout node_modules. **Done:** candidate
  installation uses locked external dependencies, missing package dependencies
  fail, and repeated tests neither mutate source nor silently resolve new inputs.
- [x] **M06 — GitHub transport state (28,29).** Consolidate request ownership
  before removing cross-process pacing. Retain bounded retries, server-directed
  backoff and publication recovery; reduce persistent per-request histories,
  arbitrary budgets and repeated reads. **Done:** throttling and interruption
  recover predictably; concurrent callers remain coordinated; public artifact
  reconciliation does not depend on a verbose request-history protocol.
  **Implemented:** content pacing stores only the latest slot/sequence; core
  accounting stores at most 900 timestamps within its rolling hour and a total
  sequence. Production callers require no full history. Existing process locks,
  atomic replacement, lineage checks and deadline/retry behavior remain; expired
  attempts are removed on reservation. Five-process reservation/upload tests and
  read/mutation reconciliation tests pass. These runner-temporary schemas reject
  incompatible/corrupt state rather than silently resetting admission accounting.
- [ ] **M07 — Repository-controls audit (24,29).** Keep minimal setup diagnostics
  for publication trust, permissions and necessary environments; prefer native
  GitHub enforcement. Remove unnecessary custom governance rules. The current
  audit was found as a maintainer setup tool, not established as an every-release
  gate. **Done:** actionable setup failures remain visible without introducing
  a second release-policy engine or weakening credential/ref boundaries.
- [ ] **M08 — Notices (19–22,28).** Derive shipped notices from locked target
  dependencies and pinned sources, with explicit exceptions only where metadata
  is insufficient. Package and verify them at their producer. Reduce duplicate
  license inventories and filename/version/mode ceremony. **Done:** actual
  distributions retain required notice contents; canonical archive modes have
  one owner and source-only checks do not fetch every target unnecessarily.
- [ ] **M09 — Cargo build scripts (07,09,15–17,22).** Remove query-source copying
  through real crate dependencies. Retain necessary linking and artifact metadata
  propagation until a working replacement exists. Remove published-package
  fallbacks to the surrounding checkout. Replace generated handwritten hashing
  with an established implementation where hashing remains necessary. **Done:**
  clean published consumers work with declared dependencies and no hidden runtime
  producer build; required payload integrity checks still reject corruption.
- [ ] **M10 — Source packages and splitting (16,20,22,27,28).** Prefer native
  package commands and one source manifest authority. Resolve unpublished sibling
  candidate dependencies explicitly before deleting staging transformations;
  cargo --no-verify alone is not a solution. Keep size-driven splitting and
  required Swift public manifests only where demonstrated necessary. **Done:**
  clean consumers use the tested frozen package bytes; no shadow SDK definition
  or unnecessary carrier layer remains.
  **Implemented:** ordinary Bun/Cargo source packaging and explicit unpublished
  sibling candidate closure; binary carriers no longer invoke Cargo during
  central assembly. Frozen-byte and clean local consumer tests pass.
  **Remaining:** final Apple/mobile and public-registry consumer closure for the
  selected frozen candidate; keep only demonstrated size/root-SwiftPM exceptions.
- [ ] **M11 — Archives/filesystems (21,22,28).** Prefer native Shell packaging
  tools for producers and suitable existing ecosystem libraries for consumer
  extraction. Review platform support before choosing replacements. Keep thin
  trust-boundary validation and safe extraction. **Done:** corrupt/traversing/
  unsafe-link archives fail without damaging existing data; required consumers
  gain no new platform-shell dependency; custom format code is minimized.
  Archive checkpoint: retain the streaming ZIP64 type validator used by GitHub
  artifact downloads; the sparse >4GiB test and clean-checkout downloader suite
  cover this separate large-archive boundary. Other consumers retain the full
  bounded archive parser.
  ZIP production and validation use the existing `node:zlib.crc32` implementation
  instead of two handwritten CRC loops. Existing corruption/traversal,
  executable-mode, empty-directory and extraction-preservation tests pass.
  A wholesale `Bun.Archive` producer substitution is not proven: the current
  API probe writes an empty-directory key as a regular file and defaults to
  current timestamps and non-executable modes.
  Swift resolver checkpoint: extraction now validates once in private staging;
  rejected replacements preserve the existing output and tree manifest. Removed
  its redundant archive inventory pass, retaining actual extracted-tree hashes
  for cache validation. The bootstrap capsule reuses the existing tar-header
  writer without changing its streaming payload or canonical-byte contract.
  Swift hostile-archive/cache/consumer and capsule integrity/repeat tests pass;
  24 old/new header comparisons are byte-identical. This does not claim atomic
  directory-plus-manifest publication across forced crashes or concurrent writers.
- [ ] **M12 — WASIX export sealing (13,22,25).** Keep Rust binary analysis and
  required dynamic-linkage/ABI checks. Remove the requirement that DCE must remove
  at least one function/global; a justified size budget is a separate concern.
  Prefer completed immutable output generations over live-prefix transaction
  machinery. Migrate executor receipt consumers with the producer; choose a
  promotion mechanism that works on each host. **Done:** actual extension loading
  passes and interrupted publication exposes no mixed bundle; unchanged-size
  valid binaries do not fail correctness qualification.
  **Implemented and proven locally:** private PostgreSQL build/sealing followed
  by whole-prefix content-addressed publication and atomic selection replaces
  live-prefix rollback journals. Existing receipt/ABI admission remains intact;
  imported portable inputs select their exact directory. Linux actual build and
  repeat produce the same generation; concurrent SQL (two backend PIDs),
  PL/pgSQL/Snowball loading, and PostgreSQL boolean/CASE/COPY regressions pass.
  Interrupted/concurrent publication and header corruption tests pass; the
  unchanged-size export proof remains covered. Owner syntax checking now needs
  only Shell inputs, without Rust setup. **Remaining:** execute generation
  publication and consumer qualification on macOS; local Linux evidence does
  not establish that host guarantee.
- [ ] **M13 — Capability probes (13,25,26).** Retain concrete patched-runtime
  regressions with the executor/sysroot owner; separate probe builds from runs.
  Scope expensive probes to their real dependencies. capabilities.tsv was found
  to be documentation; Shell owns probe selection. **Done:** relevant runtime
  changes exercise meaningful capabilities, unrelated SDK/docs changes do not,
  and no new capability-inventory enforcement system is introduced.
- [ ] **M14 — Headers and symbols (04,19,20,25).** Consume one canonical header
  through declared dependencies and copy into distribution outputs as needed;
  delete committed-copy equality checks when duplicates disappear. Retain actual
  symbol-provider/ABI checks and extension loading in an embedding application.
  **Done:** packaged consumers compile against the correct header and required
  binaries link/load without relying solely on source-spelling assertions.
- [ ] **M15 — Reproducibility/caches (06,19,24).** Keep source-derived timestamps
  and narrowly necessary upstream workarounds. Prefer immutable completed cache
  outputs keyed by compiler/target/flags/dependency inputs; remove reuse-time
  mutation and completion-stamp ceremony where unnecessary. **Done:** cold, warm,
  interrupted and changed-input cases behave correctly; safe reuse does not
  require invalidating the previously valid cache.
  Native PostGIS checkpoint: a fully hash-validated warm cache now keeps its
  completion marker, so interruption during reuse does not discard valid
  libraries on the next attempt. Existing changed-input/corrupt-output
  invalidation remains; owner tests pass under Bash 3.2 and current Bash.
  WASIX OpenSSL/GEOS/PROJ checkpoint: upstream `DESTDIR` installs now validate
  staged prefixes before replacing usable dependencies. All three recipes pass
  repeat/changed-input and configure/build/install failure-retention tests;
  real cached installs in the existing builder image preserve library bytes.
  Forced-crash/concurrent publication remains outside this bounded fix.
- [ ] **M16 — Native consumer integration (20).** Retain Expo, Gradle, CocoaPods
  and RN integration as product behavior. Kotlin/Swift own native dependencies;
  RN composes them without another complete artifact resolver. Keep idiomatic
  Java Gradle integration and TypeScript-generated distribution JavaScript.
  **Done:** repeated prebuild is idempotent, adding/removing extensions leaves no
  stale assets, correct ABIs build, and optional resources remain unbundled.
- [ ] **M17 — Installed-app runners (20,23–26).** Separate built-app production
  from install/run tasks; retries consume the same artifact. Keep readiness,
  timeout, cleanup and sufficient run identity to reject stale success. Reduce
  duplicate report interpretation; scope broad suites to actual dependencies.
  **Done:** narrow native-platform tests remain runnable independently and detect
  real failures; Android/iOS-specific semantics retain their own necessary proof.
- [ ] **M18 — Benchmarks (23,25).** Keep purposeful experiments and provenance;
  preserve their existing exclusion from ordinary CI. Lock comparison inputs,
  separate setup from measured work, and delete abandoned scaffolding only after
  caller review. **Done:** retained benchmarks answer a stated question with raw
  results and reproducible inputs; no noisy automatic release gate is added.

Task 30 must review every disposition above against the final task graph and
package/release flow. Record any deferred replacement and its concrete reason;
do not count directory moves or renamed wrappers as simplification evidence.
This checklist is migration review material, not a permanent policy checker.

## Versioning and changelog review

Current release-please-config.json contains 20 products and 43 extra-file
updates. Strategies are Rust, Node and simple; Swift and Kotlin use simple,
not a native Apple/Gradle release mechanism. Only node-workspace is configured;
cargo-workspace is absent. Upstream Release Please documents that Rust manifest
releases need cargo-workspace for dependency updates. The repo instead supplies
substantial custom synchronization; absence of the plugin alone is not proof
the current final pins are wrong.

Version flow today:

1. Release Please selects path-associated Conventional Commits and updates
   candidate versions/changelogs, canonical files and configured extra-files.
2. sync-release-pr.mts (1224 lines at review) adds shared contrib candidates,
   syncs compatibility pins, extension registry metadata, npm optional deps,
   examples/install snippets, Cargo dependency pins, Cargo/Bun lock content and
   extension evidence summaries.
3. release-candidate-sync.mts can independently create/merge changelog sections
   for custom shared-source/dependency candidates. The workflow normalizes and
   amends the bot PR, then checks the resulting tree.

This is more than a small version-file adapter. Native runtime versions are
mirrored across carriers and C source; the Rust broker version exists in both
Cargo metadata and BROKER_RELEASE_VERSION (declared in release.toml for sync).
Declared synchronization reduces drift but does not eliminate the duplicate
authority or prove arbitrary future tests are version-independent.

Changelog findings are concrete: the Swift 0.7.0, vector 0.2.0 and postmaster
0.1.0 changelogs include a breaking note about Rust WASIX storage variants and
browser IndexedDB v3. These are product-irrelevant claims in those locations.
The broad commit fae2bd7 contains cross-product release text, explaining the
path-selected commit-body contamination. CI/refactor bullets also appear as
product release notes. There are 20 tracked changelogs matching the 20 configured
products; this inspection did not find extra orphan changelog files. The
verified problem is relevance/content and ownership boundaries, not evidence
of randomly created changelog files.

Version literals sampled in release unit tests and Swift resource composition
tests are largely self-contained fixtures; they should not follow every real
release. The failure pattern to eliminate is mixing fixed fixture versions with
live repository or downloaded candidate metadata. This source review does not
establish that a particular current test is failing from that pattern. Task 27c
requires an actual disposable candidate version-change exercise to prove it.

Focused verification: ran release-candidate-sync.test.mts and
sync-release-pr.test.mts through the existing with-projects.sh harness; the
resulting run reported 30 passing tests across six files, zero failures. This
verifies existing synchronization scenarios, not every real product under a
new release version, and does not validate changelog prose relevance.

Tool assessment: Release Please supports polyglot manifest releases and is not
a Rust-only tool. The final decision retains it as the candidate/PR generator; it must
not become a second cross-language build/release graph. Changesets' explicit
change descriptions address note relevance but do not by themselves eliminate
Rust/Swift/Gradle/carrier adapters. Replacing the tool without simplifying those
boundaries can preserve the same maintenance problem. Task 27b verifies the
minimal pinned integration and shared-source selection before moves; the later
version-transition exercise proves the migrated configuration. No tool switch
or second release engine is planned.

References:

- [Release Please manifest and workspace plugins](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- [Release Please strategies and extra files](https://github.com/googleapis/release-please/blob/main/docs/customizing.md)
- [Changesets change-description model](https://github.com/changesets/changesets)

## Affectedness audit: observed selection

Ran the installed pinned Moon 2.5.4 with one file path supplied on stdin to
`moon query affected --upstream none --downstream deep`, extracted directly
affected tasks using the same criteria as affected.mts, and passed them to the
actual ci_plan.mts jobs-for-affected command using a real Moon task graph.
Probes used the current dirty workspace configuration; no source edits or
product builds were needed. These test file-to-task/builder selection, not
Git event comparison, hosted matrix execution or timing. The results below
describe builder jobs; check/test matrices are a separate existing path.

| Simulated changed path | Observed result |
| --- | --- |
| `docs/maintainers/development.md` | No product builder selected; only base affected job |
| `src/shared/rust-query-core/query_core.rs` | Both Rust SDK unit/typecheck tasks selected; also runtime AOT and native/WASIX extension producer jobs through current coupling |
| New path `src/sdks/rust/src/new_affected_probe.rs` | Native SDK unit/typecheck and package work selected without adding a file entry; source globs cover additions |
| `src/runtimes/liboliphaunt/native/bin/icu.sh` | Native and WASIX producers selected, consistent with the helper's cross-runtime use, but very broad downstream fan-out |
| `src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1` | Android and iOS build tasks directly affected; native mobile apps and WASIX producers selected as well. Windows-only orchestration is mixed into broad groups |
| `.github/actions/setup-msvc/action.yml` | Only workflow check directly affected; no native producer selected. Changed Windows setup lacks a Windows build proof edge |
| `src/shared/artifact-packaging/portable-archive.mts` | 67 directly affected tasks and broad native/mobile/WASIX/postmaster builder selection; review actual fetch/packaging uses before narrowing |
| `Cargo.lock` | 74 directly affected tasks and broad native/mobile/WASIX/postmaster selection; conservative workspace input, not proof every lock entry affects every product |

Manual selection machinery still exists:

- .moon/tasks/inputs.yml has shared file inventories and broad workspace inputs.
- Individual Moon tasks contain long cross-project input lists; the native
  runtime mixes platform-specific scripts into groups used by several targets.
- ci_plan.mts has BROAD_EXTENSION_INPUT_PROJECTS and explicit job/target sets,
  and performs additional downstream/prerequisite traversal. Some runner mapping
  is necessary; product impact should come from the declared dependency graph.
- write-affected-moon-target-matrices.mts classifies policy through a fixed
  policyProjectIds set and command.includes checks, alongside proper task tags.
- GitHub cache keys separately enumerate source paths. Those lists affect cache
  identity, not job selection, but must agree with actual producer inputs.

Conclusion: Moon is the starting graph, not evidence that the selection is
already clean or entirely inferred. There is observed over-selection and a
missing native-build selection for setup changes. Not every explicit input is
bad: a shell script sourcing another file or an external tool consuming a pin
must declare that dependency if the ecosystem cannot infer it. The target is
one product-owned dependency declaration, no detached CI whitelist of the same
relationship, and normal source-directory globs for newly added files. Do not
claim that a task runner can infer arbitrary shell/file/environment dependencies.

## Check value and ownership review

The plan previously required deletion of low-value checks, but the current CI
has not been proven free of them. Concrete source findings from this review:

| Current path | Finding | Disposition |
| --- | --- | --- |
| `tools/policy/check-policy-tools.sh` | A task named lint syntax-checks shell and bundles scripts across .github/scripts, examples/tools, policy and graph | Put syntax/type/build validation in the actual tooling owners; do not hide a cross-domain build behind lint |
| `tools/release/release-check.sh` | Discovers almost every test in tools/release and tools/policy, with a growing exclusion list; execution scope follows storage location | Group actual release/CI/packaging behavior under their own tasks with narrow inputs, remove unrelated tests from release qualification |
| `tools/release/release-metadata-check.sh` | Combines product metadata, generated release-PR state, version synchronization and example Cargo policy | Retain selected-candidate package/dependency validation; move example checks out of the publication prerequisite and eliminate redundant metadata authorities |
| `tools/release/moon.yml` metadata task | Broad cross-repo input list and cache:false, despite mixing static facts with history/state reads | Split necessary stateful preflight from deterministic metadata processing; scope inputs instead of invalidating all checks for unrelated files |
| `tools/release/native-script-self-identity.test.mts` | Extension source lookup test freezes target directory spellings and lives under release tooling | Preserve meaningful lookup/unknown-extension behavior at source ownership; avoid making an internal directory name a release contract |
| `tools/policy/check-workflows.sh` | Includes actionlint/zizmor plus security, shell runner, capability and planner behavior tests | Retain consequential workflow/selection/security behavior when its implementation changes; do not rerun this suite merely because a product is being published |

Not every exact assertion is low value: a package manifest pointing at a missing
public file, an invalid dependency version or a wrong runtime ABI is a real
consumer failure. Prefer one real packaged-consumer check or focused validation
at that boundary over several checks of source spelling and duplicated models.
Likewise, a test proving planner failure cannot become a green Required gate
earns its place; a test demanding an arbitrary YAML layout does not.

Phase ownership:

| Phase | Checks that belong | Checks that do not belong |
| --- | --- | --- |
| Source PR | Affected format/lint/type/tests; affected tooling behavior | Unrelated examples, release registry readiness, aesthetic repo layout rules |
| Build/package | Required compile/integration and final package interfaces/bytes | Repeating all source tests through package aliases |
| Release PR | Selected version/dependency/lock closure and final consumer envelope | Unrelated source-policy sweep or mandatory unchanged runtime rebuild |
| Qualification | Aggregate required selected evidence for exact candidate | A second copy of every test already executed on those inputs |
| Publish/retry | Candidate identity, transferred bytes, current registry/auth state, public consumers | Source formatting, repository layout, all tooling test suites |

Tasks 25a/25b close this gap by review and deletion, not by adding another
policy-enforcement layer. No claim of removed work or measured savings is made
until actual execution traces and deleted checks demonstrate it.

## Windows/Bash and host-placement review

Source review on 2026-09-11 found three tracked PowerShell files:

| File | Lines | Responsibility |
| --- | ---: | --- |
| `.github/scripts/setup-msvc.ps1` | 225 | VS discovery, developer environment, tool validation, hosted provenance |
| `src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1` | 3109 | MSVC setup plus sources, dependencies, generated Meson configuration and product compilation |
| `src/runtimes/liboliphaunt/native/tools/package-liboliphaunt-windows-assets.ps1` | 308 | Optional build, seed generation, native smoke, staging and archives |

Most reusable Windows workflows already specify `shell: bash`. GitHub supports
this using Git for Windows Bash. Bash can invoke native MSVC executables; it
does not require changing the compiled product ABI. MSVC still needs the
environment established by Visual Studio's developer launcher.

The current Windows builder deliberately removes MSYS tool directories when
selecting cl/link/lib/dumpbin. That is evidence that tool selection needs care,
not that PowerShell is intrinsically required. Preserve the intended MSVC
selection when migrating; Git's link.exe must not shadow the MSVC linker.
MSYS path conversion and slash-prefixed MSVC switches need explicit handling
at native command boundaries; do not disable conversion globally by habit.

Current positive examples: CI already assembles native release assets on Linux,
has Linux Apple ABI-finalization jobs, and platform-binary-contract.mts reads
PE/Mach-O/ELF using portable data processing. Reuse these capabilities before
adding LLVM tooling or another binary parser.

| Work | Proposed execution host | Limit |
| --- | --- | --- |
| TS analysis, ordinary unit tests, metadata/version/release planning | Linux | Real platform-specific behavior tests remain native |
| Notices, resource selection, archives, checksums and registry assembly | Linux | Preserve executable bits, symlinks, case and package layout in transfer |
| PE/Mach-O imports, exports, architecture and declared minimum OS inspection | Linux | Does not prove loader compatibility or runtime behavior |
| Windows MSVC compile/link, SDK/CRT discovery | Windows for the supported build | Cross-compiling is not a prerequisite for this cleanup |
| Windows DLL loading, Node addon, broker/server, filesystem/process semantics | Windows | Run final consumer without Git Bash/MSYS on its runtime PATH |
| Apple SDK compile/link, XCFramework production, Apple signing verification where used | macOS | Ordinary ZIP assembly and metadata checks need not inherit macOS |
| Swift Apple SDK integration, macOS runtime, iOS simulator/device | macOS/device | Linux Swift checks cannot replace Apple-platform validation |
| Android assembly/emulator | Linux with required Android/KVM setup | Android does not inherently require macOS |
| Target-specific seed generation | Host capable of executing that initializer | Seed packaging/checksum work is portable; do not execute Windows initdb on Linux by assumption |
| WASIX portable production | Linux where supported by current toolchain | AOT generation split is subject to actual compiler/target capability; keep target execution native |
| Registry upload and candidate coordination | Linux unless an actual operation requires another host | Extract necessary signing/Apple consumer verification rather than moving the entire release to macOS |

Acceptance is behavioral and ABI compatibility, not byte-identical output
between old and new compilers/scripts. This investigation does not claim a
Windows build has been run from Linux or that current Windows failures have
been repaired.

Primary references:

- [GitHub workflow shell behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [MSVC command-line environment](https://learn.microsoft.com/en-us/cpp/build/building-on-the-command-line)
- [MSYS path conversion](https://www.msys2.org/docs/filesystem-paths/)
- [LLVM object inspection capabilities](https://llvm.org/docs/CommandGuide/llvm-readobj.html)
- [Apple XCFramework production](https://developer.apple.com/documentation/xcode/creating-a-multi-platform-binary-framework-bundle)

## Release-path alignment review

Reviewed the actual release.yml job sequence, release PR normalization/sync,
release-dry-run.sh, package-release-carriers, candidate locking, bootstrap plan,
normal publication executor, Maven signing and final promotion. This is a
source review, not a live release or a claim that every transport helper has
been exhaustively audited. Overall: frozen publication and retry semantics
align; preparation scope, naming and product ownership still do not.

| Finding | Evidence and consequence | Required change / task |
| --- | --- | --- |
| Release Please is not the sole candidate-generation path | release.yml has a no-PR fallback that creates a shared-contrib release branch/PR; sync-release-pr.mts also has bootstrap-shared-contrib. Shared changes need releases, but a special alternative PR creator duplicates authority | Model shared shipped-byte changes in one candidate selection path; keep required derived manifest closure, remove the contrib-only alternate PR construction. 27,27a |
| Exact single-commit normalization adds history coupling | normalize-release-please-pr.sh resets/amends a generated branch and insists on one commit above exact main | Judge candidate tree, versions and safe update identity; retain lease protection, remove commit-count restrictions unless a real consumer requires them. 27a |
| Preparation provisions too much before knowing scope | prepare-candidate selects macos-26, installs workspace/Rust and configures Java plus Android before release planning; no-change/TS-only selection still passes setup | Plan selected products and required capabilities first; skip setup for no-op, isolate genuinely Apple/Android-dependent preparation. No new generic provisioning framework. 24b,28 |
| Qualified wait cannot itself create the required evidence | prepare-candidate waits up to 7200 seconds for Builds/Required/Qualified; Qualified is currently manual-all-target only | Product-scoped automatic qualification and an explicit request-or-reuse path; never spend two hours waiting for a workflow nobody started. 26,26b |
| Dry-run is an inaccurate and overloaded name | release-dry-run.sh without qualified-ci runs release-check.sh; qualified-ci verifies an existing candidate; arguments add live registry checks. Packaging/freezing happens later in the workflow | Separate existing local checks, candidate verification, and live registry preflight by their real responsibilities. Remove obsolete publish-dry-run operation strings; migrate the release-dry-run environment deliberately if renamed. A no-upload rehearsal must exercise actual assembly, not imply these checks prove it. 28 |
| Root packaging still knows every product | package-release-carriers.mts imports individual native, WASIX, broker, addon and extension implementations; its shell wrapper adds a broker-only packaging branch | Products emit finished package outputs through their declared tasks. Coordinator selects/invokes those tasks and consumes their outputs; do not replace the switch with a bespoke plugin framework. 14–19,24,28 |
| Same facts are recomputed across jobs | prepare, bootstrap and publish re-plan products and revalidate release identity/registry state | Compute immutable selection once and use the frozen candidate across jobs. Keep verification on artifact transfer and fresh mutable-state checks at public mutation boundaries; delete repeated whole-source planning and unrelated qualification. 28–29 |
| Bootstrap and ordinary publication have overlapping work | Both plan registry carriers, order dependencies, reconcile identities and publish; bootstrap additionally has credentials and an interruption ledger | Reuse existing ordering/reconciliation primitives where that reduces code. Keep distinct credential scope and necessary durable bootstrap state; no deletion of recovery guarantees just to merge jobs. 29 |
| “Publish frozen bytes” needs a signing-envelope qualification | preflight-maven-central-bundle.sh signs frozen payloads and constructs a ZIP inside publish. This is not product compilation, but signatures/envelope bytes can change on retry | State precisely which payload bytes are immutable and which signing envelope is created later. Preserve/reconcile signed transport identity when required; do not claim complete byte-reproducibility without proof. 28a,29a |
| “Promote last” does not mean nothing was public earlier | Product tags/assets and Swift publication occur before registry verification and final draft promotion | Document partial visibility and per-ecosystem availability; ensure Swift consumers can resolve required public assets. Final labels describe completed publication, never atomicity across registries. 28a,29a |

Keep the following existing guarantees unless a simpler implementation proves
the same behavior: exact candidate/tree identity, dependency-ordered publication,
conditional absent-name bootstrap, checksum/SRI reconciliation, mismatch
rejection, bounded handling of transient registry failures, and final public
consumer verification. Checkpoint/lock size alone does not prove dispensability.
Conversely, package checks should not validate prose or incidental source
spelling, and no runtime build is justified merely by release label changes.

Additional completion examples for the mapped tasks:

- Preparing a TS-only release with no native package assembly requirement does
  not configure Android or Java; no-release selection does no package setup.
- A shared contrib source change produces the correct runtime candidates through
  the same release-PR mechanism as other shared shipped-source changes.
- Local deterministic checks work without registry credentials; live registry
  preflight is explicitly identified and scoped to selected ecosystems.
- Bootstrap and publish consume the same locked product set even if main moves;
  public-state checks are refreshed where they can change, not mechanically
  deleted as duplicates.
- Maven retry verifies identical payloads and handles signed envelope identity
  explicitly; final Swift availability is tested with anonymous access.

## PR-to-release operating model

These are acceptance requirements for the existing workflows, not new services
or an additional handwritten task graph.

| Event | Required behavior | Must not happen |
| --- | --- | --- |
| Normal/fork source PR | Plan exact changed tree; run affected checks/builds/consumer tests in dependency order; expose stable Required result | Registry-readiness prerequisite, secrets in untrusted builds, unrelated full qualification |
| New PR revision | Cancel obsolete PR execution and qualify the new planned tree | Previous green head accepted for new source |
| PR closes | Cancel obsolete execution without scheduling builders | Runner allocation by always-on aggregate jobs |
| Merge queue | Qualify the actual merge-group tree against its correct base | Qualify only an individual PR head and claim integration success |
| Main push | Evaluate exact merged commit and produce needed evidence; release candidate scope includes selected products even when the diff only changes versions | Assume PR SHA equals merge SHA, or run an exhaustive matrix for every push |
| Prepare release PR | Select candidates from release history, close versions/dependencies/locks once, publish one stable bot PR update | Manual version surgery, duplicate heavy CI on transient generated heads |
| Release PR CI | Check final package versions/compatibility/consumer envelopes and required changed producers | Rebuild unchanged binaries solely because a changelog changed |
| Merge release PR | Establish the final candidate SHA and selected release scope; obtain exact candidate evidence | Treat bot PR qualification as unconditional evidence for a different merge |
| Publish | Reuse or request exact-candidate assembly/freezing/package qualification once, then bootstrap if needed, upload the same dependency-ordered bytes, verify public consumers and finalize | Separate obligatory dry-run/bootstrap/full-qualification ceremonies, compilation inside upload jobs |
| Retry partial publish | Reconcile public bytes and continue the original immutable candidate | Republish conflicting bytes, follow moving main, restart all successful uploads |
| Exhaustive audit | Explicit optional diagnostic/migration audit across the full supported surface | Hidden universal prerequisite for an unrelated product release |

Selected-release scope and affected-PR scope are not interchangeable. For
example, a release PR changing only versions still needs every selected output
accounted for, while it may reuse verified unchanged producer bytes. A shared
runtime change needs dependent compatibility proof even when those consumers
are not themselves receiving new releases.

## Acceptance matrix

| Scenario | Required observation |
| --- | --- |
| Clean checkout, one SDK | One documented build command traverses required dependency builds; native ecosystem commands remain available; no unrelated language/OS setup |
| Same build twice | Inputs unchanged; no unnecessary producer execution or source mutation |
| Cache absent | Correct build, no hidden dependency on old artifacts |
| Interrupted source/seed/package preparation | Retry recovers or fails clearly; existing valid data/output preserved |
| Native direct and broker | Query/error/cancel/close/persistence retained; broker isolation and death behavior retained |
| Native Node/Bun/Deno consolidation | One frozen Rust napi-rs addon per target passes all host consumers; generation/worker cleanup and cancellation preserved; no C++ addon or Deno FFI fallback |
| Addon-free broker/server | Process/socket modes work without loading or installing the direct addon; no topology fallback |
| Native server | Packaged PostgreSQL launch, multiple connections and clean stop retained |
| WASIX Rust and Node | Runtime-only/default excludes optional assets; selected resources initialize and persist |
| Browser | Built Rust/WASM host loads, endpoint startup succeeds, selected assets and storage work |
| Postmaster | Multiple backends and required shared-memory/process capabilities; compiler-free executor |
| Swift/Kotlin/RN | Packaged consumer builds plus relevant simulator/device behavior; consistent native dependency versions |
| Resources | Four logical seeds plus required target variants; same compatible ICU data; wrong-format rejection; no unselected payload |
| Extensions | Contrib subset plus external carrier, load/create/restart/dump-restore where promised |
| PostgreSQL tools | Separately installed initialization and logical dump/restore |
| pgwire-server | Installed CLI accepts an ordinary driver; sequential limitations documented |
| Shared source edit | Actual consumers tested; bundled-byte consumers selected for release; unrelated products unchanged |
| Pure docs edit | Docs checks only, no binary producer |
| Source pin or patch edit | Relevant runtime/extension rebuild and downstream compatibility checks |
| Version/envelope-only edit | Package/version checks; immutable binary reuse only with verified unchanged producer identity |
| Release preparation twice | No second source diff or new candidate identity |
| Publication retry | Byte-matching public versions skipped; absent versions published; conflicts rejected |
| Fork PR | Useful Required result without release secrets or registry setup |
| PR revision/closure | Obsolete work cancelled; closure allocates no new runner |
| Merge group / main merge | Correct immutable tree/base selected; no PR-head substitution |
| Release PR no-op/rebase/conflict | Stable final tree; no duplicate CI; unrelated edits preserved |
| Bot PR update | Required CI runs on the normalized head; obsolete head cannot satisfy it |
| Selected job skipped/cancelled/missing | Required fails; legitimately unselected work does not block |
| New selected product/carrier | Complete manifests, dependency ordering and conditional first-name bootstrap |
| Publish without pre-existing qualification | One exact-candidate CI request before publication, or reuse of eligible in-flight run |
| Stale/wrong-attempt/expired artifact | Reject reuse with actionable diagnosis; never substitute branch-latest output |
| Post-publication main movement | Resume original candidate using retained verified bytes |
| Swift source tag and binary assets | Public consumer works at the declared availability point; no dependence on draft asset access |
| Partial publication/finalization failure | Public state accurately reported; labels/tags/promotion reconciled on retry |
| Protected-check migration | Required remains enforceable; no obsolete required job or accidental bypass |
| Windows Bash build | MSVC/CRT ABI preserved; no Git Bash/MSYS/WSL runtime requirement for consumers |
| Windows path/tool boundary | Spaces/Unicode paths and compiler switches survive; correct link.exe; native failures propagate |
| Linux packaging of Windows/Apple outputs | Archive structure/modes/checksums valid; final native consumer still passes |
| Local toolchain preparation | No GitHub-only environment variables required; precise missing capability reported |

No wall-clock improvement or line reduction is claimed until measured. Keep
only measurements needed to establish that the new workflow removed work;
do not add a permanent performance/policy platform for this migration.

## Execution discipline

1. Complete baseline and names, then one coordinated layout/reference pass.
2. Implement ownership/extraction tasks in dependency order; make small local
   checks after each actual behavior change. Do not alternate speculative moves
   and whole-repository CI runs.
3. Use narrow hosted jobs when a platform-only problem needs resolution;
   reserve the integrated full migration proof for the coherent final state.
4. Do not skip correctness checks in the name of doing the visual pass first.
5. Keep a short completed-task log here with exact commands/results; never mark
   a phase complete because its directories exist.
6. Registry publication is not necessary to finish the planning or structural
   work. Prepare concrete packages and local consumers before any real release.

### Implementation log — 2026-09-11

Implementation is now authorized. The first parallel batch established real
dependency boundaries and removed obsolete tooling; the coordinated product move
is applied. Final-state task boxes remain open until their complete contracts
are met; these results do not qualify every platform or a production release.

- **06, partial:** PostgreSQL patches now have an explicit common/WASIX hierarchy
  under `third-party/postgres/patches`, with ordered series for all three runtime
  lanes. The hierarchy-only change preserved all three PostgreSQL 18.4 source
  postimages byte-for-byte. Source preparation passed clean, repeated and
  interrupted-recovery checks. Other source/toolchain consolidation remains.
- **06b, implemented tooling batch:** Bun 1.4.2 replaces pnpm workspace installation,
  locks, packing and CI setup. Deleted the scoped pnpm workspace writer and duplicate
  lock editor. The Node/Bun action reuses the existing verified Bun installer.
  Bun frozen installation and Moon 2.5.4 project discovery pass. WASIX SDK tests
  pass 338 cases, React Native 11, and the WASIX tools SDK 9; their typechecks pass.
  Host-specific execution and final affected/task integration remain separate proof.
- **07–08, implemented package boundaries:** `sdks/rust-query` and `sdks/ts-query`
  own normal published dependencies (`oliphaunt-query`, `@oliphaunt/ts-query`).
  Rust include/copy and TS bundled-source staging were removed. Query release
  manifests, compatibility updates and publication ordering are present. Native
  Rust tests (198), shared Rust tests (3), WASIX query tests (19), WASIX test-target
  compilation, native/query Clippy, TS build/typecheck and query/package tests
  (41) passed. Both real shared package archives were staged and exercised through
  candidate creation and freezing. CI uploads now include their exact artifact
  names; query-only runs skip unrelated SDK uploads and native lifecycle work.
  The SDK path migration is applied; later checks are recorded below.
  Follow-up test consolidation deleted 539 lines of duplicate TS decoder suites
  and moved parser-only Rust cases to their actual owner. Final checks passed
  26 TS query tests, 28 Rust query tests, 177 native Rust tests, two WASIX adapter
  tests, and Clippy for all three Rust packages. SDK host/error conversion checks
  remain. The actual Moon release-package tasks built both shared archives;
  repeating them succeeded with two cached prerequisites.
- **11a, implemented readiness fix:** the native server owner now enforces startup
  timeout even when a peer accepts TCP but sends nothing, closing the socket on
  expiry. Sixteen adapter tests and real PostgreSQL server queries pass. The smoke
  uses the existing standard `pg` driver instead of a second handwritten query
  implementation. Direct restore proof uses a fresh host process, while same-root
  logical reopening remains covered; it now checks a row persisted before backup.
  The complete `bash examples/tools/smoke-js-sdk.sh` passed Bun direct/broker,
  standard-driver server and Deno direct phases with the original native artifacts.
- **09, shared native Rust ownership:** `sdks/rust/liboliphaunt-native` now owns
  sessions, FFI, resource preparation, cancellation and backup/restore. The Rust
  SDK and broker depend on this crate; the broker owns its IPC implementation.
  The bindings' 63 tests pass both in the workspace and from its packaged crate;
  SDK 109 and broker five tests pass, with all three owners Clippy-clean.
  CI uploads and catalog-driven candidate downloads include both source crates.
  A consumer built from the actual SDK/query/bindings/broker archives; platform
  binary carriers alone were placeholders in that compile-only proof. Publication
  discovery verified both new source archives and their dependency edge.
- **09a, proof only:** the same napi-rs prototype passed query, streaming,
  callback-error recovery, cancellation, backup/restore and generation-safe
  cleanup on Node 22, Bun 1.4.2 and Deno 2.8.1. Terminating a Node worker during
  pending work aborts generic napi `AsyncTask` promise completion. Existing C++
  remains until shutdown behavior and installation/platform contracts pass.
  Subsequent Node/Bun proof uses an asynchronous reaper and owner-thread cleanup
  acknowledgement, preserving the existing off-thread native teardown contract.
  Initialization, active/queued query, stream, forgotten-handle and copied-addon
  stale-owner cases pass, as do callback exception identity and backup-before-close.
  Deno's supported FFI adapter remains: both existing C++ and the async prototype
  reproduce a Deno V8 cleanup failure. Production Node/Bun adoption is underway;
  these prototype checks are not a claim of completed platform qualification.
- **02a/27b, migration prerequisites:** the pinned Release Please simulation
  established stable component/version preservation, but directory changes lose
  old-path unreleased notes unless captured once at cutover. The lineage ledger
  records existing tags and transferred registry version floors. Transition and
  historical artifact lookup now map through current/historical configurations
  by component, including swapped paths; real Git history tests reject missing
  mapped pins. Product metadata tests (21) and transition tests (16) pass.
  Applying the one-time notes at the actual global move remains pending.
- **23, implemented docs cleanup:** removed generated SDK API dependencies and docs
  version scaffolding. Main guides resolve installation versions from completed
  public releases. Docs typecheck, 44 internal links, 139 static outputs and 49 HTML
  export checks passed. Vercel release-triggered refresh and verification are task
  23a; successful local export is not a deployment claim. A separate post-promotion
  CI job now requests one refresh and preserves its receipt. The protected Vercel
  hook secret/settings and actual deployment correlation are still unavailable;
  an accepted POST is explicitly not reported as a successful deployment.
- **27–29, partial integration:** Bun itself refreshes/verifies its lockfile after
  release PR metadata synchronization; release-commit validation permits the exact
  derived Bun workspace version changes. All six release-commit tests passed
  through the release-state wrapper. `bash tools/policy/check-workflows.sh` passed
  actionlint, zizmor, workflow security and runner checks, plus all 45 affectedness
  and artifact-transfer tests. The release aggregate passed 527/528 cases; its sole
  failing TTY fixture inherited local shell startup files, and its corrected suite
  subsequently passed all 14 cases. Eight archive/carrier tests also passed. The
  metadata gate exposed historical release validation incorrectly applying current
  Bun/docs rules to an old release. Tagged compatibility now uses its immutable
  version facts; pending candidates retain strict validation. Removed the duplicate
  release-PR wrapper from ordinary metadata checks: the release workflow already
  verifies its exact candidate before pushing. The complete metadata gate now passes
  for 22 products, 354 artifact targets and 42 compatibility fields, including Bun
  lock convergence and example Cargo policy. The pre-move Release Please history
  simulation passed; applying its one-time carry of unreleased notes at cutover
  remains task 02a/27b work. The combined workflow gate passed again after adding
  source crate uploads. Release metadata and the 21 publication-lock tests also
  pass with the shared bindings and broker source carrier present.

- **05/25, partial packaging cleanup:** removed native TS's intermediate
  `package-shape` task and second copy. Its final packager stages built output once.
  WASIX retains its actual package task, with an explicit source-build dependency;
  packaging stages the browser host inside its own output rather than modifying
  source-build output. Both real archives passed final validators; all 28 focused
  affectedness tests passed after the task changes.
  Packed consumer fixtures now install the actual WASIX SDK archive instead of
  making another SDK copy. `smoke-browser.sh --package-only` passed in Chrome
  (direct/worker SQL, IndexedDB, transactions, pgTAP and logical tools), and the
  packed Node condition smoke passed. Browser fixture query-archive placement and
  its stale source-host prerequisite were corrected; its controller runs on Bun.

- **04, product move applied:** 1,465 files moved to the agreed runtime, SDK,
  broker, extension, PostgreSQL and docs owners, with no destination collisions.
  Existing dirty source was snapshotted before application. Obsolete ignored
  outputs were preserved under `target/pre-layout-build-outputs`, not left as
  apparent source in retired directories. Moon discovers projects without a
  manually enumerated owner list; package manifests and Bun links resolve.
  Remaining shared helpers and resource/tools ownership are separate unfinished
  work; no compatibility source directories were introduced.
- **04/12, post-move proof:** Rust's five library suites pass 381 tests, six
  crates pass Clippy, and actual source-package/packed-consumer tasks pass.
  Four TS/query/RN builds and typechecks pass with 434 source tests, plus 42
  packaging/tool tests (nine macOS-only skips). Real packed WASIX Node and Chrome
  consumers pass. Docs export, 49-page HTML checks and 44-route link/type checks
  pass. The browser host now owns its build task and the SDK declares that
  producer dependency. Kotlin formatting, two shared protocol fixture tests and
  50 Android runtime-resource unit tests pass; missing fixtures can no longer
  silently turn those JVM tests into successful no-ops.
- **24, affected-task correction:** CI selects actual task closure rather than
  every target sharing a job label. Full qualification remains explicit. An
  Android ABI receipt dependency missing from Moon is now declared, and uploads
  follow selected package targets. The post-move workflow aggregate passes all
  48 graph/transfer tests plus actionlint, zizmor and execution checks. Transport
  test files no longer invalidate PostgreSQL runtime builds merely because the
  tests moved beside shared source preparation.

- **05/06/25, task normalization:** Rust SDK/query/bindings/broker owners now
  expose consistent format, lint, build, test, package and consumer tasks.
  Packaging no longer hides consumer compilation. Five real packaging tasks,
  four builds, 66 bindings tests and 32 graph checks pass. TS/query/RN owners
  use the same public taxonomy through Moon's native inherited-task renaming;
  all four builds, typechecks, formatting and linting pass, with 476 tests and
  nine macOS skips. Query/native/WASIX archives validate. RN's final archive
  still requires genuine Apple artifacts; no placeholder is accepted.
- **09a, shipping Linux addon:** Node/Bun use the Rust napi-rs adapter and shared
  native sessions. The 2,444-line C++ implementation and Node-header installer
  machinery are removed. The optimized release build passes 57 lifecycle cases,
  actual Node source/restore and Bun direct/broker/server consumers; Deno's
  existing FFI path also passes. Deno addon teardown remains a demonstrated host
  incompatibility, so its FFI implementation is retained. macOS/Windows shipping
  execution is not yet qualified. Package/build and lifecycle qualification are
  separate tasks sharing the same Cargo output/profile.
- **13, postmaster executor:** ordinary owner Cargo.toml/Cargo.lock replace
  workspace injection and source copying. Preparation emits only Cargo patch
  paths for prepared Wasmer; the upstream CLI references owner source directly.
  Fresh/repeated preparation, release builds, 36 executor tests, version output,
  receipt checks and locked CLI resolution pass. Executor normal dependencies
  contain neither LLVM nor Cranelift. Full sealed-carrier concurrency proof is
  still required in the aggregate pass.
- **14, native tools:** independent archive/Cargo/npm producers use the new
  `postgres-tools-native` owner, retaining registry identities at version 0.2.1.
  Runtime packagers no longer emit utility archives. Corrected a real consumer
  defect: tools omitted libpq while the old Linux check borrowed runtime-package
  libraries. The tools archive now includes only its local dynamic dependency
  closure. Its isolated glibc 2.38 consumer passes with four ELF files and three
  executables, without a runtime package mount; repeated packaging has identical
  SHA-256. Disjoint runtime/tools Cargo packaging and real extracted Rust consumer
  pass, as do packed npm logical dump/restore on Node, Bun and Deno. Native CI
  uploads follow selected runtime/tools tasks. Central release dispatch and the
  WASIX optional execution/assets split are being completed separately.
- **21/22/25, helper ownership and deletion:** 77 metadata/packaging helpers moved
  to tools/release, tools/packaging and actual native/Swift/ICU/extension owners;
  130 tests pass, with one Darwin skip. Android/Maestro installers now belong to
  tools/dev, CI emulator provisioning to tools/ci; all three Shell suites pass.
  Native source lookup/PostGIS cache behavior now runs as small owner Shell
  tests, replacing release-owned TS subprocess harnesses. Deleted the manual
  example Cargo dependency graph and unused lock validator: release bindings
  follow source manifests (including aliases/scopes), while real WASIX package
  pin validation stays with its producer. Four focused tests pass; full version
  transition checks await the in-progress tools catalog/lock checkpoint.
- **24, transferred producer ordering:** real Moon 2.5.4 experiments show
  `--upstream none` drops ordering even between explicitly selected roots and
  runs a consumer after its producer fails. The CI handoff therefore orders only
  those selected roots and runs them sequentially, preserving downloaded
  dependencies without a second general scheduler. Actual RN producer/package/
  consumer graph, failure propagation and cycle tests pass. Workflow aggregate:
  eight helper checks, 17 CLI cases and 49 affected/transfer cases pass.
- **24/25, declared CI checks:** removed project-name and command-substring
  heuristics from policy classification. Task tags select the lane, and both
  check lanes execute declared Moon dependencies. Deleted the cross-project
  policy bundling/parser pass; owner lint and executable tests remain. Six
  focused classifier/capability tests, both owner lint tasks and the complete
  workflow check pass (49 affected/transfer cases, plus CLI/security checks,
  actionlint and zizmor).

The earlier `bun install --frozen-lockfile` checkpoint passed with lifecycle
scripts enabled. Refresh and repeat it after the new tools carriers and removed
addon dependency settle. No active pnpm/Vitest executable references or committed
JavaScript/Python files remain.

No registry publication or production deployment has been performed. Whole-repo
remaining ownership moves, mobile bindings, broker PG wire, resource ownership,
cross-platform qualification and the remaining CI/release redesign are pending.

## Docs review and planned cleanup

Status: implementation authorized; see the current implementation log above.
The earlier premature implementation was reverted, preserving the pre-existing
work. Earlier experimental build results do not establish that
the current or eventual final repository meets these requirements.

Observed issues: docs declare SDK workspace dependencies, generate API summaries,
and carry TypeDoc/Dokka/DocC/Doxygen integration and extensive cross-project task
inputs. Test-marker checks establish only that strings exist, not that examples
work. The source-version matrix reads release-candidate metadata; the releases
page promises historical docs without a working archive. Kotlin installation
examples contain mismatched plugin/library versions, and release PR rewriting
does not cover every displayed version.

Planned work:

- Remove generated SDK API references for now, their exclusive tools/dependencies,
  dead navigation and duplicate checks. Preserve written guides and actual SDK
  behavior tests. Review callers before deleting shared facilities.
- Remove docs versioning, applicability/version scaffolding and historical-docs
  promises. Keep independent product versions and release identities intact.
  The site should describe the latest available products.
- Retain only useful product metadata inputs, explicitly owned in the task
  graph. Prove docs can build locally without native SDK toolchains and SDK
  implementation-only edits do not unnecessarily rebuild the site.
- Resolve each product's latest completed, non-prerelease GitHub release at
  docs preparation time, using existing stable component identities. Render
  installation commands from that explicit generated input; do not use the
  Release Please candidate manifest or one repository-wide latest tag. Product
  finalization guarantees public dependency availability. Pin related runtime,
  Kotlin plugin/library and Swift installation examples to the compatible
  versions of the selected published product, not independently latest values.
  A product with no completed release is unavailable, never version 0.0.0.
  Cache the resolved input as an ignored build artifact; local builds may consume
  it explicitly, tests use a fixture. Network failure does not invent a version
  or silently advertise a stale build as newly refreshed. No committed mirrored
  version constants, SDK builds or cross-SDK API generation are required.
- Hosting is **oliphaunt.dev on Vercel**. User approved production guides from
  main with versions from completed releases. Use existing Vercel Git deployment
  for docs changes and one protected main-branch deploy hook after an entire
  release operation completes. Inspect the actual root/build/ignore settings and
  record only the required changes; avoid one deployment per product tag.
  Resolve fresh published metadata on the triggered build even when normal
  dependency/build caches hit. Correlate the requested deployment with its actual
  status and the live guides; hook HTTP acceptance alone is insufficient.
  A failed refresh preserves the existing live site and has a docs-only retry.
  Concurrent/main-advancing builds must not let an older deployment replace
  newer guides or published-version data. Main guides must describe available
  features; future-only prose stays off production or is explicitly labelled.
  This editorial rule is not a source-text policy checker. Hook secret/access
  and existing Vercel settings are implementation prerequisites, not new user
  architecture decisions.
- After the full plan is implemented, perform task 30a's principles review
  against the final graph and release flow. Keep only consequential checks,
  ecosystem-native local commands, necessary dependencies and clear ownership.

Research: [Apache ADBC's versioning](https://github.com/apache/arrow-adbc/blob/main/docs/source/format/versioning.rst)
and [docs configuration](https://github.com/apache/arrow-adbc/blob/main/docs/source/conf.py)
illustrate separating source/development state from published versions, without
requiring us to adopt its docs-version system. [Vercel deploy hooks](https://vercel.com/docs/deploy-hooks)
target a configured branch; [Git integration](https://vercel.com/docs/git) can
deploy on pushes independently of product publication. Recheck these mechanisms
when implementing rather than assuming a hook alone guarantees latest-released
documentation.

## Planning closure and remaining implementation evidence

Planning validation: a disposable local check found 59 unique numbered tasks,
an acyclic prerequisite graph whose final task reaches all 59, all 18 machinery
items, and an inventory total matching 2,287 tracked paths. Relative document
links, code-fence balance and trailing whitespace passed. The check was not
added to the repository or CI; no product qualification was run for this edit.

- [x] Enumerated all tracked source/configuration domains and mapped them to
  owners/tasks in the companion contracts; included all 20 current release
  declarations and their carriers, plus the new products and internal projects.
- [x] Defined native command profiles, target preservation, dependency/output
  contracts and meaningful source/package/platform proof for every leaf family.
- [x] Incorporated all 18 machinery dispositions with removal/replacement criteria.
- [x] Resolved naming and docs preferences; retained Release Please, normal query
  dependencies and explicit browser-host/tools/resource release ownership.
- [x] Added history/carrier transfer task 02a, including version floors and
  first post-move release behavior; no registry reset is permitted.
- [x] Defined an acyclic execution order with docs review before final acceptance.
- [x] Fixed release ordering: assemble, freeze, qualify final packages, publish
  those bytes, verify public consumers, finalize, then independently refresh docs.
- [x] Defined completion evidence and made unavailable platform/registry/deploy
  verification explicitly incomplete; no directory move closes a behavior task.

Read-only GitHub inspection during planning confirmed main as the default
branch, squash-only merging and published releases for all 20 current release
components. Latest listed examples included native/WASIX runtime 0.2.0,
postmaster 0.1.0, Swift 0.7.0 and WASIX TS/addon 0.1.0. Legacy contrib and
unscoped Swift tags remain public history. These observations are not proof of
every registry package's bytes. An earlier crates.io lookup for the now-reserved
bare liboliphaunt-native name was blocked by HTTP 403. The final bindings name is
liboliphaunt-native-bindings; its availability must be checked in 02a before any
reservation or publication. Reserving a name in this plan creates no registry
package. Actual Vercel settings/access, registry trust settings and native
execution remain evidence to obtain during the owning implementation tasks.

This completes planning for the defined scope, not implementation qualification.
Unexpected source/platform constraints must be recorded with their minimal
reproduction and a plan adjustment; they are not permission to silently remove
functionality or expand the architecture. Routine replacement choices belong to
the implementer under the existing principles. Ask the user only if a discovered
constraint changes product scope, naming, public behavior or another agreed policy.

## Consolidation decisions and completion contracts — 2026-09-11

This amendment is part of the implementation plan. Tasks 06,06b,07,08,11a,
15–20,23–29 and final acceptance 30 must satisfy it. It supersedes earlier
references that retain pnpm for repository maintenance. No runtime behaviour
or optimization has been changed during planning. The source evidence is the
current planning checkout, not a claim that overlapping upstream PRs are merged.

### Resource production and consumption (15–20)

Current Swift OliphauntRuntimeResources.swift/OliphauntExtensionResources.swift
and Kotlin OliphauntAndroidRuntimeAssets.kt contain substantial resolution,
extraction, cache and publication logic. Moving these files is not completion.

1. Inventory each current input and caller: installed carriers, explicit local
   resource paths, custom runtime/extension overrides, static mobile extension
   registration, standard/ICU initialization, existing databases and restore.
   Record the replacement for each supported path before deleting its code.
2. Producers own immutable payloads and their authoritative metadata. Gradle,
   Swift packaging and application integration select and stage the final
   resource closure before application launch. Resolve selection once; do not
   recreate a package catalog/resolver inside each SDK. Keep one resource product
   and its selectable carriers; do not add a new public resource-manager SDK.
3. Move compatible immutable assembly, digest calculation and installation
   receipts to the build/install boundary. Remove redundant SDK caches, catalog
   copies, manifests and extraction engines after their callers migrate. Retain
   a small platform extractor/cache only when the actual bundle format or
   supported explicit input needs it; no universal filesystem framework.
4. Runtime code locates selected assets, validates necessary runtime/physical/
   ICU compatibility, and creates mutable database storage safely. Read-only
   application bundles cannot become live PGDATA. Preserve private seed copies,
   concurrent initialization exclusion, descriptor-last publication, interrupted
   recovery, create-only restore and useful missing-resource errors. Existing
   databases do not require a seed merely to reopen. Do not erase validation at
   an untrusted/custom-input boundary because build-owned assets were validated.
5. ICU data exists once in the selected closure; standard profiles exclude it.
   Native and WASIX ICU seeds remain distinct while sharing compatible ICU data.
   Keep four logical seed profiles plus necessary physical target variants.
   Extensions remain explicitly selected, with correct native static/dynamic
   and WASIX side-module handling. A selection change must remove stale staged
   files; repeated application builds must not duplicate or accumulate assets.
6. Acceptance uses actual final packages/apps: inspect selection and installed
   size, initialize/query/close/reopen, restore, exercise ICU collation, reject a
   wrong/corrupt resource without modifying existing data, and interrupt/retry
   initialization at a meaningful publication boundary. Compare first versus
   repeated preparation. No application-time download or package graph traversal
   for preselected bundled assets. Custom inputs get the smallest equivalent
   validation path. Delete obsolete tests of the removed cache implementation.

### Query ownership and behavioural proof (07,08,23,25)

Both Rust query.rs adapters currently implement QueryResult/QueryRow inherent
methods on copied query-core types. Moving the methods and their error ownership
into sdks/rust-query is required for a real Cargo dependency. Prefer a single
query/decode error contract and a small boundary conversion over duplicate
wrappers or extension traits added only to preserve today's source layout.
Remove the build.rs source-copy/include fallback and packaged duplicate sources.
Shared TS query behaviour similarly belongs to sdks/ts-query; native/WASIX/RN
consumers do not each need a duplicate parser test suite.

The simplest useful oracle for PostgreSQL-compatible semantics is ordinary
PostgreSQL at the pinned major/version, queried through an independent standard
driver. Reuse existing shared SQL scenarios and consumer harnesses. For the
focused compatibility integration task, run the same deterministic scenarios
against the reference and selected Oliphaunt implementations and compare public
results, types, SQLSTATE and transaction outcomes where contracts agree. Fix
locale/timezone/encoding/session inputs; do not compare unstable backend IDs,
timestamps, whole error strings, private representations or arbitrary OID values.
Normalize only documented incidental differences, not genuine failures.

Do not make every source unit test start PostgreSQL or compile every runtime.
Run pure decoder/type tests once at their package and focused reference-backed
integration when relevant behaviour changes. Reuse one reference server for a
qualification job; keep each scenario's database/session state isolated. Use
already-required client tools/driver support before adding a new harness.

Keep a small set of handwritten semantic expectations where an independent
PostgreSQL oracle cannot express the product contract: malformed/truncated input
rejection, buffer bounds, unsupported COPY/transaction combinations, callback
abort, cancellation/close ownership, and language-specific value conversion.
Handcrafted protocol bytes are justified for malformed-input tests. Do not
snapshot the implementation's own output as truth, read source to predict
behaviour, mass-generate golden files, or add a schema/test-generation framework.
Correctly shared fixtures are test inputs, not another implementation of SQL.

Acceptance: both packaged Rust SDKs resolve the shared crate and expose usable
common types; TS consumers resolve their normal package dependency; reference
comparisons detect a deliberately incorrect result during implementation review;
remaining adapter checks exercise actual conversion/lifecycle differences.
Remove temporary perturbations after this one-time proof. No permanent mutation
testing machinery or new all-platform conformance mega-job is required.

### Native server readiness (11a)

src/sdks/js/src/runtime/pgwire.ts currently combines startup readiness and a
query operation consumed by native-smoke.ts. The production server adapter
does not expose that query path. Replace test-only querying with an ordinary
PostgreSQL client and remove its otherwise unnecessary production protocol code.
Apply the same caller review to Rust readiness. Preserve the requested user/
database startup handshake, bounded wait, observed child exit, exact endpoint
and cleanup semantics. pg_isready or a port probe is not automatically an
equivalent replacement. The standard-client smoke proves a real downstream
connection/query, not just agreement between two private Oliphaunt helpers.

### PostgreSQL patch hierarchy (06)

There are three product lanes: native, embedded WASIX, and concurrent WASIX
postmaster. Today postmaster applies its own series and then
postgres/main-optimizations.series, whose files live inside the embedded WASIX
product. Native/WASIX also duplicate the collation-discovery change. Replace
that cross-product ownership with:

```text
third-party/postgres/
  source.toml
  patches/
    common/                  # existing deltas truly applicable to all lanes
    wasix/                   # identical deltas consumed by both WASIX lanes
runtimes/liboliphaunt-native/postgres/
  patches/                   # native-only deltas
  series                     # explicit complete ordered patch references
runtimes/liboliphaunt-wasix/postgres/
  patches/                   # embedded WASIX-only deltas
  series
runtimes/liboliphaunt-wasix-postmaster/postgres/
  patches/                   # concurrent process/shared-memory deltas
  series
```

These are source/build ownership directories, not separately released packages.
Use the same pinned upstream source and a small Shell series applicator. Lists
are explicit build recipes, not manual CI affected-path lists. Declare selected
patch files/series and overlays as real producer inputs in Moon. Do not use glob
order, duplicate patch bodies, copied shared directories, or a dynamic patch
resolver. Ordered series can interleave layers when necessary; hierarchy must
not silently reorder dependent hunks. Each build gets its own prepared tree.

Lift existing common identity/branding/default build configuration where it
actually exists and has the same meaning. Configure flags belong in shared build
configuration rather than unnecessary PostgreSQL patches. Do not invent new
branding work, alter PostgreSQL wire/server_version compatibility, remove legal
notices, or enable an embedded setting in postmaster just for visual symmetry.
No dedicated branding delta was identified in the targeted patch search; verify
overlays/build substitutions before concluding there is none. The two existing
collation patches are a consolidation candidate; do not newly apply their
behaviour to postmaster without evidence that it belongs there. A shared patch
may be selected by two lanes only; common storage does not mean mandatory use.

Reconcile current main, PR #202 and issues #201/#203 before migration: some local
optimization patches may already have been superseded. Preserve each lane's
effective preprocessed behaviour and resulting source postimage when only
reorganizing. Record a concise rationale/base/consumers in existing patch headers
and series comments, avoiding a second metadata ledger. Verify clean apply,
repeat/interrupted preparation and the affected build/behaviour at their owners.
Keep true concurrent atomics/spinlocks in postmaster; never import the embedded
single-backend specializations into it. Remove obsolete patch provenance/selection
files only after their meaningful information and consumers have migrated.

Optimization deletion/tuning is explicitly deferred. In the current checkout,
performance-oriented deltas include 0014 hash loads, 0015 top-XID lookup, 0016/
0026 integer B-tree comparisons, 0017 scratch allocation, 0024 LIKE substring,
0030 WAL segment arithmetic and 0043 JSONB metadata caching. These are not user
configuration switches and are not proven safe deletions. Some are compiled out
in particular lanes despite appearing in a selected series. 0037 combines a
single-backend entropy buffer with a descriptor-exhaustion correctness fix;
0039 sigsetjmp is error recovery, not an optional optimization. 0018 pg_dump LTO
collision is build correctness despite appearing in main-optimizations.series.
0035/0036 have single-backend execution assumptions. Preserve all required
semantics and existing performance choices during organizational changes.

### Bun maintenance toolchain and pnpm retirement (06b,05,22–29)

Decision: Bun-specific maintainer TypeScript and bun:test. The package-manager
target is Bun workspaces, not parallel pnpm/Bun maintenance. Stable 1.4.2 was
verified from oven-sh/bun releases/latest on 2026-09-11 and is already pinned in
.prototools. Use an exact reviewed pin, never a floating latest in CI. Shell
still owns command orchestration; Bun's shell API is not a workaround. Native
language test runners remain native; real Node/Deno/browser/device execution
is still required for those advertised product surfaces. Node can remain for
third-party tooling and publication transports that require it.

Bun documents workspaces, catalogs, isolated linking, frozen installs, overrides,
filtered installs and packing workspace/catalog references. Moon documents Bun
dependency discovery and task inference. This establishes a plausible migration,
not evidence that this repository already passes it. During implementation:

- Convert root workspaces/catalogs to package.json; use one bun.lock and explicit
  isolated linker settings. Keep independent standalone consumer fixtures only
  where they prove installation outside the workspace. No duplicate local locks
  for ordinary workspace members or generated scoped-workspace manifests.
- Audit every pnpm setting. Current minimumReleaseAge 1440 is minutes; Bun's
  equivalent uses seconds (86400). Carry justified overrides and explicit trusted
  dependency build scripts, including Electron/esbuild/sharp consumers. Bun's
  peer auto-install default differs from current autoInstallPeers:false: prove
  the chosen policy and required consumer peers rather than silently inheriting
  a new default. Remove the ICU hidden-hoist workaround only when explicit
  resource ownership makes it unnecessary. No blanket trust-all or hoisting fix.
- Trial migration in a disposable copy, compare resolved versions and resulting
  package closures, and review intentional lock changes. Test filtered cold/warm
  frozen installs, missing dependency errors, platform optional packages, lifecycle
  scripts and workspace/catalog substitution in final tarballs. Verify actual
  pinned Moon plugin support; do not assume current website configuration matches
  the pinned plugin. Upgrade the plugin only with a focused graph/install proof.
- Migrate meaningful Vitest tests to bun:test without preserving tests of deleted
  machinery. Keep real Playwright/device/host processes for integration. Establish
  Bun type declarations and retain tsc typechecking; bun test is not a typecheck.
  Verify worker/mocking/timers/isolation differences used by surviving tests.
- Delete pnpm tool acquisition, scoped workspace writer, package-manager pins,
  lock/config/cache paths and documentation after caller migration. Update docs
  Vercel install configuration, examples, packaging, release-PR lock refresh,
  qualification and contributor commands together. A release PR must update the
  Bun lock consistently with workspace versions, with an idempotent second run.
- Package once, qualify and freeze those bytes. Do not switch publication
  transports merely to brand them Bun: verify registry auth/OIDC/provenance and
  frozen-tarball support before replacing a working npm transport. Ordinary npm
  consumers must keep working and do not need Bun. No publication-time rebuild.

Sources: [Bun install](https://bun.com/docs/pm/cli/install),
[catalogs](https://bun.com/docs/pm/catalogs),
[workspaces](https://bun.com/docs/pm/workspaces),
[Moon Bun support](https://moonrepo.dev/docs/guides/javascript/bun-handbook),
[verified stable release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2).

### Qualification follows responsibility (24–29)

Test substantive shared logic once at its owner, adapters for conversions and
host lifecycle, installed packages for consumer compatibility, and platforms
for their actual platform behaviour. Input edges select affected tasks; do not
propagate a shared unit change into every downstream device test by default.
Conversely, a changed native lifecycle/resource adapter cannot be excused by a
shared Linux unit pass. Keep producer-before-consumer edges at required artifacts.
Do not introduce a parallel path whitelist or scenario-to-file scheduler.

For every retained task, identify the consequence it detects and the artifact/
source inputs needed to detect it. Delete repository-layout/source-spelling
checks, repeated decoder suites, unused-client tests and checks of removed cache
machinery. Do not replace these with new policy tests asserting the taxonomy.
Use representative changes as a one-time graph acceptance review, including a
query-core change, resource selection, common patch, lane-only patch and release
metadata-only change. Package compatibility still needs proof when dependency
bytes change, but not every unrelated lifecycle/stress scenario.

Release qualification consumes the final candidate once, then publication
promotes it. PR/source proof is reusable only for the same relevant inputs and
outputs; a different merged SHA or changed packaged dependency is not covered by
an earlier assertion. Preserve task-local reproduction commands and avoid an
extra full qualification before an already-equivalent release qualification.

### Explicitly parked work

- [#212 — Browser-host implementation extraction](https://github.com/f0rr0/oliphaunt/issues/212).
- [#213 — Wasmer dependency-family/backport convergence](https://github.com/f0rr0/oliphaunt/issues/213).

Both issues contain bounded investigation and acceptance criteria, reference
overlapping existing work, and are excluded from task 30 completion. Existing
browser-host ownership/build fixes remain in task 12. Optimization changes are
deferred, not a hidden acceptance requirement. The subsequent broker/mobile
amendment below adds scoped PG wire and UniFFI investigation and migration work;
it does not unpark #212/#213 or authorize optimization changes.

## Broker PG wire and generated mobile bindings — follow-up decision

The user authorized deeper delegated UniFFI investigation, PG wire broker
planning, the C-error fallback and RN consolidation. These are now tasks
09c/09d,10a/10b and 20a, not unassigned future suggestions. Planning does not
claim that prototypes or platform qualification have run. The following
contracts supersede the earlier broker-preservation-only scope.

### Broker: standard PostgreSQL traffic plus minimal management (10a,10,10b)

Preferred target:

```text
Rust/TS SDK or ordinary PostgreSQL driver
  → PostgreSQL wire endpoint → broker-owned embedded native session
Owning SDK
  → small private management endpoint → backup / process shutdown
```

The current PGOB envelope already carries PostgreSQL request/response bytes.
Remove that envelope from SQL traffic. PostgreSQL supplies startup negotiation,
authentication messages, parameters/results/errors, streaming message sequences,
transaction status, Terminate and a separate-connection CancelRequest mechanism.
Cancellation therefore belongs on PG wire, not in a parallel custom cancel RPC.
Termination of a SQL connection is distinct from terminal shutdown of the owned
broker process; preserve that distinction explicitly.

Reuse the existing management transport narrowed to authenticated backup and
shutdown, with bounded payload/error handling. This avoids inventing HTTP/gRPC,
another schema generator, or a second query protocol. Startup configuration and
resource selection remain process-launch inputs; endpoint readiness remains an
owned startup result. No generic admin API or remote management service. Current
broker IPC has no restore request: TS restore uses the native binding separately.
Trace Rust/TS restoration before claiming addon-free restore; preserve the
existing operation or use a narrowly scoped pre-open broker helper if required
by the final installation contract. Do not invent a live restore command merely
to fill a management API. Do not equate the native physical archive with the
standard PostgreSQL replication BASE_BACKUP protocol, or disguise process
commands as SQL statements/extensions.

This remains embedded execution with one active backend. Initially admit one
SQL client and reject a second promptly rather than interleaving sessions or
silently pooling transactions. A subsequent connection may reuse the process
only after proved session reset; otherwise end/restart that broker instance.
Preserve existing reopen/persistence behaviour through the owning SDK. Do not
advertise independent concurrent sessions, replication or full server feature
parity merely because ordinary drivers can connect.

Concrete source gaps to prove before cutover:

- native liboliphaunt_protocol.c validates a supplied request, streams output and
  waits for ReadyForQuery. An ordinary driver can send Parse/Describe/Flush and
  wait for a reply before sending Sync. A complete-buffer API cannot be assumed
  to support this incremental exchange. Demonstrate a bounded native protocol
  pump with input/output progress and real message boundaries; make the smallest
  necessary native ABI addition if required. Never append fake Sync messages or
  buffer indefinitely, since that changes transaction/protocol behaviour.
- The current WASIX proxy has startup/protocol-pump machinery, but its
  CancelRequest branch closes the connection without routing cancellation.
  Reuse only proven portions. Supply valid per-session BackendKeyData, validate
  CancelRequest secrets and invalidate stale keys on teardown; route cancel
  independently of a busy SQL worker. Negotiate an explicit protocol version
  and implement its matching key format (PG18 supports newer minor negotiation;
  do not advertise it while assuming every cancel key is four bytes).
- Preserve private endpoint binding and fresh process credentials. Use standard
  PG authentication for SQL and retain authenticated management. A supported
  local-only password exchange can carry the existing ephemeral credential;
  do not add a homegrown password scheme, expose credentials in logs, or claim
  internet-facing TLS/server authentication support. Validate requested database,
  user and startup settings against the owned session rather than acknowledging
  unsupported changes. ParameterStatus must reflect actual settings.
- PG errors remain PG errors and transaction status is preserved. Transport or
  native failures that leave session state unknown close the session; no query
  replay. A client callback failure remains local: drain to a confirmed protocol
  boundary (or cancel/close when needed) before reuse, then return the callback
  error. Normal SQL streaming no longer needs a custom callback-aborted frame.

Task 11's pgwire-server extraction is the initial reuse point. Share real
framing/startup/socket plumbing between native broker and WASIX proxy when it
removes duplication; make the existing WASIX engine dependency optional so a
native broker cannot pull in Wasmer/compiler assets. Keep runtime-specific
execution behind narrow real adapter functions, not a new universal executor.
Evaluate the low-level codec/startup facilities of sunng87/pgwire against this
existing code before choosing a new dependency. Its full SQL-handler server
framework is not automatically useful when PostgreSQL already processes SQL;
avoid decoding and rebuilding every result through a second query engine.

Proof uses an installed broker with psql and independent Rust/TS clients:
simple/parameterized/prepared queries, transactions and rollback, notices/errors,
fragmented/coalesced packets, Flush before Sync, supported pipelining and clear
rejection of unsupported COPY/features without hanging. Exercise slow readers,
bounded buffers, cancellation during saturation, stale/invalid auth/cancel keys,
disconnect during transaction/stream, second-client rejection, backup ordering,
shutdown and parent death. Preserve every existing supported raw-protocol
behaviour; document extensions to support only after demonstrated. Run focused
Linux proof early, then Unix/macOS and Windows packaged transports on their
actual hosts. Compare maintained code/dependencies and final package size before
removing the old path. Temporary A/B fixtures are deleted after cutover.

If the necessary native pump cannot preserve behaviour without disproportionate
runtime redesign, report the concrete blocker and revise this plan before
cutover; do not claim 10b complete while shipping two permanent query protocols.
This is a product-boundary experiment, not permission to silently reduce scope.

Sources: [PostgreSQL message flow](https://www.postgresql.org/docs/18/protocol-flow.html),
[pgwire implementation](https://github.com/sunng87/pgwire).

### UniFFI shared mobile implementation, with C fallback (09c,09d)

The source/docs review led to the implemented shared mobile bridge below.
The platform acceptance gates remain distinct from the completed migration:

```text
sdks/rust/
  liboliphaunt-native/   # shared native operations/error/lifetime; linked + dynamic
  sdk/                  # existing serialized session/query API
  mobile-bindings/      # private Cargo build project: UniFFI exports
sdks/swift/             # generated binding + thin idiomatic/platform facade
sdks/kotlin/            # generated binding + thin idiomatic/platform facade
```

mobile-bindings consumes the actual direct Rust implementation and shared query
crate; it does not reimplement queues, SQL conversion or database operations.
Use direct-only Cargo features to exclude desktop broker/server/carriers from
mobile builds. Keep the native bindings crate independent of the public SDK.
No extra public registry identity/changelog: generated code and native interop
artifacts ship with the consuming Swift/Kotlin products. Use Rust proc-macro
exports as the interface authority, not a second hand-maintained UDL definition.

Required feasibility work:

- Rust's existing ffi.rs dynamically loads symbols; Apple's C bridge also uses
  linked symbols and static extension registration. Implement/prove the explicit
  linked route in the shared bindings; preserve dynamic/custom paths on supported
  platforms. Keep mobile resource lookup at its native integration boundary.
- UniFFI exports need Send + Sync objects. Wrap the existing serialized owner
  session, not raw native pointers with unsafe marker traits. Native execution
  remains on the owner thread. Use foreign-driven futures where sufficient;
  no second Tokio runtime or executor merely for binding generation.
- Foreign future/task cancellation must reach PostgreSQL's independent cancel
  path and reconcile admitted work before allowing another operation. A dropped
  future alone is not cancellation or evidence of a reusable session. Preserve
  queue admission, transaction exclusivity, rollback, streaming backpressure and
  callback failure. Async borrowed buffers must not outlive the original call;
  use owned bounded chunks and measure copies rather than claiming zero-copy.
- Kotlin wrapper disposal/close is not safe database shutdown. Give the internal
  operation a distinct name such as shutdown; public SDK close awaits it before
  disposing the binding. Keep generation-safe stale calls, concurrent close,
  terminal session handling and reopen/persistence semantics.
- Account for stable Kotlin/JNA Android AAR dependencies and callback-thread
  attachment, supported ABIs, API floor, native load order, R8, notices and size.
  Do not quietly switch to an experimental generator to evade packaging cost.
  Verify the exact pinned generator with this repo's Swift 6 strict-concurrency
  settings; documented async/Sendable limitations need actual compiler evidence,
  not blanket warning suppression.

Prototype acceptance uses existing behavioural scenarios and minimal clean
Swift/Kotlin consumers, not a new test framework: parameterized queries and
SQLSTATE, transactions, streaming with a slow/rejecting callback, cancellation
before/after admission and under queue saturation, shutdown/reopen/stale objects,
backup/restore and terminal failures. Prove selected static extensions/resources,
Android arm64 plus remaining declared ABI packaging, and Apple device/simulator
and macOS support on the relevant hosts. Measure query/stream/backup allocations,
copying, binary size and dependency/build cost versus the current bridge.
Linux-only generation cannot close Apple/Android behaviour acceptance.

On success, delete the replaced Swift C bridge, Android JNI native bridge and
duplicated proven-shareable query/session implementation. Keep idiomatic public
facades and real platform integration. On failure, record the reproducible
constraint and take the already-authorized fallback: use existing _with_error
operations in the surviving bridges and delete redundant error-copy/storage
logic. Cancel has no _with_error entry point; retain correct immediate error
capture for that call and bridge-originated errors. If UniFFI succeeds, it
inherits Rust's error capture and no separate cleanup of deleted bridges is
needed. Permit a different outcome per platform only with concrete evidence;
never keep two interchangeable implementations for one target.

Generated source and native binaries must use the same pinned generator/interface
inputs and freeze together. Declare Cargo/Moon and Swift/Gradle producer edges;
shared implementation changes select affected SDK builds/releases, while the
private adapter has no independent release ceremony. Prove clean packaged
consumers and idempotent release-PR dependency/version updates. Build consumers
never secretly regenerate a different binding from a published binary.

UniFFI is in-process FFI, not process isolation. The reviewed RN
NativeDirectProcessOwner is not proof of Android Binder/services or an Apple
extension implementation. Preserve actual shipped direct behaviour and reconcile
PR #126/research separately before asserting an isolation implementation exists.

Sources: [UniFFI async](https://mozilla.github.io/uniffi-rs/latest/futures.html),
[object constraints](https://mozilla.github.io/uniffi-rs/latest/types/interfaces.html),
[Kotlin lifetimes](https://mozilla.github.io/uniffi-rs/latest/kotlin/lifetimes.html),
[Gradle/JNA](https://mozilla.github.io/uniffi-rs/latest/kotlin/gradle.html),
[Swift](https://mozilla.github.io/uniffi-rs/latest/swift/overview.html),
[buffers](https://mozilla.github.io/uniffi-rs/latest/types/bytes.html).

### React Native common JSI mechanics (20a,20)

Both ios/Oliphaunt.mm and android/src/main/cpp/OliphauntJsiBindings.cpp implement
similar acknowledgement mutex/condition-variable/error state, buffer validation,
promises and stream teardown. Share those mechanics in sdks/react-native/cpp,
included directly by CocoaPods and CMake. No separately published common-bridge
package or new framework. Keep JNI/Objective-C++ conversion and actual Swift/
Kotlin SDK integration platform-specific; RN does not go through desktop napi-rs.

Do not simply copy iOS's global weak acknowledgement registry into common code:
Android's pending-stream ownership differs. Make pending callbacks/promises and
acknowledgements belong to the actual RN runtime/stream lifetime, so one runtime
invalidating cannot abort another's work. Use real existing RN lifecycle hooks.
Prove JS-thread-only JSI access, exact ArrayBuffer/view ranges, owned async bytes,
settle-once promises, cancel/rejection, invalidation during acknowledgement wait,
reload, bounded slow-consumer memory and no access after runtime destruction.
Share source tests of the common mechanics once; retain final Android/iOS/Hermes
tests for their integration differences, not two copies of the same helper suite.
Do not advertise legacy architecture or new process isolation as part of this
cleanup. Existing RN codegen stays where it covers the real API; do not assume
it replaces binary streaming merely because it generates open/cancel/close.

### Swift/Kotlin platform ownership checkpoint — 2026-09-11

Swift build/source tests/coverage are portable and use a separate requires-swift
capability. Linux CI provisions Swift 6.3.3 from sdks/swift/.swift-version through
setup-swift commit d8e84bc3a450686a95474d7d6fa4a3301498debc; upstream labels
v3 beta. The pinned implementation uses signature-verified Swiftly 1.1.0 on Linux.
Apple jobs retain pinned Xcode. Compiler-free source archiving and release metadata
staging run on Linux; Apple bundle behavior and native first-open remain Apple
tasks. Native first-open currently requires macOS initdb or a packaged seed.
Kotlin native bridge tests now run independently of Gradle/Android SDK setup.
Linux proof: 95 Swift tests with coverage, Swift checkout/extracted archive builds,
full JNI translation-unit compilation, C/C++ owner tests. Real Apple package/app
qualification still requires the platform artifacts and runner.

### Native broker PGwire checkpoint — 2026-09-11

The ignored `target/broker-pgwire-proof` standard-startup proof now admits real
`pg` and packaged `psql` clients with fresh process authentication, actual backend
ParameterStatus values, per-session BackendKeyData and independent standard
CancelRequest routing. Verified behavior includes prompt second-client rejection,
parameterized SQL, cancellation/recovery, stale cancellation rejection, sequential
transaction/temp reset, malformed startup, explicit protocol3.2 rejection,
COPY output/input, and a stalled Node socket reader followed by successful reuse.

Interactive COPY exposed a real native boundary gap: preassembled COPY requests
worked, but Query closed incremental input before a client could answer
CopyInResponse. The native scanner now opens bounded COPY-only input after that
response and closes it after CopyDone/CopyFail. It does not reopen ordinary
commands. The rebuilt native library passes the full host C aggregate, including
new successful incremental COPY and CopyFail recovery cases, and actual psql
interactive COPY insertion followed by SELECT.

This supports continuing PGwire consolidation; it does not authorize deleting
the existing broker yet. The authenticated startup proof and earlier Flush/feed
proof still need a single bounded input/output lifecycle, management operations,
parent-death cleanup and supported-platform validation. The disposable COPY
callback blocks on client input and is explicitly unsuitable as the final
transport. Reuse common framing and forward native response bytes; do not add
another SQL execution/result-encoding framework. The proof's small line count
does not include those remaining production obligations and is not a claimed
maintenance reduction. Detailed commands/evidence and limitations are retained
in the ignored proof README and `/tmp/oliphaunt-patch-proof/native-copy-smoke.log`.

### Resource release and Windows packaging checkpoint — 2026-09-11

The resources owner now has independent CI upload groups for canonical ICU,
desktop/mobile native seeds and portable WASIX seeds. Release collection selects
these artifacts from the qualified commit/run, packages registry carriers and
freezes their actual archives with the publication lock. Seed archives and their
compatibility manifests are public resource assets; the full producer requires
every declared physical target/profile before writing the release checksum.
Local ICU packaging remains independent of seed production. Shared Maven staging
now lives under tools/packaging; Kotlin retains its own publication integration.
Maven manifest/staging, checksum and publication catalog tests pass (15 tests).
This does not establish a complete multi-platform resource release: real mobile,
macOS and Windows seed production and installed consumers remain qualification gates.

Windows runtime packaging now uses Bash and the existing common extension guard,
VC closure, payload, compatibility and archive tools instead of a 276-line
PowerShell implementation. Native build/package dispatch, shared guard behavior
and Shell syntax pass locally. The 3102-line Windows compiler has also been
replaced with Bash orchestration and extension-owned TypeScript source generation;
only explicit Visual Studio machine setup retains PowerShell. Native commands
remain Shell commands, and both server and embedded modules retain the MSVC
provider/import-library and app-local VC runtime checks. Pinned Meson/Ninja
installation belongs to machine setup. Compiler/source identity changes invalidate
the Windows dependency prefixes as well as PostgreSQL outputs.

The actual pinned pgcrypto, uuid-ossp, pg_hashids, pg_ivm, pg_uuidv7,
pg_textsearch, vector, PostGIS and pgTAP sources pass local source/SQL generation;
Meson 1.10.0 parses the generated recipes, and repeating source/SQL generation
produces byte-identical trees. This caught and corrected a broken
PostGIS source-list template before cutover. Build/package dispatch preserves a
Windows compiler's failing exit status; seven VC runtime closure tests and Shell
syntax/lint pass. These host-neutral checks do not prove compilation: task 24d
remains open until actual MSVC builds, Windows spaces/Unicode/PATH/setup behavior,
and clean installed consumers pass on Windows.

The Windows compiler reads PostgreSQL version, archive checksum and URL from the
canonical PostgreSQL source manifest; its cache includes that reader and fetch
implementation. The combined workflow checks pass after cutover, including
50 graph/handoff tests. Mobile app jobs now download their explicitly declared
ICU seed and canonical ICU archive from `database-resources`, rather than looking
for a seed inside the runtime carrier. Their task graph retains ABI proofs and
the selected resource producers; the seed staging CLI validates the archive,
target, profile and ICU digest. Actual mobile app execution remains outstanding.

Release compatibility synchronization now handles equivalent inline and table
Cargo dependency syntax through the existing dependency editor. Nine release
sync tests pass, including retained fields, repeated synchronization and the
generated release fixed point.

### Native archive validation ownership — 2026-09-11

Desktop runtime `package-runtime-desktop-target` now assembles and statically
checks the distributable without starting PostgreSQL or running the C suite.
`test-artifacts-desktop-target` depends on that package, extracts the final bytes,
and runs the existing ABI/runtime harness and Linux glibc baseline execution.
The harness still uses internal PostgreSQL headers, so this is explicitly an
artifact test rather than a clean public consumer test. Its existing native CI
lane retains this qualification. The local built-runtime command is named
`test-integration`; no forwarding `host-smoke` alias remains.
Rust SDK integration consumes the native build directly rather than rerunning
the native C suite as a prerequisite. Native tests retain their own task/CI owner.

Removed the macOS smoke harness's handwritten subset of iOS source syntax checks:
actual iOS target compilation covers those sources and more. Removed duplicated
native/WASIX ICU uploads and their CI/release byte-comparison helper: resources
now produces one canonical data artifact, and real native/WASIX collation probes
exercise it. Canonical resource upload and release collection remain intact.
Removed the central native npm notice fixture, which restaged fake payloads and
assumed tools/ICU lived under the runtime; the runtime, tools and resources
packagers already validate notices in their actual final npm archives. Packaging
inputs no longer include unrelated compatibility/binary-contract test files.
The complete workflow aggregate passes after this split (50 graph/handoff tests),
as does ordinary release metadata and frozen-lock validation. An additional
affectedness case confirms smoke-source edits select the artifact test without
marking the compiler or packager inputs changed; the required final package
remains in the execution dependency graph. Native execution evidence is recorded
separately from these portable checks.

### Selectable mobile resource checkpoint — 2026-09-11

`database-resources/seeds/package-mobile-carriers.mts` adapts canonical raw seed
archives into the existing bound mobile resource layout. It validates target,
profile, archive digest, physical compatibility and canonical ICU tree binding.
Android standard/ICU seeds use independent `dev.oliphaunt.runtime` Maven carriers;
the existing plugin selects at most one seed profile and resolves the resource
version independently of the native runtime. Existing PGDATA and runtime cache
materialization no longer require an initialization seed.

Swift resources now belong to a separate source package exposing
`OliphauntSeedNativeIOSStandard`, `OliphauntSeedNativeIOSICU`, and `OliphauntICU`.
The SDK source package contains none of those payloads. A real local SwiftPM
consumer builds the SDK and all selectable resource products and reads their
bundles. This proves package composition with fixture PGDATA, not Apple runtime
execution. The resource source archive includes both profiles; the selected
targets determine application bundle contents.

Remote SwiftPM needs a distinct repository identity from the SDK. The existing
source-tag publisher now accepts an explicit resource product/repository and
projects its frozen source ZIP into a standalone Git tree, retaining notices and
source commit/tree provenance. It uses the existing bounded push/reconciliation
mechanism. Local bare-repository tests prove deterministic projection, semantic
tags and resumption, while preserving SDK source-tag behavior. No remote resource
repository or tag has been created; the distribution decision is pending.

Validated: 96 Swift owner tests, Android SDK unit tests, Java/Kotlin compilation,
mobile archive adaptation/rejection tests, resource Maven staging, the local
SwiftPM consumer, and all three source-tag publisher behavior tests. The Android
plugin aggregate now passes after the generated legal receipt was refreshed.
Native npm leaves carry one unpacked PGDATA tree and its logical tree digest;
Cargo leaves retain the compressed include-bytes interface. The iOS npm leaf
contains one resource bundle and resource-only CocoaPod, discovered from the
actual packed fixture by both React Native CLI and Expo autolinking. ICU remains
the existing separately composed canonical data dependency.

The obsolete runtime root receipt and its Swift/Kotlin/Gradle readers are gone.
Runtime target/static-registry binding stays in the actual runtime manifest.
Expo runners take one explicit resource seed directory and reuse its owner
validator, replacing the duplicated Shell contract checks and mandatory two-seed
copy. The selected archive staging CLI and runner composition pass locally.
Actual mobile seed production, Apple CocoaPods installation and Android installed
consumers remain aggregate qualification gates; packaging fixtures do not prove
that PostgreSQL can open those fixture databases.

### Seedless Linux archive checkpoint — 2026-09-11

The current Linux runtime packages without initialization seeds, ICU data or the
obsolete root seed receipt. The consumer task extracts the finished archive and
passes the glibc 2.38 baseline plus the existing native ABI and C lifecycle suite,
including incremental COPY, repeated cancellation recovery, backup/restore,
detach/reopen and terminal shutdown. Packaging and consumer execution now have
separate task ownership.

The actual npm carrier passes payload, executable-mode and notice validation.
The actual Cargo parts and aggregator install from extracted `.crate` files in
an isolated offline consumer; its reconstructed payload matches the tested
release archive byte for byte. Native npm packaging accepts an explicit target
and asset directory so this Linux check needs no fabricated platform artifacts.
Mobile release validation retains semantic target/mode/static-registry and ABI
checks, without restoring removed seed receipts or exact-text size reports.

### UniFFI feasibility checkpoint — 2026-09-11

The ignored `target/uniffi-native-proof` pins UniFFI 0.32.1 and consumes the real
shared Rust NativeSession. Generated Swift compiles with Swift 6.3.3, language
mode 6, complete strict concurrency and warnings as errors. Generated Kotlin
compiles with the SDK's Kotlin 2.2.21 and coroutines 1.10.2 plus JNA 5.14.0.
A private error field named `message` conflicted with Kotlin Throwable; `detail`
avoids that generator collision without modifying generated code.

Actual Swift and Kotlin host consumers pass SQLSTATE propagation, transactions,
slow and rejecting stream callbacks with recovery, independent cancellation,
backup, detach/reopen, stale shutdown and terminal shutdown. Shared bindings now
accept explicit current-process symbols for host-prepared Unix inputs, using the
same typed symbol table and lifetime/generation machinery. The same Swift proof
passes with liboliphaunt linked into the executable and no runtime library path.
This proves Linux dynamic/current-process loading, not Apple static linking.

This initial synchronous prototype was superseded by the production shared async
owner described in the 09d checkpoint below. Rust owner integration, request-scoped
cancellation/rollback, shared static registration and Android AAR/ABI packaging
are implemented and tested. Remaining qualification covers Android device/R8,
Apple application execution, and measured shipping size/copy/build cost; it does
not require another bridge implementation or retaining the deleted C/JNI bridges.

### Task 17/18 checkpoint — explicit WASIX ICU input (2026-09-11)

Rust WASIX accepts `IcuData::new(data_bytes, manifest_bytes)` through synchronous,
asynchronous and prepared-session APIs. Construction verifies the canonical data
identity and logical tree digest once; clones share immutable bytes. Explicit data
requires no Cargo `icu` feature. That feature remains an optional resource-carrier
convenience for Rust applications. Runtime caches use the selected data digest,
replacing the old profile-only global selection; seed compatibility checks compare
the actual installed ICU tree rather than assuming a particular package carrier.

The existing resource integration task now extracts the independently packaged ICU
artifact and runs without the `icu` feature. Both real standard/ICU scenarios pass:
seeded memory/directory storage, unusable-seed-free reopen, unseeded initdb, persisted
SQL and ICU collation ordering. Tampered data is rejected before opening storage.
Also passed: 148 library tests and all-target Clippy with optional Cargo ICU enabled.
The two removed tests exercised a deleted profile-only cache helper and a deleted
test-only ICU receipt helper. TS/browser/addon adaptation remains a separate active
checkpoint; these results do not close all runtime carrier cleanup.

Ownership correction: ICU/tool Rust formatting and Clippy now belong to
`database-resources` and `postgres-tools/native`; native runtime packaging no longer
invokes ICU packaging tests. The actual seedless native Cargo carrier fixture passes
extracted-consumer compilation and repeat-byte checks. Desktop archive behavior is
being checked against real compiled outputs, separately from this Rust WASIX proof.

### Tasks 17/18/21 checkpoint — producer and owner boundaries (2026-09-11)

The WASIX runtime producer no longer invokes the seed generator, declares seed
manifest entries, or exposes bundled seed accessors from its portable Cargo crate.
Its maintainer xtask no longer depends on the seed runner, Tokio, WebC or
wasmer-wasix; AOT serialization retains only the Wasmer compiler dependencies it
uses. Runtime/initdb modules and artifact/source integrity checks remain.
Portable release/npm staging excludes independently owned seeds, ICU and tools.
The old runtime-owned ICU npm producer is deleted. The Cargo payload check now
accepts the actual seedless runtime closure. Producer/portable Rust tests and AOT
serializer compilation pass; 13 Cargo/npm/release staging tests pass. A fresh
compiler build is required: the old prepared-source fingerprint was correctly
rejected. That build also exposed a removed ICU helper call; the WASIX builder now
uses the same canonical raw-data installer as native. Fresh build and final AOT
qualification are still in progress, not covered by fixture package tests.

Extension contracts now live in `extensions/contracts`. Real cross-language
behavior data lives in `test-fixtures`; the native-only archive fixture lives
with native C smoke tests. The unused descriptive fixture manifest was deleted.
Imports, package fixture projection, Gradle resources, evidence paths and Moon
inputs follow those owners. Existing extension/catalog package tests (16) and
shared native Rust tests (60) pass, and Moon resolves the changed project graph.
Four previously compressed SDK Moon files are readable block YAML with identical
parsed task definitions. Running the SDK-owned Bun commands (which load their
declared test setup) passes 349 WASIX SDK tests and 11 WASIX tools tests without
compiling a runtime. Root-level ad hoc test invocation bypassed that setup; it is
not a substitute for those package commands. Actual installed-carrier integration
continues separately against rebuilt artifacts.

Native desktop packaging and Windows compilation read the canonical extension
file inventory through Bun instead of compiling the Rust SDK and packaging CLI
to print it. The obsolete Rust workspace/xtask/packaging source inputs are removed
from the desktop compiler task. The existing extension-exclusion guard still
rejects installed optional control, module and data files. This does not remove
the mobile resource packager or its actual runtime resource assembly.

### 2026-09-11 native addon shutdown correction

Actual installed standard-seed consumers exposed an intermittent Bun 1.4.2
shutdown fatal banner despite successful queries and exit status zero. The
pinned upstream `NapiEnv::cleanup` aborts threadsafe functions after invoking
async hooks without waiting for their completion signal. The production addon
now uses one synchronous native cleanup hook: quiesce callback admission and
acknowledgements, cancel/drain native operations, join their worker threads,
then perform generation-owned terminal close. Native operations need no
JavaScript progress here; competing opens acquire their lease immediately or
fail. Completed operation threads are reaped at subsequent admission. The
async hook/acknowledgement reaper is removed, not ignored on shutdown errors.

The shipping release-profile addon passes all 57 lifecycle cases independently
on Node and Bun. Actual ABI11 PostgreSQL workers pass termination during open,
query, queued query, stream callback and stale copied-addon ownership on both
hosts; backup finishes before terminal close. Twelve repeated real Bun standard
seed close/reopen/exit consumers finish without the prior banner. The regular
addon lifecycle task now runs both hosts and rejects Bun fatal banners even
when a child exits zero. The final installed resource matrix is validated after
this rebuild separately; no Apple or Windows execution is implied.

### 2026-09-11 UniFFI shared async owner and cancellation proof

The SDK now has a gated `mobile-bindings` entry for prepared native inputs that
opens the existing `EngineExecutor`; generated mobile calls no longer need the
prototype mutex or a second queue/runtime. Default `desktop` features retain
the existing Rust SDK behavior, while disabling defaults excludes broker,
server/process/socket modules and the broker dependency from mobile compilation.
The direct-only library passes Clippy and 95 owner/source tests; the default
desktop build with the mobile entry enabled passes 110 tests.

`mobile::Request` provides one-use request cancellation through that same owner.
Queued/active/finished authority prevents old or queued cancellation from
targeting later SQL. Dropping its admitted future cancels only that request;
abandoned queued requests are never executed. Existing ordinary Rust future
drop behavior is unchanged. Streaming reuses the existing callback/error and
ReadyForQuery recovery path. The focused owner test covers cancellation and
abandoned queued work without source/layout assertions.

Actual generated Swift 6 strict-concurrency and Kotlin/JNA consumers pass async
query, SQLSTATE, transaction, slow/rejected streaming with recovery, explicit
cancellation, backup and detach/reopen against ABI11. Real Swift Task.cancel and
Kotlin coroutine cancelAndJoin stop a 60-second sleep within three seconds,
preserve the subsequent request, and prevent a cancelled queued CREATE TABLE.
UniFFI 0.32.1 Swift does not propagate Task cancellation into Rust automatically:
the thin Swift facade must use withTaskCancellationHandler and the generated
request handle. Kotlin abandons the Rust future through its generated finally
path. No generated source is patched to obtain these results.

The generated consumer remains an ignored proof until private mobile Cargo
packaging, selected static extension registration, typed facade migration and
actual Android/Apple application gates are complete. Existing C/JNI bridges
remain; hosted Linux Swift/JNA execution is not mobile installation proof.

### Implementation checkpoint: TypeScript broker and native test ownership

- The TypeScript broker now uses PostgreSQL startup/password authentication,
  raw SQL/result frames, BackendKeyData and standard CancelRequest. Its separate
  PGOB management channel has only authentication, backup and terminal close;
  SQL/chunk/callback-abort/cancellation RPC variants were deleted.
- A callback failure drains every promised ReadyForQuery boundary and preserves
  the original callback error. Transport failure retires the handle. Concurrent
  socket writing/reading prevents large pipelined requests from deadlocking.
- `oliphaunt-js:test-native` and `bun run test-native` own the native SDK contract;
  the old examples-owned task/script and duplicate Deno entrypoint are removed.
  Moon builds the SDK/query, native runtime, broker and addon before this test;
  the shell recipe also runs against already built inputs. The same built SDK
  runs on Node, Bun and Deno in direct/broker modes, source/restored processes,
  with typed queries, backup/restore, persisted reopen and callback-abort recovery.
  The PostgreSQL driver checks server connections separately in that recipe.
- Linux verification: 69 SDK source tests, typecheck and lint pass; the complete
  SDK-owned native recipe passes all host/topology/restore combinations plus
  the server test. An earlier fresh packed-SDK resource matrix passed all 18
  host/topology/resource combinations; its teardown diagnostics led to a broker
  reset fix, so final packaged evidence must be refreshed after the daemon work.
- This checkpoint does not qualify Windows/macOS, unfinished partial-protocol
  disconnect handling, final carriers, or publication. Those remain explicit
  integration gates; no release or hosted workflow was dispatched.

### Native installed-consumer CI checkpoint (2026-09-11)

`oliphaunt-js:test-consumer` installs the packed SDK and query dependency in a
temporary consumer, extracts the Linux runtime/broker/addon candidates, and runs
the existing Node/Bun/Deno direct, broker and server behavior. The same archived
broker is exercised by `oliphaunt-broker:test-consumer`, including the ordinary
PostgreSQL client, incremental Flush/Sync, COPY, cancellation and disconnect
tests. Both owner tasks share the Linux `native-consumers` job and consume
downloaded producer outputs without recompiling native artifacts. The installed
SDK recipe and both broker protocol tests pass locally against ABI 11 artifacts.
The addon and broker owner packagers separately validate their corrected Rust
dependency notices, SPDX metadata and exact upstream source provenance; the last
notice-only refresh preserves the binaries exercised by these consumer tests.

Explicit platform requirements live on these consumer tasks. The planner derives
dependency-only producer host requirements from Moon edges; an SDK-only change
or SDK qualification needs Linux candidates, while directly selected native,
broker or addon producers retain their platform matrices. Consumers without an
explicit platform bound retain existing coverage. No source-path whitelist is
introduced. Hosted platform qualification and cross-commit native reuse remain
unproven. The TypeScript producer pilot uses Moon CAS with integrity verification
enabled and records actual task hashes and current uploaded artifact identity;
it does not bypass exact-source candidate checks.

### Swift binary producer handoff checkpoint (2026-09-11)

`oliphaunt-swift:package-bindings` runs on the macOS `swift-bindings` job with
the three Apple Rust targets installed. It uploads its XCFramework, canonical
checksums and generated bindings source. Linux `swift-sdk-package` downloads
these outputs and explicitly transfers that producer dependency before source
and release assembly. Swift's fixed public asset catalog now includes the
bindings ZIP and checksum manifest; publication freezes both from the SDK's
single `release-assets` directory. The 21 publication-lock tests pass, including
these asset identities. Actual XCFramework construction still requires macOS
qualification; Linux graph and publication tests do not prove Apple binaries.

### Final carrier and docs checks (2026-09-11)

- Native packaging now calls `liboliphaunt-native-bindings` directly. The public
  Rust SDK no longer exposes a private packaging feature/reexport bridge. All
  72 existing packaging tests and Clippy pass before the unused-tooling prune.
- Linux baseline command tests now run from Shell and do not duplicate pinned
  version strings. They exposed a broker output-path escape: canonicalization
  now precedes the target-directory guard and deletion. Parent traversal and
  symlink tests preserve an outside sentinel; bad image digests are rejected.
- Extension legal tests retain actual staged/archive byte, SPDX, and corruption
  checks; copied whole-catalog lists, fixed product counts and repository-layout
  assertions are removed. The remaining 11 legal behavior tests pass.
- The real WASIX contrib bundle packages all 32 members and passes the existing
  carrier validator. Its canonical tar excludes directory records; Cargo seed
  archives retain empty directories. This fixes the shared archive writer at
  the producer option without weakening either consumer contract.
- Final broker and addon archives include target-specific Rust notices and
  exact source-download links. Current broker legal tests pass; object key order
  is irrelevant, while missing/extra keys and altered legal bytes still fail.
- Docs check, production build, exported-site smoke and published-version/
  refresh-request tests pass from `docs`. Current guides use completed public
  releases. No Vercel deployment or production-settings change was performed.
- Swift/Kotlin public facade integration, React Native JSI ownership, remaining
  Shell test orchestration, and single-tree release PR preparation continue.
  Apple/Windows/device execution and the final exact-commit hosted qualification
  remain required; these local results do not close task 30.

### Deno shared-addon retest: task 09b remains blocked (2026-09-11)

The existing Deno FFI path was still selected during earlier installed-SDK
checks. Those results must not be described as Deno addon qualification.
With the current synchronous-cleanup Rust addon selected experimentally, the
complete native SDK source/restored recipe passes on Deno 2.8.1. The shipping
addon lifecycle harness nevertheless fails `worker-terminate-stream-delivery-wait`:
its process exits zero after `init`, `stream-started`, `stream-callback-blocked`,
without the required `stream-aborted` and terminal `close`. No timeout or missing
method assertion was substituted for that native cleanup observation.

The default keeps Deno FFI until this lifecycle case passes. Its old duplicate
Bun selection branch is removed. The existing lifecycle harness can now run
under Deno with its actual CLI flags and `parentPort.unref()` (Deno's Node port
has no `close()` method); it provides a repeatable migration diagnostic without
introducing a second suite or a knowingly failing supported-product CI gate.
See the [pinned Deno worker implementation](https://github.com/denoland/deno/blob/v2.8.1/ext/node/polyfills/worker_threads.ts).
Logs: `/tmp/deno-shared-addon-native-consumer.log` (ordinary behavior passes),
`/tmp/deno-current-addon-cleanup.log` (required cleanup fails). FFI source and
its existing behavioral tests remain; task 09b is not complete.

### 2026-09-11 production Swift/Kotlin shared bridge checkpoint (09d)

Swift and Kotlin now use private `sdks/rust/mobile-bindings` UniFFI bindings and
the existing Rust executor/session implementation. The old Swift C session bridge,
Kotlin JNI session bridge, and queue/cleanup-only tests are removed. Public query
and transaction APIs and resource preparation remain intact; this is an in-process
binding migration, not evidence of mobile process isolation. Request-scoped
cancellation drains started work, skips abandoned queued
work, and cannot cancel later requests. Transaction cleanup runs independently of
the canceled user request.

Linux proofs pass: 94 Swift source tests; Swift public native SQL, parameters,
SQL error recovery, callback identity, cancellation, canceled transaction rollback,
backup/restore; Kotlin public facade through generated JNI with SQL, cancellation,
transaction rollback, callback recovery and backup. Kotlin source tests and
Spotless pass with Gradle configuration cache. Both published Android ABIs compile;
actual Maven AAR/source/Javadoc carriers pass validation with their exact 61-crate
Rust license closure. Existing shipping Node/Bun addon lifecycle suites pass 60
cases each, including shared selected-extension registration and rejection before
initialization.

The Swift recipe builds three Apple static-library framework slices with the same
per-target Rust license closure, freezes their ZIP/checksum, and stages generated
Swift source in the SDK source carrier. The renderer validates these inventories.
A minimal C link anchor retains the runtime resolved dynamically by Rust; an
actual Linux `--as-needed` link/current-process lookup proves that mechanism.
Eleven focused Swift carrier tests pass.

Apple framework compilation and installed SwiftPM execution, and Android device
qualification, remain explicit platform gates. Linux proofs do not close them.
The existing language-side typed query implementations remain; this checkpoint
consolidates native execution and ownership, not every public facade operation.

### Task 27a/27b implementation checkpoint — one local release candidate

Release Please 17.3.0 is now a pinned private maintainer dependency. Its library
generates the candidate locally; the existing graph supplies shared shipped-source
ownership to its normal commit processing. Release Please alone chooses versions,
changelog entries and native ecosystem updates. The separate shared-contrib
candidate creator and handwritten bump/changelog engine have been removed.
Changelog dates use the exact source commit date through the library's template
option. Native updater composition and optional missing workspace lockfile
semantics are preserved; the existing derived closer owns compatibility fields
and real workspace lock regeneration.

`prepare-release-pr.sh` checks the existing merged-but-unpublished lifecycle and
creates local updates. `close-release-candidate.sh` closes derived metadata and
validates the complete tree before `.github/scripts/publish-release-pr.sh` writes
anything remotely. The publisher retains canonical PR identity, exact main SHA,
and lease checks. It reuses an unchanged candidate commit, reconciles an ambiguous
PR creation on retry, and refuses unrelated work on the reserved branch. There is
no intermediate generated PR head to trigger redundant qualification. A no-change
candidate skips Rust setup and publication. Publication remains the authority for
pending/tagged labels; preparation does not mark a release published.

Local evidence: three tests use the actual pinned Release Please implementation
for shared-source history boundaries, repeat output, and current Rust/npm/Swift/
Gradle updater inputs. A real disposable Git remote proves no-op SHA reuse,
ambiguous-create recovery, new-main updates and preservation of unrelated commits.
The full release source aggregate and frozen Bun install pass. These proofs do
not claim a hosted bot-token run, remote branch-protection behavior or completed
publication; those remain external qualification requirements.

### Resource and orchestration cleanup checkpoint — 2026-09-11

The database-resources product now owns one Shell test entrypoint. Its seed
tests and ICU archive/npm tests execute once; Shell runs packaging and the
actual Node CommonJS consumer, while Bun asserts receipt, data and descriptor
behavior. Repeated ICU packaging produces identical bytes, rejects empty or
symlinked source without replacing valid output, and supports a symlinked OS
temporary-directory alias. The redundant ICU-only Moon project is removed.

The packaging aggregate passes with Shell-owned command execution, including
actual Cargo archive consumers, native stripping and the Windows CRT fixture
closure. Release-intent ancestry tests now execute Git directly from Shell,
using isolated object storage; exact-parent and sibling-commit rejection pass.
No committed JavaScript or Python remains in the tracked source inventory;
generated consumer JavaScript remains an intentional build output.

Native packaging no longer depends on the public Rust SDK, generates unused
cluster seeds, supports unused broker/server packaging modes, or emits a legacy
runtime-owned ICU archive. Its real React Native ICU assembly and existing
mobile carrier finalizer pass. Mobile device/static-link proof and final iOS
resource consumer migration remain separate requirements, not inferred from
these Linux checks.

### 2026-09-11 WASIX final consumer input audit

Rust `test-aot` now depends on the separate extension and PostgreSQL tool AOT
producers it actually executes. Browser and Node SDK tests depend on extension
compiler outputs and read their manifest/archive paths from that owner, rather
than the core runtime output. Default SDK/runtime builds gain no optional payload.
CI transfers the same-run extension outputs, WASIX seed archives and ICU npm
carrier; local seed packaging reuses the frozen producers. The execution resolver
test covers these transitive transfers without inventing redundant direct edges.

Actual final-module proof passes: standard/ICU resource initialization, memory and
directory storage/reopen; three UUID-OSSP AOT direct/restart, dump/restore and
materialization cases; browser PostGIS worker, OPFS crash recovery and pgtap;
packed browser direct/worker/IndexedDB/transaction/resource selection; and the
fresh ABI 2 release addon's Node SDK actor/direct/worker/server, persistence,
backup/restore and corrupt-restore preservation. The shipping addon was rebuilt
through its Linux baseline producer, not substituted with a debug library.
Its complete installed-carrier matrix passes: Node/npm, Node/Bun, Bun, Deno and
Electron, including worker unload and actor/direct/server-wire round trips.
Nine resolver tests, three transfer tests, the full task graph and actionlint pass.

These runs first rejected stale seed/module hashes and old SDK notice bytes.
Regenerating only the resource and archive producers resolved both. Two obsolete
embedded-seed helper tests that failed the extension-feature build were removed;
explicit resource integration and existing atomic seed-publication tests retain
the corresponding behavior coverage.

### Tasks 05/24f/17 checkpoint — local commands and mobile resource boundary

The released SDK/resource/tools leaf commands were compared with their native
manifests and resolved Moon producers. The WASIX TypeScript tools facade now
builds and typechecks against the SDK's real declarations; two handwritten
declaration shims were deleted. Its `build` task depends on SDK compilation,
and `package` depends on that build instead of compiling inside its packaging
recipe. The actual six-task query → SDK → tools build/typecheck/test/package
closure passes without a PostgreSQL, Wasmer or addon build. Native tools `build`
now compiles both Rust and npm facades and records both outputs. Resource tests
have one owner, with the existing canonical contract test as a prerequisite;
the redundant ICU test-only Moon project was removed.

Maintainer instructions distinguish direct commands using prepared inputs from
Moon commands that build their dependencies. Kotlin AAR assembly remains runnable
on Linux with Android SDK/NDK, Java, Bun and the two declared Rust Android targets.
Swift source checks remain portable with Swift/Rust/Bun; Apple XCFramework
production and installed iOS/device execution still require their actual hosts.

The artifact inventory audit exposed retired native/WASIX ICU archives still
required by release and Swift/RN carrier code. Those expectations and the
runtime-owned ICU copy were removed; the canonical database-resources carrier
remains. Swift and RN base carriers now contain the native framework and runtime
resources only. The RN app-owned payload validates the seedless runtime target,
extension closure and legal bytes. Explicit `seedProfile` selects a separate
resource CocoaPod; ICU selects the separate `OliphauntICU` pod. Neither seed nor
ICU bytes are copied into the base payload, and omitting a seed profile does not
create a default seed dependency. The Swift initializer retains compatibility
validation of separately installed resources.

Evidence: actual RN archive/cache-tamper/malicious-ZIP/app-payload staging passes;
RN typecheck and source tests pass; the Swift owner packaging aggregate passes
its resolver/inventory scenarios and 19 tests; publication freezing passes all
21 tests with the seedless base carrier. These use real archive/filesystem
operations and synthetic Apple binaries, not an Apple link or installed-device
qualification. The latter remain explicit platform gates.

### Tasks 26–29 checkpoint — portable frozen-candidate assembly

The final caller audit found one compiler hidden inside candidate assembly:
broker Cargo payload packaging invoked `cargo package` for all four targets.
It now uses the same deterministic Cargo archive producer as the other binary
carriers. The two-phase Shell wrapper and its temporary plan were deleted.
The broker owner test still compiles each extracted, normalized carrier with
payload verification enabled and offline Cargo; parallel packaging also proves
identical bytes across independent staging directories and exact target notices.

Candidate preparation now runs on Linux without installing Rust, Apple or
Android build toolchains. Duplicate Bun/workspace setup and the obsolete macOS
toolchain configuration helper/test were removed. This job consumes qualified
outputs, assembles carriers and freezes the existing publication lock/capsule.
The publishing job retains macOS because it executes a real public Swift
consumer. Public-consumer compilation is distinct from rebuilding product bytes.

Qualification request/reuse remains bound to the exact source and covering
product evidence. Bootstrap remains conditional on missing initial registry
identities; recovery restores the original frozen capsule. Registry-race checks,
immutable version/byte reconciliation and controller trust checks remain at
publication. No hosted dispatch, registry mutation or platform qualification
was performed in this audit. Native cross-commit producer reuse and the final
hosted/platform proofs remain open rather than being inferred from source checks.

Validation: broker assembly succeeds with an empty executable search path and
Cargo home, all four extracted carriers compile offline, and ten owner tests
pass. The complete workflow aggregate passes, including 55 graph/selection
tests, transferred-dependency cases, actionlint and security checks.

### Tasks 05/24f checkpoint — transitive Cargo source hashes and local checks

Project dependencies alone did not invalidate native Rust SDK test caches. An
actual bindings-source comment left the SDK test hash unchanged at `6fdd17ff`
and reused cached results. The shared internal `cargo-sources` task now carries
hashes through native Moon dependency edges. SDK compiler/test tasks consume
that node and include the locally compiled `oliphaunt-build` helper. With the
fix, the same source-only change changed SDK test hash `0e50780e` to `bb3ec969`
and reran all 121 tests successfully. Probe comments were restored. Formatting
remains owner-local; CI uses deep downstream traversal for transitive consumers.
Existing affectedness observations cover the regression without a separate
hash engine.

Swift and Kotlin binding consumers depend on the same source hash, independently
of their generated-file preparation. A bindings-source edit changed the actual
Swift test hash and reran all 94 tests without building PostgreSQL. Formatting
and archive-only tests remain local. Mobile compilation/generation use Cargo's
incremental cache rather than claiming declarations alone restore native binaries.

Transferred-artifact jobs omit already produced dependencies. Moon also omits
their hashes with `--upstream none`, so those consumer invocations disable Moon
caching and execute against the downloaded bytes. Normal source checks retain
transitive caching. The CI adapter skips internal command-free hash nodes when
choosing explicit executable prerequisites; it preserves real producer edges.
Actual before/after probes and Shell handoff checks prove these distinctions.

Optional pre-commit hooks no longer run duplicate workspace/Tauri rustfmt checks
on unrelated TOML edits. Cheap file/security hooks remain, and the hook config
validates. Maintainer examples inspect affectedness and run explicit owner
tasks: query-only or wildcard Moon run commands do not safely express the
intended local selection. This checkpoint does not qualify Windows, Apple or
mobile artifacts.

### Query and extraction acceptance audit — 2026-09-11

Tasks 09 and 11 satisfy their extraction acceptance: the public native SDK,
broker and addon consume the shared native bindings without a public-SDK
backedge; lifecycle, cancellation, generation and persistence checks pass on
Linux. The separately packaged pgwire-server CLI accepts an ordinary sqlx
client, and six real socket startup, malformed-input, reconnect and shutdown
checks pass. These completed boundaries do not close the separate Windows,
Apple or mobile qualification tasks.

Tasks 07/08 have normal shared dependencies, packed consumer and transitive
affectedness evidence. A disposable reference comparison now also runs the
existing PostgreSQL behavior corpus against a separately started PostgreSQL 18
server through `pg` and the installed native TS SDK through its shared query
package. Six comparisons cover typed values, arrays/JSON, views and aggregates;
SQLSTATE 23505, recovery and transaction rollback agree. The same comparator
rejects an intentionally changed result (42 to 43), then accepts the original.
The same corpus now passes through the native Rust SDK and its shared query
crate against separately captured `pg` results from that PostgreSQL server.
Rust checks nullable/text and typed boolean/integer/float/Unicode decoding,
SQLSTATE 23505, recovery and callback-scoped transaction rollback. Its comparator
also rejects the deliberately changed integer, then accepts the unchanged
result. Both temporary harnesses live outside the repository; no source
perturbation or permanent mutation framework remains. Together with the existing
packed Rust/TS dependency closures and source-affectedness checks, this closes
07/08. It does not qualify platform-specific execution adapters or final mobile
artifacts.

Hosted Windows broker packaging exposed native child lookup selecting the WSL
launcher instead of Git Bash. The common Moon setup now publishes Git's real
`bin` path. Windows addon packaging separately exposed a missing app-local
VCRUNTIME DLL; its raw and npm carriers now stage the existing verified VC
closure before validation. Hosted rerun is required to qualify these fixes.
