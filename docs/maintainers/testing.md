# Testing Policy

Status: normative testing policy. Last verified: 2026-07-15. Owner: repository maintainers.

Oliphaunt is a polyglot product repo. Product-native tests stay in product-native test roots.
Each SDK is validated with the same tools its consumers use:

- Rust SDK: `src/sdks/rust/tests/`
- WASM crate: `src/bindings/wasix-rust/crates/oliphaunt-wasix/tests/`
- Swift SDK: `src/sdks/swift/Tests/`
- Kotlin SDK: `src/sdks/kotlin/oliphaunt/src/commonTest/`,
  `src/sdks/kotlin/oliphaunt/src/androidUnitTest/`, and
  `src/sdks/kotlin/oliphaunt/src/nativeTest/`
- React Native package: `src/sdks/react-native/src/__tests__/`
- Installed React Native app smoke and benchmark coverage:
  `src/sdks/react-native/examples/expo/`

Use the tier model below when deciding whether a check belongs in PR fast
feedback, affected integration, an explicit full manual run, release dry-run, or post-publish
validation.

- PR: Moon-affected `check` and `test` tasks, release intent, and the selected
  package, artifact, and E2E jobs. Measured `coverage` is an explicit
  local/manual lane; it is not part of the `Required` PR gate.
- Main: the PR gate plus selected runtime smokes and regressions for changed
  products; a successful non-cancelled run emits the exact-SHA `Qualified`
  release record.
- Full manual: full regressions, extension matrix, installed mobile app
  smokes, lifecycle drills, and measured benchmark reports.
- Release: package-native dry-runs, artifact manifests, checksums,
  attestations, registry checks, exact-extension evidence, binary
  compatibility-floor inspection, and selected regression/performance gates.

Target-scoped consumer diagnostics do not inherit an implicit success barrier
from a multi-platform producer matrix. Mobile extension packaging and Android
app/E2E rows, the per-target JavaScript candidate consumers, the Linux native
lifecycle/Rust candidate consumers, and the Linux WASIX regression continue
after an unrelated producer row fails, provided the plan and every shared
prerequisite succeeded and the run was not cancelled. Each consumer still
downloads its exact same-run artifact and fails when that target's input is
absent. The JavaScript matrix waits directly for the desktop producer matrix,
not the all-platform native aggregate. Its portable ICU candidate is packaged
once by the macOS desktop row into a separate exact same-run artifact, so a
failed Windows, Android, or iOS row cannot skip otherwise usable Linux/macOS
consumer diagnostics. The all-platform native aggregate remains a separately
selected mandatory build and still validates the complete release-asset set.
`Builds`, `E2E`, `Required`, and `Qualified` retain every producer and consumer
result and therefore remain fail-closed for release evidence.

Linux producer lanes prove compatibility twice. The format-independent ELF
inspector rejects any `GLIBC` requirement above 2.38 or `GLIBCXX` requirement
above 3.4.30, including objects inside static archives. The packaged dynamic
trees then run through `tools/release/check-linux-consumer-baseline.sh` in an
immutable Fedora 39/glibc 2.38 container with no network, writable root, or
Linux capabilities. The fixture is an ABI test appliance, not a supported-OS
or security-lifecycle assertion. The broker is additionally built and started
in its pinned older linker baseline so the rehearsal cannot merely document a
runner-induced floor regression.

### Candidate Cargo example locks

Cargo examples are registry-neutral source fixtures. Their manifests use
ordinary crates.io dependencies with exact Oliphaunt versions; they do not
commit `registry = "oliphaunt-local"`, a candidate `[patch.crates-io]` table, or
a nested `Cargo.lock`. Exact candidate archives are outputs of cross-platform
CI, so a source commit cannot also contain their final checksums without
creating a build-commit-build cycle.

The static source check rejects registry coupling, stale product versions,
committed nested locks, and missing ignore rules:

```sh
tools/dev/bun.sh tools/release/example-cargo-policy.mjs --check
```

Release qualification first assembles an exact local registry from the
qualified artifacts. It then copies each example to `target/`, injects exact
`[patch.crates-io]` entries for candidate packages, generates a lock, validates
candidate versions and checksums against both the registry index and `.crate`
bytes, enforces the canonical stable Wasmer/WASIX set and advisory floors, and
runs a full `cargo fetch --locked`. The generated evidence records each lock
digest. Run the same proof locally with:

```sh
tools/dev/bun.sh tools/release/validate-example-cargo-candidates.mjs \
  --index target/release-work/candidate-registries/cargo/index
```

For a later partial release, only packages present in that candidate registry
are patched; unchanged published packages and all third-party dependencies
resolve from crates.io. Candidate manifests and locks must never be copied back
into source.

Cross-product behavior belongs in `docs/maintainers/sdk-parity-policy.md` and executable parity
checks. Do not centralize platform tests into a fake shared test harness when a
native package manager, simulator, Gradle target, SwiftPM target, Cargo target,
or React Native Codegen path is the actual consumer contract.

## Fixtures

Product-private fixtures stay inside the product test root that consumes them.
Create a shared fixture root only after the same contract is consumed by at
least two products without platform-specific setup. Until then, colocated
fixtures are clearer and cheaper to maintain.

Shared fixture domains are small, semantic contracts consumed by
product-native tests or policy checks:

- `src/shared/fixtures/protocol/query-response-cases.json`: PostgreSQL backend-response
  corpus consumed by Rust, Swift, Kotlin, React Native, TypeScript, and WASM
  protocol tests.
- `src/shared/fixtures/sdk-capabilities/mode-support.json`: direct, broker, and server
  capability expectations used to keep mode support assertions aligned.
- `src/shared/fixtures/runtime-resources/manifest.properties`,
  `src/shared/fixtures/runtime-resources/template-pgdata-manifest.properties`, and
  `src/shared/fixtures/runtime-resources/package-size.tsv`: runtime-resource and
  exact-extension package-size contracts used by Rust, Swift, Kotlin,
  TypeScript, and React Native packaging/resource tests.
- `src/shared/fixtures/backup/physical-archive-manifest.json`: physical archive metadata
  expectations for backup/restore contract tests.
- `src/shared/fixtures/lifecycle/session-lifecycle.json`: close, cancel,
  background/foreground, and transaction-pinning lifecycle expectations.
- `src/shared/fixtures/react-native-jsi/binary-transport.json`: RN-only JSI ArrayBuffer,
  typed-array offset, stream chunk, callback, and handle-validation cases.

Reusable benchmark datasets, benchmark plans, and published reports belong in
`benchmarks/`. Executable benchmark harnesses belong in `tools/perf/` unless
the harness is intentionally part of a product's public developer API.

## Moon Tasks

Moon task names are intentionally narrow:

- `check`: static checks, typecheck, codegen, lint, or build-only validation.
- `test`: real unit or contract tests in the product-native runner.
- `package`: package-shape checks and publish dry-runs.
- `smoke`: one runtime happy path for that product.
- `regression`: broader SQL, protocol, extension, lifecycle, or runtime
  regression suites.
- `bench`: benchmark plan/report validation only.
- `bench-run`: measured benchmark execution.
- `coverage`: runs product-native measured line coverage and writes
  machine-readable reports under `target/coverage/<product>/`.

`check` and `test` must not call the same command for SDK products. `test`
must run tests, not metadata-only checks. `smoke` targets must be explicit
runtime probes and must be run with `--cache off` in CI/release evidence lanes
where current device/simulator/runtime state matters.

Runtime prerequisites are centralized in `tools/runtime/preflight.sh`. Rust,
Swift, Kotlin, TypeScript, and WASM smoke/regression lanes use that helper for
host liboliphaunt, Android liboliphaunt, iOS simulator probe, and WASIX
asset/AOT checks. Static, package, unit, and coverage lanes remain
artifact-light; they may warn about missing local runtimes but must not claim
runtime evidence. React Native installed-app smokes delegate runtime
materialization to the Expo platform scripts and hard-fail there if native
artifacts cannot be built or located.

React Native installed-app smoke is split by platform:

```sh
moon run oliphaunt-react-native:smoke-android
moon run oliphaunt-react-native:smoke-ios
moon run oliphaunt-react-native:smoke-mobile
```

PR jobs run RN static, unit, Codegen, JSI, config-plugin, and package checks.
Affected PR, main, and explicit manual lanes run the installed Android/iOS app
smokes selected by the CI plan.

Installed-app E2E runner choice is closed, not a recurring research task.
Decision (2026-06-08): Oliphaunt uses the pinned open-source Maestro CLI
through GitHub-hosted emulator/simulator jobs. This is not an open research loop.
Reopen that decision only when a written implementation proposal names an
installed-app E2E requirement that the pinned open-source Maestro CLI cannot
satisfy. Do not keep re-checking Maestro, Detox, Appium, EAS, Firebase Test
Lab, BrowserStack, Sauce, AWS Device Farm, or other hosted-device services while
implementing this plan. Routine maintenance verifies the pinned installer, flow
files, app artifacts, runner behavior, and CI logs for the selected Maestro
lanes; it does not revisit provider selection.

`tools/dev/setup-maestro.sh` installs only the exact versioned release asset and
SHA-256 recorded in `src/sources/toolchains/maestro.toml`; that manifest is the
single release pin. It does not execute the vendor's network installer. Version
upgrades change the reviewed manifest metadata and must keep the staged
archive/layout/version and atomic-promotion regression tests green; incomplete
or inconsistent metadata fails before any download.

The Node direct addon likewise treats `src/sources/toolchains/node.toml` as the
single source for fallback header and Windows import-library release metadata.
`build-node-addon.sh` continues to prefer an explicit or installed local header
or `node.lib` candidate. Only a missing candidate activates the fallback, which
then requires the manifest's exact Node runtime, HTTPS-only bounded transfer,
SHA-256 verification, safe staged header extraction, and atomic cache promotion.
The fault suite covers invalid metadata, corrupt caches, unsafe or truncated
archives, transport interruption, checksum failure, and promotion rollback.
Node upgrades update that manifest's reviewed digests together with
`.prototools` and each CI `NODE_VERSION`; source-toolchain policy rejects any
runtime/manifest drift before a release build.

Prior provider research is historical context, not a standing checklist. Maestro
pin upgrades are dependency maintenance; they do not reopen the runner decision
unless they expose a concrete installed-app E2E requirement this path cannot
meet.

The default installed-app path must remain free and public-checkout
reproducible. Paid hosted-device providers, SaaS-only runners, and required
private runner infrastructure are not part of the default proof path. When
mobile E2E breaks, inspect the selected implementation first: app artifact shape,
simulator/emulator setup, Maestro flow files, logs, and CI runner assumptions.
Debug the chosen implementation first. Do not restart provider research unless
the failure proves a concrete requirement this model cannot satisfy.

## Coverage

Coverage is measured evidence, not a policy-only check. Product tasks run the
native reporter for their ecosystem: `cargo-llvm-cov` for Rust and WASM library
coverage, `swift test --enable-code-coverage` for Swift, Kover for Kotlin, and
Vitest V8 coverage for TypeScript and React Native TypeScript code. Each product writes
`target/coverage/<product>/summary.json` plus its native report formats, and
`moon run repo:coverage` aggregates those summaries into `target/coverage/summary.json`
and `target/coverage/summary.md`.

Rust and WASM executable unit tests run through `cargo nextest` with the `ci`
profile. Unit lanes still run doctests through `cargo test --doc` because
nextest does not own doctest execution. Coverage lanes measure line coverage
through `cargo llvm-cov nextest` and then run `cargo test --doc` as stable-Rust
correctness evidence. Doctest coverage itself requires nightly rustdoc flags, so
it is not part of the default stable LCOV gate.
WASM library unit coverage intentionally uses `--no-default-features`, while
WASM doctests run with default features because the README extension examples
exercise the default extension surface. Runtime Postgres/WASIX execution stays
in `smoke` and `regression`, where missing runtime assets must fail or skip
explicitly according to the lane policy.

TypeScript and React Native unit tests use the shared Vitest discovery runner
in `tools/test/run-js-tests.mjs`. Coverage calls the same runner with Vitest V8
coverage enabled, so test discovery and coverage discovery cannot drift. React
Native native adapter compile checks, Codegen checks, Expo prebuild/app wiring,
and installed-device smokes remain separate package or runtime lanes; Vitest
coverage is only evidence for TypeScript API/config/JSI contract code.

`coverage/baseline.toml` records product-owned `source_globs`, precise
`exclude_globs`, explicit waivers, the aggregate gate, and an initial per-file
floor. Every owned source file must be measured or waived with a reason and
replacement evidence; every waiver also carries an owner and expiry/review
horizon. Generated code, vendored code, PostgreSQL sources, native build
outputs, package `lib/` output, Gradle build directories, Xcode DerivedData,
and Codegen output are excluded from SDK wrapper coverage gates.
`measured_line_coverage` is an audit snapshot, not an exact equality gate. The
initial aggregate floor is 80 percent for SDK wrapper code, with a two-point
per-release ratchet until each SDK wrapper reaches 85 percent line coverage.
Use `moon run repo:coverage-policy` when you only need to validate the
coverage policy shape.

The root coverage commands are:

```sh
moon run :coverage
moon run :coverage --affected
```

## WASM Runtime Tests

`oliphaunt-wasix` is intended for tests that need real Postgres semantics without
Docker.

Use `Oliphaunt::temporary()` when the code under test can call the direct Rust
API:

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

#[test]
fn stores_rows() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::temporary()?;

    db.exec("CREATE TABLE items (id int primary key, name text)", None)?;
    db.exec("INSERT INTO items VALUES (1, 'alpha')", None)?;

    let rows = db.query("SELECT name FROM items WHERE id = 1", &[], None)?;
    assert_eq!(rows.rows[0].get("name").unwrap(), "alpha");

    db.close()?;
    Ok(())
}
```

Use `fresh_temporary()` only when the test must validate fresh-cluster
initialization behavior:

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

#[test]
fn fresh_cluster_path() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::builder().fresh_temporary().open()?;
    db.close()?;
    Ok(())
}
```

## Server Tests

Use `OliphauntServer` when the application already talks to Postgres through a
client library:

```rust,no_run
use oliphaunt_wasix::OliphauntServer;
use sqlx::{Connection, Row};

#[tokio::test]
async fn sqlx_query() -> Result<(), Box<dyn std::error::Error>> {
    let server = OliphauntServer::temporary_tcp()?;
    let mut conn = sqlx::PgConnection::connect(&server.database_url()).await?;

    let row = sqlx::query("SELECT $1::int4 + 1 AS n")
        .bind(41_i32)
        .fetch_one(&mut conn)
        .await?;
    assert_eq!(row.try_get::<i32, _>("n")?, 42);

    conn.close().await?;
    server.shutdown()?;
    Ok(())
}
```

Keep client pools at one connection.

## Extension Tests

Enable bundled extensions through the builder:

```rust,no_run
use oliphaunt_wasix::{Oliphaunt, extensions};

#[test]
fn vector_query() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::builder()
        .temporary()
        .extension(extensions::VECTOR)
        .open()?;

    db.exec("CREATE TABLE items (embedding vector(3))", None)?;
    db.exec("INSERT INTO items VALUES ('[1,2,3]')", None)?;
    db.exec("SELECT embedding <-> '[1,2,4]' FROM items", None)?;

    db.close()?;
    Ok(())
}
```

When an extension has bundled dependencies, prefer the builder path over
post-open `enable_extension(...)`.

## Snapshot Setup

Use physical data-dir archives or `try_clone()` when a test suite needs a
pre-populated same-version fixture:

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

#[test]
fn clone_fixture() -> Result<(), Box<dyn std::error::Error>> {
    let mut seed = Oliphaunt::temporary()?;
    seed.exec("CREATE TABLE items(value TEXT)", None)?;
    seed.exec("INSERT INTO items VALUES ('alpha')", None)?;

    let mut clone = seed.try_clone()?;
    clone.exec("SELECT * FROM items", None)?;

    clone.close()?;
    seed.close()?;
    Ok(())
}
```

Use logical dumps, not physical archives, when you need a portable export.

## Cross-Language Clients

Use `oliphaunt-wasix-proxy` when the test process lives outside Rust:

```sh
oliphaunt-wasix-proxy --temporary --tcp 127.0.0.1:0 --print-uri
```

Pass the printed URI to Python `psycopg`, Go `pgx`, Node `pg`, or another
standard Postgres client.

## COPY And Raw Protocol Tests

Direct `Oliphaunt` supports `/dev/blob` for `COPY TO` and `COPY FROM`. Server
mode supports ordinary client-driven `COPY FROM STDIN` and other standard wire
protocol flows through the local Postgres endpoint.
