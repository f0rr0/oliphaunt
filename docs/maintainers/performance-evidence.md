# Performance

`oliphaunt-wasix` is built to stay close to native Postgres while keeping the
database embedded in the Rust process.

This page tracks the repo benchmark matrix. The main comparison uses SQLx on
each wire-protocol path:

- native Postgres with SQLx;
- `oliphaunt-wasix + SQLx`;
- vanilla `@electric/wasm` persisted with NodeFS and reached through
  `@electric/wasm-socket`, then measured with SQLx.

The native `oliphaunt` track has its own matrix for PostgreSQL 18 direct,
broker, and server modes. That matrix is the release gate for the native SDK and
must be used before claiming native parity:

```sh
tools/perf/matrix/run_native_oliphaunt_matrix.sh
```

Native server mode keeps the public PostgreSQL-compatible TCP connection string,
but SDK-owned protocol traffic uses Unix-domain sockets on Unix by default. Set
`OLIPHAUNT_SERVER_SDK_TRANSPORT=tcp` only when explicitly diagnosing TCP
transport behavior.

It records p50/p90/p95/p99 latency, suite totals, throughput, `/usr/bin/time`
CPU/RSS/footprint metrics, child-process RSS for broker/server modes, artifact
sizes, native PostgreSQL controls, a SQLite embedded speed control,
prepared-update rows, and backup/restore timings for native PostgreSQL, SQLite,
NativeDirect, and NativeBroker. NativeServer participates only in workloads its
public server API supports. The speed and backup/restore
sections report p50 elapsed time, p90 elapsed time, p95 elapsed time, median
throughput, tail throughput, p99 tail latency, native-PostgreSQL p90 ratios,
and command-level CPU/RSS/footprint p90/p99 so transport and persistence
regressions are visible without opening the raw JSON files.

When NativeDirect misses a native PostgreSQL gate, the generated report includes
a `Native Direct Regression Diagnostics` section with the missed gate, the
matching focused matrix command, and a repeated speed-case diagnostic wrapper
that runs NativeDirect as one fresh process per case/repeat before comparing it
with the native PostgreSQL control. The lower-level `perf diagnose-speed-cases`
commands remain available for one-off inspection.

The native matrix is native-only by default. The script builds `xtask` with
the `perf` feature explicitly enabled and builds the native broker helper:

```sh
tools/perf/matrix/run_native_oliphaunt_matrix.sh \
  --rtt-repeats 1 \
  --speed-repeats 1
```

For an even faster no-build sanity check of the benchmark plan:

```sh
tools/perf/matrix/run_native_oliphaunt_matrix.sh --quick --plan-only
tools/perf/matrix/run_native_oliphaunt_matrix.sh \
  --quick --plan-only --engines broker --suites streaming
tools/perf/check-native-perf-harness.sh
```

Use `--engines direct|broker|server|all` and
`--suites rtt|speed|streaming|prepared|backup|all` for focused diagnostic runs.
Focused runs still include the relevant native PostgreSQL control for the
selected suite, but the generated report marks them as partial coverage. They
are not release evidence.

Use repeated `--startup-guc name=value` flags for native footprint experiments.
The same explicit settings are passed to NativeDirect, NativeBroker,
NativeServer, and the native PostgreSQL control, and the
JSON/report/provenance files record the overrides:

```sh
tools/perf/matrix/run_native_oliphaunt_matrix.sh \
  --quick \
  --startup-guc shared_buffers=32MB \
  --startup-guc wal_buffers=-1
```

The PostgreSQL 18 mobile cluster seeds use standard 16MB WAL segments, so
`min_wal_size=8MB` and `min_wal_size=16MB` are invalid. WAL segment size is a
physical cluster property, not a startup GUC; the performance harness does not
regenerate or relabel release seeds. Mobile sweeps therefore select valid
startup settings only:

```sh
tools/perf/matrix/run_mobile_footprint_matrix.sh --quick --platform android \
  --min-wal-size 32MB,80MB \
  --max-wal-size 32MB,64MB \
  --crash-recovery off
```

The benchmark report captures PostgreSQL's effective read-only
`wal_segment_size` setting alongside the startup GUCs.

For Android/iOS device sweeps, use the Expo dev-client matrix wrapper. It emits
or runs explicit shared-buffer, WAL-buffer, WAL-minimum, and WAL-maximum
combinations against the installed React Native app.
Non-plan runs store every case in its own scratch directory and write
`summary.json` plus `summary.md` under `target/perf/mobile-footprint-<run-id>/`
with open time, typed and parameterized query p50/p90/p95/p99, set-based insert throughput, background
checkpoint latency, Android PSS/RSS, and iOS resident memory where the platform
harness can collect them. Package footprint is reported for the built Android
APK or iOS app bundle and the local React Native package tarball used by the
dev-client app. Benchmark reports also include a same-device Expo SQLite WAL
baseline, including simple-query, parameterized-query, indexed lookup, indexed
aggregate, update, checkpoint, large-result, and insert-throughput measurements
using an explicitly SQLite-specific durability profile, so mobile SQLite
comparison is device evidence instead of inferred from the host matrix. Each
native benchmark report also
records effective PostgreSQL settings through `current_setting(..., true)`, and
the matrix summary surfaces the core effective GUCs next to the intended startup
overrides. Treat measurements without those effective settings as incomplete
tuning evidence. Process memory is harness evidence rather than SDK API:
Android uses `adb`/`dumpsys meminfo`, while iOS uses the installed-app runner's
process report. Missing process-memory data remains blank rather than recording
a false zero. By default every matrix case also runs the installed-app
process-death recovery lane. The app verifies effective PostgreSQL `fsync`,
`full_page_writes`, and `synchronous_commit` are `on` before producing crash
evidence.
Use `--crash-recovery off` only for a diagnostic latency-only sweep:

```sh
tools/perf/matrix/run_mobile_footprint_matrix.sh --plan-only --platform android
tools/perf/matrix/run_mobile_footprint_matrix.sh --quick --platform android \
  --shared-buffers 8MB,32MB,128MB \
  --wal-buffers -1 \
  --min-wal-size 32MB \
  --max-wal-size 64MB \
  --crash-recovery off
tools/perf/matrix/run_mobile_footprint_matrix.sh --quick --platform ios --crash-recovery off
tools/perf/matrix/run_mobile_footprint_matrix.sh --platform ios
```

`--quick` keeps the same GUC axes but passes
`OLIPHAUNT_EXPO_MOBILE_BENCHMARK_PRESET=quick` into the Expo dev-client app so
the installed-app workload uses fewer warmup, latency, checkpoint, and insert
iterations. Use it for harness validation and emulator/simulator
sanity checks; use the default full preset for reportable numbers.
Use `--shared-buffers`, `--wal-buffers`, `--min-wal-size`, and `--max-wal-size`
to run a small slice with the same
installed-app harness before committing to the full device matrix.

Current diagnostic Android emulator slice:

- run id: `android-guc-slice-20260524T1750`
- report: `target/perf/mobile-footprint-android-guc-slice-20260524T1750/summary.md`
- platform: Android API 34 emulator through the Expo dev-client harness
- benchmark preset: `quick`
- fixed settings: `wal_buffers=-1`, `min_wal_size=32MB`,
  `max_wal_size=64MB`

| shared_buffers | Android PSS | Android RSS | Open ms | Param p90 ms | Insert rows/s | Checkpoint p90 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8MB | 253.7 MB | 383.1 MB | 7695.68 | 39.38 | 57 | 1457.90 |
| 32MB | 256.6 MB | 386.3 MB | 6347.87 | 41.92 | 77 | 1480.58 |

This is diagnostic emulator evidence, not a release claim. It does show that
lowering `shared_buffers` from 32MB to 8MB does not currently buy a proportional
resident-memory reduction in the React Native app process; fixed mappings,
runtime/cluster-seed assets, extension registry, or other PostgreSQL/React Native
process costs are still dominating the measured PSS/RSS. Keep the full device
matrix and source/build-cut investigations separate from this quick slice.

Latest Android emulator retry caveat:

- run id: `android-emulator-shared-minwal-slice-20260525T0325`
- report:
  `target/perf/mobile-footprint-android-emulator-shared-minwal-slice-20260525T0325/summary.md`
- result: one quick `shared_buffers=8MB,min_wal_size=8MB` case passed with
  Android harness process evidence; the matching `min_wal_size=32MB`
  case did not produce benchmark evidence.
- passed case: `271,565 KB` app PSS, `396,424 KB` host RSS, `41,415.89 ms`
  open, `286.18 ms` parameterized p90, `7.98 rows/s` insert throughput,
  and `126.77 ms` checkpoint p90.

A focused `min_wal_size=32MB` retry after adding a bounded
`Linking.getInitialURL()` path in the Expo example still failed before the
React Native app attached: Android killed the app process for `failed to attach`
/ `start timeout`, and Metro never served a bundle. Treat this as local AVD
instability, not PostgreSQL tuning evidence. Physical Android device evidence is
still required before Android defaults can be selected.

It is simulator evidence only. Physical iOS benchmark runs additionally require
a valid Apple Development signing identity or a working Xcode account that can
create one through automatic provisioning.

Current iPhoneOS build-only device-artifact evidence:

- scratch: `target/oliphaunt-expo-ios-device-buildonly-20260524T1615`
- mode: `OLIPHAUNT_EXPO_IOS_SDK=iphoneos`,
  `OLIPHAUNT_EXPO_IOS_BUILD_ONLY=1`,
  `OLIPHAUNT_EXPO_IOS_CODE_SIGNING_ALLOWED=NO`
- result: Xcode `Debug-iphoneos` build succeeded using the local
  `liboliphaunt.xcframework` iPhoneOS slice
- bundled Oliphaunt resources: 1,874 files, 35,800,256 bytes
- iOS app bundle: 184,075,464 bytes
- packed React Native package: 14,015,379 bytes

This is compile/package evidence only. It proves the iPhoneOS artifact,
resource bundle, React Native local iOS pod integration, and New Architecture
generated code compile without relying on a runnable device. It is not runtime
performance evidence; physical install/launch still requires Developer Mode,
Developer Disk Image services, and valid signing on the paired phone.

Current physical iPhone install/runtime/benchmark evidence:

- scratch: `target/oliphaunt-expo-ios-device-crash-safe-smallwal-20260524T174847`
- runtime smoke scratch:
  `target/oliphaunt-expo-ios-device-smoke-autolifecycle-20260524T0018`
- latest reuse-installed runtime smoke:
  `target/oliphaunt-expo-ios-smoke/reports/smoke-report.json`
- quick footprint matrix scratch:
  `target/perf/mobile-footprint-ios-physical-memory-retry-20260525T0230`
- full candidate footprint matrix scratch:
  `target/perf/mobile-footprint-ios-physical-full-candidate-20260525T0200`
- device: iPhone 14 Pro, UDID `7C01EC26-8B01-56E6-872D-82BB72421567`
- mode: `OLIPHAUNT_EXPO_IOS_SDK=iphoneos`
- startup GUCs:
  `shared_buffers=32MB,wal_buffers=-1,min_wal_size=8MB,max_wal_size=32MB`
- result: Xcode `Debug-iphoneos` build succeeded and `devicectl device install
  app` installed bundle ID `dev.oliphaunt.reactnative.example`
- bundled Oliphaunt resources: 1,871 files, 35,799,044 bytes
- selected extension: `vector`, 38 files, 63,478 bytes
- iOS app bundle: 183,420,535 bytes
- packed React Native package: 14,008,184 bytes
- crash recovery: passed on the physical iPhone with app-private
  explicit React Native `applicationData` storage; verify reopened the recovered database in
  `146.99 ms` and read back `crash-ios-12452656`
- smoke/runtime: passed on the physical iPhone after the harness automatically
  backgrounded the app through Safari and foregrounded it again. The smoke
  covered `SELECT 1`, parameterized query, DDL, DDL event triggers, pgvector,
  extension selection, transaction/savepoint recovery, constraint error
  recovery, JSONB/arrays, recursive CTE/window functions, raw protocol
  streaming, query cancellation/recovery, checkpoint/physical backup, and
  background/foreground resume SQL.
- smoke timings: open `1360.33 ms`, select p50/p90/p99
  `0.23/0.25/0.57 ms`, backup payload `33,425,920` bytes, lifecycle SQL
  after foreground `27.43 ms`
- latest reuse-installed smoke after the bounded launch-URL change opened in
  `1357.67 ms`, reported select p90 `0.245 ms`, passed the
  `active -> inactive -> background -> active` lifecycle SQL check.
- the historical full candidate predates the explicit-GUC-only report shape;
  rerun it before using its performance or process-memory measurements as
  current evidence.

Current physical iPhone shared-buffer/min-WAL tuning slice:

- run id: `ios-physical-shared-minwal-slice-20260525T0300`
- report:
  `target/perf/mobile-footprint-ios-physical-shared-minwal-slice-20260525T0300/summary.md`
- device: same iPhone 14 Pro physical dev-client install
- platform: iPhoneOS through the Expo dev-client harness
- benchmark preset: `quick`
- fixed settings: `wal_buffers=-1`, `max_wal_size=32MB`, process-death recovery off
- varied settings: `shared_buffers=8/16/32/64/128MB`
- result: historical cases passed. Rerun the slice with qualified release seeds
  before making a current memory claim.

The iPhoneOS `liboliphaunt.xcframework` used for this run also has a stricter
artifact gate: the device and simulator slices are rejected if they import
mobile-forbidden SysV/POSIX shared-memory or semaphore APIs (`shm*`,
`shm_open`, or external `sem*`). This was added after a real-device `SIGSYS`
crash report showed PostgreSQL reaching `shmget` during embedded startup.

The wrapper skips `min_wal_size` values below two fixed 16MB WAL segments, so
8MB and 16MB are negative-only cases. Pass `--include-invalid-wal-min` only for
negative validation. The wrapper also skips
impossible WAL ranges such as `max_wal_size=32MB` with `min_wal_size=80MB`,
while preserving a `max_wal_size=default` baseline for the current
throughput-sized WAL ceiling.

Crash recovery after process death is measured by the installed-app crash lanes,
which write to a persistent app-private root, terminate the app without closing
the direct-mode database, relaunch, and verify committed data through
PostgreSQL recovery. The app accepts crash evidence only after observing
PostgreSQL `fsync=on`, `full_page_writes=on`, and `synchronous_commit=on`:

```sh
pnpm --dir examples/react-native-expo run crash:android
pnpm --dir examples/react-native-expo run crash:ios
```

Use the default script invocation for release evidence. Native release gates are
read against native PostgreSQL controls. The matrix plan labels runs with
`releaseEvidence`, `partialReport`, and `diagnosticRun` before any expensive
work starts. Default runs must meet the current release minimums: 100 RTT
samples, 10 fresh-process RTT repeats, 25,000 prepared-update rows, 10
fresh-process prepared repeats, 20 fresh-process speed repeats, and 10
fresh-process backup/restore repeats for direct and broker alongside the
supported direct/broker/server RTT, speed, streaming, and prepared workloads.
Quick or focused runs are diagnostic
evidence only, even when they are useful for investigating a regression.

Each native matrix run writes `provenance.json` next to `report.md`. The
provenance file records the benchmark source set, PostgreSQL patch/build inputs,
Rust SDK sources, `xtask`, and native artifacts by SHA-256. Verify an existing
run before using it as release evidence:

```sh
OLIPHAUNT_PERF_RUN_DIR="$PWD/target/perf/native-liboliphaunt-<run-id>" \
tools/perf/check-native-perf-report.sh
```

This validation rejects diagnostic and partial reports by default. To verify
only the source/artifact provenance of a focused diagnostic run, set
`OLIPHAUNT_PERF_ALLOW_DIAGNOSTIC=1`; do not use that mode for release
claims or updates to the latest complete matrix section.

Use the focused native diagnostic when a specific speed case misses the native
control and needs repeat evidence:

```sh
tools/perf/matrix/run_native_speed_diagnostics.sh --ids 1,2,2.1 --repeats 10 --skip-build
```

It writes `summary.json` and `summary.md` under
`target/perf/native-speed-diagnostics-<run-id>/`. Use the lower-level command
when you need a single raw diagnostic case:

```sh
LIBOLIPHAUNT_PATH="$PWD/target/liboliphaunt-pg18/out/liboliphaunt.dylib" \
OLIPHAUNT_INSTALL_DIR="$PWD/target/liboliphaunt-pg18/install" \
cargo run -p oliphaunt-perf -- \
  diagnose-speed-cases --engine native-liboliphaunt --ids 3
```

Native direct diagnostics run one case per process because the embedded backend
has a single safe process lifetime. Diagnostic output includes the engine
process model and key PostgreSQL GUCs so direct-mode misses can be separated
from control mismatch. The same command supports `--engine native-postgres`; it
uses `OLIPHAUNT_POSTGRES` / `OLIPHAUNT_INITDB` or the repo's
`target/liboliphaunt-pg18/install/bin` tools when present, with `--postgres-bin`
and `--initdb-bin` available for explicit overrides. Cluster-seed hydration
defaults to physical byte-copy because local matrix evidence showed better p90
stability than APFS clone-on-write. Set
`OLIPHAUNT_PGDATA_COPY_MODE=prefer-clone` only when investigating
clone-on-write behavior explicitly.

The SQLite control is part of the same matrix by default and can be run
directly for a quick embedded baseline:

```sh
cargo run -p oliphaunt-perf -- \
  sqlite --suite speed --speed-source oliphaunt --durability safe
```

`safe`, `balanced`, and `fast-dev` map to explicit SQLite PRAGMAs inside `oliphaunt-perf`,
so SQLite numbers are recorded as product comparison data rather than inferred
from a separate tool.

## Snapshot

Snapshot run: `20260507T113000Z`

Environment:

- OS: `macOS 26.4.1 (Darwin 25.4.0 arm64)`
- CPU: `Apple M1 Pro`
- RAM: `16 GB`
- Logical cores: `10`
- Node: `v24.13.0`
- Node packages: `@electric/wasm@0.4.5`,
  `@electric/wasm-socket@0.1.5`
- Native Postgres: `18.3 (Homebrew)`
- RTT iterations: `100`
- Speed source: exact upstream SQL from
  `target/oliphaunt-sources/checkouts/oliphaunt/packages/benchmark/src`

Every mode was run serially.

## Representative Operations

Lower is better.

| Operation | native pg + SQLx | oliphaunt-wasix + SQLx | vanilla Oliphaunt + SQLx |
|---|---:|---:|---:|
| 25,000 INSERTs in one transaction | 132.36 ms | 149.54 ms | 257.02 ms |
| 25,000 INSERTs in one statement | 46.14 ms | 59.39 ms | 117.19 ms |
| 25,000 INSERTs into an indexed table | 188.72 ms | 253.38 ms | 352.64 ms |
| 5,000 indexed SELECTs | 81.39 ms | 125.31 ms | 203.05 ms |
| 25,000 indexed UPDATEs | 351.05 ms | 578.96 ms | 720.63 ms |

## Full Operation Table

| ID | Test | native pg + SQLx | oliphaunt-wasix + SQLx | vanilla Oliphaunt + SQLx |
|---|---|---:|---:|---:|
| 1 | Test 1: 1000 INSERTs | 9.13 ms | 19.76 ms | 15.66 ms |
| 2 | Test 2: 25000 INSERTs in a transaction | 132.36 ms | 149.54 ms | 257.02 ms |
| 2.1 | Test 2.1: 25000 INSERTs in single statement | 46.14 ms | 59.39 ms | 117.19 ms |
| 3 | Test 3: 25000 INSERTs into an indexed table | 188.72 ms | 253.38 ms | 352.64 ms |
| 3.1 | Test 3.1: 25000 INSERTs into an indexed table in single statement | 66.41 ms | 95.12 ms | 93.88 ms |
| 4 | Test 4: 100 SELECTs without an index | 107.63 ms | 162.89 ms | 242.03 ms |
| 5 | Test 5: 100 SELECTs on a string comparison | 305.38 ms | 338.01 ms | 434.63 ms |
| 6 | Test 6: Creating indexes | 9.94 ms | 13.08 ms | 17.12 ms |
| 7 | Test 7: 5000 SELECTs with an index | 81.39 ms | 125.31 ms | 203.05 ms |
| 8 | Test 8: 1000 UPDATEs without an index | 47.91 ms | 74.42 ms | 103.66 ms |
| 9 | Test 9: 25000 UPDATEs with an index | 351.05 ms | 578.96 ms | 720.63 ms |
| 10 | Test 10: 25000 text UPDATEs with an index | 471.74 ms | 712.38 ms | 858.95 ms |
| 11 | Test 11: INSERTs from a SELECT | 65.64 ms | 97.43 ms | 112.87 ms |
| 12 | Test 12: DELETE without an index | 7.54 ms | 9.74 ms | 11.69 ms |
| 13 | Test 13: DELETE with an index | 9.31 ms | 26.58 ms | 27.7 ms |
| 14 | Test 14: A big INSERT after a big DELETE | 53 ms | 71.6 ms | 87.72 ms |
| 15 | Test 15: A big DELETE followed by 12000 small INSERTs | 58.98 ms | 74.49 ms | 112.18 ms |
| 16 | Test 16: DROP TABLE | 3.43 ms | 10.17 ms | 6.74 ms |

## Reproduce

Run the native matrix plan locally:

```sh
tools/perf/matrix/run_native_oliphaunt_matrix.sh --plan-only
```

Run measured native results when the native runtime artifacts are present:

```sh
tools/perf/matrix/run_native_oliphaunt_matrix.sh --engines direct,broker,server
```

That command covers:

1. native direct, broker, and server Oliphaunt paths;
2. native PostgreSQL control runs;
3. SQLite embedded control runs for the speed suite;
4. p50/p90/p95 latency, throughput, RSS, CPU, and footprint report generation.

The WASIX TypeScript binding owns the shared WASIX browser and Node benchmark
plans:

```sh
moon run oliphaunt-wasix-ts:bench
```

Run measured Node or browser evidence explicitly with
`moon run oliphaunt-wasix-ts:bench-run` or
`moon run oliphaunt-wasix-ts:bench-browser`.

Outputs land under `target/perf/`:

- `bench-native-postgres-sqlx-<run-id>.json`
- `bench-oliphaunt-native-direct-<run-id>.json`
- `bench-oliphaunt-native-broker-<run-id>.json`
- `bench-oliphaunt-native-server-<run-id>.json`
- `bench-sqlite-<run-id>.json`
- `bench-comparison-<run-id>.md`

Override the native Postgres binaries when needed:

```sh
OLIPHAUNT_POSTGRES=/path/to/postgres \
OLIPHAUNT_INITDB=/path/to/initdb \
tools/perf/matrix/run_native_oliphaunt_matrix.sh --engines direct,broker,server
```

## Reading The Matrix

- `oliphaunt-wasix + SQLx` is the product-style path for apps that connect through
  standard Postgres clients.
- `vanilla Oliphaunt + SQLx` keeps upstream Oliphaunt on NodeFS, but uses the same Rust
  SQLx client path as the other wire-protocol rows.
- These are machine-local numbers. Re-run the matrix before quoting them in a
  release note or public comparison.
