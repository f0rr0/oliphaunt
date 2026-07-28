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
NativeDirect, NativeBroker, and NativeServer. The speed and backup/restore
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
the `perf` feature explicitly enabled, avoiding the legacy `oliphaunt-wasix`
runtime-control path while still building the native broker helper:

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

Use `--runtime-footprint throughput|balanced-mobile|small-mobile` and repeated
`--startup-guc name=value` flags for mobile footprint experiments. The same
tuning is passed to NativeDirect, NativeBroker, NativeServer, and the native
PostgreSQL control, and the JSON/report/provenance files record the effective
profile and overrides:

```sh
tools/perf/matrix/run_native_oliphaunt_matrix.sh \
  --quick \
  --durability balanced \
  --runtime-footprint balanced-mobile \
  --startup-guc shared_buffers=32MB \
  --startup-guc wal_buffers=-1
```

The default PostgreSQL 18 template uses 16MB WAL segments, so
`min_wal_size=8MB` and `min_wal_size=16MB` are invalid for the default mobile
cluster. WAL segment size is an `initdb`/template-cluster property, not a
startup GUC. For the small-WAL mobile experiments, run the Expo matrix with a
matching template segment size:

```sh
tools/perf/matrix/run_mobile_footprint_matrix.sh --quick --platform android \
  --wal-segsize 4 \
  --min-wal-size 8MB,16MB \
  --max-wal-size 32MB,64MB \
  --durability balanced \
  --crash-recovery off
```

The harness passes `OLIPHAUNT_EXPO_MOBILE_WAL_SEGSIZE_MB` into the Android/iOS
dev-client scripts, regenerates the packaged template PGDATA with
`initdb --wal-segsize`, records `walSegmentSizeMB` in the template manifest, and
captures PostgreSQL's effective read-only `wal_segment_size` setting in the
benchmark report.

For Android/iOS device sweeps, use the Expo dev-client matrix wrapper. It emits
or runs the same runtime-footprint, shared-buffer, WAL-buffer, WAL-minimum,
WAL-maximum, and Safe/Balanced combinations against the installed React Native
app. The default profile is `balancedMobile`; pass `--runtime-footprint all` to
run `throughput`, `balancedMobile`, and `smallMobile` under the same GUC axes.
Non-plan runs store every case in its own scratch directory and write
`summary.json` plus `summary.md` under `target/perf/mobile-footprint-<run-id>/`
with open time, warm query p50/p90/p95/p99, bulk insert/update, background
checkpoint latency, Android PSS/RSS, and iOS resident memory where the platform
harness can collect them. Package footprint is reported at three separate
levels: the Oliphaunt embedded payload reported by the app, the built Android
APK or iOS app bundle, and the local React Native package tarball used by the
dev-client app. Benchmark reports also include a same-device Expo SQLite WAL
baseline, including simple-query, parameterized-query, indexed lookup, indexed
aggregate, update, checkpoint, large-result, and insert-throughput measurements
using the same durability label, so mobile SQLite comparison is device evidence
instead of inferred from the host matrix. Each native benchmark report also
records effective PostgreSQL settings through `current_setting(..., true)`, and
the matrix summary surfaces the core effective GUCs next to the intended startup
overrides. Treat measurements without those effective settings as incomplete
tuning evidence. React Native benchmark reports include app-reported process
memory via `Oliphaunt.processMemory()`: iOS records Mach task resident and
physical-footprint bytes, and Android records `Debug.MemoryInfo` PSS plus heap
fields. The matrix summary prefers this in-app report and uses `devicectl` or
`adb` process scraping only as additional harness evidence. Missing process
memory data leaves iOS resident memory blank rather than recording a false zero.
By default safe-durability matrix cases
also run the installed-app
process-death recovery lane. Balanced cases keep `synchronous_commit=off`, so
they remain latency/footprint evidence rather than last-commit survival gates.
Use `--crash-recovery off` only for a diagnostic latency-only sweep:

```sh
tools/perf/matrix/run_mobile_footprint_matrix.sh --plan-only --platform android
tools/perf/matrix/run_mobile_footprint_matrix.sh --plan-only --platform android --runtime-footprint all
tools/perf/matrix/run_mobile_footprint_matrix.sh --quick --platform android \
  --shared-buffers 8MB,32MB,128MB \
  --wal-buffers -1 \
  --min-wal-size 32MB \
  --max-wal-size 64MB \
  --durability balanced \
  --crash-recovery off
tools/perf/matrix/run_mobile_footprint_matrix.sh --quick --platform ios --crash-recovery off
tools/perf/matrix/run_mobile_footprint_matrix.sh --platform ios
```

`--quick` keeps the same GUC/profile axes but passes
`OLIPHAUNT_EXPO_MOBILE_BENCHMARK_PRESET=quick` into the Expo dev-client app so
the installed-app workload uses fewer warmup, latency, checkpoint, insert, and
large-result iterations. Use it for harness validation and emulator/simulator
sanity checks; use the default full preset for reportable numbers.
Use `--shared-buffers`, `--wal-buffers`, `--min-wal-size`, `--max-wal-size`,
`--wal-segsize`, and `--durability` to run a small slice with the same
installed-app harness before committing to the full device matrix.

Current diagnostic Android emulator slice:

- run id: `android-guc-slice-20260524T1750`
- report: `target/perf/mobile-footprint-android-guc-slice-20260524T1750/summary.md`
- platform: Android API 34 emulator through the Expo dev-client harness
- benchmark preset: `quick`
- fixed settings: `balancedMobile`, `balanced`,
  `wal_buffers=-1`, `min_wal_size=32MB`, `max_wal_size=64MB`

| shared_buffers | Android PSS | Android RSS | Open ms | Param p90 ms | Insert rows/s | Checkpoint p90 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8MB | 253.7 MB | 383.1 MB | 7695.68 | 39.38 | 57 | 1457.90 |
| 32MB | 256.6 MB | 386.3 MB | 6347.87 | 41.92 | 77 | 1480.58 |

This is diagnostic emulator evidence, not a release claim. It does show that
lowering `shared_buffers` from 32MB to 8MB does not currently buy a proportional
resident-memory reduction in the React Native app process; fixed mappings,
runtime/template assets, extension registry, or other PostgreSQL/React Native
process costs are still dominating the measured PSS/RSS. Keep the full device
matrix and source/build-cut investigations separate from this quick slice.

Current diagnostic Android emulator small-WAL slice:

- run id: `android-small-wal-20260524T1833`
- report: `target/perf/mobile-footprint-android-small-wal-20260524T1833/summary.md`
- platform: Android API 34 emulator through the Expo dev-client harness
- benchmark preset: `quick`
- fixed settings: `balancedMobile`, `balanced`, `shared_buffers=32MB`,
  `wal_buffers=-1`, `max_wal_size=32MB`, `--wal-segsize 4`

| min_wal_size | Effective wal_segment_size | Android PSS | Open ms | Param p90 ms | Lookup p90 ms | Aggregate p90 ms | SQLite param p90 ms | SQLite lookup p90 ms | SQLite aggregate p90 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8MB | 4MB | 257.9 MB | 11223.12 | 45.02 | 40.72 | 26.98 | 79.90 | 67.94 | 733.46 |
| 16MB | 4MB | 260.5 MB | 22116.32 | 71.35 | 37.20 | 47.34 | 78.57 | 34.45 | 31.58 |

This proves the harness can build and run an installed Android package against
template clusters with 4MB WAL segments and verify the effective PostgreSQL
`wal_segment_size`. The open-time spread is too noisy to treat this quick
emulator slice as a tuning decision; use it as harness evidence and run the full
physical-device matrix before picking the mobile default.

Latest Android emulator retry caveat:

- run id: `android-emulator-shared-minwal-slice-20260525T0325`
- report:
  `target/perf/mobile-footprint-android-emulator-shared-minwal-slice-20260525T0325/summary.md`
- result: one quick `shared_buffers=8MB,min_wal_size=8MB` case passed with
  app-reported `android-debug-memory-info`; the matching `min_wal_size=32MB`
  case did not produce benchmark evidence.
- passed case: `271,565 KB` app PSS, `396,424 KB` host RSS, `41,415.89 ms`
  open, `286.18 ms` parameterized p90, `7.98 rows/s` insert throughput,
  `126.77 ms` checkpoint p90, and `34.1 MB` embedded payload.

A focused `min_wal_size=32MB` retry after adding a bounded
`Linking.getInitialURL()` path in the Expo example still failed before the
React Native app attached: Android killed the app process for `failed to attach`
/ `start timeout`, and Metro never served a bundle. Treat this as local AVD
instability, not PostgreSQL tuning evidence. Physical Android device evidence is
still required before Android defaults can be selected.

Current diagnostic iOS simulator small-WAL slice:

- run id: `ios-small-wal-20260524T1855`
- report: `target/perf/mobile-footprint-ios-small-wal-20260524T1855/summary.md`
- platform: iOS 18.0 simulator through the Expo dev-client harness
- benchmark preset: `quick`
- fixed settings: `balancedMobile`, `balanced`, `shared_buffers=32MB`,
  `wal_buffers=-1`, `max_wal_size=32MB`, `--wal-segsize 4`

| min_wal_size | Effective wal_segment_size | iOS RSS | Open ms | Param p90 ms | Lookup p90 ms | Aggregate p90 ms | SQLite param p90 ms | SQLite lookup p90 ms | SQLite aggregate p90 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8MB | 4MB | 380.1 MB | 1109.52 | 0.50 | 0.67 | 0.95 | 0.94 | 0.84 | 0.94 |
| 16MB | 4MB | 382.2 MB | 1534.13 | 0.98 | 1.67 | 1.91 | 1.78 | 1.66 | 1.47 |

This proves the iOS harness can package the same 4MB-WAL template and capture
effective GUCs, package size, resident memory, and same-device SQLite baselines.
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
- mode: `OLIPHAUNT_EXPO_IOS_SDK=iphoneos`,
  `OLIPHAUNT_EXPO_MOBILE_DURABILITY=safe`,
  `OLIPHAUNT_EXPO_MOBILE_RUNTIME_FOOTPRINT=balancedMobile`,
  `OLIPHAUNT_EXPO_MOBILE_WAL_SEGSIZE_MB=4`
- startup GUCs:
  `shared_buffers=32MB,wal_buffers=-1,min_wal_size=8MB,max_wal_size=32MB`
- result: Xcode `Debug-iphoneos` build succeeded and `devicectl device install
  app` installed bundle ID `dev.oliphaunt.reactnative.example`
- bundled Oliphaunt resources: 1,871 files, 35,799,044 bytes
- selected extension: `vector`, 38 files, 63,478 bytes
- iOS app bundle: 183,420,535 bytes
- packed React Native package: 14,008,184 bytes
- crash recovery: passed on the physical iPhone with app-private
  `app-support://...` storage; verify reopened the recovered root in
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
  `active -> inactive -> background -> active` lifecycle SQL check, and reported
  an embedded payload of `35,799,044` bytes.
- full candidate footprint matrix: passed two physical-device cases with
  `shared_buffers=32MB`, `wal_buffers=-1`, `min_wal_size=8MB`,
  `max_wal_size=32MB`, 4MB WAL segments, and the full benchmark preset. Safe
  durability reported open `1386.29 ms`, raw p90 `0.04 ms`, typed p90
  `0.08 ms`, parameterized p90 `0.09 ms`, insert throughput `9686 rows/s`,
  checkpoint p90 `1.13 ms`, large-result p90 `0.81 ms`, process-death
  recovery elapsed `127.00 ms`, and recovery open `102.61 ms`. Balanced
  durability reported open `1466.92 ms`, raw p90 `0.04 ms`,
  typed p90 `0.09 ms`, parameterized p90 `0.10 ms`, insert throughput
  `9726 rows/s`, checkpoint p90 `1.15 ms`, and large-result p90 `0.80 ms`.
- same-device SQLite baseline in that full candidate matrix: Safe open
  `6.30 ms`, parameterized p90 `0.17 ms`, insert throughput `6855 rows/s`,
  large-result p90 `4.90 ms`; Balanced open `6.16 ms`, parameterized p90
  `0.16 ms`, insert throughput `6910 rows/s`, large-result p90 `4.97 ms`.
- app-reported iOS process memory source: `ios-task-vm-info`. Safe reported
  `253.3 MB` resident and `153.3 MB` physical footprint; Balanced reported
  `199.8 MB` resident and `137.5 MB` physical footprint.

Current physical iPhone shared-buffer/min-WAL tuning slice:

- run id: `ios-physical-shared-minwal-slice-20260525T0300`
- report:
  `target/perf/mobile-footprint-ios-physical-shared-minwal-slice-20260525T0300/summary.md`
- device: same iPhone 14 Pro physical dev-client install
- platform: iPhoneOS through the Expo dev-client harness
- benchmark preset: `quick`
- fixed settings: `balancedMobile`, `balanced`, `wal_buffers=-1`,
  `max_wal_size=32MB`, `--wal-segsize 4`, process-death recovery off
- varied settings: `shared_buffers=8/16/32/64/128MB`,
  `min_wal_size=8/16/32MB`
- result: 15 cases passed, 0 failed; every row recorded PostgreSQL effective
  GUCs and app-reported `ios-task-vm-info` memory.

| shared_buffers | effective wal_buffers | footprint median MB | footprint min-max MB | RSS median MB | open median ms | param p90 median ms | insert median rows/s |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8MB | 256kB | 135.5 | 135.3-136.2 | 202.7 | 1341.12 | 0.10 | 8710 |
| 16MB | 512kB | 136.1 | 135.9-136.3 | 198.4 | 1331.04 | 0.10 | 8972 |
| 32MB | 1MB | 137.0 | 136.9-137.3 | 199.4 | 1310.48 | 0.10 | 8907 |
| 64MB | 2MB | 139.5 | 139.3-141.0 | 205.4 | 1346.28 | 0.10 | 8923 |
| 128MB | 4MB | 142.8 | 142.4-146.3 | 208.5 | 1363.92 | 0.10 | 8858 |

This quick physical-device slice shows that `min_wal_size=8/16/32MB` does not
materially move app physical footprint for this small workload. Lowering
`shared_buffers` from 128MB to the 8-32MB band saves roughly 6-11MB of physical
footprint on this iPhone, but it does not collapse total process footprint
because the embedded Postgres/runtime/template baseline still dominates. Treat
this as tuning evidence for the mobile default shape, not as full release
evidence; Safe durability, additional `wal_buffers` values, runtime footprint
profiles, and physical Android still need corresponding device evidence.

The iPhoneOS `liboliphaunt.xcframework` used for this run also has a stricter
artifact gate: the device and simulator slices are rejected if they import
mobile-forbidden SysV/POSIX shared-memory or semaphore APIs (`shm*`,
`shm_open`, or external `sem*`). This was added after a real-device `SIGSYS`
crash report showed PostgreSQL reaching `shmget` during embedded startup.

By default the wrapper skips `min_wal_size` values below two WAL segments. With
the default `--wal-segsize 16`, that skips 8MB and 16MB. With
`--wal-segsize 4`, both become valid and are included. Pass
`--include-invalid-wal-min` only for negative validation. The wrapper also skips
impossible WAL ranges such as `max_wal_size=32MB` with `min_wal_size=80MB`,
while preserving a `max_wal_size=default` baseline for the current
throughput-sized WAL ceiling.

Crash recovery after process death is measured by the installed-app crash lanes,
which write to a persistent app-private root, terminate the app without closing
the direct-mode database, relaunch, and verify committed data through
PostgreSQL recovery. The default crash invocation uses safe durability; do not
interpret balanced/synchronous-commit-off runs as committed-row survival
evidence:

```sh
pnpm --dir src/sdks/react-native/examples/expo run crash:android
pnpm --dir src/sdks/react-native/examples/expo run crash:ios
```

Use the default script invocation for release evidence. Native release gates are
read against native PostgreSQL controls. The matrix plan labels runs with
`releaseEvidence`, `partialReport`, and `diagnosticRun` before any expensive
work starts. Default runs must meet the current release minimums: 100 RTT
samples, 10 fresh-process RTT repeats, 25,000 prepared-update rows, 10
fresh-process prepared repeats, 20 fresh-process speed repeats, and 10
fresh-process backup/restore repeats across the default direct/broker/server and
rtt/speed/streaming/prepared/backup matrix. Quick or focused runs are diagnostic
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
and `--initdb-bin` available for explicit overrides. PGDATA template hydration
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

Most recent recorded complete native track matrix:

- run id: `20260524T090412Z`
- report: `target/perf/native-liboliphaunt-20260524T090412Z/report.md`
- provenance: `target/perf/native-liboliphaunt-20260524T090412Z/provenance.json`
- PostgreSQL control: `postgres (PostgreSQL) 18.4`
- native durability profile: `safe`
- native runtime footprint profile: `throughput`
- PGDATA template hydration: `copy`
- RTT samples: `100`
- RTT repeats: `10`
- prepared-update repeats: `10`
- speed repeats: `20`
- backup/restore repeats: `10`
- provenance verification: passed for that recorded source/artifact set; rerun
  the full matrix before making current-checkout release claims after the
  later backup ABI/tar-writer changes.

Key results from that run:

| Metric | NativeDirect | NativeBroker | NativeServer | Native Postgres control | SQLite embedded |
| --- | ---: | ---: | ---: | ---: | ---: |
| RTT repeat gate p90 | 107 us | 124 us | 127 us | 112 us | n/a |
| Speed suite p90 | 2.668 s | 2.629 s | 2.452 s | 2.419 s | 3.871 s |
| Backup/restore physical p90 | 0.558 s | 0.62 s | 0.567 s | 0.344 s | 0.005 s |
| Backup payload p50 | 56.17 MB | 56.17 MB | 56.17 MB | 56.17 MB | 1.31 MB |
| Backup tail throughput p10 | 201.3 MB/s | 181.1 MB/s | 198.1 MB/s | 326.5 MB/s | 483.9 MB/s |
| Open p90 | 440.28 ms | 384.11 ms | 423.18 ms | 576.4 ms | 0.89 ms |
| p90 RSS | 123.5 MB | 107.9 MB process / 109.5 MB observed helper | 93.1 MB process / 138.5 MB observed server | 90.6 MB process / 128.7 MB observed server | 36.9 MB |

The packaged-template bootstrap path still fixes the prior native open-time
miss: direct open p90 is now `0.764x` native PostgreSQL control open p90, with
broker and server also below the native control. PGDATA template hydration
defaults to byte-copy because same-source evidence showed better p90 stability
than `prefer-clone`.

This run is more defensible than the older one-shot RTT snapshots because the
harness now runs 10 fresh-process RTT repeats and gates RTT on p90 across
repeated median-p90 summaries. It also still requires at least 20 fresh-process
speed repeats before classifying speed tail stability as release-grade. Under
the speed-quality rule, direct, broker, native PostgreSQL tokio, and SQLite are
`stable`; server is also `stable` on this host run.

Native direct passes the repeated RTT, open p90, and RSS gates, but it does not
yet pass the speed-suite or physical-backup gates. RTT gate p90 is `107 us`
versus native PostgreSQL tokio at `112 us` (`0.955x`). Speed-suite p90 is
`2.668 s` versus native PostgreSQL tokio at `2.419 s` (`1.103x`), and speed
tail throughput p10 is `63,420.4 ops/s` versus `69,938.9 ops/s` (`0.907x`).
Backup/restore now has a same-semantics native PostgreSQL physical control:
direct p90 is `0.558 s` versus native PostgreSQL physical at `0.344 s`
(`1.622x`), with equal `56.17 MB` p50 payloads. Direct backup tail throughput
p10 is `201.3 MB/s` versus native PostgreSQL physical at `326.5 MB/s`
(`0.617x`). The logical `pg_dump`/`pg_restore -Fc` control still appears in the
backup table as portability comparison data; its p90 is `0.149 s` with a
`1.27 MB` p50 payload.

A focused post-report backup diagnostic at
`target/perf/native-liboliphaunt-20260524Tbackup-final-direct/report.md`
uses matching current-source provenance but is intentionally partial. It covers
only NativeDirect plus native PostgreSQL backup/restore with 10 repeats after
the C ABI gained `oliphaunt_backup_ex`, in-archive SDK metadata append, direct
`read(2)` file copying, and per-entry tar buffer reservation. That run improves
the direct physical backup/restore p90 to `0.534 s`, but native PostgreSQL
physical remains `0.324 s`, so the backup gate is still a real miss. Opt-in
`OLIPHAUNT_TRACE_BACKUP=1` phase tracing shows the remaining direct cost is
concentrated in PostgreSQL `pg_backup_start` and PGDATA archive generation, not
Rust-side metadata annotation or FFI response copying.

Individual speed cases above the 5% tolerance in the complete matrix are `1`,
`2`, `2.1`, `3`, `3.1`, `4`, `5`, `10`, and `13`; the generated report includes
focused diagnostic commands for those ids. A follow-up fresh-process diagnostic run
stored at
`target/perf/native-speed-diagnostics-20260524T090412Z-speed-misses/summary.md`
reproduced stable misses for `1`, `2.1`, `3`, `4`, `10`, and `13`. Cases `2`,
`3.1`, and `5` did not reproduce above tolerance in that isolated per-case run
and should be rechecked only if they recur in the next complete matrix.
Compared with SQLite, native direct wins the total speed suite in this run
(`0.689x`) but still has much higher open p90 (`493.034x`) and RSS (`3.343x`).

Prepared-update p90 rows now include sequential and pipelined direct, broker,
server, and native PostgreSQL controls. Direct sequential prepared p90 is
`0.775 s` numeric and `0.768 s` text versus native PostgreSQL tokio at
`0.867 s` and `0.879 s`. Direct pipelined prepared p90 is `0.337 s` numeric and
`0.34 s` text versus native PostgreSQL tokio at `0.341 s` and `0.359 s`.

Artifact rows from the same run:

| Artifact | Size |
| --- | ---: |
| `liboliphaunt.dylib` | 11.14 MB |
| Embedded extension modules | 2.32 MB |
| Native PostgreSQL install | 33.62 MB |
| Native PostgreSQL install tree | 33.42 MB |

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

The WASM product lane has its own perf smoke target:

```sh
moon run oliphaunt-wasix:bench
```

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
