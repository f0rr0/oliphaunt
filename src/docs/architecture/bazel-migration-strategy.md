# Native Bazel migration strategy

Status: migration in progress; the existing qualification and publication policy remains active.
Audited: 2026-10-11. Owner: repository maintainers.

This proposal replaces construction and qualification machinery with native
Bazel rules. It preserves independently versioned public products, conventional
consumer manifests, Release Please, and the frozen publication transaction.
The [current architecture](final-product-source-architecture.md) remains active
until the corresponding migration gates pass. The native foundation, query
packages and Linux PostgreSQL/extension construction now have executable
targets. Labels for the remaining products below describe the intended end
state.

The implementation imports existing product identities, versions and extension
ownership before Bazel analysis. Those metadata-only targets have no payload
dependencies. Rust and TypeScript query packages use native language rules and
bounded package writers. The PostgreSQL slice invokes generators, compilers and
linkers directly. The declared glibc 2.28 Linux profiles use the pinned Zig,
Perl, Bison and Flex toolchains; the ambient compiler profile remains a local
development lane.
Construction exports are marked `scope = construction`: they cannot authorize
publication, and unclassified changed inputs cannot mean unaffected. The
acceptance fixtures exercise actual native outputs and cached action reuse.
Active preparation still selects products through the existing ownership graph.
The ancestry repair makes its history exact; it does not make that graph a
precise description of delivered contents. Native release selection remains a
cutover gate.

Linux construction and local reproduction are the default. This preserves the
reason for the existing Linux-first design: maintainers must be able to reproduce
shared CI construction and failures locally using the same declared inputs,
platforms and commands. No remote executor is required or configured.
GitHub-hosted runners provide native host and SDK verification. A foreign target
does not by itself justify moving its construction off Linux; platform SDK
requirements and actual runtime execution determine the exceptions.
Full WASIX, mobile, macOS and Windows construction, final carrier coverage and
publication cutover remain migration gates. Moon and the current producer
engines remain in use for products whose replacements have not passed those
gates.

The audit baseline is main commit
`8316eb419999f47d6d4a61a8444e6c5ef32caf46`, tree
`91138aa6cc458471d81769e9d6543a1e3f99f0dc`. The workspace commit
`a43b10770ae0e843fe26b2dddc460c9db5cef981` has exactly that tree.
PR #294 is historical investigation context, not the authority for this plan.
The [coverage inventory](bazel-migration-inventory.md) enumerates every current
product, other project, workflow job, and CI-tagged root.

## Recommendation and the underlying problem

Use Bazel for source acquisition, configured construction, generation, package
assembly, deterministic checks, and build/test reuse. Remove Moon and the nested
producer engines after their replacements are proven. Keep parallel GitHub
Actions platform jobs, device operations, protected publication, and deployment.
Keep Release Please as the only semantic-version calculator and release-PR
writer. Keep Cargo/npm/Gradle/SwiftPM/CocoaPods contracts for installed consumers.

The underlying defect is the use of approximate project relationships as a
substitute for actual construction and delivery relationships. Directory
ownership, Moon dependency scopes, task ordering, Cargo source inference,
embedded-product lists, compatibility pins, job capability booleans, and copied
build trees each encode a partial answer. Release and CI adapters combine them
as if they described the same fact. They do not.

For example, changing a broker executable need not affect its mobile library;
a source SDK can retain its published runtime pin while tests exercise the new
workspace runtime; an unpublished browser host ships inside the WASIX TS SDK;
and an initialized seed depends on an executable producer without requiring
that producer's product to be published. These distinctions require explicit
construction, package, and installed-compatibility boundaries.

The correct simplification is one construction authority with typed projections.
It is not one universal dependency edge. Bazel does not infer independent
versions, semantic compatibility, completed publication, or approval. Those
facts retain their own authoritative declarations and are checked against the
constructed packages.

The final state has these non-negotiable properties:

1. Every generated file, object, library, transformed module, package tree, and
   archive has one producer and declared inputs/tools/configuration.
2. Production actions invoke compilers and bounded generators directly. They
   do not invoke Moon, Cargo build, Gradle assemble, SwiftPM build, Make, Meson,
   CMake, wasm-pack, or Docker scripts as another construction scheduler.
3. Tests consume production outputs; they do not become shipping dependencies
   merely because they run before publication.
4. Shipping roots describe actual delivered contents, including source packages,
   generated carrier sources, manifests, resources, and legal files.
5. Installed requirements remain conventional and agree with actual loaded or
   incorporated runtime identities. Workspace overrides are separate tests.
6. Every release has an explicit completed baseline, bounded intent, reason for
   selection, supported target coverage, immutable outputs, and consumer proof.
7. Publication and recovery upload qualified frozen bytes. They never rebuild.

An upstream compiler, Next's framework compilation, a pinned Perl/Bison
generator, or `xcodebuild -create-xcframework` operating on completed slices can
be a bounded action. Wrapping an existing whole-product builder is a temporary
comparison harness, not this end state. Installed-consumer tests deliberately
use conventional build tools because those tools are the customer interface.

## What was evaluated

The resolved inventory contains 27 release products, 29 other Moon projects,
407 resolved task entries, and 265 declared registry identities: 121 Cargo,
119 npm, and 25 Maven. There are 39 tracked Cargo manifests, 44 npm manifests,
three Swift manifests, and Android/Kotlin/React Native build integration.
The eight workflows declare 83 jobs before matrix expansion, including 64 CI
jobs and ten release jobs; there are 15 composite actions.

The 265 identities are a minimum catalog, not the final artifact count. Generated
Cargo payload parts, GitHub archives, and Swift source tags add outputs. The
publication lock must enumerate the actual set. There are 32 contrib extensions
and seven external extensions. Private producer roots, generated carriers
without `src/`, examples, performance tools, docs, and recovery paths are in
scope.

Source findings explain why changing the scheduler alone is insufficient:

| Current mechanism | Concrete gap | Required correction |
| --- | --- | --- |
| `tools/release/release-graph.mts`, `releaseProductsForSourceProjects` and `buildPlan` | Reverse generic non-development project edges and first release boundaries approximate shipping ownership; blanket Markdown exclusions can exclude delivered legal/content changes | Derive impact from configured shipping outputs and their production inputs; classify verification and release projections structurally |
| `tools/release/prepare-release-candidate.mts`, `includeOwnedSourceCommits` | Starts with already path-filtered commits, then adds observed ownership; old entries are not inherently bounded by the completed product boundary | Start with a complete verified history and an empty per-product selection; require every boundary to be reached |
| `with-product-history.sh` versus Release Please history | Git tags and GitHub release discovery can disagree about the last completed delivery | One completed-publication snapshot shared by preparation and admission |
| `tools/ci/ci_plan.mts` and `.github/scripts/*moon*` | Reconstruct closures, setup capability propagation, target grouping, and execution batches outside the task engine | Bazel handles dependencies and execution; a thin scheduler partitions explicit roots/configurations into GitHub jobs |
| `run-planned-moon-job.sh` | Transferred output trees lead to disabled cache/prerequisite traversal | Remove construction transfers and satisfaction overrides; request the complete Bazel closure |
| Persistent exact-extension Android/iOS builders | Source invalidation clears the PG build directory while dependency archives survive; OpenSSL/PostGIS helpers can return on archive/header presence. This finding does not establish stale extension-free base CI | Native dependency actions keyed by actual source/tools/flags; remove readiness-based reuse |
| Native desktop dependency selection | Host OpenSSL/Homebrew/PostGIS libraries and ambient generator executables influence production | Pinned repositories/toolchains and explicit parity qualification of changed dependency selection |
| WASIX initdb/frontends | Mutable common/port archives are rebuilt with different frontend/backend flags | Separate configured libraries and outputs |
| Rust SDK extension-runtime exemption | Metadata exemption conflicts with the actual loaded-runtime equality contract | Resolve the contract and test the real installed SDK plus extension; do not preserve the exemption blindly |
| Frozen-consumer workflow conditional | A skipped optional ancestor can suppress a dependent job without explicit status handling | Credential-free hosted topology test and strict expected-proof gate |

These are source-grounded findings from the audit baseline. The implementation
now builds and tests the bounded Linux PostgreSQL/ICU/extension slice described
above. It does not establish that a particular Bazel/rules combination works on
every platform; remaining native source/generator inventories are migration
gates.

## Authority and file disposition

| Existing authority or machinery | Final disposition |
| --- | --- |
| `.moon/`, project `moon.yml`, Moon/Proto orchestration | Remove after all construction/check/dev surfaces have replacements |
| Source-local build definitions | Add `BUILD.bazel` beside their source owners; standard language providers describe compilation/linking |
| Tool/bootstrap pins and immutable `source.toml` files | Retain one pin authority; import through Bzlmod repository/module extensions and registered toolchains |
| `release-please-config.json`, `.release-please-manifest.json`, product version mirrors | Retain Release Please policy; validate deterministic conventional mirrors |
| Product `release.toml` | Retain irreducible authored product membership/version ownership, upstream and public support/recipe facts. Import canonical public names into construction; derive carrier/target inventories from actual shipping exports. Keep generated projections where consumers need them; remove competing authored inventories and inferred shared-source/embedded-construction arrays after native replacement |
| Extension catalog, recipes, component and target contracts | Retain SQL identities, support, ABI, resources, and legal facts; replace producer-kind dispatch with native targets and check agreement |
| Cargo/npm/Gradle/Swift/podspec manifests and downstream build scripts | Retain installed contracts; import or validate overlapping facts rather than authoring two dependency resolutions |
| `tools/release/release-graph.mts`, `release_plan.mts` | Split retained metadata/history/admission readers from obsolete Moon/path/Cargo construction inference; consume Bazel exports |
| `prepare-release-candidate.mts`, `release-dependency-plan.mts`, `default-extension-release-plan.mts`, `consumer-compatibility.mts` | One bounded Release Please adapter and explicit supported-recipe/adoption policy; remove overlapping cascades and bump monkey-patches |
| `sync-release-pr.mts`, `verify-release-commit.mts`, metadata checks | Retain deterministic projection/admission, with independent manifest/history/output oracles and fixed-point checks |
| `package-release-carriers.{mts,sh}` | Remove central product build dispatch; selected shipping labels construct outputs |
| `tools/packaging/` and product assembly algorithms | Retain useful TS/Rust format, split, legal, ABI, checksum, and safety logic as declared leaf tools; remove ambient discovery and internal caches |
| Native/WASIX broad shell producers and stamp caches | Remove production bodies after source-native compiler/generator/link actions pass parity gates |
| `publication-catalog.mts`, `release-artifact-targets.mts` | Retain normalization/strict ownership contracts; replace Moon scans and independently authored target matrices with configured product exports |
| `publication-lock.mts`, capsule, lifecycle, frozen publishers, controller | Retain immutable identities, exhaustive discovery, exact-source admission, recovery, and reconciliation; adapt output paths/evidence |
| GitHub Actions | Retain event identity, runner allocation, device setup, approvals, credentials, immutable evidence transport, and external mutations |
| Docs/examples/performance/developer scripts | Native build/check/run targets; network, live deployment, device control, and measurements remain explicit operations |

Delete `.github/scripts/moon-task-capabilities.mts`,
`select-moon-target-groups.mts`, `select-planned-moon-targets.mts`,
`resolve-planned-moon-execution.mts`, `write-affected-moon-target-matrices.*`,
`run-moon-targets.sh`, and `run-planned-moon-job.sh` after their guarantees have
native owners. Remove `tools/ci/affected.mts`, Moon snapshot/context/observation
adapters, `setup-moon`, Moon-only tool pins, construction output-tree transfers,
and their obsolete implementation-shape tests. Preserve behavioral guarantees
through real graph/action/consumer tests before deleting the old tests.

Do not delete multifunction release modules wholesale. Historical compatibility
readers, frozen-byte validators, source/tag guards, and publication receipts are
valuable; project inference and construction dispatch are the replaceable parts.
Recovery needs a bounded reader for old approved capsules until their supported
recovery window closes.

## Native construction model

### Targets and outputs

Keep source navigation intact. Use source-local labels such as:

```text
//src/query/rust:query
//src/query/rust:source_package
//src/native/broker:broker_lib
//src/native/broker:broker
//src/native/runtime:liboliphaunt
//src/native/runtime:runtime_archive
//src/extensions/external/postgis:embedded_module
//src/extensions/external/postgis:static_archive
//src/wasix/runtime:portable_archive
//src/wasix/runtime:runtime_aot
//src/native/sdks/swift:release_source_tree
```

The `BUILD.bazel` graph owns actual compilation, generator, link, embed, resource,
and packaging prerequisites. A product shipping root exports its product ID,
supported configurations, carrier roles, exact outputs, and applicable package
contracts. Use standard `CcInfo`, Rust, JS, JVM, and Swift providers first. Add
small providers only for missing domain facts such as a Wasm module/interface,
AOT descriptor, resource/seed identity, or publication envelope.

A provider/aspect exports these declarations for the release adapter and CI
scheduler. It must not become another handwritten graph. Its production view
starts from actual shipping files and producer actions, excluding independent
test/validation outputs. Tools that produce shipping bytes are included; a
validator does not become a shipping input merely because it inspects them.
`cquery deps(...)` alone is too broad for this distinction.

Rules own declared immutable outputs. Replace in-place finalizers with assembly
from the payload plus ABI/license/descriptor inputs into a new output. An action
must not rewrite another action's output, mutate source files, find a sibling
`target/` tree, or decide reuse from a private stamp. Archive creators consume
explicit mappings; package validators independently inspect their result.
[Bazel rules and providers](https://bazel.build/extending/rules) supply these
mechanisms, not the Oliphaunt-specific declarations.

Do not add a generic artifact framework, custom cache, universal dependency DSL,
or one Bazel module per release product. One repository module can contain many
independently versioned products. Bzlmod resolves build dependencies; it is not
an installed-package SemVer compatibility engine.
[Bzlmod resolution](https://bazel.build/external/module).

### Where dependencies and version ownership come from

Every relationship has a declared meaning and one authoritative source. Bazel
does not infer release version equality from compilation dependencies.

| Fact | Authority and how the system uses it |
| --- | --- |
| Uses source, a library, generator, tool or resource to construct output | Native target/action inputs and language providers. Import actual conventional dependency declarations where appropriate; explicitly declare C/PG sources and generators. Derived configured production exports explain rebuild and delivery impact |
| A carrier takes a product's publication version | Product/carrier ownership metadata, imported into shipping rules. A carrier's version is rendered from its owner's selected version, never independently bumped |
| An installed package accepts a dependency version | Cargo/npm/POM/Swift/podspec requirements; extension ABI/host/support facts retain their explicit descriptor where these formats cannot express them. Rendered and packed manifests must agree |
| A test observes a product | Test inputs/runfiles and supported configurations. This requests verification, not shared versioning or release ownership |

For contrib, the existing authoritative declaration is
[`src/extensions/contrib/carriers.toml`](../../extensions/contrib/carriers.toml):

```toml
native_owner = "liboliphaunt-native"
wasix_owner = "liboliphaunt-wasix"
```

Keep/import that declaration rather than duplicating those IDs in BUILD rules
and release scripts. TOML is the existing compact authority, not a Bazel
requirement: ownership solely in BUILD would also be valid if the old authored
copy were removed. Choose one location per fact. Public naming/support policy
can remain explicit, but configured carrier inventories must be derived from
the actual package targets rather than separately maintained in release scripts.
Successful compilation does not establish a public support promise.

Generated snapshots may repeat facts for consumers; they must be one-way and
must not become an independent selection authority. For example, external
extension `registry_packages`/`publish_targets` arrays are already regenerated
by `sync-release-pr.mts`; their presence alone is not evidence of competing
authored inventories. Change their producer to consume native exports where
appropriate, rather than deleting required public/recovery metadata blindly.

Expose owner identity/version as data or a metadata-only target with no payload
dependencies. A carrier must not point back to the shipping aggregate that
contains it: that would create a target cycle. Construction flows from identity
and payload inputs to carriers, then to the product aggregate. Production uses
only relevant product versions, avoiding global version-manifest invalidation.

Ordinary Starlark rule analysis cannot read TOML file contents. The metadata
import must be tracked repository/module evaluation or a checked generated
projection available before analysis, with one-way provenance to its authored
source. A build action cannot generate a `.bzl` file and load it during that same
analysis. The foundation gate must prove owner/version edits propagate and
unrelated product edits leave production reusable; this is implementation work,
not an implied automatic import.
[Rule analysis and file inputs](https://bazel.build/extending/rules).

Native contrib envelopes take the native runtime owner's
version; WASIX envelopes take the WASIX runtime owner's version. Those two
products remain independently versioned. There is no third contrib release
version or a release product per SQL member. PostgreSQL's upstream version and
each SQL extension's control-file version are separate identities; for example,
`pg_trgm`'s SQL version is not its carrier's publication version.

The actual contrib modules, SQL/control files and legal contents are explicit
package inputs. A changed member selects each runtime owner whose supported
shipping closure includes that change, measured against that owner's completed
baseline. Its envelopes receive that owner's candidate version. A runtime
release renders its owned contrib carrier versions even when the member bytes
are unchanged; shared source alone never couples the native/WASIX bump numbers.

External extensions instead own independent release products. Their declared
runtime host requirement is compatibility, not version equality. An SDK's
installed historical pin is also distinct from its checkout build dependency.
Mandatory adoption follows explicit public-support/default-install policy and
actual requirements; it cannot be inferred from every Bazel reverse dependency.

The thin release adapter consumes derived construction facts plus these explicit
ownership/support facts. Require one release owner per publication identity,
valid referenced products, correct owner-derived carrier versions, and actual
packed requirements matching the claimed compatibility. Reject missing or
conflicting ownership rather than guess from names or paths. A small independent
scenario must cover distinct native/WASIX versions, a contrib-only change, an
external-only change and an unchanged historical SDK pin. These refine the
existing coverage/selection fixtures; they do not introduce another graph DSL.

Runtime-owned contrib is appropriate for the current distribution contract.
Giving contrib independent versions would be a deliberate product change with
its own host/support/adoption policy. Do not introduce another release component
merely to reuse a version-group plugin. Release Please's
[linked-versions plugin](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md#linked-versions)
can synchronize genuinely separate components; these carriers already inherit
one owner's selected version and need no additional version calculation.

### Platforms, tools, and reproducibility

Introduce pinned `.bazelversion`, `MODULE.bazel` and its lock,
`.bazelrc`, `build/platforms`, `build/toolchains`, and a small `tools/bazel`
integration area. Verify the Bazel bootstrap itself. Pins in existing TOMLs
should feed repository registration instead of being copied into workflows,
BUILD attributes, and shell installers.

Separate target platform from execution platform. Desktop outputs cover Linux
x64/arm64 GNU, macOS arm64, and Windows x64 MSVC. Android covers arm64-v8a and
x86_64. Apple aggregates macOS/device/simulator slices. Portable WASIX, browser
Wasm, AOT host triples, and mobile seed compatibility domains are distinct.
`ios-xcframework` and `ios-datum64` are not CPU architectures.

Toolchain identity includes compiler/linker/archiver, sysroot/SDK, target API or
deployment floor, CRT/C++ runtime, CPU baseline, feature flags, generators, and
output-affecting environment. Xcode and Windows SDKs remain licensed host
facilities, but their exact observed identities must enter registered build
configuration and cache identity. An ambient PATH/Homebrew lookup is not a
production contract. Sandbox/offline builds, changed-tool probes, and clean
execution are necessary evidence of input completeness.
[Hermeticity](https://bazel.build/basics/hermeticity),
[platforms](https://bazel.build/concepts/platforms), and
[toolchains](https://bazel.build/extending/toolchains).

Preserve safe extraction, bounded transport, checksums, notices, platform binary
baselines, ABI/export/import checks, relocation, empty directories, and archive
limits. Declared input symlinks in Bazel's execroot/runfiles are legitimate;
existing blanket symlink rejection must distinguish them from unsafe symlinks
inside delivered archives. Reuse format/security algorithms with explicit
materialization or validated input mappings.

Require repeatable bytes for cacheable production actions under the same
declared configuration, including compiled payloads and package encoding.
Normalize output-affecting time, randomness, paths, locale and linker metadata
explicitly; different platform/toolchain configurations can legitimately differ.
Native `initdb` can introduce changing PGDATA/system-identifier bytes; archive
normalization does not fix that. Investigate and prove deterministic seed
generation, with an explicit initialization time/randomness/identifier policy
and any necessary source changes qualified through actual open/reopen/restore
consumers. Do not patch control/WAL bytes without preserving their consistency.
During transition, qualify and freeze the original produced seed honestly;
unresolved repeatability prevents declaring the ideal migration complete.

### Native PostgreSQL, libraries, extensions, and seeds

The main effort is a native build-description port, not installing Bazel:

| Construction family | Required native boundary and acceptance |
| --- | --- |
| PostgreSQL source/configuration | Acquire the exact PG pin and ordered semantic patches. Inventory every source, platform replacement, config header, catalog/BKI, nodes/fmgr/errors/lwlocks/wait-events, grammar/scanner, probe, timezone and support-data generator. Generate named outputs using pinned tools |
| Ordinary versus embedded PG | Separate standalone backend/frontends/libpq/tools from embedded backend/common/port/timezone/JIT stubs. Preserve distinct definitions, provider imports, exports, signal/IPC semantics, and Windows import libraries |
| Oliphaunt C runtime | Compile wrapper units and shared/mobile links directly. The actual embedded version literal is an input to its C unit; a version update need not recompile every PG unit |
| Contrib and external extensions | Per-member server/embedded/static/SQL targets. Contrib has runtime release owners, not a new independent product. Preserve optional-extension-clean base runtime, registration aliases, preload/lifecycle and target restrictions |
| PostgreSQL tools | Native product owns pg_dump, pg_basebackup and psql. Build requested frontend closures without a required embedded-runtime link. WASIX tool product owns pg_dump and psql |
| ICU | Separate common/i18n/stubdata libraries from canonical ICU data. Inspect which host generators are actually needed; do not rebuild a discarded data-generation pipeline. Existing pinned Windows ICU binaries can be declared external imports until an intentional source port is qualified |
| OpenSSL/PostGIS dependencies | Source-native crypto, GEOS, PROJ, SQLite, JSON-C, libxml2 and Android libiconv. Qualify replacing desktop host libraries with pinned sources. PROJ needs a target SQLite library and a separate execution SQLite tool; database embedding affects compilation |
| PostGIS | Explicit config/parser/geometry/FlatGeobuf/SQL/resource actions, disabled-feature profile, provider-specific modules and prefixed mobile archives. Keep SQL generation prerequisites even where the corresponding optional module is excluded |
| Mobile extension libraries | Compile selected registry C and whole-archive selected extensions/dependencies into the Android library; preserve C++ linkage and 16KB alignment. Apple XCFrameworks consume exact configured slices |
| Resources/seeds | Canonical ICU extraction is independent of PG compilation. Seed generation consumes actual initdb/runtime/share-data launch closure. Android/iOS datum64 producer domains require ABI receipts; do not run target phone binaries on the build host |
| Broker | Distinct Rust library and executable targets. Preserve its Linux minimum-host loader/argument probe through declared Rust/linker/sysroot baseline inputs before deleting the Docker/Cargo producer. Runtime loading/fixtures belong to applicable consumer tests; a main.rs change must not reach library-only mobile consumers |

Remove Make/Meson/CMake/nmake/PGXS producer authority, fake pg_config/config
discovery, archive/object scanning to recover source inventories, source-tree
mutation, depth-limited fingerprints, readiness shortcuts, and ccache layers.
Retain semantic source patches and output checks. Build-system-only patches
become native flags/provider relationships when their foreign engine disappears.
Source inventories for pinned upstream libraries must be inspected and reviewed;
this audit cannot honestly predeclare absent upstream generator files.

### WASIX, AOT, browser host, and postmaster

Preserve three distinct Wasmer contexts: single-backend/AOT 7.2.1/0.702.1,
browser 6.1/0.601 with its backports, and patched postmaster
7.2.0-alpha.2/0.702.0-alpha.2. Do not unify their Cargo locks/features or
serialization contracts.

Portable construction must expose separate backend/frontend common/port, shims,
support modules, initdb, tool links, runtime data, strict main links and Binaryen
transforms. Tools retain their frontend optimization/import-closure profile.
AOT is one transform per module/configuration, with the exact serializer/LLVM,
host triple, CPU baseline, exception/features and options recorded. Runtime,
tools and extensions can share the serializer without sharing release ownership.

The runtime's required exports are derived from compiled side-module imports.
The acyclic native order is side modules plus configured headers, then canonical
required-export list, then strict main link and closure validation. A changed
extension can require compilation to prove its import interface is unchanged;
if the emitted list is identical, Bazel can avoid a runtime relink. Static
reachability cannot predict that value. Release treatment is addressed below.

Postmaster remains a separate product. Port its patched libc variants/sysroots,
native Rust compiler/executor feature split, core and 27 side modules,
export sealing, Binaryen pass, final export/start/atomic validation, then
linear-memory sealing, then per-module AOT, then the 29-module compiler-free
carrier. Preserve the memory/ABI/concurrency policies and final receipts; do
not serialize an earlier unsealed module or ship the compiler feature union.
Native clients used by regression tests are their own build prerequisites.

The browser host becomes native Rust Wasm compilation, matching wasm-bindgen,
Binaryen, and Rollup actions with separately resolved patched Cargo/npm inputs.
Its JS/Worker/Wasm/provenance outputs ship in `oliphaunt-wasix-ts`; the private
host has no new product version. Replace wasm-pack orchestration while preserving
its actual transform behavior.

WASIX N-API explicitly incorporates SDK/server source and runtime/tools/resource
payloads. Native direct N-API loads the native runtime separately. These are
different release-impact contracts. Preserve the WASIX addon glibc baseline by
a pinned execution sysroot/image and binary checks before deleting its Docker
build wrapper.

### SDKs, source packages, applications, docs, and tools

Use `rules_rust` and Cargo-lock import contexts for dependencies, with explicit
first-party library/binary/features/build-script data. Compilers run directly;
published Cargo build helpers and build.rs remain downstream functionality.
Source-package roots contain source/legal/generated files and normalized
manifests, not checkout rlibs or freshly built dependencies that are not shipped.
[Cargo import](https://bazelbuild.github.io/rules_rust/crate_universe_bzlmod.html)
and [build-script integration](https://bazelbuild.github.io/rules_rust/cargo_build_script.html).

Audit imported build.rs behavior too, particularly native compression and
Wasmer/LLVM dependencies. Pure cfg/metadata/code generation can remain a declared
leaf. A build script that compiles an opaque native library, launches a foreign
producer, or downloads assets must instead consume declared native library/tool
providers, with appropriate import annotations or reviewed BUILD overlays.
Cargo-lock import alone does not prove that third-party construction is native
or hermetic; this is part of the acquired-source/toolchain acceptance inventory.

Use mature `rules_js`/`rules_ts`, pinned Node, and one pnpm resolution for the
internal npm graph. Migrate the root Bun lock without dependency upgrades:
compare versions/integrities, peers, optional/platform dependencies, catalogs,
overrides and native lifecycle outputs. Do not maintain two root resolutions
indefinitely or assume rules_js imports bun.lock. Keep pinned Bun as an explicit
tool/test runtime for existing Bun APIs and supported consumer tests; authored
scripting stays TypeScript. Isolated consumer locks can legitimately remain.
Keep docs' separately resolved TypeScript where required.
[rules_js design](https://github.com/aspect-build/rules_js).

TypeScript package actions preserve ESM/CJS/declarations, nested module markers,
conditional exports and emitted consumer tools. Select typechecking explicitly
when emit rules permit split validation; do not pay for duplicate full tsc runs.
Use declared esbuild/Rollup/Bun compiler actions only with their real input sets.

UniFFI generation is a declared execution tool using exact library/configured
metadata. Share compatible generation across Swift/Kotlin without merging their
platform binaries or public versions. Kotlin requires Android/JNI/AIDL/resource
compilation plus the exact AAR/plugin/marker/POM/source/javadoc/module envelope;
JVM export rules alone do not implement it. Its currently expected ten primary
publication files are Android AAR/POM/sources JAR/javadoc JAR, plugin
JAR/POM/module/sources JAR/javadoc JAR, and marker POM. Only the plugin publishes
module metadata: Android module metadata would redirect to an unpublished root.
Preserve Android-only public coordinates; do not invent JVM/KMP publications.
Signatures are handled by publication.

Swift uses native Swift/C/Rust targets and Apple archive rules; assembly and
consumer checks run on macOS. Render the public Package.swift/source tag and
binary URL/checksum closure from final outputs. Development `.build` paths and
unsafe local links must not appear in that public tree.
Preserve the empty default extension set, separately owned opt-in extension
carriers, and frozen extension-generator/catalog inputs in the release tree.

RN needs explicit TS/spec/codegen/JSI/Objective-C++/Swift/Kotlin/JNI targets and
the declared Android mobile extension library. Its npm package still ships
Gradle/CMake/podspec/codegen/templates because consumers use them. Run installed
RN/Expo builds to prove those public entrypoints. Internal Bazel app compilation
alone is not that proof.
[Kotlin](https://github.com/bazel-contrib/rules_kotlin),
[Android](https://github.com/bazelbuild/rules_android),
[Swift](https://github.com/bazelbuild/rules_swift),
[Apple](https://github.com/bazelbuild/rules_apple), and
[RN codegen](https://reactnative.dev/docs/turbo-native-modules-introduction).

All six example surfaces remain: native/WASIX Electron and Tauri, WASIX browser,
and native Expo Android/iOS. Separate native application construction from
installed-ecosystem integration tests. Preserve Tauri build context, Electron
sidecars, workers, serving headers, supported topologies and extension profiles.
GUI/device launching is an operation, not a hidden compiler fallback.

Docs becomes declared content/catalog/MDX/Next/static-export/smoke targets.
Completed-release data is acquired outside construction and passed as a frozen
input; ordinary builds must not read live release state invisibly. Deployment
hook/live verification remain separate operations. Docs does not recommend
package versions. Benchmarks retain declared runners/fixtures and plan tests;
measurements run uncached with host metadata. Formatting, hooks, acquisition
tests, security checks and developer commands get explicit targets; remove
obsolete bootstrap duplication when their consumers have migrated.

## Affectedness, execution, and release selection

| Question | Deterministic answer |
| --- | --- |
| What might be affected? | Old and new configured construction relationships identify potential impact, including removed edges/files |
| What is requested? | CI/release selects explicit product/test roots and supported configurations |
| What must build now? | Bazel executes demanded invalid actions and materializes valid cached outputs; affectedness is not an instruction to rerun everything |
| What must be checked? | Required semantic tests/validators, reusing trusted results for identical complete inputs; fresh observations where external state or current execution is part of the claim |
| What needs publication? | Delivery changes since that product's completed publication, plus required explicit compatibility adoption or deliberate release intent |
| What version? | Release Please applies bounded Conventional Commit and public-support intent to the published version |

A product needing no release may still be a build prerequisite or test subject.
A product needing no new compilation may need new package assembly, manifest
validation, installed-consumer proof, or publication. A docs-only change can
need a docs build/check while selecting zero package releases.

Start CI with bounded platform cohorts and native cache reuse. Add job-elision
only where measured startup/download cost justifies it. If retained, root
selection uses both old and new configured graphs, including deleted/renamed
inputs, BUILD/Starlark changes, toolchain/config changes and removed support.
Unknown analysis widens checks or fails required admission; it never silently
means unaffected. Loading-phase query is conservative; cquery evaluates selected
configuration; aquery exposes declared actions. An aquery ActionKey is not the
content-based remote cache identity or a package compatibility proof.
[cquery](https://bazel.build/query/cquery),
[aquery](https://bazel.build/query/aquery).

### Concrete release decision

Adopt a conservative, explicit delivery rule: an authored change to actual
shipping source, source pins, rules, used toolchains, resources, manifests,
supported targets, packaging writers, or legal inputs since the product's last
completed publication selects its shipping owner. Verification-only inputs
outside those roots do not. An unclassified delivery change receives patch
intent through the same Release Please strategy; authored feature/breaking
intent can require more. Removed public exact-host support contributes breaking
intent. Do not silently skip delivery changes because their commit says chore.

This is minimal with respect to the declared delivery/support contract, not a
universal semantic-equivalence test. A changed compiler recipe can warrant a
release even if a particular build happens to emit identical bytes. Narrow
construction-only migration parity and derived-interface exceptions require
explicit policy and independent evidence. There is no generic tooling bypass.

For a derived interface such as required WASIX exports, declare the contract
boundary in the native provider: runtime linking consumes that interface, not
external-extension implementation semantics. To exclude the runtime from a
release, compare the newly emitted interface to the actual completed baseline,
verify its contract, and establish that no other runtime delivery input changed.
Admit this exclusion only for version-independent canonical contract outputs
under matching contract configurations and generator/tool identities. Retain
the scope receipt and revalidate it against the final production interface;
candidate-version-bearing output cannot justify pre-assignment exclusion.
The changed external extension still releases. Runtime-owned contrib payloads
are shipping runtime inputs and do not qualify for that exclusion. Missing
baseline interface evidence means conservative selection. This exception can
require building the changed module; no static no-build guarantee is possible.

Do not use final version-bearing package bytes to seed release decisions.
Select authored changes before the generated bump. Recognize only validated
structural Release Please projections when excluding generated version/changelog
updates from later intent; do not ignore entire Cargo/package/version files.
Actual version and requirement changes remain inputs to final package actions.
Net source changes that cancel exactly at the declared input level need not
select a new delivery merely because an old feature commit appears in history.

### Baselines and Release Please integration

Preparation follows this sequence:

1. Freeze main source SHA/tree and the completed-publication snapshot. Per product
   record version, original source, actual immutable manifest requirements and
   lock/receipt identity. Drafts, tags alone, merged PRs and partial publication
   are not completion. Preserve the unresolved merged-release guard.
2. Load complete history before product filtering, to the oldest required
   boundary, and verify every boundary was reached. History/page limits are
   errors. A release commit outside a product directory still ends its history.
3. Compare each product's own old/new configured shipping production inputs,
   including removed dependencies and action-producing tools. Retain changed
   input, root/configuration, baseline and dependency-path witnesses. This is
   a graph export and diff, not another build/cache hash engine.
4. Select direct delivery intents, then close mandatory compatibility adoption
   from real manifests, incorporated-source facts and declared supported recipes.
   Recompute Release Please strategies from the same published versions and
   accumulated intents to a monotonic selection fixed point; never bump an
   already bumped candidate again on each iteration.
5. Render conventional versions/requirements/carrier metadata/locks. A second
   run must change nothing. Before updating the release branch, independently
   check rendered/normalized manifest semantics, allowed projection fields,
   baseline witnesses and excluded products. Actual archive/packed-manifest
   validation runs after final native assembly, before freeze/publication; this
   does not add a full platform package pass before creating the PR.

Capture configured production facts at completed publication and reuse that
immutable baseline. Analyze/export once per distinct source/configuration, not
once per carrier or product sharing that source. Cache the read-only derived
analysis by its exact inputs; it must not grow a second action cache. Preparation
normally needs head analysis and saved completed facts, with historical analysis
only for the bridge or missing legacy evidence.

Use one typed adapter around Release Please's versioned APIs/plugin hooks.
Remove automatic cross-product `node-workspace` propagation, global Rust
workspace intent and private version-strategy monkey-patches once explicit
adoption covers their intended guarantees. Keep ecosystem version updaters and
the deliberate shared product containing `oliphaunt` and `oliphaunt-build`.
If the pinned library lacks a clean hook for the frozen bounded context, obtain
that narrow capability before cutover; do not preserve an unverified fallback.
[Release Please manifest mode](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md).

Historical publications predate Bazel BUILD files. Running today's rules at an
old source SHA does not reconstruct its old production graph. Before switching
selection, establish an audited baseline per product from actual published
source/artifacts/recipes, with an explicit mapping to native roots. A read-only
legacy baseline adapter can exist during this bridge; missing facts fail or
widen review. Do not substitute an empty old graph or stamp today's closure as
historical truth. Retire the adapter for each product after its first completed
native publication carries native facts. Migration parity can avoid gratuitous
bulk bumps; behavior-changing ports require justified delivery releases.

### Independent versions and installed compatibility

A compiled binary that incorporates changed source/payload is a delivery
dependent. A source package referencing an immutable historical product is an
installed dependent: that requirement can remain unless adoption is required.
The Bazel checkout compile edge does not automatically rewrite its public pin.
Shipping configurations use declared/adopted candidate identities or verified
historical artifacts; current workspace bytes cannot be labeled as an older pin.

Keep source/candidate compatibility tests and final installed-package tests
separate. The latter use final normalized Cargo/npm/POM/Swift/RN requirements,
supported features/targets and the runtime the consumer actually loads. Include
default SDK plus external/contrib extension recipes, standard/ICU, tools,
direct/broker/server/browser and mobile surfaces where supported. Resolve the
Rust SDK equality/exemption gap before claiming the policy coherent.

An extension's exact runtime promise remains exact until a versioned ABI/support
contract and actual consumer matrix justify a broader range. Independent SemVer
numbers, identical PG majors, or successful source compilation do not prove
compatibility. Conversely, a producer release alone is not a reason to update
every compatible historical consumer.

## GitHub Actions and execution infrastructure

Keep multiple jobs/invocations. The thin TS plan contains source/request identity,
explicit `(root, configuration)` requirements, compatible runner cohorts,
expected outputs, and required external proof cases. It does not topologically
schedule actions, infer tool availability, or mark downloaded prerequisites
satisfied. All job roots include their complete native prerequisites.

Use parallel Linux x64/arm64, macOS, Windows and Android/Apple cohorts. Batch
related roots per configuration so one invocation shares analysis and actions.
Move Swift assembly/consumers to macOS. Devices/browser/GUI tests use separately
allocated suitable hosts; `--platforms` does not allocate a runner or emulator.

Keep portable WASIX production and supported cross-compilation on Linux so
maintainers can reproduce them locally. The existing serializer supports a
target independent of its execution host; expose that target explicitly and
prove each produced AOT envelope by deserializing and running it on its real
target host. Foreign object generation alone is insufficient. Apple SDK and
MSVC-dependent actions stay on native GitHub runners with declared SDK/compiler
inputs. This architecture requires no hosted remote executor.

For example, the Linux x64 runtime and installed package cohort uses the same
command in a checkout and in `.github/workflows/bazel.yml`:

```sh
profile=//build_defs/native:linux_x86_64_glibc_2_28
bash tools/dev/bazel.sh test //:native_linux_tests \
  --platforms="$profile" --host_platform="$profile" \
  --java_runtime_version=remotejdk_17 --tool_java_runtime_version=remotejdk_17 --jobs=2
```

Android construction stays on this Linux execution profile while its declared
target transitions select the Android ABI. Platform execution tests add the
actual device or foreign host; they do not change the Linux construction proof.

Complete final packages can move between qualification jobs at the frozen
artifact boundary. Intermediate compiler inputs inside a construction closure
must remain native declared dependencies. Where a target genuinely cannot be
constructed on Linux, port the necessary execution toolchain to its native host
or construct the complete package on that host; do not silently skip the
prerequisite. Cache hits do not confer execution capability.
[Execution groups](https://bazel.build/extending/exec-groups),
[remote rule requirements](https://bazel.build/remote/rules), and
[execution/cache controls](https://bazel.build/reference/be/common-definitions).

A remote execution service may later improve throughput. Adopt it only after
local and hosted execution establish the platform contracts; credentials,
executor images and cold-cache capability then become explicit configuration.
Its absence cannot block the default Linux reproduction path. Temporary
intermediate imports during migration still require exact
digest/configuration/producer descriptors and a removal gate.

No global compiler root needs every desktop OS in one invocation. Each host
produces its complete configured packages. Frozen publication collates those
already qualified final packages across hosts; this is an explicit operational
trust boundary, not a shortcut within construction. Apple aggregate artifacts
can be fully constructed on the Apple host. Device jobs similarly consume an
exact qualified app envelope.

| Workflow | Migration |
| --- | --- |
| `.github/workflows/ci.yml` | Native platform build/test cohorts, fresh operational proof, one strict Required/Qualified admission path |
| `.github/workflows/liboliphaunt-native-desktop.yml` | Remove reusable construction workflow after native desktop cutover |
| `.github/workflows/extension-artifacts-native.yml` | Remove after native extension roots work in platform cohorts |
| `.github/workflows/broker-runtime.yml` | Remove after native library/executable/package targets |
| `.github/workflows/mobile-extension-packages.yml` | Remove after Android/Apple construction/assembly targets |
| `.github/workflows/wasix-host.yml` | Remove after complete portable-to-host execution is proven |
| `.github/workflows/mobile-e2e.yml` | Keep exact-artifact diagnostic replay, sharing the ordinary installed-app harness |
| `.github/workflows/release.yml` | Keep prepare/qualify/freeze/consumer/ready/bootstrap/publish/docs state machine; replace construction context and transport |

Replace setup actions with declared language/tools where possible. Retain narrow
Xcode/MSVC registration, device/ADB/KVM/licensing setup, orchestrator bootstrap
and publisher readiness. Wasmer LLVM becomes a pinned dependency; Docker Buildx
ceases to be a construction engine. Do not duplicate pins in remaining setup
actions. Genuine installed consumers still need their exact package-manager
clients.

Preserve PR/merge-group versus exact-main publication trust. Focused/debug runs
cannot become Qualified. Check every expected label/configuration/output/proof,
not just green jobs or `bazel test //...`: incompatible/manual targets can be
skipped. BEP supplies actual configured target, output and test results; the
admission gate compares them with the expected inventory.
[Build Event Protocol](https://bazel.build/remote/bep).

Retain event/concurrency cancellation, including the current runnerless PR-closed
tombstone. Preserve exact-main dispatch comparison admission: a manual request
cannot narrow qualification by inventing a comparison base instead of the
required immutable sole parent. Test these rules through credential-free hosted
events as well as local policy checks.

## Cache, tests, and efficient verification

Use one trusted remote action cache/CAS, declared toolchains and local action
reuse. Repository download caching is a different function. Untrusted PRs must
not write trusted publication cache results; isolate read/write policy and
qualifying source contexts. Frozen candidate storage must survive cache eviction.
[Remote caching](https://bazel.build/remote/caching).

Enforce isolation with server-side ACLs and scoped credentials, not a client
flag an untrusted PR can override. Include an adversarial cache-write probe;
trusted cached results must remain unavailable for unauthorized replacement.

A cold miss requested simultaneously by independent clients may duplicate work;
remote caching is not global scheduling. Keep expensive producer-first cohort
ordering where measurement shows it useful, or use executor-supported operation
deduplication after verifying it. Dependencies remain in every consumer's graph.
Do not restore upstream suppression to optimize a cache miss.

The current stricter same-run qualification policy remains active until its
replacement passes the cutover gates. The end state classifies evidence by its
claim, rather than by a task name or workflow phase:

- Hermetic unit, format, ABI, package, process, lifecycle and offline installed-
  consumer tests may reuse trusted passing results. Their declared inputs must
  include every actually consumed input: transitive dependencies, requirements,
  features, harness/fixtures, tools, relevant policy and execution environment.
  Final envelopes are required when installation/delivery is the claim; pure
  unit/format fixtures must not acquire unnecessary package prerequisites.
  Include loaded provider libraries and the actual OS/CPU/runtime configuration
  where relevant; an OS label or source SHA alone is insufficient.
- Device/host behavior with unmodelled state, live registry/auth/deployment
  observations and claims about an operation in the current run require fresh
  execution. Compile their runners once; execute only the required distinct
  environments, modes and shards.
- Admission binds the candidate's actual bytes/configurations to the original
  trusted result and retains its original execution identity/logs. A cache hit
  is evidence reuse, never a new execution receipt. PR/main trust remains a
  separate condition; identical source does not authorize promoting untrusted
  test results.

Use Bazel's test-result cache and BEP, with the existing publication admission
records. Do not add a second proof cache or freshness ledger. A candidate SHA,
global publication-lock digest or workflow phase must not invalidate every test
when it is only admission context, rather than a real test input. For offline
resolver tests, pin the historical package inputs and tools; acquire mutable
external state before the hermetic test or classify that test as fresh. The
[test contract](https://bazel.build/reference/test-encyclopedia) describes the
conditions under which test-result reuse is valid.

Before allowing reuse, negative fixtures must show rejection of changed payload,
transitive dependency, harness, toolchain/environment, requirements/features,
policy and untrusted origin. Current same-run checks can be removed only when
these cases and real supported consumer execution establish equivalent claims.
Do not carry a blanket release-wide `--nocache_test_results` into the end state.

Measure existing cold/warm builds, action counts, repeated tests, transfer bytes,
runner time and cost first. Acceptance must show:

- warm identical requests execute no unnecessary production actions;
- one translation-unit edit rebuilds its actual compile/link/package consumers;
- legal/manifest-only changes assemble/check packages without broad C rebuilds;
- test-only edits request relevant proof without selecting package releases;
- changed pins/tools/headers cannot reuse stale dependency outputs;
- identical shared generators/compilations execute once per compatible config;
- warm identical hermetic test requests reuse trusted results; only required
  current external observations execute again;
- aliases and root unions do not execute both an aggregate suite and its members;
- selected one/few/many products do not publish prerequisites automatically;
- provenance source SHA does not globally stamp/recompile unrelated payloads;
- broad-versus-focused selection differences are measured before job elision.

Do not invent percentage savings before native representative measurements.
Keep bounded old/new comparison runs during each cutover, then remove them;
permanent dual-build CI defeats the migration's efficiency goal.

### Minimal checks, tests, and builds

Migrate observable guarantees, not the current task count. Retain a check only
when it proves a distinct repository/product/operational contract, or tests
first-party code that implements that contract. Give it one executable owner;
convenience suites and CI cohorts request a union of those owners. Different
platforms, features, loaders, consumer manifests and failure boundaries can be
distinct contracts even when their scripts look similar. Identical wrappers,
workflow phases and scratch directories do not create new contracts.

Bazel owns dependency scheduling, configured output separation and cached-output
materialization. Delete tests of the retired implementations of those facilities
with their implementations. Keep small fixtures for our custom rules' actual
inputs, platform constraints and providers: Bazel does not discover omitted
inputs or establish consumer semantics. Validate a final transformed artifact
once within an immutable trusted phase; verify identity/content again when it
crosses a real download, extraction, approval or publication boundary.

The following dispositions are grounded in the audited source baseline. None
authorizes deleting a necessary check while its current producer remains.

| Current work and concrete evidence | End-state disposition |
| --- | --- |
| `tools/release/release-check.sh:31–53` discovers `independent-version-pins.test.sh`; `tools/release/moon.yml:162–166` also runs it separately | One native test owner for those scenarios, included by command-free suites. Remove duplicate execution without removing unchanged-SDK pin-preservation proof |
| `.github/scripts/*moon*` scheduler/capability/batch tests; `tools/ci/workflow-moon-transfers.test.mts:59–100,190–244,262–382`; `.moon/tasks/cargo.yml:14–23` | Delete recursive capability inference, producer subtraction, copied construction-tree/no-cache assertions and command-free source-hash graph. Keep immutable event/source selection, expected supported-root coverage and failed/skipped/cancelled admission cases |
| `tools/ci/workflow-moon-transfers.test.mts:104–148` requires all producers to wait for source checks/tests | Remove universal source-gate-before-production ordering. Independent checks and construction can run concurrently; final admission waits for all required results. Necessary authorization/acquisition preconditions remain |
| `tools/ci/workflow-caches.test.mts:13–131`; native/WASIX `build-orchestration-test`; `test-symbol-scope.sh:99–243`; postmaster `wasix-build-lock.test.sh:17–58` | Delete Docker/Cargo nesting, dispatch, stamps, readiness invalidation and mutable-prefix lock tests with those engines. Split mixed suites: keep actual symbol/provider/loader/ABI/AOT/sealing/unsafe deployment assertions |
| `src/native/runtime/bin/check-postgres18-ios-simulator.sh:164–211` builds ICU and selected PG objects, then checks patch text | Remove extra probe production and patch substring assertions after real configured simulator compilation and semantic mobile tests cover the contract. Do not remove actual open/reopen/persistence checks |
| Mobile `build-ci-target.sh:9,33` creates per-target host builds; `package-liboliphaunt-mobile-assets.sh:203–206` calls the XCFramework producer; ABI generation/comparison repeats at `:125–128,178–194` | Share identical configured prerequisites. Assembly consumes exact slice/resource/ABI outputs and cannot call producers. Generate/compare each ABI domain once, then assemble immutable final envelopes; remove in-place archive repair |
| Kotlin declares `mobile-bindings:generate` but `oliphaunt/build.gradle.kts:164–169,971,990` also invokes it; Swift `build-bindings-xcframework.sh:6` does the same | One declared UniFFI generation action supplies both languages and headers. Keep distinct configured Android/Apple library slices; remove downstream generation/build fallbacks |
| Native NAPI `moon.yml:182` requests both release packaging and `test-built`; `package-node-direct-runtime.sh:100` invokes the default release producer again | One cdylib/strip action per configuration, consumed by package and lifecycle tests. This is repeated current engine invocation, not proof of repeated code generation; final tests must consume the stripped delivered payload |
| Swift `stage-release-artifacts.mts:130–133` emits generator bundles; `check-package.mts:170–175` recompiles the same sources with the same helpers/flags | Generate once as declared outputs; independent final package reader compares actual packed files with those outputs and checks contents/requirements without compiling again |
| `src/wasix/sdks/ts/tools/integration/smoke-node.sh:16` and `smoke-browser.sh:40` repack query for each consumer | One declared immutable query tarball shared by Node/Bun/Deno/Electron/browser fixtures. Keep each supported resolver/export/runtime case; share installation only where requirements/environment match |
| `src/wasix/node-addon/moon.yml:75` runs `local-npm-tarball.test.mts`, also discovered by `tools/packaging/test.sh:5` | One packaging-owned test label reused by both suites; retain distinct addon platform/content tests |
| `src/query/ts/moon.yml:88–93` uses `**/*` for packaging; WASIX compiler inputs include legal/archive metadata; native/WASIX packaging units include broad tool globs | Separate compilation, envelope assembly and test inputs. Test-only edits run relevant tests; legal-only edits assemble/check affected envelopes. Neither forces unchanged PG compilation. Source membership/tool/patch/header changes still invalidate actual production |
| `tools/release/release-metadata-check.sh:8–16` runs overlapping RP/product/target checks | Share parsing and common assertions in one cheap static admission path; preserve each unique assertion and projection fixed-point check. Do not carry several overlapping traversals into native tasks or aggregate every product test under broad metadata inputs |
| `.github/workflows/release.yml:881–892` creates/validates the lock, immediately verifies it, then packs/validates it; `:1211–1217` repeats verification after verified capsule extraction | Remove adjacent redundant passes once create/pack/extract negative tests prove the same rejection guarantees. Keep actual archive parsing, capsule verification on each new host and immutable identity checks at protected boundaries |
| `tools/release/check_release_versions.mts:307–326` revisits historical dependencies per consumer | Share immutable historical facts within one preflight and check the actual required carrier/asset closure. Refresh mutable registry/auth state at the publication boundary; preserve anonymous postpublication resolver proof |
| `tools/release/publication-consumer-proof.mts:25–72` hashes a global list of unrelated platform/controller/harness files | Replace with each native test's actual transitive inputs and applicable policy. Bind candidate/approval context at admission. An unrelated product version or Android setup edit must not invalidate an identical query test; a real transitive dependency must |
| Source qualification and frozen-consumer tests have similar SQL/lifecycle scenarios | Share harness code. Share results only when final installed envelopes, resolved dependencies, features, environment and claims coincide. Today's workspace overrides, stub Cargo dependencies and rewritten WASIX requirements cannot prove frozen installation |
| Per-phase publisher workers reload immutable context | Keep inexpensive worker admission unless measurement justifies consolidation. Do not build a long-lived controller or custom cache merely to avoid cheap parsing; remote race/auth/byte checks remain per relevant operation |
| Native Rust's ordinary suite compiles runtime tests that return when runtime inputs are absent (`native_smoke.rs:64`, `native_sql_regression.rs:73`, `mobile_broker.rs:69`) | Separate pure unit and configured integration roots. Unit selection need not compile unused integration binaries; selected integration tests require actual runtime inputs and fail when absent, rather than producing a vacuous PASS |

Several apparent duplicates are already distinct or suppressed. Release and
packaging runners skip a TypeScript test when its same-name Shell wrapper owns
it. All seven coverage tasks have `runInCI: false`; coverage is not currently
doubling ordinary CI. Native raw-tree integration is also not an always-running
CI duplicate of packed-artifact smoke. Formatter versus lint, TS type checking
versus transpilation, Rust compilation versus clippy, and unit fixtures of a
validator versus validating a candidate prove different facts. Combine compatible
invocations only when all diagnostics/configurations survive. Optional coverage
must not become an automatic second complete suite; instrumented and ordinary
builds nevertheless have different inputs and cannot be assumed equivalent.

Docs generation/snippet checks can be shared between fast checks and full site
builds, without removing consumer snippet typing. Source SDK semantic checking
can be shared with equivalent production compilation; preserve test typing and
different public resolver/feature configurations. Cargo's packaged-test
`--no-run` check proves shipped fixture/source completeness under its requested
features; it does not execute the unit suite again. Conventional consumer
compilation remains independent of internal Bazel compilation. Broad lower-
layer semantics need not be replayed through every SDK, but each binding retains
its actual API/resource/lifecycle behavior and installed compatibility. This
audit has not established equivalence sufficient to delete those behavior cases.

The permanent verification model has five responsibilities:

1. **Declared contracts:** cheap deterministic checks for supported roots,
   conventional requirements, rendered versions/legal contents and completed-
   history/release intent. Pure unit fixtures use small explicit data.
2. **Custom rule/tool correctness:** narrow positive/negative fixtures for our
   generators, package formats, resources, ABI/provider rules and ownership.
   Share common tool fixtures rather than importing them into every product.
3. **Actual product behavior:** public APIs/features, SQL/lifecycle, installed
   resolvers/loaders, supported runtime/platform and device behavior. Use final
   envelopes where delivery is the claim; cache only eligible hermetic cases.
4. **Admission and trust boundaries:** workflow security, cache-write authority,
   immutable source/configuration, expected proof completeness, safe extraction,
   exact approved bytes and resumable publication. Keep actionlint/zizmor while
   GHA remains. Required/Qualified are admission views, not extra test suites.
5. **Current external observations:** selected identity/auth/signing readiness,
   public resolver visibility, real device/deployment state and remote race
   checks. Retry a failed external operation without rebuilding or replaying
   successful offline behavior tests.

Use native validation actions for appropriate deterministic build contracts;
do not add validator outputs as artificial compiler inputs merely to serialize
checks. Explicit test/admission roots still cover tools and configurations that
automatic validations omit.
[Validation actions](https://bazel.build/extending/rules#validation-actions).
Actual archive parsing is independent of writer unit tests. Public consumer
smoke already checks anonymous Cargo/npm/Maven/Swift resolution without replaying
the frozen SQL suite; retain that separate boundary.

For each cutover, record the old guarantee, surviving owner or native facility,
positive/negative semantic evidence, and obsolete code/tests removed in that
same change. This belongs in the slice's review, not a new permanent check
registry. Bounded legacy comparisons, cold/cache parity and repeatability
experiments qualify the port/toolchain; do not run two production engines or
recompile PG for every randomized policy fixture forever. Permanent scenarios
use small actual native actions plus independent expected consumers; rerun real
integration when relevant rules/toolchains/platform contracts change.

Assert work as well as results. The fixture/cutover budget must demonstrate:

- a warm unchanged request executes no production actions or eligible hermetic
  test attempts; required current external observations remain;
- docs/test-only changes select zero unrelated releases and compile no unrelated
  runtime; legal/envelope-only edits reassemble affected packages without C rebuilds;
- one SDK or embedded payload edit reaches its real consumers, while an unrelated
  independently versioned sibling remains reusable;
- one/few/many requested roots execute each shared action/test once per identical
  configured identity within an invocation, including aggregate/member requests;
- altered transitive inputs or unsupported/untrusted evidence prevent reuse;
- freeze, publication retries and docs recovery consume existing bytes/results,
  performing no producer build or complete source-suite rerun.

Count executed action/test attempts through BEP/execution evidence, with explicit
exceptions for separate configurations, instrumentation, fresh observations and
cold misses across independent clients. Do not promise global deduplication from
remote caching. Required support coverage remains complete even when matching
results are reused. A releaser should see a small selected contract set, rather
than every former task relabelled as a mandatory Bazel test.

## Frozen release and recovery

The delivery pipeline becomes:

```text
completed-publication snapshot + source
  -> bounded delivery/adoption intent -> Release Please candidate
  -> final versioned tree -> native configured packages + qualification
  -> exhaustive actual-output lock -> artifact-bound installed-consumer evidence
  -> publication-ready + approval -> upload those bytes -> reconcile/promote
  -> docs refresh and independent live verification
```

Parse actual archives after packaging. Dynamic Cargo splitting uses a declared
tree output plus inventory because size determines part count after execution.
Verify allowed parent/target, contiguous part names, exact product version,
limits/legal contents, complete aggregator dependencies and actual packed
dependency order. Do not invent a product or static label per hypothetical part.
Existing deterministic split/reassembly algorithms are valuable leaf tools.

Freeze final npm tarballs, Cargo crates/parts, Maven envelopes, Swift source/tree
and archives, GitHub assets, checksums and descriptors. Installed tests use
normal resolvers against a controlled transport of these exact bytes plus
verified historical dependencies. They must not substitute workspace sources
or rewrite requirements. Transport routing is allowed; changing declared
identity/constraint semantics is not. Anonymous live-registry installation and
visibility are fresh postpublication operations.
[Cargo packaging](https://doc.rust-lang.org/cargo/commands/cargo-package.html).

Preflight selected registry/auth/bootstrap/signing requirements before avoidable
mutations. Sign approved Maven contents at the protected boundary and record
the signed upload bytes. Publishing is an explicit runtime operation, possibly
launched by `bazel run`, never a cached build action. Cross-registry delivery is
resumable, not atomic: reconcile already-existing matching bytes, fail conflicting
immutable identities, publish missing dependencies before dependents, preserve
receipts and verify public visibility before promoting GitHub drafts/marking
completion. Cover Maven pagination and ambiguous upload responses.

Recovery uses the original source, lock, approval capsule and bytes. A narrowly
allowlisted controller repair can change transport logic; native BUILD/rule,
compiler or package-writer changes cannot be disguised as controller-only
recovery. Main advancing does not authorize replacement producer outputs.
Preserve all tag/lease/exact-PR guards. Failure of docs deployment after completed
publication retries docs only.

## Migration sequence and hard gates

Each step ends with a deletion or authority cutover after proof. Parallel work
within a step is useful; dependents cannot cut over before their full closure.
Use scoped PRs around these gates rather than one unreviewable rewrite.

| Step | Concrete deliverable | Acceptance and removal |
| --- | --- | --- |
| 0. Stabilize current delivery | Correct completed-history bounding, exact-runtime/default-recipe checks, frozen-consumer skip topology and publisher reconciliation/preflight; capture actual baseline inventories and performance | Independent failing scenarios now pass through the real preparation/consumer/controller entrypoints. Do not wait for Bazel to repair unrelated release bugs |
| 1. Establish the foundation | Pin Bazel/rules; acquire upstream source inventories; register native and cross-compilation toolchains; define small shipping/domain exports, manifest imports and the historical bridge | Clean Linux construction plus native macOS/Windows SDK probes pass. Cross-built packages run on their real hosts. No cutover with unavailable execution capability or unknown historical ownership |
| 2. Prove hard construction slices | Native PG configured headers/generators and ordinary/embedded/frontends; one representative compiled extension, SQL-only pgTAP, portable WASIX plus host AOT; query/package tools as fast test infrastructure | Clean sandboxed production works with no existing target tree or foreign producer. ABI/provider/SQL/package tests and declared-action inspection match the supported contract. Compare legacy behavior, diagnose differences, then delete slice-specific producer/cache/handoff bodies |
| 3. Complete runtime/dependency families | All native platforms, ICU/crypto/PostGIS and its generators, contrib/external targets, seeds/mobile ABI, complete WASIX/tools/AOT/postmaster/browser production | Full declared support and actual content/ABI/feature/lifecycle coverage; stale dependency and interface-change cases pass. Prove repeatable production, including seed generation, before declaring this workstream complete. Remove all broad C/WASIX producer engines |
| 4. Complete SDK/application/dev surfaces | Rust/TS/NAPI/UniFFI/Swift/Kotlin/RN native targets and exact envelopes; all examples, docs, benchmark checks, security/hooks/developer commands; JS resolution cutover | Real installed Cargo/npm/SwiftPM/Gradle/RN consumers, browser and app proofs pass. Preserve public integration manifests; remove internal Cargo/Gradle/SwiftPM/Bun task dispatch and duplicate lock/bootstrap authority |
| 5. Switch CI and release | Platform cohort workflow, BEP/expected-coverage gate, native delivery selection plus historical bridge, bounded RP/adoption adapter, freeze integration and capsule compatibility | Zero/few/many/all-product simulation, exact merged qualification, skipped ancestor, recovery and fake registries pass. Evidence-reuse negative cases and the warm-run work budget pass; required fresh observations remain. One real credential-free hosted topology probe passes. Remove reusable construction workflows and every Moon closure/capability/transfer bypass |
| 6. Complete the authority cutover | All inventory rows have native owners; current docs/skills/local commands route to them; retire legacy baselines product by product and capsule readers by recovery policy | No ordinary path requires Moon/Proto, a mutable producer tree, foreign producer engine, handwritten shared-source graph or hidden latest fetch. Delete `.moon/`, obsolete project task files/pins/actions and implementation-shape tests. Record remaining external facilities explicitly |

Do not force a mass release just to install BUILD files. Where the port changes
compiler/dependency/payload/support behavior, release the resulting delivery
change with its reason. Where audited parity establishes a construction-only
migration, record that evidence in the baseline bridge. A product still lacking
an honest old baseline cannot be claimed precisely unchanged.

## Verification scenarios and independent oracles

The test harness must exercise real Bazel analysis/actions, the real Release
Please adapter/projections, package writers/parsers and the publication controller.
It must not ask a planner to produce both the result and expected answer.

| Scenario family | Required independently asserted result |
| --- | --- |
| Zero/one/few/many/all changes | Exact selected products, versions, requirements, build roots, final artifacts and required proofs; examples/docs/tests alone select zero package releases unless their contents ship |
| Shared source and different baselines | An older change already delivered by one product but not another selects only remaining delivery owners; out-of-directory release commits and component renames retain boundaries |
| Deletion/rename/removed edge | Union of old/new native facts preserves impact; missing historical facts or exhausted pagination blocks precise preparation |
| Broker/query/source versus binary | main-only change excludes library-only mobile; shared library change reaches actual embedded SDKs; source SDK historical pins remain unless mandatory adoption applies |
| Package-only and legal input | Correct owned envelope changes without unnecessary runtime compilation; Markdown file extension never silently exempts shipped notices |
| Source/tool/platform configuration | New nested header/table/assembly, host SQLite, Perl/Bison/Flex, NDK/API/CRT/CPU/LLVM changes invalidate the right actions; an unused toolchain does not select unrelated products |
| WASIX interface and sealing | Stable imports avoid main relink/mandatory runtime delivery under the admitted interface policy; changed imports select main work; wrong Wasmer family or pre-seal AOT is rejected |
| Installed compatibility | Actual packed requirements plus loaded runtime/extension/profile/target agree; historical pin unavailable, wrong host, unsupported feature, missing resource or wrong default recipe fails |
| Generated parts and envelopes | Size thresholds, several targets, missing/extra/noncontiguous/wrong-version parts, aggregator pins, exports, Swift URLs/checksums, plugin marker and optional npm dependency cases are detected |
| Cached versus clean construction | For representative edits/configs, a clean execution and incremental execution have equivalent final contents/contracts; no presence stamp or prepopulated target tree hides an omission |
| Qualification coverage and evidence reuse | Identical complete inputs reuse the original trusted result. Changed/missing transitive input, wrong environment, stale policy, untrusted result, missing config/shard/manual target, debug run, wrong app digest, failed/skipped proof and main/source mismatch block admission; required current external observations cannot use cached PASS |
| Publication and recovery | Fail after each registry boundary, replay matching identity, conflicting byte, later-page Maven deployment, auth failure, ambiguous response, delayed visibility, main movement and controller-only repair reconcile correctly without rebuilding |
| Completed publication/docs | Partial publication never becomes the next baseline; a docs failure retries only deployment; no recommended-version edits or product bumps |

Use a tiny fixture repository with an independently authored physical-consumer
truth table and immutable prior publication records. Seed random edits across
zero/few/many inputs, graph/config changes, old/new pins and failure points.
Exhaustively enumerate admissible small product subsets to verify required
compatibility closure, run actual entrypoints, and retain the random seed and
minimal failing fixture. Most scenarios need small native actions and fake
registries, not repeated full PG matrices.

Use a bounded real clean-platform suite for compiler/rule integration, binary
contracts and installed lifecycle; use broad candidate-specific supported
platform coverage for releases. Tests of the former planner's string shape
cannot replace either. No tool can prove arbitrary semantic defects impossible;
this design makes omitted inputs, incomplete history, unsupported configurations,
metadata drift, package substitution and transaction failures explicit and
testable before avoidable publication.

## Audit validation and remaining work

The audit loaded the actual product/catalog parsers and pinned Moon project/task
snapshots, checked the main/workspace tree equivalence, and independently
validated inventory coverage. The current publication-catalog suite passed
five tests and 583 assertions. Document coverage and links are checked separately.

The initial strategy audit preceded implementation. The current local migration
has executable foundation/import targets, native Rust/TypeScript query packages
and installed consumers, direct Linux PostgreSQL/ICU and 39 extension members,
native Rust SDK/mobile/Node targets, the TypeScript SDK source envelope, a
physically verified portable WASIX runtime, the browser's exact nightly Rust
standard library built from source, and both complete Android runtime ABI
outputs. Kotlin's native common-source compilation and tests also pass. Actual Linux runtime
tests cover the embedded C ABI, persisted SQL, ordinary server frontends,
dump/restore and physical-backup reopen. Warm runs reuse completed actions.
Physical conformance fixtures cover seeded edit subsets, independent release
baselines, malformed ownership and cached reuse. These construction results do
not admit all products or replace real installed compatibility qualification.

The installed native Rust source packages resolve through Cargo against the
actual published runtime and broker versions. WASIX's optional tools and ICU
requirements are now explicit held Cargo metadata, verified against its
published crate. Current source construction does not replace those installed
contracts. The macOS and Windows native runtime and Swift package targets are
authored; their real host qualification remains a separate gate.

Completed-history preparation now uses exact captured Git ancestry and verified
publication boundaries, with real merge/clock-skew regressions. Existing
qualification and frozen publication remain active. The hosted native workflow
qualifies an exact source commit; its platform results are required before the
corresponding cutover. No registry mutation or release cutover was performed. Complete declared
toolchain and execution identity, remaining runtime/extension profiles,
Android/Apple package rules, final carriers, seed reproducibility and release-hook
integration remain concrete acceptance work.
