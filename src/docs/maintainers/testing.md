# Testing Policy

Status: normative testing policy. Last verified: 2026-07-28. Owner: repository maintainers.

Oliphaunt is a polyglot product repo. Product-native tests stay in product-native test roots.
Each SDK is validated with the same tools its consumers use:

- Rust SDK: `src/native/sdks/rust/tests/`
- Rust WASIX binding: `src/wasix/sdks/rust/tests/`
- Swift SDK: `src/native/sdks/swift/Tests/`
- Kotlin SDK: `src/native/sdks/kotlin/oliphaunt/src/commonTest/`,
  and `src/native/sdks/kotlin/oliphaunt/src/androidUnitTest/`
- React Native package: `src/native/sdks/react-native/src/__tests__/`
- Installed React Native app smoke and benchmark coverage:
  `src/examples/native/react-native-expo/`

All Bun test entrypoints (Shell, Moon, workflows, and package scripts) use
`bash tools/dev/bun.sh test`. This launcher selects the pinned Bun and owns the
30-second per-test default. Use an explicit `--timeout` only for a different
limit. The launcher starts from the repository root; package-local tests pass
`--cwd src/path/to/package` so their paths and Bun configuration stay local.

Use the tier model below when deciding whether a check belongs in PR fast
feedback, affected integration, an explicit full manual run, release dry-run, or post-publish
validation.

- PR: Moon-affected `check` and `test` tasks, release intent, and the selected
  package, artifact, and E2E jobs. Measured `coverage` is an explicit
  local/manual lane; it is not part of the `Required` PR gate.
- Main: affected checks, builds, runtime tests, and selected E2E. A release
  version change selects its product qualification closure and can emit an
  exact-SHA `Qualified` record.
- Manual: the selected product or full source/runtime/package/E2E graph. All
  platform selectors must remain `all` for publishable qualification on main.
  Coverage and benchmarks remain optional.
- Release: package-native dry-runs, artifact manifests, checksums,
  attestations, registry checks, exact-extension evidence, binary
  compatibility-floor inspection, and selected artifact behavior evidence.
  Publication reuses qualified artifacts; it does not rebuild products or rerun
  the release tooling's implementation tests.

Merging a PR emits a `pull_request.closed` cancellation tombstone in the
existing PR concurrency group. That event allocates no runners: the plan,
release-intent, and every `always()` aggregate skip. Its only purpose is to
cancel obsolete PR work before the `main` commit is qualified; work completed
before cancellation has still consumed runner time.
For a manual dispatch on `main`, release intent compares the dispatched SHA
with its immutable sole parent; it never uses the moving `origin/main` ref,
which already names the head after a merge. Non-main diagnostic dispatches
continue to compare with current `origin/main`.

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
trees then run through `tools/packaging/check-linux-consumer-baseline.sh` in an
immutable Fedora 39/glibc 2.38 container with no network, writable root, or
Linux capabilities. The fixture is an ABI test appliance, not a supported-OS
or security-lifecycle assertion. The broker is additionally built and started
in its pinned older linker baseline so the rehearsal cannot merely document a
runner-induced floor regression.

### Cargo example manifests

Cargo examples use crates.io dependencies pinned to the current Oliphaunt versions.
They do not commit nested lockfiles. Validate them with:

```sh
tools/dev/bun.sh tools/release/example-cargo-policy.mts --check
```

Cross-product behavior belongs in `src/docs/maintainers/sdk-parity-policy.md` and executable parity
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

- `src/test-fixtures/protocol/query-response-cases.json`: PostgreSQL backend-response
  corpus consumed by Rust, Swift, Kotlin, React Native, TypeScript, and WASIX
  protocol tests.
- `src/test-fixtures/postgres/behavior-contract.json`: common PostgreSQL
  behavior cases that are meaningful in more than one SDK.
- `src/test-fixtures/storage/database-root.json`: the exact five-field
  managed-root descriptor cases consumed by native and WASIX validators.
- `src/native/runtime/smoke/fixtures/physical-archive-native-v1.properties` and
  `physical-archive-wasix-v1.properties`: exact physical archive identities
  consumed by the runtime-family backup and restore tests.
- `src/test-fixtures/storage/physical-backup-wal-range-v1.properties`: exact
  inclusive WAL segment-range vectors consumed by native and both WASIX online
  backup implementations, including non-default segment size arithmetic.

Product tests consume these shared fixtures through the actual protocol and
archive implementations. Published source packages receive required standalone
copies in their staging directories.
Reusable benchmark datasets, benchmark plans, and published reports belong in
`src/benchmarks/`. Executable benchmark harnesses belong in `src/benchmarks/perf/` unless
the harness is intentionally part of a product's public developer API.

## Acquisition deadlines

Repository-owned downloads use `tools/dev/acquisition.sh`. Start one budget at
an acquisition's entry point, before lock waits or transport, and reuse it for
all retries, mirrors and dependent requests. Nested operations can shorten the
budget but cannot restart it. Compilation and test execution have their own
budgets; do not wrap an entire build in an acquisition timeout.

```sh
. "$repo_root/tools/dev/acquisition.sh"
oliphaunt_acquisition_start 'example sources' 900
# Per-endpoint cap, attempts, retry delay, curl command, existing secure arguments.
oliphaunt_acquisition_curl 300 3 5 curl --fail --location \
  --proto '=https' --proto-redir '=https' --tlsv1.2 --output "$partial" "$url"
# For Git, package managers and source validation processes:
oliphaunt_acquisition_run 300 git fetch --depth=1 "$url" "$commit"
```

The caller owns URL/pin validation, TLS policy, archive limits, checksums,
validation and atomic promotion. Downloads must target a staging file with
`--output`, never append retry responses to stdout. Pass curl's connection,
size and low-speed limits normally, but let the helper own `--retry` and
`--max-time`. Its single attempts each receive the remaining time. Curl's
[`--retry-max-time`](https://curl.se/docs/manpage.html#--retry-max-time) alone
allows its final attempt to run past the retry timer.

| Acquisition | Default total | Maximum per endpoint/command |
| --- | --- | --- |
| Source scope / individual source pin | 30 / 15 min | Git fetch and archive endpoint: 5 min |
| PostgreSQL source archive, both origins | 3 min | 90 sec per origin |
| WASIX builder APT update + install + retries | 15 min | Update: 5 min; install: remaining budget |
| WASIX compiler asset set | 30 min | 15 min per asset |
| Android SDK setup / emulator packages (separate operations) | 30 min each | Command-line-tools origin: 4 min; SDK packages: remaining budget |
| Moon + Proto + plugins | 15 min | 5 min per asset or registry request |
| Bun/Deno; Node; npm publisher | 5 min each | Bun/Deno origin: 2 min; others: remaining budget |
| Wasmer LLVM | 30 min | Remaining budget |
| Maintainer binary; winflexbison | 3 min each | Remaining budget |
| Swift signing keys | 2 min | Remaining budget |

`OLIPHAUNT_ACQUISITION_TIMEOUT_SECONDS` overrides an operation's total (integer
1–7200); it never raises an endpoint cap or replenishes an enclosing operation.
Defaults allow cold installation while bounding repeated failures. The APT
budget is deliberately above observed normal cold transactions (roughly a
minute), below the observed 40-minute failure tail. Tune with hosted timings,
not another retry layer. Separate scripts/actions have separate transactions;
this is not a workflow-wide download allowance.

Shell and curl suffice for bootstrap downloads. Git, APT and SDK-manager
processes require GNU `timeout` (`coreutils`, `brew install coreutils` on macOS).
The shared helper verifies GNU identity, preferring `gtimeout` and falling back
to `/usr/bin/timeout` when Windows System32 shadows Git Bash's executable.
Android setup checks the timer before treating an SDK installation as invalid;
the macOS setup action provisions Coreutils when missing.
Commands receive TERM on expiry and KILL five seconds later if needed, including
children in their process group. Expiry reports the acquisition label and a
nonzero status (124 on expiry, or 137 after a forced kill; owners may add their
own failure status).
Interrupted curl attempts are not retried or mirrored. Existing traps clean staging and preserve prior
installations; short atomic promotion and rollback finish outside the timed
child. Source validation/extraction also consumes the source budget. Other
installers' local validation and promotion are not independently hard-timed.
The portable shared clock uses epoch seconds; per-process timers bound active
work. Runner clock corrections can shift subsequent remaining-time calculations.

The helper's test owns clock arithmetic and process termination; source and
installer fault tests own preservation, retry/failover and validation. Moon
inputs and WASIX recipe identity include the helper. Build the WASIX Dockerfile
from the repository root; its adjacent `Dockerfile.dockerignore` limits context
to the recipe and helper. To build from another checkout, set `REPO_ROOT` and
`WASIX_TOOLCHAIN_ROOT` together so the recipe and COPY inputs refer to that tree.

Upstream actions and general dependency resolution (Cargo, npm, Homebrew,
Chocolatey, pip and host build-tool setup) retain their existing job/setup
budgets. This helper does not replace package-manager retry or installation
semantics. A deadline stops a bad acquisition promptly; it does not turn a
failed transfer into successful qualification.

## Moon Tasks

Moon task names are intentionally narrow:

- `check`: static checks, typecheck, codegen, lint, or build-only validation.
- `test`: real unit or contract tests in the product-native runner.
- `package`: carrier assembly or inspection; it never publishes.
- `smoke`: one runtime happy path for that product.
- `regression`: broader SQL, protocol, extension, lifecycle, or runtime
  regression suites.
- `perf-tools:*-plan`: benchmark plan/report validation only.
- `perf-tools:*-measure`: measured benchmark execution.
- `<product>:coverage`: runs product-native measured line coverage and writes
  machine-readable reports under `target/coverage/<product>/`.

`check` and `test` must not call the same command for SDK products. `test`
must run tests, not metadata-only checks. `smoke` targets must be explicit
runtime probes and must be run with `--cache off` in CI/release evidence lanes
where current device/simulator/runtime state matters.

Native and WASIX runtime prerequisites are owned by their runtime projects. Rust,
Swift, Kotlin, TypeScript, and WASIX smoke/regression lanes use that helper for
host liboliphaunt, Android liboliphaunt, iOS simulator probe, and WASIX
asset/AOT checks. Static, package, unit, and coverage lanes remain
artifact-light; they may warn about missing local runtimes but must not claim
runtime evidence. React Native installed-app smokes delegate runtime
materialization to the Expo platform scripts and hard-fail there if native
artifacts cannot be built or located.

The Linux native consumer job also owns these uncached SDK runtime suites:

- `oliphaunt-rust:test-integration`: native smoke and SQL behavior.
- `oliphaunt-mobile-bindings:test-native`: shared broker streaming and lifecycle.
- `oliphaunt-swift:test-native`: Swift native runtime behavior.
- `oliphaunt-kotlin:test-native-bindings`: Kotlin native binding behavior.

They consume the same-run packaged runtime, with tools and broker archives when
needed. The shared `src/native/sdks/tests/with-runtime.sh` stages each invocation
in an isolated temporary directory; Moon retains the producers for local runs
and the hosted transfer runner substitutes downloaded artifacts. Swift/Kotlin
share one generated binding dependency. These suites require executed tests and
valid runtime inputs; zero tests or unavailable artifacts cannot pass as proof.

`oliphaunt-wasix-rust:test-integration` runs the standard and ICU seed resource
tests in the existing WASIX regression job, consuming its portable runtime/AOT
and same-run database resource artifacts. This host coverage supplements the
installed mobile apps and per-platform package checks.

React Native installed-app smoke is split by platform:

```sh
moon run integration-examples:react-native-android-e2e
moon run integration-examples:react-native-ios-e2e
```

PR jobs run RN static, unit, Codegen, JSI, config-plugin, and package checks.
Affected PR, main, and explicit manual lanes run the installed Android/iOS app
smokes selected by the CI plan.

Installed-app SDK smoke runs the real app on a hosted emulator or simulator.
The app performs the SQL, extension, and resource assertions itself. CI and
manual replay share `.github/actions/run-mobile-e2e`; both require a validated
structured receipt from continuous logs captured for that launch. Explicit
failure, app death, dead capture, and a missing receipt fail within the smoke
budget. Lifecycle and crash-recovery drills retain their separate assertions.

The native Node addon uses the Rust Node-API adapter. It no longer downloads
Node C headers or a separate Windows import library through a custom fallback.

The default installed-app path must remain free and public-checkout
reproducible. Paid hosted-device providers, SaaS-only runners, and required
private runner infrastructure are not part of the default proof path. When
mobile E2E breaks, inspect the selected implementation first: app artifact shape,
simulator/emulator setup, exact-launch logs, receipts, and CI runner assumptions.
Debug the chosen implementation first. Do not restart provider research unless
the failure proves a concrete requirement this model cannot satisfy.

## Coverage

Coverage is measured evidence, not a policy-only check. Product tasks run the
native reporter for their ecosystem: `cargo-llvm-cov` for Rust and WASIX library
coverage, `swift test --enable-code-coverage` for Swift, Kover for Kotlin, and
Vitest V8 coverage for TypeScript and React Native TypeScript code. Run
`moon run <product>:coverage` for that product's native reports under
`target/coverage/<product>/`. There is no repository coverage aggregate or
shared summary-file contract. Coverage is an explicit measurement, separate from
the required source-test and release gates.

Rust and WASIX executable unit tests run through `cargo nextest` with the `ci`
profile. Unit lanes still run doctests through `cargo test --doc` because
nextest does not own doctest execution. Coverage lanes measure line coverage
through `cargo llvm-cov nextest`; they do not recompile doctests after the unit
lane has already established that correctness evidence. Doctest coverage itself
requires nightly rustdoc flags, so it is not part of the default stable LCOV gate.
WASIX library unit coverage intentionally uses `--no-default-features`.
WASIX doctests run with the `tools` feature because the README contains
tools-gated examples. The `public_api` lane separately enables one exact leaf
extension feature to compile-check its root selector. Runtime Postgres/WASIX
execution stays in `smoke` and `regression`, where missing runtime assets must
fail or skip explicitly according to the lane policy.

TypeScript and React Native packages invoke Vitest directly. The coverage runner
invokes the same test directories with Vitest V8 coverage enabled. React
Native native adapter compile checks, Codegen checks, Expo prebuild/app wiring,
and installed-device smokes remain separate package or runtime lanes; Vitest
coverage is only evidence for TypeScript API/config/JSI contract code.

Coverage is an optional product-owned diagnostic. Each SDK invokes its native
coverage tool directly; normal CI runs its unit tasks once. Reports remain under
`target/coverage/<product>/`. There is no cross-language percentage gate, source
scanner, waiver ledger, or second test execution layer.

Run coverage for one product with `moon run <product>:coverage`. To select all
product coverage tasks (requiring their respective toolchains):

```sh
moon run :coverage
moon run :coverage --affected
```

## WASIX Runtime Tests

Extension lifecycle qualification tests physical backup/restore, reopening the
restored database and verifying existing extension state without rerunning setup.
Logical `pg_dump`/`psql` tests are separate and prove only their tested fixtures.
In particular, pinned pg_ivm 1.13 does not preserve incremental-view maintenance
through a plain logical dump/restore: use physical backup/restore for those
databases. Upstream introduced metadata export and `restore_immv` in pg_ivm 1.15;
adopting that release requires the normal extension source and platform qualification.

`oliphaunt-wasix` is intended for tests that need real Postgres semantics without
Docker.

Use the default memory database when the code under test can call the direct
Rust API:

```rust,no_run
use oliphaunt_wasix::Oliphaunt;

#[test]
fn stores_rows() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::open()?;

    db.execute("CREATE TABLE items (id int primary key, name text)")?;
    db.execute("INSERT INTO items VALUES (1, 'alpha')")?;

    let rows = db.query("SELECT name FROM items WHERE id = 1")?;
    assert_eq!(rows.get_text(0, "name")?, Some("alpha"));

    db.close()?;
    Ok(())
}
```

Tests that specifically exercise `initdb` invoke the packaged WASIX tool.
Ordinary embedded open uses the packaged cluster seed, and physical restore is tested
through the dedicated restore API rather than an initialization selector.

## Server Tests

Use `OliphauntServer` when the application already talks to Postgres through a
client library:

```rust,no_run
use oliphaunt_pgwire_server::AsyncOliphauntServer;
use sqlx::{Connection, Row};

#[tokio::test]
async fn sqlx_query() -> Result<(), Box<dyn std::error::Error>> {
    let server = AsyncOliphauntServer::builder().start().await?;
    let mut conn = sqlx::PgConnection::connect(&server.connection_string()).await?;

    let row = sqlx::query("SELECT $1::int4 + 1 AS n")
        .bind(41_i32)
        .fetch_one(&mut conn)
        .await?;
    assert_eq!(row.try_get::<i32, _>("n")?, 42);

    conn.close().await?;
    server.close().await?;
    Ok(())
}
```

Keep client pools at one connection.

## Extension Tests

Select extension runtime artifacts through the builder, then let migrations
install the database-local objects:

```rust,no_run
use oliphaunt_wasix::{Extension, Oliphaunt};

#[test]
fn vector_query() -> Result<(), Box<dyn std::error::Error>> {
    let mut db = Oliphaunt::builder()
        .extension(Extension::VECTOR)
        .open()?;

    db.execute("CREATE EXTENSION vector")?;
    db.execute("CREATE TABLE items (embedding vector(3))")?;
    db.execute("INSERT INTO items VALUES ('[1,2,3]')")?;
    let rows = db.query("SELECT embedding <-> '[1,2,4]' AS distance FROM items")?;
    assert!(rows.get_text(0, "distance")?.is_some());

    db.close()?;
    Ok(())
}
```

The builder resolves bundled dependencies and any generated startup
configuration before PostgreSQL starts. Extension selection is not a post-open
lifecycle operation.

## Physical Fixture Setup

Use `backup()` and static `restore()` when a test suite needs a pre-populated
same-version independent root:

```rust,no_run
use oliphaunt_wasix::{DatabaseStorage, Oliphaunt};

#[test]
fn clone_fixture() -> Result<(), Box<dyn std::error::Error>> {
    let mut seed = Oliphaunt::open()?;
    seed.execute("CREATE TABLE items(value TEXT)")?;
    seed.execute("INSERT INTO items VALUES ('alpha')")?;
    let backup = seed.backup()?;
    seed.close()?;

    let parent = tempfile::tempdir()?;
    let root = parent.path().join("clone");
    Oliphaunt::restore(&root, backup)?;
    let mut clone = Oliphaunt::builder()
        .storage(DatabaseStorage::Directory(root))
        .open()?;
    assert_eq!(clone.query("SELECT value FROM items")?.get_text(0, "value")?, Some("alpha"));

    clone.close()?;
    Ok(())
}
```

Use logical dumps, not physical archives, when you need a portable export.

## Cross-Language Clients

Use `oliphaunt-pgwire-server` when the test process lives outside Rust:

```sh
oliphaunt-pgwire-server --memory --print-uri
```

Pass the printed URI to Python `psycopg`, Go `pgx`, Node `pg`, or another
standard Postgres client.

## COPY And Raw Protocol Tests

Direct `Oliphaunt` supports `/dev/blob` for `COPY TO` and `COPY FROM`. Server
mode supports ordinary client-driven `COPY FROM STDIN` and other standard wire
protocol flows through the local Postgres endpoint. Native SDK regression tests
exercise callback-streamed raw responses in direct, broker, server, and
transaction-owned sessions; language unit tests lock callback forwarding at
the Swift, Kotlin, React Native, and desktop TypeScript facades.
