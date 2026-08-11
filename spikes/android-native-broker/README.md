# Android native broker spike

This DEBUG-only spike mirrors the iOS broker experiment on Android with a
private `:broker` service process, an AIDL/Binder control plane, and a reliable
Unix socket-pair file-descriptor data plane.

The `full` fixture exercises:

- distinct host and broker PIDs plus a random worker epoch;
- PostgreSQL protocol bytes over the socket data plane;
- cancellation from a Binder thread outside the occupied database executor;
- executor-deadlock and native-output-gated `pg_sleep` fail-stop paths;
- generation-scoped Binder death, `outcomeUnknown`, no SQL replay, and recovery
  to a fresh PID and epoch;
- controlled zero-read 8 MiB and 32 MiB streams that directly observe a
  blocked synchronous socket write; and
- persistent data and an ambiguous committed counter across injected worker
  deaths.

It is an experiment, not a production broker. Fault hooks are DEBUG-only, and
an emulator result is not physical-device evidence.

## Retained evidence

The final ten-run behavior series is:

```text
target/android-native-broker-spike/runs/pr-final-01-20260811T121603Z/
through
target/android-native-broker-spike/runs/pr-final-10-20260811T121854Z/
```

`target/android-native-broker-spike/runs/pr-doc-sync-v1/` is the post-document
single-run confirmation whose source manifest includes this final README. The
ten-run series used identical executable inputs and differs only in the README
evidence-path text.

All ten API 34 arm64 emulator runs passed 11 checks. They produced 30 injected
worker deaths, 30 generation-scoped Binder-death observations, 30
`outcomeUnknown` terminals, and 30 fresh PID/epoch recoveries followed by
healthy SQL. All 10 host PIDs and all 40 worker PIDs and epochs were unique in
the retained series.

Each native fault recorded 4,202,496 bytes from the native PostgreSQL stream
for an ordered output-then-`pg_sleep(60)` query before arming a two-second
fail-stop watchdog. This is strong source-backed sequencing evidence, not a
callback from inside `pg_sleep`.

The ambiguous counter was one after recovery and derived `replayCount` was zero
in every run. That proves no replay for the instrumented mutation, not a
generic exactly-once protocol.

For both stream sizes, a host-controlled gate prevented response reads while
two diagnostics samples observed the same blocking `responseBytes` write with
`POLLOUT=false` and unchanged completion counters for at least 300 ms. The
conservative pre-read accepted-wire upper bound was 493,920 bytes for every
8 MiB and 32 MiB trial; after releasing the gate, the same generation drained
the full response. This proves synchronous socket backpressure for this
workload. It does not establish a process-memory bound, effective `SO_SNDBUF`,
or throughput SLA.

Two earlier failed attempts are retained as negative evidence and are not part
of the passing series:

- `final-witness-001-20260811T113240Z` showed that a small first-statement
  `CommandComplete` remained buffered until after the sleeping statement, so it
  was not a usable pre-hang witness.
- `final-output-witness-006-20260811T115345Z` showed that the first transient
  non-writable socket write could advance before the client read. The final
  probe therefore keeps an explicit read gate closed and resets its candidate
  until one write remains unchanged for at least 300 ms.

See [the architecture and evidence report](../../docs/architecture/android-native-broker-spike.md)
for exact ranges, artifact hashes, and the proven/unproven split.

## Prerequisites

- Android SDK with the API 34 `Pixel_9_API_34_Google_API` arm64 AVD;
- JDK 17, NDK `27.0.12077973`, and CMake `3.22.1`;
- a current Android arm64 `liboliphaunt.so`; and
- prepared mobile runtime resources containing a PostgreSQL 18 template
  `PGDATA`.

The defaults are:

```text
target/android-native-broker-spike/native/out/liboliphaunt.so
target/android-native-broker-spike/runtime-resources
```

Override them with `OLIPHAUNT_ANDROID_BROKER_LIBOLIPHAUNT_SO` and
`OLIPHAUNT_ANDROID_BROKER_RUNTIME_RESOURCES_DIR`.

## Run

```sh
bash spikes/android-native-broker/run-emulator.sh
```

The runner:

1. requires the canonical Android native `--check-current` gate;
2. records exact source, APK, and native-library hashes;
3. builds the Debug APK;
4. starts or reuses only the API 34 arm64 AVD;
5. installs and clears the app once;
6. launches the full fixture and rejects stale reports by run nonce; and
7. validates the JSON contract, exact worker crash PIDs, process transitions,
   Binder deaths, native-output witness, replay counter, persistence, and
   socket-stall arithmetic.

Evidence is written beneath:

```text
target/android-native-broker-spike/runs/<run-nonce>/
```

## Claim boundaries

- The service is a separate private app process, not an Android
  `isolatedProcess`; it shares the app UID and private storage.
- Binder death is the explicit process-death signal. Reliable-socket EOF drives
  the same interruption path but does not identify why the peer disappeared.
- Recovery requires a different PID and epoch plus healthy SQL.
- Once request bytes may have reached the worker, loss is `outcomeUnknown` and
  the host does not retry SQL.
- The native output witness proves ordered PostgreSQL execution immediately
  before the sleeping plan child, but not a direct stack observation from
  inside `pg_sleep`.
- `pm clear` runs before each complete matrix, never between a fault and its
  recovery check.
- PSS/RSS and drain rates are observations, not acceptance limits.
- The retained result covers one API 34 arm64 emulator image. It does not prove
  physical-device behavior, other Android/OEM versions, broad reliability,
  lifecycle/Doze/LMK behavior, power-loss durability, concurrency,
  security isolation, a production watchdog policy, or Release/Play readiness.
