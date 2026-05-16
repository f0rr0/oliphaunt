# PG18 Branch Validation

Date: 2026-05-15

This branch is not ready to promote over the PostgreSQL 17 WASIX lane yet, but
the core PG18 native-direct path is viable.

## What Passed

- `LIBPGLITE_BUILD_EXTENSIONS=0 libpglite/bin/build-postgres18-macos.sh`
- `cargo run -p xtask -- assets fetch`
- `libpglite/bin/build-postgres18-macos.sh` with native extensions enabled.
  The rebuilt artifact contains `35` extension control files and `35`
  embedded `.dylib` modules.
- `libpglite/bin/smoke-macos-happy-path.sh`
- `cargo fmt --check`
- `cargo test -p libpglite-oxide -- --nocapture` (`37 passed`)
- `LIBPGLITE_OXIDE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib cargo test -p libpglite-oxide --test sdk_shape native_libpglite_runtime_select_one_when_env_is_available -- --nocapture`
  validates high-level queries, parameterized execution, reusable prepared
  statements, describe-query metadata, `LISTEN`/`NOTIFY`/`UNLISTEN`,
  `CHECKPOINT`, typed unsupported backup errors, transaction drop rollback, and
  commit-time database errors against the native PG18 runtime. The smoke also
  confirms parsed `ReadyForQuery` transaction status and table-backed column
  metadata from the real backend.
- `PGLITE_OXIDE_NATIVE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib cargo test -p pglite-oxide --test native_libpglite_smoke -- --nocapture`
- `PGLITE_OXIDE_NATIVE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib PGLITE_OXIDE_POSTGRES_REGRESSION_NATIVE=1 cargo test -p pglite-oxide --test native_libpglite_smoke --test postgres_regression -- --nocapture`
- `PGLITE_OXIDE_NATIVE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib cargo test -p pglite-oxide --test native_libpglite_extensions -- --nocapture`
- Native template bootstrap now caches a PostgreSQL 18 PGDATA template built
  with the install-tree `initdb`, clones it for default `postgres` template
  opens, and leaves custom-user or `FreshInitdb` opens on the explicit initdb
  path. This reduced the measured SDK `pglite_init` phase from hundreds of
  milliseconds to `20.43 ms` in the latest open-profile sanity run.
- The native PGDATA template cache is keyed by the native install fingerprint
  instead of being a single process-wide winner. This keeps in-process tests and
  apps from accidentally reusing a template produced by a different PG18 build.
- `cargo test -p pglite-oxide --lib --no-default-features -- --nocapture`
- `cargo test -p pglite-oxide --tests -- --nocapture` in a source-only
  checkout now passes with runtime-dependent WASIX tests explicitly skipped when
  bundled/generated assets are absent. With generated assets installed, the same
  tests run normally.
- `tools/scripts/validate.sh test`
- `cargo check -p pglite-oxide --lib --bins`
- `cargo check -p xtask`
- `cargo clippy -p libpglite-oxide --all-targets -- -D warnings`
- `cargo clippy -p pglite-oxide --all-targets -- -D warnings`
- `cargo clippy -p pglite-oxide --lib --bins -- -D warnings`
- `cargo clippy -p xtask -- -D warnings`
- `LIBPGLITE_OXIDE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib LIBPGLITE_OXIDE_INITDB=$PWD/target/libpglite-pg18/install/bin/initdb LIBPGLITE_OXIDE_POSTGRES=$PWD/target/libpglite-pg18/install/bin/postgres target/release/xtask perf native-libpglite-sdk --iterations 1000`
- `LIBPGLITE_OXIDE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib LIBPGLITE_OXIDE_INITDB=$PWD/target/libpglite-pg18/install/bin/initdb LIBPGLITE_OXIDE_POSTGRES=$PWD/target/libpglite-pg18/install/bin/postgres target/release/xtask perf native-libpglite-open`
- `target/release/xtask perf native-postgres-open --postgres-bin $PWD/target/libpglite-pg18/install/bin/postgres --initdb-bin $PWD/target/libpglite-pg18/install/bin/initdb`
- `tools/scripts/perf/run_native_libpglite_matrix.sh --run-id pg18-sdk-matrix-smoke-20260514T220849Z --rtt-iterations 5 --sdk-iterations 50 --speed-repeats 1 --skip-build --skip-wasix --skip-prepared --speed-source generated`
- `tools/scripts/perf/run_native_libpglite_matrix.sh --run-id pg18-open-profile-smoke-20260514T224439Z --rtt-iterations 3 --sdk-iterations 10 --speed-repeats 1 --skip-build --skip-wasix --skip-prepared --speed-source generated`
- `tools/scripts/perf/run_native_libpglite_matrix.sh --run-id pg18-dirsymlink-native-20260515T002500Z-r100-s3 --rtt-iterations 100 --sdk-iterations 1000 --speed-repeats 3 --skip-build --skip-wasix --skip-prepared --speed-source generated`
- `tools/scripts/perf/run_native_libpglite_matrix.sh --run-id pg18-dirsymlink-native-20260515T003500Z-r30-s10 --rtt-iterations 30 --sdk-iterations 1000 --speed-repeats 10 --skip-build --skip-wasix --skip-prepared --speed-source generated`
- `tools/scripts/perf/run_native_libpglite_matrix.sh --run-id pg18-keyed-template-20260515T0012Z-r100-s3 --rtt-iterations 100 --sdk-iterations 1000 --speed-repeats 3 --skip-build --skip-wasix --skip-prepared`
- `tools/scripts/perf/run_native_libpglite_matrix.sh --run-id pg18-parity-settings-20260515T0115Z-r100-s3 --rtt-iterations 100 --sdk-iterations 1000 --speed-repeats 3 --skip-build --skip-wasix --skip-prepared`
- `target/release/xtask perf diagnose-speed-cases --ids 1 --engine native-libpglite --speed-source pglite --postgres-config <name>=<value>`
- `target/release/xtask perf diagnose-speed-cases --ids 1 --engine native-postgres --speed-source pglite --postgres-config <name>=<value>`
- `target/release/xtask perf diagnose-speed-cases --ids 16 --engine native-libpglite --speed-source generated`
- `target/release/xtask perf diagnose-speed-cases --ids 4 --engine native-libpglite --speed-source generated`
- `target/release/xtask perf diagnose-speed-cases --ids 4 --engine native-postgres --speed-source generated`
- `target/release/xtask perf diagnose-speed-cases --ids 16 --engine native-postgres --speed-source generated`
- `bash -n tools/scripts/perf/run_native_libpglite_matrix.sh`
- `node --check tools/scripts/perf/summarize_native_libpglite_matrix.mjs`
- `git diff --check`

## What Failed Or Was Blocked

- Full WASIX runtime validation is still blocked in this checkout because no
  compatible generated asset bundle exists for this branch fingerprint.
  `cargo run -p xtask -- assets download --latest-compatible --target-triple
  aarch64-apple-darwin` rejected recent Assets workflow runs whose downloaded
  asset-input fingerprints did not match this checkout and ended with `no
  compatible successful Assets workflow artifact found`.
- Source-only checkouts cannot run the full native extension gate until
  `cargo run -p xtask -- assets fetch` has populated ignored upstream
  `assets/checkouts/*` source trees.
- Native server mode is not implemented. It should not be faked over the
  single-session direct C ABI. The default `LibPgliteRuntime` now rejects
  native-server and native-broker modes, and native direct capabilities do not
  advertise PostgreSQL connection strings. The explicit `NativeServerRuntime`
  and `NativeBrokerRuntime` scaffolds return typed `UnsupportedFeature` errors
  for their correct modes that describe the missing process/ABI contracts.
- Same-process native reopen is still not supported by libpglite v1.
- Native direct backup/export is not implemented. The SDK now exposes typed
  `UnsupportedFeature` errors for logical SQL, physical archive, and product
  archive requests instead of opaque engine strings. Implementing this safely
  needs a server/broker path, a pg_dump-compatible path, or a future native
  backup ABI because direct v1 cannot quiesce and reopen the same embedded
  process.
- Native libpglite startup now beats the native PostgreSQL initdb+server-open
  control in the repeated native-only matrix after cached PGDATA template
  cloning. The matrix now gates total RSS by adding native PostgreSQL client RSS
  and observed server-process-tree RSS, which is the fair comparison against
  in-process native direct RSS. The current dominant SDK open phase is template
  clone (`173.98 ms` in the parity-settings matrix), not `initdb`.

## Quick Benchmarks

Reduced local runs were written under:

```text
target/perf/quick-pg18-validation/
```

RTT command:

```sh
cargo run --release -p xtask -- perf native-libpglite --suite rtt --iterations 10
cargo run --release -p xtask -- perf native-postgres --suite rtt --iterations 10 --client tokio-postgres-simple
```

Result:

- PG18 native-direct mean RTT average across cases: `38.61 us`
- Native PostgreSQL 18 through `tokio-postgres` mean RTT average: `63.33 us`
- PG18 native-direct open: `613 ms`
- Native PostgreSQL open plus connect: `476 ms`

Generated speed-suite command:

```sh
cargo run --release -p xtask -- perf native-libpglite --suite speed --speed-source generated
cargo run --release -p xtask -- perf native-postgres --suite speed --speed-source generated --client tokio-postgres-simple
```

Result:

- PG18 native-direct total: `1.740 s`
- Native PostgreSQL 18 total: `1.742 s`
- Ratio: `0.999x`

Interpretation: steady-state direct execution is close to native Postgres and
often faster on RTT. Startup is not yet equal to native Postgres. Treat these
quick one-shot numbers as smoke evidence only; the repeated matrix below is the
stronger benchmark signal.

## Generated Native Matrix

The native matrix runner was fixed to resolve the repository root correctly and
to make the speed SQL source configurable. This lets the matrix run without the
missing vendored PGlite checkout while still producing `/usr/bin/time` CPU, RSS,
and footprint data. The runner also includes the high-level Rust SDK
microbenchmark so `query_params` and reusable `PreparedStatement` latency are
visible in the same promotion report as backend throughput and resource use.

Command:

```sh
tools/scripts/perf/run_native_libpglite_matrix.sh \
  --run-id pg18-generated-native-20260514T203258Z-r100-s3 \
  --rtt-iterations 100 \
  --speed-repeats 3 \
  --skip-wasix \
  --skip-prepared \
  --skip-build \
  --speed-source generated
```

Report:

```text
target/perf/native-libpglite-pg18-generated-native-20260514T203258Z-r100-s3/report.md
```

Headline results:

- Native libpglite direct RTT median p90: `66 us`
- Native PostgreSQL 18 `tokio-postgres` RTT median p90: `95 us`
- Native libpglite direct speed suite p90 across 3 fresh processes: `1.777 s`
- Native PostgreSQL 18 `tokio-postgres` speed suite p90 across 3 fresh processes:
  `1.782 s`
- Native libpglite direct open p90: `576.13 ms`
- Native PostgreSQL 18 open p90: `495.77 ms`
- Native libpglite direct peak RSS in speed suite: `122.9 MB`

The SDK-report smoke run is:

```text
target/perf/native-libpglite-pg18-sdk-matrix-smoke-20260514T220849Z/report.md
```

It verified that the matrix emits a `Rust SDK API Latency` section. With 50
samples, `query_params` was p50 `18 us` / p90 `21 us`, and reusable
`PreparedStatement` was p50 `12 us` / p90 `15 us`. This smoke run used
`--skip-wasix`, `--skip-prepared`, one speed repeat, and only 5 RTT samples, so
its backend performance rows are validation of the report path rather than
research-grade evidence.
- Native PostgreSQL 18 client plus observed server RSS baseline: `128.3 MB`

The open-profile smoke run is:

```text
target/perf/native-libpglite-pg18-open-profile-smoke-20260514T224439Z/report.md
```

It adds an `Open Phase Profile` section to the matrix report. In that run,
native libpglite SDK open was `527.12 ms`, with `111.84 ms` in runtime share
tree materialization and `407.84 ms` in `pglite_init`; first query after open
was `332 us`. The native PostgreSQL control open was `439.93 ms`, with
`404.92 ms` in external `initdb`, `33.95 ms` in server readiness, `1.48 ms`
client connect, and `124 us` first query. This confirms the startup miss is
mostly per-open runtime materialization plus embedded init/startup, not
high-level SDK query overhead.

The symlink-materialization smoke run is:

```text
target/perf/native-libpglite-pg18-symlink-open-smoke-20260515T000000Z/report.md
```

It keeps `bin/postgres` and `bin/initdb` copied into the runtime root, but
materializes runtime share files and PostgreSQL loadable modules as symlinks on
Unix with a copy fallback. A follow-up pass symlinked fully accepted share
subtrees such as `timezone` and `timezonesets`, while keeping filtered
directories such as `extension` and selected `tsearch_data` files under
per-file materialization. The native smoke test also creates and calls a
`plpgsql` function, proving that `$libdir/plpgsql` still resolves to the
embedded module through the new layout.

In the reduced matrix smoke, native libpglite SDK open was `463.43 ms`, with
`46.99 ms` in `native.open.runtime.materialize_share_tree`, `1.96 ms` in
`native.open.runtime.materialize_library_tree`, and `412.35 ms` in
`pglite_init`; first query after open was `334 us`. The native PostgreSQL
control open was `479.39 ms`, with `439.56 ms` in external `initdb`,
`39.15 ms` in server readiness, `1.32 ms` client connect, and `111 us` first
query. The reduced matrix also measured native libpglite direct RTT median p90
at `92 us` versus native PostgreSQL `tokio-postgres` at `210 us`, and speed
suite p90 at `1.611 s` versus `1.648 s`. Two generated speed cases missed the
5% per-case tolerance in this one-repeat smoke, so this run validates the
materialization direction and report path but is not research-grade promotion
evidence.

The directory-symlink repeated matrix is:

```text
target/perf/native-libpglite-pg18-dirsymlink-native-20260515T002500Z-r100-s3/report.md
```

Command:

```sh
tools/scripts/perf/run_native_libpglite_matrix.sh \
  --run-id pg18-dirsymlink-native-20260515T002500Z-r100-s3 \
  --rtt-iterations 100 \
  --sdk-iterations 1000 \
  --speed-repeats 3 \
  --skip-wasix \
  --skip-prepared \
  --skip-build \
  --speed-source generated
```

Headline results:

- Native libpglite SDK open profile: `427.50 ms`, including `6.78 ms` in
  `native.open.runtime.materialize_share_tree`, `1.86 ms` in
  `native.open.runtime.materialize_library_tree`, and `416.68 ms` in
  `pglite_init`
- Native PostgreSQL control open profile: `484.73 ms`, including `448.48 ms`
  in external `initdb` and `35.59 ms` waiting for readiness
- Native libpglite direct RTT median p90: `47 us`
- Native PostgreSQL 18 `tokio-postgres` RTT median p90: `62 us`
- Native libpglite direct speed suite p90 across 3 fresh processes: `1.665 s`
- Native PostgreSQL 18 `tokio-postgres` speed suite p90 across 3 fresh
  processes: `1.655 s`
- Native libpglite direct speed-open p90: `429.94 ms`
- Native PostgreSQL 18 speed-open p90: `479.67 ms`
- Native libpglite direct speed p90 RSS: `124.9 MB`
- Native PostgreSQL 18 observed server-inclusive p90 RSS baseline: `123.2 MB`
- Rust SDK `query_params` p50 `16 us` / p90 `22 us`; reusable
  `PreparedStatement` p50 `12 us` / p90 `15 us`

This run passes the report's native-direct gates for RTT, suite throughput,
open latency, and RSS. Two generated speed cases still miss the 5% per-case
tolerance: test 14 (`1.095x`) and test 16 (`1.077x`). Treat that as a remaining
query-shape investigation, not as a startup blocker.

The 10-repeat generated-speed matrix is:

```text
target/perf/native-libpglite-pg18-dirsymlink-native-20260515T003500Z-r30-s10/report.md
```

It reduces the RTT sample count to 30 but raises fresh-process speed repeats to
10, so the per-case speed table is less sensitive to max-of-three noise.

Headline results:

- Native libpglite SDK open profile: `485.73 ms`, including `7.50 ms` in
  `native.open.runtime.materialize_share_tree`, `2.05 ms` in
  `native.open.runtime.materialize_library_tree`, and `473.99 ms` in
  `pglite_init`
- Native PostgreSQL control open profile: `494.49 ms`
- Native libpglite direct RTT median p90: `43 us`
- Native PostgreSQL 18 `tokio-postgres` RTT median p90: `64 us`
- Native libpglite direct speed suite p90 across 10 fresh processes: `1.708 s`
- Native PostgreSQL 18 `tokio-postgres` speed suite p90 across 10 fresh
  processes: `1.885 s`
- Native libpglite direct speed-open p90: `494.72 ms`
- Native PostgreSQL 18 speed-open p90: `488.37 ms`
- Native libpglite direct speed p90 RSS: `125.4 MB`
- Native PostgreSQL 18 observed server-inclusive p90 RSS baseline: `128.4 MB`
- Rust SDK `query_params` p50 `17 us` / p90 `18 us`; reusable
  `PreparedStatement` p50 `13 us` / p90 `13 us`

This stronger repeat count removes the earlier case 14 miss. The remaining
per-case misses are test 4 (`1.061x`) and test 16 (`1.645x`). Test 16 is a tiny
five-statement `DROP TABLE` teardown case where p90 is highly sensitive to
millisecond-scale tails: the 10 direct samples ranged from `2.50 ms` to
`10.15 ms`, while native PostgreSQL ranged from `2.58 ms` to `8.54 ms`.

Targeted native diagnostics for generated test 16 were captured under:

```text
target/perf/native-libpglite-pg18-dirsymlink-native-20260515T003500Z-r30-s10/native-libpglite-diagnose-speed-16-*.json
target/perf/native-libpglite-pg18-dirsymlink-native-20260515T003500Z-r30-s10/native-postgres-diagnose-speed-16.json
```

The 10 native-libpglite diagnostic runs ranged from `2.42 ms` to `3.96 ms`,
with almost all time in `client.protocol_transport_send`. The native PostgreSQL
diagnostic measured `2.74 ms` for the same generated target case after the same
setup sequence. The native filesystem trace is not active in the direct engine
path, and the diagnostics did not reproduce the matrix's `9-10 ms` tail. Treat
test 16 as benchmark tail variance unless a future statement-level sampler
reproduces a direct-mode-only stall.

Targeted diagnostics for generated test 4 were captured under:

```text
target/perf/native-libpglite-pg18-dirsymlink-native-20260515T003500Z-r30-s10/native-libpglite-diagnose-speed-4.json
target/perf/native-libpglite-pg18-dirsymlink-native-20260515T003500Z-r30-s10/native-postgres-diagnose-speed-4.json
target/perf/native-libpglite-pg18-dirsymlink-native-20260515T003500Z-r30-s10/native-libpglite-diagnose-speed-4-*.json
target/perf/native-libpglite-pg18-dirsymlink-native-20260515T003500Z-r30-s10/native-postgres-diagnose-speed-4-*.json
```

The first one-shot diagnostic measured native libpglite at `92.82 ms` and
native PostgreSQL at `88.66 ms`. Native-libpglite spent `92.62 ms` in
`client.protocol_transport_send`; parsing and finish phases were sub-`0.2 ms`.
A follow-up 10-run diagnostic distribution was tighter than the matrix p90:
native libpglite ranged from `87.94 ms` to `92.12 ms`, with p50 `91.03 ms` and
p90 `91.30 ms`; native PostgreSQL ranged from `85.98 ms` to `92.26 ms`, with
p50 `87.39 ms` and p90 `88.43 ms`. The diagnostic p90 ratio is `1.032x`, so
the generated no-index scan delta is below the 5% tolerance under targeted
statement-level measurement. The matrix-level test 4 miss is therefore a
candidate for repeat noise or suite-context tail behavior, not SDK parsing
overhead.

Gate status:

- RTT latency passes with substantial headroom.
- Speed suite total passes the 5% native PostgreSQL tolerance in the 10-repeat
  matrix at `0.906x`.
- Startup/open passes in the latest repeated matrix. The copy-based run missed
  at `1.162x`; file symlinks reduced share materialization to about `47-48 ms`,
  and directory symlinks reduced it to `6.78-7.50 ms` in the latest open
  profiles.
- RSS passes the report gate in the 10-repeat generated suite at `0.977x`, but it
  is close enough that full promotion should keep RSS/footprint in the
  acceptance matrix.
- Two generated speed cases miss the 5% native PostgreSQL per-case tolerance in
  the 10-repeat run. Test 16 did not reproduce under isolated native and native
  PostgreSQL diagnostics. Test 4 reproduced only as a sub-5% targeted
  statement-level delta. The current evidence supports keeping generated
  per-case misses as a watch item rather than a blocking direct-runtime
  regression.

This is strong enough to keep investing in native direct mode but not strong
enough to claim that PG18 comprehensively matches native PostgreSQL yet. The
remaining startup variance, `pglite_init` cost, missing WASIX assets, missing
external extension sources, and lack of a real server/broker path all need
root-cause work before this lane can replace the PG17 stable lane.

## Native SDK Prepared Microbenchmark

The high-level Rust SDK path is measured directly with:

```sh
LIBPGLITE_OXIDE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib \
LIBPGLITE_OXIDE_INITDB=$PWD/target/libpglite-pg18/install/bin/initdb \
LIBPGLITE_OXIDE_POSTGRES=$PWD/target/libpglite-pg18/install/bin/postgres \
target/release/xtask perf native-libpglite-sdk --iterations 1000
```

Result file:

```text
target/perf/sdk-prepared/native-libpglite-sdk-1000.json
```

Result:

- `query_params` unnamed parse/bind/execute per call: p50 `16 us`, p90 `18 us`,
  p95 `20 us`, average `16.32 us`
- reusable `PreparedStatement`: p50 `10 us`, p90 `15 us`, p95 `16 us`,
  average `11.19 us`

Interpretation: the public prepared-statement API is measurably useful even in
direct mode, and this benchmark should become part of the promotion gate for
the PG18 SDK surface.

## Full Extension Artifact Follow-Up

After fetching pinned upstream source checkouts with `cargo run -p xtask --
assets fetch`, the native PG18 build with extensions enabled completed
successfully. The first extension smoke attempt had failed because the local
artifact was built with only `plpgsql`; after the rebuild:

- `target/libpglite-pg18/install/share/postgresql/extension` contained `35`
  control files.
- `target/libpglite-pg18/out/modules` contained `35` embedded `.dylib` modules.
- `PGLITE_OXIDE_NATIVE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib cargo test -p pglite-oxide --test native_libpglite_extensions -- --nocapture`
  passed all three tests, including child-process smoke for every advertised
  PG18 native extension.

## Cached Native Template Perf Sanity

Commands:

```sh
LIBPGLITE_OXIDE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib \
cargo run --release -p xtask -- perf native-libpglite-sdk --iterations 1000

PGLITE_OXIDE_NATIVE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib \
cargo run --release -p xtask -- perf native-libpglite --suite rtt --iterations 1000

cargo run --release -p xtask -- perf native-postgres --suite rtt \
  --client tokio-postgres-simple --iterations 1000

PGLITE_OXIDE_NATIVE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib \
cargo run --release -p xtask -- perf native-libpglite --suite speed

cargo run --release -p xtask -- perf native-postgres --suite speed \
  --client tokio-postgres-simple
```

Results:

- Native-libpglite SDK open profile: `207.82 ms`, including `171.55 ms` in
  `native.open.prepare_root.clone_pgdata_template`, `20.43 ms` in
  `native.open.pglite_init`, `10.66 ms` in share-tree materialization, and
  `1.95 ms` in library-tree materialization.
- Native PostgreSQL open profile: `467.07 ms` including client connect, with
  `424.45 ms` in `initdb` and `39.92 ms` waiting for readiness.
- Native-libpglite direct RTT open in the 1000-iteration run: `216.61 ms`.
- Native-libpglite RTT was faster than the prior socketed native PostgreSQL RTT
  control across all 12 CRUD RTT cases in the 1000-iteration sanity run.
- Speed suite open: native-libpglite `250.67 ms` versus native PostgreSQL
  `558.78 ms` including client connect.
- Speed suite total was `1.865 s` for native-libpglite versus `1.834 s` for
  socketed native PostgreSQL in the one-shot run, ratio `1.017x`. This is close
  but not a clean throughput win; use the repeated matrix before making a
  promotion claim.

## Upstream PGlite Native Matrix

Command:

```sh
LIBPGLITE_OXIDE_LIBPGLITE=$PWD/target/libpglite-pg18/out/libpglite.dylib \
LIBPGLITE_OXIDE_POSTGRES=$PWD/target/libpglite-pg18/install/bin/postgres \
LIBPGLITE_OXIDE_INITDB=$PWD/target/libpglite-pg18/install/bin/initdb \
tools/scripts/perf/run_native_libpglite_matrix.sh \
  --run-id pg18-parity-settings-20260515T0115Z-r100-s3 \
  --rtt-iterations 100 \
  --sdk-iterations 1000 \
  --speed-repeats 3 \
  --skip-wasix \
  --skip-prepared \
  --skip-build
```

Report:

```text
target/perf/native-libpglite-pg18-parity-settings-20260515T0115Z-r100-s3/report.md
```

Results:

- Native control: `postgres (PostgreSQL) 18.3`.
- Speed source: exact upstream PGlite SQL files from
  `assets/checkouts/pglite/packages/benchmark/src`.
- Native PostgreSQL controls now run with the same captured PGlite startup
  defaults for `search_path=public`, `exit_on_error=off`, `TimeZone=UTC`, and
  `log_timezone=UTC`, in addition to the existing durability, buffer, worker,
  and autovacuum settings.
- Native-libpglite SDK open profile: `200.03 ms`, with `173.98 ms` in
  `native.open.prepare_root.clone_pgdata_template`, `13.05 ms` in
  `native.open.pglite_init`, `8.88 ms` in share-tree materialization, and
  `1.94 ms` in library-tree materialization.
- Native PostgreSQL control open: `425.89 ms` open plus `1.25 ms` connect, with
  `390.52 ms` in `initdb`.
- RTT median p90: native-libpglite `39 us` versus native PostgreSQL tokio simple
  `63 us`, ratio `0.619x`, passing the 5% gate.
- Speed suite p90: native-libpglite `1.802 s` versus native PostgreSQL tokio
  simple `1.778 s`, ratio `1.013x`, passing the 5% gate.
- Speed open p90: native-libpglite `201.53 ms` versus native PostgreSQL tokio
  simple `424.84 ms`, ratio `0.474x`, passing the 5% gate.
- Speed p90 total RSS: native-libpglite `135.8 MB` versus native PostgreSQL
  client plus observed server-process-tree RSS `219.0 MB`, ratio `0.620x`,
  passing the 5% gate. The earlier process/max-server comparison undercounted
  the external native PostgreSQL control.
- Per-case speed misses above 5%: test 1 inserts (`1.729x`), test 3 indexed
  inserts (`1.098x`), test 6 index creation (`1.075x`), test 7 indexed selects
  (`1.093x`), test 11 insert-from-select (`1.086x`), test 13 indexed delete
  (`1.079x`), and test 16 drop table (`1.195x`).
- Rust SDK latency: `query_params` p50 `16 us`, p90 `18 us`; reusable
  `PreparedStatement` p50 `10 us`, p90 `15 us`.

Interpretation: native direct now passes the headline open, RTT, and upstream
PGlite speed-suite gates against native PostgreSQL in this local native-only
matrix. It is not yet a promotion-quality claim because several individual speed
cases miss tolerance, WASIX lane controls were skipped due the asset blocker,
and the matrix needs more repeats on an isolated machine before we call it
production evidence.

Focused follow-up diagnostics:

- `target/release/xtask perf diagnose-speed-cases --ids 1,3,4,6 --engine
  native-postgres --speed-source pglite`
- `target/release/xtask perf diagnose-speed-cases --ids <id> --engine
  native-libpglite --speed-source pglite` once per id because native libpglite
  v1 is one-open-per-process.
- `target/release/xtask perf diagnose-speed-cases ... --postgres-config
  <name>=<value>` for matched native-libpglite/native-PostgreSQL GUC override
  experiments.

Results:

- Captured settings now prove native-libpglite and native PostgreSQL controls
  match on `shared_buffers`, `fsync`, `full_page_writes`, `synchronous_commit`,
  `wal_buffers`, `work_mem`, `jit`, `autovacuum`, worker counts,
  `exit_on_error`, `search_path`, and `TimeZone`.
- Case 1 remained a real miss after settings parity. Three focused repeats were
  stable at native-libpglite `9.38-9.43 ms` versus native PostgreSQL
  `5.93-6.02 ms`, ratio `1.57-1.58x`. Protocol tracing showed the measured time
  is backend wait, while input copy, output append, ready scan, and response copy
  were each single-digit microseconds.
- A local backend-only timing probe in the generated PostgreSQL 18 tree (removed
  after the experiment) broke the native-libpglite case 1 simple query into
  `1001` statements in one implicit block: traced total `11.90 ms`, parse
  `0.70 ms`, analyze/plan `3.48 ms`, portal execution `7.03 ms`, final
  transaction close `0.21 ms`, command-counter work `0.02 ms`, and command
  completion output `0.05 ms`. The paired native protocol trace for the same
  request was `78,724` request bytes and `16,024` response bytes with
  `11.93 ms` waiting for the backend and only microseconds in host copy/scan
  paths.
- GUC override experiments did not explain case 1. Native-libpglite stayed in
  the same band with `full_page_writes=off` (`9.44 ms`),
  `synchronous_commit=off` (`9.48 ms`), `track_counts=off` plus
  `track_activities=off` (`9.92 ms`), `update_process_title=off` (`9.87 ms`),
  and fast-dev durability (`9.37 ms`). Native PostgreSQL remained faster under
  the matched fast-dev profile (`5.90 ms` versus `6.13 ms` baseline).
- Rebuilding the embedded backend objects at `-O3` did not help; case 1 measured
  `10.15 ms`, worse than the restored normal `-O2` build. The generated build
  tree and dylib were restored through `libpglite/bin/build-postgres18-macos.sh`
  after this experiment, and restored `-O2` repeats returned to `9.42-9.69 ms`.
- Case 4 is close to the gate but still suspicious. Three focused repeats landed
  at native-libpglite `91.03-91.29 ms` versus native PostgreSQL `85.00-86.49 ms`,
  ratio `1.05-1.07x`. It was not a matrix miss in the parity-settings run, but
  should stay on the watch list.
- Case 3 was essentially equal in focused diagnostics: native-libpglite
  `178.68 ms` versus native PostgreSQL `178.94 ms`, so the matrix p90 miss needs
  more repeats before treating it as a code hotspot.
- Case 6 was essentially equal in focused diagnostics: native-libpglite
  `9.02 ms` versus native PostgreSQL `9.12 ms`; the matrix p90 miss is likely
  noise or setup sensitivity.

## API Decision

The native SDK now exposes a high-level direct query API:

- `query`, `query_one`, `query_optional`
- `query_params`, `query_one_params`, `query_optional_params`
- `describe`, `describe_typed`, `PreparedStatement::describe`, and parsed
  `QueryDescription` metadata
- `Pglite::open`, `Pglite::temporary`, and observable close state through
  `is_closed`
- `Pglite::open_metrics()` for runtime-provided startup phase diagnostics
- `execute` returning `CommandOutcome`
- `execute_params` over PostgreSQL's extended protocol
- parsed `QueryResult`, `StatementResult`, `Row`, `Column`, `Value`
- `Column` preserves PostgreSQL table OID and table attribute number in addition
  to type metadata and value format
- typed `Row::get::<T>(...)`
- `SqlParam` for text, binary, null, and common primitive parameters
- reusable `PreparedStatement` values with `prepare`, `prepare_typed`,
  `query_*`, `execute_*`, explicit `close`, and best-effort drop cleanup
- pinned prepared statements fail explicitly with `InvalidSessionPin` after the
  owning pin or transaction releases the direct session
- matching `query_one`, `query_optional`, parameterized query, describe,
  execute, and named-prepare helpers on `SessionPin` and `Transaction`
- row/result iterators and owned row/value extraction for ergonomic test code
- explicit row-count, missing-column, out-of-range-column, null, and
  conversion errors instead of panics or stringly typed failures
- strict malformed-protocol rejection for negative row counts, mismatched
  `RowDescription`/`DataRow` field counts, unknown column formats, and trailing
  bytes in parsed row and control frames
- fail-closed high-level parsing for unknown backend message tags instead of
  silently accepting messages the SDK does not understand
- explicit `UnsupportedFeature` errors when the high-level parser sees
  PostgreSQL COPY streaming responses or suspended portals; raw protocol APIs
  remain the supported escape hatch for those states
- transaction drop enqueues best-effort `ROLLBACK` before releasing the
  single physical session
- commit-time PostgreSQL errors are promoted to Rust errors and release the
  pinned session without a redundant rollback
- PostgreSQL notices, notifications, and database errors
- PostgreSQL backend session metadata: parameter status messages, backend key
  data, and final `ReadyForQuery` transaction status
- safe `listen`, `unlisten`, and `unlisten_all` helpers for direct-mode
  notification channels; direct mode exposes notifications on `QueryResult`
  rather than running a background callback receiver
- explicit backup request formats plus typed `UnsupportedFeature` errors for
  backup/export paths that native direct v1 cannot safely support yet
- `exec_protocol_raw` as the escape hatch for lower-level protocol work

This is the right direction for Rust testers and app developers. The direct
path is feasible. Server mode remains a separate product surface requiring true
independent sessions through a new ABI or helper process. The current default
runtime intentionally refuses to fake those modes over the direct C ABI.

## Fresh WASIX PG18 Experiment Rerun

Commands:

- `cargo run -p xtask -- assets download --latest-compatible --target-triple
  aarch64-apple-darwin`
- `cargo run -p xtask -- assets download --latest-compatible --branch
  f0rr0/wasix-pg18-experiment --target-triple aarch64-apple-darwin`
- `cargo run -p xtask -- assets input-fingerprint`
- `cargo run -p xtask -- assets input-fingerprint --explain`
- `cargo run -p xtask -- assets input-fingerprint --write --explain`
- `cargo run -p xtask -- assets verify-committed`
- `cargo run -p xtask -- assets build --profile release-o3 --target-triple
  aarch64-apple-darwin`
- `cd assets/wasix-build/experiments/fresh-wasix-postgres &&
  WASIX_SKIP_PRECOMPILE=1 ./bin/smoke-wasix-core.sh`
- `cd assets/wasix-build/experiments/fresh-wasix-postgres &&
  WASIX_SKIP_PRECOMPILE=1 ./bin/smoke-wasix-concurrent-connections.sh
  --connections 2 --iterations 4`

Results:

- Production asset download is still blocked. `main` has only eight recent
  successful `Assets` runs and none matched this branch's previous committed
  asset input fingerprint `6f70135d...`. The recent artifact fingerprints
  observed were `c5393728...`, `bc73145b...`, `9fab1746...`, and `24f6fd55...`.
  The experiment branch has no successful `Assets` workflow artifact.
- The branch asset input fingerprint was refreshed to the current input set
  (`b21968be9c255e33ed0acb52f1619d7dc329650a8d6c9fff6c49e02f0e2ef3f5`) so
  `assets verify-committed` passes and a future branch `Assets` workflow can
  produce compatible artifacts. `assets input-fingerprint --explain` now prints
  the computed value, committed value, match status, and per-input file hashes
  to make future artifact/download mismatches debuggable.
- Docker was initially stopped; after starting Docker Desktop, the local builder
  image `pglite-oxide-wasix-build:local` was available and focused upstream
  blocker probes could compile against the default wasixcc sysroot.
- The cached fresh WASIX PostgreSQL `REL_18_3` `safe-o2` core build still passes
  the one-shot `initdb` smoke under the pinned Wasmer `7.2.0-alpha.2` binary
  with hash `d8da24764ba74bba1be431a131600a7d022d2f8fe5795842c41aebd0f5576f81`.
- The WASIX server/concurrent path is not promotable on that runtime. The
  postmaster starts and listens on `127.0.0.1:55445`, but every backend dies
  before readiness with
  `could not reattach to WASIX shared memory object ... at 0xac0918: Invalid argument`.
  The concurrent smoke now classifies this as
  `runtime-shared-memory-reattach` instead of retrying until timeout. Latest
  evidence is in
  `assets/wasix-build/work/experiments/fresh-wasix-postgres/reports/wasix-concurrent-connections/summary.md`.
- The focused upstream probes reproduce the same class of failure without
  PostgreSQL:
  - `WASMER_BIN=$PWD/../../work/experiments/fresh-wasix-postgres/tools/wasmer-v7.2.0-alpha.2/bin/wasmer WASIXCC_SYSROOT_PREFIX= ./upstream/bin/run-blocker-probes.sh --probe mmap-fixed --strict`
    fails with `mmap MAP_FIXED failed errno=28 Invalid argument`.
  - `WASMER_BIN=$PWD/../../work/experiments/fresh-wasix-postgres/tools/wasmer-v7.2.0-alpha.2/bin/wasmer WASIXCC_SYSROOT_PREFIX= ./upstream/bin/run-blocker-probes.sh --probe spawn-shmem-reattach --strict`
    fails with `parent msync: Invalid argument`.
  - The latest focused probe report is
    `assets/wasix-build/work/upstream/reports/blocker-probes.md`.

Interpretation: the fresh WASIX PG18 direct one-shot path is past the first
`initdb` gate, but the server path currently depends on patched runtime/libc
semantics for fixed-address shared-memory reattach. We should not claim server
mode feasibility from stock Wasmer artifacts. The next validation needs either
the accepted pinned patched-runtime bundle or a Docker-backed rebuild with the
patched wasix-libc sysroot and release-o3 artifacts.

## Patched WASIX Runtime/Libc Rerun

The ignored upstream work roots were recreated locally to test the tracked WIP
runtime/libc patch set against PostgreSQL instead of the stock Wasmer binary:

- Wasmer source: `wasmerio/wasmer`, tag `v7.2.0-alpha.2`, checkout
  `1d1b3420beef28550afbb4692b664bd7f6bc2581`, with `lib/napi` submodule
  `706383f42391cb4e4e82e5fd5e63a0ebf81ae19d`.
- wasix-libc source: `wasix-org/wasix-libc`, checkout
  `34178a6272804f90448b5bd08dc7bcf0d85438e3`.
- The first local source replay needed drift repair: one wasix-libc futex
  timeout hunk, dynamic test registration, reconstructed `proc_rlimit_get.rs`,
  and a local no-op `perf.rs` because the exported Wasmer patch referenced
  `mod perf` without including that file. A prior large `path_open2`
  cached-handle fast path also did not replay cleanly at this stage; it was
  adapted and restored later in this validation pass.
- Rebuilt patched wasix-libc sysroot:
  `assets/wasix-build/work/upstream/build/patched-wasixcc-sysroot`, signature
  `f5cbbf37fe0c9c7b5db70a6f2bf3fd78d98e1613257fc472be0c2e95dd463b34`.
- Patched Wasmer validation:
  - `cargo check --manifest-path lib/wasix/Cargo.toml --features wasmer/cranelift`
    passed.
  - `cargo build --manifest-path lib/cli/Cargo.toml --bin wasmer --no-default-features --features llvm,wat`
    passed.
  - Debug LLVM-capable Wasmer hash:
    `e2ccb928cb31eb5b3cd551294b7e266c170fec75aaf59c7b40f710362d0c0f5c`.

Focused stock-runtime failures were cleared by the patched runtime/libc pair:

- `mmap-fixed`: pass.
- `spawn-shmem-reattach`: pass.
- Full `run-blocker-probes.sh --strict --strict-dynamic`: pass, with zero
  failed probes and zero failed decision probes. This includes shared mmap
  writeback, shared futex across fork, finite `RLIMIT_STACK`, spawn/wait,
  epoll listener readiness, socket flags, EH libc `fork`, dynamic `dlopen`,
  dynamic fork/dlopen, dynamic indirect fork, and wasm EH/SJLJ.

PostgreSQL was then rebuilt against the patched sysroot:

- `WASIXCC_SYSROOT_PREFIX=.../patched-wasixcc-sysroot ./bin/build-wasix-core.sh --clean`:
  pass for `REL_18_3` `safe-o2`.
- `WASMER_BIN=.../target/debug/wasmer WASIX_SKIP_PRECOMPILE=1 ./bin/smoke-wasix-core.sh`:
  pass.
- `WASMER_BIN=.../target/debug/wasmer WASIX_SKIP_PRECOMPILE=1 ./bin/smoke-wasix-concurrent-connections.sh --connections 2 --iterations 4`:
  pass. Verification wrote `8/8` rows, saw two distinct backend PIDs, and
  confirmed client overlap.

A small native-vs-WASIX concurrent benchmark smoke also passed with the debug
runtime:

| Workload | Native ops/s | WASIX debug ops/s | Notes |
| --- | ---: | ---: | --- |
| indexed-read | 977.778 | 363.636 | verified `1000/1000` rows |
| mixed-write | 1702.128 | 707.965 | verified `80/80` rows |
| indexed-update | 909.091 | 341.880 | verified `40/40` rows |
| indexed-insert | 869.565 | 360.360 | verified `40/40` rows |

This benchmark used `2` connections, `20` iterations per client, `1000` seed
rows, `safe-o2`, skipped precompile, and the debug patched Wasmer. Treat it as a
functional benchmark-harness smoke, not latency/throughput evidence for
promotion. WASIX had zero repeated epoll interruption counts in this run, but
RSS was much higher than native at this scale (`~260-271 MiB` sampled WASIX
peak versus `~39 MiB` native).

Interpretation: the WASIX server path is feasible on the patched runtime/libc
stack; it is not feasible on stock Wasmer `7.2.0-alpha.2`. Promotion still needs
a complete, reproducible patched source snapshot or accepted pinned runtime
bundle, a release-o3/nativecpu rebuild, full pg_regress expansion, and real
native-vs-WASIX-vs-stable performance runs before making any native-parity or
stable-lane claim.

## Reproducible Upstream Patch Replay

The upstream source replay is now scripted instead of relying on locally repaired
ignored work roots:

- Added `assets/wasix-build/experiments/fresh-wasix-postgres/upstream/bin/prepare-upstream-checkouts.sh`.
- Defaults:
  - Wasmer remote `https://github.com/wasmerio/wasmer.git`, fetch ref
    `refs/tags/v7.2.0-alpha.2`, checkout
    `1d1b3420beef28550afbb4692b664bd7f6bc2581`.
  - Wasmer `lib/napi` submodule
    `706383f42391cb4e4e82e5fd5e63a0ebf81ae19d`.
  - wasix-libc remote `https://github.com/wasix-org/wasix-libc.git`, fetch ref
    `main`, checkout `34178a6272804f90448b5bd08dc7bcf0d85438e3`.
- The script refuses dirty existing checkouts unless `--force` is used. `--force`
  uses `git reset --hard` and `git clean -fd`, but deliberately avoids
  `git clean -x` so ignored build caches such as `target/` are preserved.
- The script verifies `lib/napi` through `git rev-parse --git-dir` so modern
  submodule layouts with a `.git` file are checked correctly.
- The tracked Wasmer and wasix-libc patch exports were regenerated from the
  tested patched checkouts. The Wasmer export now carries the previously missing
  `perf.rs`, `mem_mmap.rs`, `proc_rlimit_get.rs`, and dynamic probe tests; the
  wasix-libc export carries the `c_mmap_writeback` probe.

Validation:

- `bash -n assets/wasix-build/experiments/fresh-wasix-postgres/upstream/bin/prepare-upstream-checkouts.sh`:
  pass.
- `prepare-upstream-checkouts.sh --help`: pass.
- Fresh replay into
  `assets/wasix-build/work/upstream-replay-check` with `--force`: pass; patch
  file count after apply was `96` for Wasmer and `18` for wasix-libc.
- `git diff --check` inside the replayed Wasmer and wasix-libc work roots: pass.
- `cargo check --manifest-path lib/wasix/Cargo.toml --features wasmer/cranelift`
  in the replayed Wasmer checkout: pass.
- `cargo check --manifest-path lib/wasix/Cargo.toml --features wasmer/cranelift,perf-stats`
  in the replayed Wasmer checkout: pass.
- `record-code-grounding.sh --strict` still reports one historical non-source
  miss for `experiment:reports/llvm-debug/o3-thinlto-md5-fshl`; source-code
  references required by the patch replay are present.

## Restored `path_open2` Cached-Handle Fast Path

The `path_open2` cached regular-file handle fast path was restored after the
first reproducible replay. The old hunk did not apply cleanly to the pinned
Wasmer tag, so it was adapted to the current `path_open2.rs` shape instead of
being copied verbatim.

Behavioral intent:

- Existing regular files with cached handles and no truncate request can return
  through a shared inode read lock when the cached handle already satisfies the
  requested read/write rights. That avoids the write-lock/reopen path for common
  PostgreSQL file opens.
- The slow path now prefers a shared read/write host open when a reopen is
  required, then falls back to the exact requested open configuration. This
  avoids downgrading a shared inode handle when other file descriptors still
  need broader rights.
- File-descriptor open flags are still recorded on both the fast and slow paths.

Validation after restoring the fast path:

- `cargo fmt --manifest-path lib/wasix/Cargo.toml --check` in the patched
  Wasmer checkout: pass.
- `cargo check --manifest-path lib/wasix/Cargo.toml --features wasmer/cranelift`
  in the patched Wasmer checkout: pass.
- The tracked Wasmer patch export was regenerated and replayed into
  `assets/wasix-build/work/upstream-replay-check` with
  `prepare-upstream-checkouts.sh --force`: pass; patch file count remained `96`
  for Wasmer and `18` for wasix-libc.
- `cargo check --manifest-path lib/wasix/Cargo.toml --features wasmer/cranelift`
  in the replayed Wasmer checkout: pass.
- Release patched Wasmer was rebuilt after the fast-path restore. Initial
  fast-path hash:
  `14248bf572948f5f382dd7f7d223737501146ec98f6a8d93d581d2763483fb10`.
- After restoring feature-gated perf-stats telemetry, adding linker subspans,
  and fixing atomic perf snapshot writes, the current normal release hash is:
  `79383fcde42828990234656b453cbb3a08f7ecd67a07e29552fa99301d6f084b`.
- Full `run-blocker-probes.sh --strict --strict-dynamic` with that release
  binary and the patched wasix-libc sysroot: pass, with `0` failed probes and
  `0` failed decision probes.
- `release-o3` concurrent PostgreSQL smoke with `2` connections and `4`
  iterations per connection: pass.

Interpretation: the current exported patch set is now a correctness artifact and
a filesystem fast-path performance artifact. It still is not a native-parity
artifact; the benchmark section below records the remaining throughput and RSS
gap.

## Restored WASIX Perf-Stats Telemetry

The upstream patch export referenced `crate::perf` counters, and the experiment
already had `build-wasmer-perf-stats.sh` plus
`summarize-wasix-perf-stats.sh`, but the replayed `perf.rs` implementation was
only a no-op shim. That made `--wasix-perf-stats` misleading.

The current patch set restores a feature-gated counter sink:

- Normal release builds without `wasmer-wasix/perf-stats` keep no-op counter
  calls, so the release throughput baseline is not changed by diagnostics.
- Perf-stats builds aggregate named call/time/byte counters, fd-pwrite path
  counters, and futex wake-to-run latency. Snapshots are emitted in the format
  expected by the existing summarizer.
- Multi-process perf snapshots are now assembled in memory and appended as one
  block so PostgreSQL child-process dumps do not interleave into corrupt TSV
  input.
- Wait-registry text dumps remain available through `WASIX_WAIT_DUMP_FILE`
  without requiring perf counters.

Validation:

- `cargo check --manifest-path lib/wasix/Cargo.toml --features wasmer/cranelift`:
  pass.
- `cargo check --manifest-path lib/wasix/Cargo.toml --features wasmer/cranelift,perf-stats`:
  pass.
- Patch replay with `prepare-upstream-checkouts.sh --force`: pass.
- Replayed Wasmer checkout checks with both normal and `perf-stats` features:
  pass.
- `WASIX_CORE_PROFILE=release-o3 ./bin/build-wasmer-perf-stats.sh`: pass.
  Latest instrumented binary hash after linker subspans and atomic snapshot
  writes:
  `9abfc38ca161f492ab6565c7636709da0c693e6b576a26362a61770c10cf3e57`.
- `codex-perfstats-final-pathopenfast-read-2x20`: pass and produced
  non-empty `wasix-perf-server.top-time.tsv`,
  `wasix-perf-server.top-bytes.tsv`, and pwrite-path summaries.
- `codex-perfstats-final-pathopenfast-read-20x1000`: pass, `20/20` clients,
  zero epoll interrupts, `52,132.701` WASIX ops/s, and peak fanout RSS
  `297.984 MiB`.
- Normal release Wasmer was rebuilt after the feature-gated telemetry repair,
  linker subspans, and atomic perf snapshot writer.
  Current normal release hash:
  `79383fcde42828990234656b453cbb3a08f7ecd67a07e29552fa99301d6f084b`.
- Full `run-blocker-probes.sh --strict --strict-dynamic` with the current
  normal release binary: pass.
- `release-o3` concurrent PostgreSQL smoke with the current normal release
  binary, `2` connections, and `4` iterations per connection: pass, including
  the post-atomic-writer run `codex-post-atomicperf-release-smoke`.

The `20x1000` perf-stats read run gives a useful next optimization target:

| Counter | Calls | Aggregate |
| --- | ---: | ---: |
| `syscall.proc_exec3` | 34 | `587.786 ms` |
| `task_wasm.new_with_store.plain` | 36 | `335.721 ms` |
| `syscall.mem_mmap.bytes` | 92 | `5.274 GiB` requested |
| `syscall.fd_pwrite.detail` | 1422 | `13.147 ms`, `36.668 MiB` |
| `syscall.fd_read.bytes` | 5555 | `7.799 MiB` |

Interpretation: short fanout latency and RSS are still dominated by backend
creation/store setup and large guest-memory remapping, not by fd read/write
syscall time. `asyncify.block_on` and `syscall.epoll_wait` are high in
top-time because they include parked wall time, so they are liveness evidence
rather than CPU bottleneck proof.

Follow-up controls did not change that conclusion:

- `codex-shbuf16-releaseo3-20x1000` (`shared_buffers=16MB`) stayed in the same
  performance band. WASIX read/mixed/update/insert throughput was
  `55837.563`, `101010.101`, `50761.421`, and `50125.313` ops/s, and fanout
  RSS was still roughly `286-321 MiB`.
- `codex-maxconn24-releaseo3-20x1000` (`max_connections=24`) was not
  materially better and kept the same RSS shape.
- `codex-perfstats-linker-subspan-read-20x1000` narrowed
  `task_wasm.new_with_store.plain` to `Linker::new`, and then to
  `Instance::new` for the main PostgreSQL module: `linker.new.main_instance.new`
  accounted for `206.158 ms` across `36` calls out of
  `312.162 ms` in `wasi_env.instantiate.linker.new`. Memory/table setup,
  symbol resolution, relocations, and handle initialization were small by
  comparison.

This means the current `EXEC_BACKEND` server path pays a fresh dynamic-main
instance cost per backend. Further tuning of `shared_buffers`, `max_connections`,
or fd read/write paths cannot make short connection fanout native-equal.

## WASIX Child Backend Feasibility

The PostgreSQL WASIX patch now has an explicit build switch:
`WASIX_CORE_CHILD_BACKEND=exec` keeps the current `EXEC_BACKEND`/`vfork+exec`
path, while `WASIX_CORE_CHILD_BACKEND=copied-fork` defines
`PG_WASIX_COPIED_FORK_BACKEND=1` and lets PostgreSQL compile the normal
`fork_process()` path.

Validation:

- `WASIX_CORE_PROFILE=release-o3 WASIX_CORE_CHILD_BACKEND=copied-fork
  ./bin/build-wasix-core.sh --clean`: pass into the isolated
  `wasix-core-release-o3-copied-fork` build/install directories.
- Copied-fork `smoke-wasix-core.sh`: pass for single-process initdb.
- Copied-fork `smoke-wasix-concurrent-connections.sh --connections 2
  --iterations 4`: blocked at readiness. The server started listening, then
  exited with `RuntimeError: unreachable` from `wasmer_wasix::bin_factory::exec`.
- `codex-copiedfork-readiness-diag-atomicperf` with perf-stats hash
  `9abfc38ca161f492ab6565c7636709da0c693e6b576a26362a61770c10cf3e57` produced
  parseable counters before the same readiness failure.

Key copied-fork counters:

| Counter | Calls | Aggregate |
| --- | ---: | ---: |
| `task_wasm.new_with_store.linker_copy` | 2 | `130.464 ms` |
| `linker.instance_group.memory.copy_to_store` | 2 | `112.354 ms` |
| `linker.instance_group.memory.copy_to_store.bytes` | 2 | `320.733 MiB` |
| `linker.instance_group.memory.copy_to_store.excluded_bytes` | 2 | `297.599 MiB` |
| `linker.instance_group.main_instance.new` | 2 | `11.149 ms` |
| `syscall.proc_fork` | 5 | `68.458 us` |

Interpretation: copied fork is not a promotable server path yet. It reaches the
patched copied instance-group path, but it copies about `160 MiB` per forked
child, spends roughly `56 ms` per copied child in memory copy alone, and still
traps before server readiness. Keeping `EXEC_BACKEND` is currently the only
functional server path. A viable copied-fork path needs a no-copy/COW memory
strategy plus a separate fix for the startup trap.

## Release Patched Runtime And PostgreSQL Gates

Release LLVM-capable patched Wasmer was built from the replayed patched upstream
checkout:

- Command:
  `cargo build --release --manifest-path lib/cli/Cargo.toml --bin wasmer --no-default-features --features llvm,wat`
- Result: pass.
- Initial pre-`path_open2` fast-path release Wasmer hash:
  `d4a3ade726b5190974e393d5d1c628e91fe4f037708061d79dd02f73a1e8d7cd`.
- Fast-path release Wasmer hash before the perf-stats telemetry repair:
  `14248bf572948f5f382dd7f7d223737501146ec98f6a8d93d581d2763483fb10`.
- Current release Wasmer hash after restoring feature-gated perf-stats
  telemetry, adding linker subspans, and fixing atomic perf snapshot writes:
  `79383fcde42828990234656b453cbb3a08f7ecd67a07e29552fa99301d6f084b`.

Strict runtime/libc blocker gate:

- Command:
  `WASMER_BIN=.../target/release/wasmer WASIXCC_SYSROOT_PREFIX=/work/assets/wasix-build/work/upstream/build/patched-wasixcc-sysroot ./upstream/bin/run-blocker-probes.sh --strict --strict-dynamic`
- Result: pass for the initial release binary, the `path_open2` fast-path
  release binary, and the current feature-gated telemetry release binary.
- Report:
  `assets/wasix-build/work/upstream/reports/blocker-probes.md`.
- Failed probes: `0`.
- Failed decision probes: `0`.
- Covered probes include `mmap-fixed`, `mmap-writeback`,
  `spawn-shmem-reattach`, shared futex fork, spawn/wait, epoll listener
  readiness, socket nonblocking, libc EH fork, dynamic dlopen, dynamic fork
  dlopen, dynamic fork indirect, and wasm EH/SJLJ.

PostgreSQL `safe-o2` against the release runtime:

- `WASMER_BIN=.../target/release/wasmer WASIX_SKIP_PRECOMPILE=1 ./bin/smoke-wasix-core.sh`:
  pass.
- `WASMER_BIN=.../target/release/wasmer WASIX_SKIP_PRECOMPILE=1 ./bin/smoke-wasix-concurrent-connections.sh --connections 2 --iterations 4`:
  pass. Verification wrote `8/8` rows, saw two backend PIDs, and confirmed
  overlap.

PostgreSQL `release-o3` was built against the patched sysroot:

- Command:
  `WASIX_CORE_PROFILE=release-o3 WASIXCC_SYSROOT_PREFIX=.../patched-wasixcc-sysroot ./bin/build-wasix-core.sh --clean`
- Result: pass after reusing the existing local Docker image.
- Install:
  `assets/wasix-build/work/experiments/fresh-wasix-postgres/install/wasix-core-release-o3`.
- Profile: `-O3 -g0 -flto=thin -fPIC -pthread -sWASM_EXCEPTIONS=yes` plus
  Binaryen `--converge:--strip-debug:--strip-producers`.
- `WASIX_CORE_PROFILE=release-o3 WASMER_BIN=.../target/release/wasmer WASIX_SKIP_PRECOMPILE=1 ./bin/smoke-wasix-core.sh`:
  pass.
- `WASIX_CORE_PROFILE=release-o3 WASMER_BIN=.../target/release/wasmer WASIX_SKIP_PRECOMPILE=1 ./bin/smoke-wasix-concurrent-connections.sh --connections 2 --iterations 4`:
  pass.

## Release Performance Smoke Critique

These are small `2` connection, `20` iteration per-client runs with `1000` seed
rows. They are useful for direction and regression detection, but they are not
the research-grade matrix needed for promotion.

`safe-o2`, release patched Wasmer, default LLVM runtime flags:

| Workload | Native ops/s | WASIX ops/s | WASIX/native |
| --- | ---: | ---: | ---: |
| indexed-read | 977.778 | 517.647 | 0.529 |
| mixed-write | 1818.182 | 1159.420 | 0.638 |
| indexed-update | 909.091 | 547.945 | 0.603 |
| indexed-insert | 888.889 | 563.380 | 0.634 |

`safe-o2`, release patched Wasmer, `WASMER_LLVM_NATIVE_CPU=1`,
`WASMER_LLVM_FULL_O3_PIPELINE=1`, and `WASMER_LLVM_INDIRECT_CALL_CACHE=1`:

| Workload | Native ops/s | WASIX ops/s | WASIX/native |
| --- | ---: | ---: | ---: |
| indexed-read | 956.522 | 517.647 | 0.541 |
| mixed-write | 1860.465 | 1194.030 | 0.642 |
| indexed-update | 851.064 | 606.061 | 0.712 |
| indexed-insert | 909.091 | 606.061 | 0.667 |

`release-o3`, release patched Wasmer, default LLVM runtime flags:

| Workload | Native ops/s | WASIX ops/s | WASIX/native |
| --- | ---: | ---: | ---: |
| indexed-read | 977.778 | 578.947 | 0.592 |
| mixed-write | 1860.465 | 963.855 | 0.518 |
| indexed-update | 930.233 | 449.438 | 0.483 |
| indexed-insert | 952.381 | 540.541 | 0.568 |

`release-o3`, pre-telemetry-repair `path_open2` fast-path release Wasmer,
default LLVM runtime flags, same tiny `2x20` shape:

| Workload | Native ops/s | WASIX ops/s | WASIX/native |
| --- | ---: | ---: | ---: |
| indexed-read | 977.778 | 571.429 | 0.584 |
| mixed-write | 1860.465 | 1066.667 | 0.573 |
| indexed-update | 930.233 | 454.545 | 0.489 |
| indexed-insert | 952.381 | 547.945 | 0.575 |

`release-o3`, current `path_open2` fast-path plus feature-gated telemetry
release Wasmer, default LLVM runtime flags, larger `20` connections by `1000`
iterations per client with `50000` seed rows:

| Workload | Native ops/s | WASIX ops/s | WASIX/native |
| --- | ---: | ---: | ---: |
| indexed-read | 89795.918 | 53789.731 | 0.599 |
| mixed-write | 158730.159 | 100755.668 | 0.635 |
| indexed-update | 81300.813 | 50000.000 | 0.615 |
| indexed-insert | 78740.157 | 50890.585 | 0.646 |

`release-o3`, release patched Wasmer, native-CPU/full-O3/indirect-cache flags:

| Workload | Native ops/s | WASIX ops/s | WASIX/native |
| --- | ---: | ---: | ---: |
| indexed-read | 880.000 | 458.333 | 0.521 |
| mixed-write | 1600.000 | 963.855 | 0.602 |
| indexed-update | 869.565 | 404.040 | 0.465 |
| indexed-insert | 909.091 | 421.053 | 0.463 |

Resource sampling remains unfavorable in these tiny runs. Representative peak
RSS:

- `safe-o2` default: native `~39-44 MiB`, WASIX `~225-238 MiB`.
- `release-o3` default before the fast-path restore: native `~39-40 MiB`,
  WASIX `~279-284 MiB`.
- `release-o3` pre-telemetry-repair fast-path `2x20`: native `~39-40 MiB`, WASIX
  `~275-290 MiB`.
- `release-o3` current fast-path `20x1000`: native fanout `~42-45 MiB`
  (`~66 MiB` during one setup phase), WASIX fanout `~293-307 MiB`.

Interpretation:

- The patched runtime/libc stack clears the correctness blockers for the server
  path. That is a material improvement over stock Wasmer, where concurrent
  backends fail with shared-memory reattach errors.
- The current artifacts do not meet the native-latency/native-throughput bar.
  The best small-run ratio here is `0.712` on `safe-o2` indexed-update with the
  tuning flags, while the current `release-o3` fast-path `20x1000` run is
  roughly `0.599-0.646` of native depending on workload.
- The native-CPU/full-O3/indirect-call-cache flag combination should stay
  experimental. It does not consistently improve throughput and makes
  `release-o3` worse in this smoke.
- Restoring the filesystem fast path is worth keeping: it preserved the strict
  blocker pass and improved the tiny mixed-write result from `0.518` to `0.573`
  of native. It did not move the branch near native parity, and read/update
  results remain close to the previous baseline.
- Promotion still needs the full matrix against native Postgres, stable
  pglite-oxide 17, and PG18 variants with repetitions, warmup discipline,
  precompiled caches or pinned runtime bundles, CPU/RSS sampling, and failure
  gates. Current evidence supports continuing server-path work, not promoting
  this branch as native-equal stable.

## Benchmark Matrix Harness

The native/PG18 matrix runner now has an optional stable-worktree lane:

```bash
tools/scripts/perf/run_native_libpglite_matrix.sh \
  --stable-worktree /path/to/stable/pglite-oxide
```

When present, the runner builds and executes that worktree's release `xtask`
from the stable worktree root and emits additional `stable-wasix-*` JSON and
resource files in the same run directory. The summary report now includes:

- stable worktree rows in the RTT and speed tables;
- a `PG18 WASIX vs Stable Worktree Gate` section for direct/server RTT and
  speed p90 comparisons;
- stable direct/server speed-case columns;
- stable prepared-update rows when prepared-update suites are enabled.

This does not itself prove promotion readiness; it closes a measurement
infrastructure gap so stable pglite-oxide, the PG18 branch, native libpglite,
and native PostgreSQL can be compared under the same SQL source, repeat count,
resource parser, and report format. The runner rejects dirty stable worktrees by
default and records stable branch/revision/dirty provenance in the report;
`--allow-dirty-stable` exists only for harness smoke runs.

## Rust API/Test Gate

Latest focused Rust validation after the PG18 native API and WASIX runtime work:

- `cargo fmt --check`: pass.
- `bash -n tools/scripts/perf/run_native_libpglite_matrix.sh`: pass.
- `node --check tools/scripts/perf/summarize_native_libpglite_matrix.mjs`: pass.
- Empty-run summary dry-run with `--stable-worktree`: pass, verifies the report
  renders stable-worktree branch/revision/dirty provenance plus method,
  coverage, and gate sections even when measured JSON files are absent.
- Dirty stable-worktree guard:
  `PGLITE_OXIDE_PERF_BUILD_XTASK=0 tools/scripts/perf/run_native_libpglite_matrix.sh --stable-worktree /Users/sid/dev/pglite-oxide --skip-wasix --skip-prepared --speed-repeats 1 --run-id dirty-stable-reject-smoke`
  exits `2` before running the stable lane because `/Users/sid/dev/pglite-oxide`
  has local changes. This prevents accidentally treating a dirty checkout as a
  stable baseline.
- Dirty stable-worktree harness smoke:
  `PGLITE_OXIDE_PERF_BUILD_XTASK=0 tools/scripts/perf/run_native_libpglite_matrix.sh --run-id codex-stable-lane-smoke-preflight --rtt-iterations 2 --sdk-iterations 1 --speed-repeats 1 --speed-source generated --skip-wasix --skip-prepared --stable-worktree /Users/sid/dev/pglite-oxide --allow-dirty-stable`
  pass. Report:
  `target/perf/native-libpglite-codex-stable-lane-smoke-preflight/report.md`.
  The report includes native libpglite, native PostgreSQL, native SDK, stable
  direct, stable server SQLx, and stable server tokio rows, and marks the stable
  source as `main@464d79e (dirty; smoke/provenance run only)`. These numbers are
  harness evidence only, not a stable baseline.
- Clean stable-worktree setup:
  `git worktree add --detach /Users/sid/dev/pglite-oxide-stable-clean origin/main`
  created a detached clean stable worktree at `a531b37` (`chore(release): 0.5.0 (#32)`).
  `target/release/xtask assets download --latest-compatible` installed ignored
  stable runtime/AOT assets from workflow run `25654931893`, and rebuilding
  `cargo build --release -p xtask` embedded those assets in the stable control.
  The worktree remains clean by `git status --short`.
- Clean stable-worktree harness smoke:
  `PGLITE_OXIDE_PERF_BUILD_XTASK=0 tools/scripts/perf/run_native_libpglite_matrix.sh --run-id codex-clean-stable-lane-smoke --rtt-iterations 2 --sdk-iterations 1 --speed-repeats 1 --speed-source generated --skip-wasix --skip-prepared --stable-worktree /Users/sid/dev/pglite-oxide-stable-clean`
  pass. Report:
  `target/perf/native-libpglite-codex-clean-stable-lane-smoke/report.md`.
  This is still a harness smoke run because samples/repeats are tiny, but it is
  no longer dirty-stable provenance. It also exposed and fixed summary
  compatibility issues for detached stable refs and stable v0.5.0 RTT reports
  that contain `p95Micros` but not `p90Micros`.
- Current PG18 WASIX matrix preflight with current WASIX enabled:
  `PGLITE_OXIDE_PERF_BUILD_XTASK=0 tools/scripts/perf/run_native_libpglite_matrix.sh --run-id preflight-pg17-metadata-smoke --rtt-iterations 2 --sdk-iterations 1 --speed-repeats 1 --speed-source generated --skip-prepared --stable-worktree /Users/sid/dev/pglite-oxide --allow-dirty-stable`
  exits `2` before running native controls because
  current-branch asset metadata in `crates/pglite-oxide/Cargo.toml` still says
  PostgreSQL `17.5`, not PostgreSQL `18`.
  If that metadata is updated, the same preflight then requires
  `target/pglite-oxide/assets/manifest.json`,
  `target/pglite-oxide/assets/pglite.wasix.tar.zst`, and a host AOT manifest
  whose `runtime:pglite` module hash matches the runtime manifest.
  The available downloaded archives under `target/pglite-oxide/downloads/*` are
  PostgreSQL `17.5` assets, so they are not treated as a valid PG18 runtime
  control for this branch. A real promotion matrix still needs PG18 WASIX assets
  built or installed for this checkout.
- Runtime-archive contamination guard:
  `PGLITE_OXIDE_PERF_BUILD_XTASK=0 PGLITE_OXIDE_RUNTIME_ARCHIVE=target/pglite-oxide/downloads/25557780617/target/pglite-oxide/assets/pglite.wasix.tar.zst tools/scripts/perf/run_native_libpglite_matrix.sh --wasix-postgres-major 17 --run-id preflight-envarchive-stable-smoke --rtt-iterations 2 --sdk-iterations 1 --speed-repeats 1 --speed-source generated --skip-prepared --stable-worktree /Users/sid/dev/pglite-oxide --allow-dirty-stable`
  exits `2` because an explicit runtime archive would contaminate the stable
  worktree lane. The same archive without a stable lane also exits `2` unless
  `PGLITE_OXIDE_PERF_ALLOW_EXTERNAL_RUNTIME=1` is set, and that override is
  documented as smoke-only because it cannot prove AOT/runtime coherence.
- Asset manifest versioning fix: `tools/xtask` no longer hardcodes
  `17.5`/`17` when writing `manifest.json` and the PGDATA template manifest.
  Runtime PostgreSQL version is derived from the pinned `postgres-pglite`
  branch, PGDATA template version is read from generated `PG_VERSION`, and
  `assets check --strict-generated` now rejects a generated manifest whose
  runtime version does not match `assets/sources.toml`/Cargo metadata.
  Validation:
  - `cargo fmt --check`: pass.
  - `cargo check -p xtask`: pass.
  - `cargo test -p pglite-oxide-assets`: pass.
  - `cargo run -p xtask -- assets check`: pass with expected warnings for
    missing current-branch generated WASIX assets.
- `cargo check -p xtask`: pass.
- `cargo clippy -p xtask -- -D warnings`: pass.
- `cargo run -p xtask -- assets verify-committed`: currently blocked by
  source-controlled asset input fingerprint drift:
  expected `b21968be9c255e33ed0acb52f1619d7dc329650a8d6c9fff6c49e02f0e2ef3f5`,
  got `ecabb7d3ecf465b7036c3e7b28dae29a412c4ac8a62d15f823dc0f430ac482c1`.
  This matches the existing modified WASIX build inputs in the worktree and
  must be resolved before a release-grade asset verification pass.
- `cargo test -p libpglite-oxide --tests`: pass, `40` integration tests.
  Covered direct-mode fake-pool rejection, mode-specific runtime contracts,
  session pinning, typed query helpers, prepared statements, named prepared
  statements, transaction commit/rollback/release behavior, raw streaming, row
  parsing, notices, notifications, and server-mode independent-session
  advertising. The SDK shape tests now also cover startup identity,
  PostgreSQL GUC replacement/validation, raw startup arg validation, and
  `relaxed_durability(true)` mapping to the safer `Balanced` profile.
- `LIBPGLITE_OXIDE_LIBPGLITE=target/libpglite-pg18/out/libpglite.dylib cargo test -p libpglite-oxide -- --nocapture`:
  pass, `40` integration tests with the native PG18 libpglite smoke active.
  The native smoke verifies explicit startup identity (`postgres` /
  `template1`), `application_name`, and caller GUC override ordering
  (`relaxed_durability(true)` followed by `synchronous_commit=on`). A second
  native smoke opens a persistent root, creates a role/database, closes and
  reopens it with `.username("oxide_user").database("oxide_db")`, and verifies
  `current_user`/`current_database()`. The direct runtime now matches the
  stable lane by applying `SET ROLE` after `pglite_init` for non-default
  startup roles.
- `cargo test -p pglite-oxide --tests`: pass. Summary:
  - Library unit tests: `56` passed, `3` ignored candidate-extension promotion
    gates.
  - Integration tests: CLI `1`, client compatibility `25`, extensions `14`,
    native libpglite extensions `3`, native libpglite smoke `1`, performance
    smoke `8`, PostgreSQL regression subset `8`, proxy `1`, runtime smoke `22`.
- `cargo clippy -p libpglite-oxide -p pglite-oxide --all-targets -- -D warnings`:
  pass.

API interpretation:

- The direct path has a credible Rust-facing shape now: single-owner execution,
  explicit session pins, typed query helpers, prepared statement APIs, and
  transaction helpers are covered by tests. It now exposes direct startup
  identity, validated PostgreSQL GUC configuration, advanced startup args, and
  an ergonomic `relaxed_durability(true)` alias without hiding the explicit
  `DurabilityProfile` API.
- The server path is represented as a real independent-session contract and is
  covered at the `pglite-oxide` SQLx/tokio-postgres compatibility layer.
- The WASIX server path is now functionally feasible only on the patched
  runtime/libc stack. It is not yet a promotable stable default because
  throughput, RSS, and full regression coverage still miss the bar.

## pglite-oxide PG18 Server-Core API And Perf Pass

Date: 2026-05-15

This pass stayed out of `libpglite`/`crates/libpglite-oxide` and focused on the
WASIX `pglite-oxide` lane.

Changes:

- Added explicit PG18 server-core runtime configuration on
  `PgliteServerBuilder`: Wasmer binary, Wasmer home/cache dirs, compiler,
  LLVM opt level, compiler threads, and readiness timeout.
- Added public `WasmerCompiler` with `Display`/`FromStr` so app and test
  harness config can avoid stringly typed compiler handling.
- Routed PG18 server-core `pg_dump` through the same runtime config instead of
  falling back to process-global Wasmer env vars.
- Applied the embedded startup profile to the PG18 server-core `postgres`
  process: `search_path=public`, `exit_on_error=off`, `fsync=off`, worker and
  parallelism limits, buffer settings, autovacuum off, checkpoint logging off,
  and UTC timezone settings. Caller `postgres_config(...)` entries are appended
  after defaults and continue to win.
- Added `PgliteServer::server_process_id()` for runtimes backed by an external
  server process and taught `xtask perf bench` to sample PG18 server-core
  process-tree RSS just like the native PostgreSQL control.
- Corrected the matrix summarizer's estimated total memory calculation for
  out-of-process server modes on macOS. `/usr/bin/time -l` maximum RSS can track
  the child server process; when peak footprint is available, reports now use
  client peak footprint plus observed server-process RSS instead of double
  counting the server RSS.
- Documented the PG18 lane status in the public README/runtime/usage/extension
  docs: server-first, legacy direct backend unavailable for current PG18
  assets, and extension preinstall blocked until PG18 extension artifacts are
  rebuilt.

Validation:

- `cargo fmt --check --package pglite-oxide --package xtask`: pass.
- `cargo check -p pglite-oxide`: pass.
- `cargo check -p xtask`: pass.
- `cargo test -p pglite-oxide --lib runtime_config -- --nocapture`: pass.
- `PGLITE_OXIDE_WASMER_BIN=assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test client_compat -- --nocapture`:
  pass, `26` tests. This includes the new server startup-profile assertion and
  process-id assertion for PG18 server-core assets.
- `PGLITE_OXIDE_WASMER_BIN=assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --tests -- --nocapture`:
  pass. Library tests `59` passed / `3` ignored candidate-extension gates;
  integration tests passed with direct/extension/Unix gaps explicitly skipped
  for PG18 server-core assets.
- `cargo test -p pglite-oxide-assets -- --nocapture`: pass.
- `cargo run -p xtask -- assets check`: pass with expected warning that
  `assets/generated/extensions.catalog.json` is stale and expected direct
  export-list skip for PG18 server-core runtime.
- `cargo test -p pglite-oxide --doc`: pass.
- `git diff --check` over touched pglite-oxide, xtask, and docs files: pass.

Quick perf probes after the startup-profile fix:

- `xtask perf bench --suite rtt --mode server-sqlx --iterations 20` with the
  patched Wasmer binary: SQLx RTT trimmed averages ranged roughly `75-240 us`
  across the 12 cases. Native PostgreSQL 18 SQLx in the same harness ranged
  roughly `136-226 us` in that run. The PG18 server-core path now wins some
  small read/update cases and still trails on several write and larger-row
  cases.
- `xtask perf bench --suite speed --mode server-sqlx --speed-source generated`
  with the patched Wasmer binary: one-shot generated speed-suite total was
  still materially slower than native PostgreSQL 18 SQLx. The run also exposed
  PG18 server-core RSS sampling; a 5-iteration RTT smoke reported
  `observedServerPeakRssBytes = 273235968`.

Current interpretation:

- The earlier benchmark comparison was partly unfair because PG18 server-core
  did not receive the embedded startup profile. That is fixed.
- The remaining speed-suite gap is real enough to keep promotion blocked. It is
  no longer explained by missing basic GUC parity alone.
- PG18 server-core memory is now measurable in the product benchmark reports;
  early RSS smoke is much higher than native PostgreSQL controls and needs
  focused optimization.

## pglite-oxide PG18 Harness Direct-Mode Cleanup

Date: 2026-05-15

This pass stayed out of `libpglite`/`crates/libpglite-oxide`.

Changes:

- Added public packaged-runtime introspection:
  `PgliteRuntimeKind`, `packaged_runtime_kind()`, and
  `using_wasix_postgres_server_core_assets()`.
- Updated `xtask perf bench` so `--mode all` skips direct-mode runs when the
  packaged assets are PG18 server-core. Explicit `--mode direct` now fails
  immediately with a clear server-core message instead of trying to preload the
  removed direct backend.
- Updated `xtask perf prepared-updates` so PG18 server-core skips legacy
  direct preload and Unix-socket runs. The PG18 prepared-update smoke now covers
  TCP SQLx, TCP tokio-postgres prepared, and TCP tokio-postgres pipelined
  prepared modes.
- Updated the matrix runner to skip current-branch `wasix-direct-*` lanes when
  `target/pglite-oxide/assets/manifest.json` reports
  `runtime-kind = wasix-postgres-server`.
- Updated the matrix summary to record the current WASIX runtime kind and mark
  direct mode as intentionally unavailable for PG18 server-core reports.
- Added runtime metadata to `xtask perf bench` JSON for current WASIX runs:
  packaged runtime kind, Wasmer binary, compiler, LLVM opt level, and compiler
  threads. The matrix report now surfaces this in the Method section so PG18
  benchmark provenance includes the external server-core runner configuration.
- Added `xtask perf pglite-server-open`, an open-profile command for
  `PgliteServer`. For PG18 server-core it captures runtime/root-preparation
  phases, `postgres` spawn/readiness phases, SQLx connect and first-query
  latency, observed external server-process RSS, and the Wasmer runtime
  metadata used by the run. The matrix runner now records this as
  `wasix-server-open`.

Validation:

- `cargo check -p pglite-oxide`: pass.
- `cargo check -p xtask`: pass.
- `PGLITE_OXIDE_WASMER_BIN=assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --lib -- --nocapture`:
  pass, `60` passed / `3` ignored.
- `bash -n tools/scripts/perf/run_native_libpglite_matrix.sh`: pass.
- `node --check tools/scripts/perf/summarize_native_libpglite_matrix.mjs`:
  pass.
- `cargo check -p xtask`: pass after the matrix RSS reporting change.
- `PGLITE_OXIDE_WASMER_BIN=assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo run -p xtask -- perf prepared-updates --rows 10 --skip-native`:
  pass, with only PG18 TCP server modes in the report.
- `PGLITE_OXIDE_WASMER_BIN=assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo run -p xtask -- perf bench --suite rtt --mode all --iterations 5`:
  pass, reports `server_sqlx` and `server_tokio_postgres_simple`, `preloadMicros
  = 0`, and observed server RSS around `260-270 MiB`.
- Runtime metadata smoke:
  `PGLITE_OXIDE_WASMER_BIN=assets/wasix-build/work/upstream/wasmer/target/release/wasmer PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 cargo run -p xtask -- perf bench --suite rtt --mode server-sqlx --iterations 2`
  emits `runtime.packagedRuntimeKind = wasix-postgres-server`,
  `runtime.wasmerCompiler = llvm`, `runtime.wasmerLlvmOptLevel = aggressive`,
  and `runtime.wasmerCompilerThreads = 4`.
- `PGLITE_OXIDE_WASMER_BIN=assets/wasix-build/work/upstream/wasmer/target/release/wasmer PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 cargo run -p xtask -- perf pglite-server-open`:
  pass. One smoke reported `openMicros = 1260443`, `connectMicros = 23001`,
  `firstQueryMicros = 2522`, and `observedServerPeakRssBytes = 268222464`.
  Largest captured phases were `server.pg18_wait_ready = 454379 us`,
  `server.root_prepare = 442819 us`, and `server.pg18_spawn = 319403 us`.
- `cargo run -p xtask -- perf bench --suite rtt --mode direct --iterations 1`:
  expected fail with `direct benchmark mode is not available for PostgreSQL 18
  WASIX server-core assets`.
- Matrix smoke without prepared lanes:
  `PGLITE_OXIDE_WASMER_BIN=assets/wasix-build/work/upstream/wasmer/target/release/wasmer tools/scripts/perf/run_native_libpglite_matrix.sh --rtt-iterations 3 --prepared-rows 10 --sdk-iterations 10 --speed-repeats 1 --stable-worktree /Users/sid/dev/pglite-oxide-stable-clean --allow-dirty-stable --skip-build --skip-prepared`
  pass. Report:
  `target/perf/native-libpglite-pg18-smoke-20260515T071316Z/report.md`.
  The report records `current WASIX runtime kind = wasix-postgres-server`,
  skips current direct mode, and measures PG18 server SQLx/tokio lanes against
  native PostgreSQL, native libpglite, and stable pglite-oxide controls. The
  report was regenerated after the macOS RSS-total correction.
- Open-profile matrix smoke:
  `PGLITE_OXIDE_WASMER_BIN=assets/wasix-build/work/upstream/wasmer/target/release/wasmer PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 tools/scripts/perf/run_native_libpglite_matrix.sh --rtt-iterations 2 --prepared-rows 10 --sdk-iterations 2 --speed-repeats 1 --skip-stable --skip-prepared`
  pass. Report:
  `target/perf/native-libpglite-pg18-open-smoke-20260515T073333Z/report.md`.
  The Method section includes the PG18 server runtime config, and the Open
  Phase Profile includes `Current WASIX PgliteServer`.

Smoke perf notes:

- PG18 server SQLx RTT median p90: `668 us`; stable server SQLx RTT median p90:
  `284 us`; this is a miss in a low-sample smoke and needs a full repeat run.
- PG18 server SQLx speed suite: `2.706 s`; stable server SQLx speed suite:
  `2.821 s`; this passes the stable comparison in the smoke.
- PG18 server SQLx process RSS/observed server RSS remains high:
  approximately `327 MiB` max RSS, `327 MiB` observed server RSS, and `363 MiB`
  corrected estimated total memory in this smoke. The previous `~655 MiB`
  total was a report-side double count on macOS.
- PG18 server open-profile smoke from the matrix reported `open = 1204 ms`,
  `connect = 108 ms`, `first query = 2370 us`, `observed server RSS = 255 MiB`,
  and corrected estimated total memory `270 MiB`. The largest startup phases
  were `server.pg18_wait_ready = 464 ms`, `server.pg18_spawn = 426 ms`, and
  `server.root_prepare = 309 ms`. This makes open latency a concrete promotion
  blocker alongside steady-state RTT/RSS.
- Stable prepared-update comparison was not included in the smoke because the
  older stable harness creates Unix sockets under the physical stable worktree
  path and hit macOS `SUN_LEN`; PG18 current prepared TCP server modes were
  validated separately above.
- Focused LLVM opt-level probe with `target/release/xtask perf bench --suite
  all --mode server-sqlx --iterations 20 --speed-source generated`:
  `aggressive` had `~1.09 s` open, `227 us` median RTT p90, `2.479 s` generated
  speed total, and `~325 MiB` speed RSS. `default` and `less` both incurred
  `~70 s` cold server open and `~752 MiB` RTT observed RSS; `none` reduced open
  to `~34 s` but slowed generated speed to `5.414 s`. The current aggressive
  default is therefore still the only defensible Wasmer LLVM opt-level for
  PG18 server-core benchmarks.

Interpretation:

- Direct mode remains intentionally unavailable for current PG18 server-core
  assets. It is no longer counted as a failing perf lane in PG18 matrix runs.
- Server mode is the only PG18 product path validated in this branch until a
  real direct PG18 runtime surface exists.

## pglite-oxide PG18 Shared Runtime Server-Core Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide`, `tools/xtask`, and the perf
matrix scripts. It did not change `libpglite` or `crates/libpglite-oxide`.

Changes:

- PG18 server-core root preparation now uses the shared runtime overlay path
  instead of unpacking a full runtime under every temporary database root.
  `prepare_server_core_runtime_layout` respects the existing runtime layout
  policy and reuses the process/shared runtime cache for the PostgreSQL 18
  server-core asset shape.
- The runtime cache is server-core aware: for `wasix-postgres-server` assets it
  validates and reuses `bin/postgres` plus the required PostgreSQL share tree,
  while preserving the legacy direct `bin/pglite` cache behavior for non-server
  assets.
- `PgliteServer` now retains the runtime module root from root preparation.
  External Wasmer server startup mounts that cached runtime root when it lives
  outside the per-database root, so `postgres` can run from the shared cache
  while PGDATA stays isolated.
- PG18 server-core `pg_dump` now uses the retained runtime module root too.
  This fixed the failure where dump tried to find `bin/pg_dump` inside the
  per-database upper root even though the executable lives in the shared cached
  runtime.

Validation:

- `cargo fmt --check --package pglite-oxide --package xtask`: pass.
- `cargo check -p pglite-oxide`: pass.
- `cargo check -p xtask`: pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --lib -- --nocapture`:
  pass, `60` passed / `3` ignored.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --tests -- --nocapture`:
  pass. Integration coverage included CLI `1`, client compatibility `26`,
  extensions `14` with PG18 extension cases explicitly skipped, native
  libpglite smoke wrappers `4` skipped/passed without native env, performance
  smoke `8`, PostgreSQL regression subset `8`, proxy `1`, and runtime smoke
  `22`.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --lib pg_dump_round_trip_plain_sql -- --nocapture`:
  pass before the full-suite rerun.
- `bash -n tools/scripts/perf/run_native_libpglite_matrix.sh`: pass.
- `node --check tools/scripts/perf/summarize_native_libpglite_matrix.mjs`:
  pass.
- `git diff --check` over the touched pglite-oxide, xtask, perf-script, and
  validation-doc files: pass.

One setup note: `cargo test` should use an absolute `PGLITE_OXIDE_WASMER_BIN`
path. A relative path is resolved from the test binary's package working
directory, not necessarily the workspace root, and can turn a valid local
Wasmer binary into a false setup failure.

Focused open-profile smoke after enabling the shared runtime:

```text
target/perf/pg18-runtime-knobs/pglite-server-open-shared-runtime-smoke.json
```

Result:

- Open: `1027.42 ms`.
- SQLx connect: `23.61 ms`.
- First query: `2702 us`.
- Observed server-process RSS: `267206656` bytes, about `254.8 MiB`.
- Largest phases: `server.pg18_wait_ready = 454.94 ms`,
  `server.pg18_spawn = 339.69 ms`, `server.root_prepare = 172.17 ms`,
  `pgdata.cached_template_clone = 166.48 ms`.
- Runtime cache work is no longer material: `runtime.cache_install = 3.46 ms`
  and `runtime.mountfs_upper_root = 0.71 ms`.

Short matrix smoke after rebuilding release `xtask`:

```sh
PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer \
PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive \
PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 \
tools/scripts/perf/run_native_libpglite_matrix.sh \
  --run-id pg18-shared-runtime-smoke-20260515T074405Z \
  --rtt-iterations 2 \
  --prepared-rows 10 \
  --sdk-iterations 2 \
  --speed-repeats 1 \
  --skip-stable \
  --skip-prepared
```

Report:

```text
target/perf/native-libpglite-pg18-shared-runtime-smoke-20260515T074405Z/report.md
```

Matrix smoke results:

- Current WASIX `PgliteServer` open profile: `1010.71 ms` open,
  `25.09 ms` connect, `2747 us` first query.
- Current WASIX open phases: `server.root_prepare = 219.34 ms`,
  `pgdata.cached_template_clone = 217.02 ms`,
  `server.pg18_spawn = 321.73 ms`, `server.pg18_wait_ready = 463.25 ms`.
- Current WASIX open RSS: observed server `255.8 MiB`, corrected estimated
  total `261.6 MiB`.
- PG18 server SQLx RTT median p90: `692 us`; native PostgreSQL SQLx RTT median
  p90: `526 us`; native PostgreSQL tokio simple RTT median p90: `480 us`.
- PG18 server SQLx speed suite: `3.237 s`; native PostgreSQL SQLx:
  `2.330 s`; native PostgreSQL tokio simple: `3.199 s`.
- PG18 server SQLx speed memory: process RSS `332.8 MiB`, observed server
  RSS `332.1 MiB`, corrected estimated total `357.3 MiB`.

A heavier comparison matrix was then run against the clean stable PG17 worktree
at `/Users/sid/dev/pglite-oxide-stable-clean` (`a531b37`):

```sh
PGLITE_OXIDE_PERF_BUILD_XTASK=0 \
PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer \
PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive \
PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 \
tools/scripts/perf/run_native_libpglite_matrix.sh \
  --run-id pg18-shared-runtime-stable-r30-s3-20260515T074744Z \
  --rtt-iterations 30 \
  --prepared-rows 10 \
  --sdk-iterations 100 \
  --speed-repeats 3 \
  --skip-prepared \
  --stable-worktree /Users/sid/dev/pglite-oxide-stable-clean
```

Report:

```text
target/perf/native-libpglite-pg18-shared-runtime-stable-r30-s3-20260515T074744Z/report.md
```

Heavier matrix results:

- Current WASIX `PgliteServer` open profile improved to `885.09 ms` open,
  `22.95 ms` connect, `2644 us` first query. Captured phases were
  `server.root_prepare = 173.81 ms`, `pgdata.cached_template_clone =
  172.18 ms`, `server.pg18_spawn = 281.49 ms`, and
  `server.pg18_wait_ready = 425.94 ms`.
- Current WASIX open RSS: observed server `257.8 MiB`, corrected estimated
  total `263.6 MiB`.
- RTT median p90: native libpglite direct `74 us`, native PostgreSQL tokio
  simple `90 us`, native PostgreSQL SQLx `155 us`, current PG18 server SQLx
  `172 us`, current PG18 server tokio simple `195 us`, stable direct `93 us`,
  stable server SQLx `187 us`, stable server tokio simple `165 us`.
- Speed suite p90 across 3 fresh processes: native libpglite direct
  `1.923 s`, native PostgreSQL tokio simple `1.946 s`, native PostgreSQL SQLx
  one-shot `1.901 s`, current PG18 server SQLx `2.720 s`, stable direct
  `2.915 s`, stable server SQLx `2.781 s`.
- Speed memory p90: current PG18 server SQLx estimated total `364.6 MiB`;
  stable direct `362.1 MiB`; stable server SQLx `299.5 MiB`; native PostgreSQL
  tokio simple server-inclusive estimate `165.7 MiB`.
- The report's stable gate passes for server SQLx RTT (`0.92x`) and speed suite
  (`0.978x`) versus stable PG17, but PG18 direct remains unavailable and the
  native PostgreSQL comparison still misses the product bar.

Critique:

- The shared-runtime change is a real startup improvement. The comparable
  pre-change open-profile smoke was about `1204 ms` open with
  `309 ms` in root preparation; the matrix after this pass is about `1011 ms`
  open with `219 ms` in root preparation, and the focused single open saw
  `172 ms` root preparation.
- This is still not promotion-ready. Runtime copying is no longer the dominant
  cost; `postgres` spawn, readiness wait, and PGDATA template clone now dominate
  open latency.
- Steady-state latency still trails native PostgreSQL in the stronger matrix
  (`172 us` server SQLx RTT median p90 versus `155 us` native PostgreSQL SQLx),
  and speed throughput is materially behind native PostgreSQL despite beating
  stable PG17 server SQLx in this run.
- RSS remains the biggest product blocker: PG18 server-core is still roughly
  hundreds of MiB, far above the native controls in this matrix.
- Direct mode remains intentionally unavailable for current PG18 server-core
  assets. It should stay skipped rather than being faked through a different
  runtime contract.
- PG18 extension preinstall and Unix-socket server endpoints remain skipped.
  Those are API/regression coverage gaps, not perf noise.
- The latest heavier matrix includes clean stable PG17 controls, but it is still
  not promotion-grade. Full promotion evidence needs larger repeat counts,
  prepared-update coverage without the stable Unix-socket path-length blocker,
  warm-cache measurements separated from cold-start measurements, CPU/footprint
  sampling, regression expansion, and explicit failure gates.

## pglite-oxide PG18 Server API Root Parity Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide` and docs. It did not change
`libpglite` or `crates/libpglite-oxide`.

Change:

- `PgliteServerBuilder` now supports `app(...)` and `app_id(...)`, matching the
  persistent app-data root API already available on `PgliteBuilder` and the
  documented server-mode root choices. This matters more for PG18 because
  `PgliteServer` is the only validated product path for current server-core
  assets.
- `PgliteServerBuilder` now also supports `template_cache(...)`, matching the
  direct builder's explicit cached-template versus fresh-initdb control for
  newly initialized roots.
- `docs/USAGE.md` now lists `app(...)` and `app_id(...)` in the server builder
  surface instead of implying only explicit paths and temporary roots, and it
  documents the server `template_cache(...)` knob.

Validation:

- `cargo check -p pglite-oxide`: pass.
- `cargo fmt --check --package pglite-oxide`: pass.
- `cargo test -p pglite-oxide --lib server_builder_exposes_persistent_app_roots_and_template_control -- --nocapture`:
  pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test runtime_smoke server_app_id_uses_platform_data_root_and_reopens -- --nocapture`:
  pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test runtime_smoke -- --nocapture`:
  pass, `23` passed.

Interpretation:

- This closes a real DX/API mismatch: PG18 server-core users can now use the
  same platform data directory convention as direct-mode users without manually
  constructing a path.
- It does not change the promotion status. Direct PG18 server-core remains
  unavailable, extensions and Unix sockets remain gaps, and the perf/RSS
  blockers from the previous section still stand.

## pglite-oxide PG18 Server URL Encoding Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide` and docs. It did not change
`libpglite` or `crates/libpglite-oxide`.

Change:

- `PgliteServer::connection_uri()` / `database_url()` now percent-encode the
  startup username and database path components for TCP and Unix-socket URLs.
  Previously the TCP URL interpolated both values directly, so roles or
  databases containing spaces, `@`, `/`, `?`, or `=` could produce malformed
  connection strings for SQLx and other URL-parsing clients.
- `docs/USAGE.md` now states that generated server URLs include
  `sslmode=disable` and percent-encode startup identity values when needed.

Validation:

- `cargo check -p pglite-oxide`: pass.
- `cargo fmt --check --package pglite-oxide`: pass.
- `cargo test -p pglite-oxide --lib tcp_connection_uri_percent_encodes_user_and_database -- --nocapture`:
  pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test client_compat sqlx_database_url_handles_reserved_startup_identity_chars -- --nocapture`:
  pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test client_compat -- --nocapture`:
  pass, `27` passed.

Interpretation:

- This hardens the PG18 server-core developer path for real app/test identities
  without adding SQLx or tokio-postgres as runtime crate dependencies.
- It does not change the remaining promotion blockers: direct PG18 server-core,
  extension preinstall, Unix sockets, RSS, and native PostgreSQL parity remain
  unresolved.

## pglite-oxide PG18 Server Connection Info Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide` and docs. It did not change
`libpglite` or `crates/libpglite-oxide`.

Change:

- Added public `PgliteServerConnectionInfo` and
  `PgliteServer::connection_info()`. The handle exposes dependency-light
  startup metadata for clients that prefer structured fields over URL parsing:
  `username()`, `database()`, `tcp_addr()`, `uri()`, `database_url()`, and on
  Unix `socket_path()` / `socket_dir()`.
- `PgliteServer::connection_uri()` and `database_url()` now delegate to the
  same connection-info URL builder. This keeps TCP and Unix-socket URL encoding
  behavior consistent.
- The Unix-socket URL branch now percent-encodes startup username and database
  values too. The earlier URL-encoding pass fixed the TCP branch; this closes
  the remaining branch-specific gap.
- `docs/USAGE.md` now points users to `connection_info()` when a Rust client
  accepts host, port, user, and database fields directly.

Validation:

- `cargo check -p pglite-oxide`: pass.
- `cargo fmt --check --package pglite-oxide`: pass.
- `cargo test -p pglite-oxide --lib connection_uri -- --nocapture`: pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test client_compat tokio_postgres_startup_options_are_forwarded_to_postgres -- --nocapture`:
  pass. The test now connects through `tokio_postgres::Config` using
  `server.connection_info()` instead of reparsing the URL.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test client_compat -- --nocapture`:
  pass, `27` passed.

Interpretation:

- This is an API/DX hardening step for the only currently validated PG18 product
  path: `PgliteServer`. It gives SQLx/tokio-postgres/app developers an
  idiomatic, dependency-light way to configure clients without URL reparsing.
- It does not change the remaining promotion blockers: direct PG18 server-core,
  extension preinstall, Unix socket runtime support, RSS, and native PostgreSQL
  parity remain unresolved.

## pglite-oxide PG18 PGDATA Clone Diagnostics Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide`. It did not change
`libpglite` or `crates/libpglite-oxide`.

Change:

- Added subphase timing inside `clone_pgdata_template_dir`:
  `pgdata.template_clone.fast_path` for the platform clone/reflink command and
  `pgdata.template_clone.fallback_copy` for the recursive safe-copy fallback.
- Tightened fast-path acceptance: a successful external clone command now must
  produce the expected template markers that exist in the source
  (`PG_VERSION` and `global/pg_control`) before the clone is accepted. Otherwise
  the partial destination is removed and the safe fallback is used.

Validation:

- `cargo check -p pglite-oxide`: pass.
- `cargo fmt --check --package pglite-oxide`: pass.
- `cargo test -p pglite-oxide --lib template_clone -- --nocapture`: pass.
- `cargo test -p pglite-oxide --lib cloned_template_marker_validation_checks_required_outputs -- --nocapture`:
  pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --lib -- --nocapture`:
  pass, `64` passed / `3` ignored.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 cargo run -p xtask -- perf pglite-server-open > target/perf/pglite-server-open-clone-subphases.json`:
  pass.

Open-profile result:

- `openMicros = 1066381`, `connectMicros = 25329`, `firstQueryMicros = 2900`.
- `observedServerPeakRssBytes = 269418496`.
- `pgdata.template_clone.fast_path = 181085 us`.
- `pgdata.cached_template_clone = 181088 us`.
- `server.root_prepare = 186109 us`.
- `server.pg18_spawn = 363201 us`.
- `server.pg18_wait_ready = 468564 us`.
- No `pgdata.template_clone.fallback_copy` phase appeared in the run.

Local template-cache inspection:

- Each cached PGDATA template observed locally is about `37 MiB` and `969`
  files.
- Direct `cp -cR` probes over the cached template measured roughly
  `0.16-0.17 s`, matching the open-profile fast-path subphase.

Interpretation:

- The PG18 server-core root-prepare bottleneck is not caused by accidentally
  falling back to the slow recursive copy path. The APFS clone fast path is
  active.
- The remaining `~170-180 ms` clone cost is metadata/file-count work over the
  PostgreSQL template itself. Further startup improvement likely needs a
  different PGDATA strategy, such as a smaller template, a host overlay/COW
  scheme for external Wasmer, or a persistent server/pool model. It should not
  be papered over by hardlinking mutable PGDATA files.
- This pass improves benchmark diagnosis and safety, not promotion status. Open
  latency, spawn/readiness time, RSS, direct PG18 server-core, extension
  preinstall, and Unix-socket support remain unresolved blockers.

## pglite-oxide PG18 Readiness Polling Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide`. It did not change
`libpglite` or `crates/libpglite-oxide`.

Change:

- Added readiness-loop subtotals for PG18 server-core startup:
  `server.pg18_wait_ready.poll_total`,
  `server.pg18_wait_ready.probe_total`, and
  `server.pg18_wait_ready.sleep_total`.
- Changed the readiness poll interval from a fixed `100 ms` sleep after each
  failed startup probe to an adaptive interval: `25 ms` during the first two
  seconds, then `100 ms` after that. This keeps normal startup responsive while
  avoiding aggressive polling during long failure waits.
- Refined that cadence so startup-probe wall time counts toward the interval.
  Slow probes now retry immediately instead of sleeping again after already
  spending more than the target interval inside the probe.

Validation:

- `cargo check -p pglite-oxide`: pass.
- `cargo fmt --check --package pglite-oxide`: pass.
- `cargo test -p pglite-oxide --lib server_core_ready_poll_interval_starts_fast_then_backs_off -- --nocapture`:
  pass.
- `cargo test -p pglite-oxide --lib server_core_ready_sleep_interval_counts_probe_time_toward_cadence -- --nocapture`:
  pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 cargo run -p xtask -- perf pglite-server-open > target/perf/pglite-server-open-ready-25ms-aggregate.json`:
  pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 cargo run -p xtask -- perf pglite-server-open > target/perf/pglite-server-open-ready-cadence.json`:
  pass after counting probe time toward cadence.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test client_compat -- --nocapture`:
  pass, `27` passed.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test runtime_smoke -- --nocapture`:
  pass, `23` passed.

Open-profile result after adaptive polling:

- `openMicros = 991236`, `connectMicros = 23727`, `firstQueryMicros = 2841`.
- `observedServerPeakRssBytes = 265076736`.
- `server.pg18_wait_ready = 390551 us`.
- `server.pg18_wait_ready.poll_total = 24 us`.
- `server.pg18_wait_ready.probe_total = 166108 us`.
- `server.pg18_wait_ready.sleep_total = 224255 us`.
- `server.pg18_spawn = 376275 us`.
- `server.root_prepare = 178781 us`.

Open-profile result after counting probe time toward cadence:

- `openMicros = 964397`, `connectMicros = 24571`, `firstQueryMicros = 2617`.
- `observedServerPeakRssBytes = 267190272`.
- `server.pg18_wait_ready = 383929 us`.
- `server.pg18_wait_ready.poll_total = 18 us`.
- `server.pg18_wait_ready.probe_total = 183650 us`.
- `server.pg18_wait_ready.sleep_total = 200063 us`.
- `server.pg18_spawn = 359094 us`.
- `server.root_prepare = 177277 us`.

Interpretation:

- The previous readiness diagnostic run with fixed `100 ms` sleeps measured
  `server.pg18_wait_ready = 472621 us` with about `314 ms` of sleep time.
  Adaptive early polling reduced the observed readiness wait to about `391 ms`
  in the focused rerun, and counting probe time toward the cadence reduced it
  further to about `384 ms`.
- The remaining readiness time is still split between startup probes and sleep,
  so there may be smaller poll-interval gains left, but the larger promotion
  blockers are now `postgres` spawn, PGDATA clone/root prep, and RSS.
- This is a startup-latency improvement and benchmark-diagnostics improvement,
  not a promotion-complete result.

## pglite-oxide PG18 Runtime Capability API Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide` and docs. It did not change
`libpglite` or `crates/libpglite-oxide`.

Fresh baseline before the API edit:

- `cargo fmt --check --package pglite-oxide`: pass.
- `cargo check -p pglite-oxide`: pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --lib -- --nocapture`:
  pass, `66` passed / `3` ignored.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test client_compat -- --nocapture`:
  pass, `27` passed.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test runtime_smoke -- --nocapture`:
  pass, `23` passed before this pass added two runtime-surface tests.

Change:

- Added public `PgliteRuntimeCapabilities` and
  `packaged_runtime_capabilities()`.
- Extended `PgliteRuntimeKind` with capability methods for:
  direct backend support, server support, TCP server endpoints, Unix-socket
  server endpoints, bundled extension preinstall, external server process use,
  and a stable direct-unavailable reason.
- `PgliteBuilder::open()` now checks packaged runtime capabilities before
  preparing roots for the default direct engine. Under PG18 server-core assets
  it fails early with an actionable `PgliteServer::builder()` /
  `PgliteServer::temporary_tcp()` message instead of relying on a later install
  failure.
- `docs/USAGE.md` now shows capability-based branching for crates that need one
  code path across stable direct-runtime assets and PG18 server-core assets.
- `crates/pglite-oxide/README.md` now describes the PG18 capability matrix:
  no direct backend, TCP server support, no Unix-socket server endpoint yet, no
  extension preinstall yet, and an external Wasmer/Postgres server process.

Validation after the API edit:

- `cargo check -p pglite-oxide`: pass.
- `cargo test -p pglite-oxide --lib runtime_kind_models_direct_and_server_core_capabilities -- --nocapture`:
  pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --lib -- --nocapture`:
  pass, `66` passed / `3` ignored.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test runtime_smoke packaged_runtime_capabilities_describe_available_api_surface -- --nocapture`:
  pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test runtime_smoke direct_builder_rejects_pg18_server_core_assets_with_actionable_error -- --nocapture`:
  pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test runtime_smoke -- --nocapture`:
  pass, `25` passed.
- `cargo fmt --check --package pglite-oxide`: pass.
- `git diff --check -- crates/pglite-oxide/src/pglite/engine.rs crates/pglite-oxide/src/pglite/builder.rs crates/pglite-oxide/src/lib.rs crates/pglite-oxide/src/pglite/mod.rs crates/pglite-oxide/tests/runtime_smoke.rs crates/pglite-oxide/README.md docs/USAGE.md docs/internal/PG18_BRANCH_VALIDATION.md`:
  pass.

Interpretation:

- The direct-vs-server decision is now an explicit public API fact instead of a
  convention in docs or tests. This is the defensible PG18 position right now:
  the bundled PG18 runtime is a `postgres` server-core artifact, so the stable
  direct `Pglite` API should not claim support until a real direct backend
  exists and passes the same regression/perf gates.
- This improves API/DX and test coverage for PG18 mode selection. It does not
  change the remaining promotion blockers: native performance parity, high RSS,
  Unix-socket support for PG18 server-core, extension preinstall, and a full
  production benchmark matrix remain open.

## pglite-oxide PG18 Native/Stable Matrix and Readiness Probe Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide` and validation docs. It did
not change `libpglite` or `crates/libpglite-oxide`.

Benchmark matrix:

- Command:
  `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 tools/scripts/perf/run_native_libpglite_matrix.sh --run-id pg18-current-vs-stable-native-smoke-20260515T085954Z --stable-worktree /Users/sid/dev/pglite-oxide-stable-clean --rtt-iterations 5 --sdk-iterations 5 --speed-repeats 1 --skip-prepared`
- Report:
  `target/perf/native-libpglite-pg18-current-vs-stable-native-smoke-20260515T085954Z/report.md`.
- The harness rebuilt release `xtask` for both current PG18 and the clean stable
  worktree before running.
- Current PG18 assets were `wasix-postgres-server`; current WASIX direct mode
  was correctly skipped.

Matrix result highlights:

- Current PG18 `PgliteServer` open in the matrix was `5450.22 ms`, connect was
  `358.41 ms`, first query was `22985 us`, observed server RSS was
  `256.9 MiB`, estimated total was `262.8 MiB`.
- Matrix open breakdown:
  `pgdata.template_clone.fast_path = 1477.21 ms`,
  `server.root_prepare = 1506.96 ms`,
  `server.pg18_spawn = 2123.4 ms`,
  `server.pg18_wait_ready = 1784.62 ms`,
  `server.pg18_wait_ready.probe_total = 1015.51 ms`,
  `server.pg18_wait_ready.sleep_total = 768.47 ms`.
- Server SQLx RTT p90 missed stable in the compact matrix:
  PG18 `17229 us` vs stable `8589 us` (`2.006x`).
- Server SQLx speed suite beat stable in the compact matrix:
  PG18 `24.079 s` vs stable `269.095 s`.
- Memory remained a blocker:
  PG18 server SQLx p90 estimated total memory was `359.8 MiB`; native
  PostgreSQL SQLx was `151.2 MiB`; native PostgreSQL tokio simple was
  `164 MiB`.

Change:

- Reduced PG18 readiness-probe read/write timeout during normal startup. The
  previous probe used `2 s` I/O timeouts, so once the TCP port accepted but the
  server was not ready to answer, individual failed probes could add seconds to
  startup.
- Added `server_core_ready_probe_io_timeout(elapsed)`:
  `250 ms` for the first `10 s`, then `1 s` for longer waits.
- `wait_for_server_core_ready` now passes that timeout into
  `probe_postgres_startup`.
- Added unit coverage:
  `server_core_ready_probe_io_timeout_starts_short_then_relaxes`.

Validation:

- `cargo fmt --check --package pglite-oxide`: pass.
- `cargo check -p pglite-oxide`: pass.
- `cargo test -p pglite-oxide --lib server_core_ready_probe_io_timeout_starts_short_then_relaxes -- --nocapture`:
  pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test client_compat -- --nocapture`:
  pass, `27` passed in `178.71 s`.
- `cargo build --release -p xtask`: pass after reverting the rejected `100 ms`
  experiment; the release perf binary now matches the final `250 ms` source.

Focused open-profile evidence:

- Before the readiness-probe I/O timeout change, three post-matrix
  `target/release/xtask perf pglite-server-open` repeats showed:
  - `open = 6098.84 ms`, `ready = 2392.65 ms`,
    `probe_total = 1176.76 ms`, `sleep_total = 1215.41 ms`.
  - `open = 8873.68 ms`, `ready = 5830.50 ms`,
    `probe_total = 3288.23 ms`, `sleep_total = 2534.36 ms`.
  - `open = 10642.61 ms`, `ready = 5700.89 ms`,
    `probe_total = 3869.33 ms`, `sleep_total = 1818.73 ms`.
- With the accepted `250 ms` early I/O cap, three focused repeats showed:
  - `open = 1511.19 ms`, `ready = 585.70 ms`,
    `probe_total = 282.23 ms`, `sleep_total = 303.40 ms`.
  - `open = 1360.83 ms`, `ready = 611.32 ms`,
    `probe_total = 360.26 ms`, `sleep_total = 250.96 ms`.
  - `open = 1768.50 ms`, `ready = 806.95 ms`,
    `probe_total = 439.62 ms`, `sleep_total = 367.25 ms`.
- A `100 ms` early I/O cap was tested and rejected. Three focused repeats
  regressed to `21-33 s` opens with `16-25 s` of probe time, so the final code
  uses `250 ms`.
- After rebuilding release `xtask` back to the final `250 ms` source, a single
  confirmation run produced
  `target/perf/pglite-server-open-ready-io-timeout-250ms-final.json`:
  `open = 8261.28 ms`, `connect = 74.36 ms`, `first query = 8176 us`,
  `observedServerPeakRssBytes = 270237696`,
  `pgdata.template_clone.fast_path = 4949.61 ms`,
  `server.pg18_spawn = 1778.14 ms`,
  `server.pg18_wait_ready = 1469.42 ms`,
  `probe_total = 902.76 ms`, `sleep_total = 566.30 ms`.
  This final run confirms the rebuilt binary uses the lower readiness-probe
  behavior, but also shows PGDATA clone variance is now large enough to dominate
  single-sample open measurements.

Interpretation:

- The readiness-probe timeout was a real startup-latency bug in the PG18
  server path. The accepted `250 ms` cap removes multi-second failed-probe
  stalls without breaking the full client compatibility suite.
- The compact matrix and focused repeats show the next major startup blocker is
  not just readiness. PGDATA template clone/root preparation is highly variable
  on the current machine and can dominate open time. The machine also reported
  the APFS volume at `99%` capacity during investigation, which likely
  contributes to clone variance, but the product still needs a more robust
  startup strategy before promotion.
- Native parity is not achieved. Remaining blockers: PGDATA clone/root-prep
  variance, `postgres`/Wasmer spawn cost, high RSS, PG18 Unix sockets,
  extension preinstall, prepared-update matrix coverage, and full production
  multi-repeat benchmarks.

## pglite-oxide PG18 Low-Space PGDATA Template Strategy Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide` and validation docs. It did
not change `libpglite` or `crates/libpglite-oxide`.

Problem:

- The previous pass showed APFS clone/root-prep variance dominating PG18
  server open time on the current machine.
- Current disk state during investigation:
  `/System/Volumes/Data` was `99%` full, with about `13 GiB` available on a
  `926 GiB` volume.
- Manual probes under that disk condition:
  `cp -cR` APFS clone of the cached template took about `1.17-1.40 s`;
  direct `zstd -dc ... | tar -xf -` extraction of the embedded
  `1.5 MiB` PGDATA template archive took about `0.64-0.86 s`.

Change:

- Added `fs2` to `crates/pglite-oxide` for cross-platform filesystem
  free-space inspection.
- Added internal `PgDataTemplateInstallStrategy`.
- `try_install_embedded_pgdata_template` still uses the cached clone path on
  normal filesystems, but now selects direct embedded-template archive unpack
  when the target filesystem has less than `5%` free space.
- Added an internal override for diagnostics:
  `PGLITE_OXIDE_PGDATA_TEMPLATE_INSTALL=auto|clone|unpack`.
- Added `pgdata.embedded_template_direct_unpack` timing around the direct
  unpack path. The existing `pgdata.template_unpack` subphase remains visible
  inside it.
- Direct unpack stages into the PGDATA parent, validates `PG_VERSION` and
  `global/pg_control`, removes runtime state, and then renames into place so a
  failed unpack does not leave a partial cluster at the final path.

Validation:

- `cargo fmt --check --package pglite-oxide`: pass.
- `cargo check -p pglite-oxide`: pass.
- `cargo test -p pglite-oxide --lib pgdata_template -- --nocapture`:
  pass, `5` passed. This covered strategy parsing, low-space threshold
  selection, cached template install, interrupted PGDATA replacement, and direct
  unpack install.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test runtime_smoke -- --nocapture`:
  pass, `25` passed in `12.95 s`.
- First full `client_compat` run after enabling low-space direct unpack exposed
  a readiness-probe reliability regression under high parallel startup:
  `25` passed / `2` failed after `311.58 s`. The failing servers were ready in
  their logs, but probes kept timing out before reading startup responses.
- Readiness policy was then adjusted to keep the early `250 ms` probe I/O cap
  only for the first `10 s`, then restore the original `2 s` I/O timeout for
  overloaded long-tail startup.
- `cargo fmt --check --package pglite-oxide`: pass after that adjustment.
- `cargo check -p pglite-oxide`: pass after that adjustment.
- `cargo test -p pglite-oxide --lib server_core_ready_probe_io_timeout_starts_short_then_relaxes -- --nocapture`:
  pass after that adjustment.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test client_compat -- --nocapture`:
  pass, `27` passed in `143.24 s`.
- `git diff --check -- Cargo.lock crates/pglite-oxide/Cargo.toml crates/pglite-oxide/src/pglite/base.rs crates/pglite-oxide/src/pglite/server.rs docs/internal/PG18_BRANCH_VALIDATION.md`:
  pass.

Open-profile evidence after the low-space strategy:

- Command used for release-profile measurements:
  `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 target/release/xtask perf pglite-server-open`.
- Three repeats:
  - `open = 1678 ms`, `connect = 36 ms`, `first query = 2 ms`,
    `pgdata.embedded_template_direct_unpack = 404 ms`,
    `pgdata.template_unpack = 403 ms`, `server.root_prepare = 411 ms`,
    `server.pg18_spawn = 598 ms`, `server.pg18_wait_ready = 651 ms`,
    observed server RSS about `253 MiB`.
  - `open = 1837 ms`, `connect = 53 ms`, `first query = 2 ms`,
    `pgdata.embedded_template_direct_unpack = 408 ms`,
    `pgdata.template_unpack = 408 ms`, `server.root_prepare = 411 ms`,
    `server.pg18_spawn = 668 ms`, `server.pg18_wait_ready = 750 ms`,
    observed server RSS about `253 MiB`.
  - `open = 1665 ms`, `connect = 40 ms`, `first query = 2 ms`,
    `pgdata.embedded_template_direct_unpack = 438 ms`,
    `pgdata.template_unpack = 438 ms`, `server.root_prepare = 442 ms`,
    `server.pg18_spawn = 568 ms`, `server.pg18_wait_ready = 646 ms`,
    observed server RSS about `252 MiB`.

Interpretation:

- On the current low-free-space APFS volume, direct archive unpack is materially
  more stable than the cached APFS clone path for PG18 temporary roots.
- This is an adaptive robustness improvement, not a universal replacement for
  COW clone. Healthy filesystems still use the cached clone path.
- Startup remains above native. After this pass, the dominant open costs are
  still PGDATA materialization, Wasmer/Postgres spawn, readiness, and high RSS.
  Native parity and promotion are still not achieved.

## pglite-oxide PG18 Log-Gated Readiness Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide` and validation docs. It did
not change `libpglite` or `crates/libpglite-oxide`.

Problem:

- The PG18 server-core startup path was still spending too much time in
  readiness probes. The low-space matrix reported
  `server.pg18_wait_ready = 1785.70 ms`, including `probe_total = 1019.53 ms`
  and `sleep_total = 764.58 ms`.
- Repeated failed PostgreSQL startup handshakes were useful as a correctness
  check, but expensive while the WASIX postgres process was still starting.

Change:

- `wait_for_server_core_ready` now watches the PostgreSQL log for the standard
  `database system is ready to accept connections` marker before attempting the
  wire-protocol startup probe.
- The existing protocol probe remains the final correctness check before
  returning the server to callers.
- If the log marker is unavailable, readiness falls back to the previous probe
  behavior after `2 s`, so changed logging does not strand startup forever.
- Added `server.pg18_wait_ready.log_total` timing and a unit test covering the
  ready-marker parser.

Validation:

- `cargo fmt --check --package pglite-oxide`: pass.
- `cargo check -p pglite-oxide`: pass.
- `cargo test -p pglite-oxide --lib server_core_ -- --nocapture`: pass,
  `5` passed.
- `cargo build -p xtask --release`: pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test client_compat -- --nocapture`:
  pass, `27` passed in `149.60 s`.

Open-profile evidence:

- Before, from
  `target/perf/native-libpglite-pg18-lowspace-current-vs-stable-native-smoke-20260515T104231Z/wasix-server-open.json`:
  `server.pg18_wait_ready = 1785.70 ms`, `probe_total = 1019.53 ms`,
  `sleep_total = 764.58 ms`.
- After, from
  `target/perf/pglite-server-open-log-ready-20260515T105720Z.json`:
  `server.pg18_wait_ready = 1118.00 ms`, `probe_total = 112.34 ms`,
  `sleep_total = 993.31 ms`, `log_total = 10.94 ms`.
- Readiness wall time improved by `667.70 ms`, and active probe time dropped by
  `907.20 ms`.
- Total open time for the after sample was `3151.17 ms`, but that sample also
  had slower low-space disk phases than the matrix baseline:
  `pgdata.embedded_template_direct_unpack = 932.05 ms` and
  `server.pg18_spawn = 1054.91 ms`. Treat total single-sample open time as
  noisy; the phase delta shows the readiness fix.

Interpretation:

- Log-gated readiness removes most failed-probe overhead without weakening the
  startup contract because a real PostgreSQL startup handshake is still required
  before success.
- The next startup bottlenecks are now PGDATA materialization variance,
  Wasmer/Postgres spawn, and high RSS. Native parity and promotion are still not
  achieved.

## pglite-oxide PG18 Wasmer CLI Help-Cache Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide` and validation docs. It did
not change `libpglite` or `crates/libpglite-oxide`.

Problem:

- `server_core_wasmer_command` checked Wasmer CLI feature support through
  repeated `wasmer run --help` subprocesses for every server start.
- Those checks happen inside `server.pg18_spawn`, so they directly tax visible
  startup latency.

Change:

- Added a process-local cache for Wasmer CLI help output keyed by executable
  path and subcommand.
- All existing option checks and error messages still go through
  `wasmer_cli_has_option`; the cache only removes repeated help subprocesses.

Validation:

- `cargo fmt --check --package pglite-oxide`: pass.
- `cargo check -p pglite-oxide`: pass.
- `cargo test -p pglite-oxide --lib server_core_ -- --nocapture`: pass,
  `5` passed.
- `cargo build -p xtask --release`: pass.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --test runtime_smoke -- --nocapture`:
  pass, `25` passed in `4.52 s`.
- `git diff --check -- crates/pglite-oxide/src/pglite/server.rs docs/internal/PG18_BRANCH_VALIDATION.md`:
  pass before this section was appended.

Open-profile evidence:

- Earlier low-space matrix baseline:
  `server.pg18_spawn = 678.80 ms`.
- Earlier log-gated readiness sample:
  `server.pg18_spawn = 1054.91 ms`.
- Help-cache repeats:
  - `target/perf/pglite-server-open-log-ready-help-cache-repeat1-20260515T112343Z.json`:
    `open = 1433.00 ms`, `server.root_prepare = 431.37 ms`,
    `pgdata.embedded_template_direct_unpack = 427.30 ms`,
    `server.pg18_spawn = 47.68 ms`,
    `server.pg18_wait_ready = 944.30 ms`, observed server RSS `257.4 MiB`.
  - `target/perf/pglite-server-open-log-ready-help-cache-repeat2-20260515T112345Z.json`:
    `open = 2334.47 ms`, `server.root_prepare = 677.08 ms`,
    `pgdata.embedded_template_direct_unpack = 672.41 ms`,
    `server.pg18_spawn = 40.84 ms`,
    `server.pg18_wait_ready = 1604.85 ms`, observed server RSS `253.8 MiB`.
- One outlier immediately after rebuild,
  `target/perf/pglite-server-open-log-ready-help-cache-20260515T112314Z.json`,
  had `open = 6275.67 ms`, driven by `pgdata.embedded_template_direct_unpack =
  2633.61 ms` and `server.pg18_wait_ready = 3023.32 ms`; even there,
  `server.pg18_spawn = 487.78 ms`, below the prior no-cache sample.

Interpretation:

- The repeated Wasmer help subprocesses were a real spawn-phase bug. After the
  cache, normal samples show `server.pg18_spawn` around `41-48 ms`.
- The remaining large variance is now outside Wasmer option discovery:
  low-space PGDATA unpack, PostgreSQL readiness, and RSS. Native parity and
  promotion are still not achieved.

## pglite-oxide PG18 Post-Startup-Fixes Matrix

Date: 2026-05-15

Command:

```sh
PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer \
PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive \
PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 \
tools/scripts/perf/run_native_libpglite_matrix.sh \
  --run-id pg18-logready-helpcache-current-vs-stable-native-smoke-20260515T113738Z \
  --stable-worktree /Users/sid/dev/pglite-oxide-stable-clean \
  --rtt-iterations 5 --sdk-iterations 5 --speed-repeats 1 \
  --skip-prepared --skip-build
```

Report:

```text
target/perf/native-libpglite-pg18-logready-helpcache-current-vs-stable-native-smoke-20260515T113738Z/report.md
```

Open-profile result:

- Current PG18 WASIX server open: `1653.13 ms`.
- SQLx connect: `67.59 ms`.
- First query: `4064 us`.
- Observed server RSS: `255.7 MiB`; estimated total: `270.2 MB`.
- `server.root_prepare = 495.39 ms`.
- `pgdata.embedded_template_direct_unpack = 485.89 ms`.
- `server.pg18_spawn = 151.78 ms`.
- `server.pg18_wait_ready = 982.43 ms`, with `log_total = 6.11 ms`,
  `probe_total = 99.64 ms`, and `sleep_total = 876.39 ms`.

Delta versus the previous low-space matrix:

- Open: `2842.55 ms -> 1653.13 ms` (`-1189.42 ms`).
- Spawn: `678.80 ms -> 151.78 ms` (`-527.02 ms`).
- Readiness: `1785.70 ms -> 982.43 ms` (`-803.27 ms`).
- Probe time: `1019.53 ms -> 99.64 ms` (`-919.89 ms`).

Gate result:

- Native libpglite direct gate passed in this smoke matrix:
  RTT median p90 `187 us` versus native Postgres tokio `745 us`;
  speed suite p90 `3.170 s` versus `3.916 s`;
  open p90 `208.91 ms` versus `1369.80 ms`;
  estimated memory `133.4 MB` versus `166.1 MB`.
- PG18 WASIX server did not pass the stable-worktree gate:
  server SQLx RTT median p90 `2258 us` versus stable `909 us` (`2.484x`);
  server SQLx speed suite p90 `8.079 s` versus stable `4.757 s` (`1.698x`).
- Current PG18 tokio-simple server RTT is better than SQLx but still not
  native: median p90 `1060 us` versus native Postgres tokio `745 us`.

Interpretation:

- The startup fixes materially improved PG18 server open in the matrix.
- The remaining promotion blockers are now clearer: server SQLx latency,
  speed-suite throughput, RSS/estimated memory, PG18 direct-mode decision, Unix
  sockets, extension preinstall, prepared-update coverage, and multi-repeat
  research-grade matrices. Native parity and stable replacement are still not
  achieved.

## pglite-oxide PG18 pg_dump Test DX Pass

Date: 2026-05-15

This pass stayed scoped to `crates/pglite-oxide` and validation docs. It did
not change `libpglite` or `crates/libpglite-oxide`.

Problem:

- `cargo test -p pglite-oxide --lib -- --nocapture` failed in this checkout
  when `PGLITE_OXIDE_WASMER_BIN` was not set and `wasmer` was not on `PATH`.
- The failing test was `pg_dump_round_trip_plain_sql`. It attempted the PG18
  server-core path and failed with:
  `Wasmer CLI is required for the PostgreSQL 18 WASIX server runtime; set
  PGLITE_OXIDE_WASMER_BIN or install wasmer on PATH`.

Change:

- The plain SQL pg_dump round-trip test now skips when PG18 server-core assets
  are present but no Wasmer CLI can be resolved.
- The same test still runs the real PG18 pg_dump round trip when
  `PGLITE_OXIDE_WASMER_BIN` is set or `wasmer` is available on `PATH`.

Validation:

- `cargo fmt --check --package pglite-oxide`: pass.
- `cargo test -p pglite-oxide --lib pg_dump_round_trip_plain_sql -- --nocapture`
  without Wasmer env: pass by explicit skip.
- `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer cargo test -p pglite-oxide --lib pg_dump_round_trip_plain_sql -- --nocapture`:
  pass, real test ran.
- `cargo test -p pglite-oxide --lib -- --nocapture` without Wasmer env:
  pass, `71` passed / `3` ignored.
- Earlier in this pass, the full library suite with the explicit Wasmer binary
  also passed: `71` passed / `3` ignored.

## pglite-oxide PG18 Server Tokio Speed Harness Pass

Date: 2026-05-15

This pass stayed out of `libpglite` and `crates/libpglite-oxide`.

Problem:

- The matrix measured PG18 server RTT for both SQLx and tokio-postgres simple
  query, but speed-suite throughput only for SQLx.
- That made it hard to separate PostgreSQL/WASIX execution cost from SQLx
  extended-query/client overhead.

Change:

- Added `run_speed_server_tokio_postgres_simple_benchmark` to `xtask perf bench`.
- `--suite speed --mode server-tokio-postgres-simple` now runs the same PGlite
  speed SQL through one long-lived tokio-postgres connection using the
  simple-query protocol.
- The native/libpglite matrix now records `wasix-server-tokio-all`, reports
  `WASIX server tokio simple` in the speed summary and speed-case table, and
  keeps backward-compatible loading for older `*-tokio-rtt` artifacts.
- The stable worktree control still uses its own release `xtask`. The current
  stable worktree does not expose server tokio speed mode, so stable tokio
  speed is reported as `n/a` instead of being faked.

Validation:

- `cargo fmt --check -p xtask`: pass.
- `cargo check -p xtask`: pass.
- `bash -n tools/scripts/perf/run_native_libpglite_matrix.sh`: pass.
- `node --check tools/scripts/perf/summarize_native_libpglite_matrix.mjs`:
  pass.
- `cargo build -p xtask --release`: pass.

Focused result:

- Command:
  `PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 target/release/xtask perf bench --suite speed --mode server-tokio-postgres-simple --speed-source pglite`.
- Artifact:
  `target/perf/pg18-server-tokio-speed-20260515T123954Z.json`.
- Result: open `608.20 ms`, connect `20.39 ms`, speed suite `2.572 s`,
  observed server RSS `335.0 MiB`.

Matrix result:

- Command:

```sh
PGLITE_OXIDE_WASMER_BIN=/Users/sid/dev/pglite-oxide-wasix-pg18-experiment/assets/wasix-build/work/upstream/wasmer/target/release/wasmer \
PGLITE_OXIDE_WASMER_LLVM_OPT_LEVEL=aggressive \
PGLITE_OXIDE_WASMER_COMPILER_THREADS=4 \
tools/scripts/perf/run_native_libpglite_matrix.sh \
  --run-id pg18-server-tokio-speed-current-vs-stable-native-smoke-20260515T124016Z \
  --stable-worktree /Users/sid/dev/pglite-oxide-stable-clean \
  --rtt-iterations 5 --sdk-iterations 5 --speed-repeats 1 \
  --skip-prepared --skip-build
```

- Report:
  `target/perf/native-libpglite-pg18-server-tokio-speed-current-vs-stable-native-smoke-20260515T124016Z/report.md`.
- Speed summary:
  - Native libpglite direct: `1.868 s`.
  - Native Postgres tokio simple: `2.081 s`.
  - Native Postgres SQLx: `3.289 s`.
  - PG18 WASIX server SQLx: `6.412 s`.
  - PG18 WASIX server tokio simple: `6.131 s`.
  - Stable worktree WASIX direct: `7.842 s`.
  - Stable worktree WASIX server SQLx: `9.586 s`.
- RTT summary:
  - PG18 server SQLx median p90: `910 us`.
  - PG18 server tokio simple median p90: `1130 us`.
  - Native Postgres tokio simple median p90: `236 us`.
  - Stable server SQLx median p90: `560 us`.
  - Stable server tokio simple median p90: `748 us`.

Interpretation:

- The previous “PG18 server speed misses stable” conclusion was too dependent
  on one SQLx-only lane. With the updated harness, PG18 server speed beats the
  current stable worktree's SQLx speed in this smoke matrix.
- PG18 server throughput is still not native-parity: the speed suite is about
  `2.95x` native Postgres tokio simple in this matrix, with high server RSS.
- The next performance blockers are backend/WASIX execution throughput,
  high RSS, RTT tail latency, and disk/startup variance, not missing SQLx-only
  benchmark coverage.
