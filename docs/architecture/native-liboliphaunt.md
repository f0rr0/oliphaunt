# Native liboliphaunt PG18 Path

The native product is split into two repo boundaries:

- `oliphaunt/` owns the C ABI, PostgreSQL 18 source pin, patch stack, build
  scripts, C smoke harness, and runtime header.
- `src/sdks/rust/` owns the Rust SDK shape over that C ABI.

The existing `oliphaunt-wasix` crate and WASIX release lane remain in place while
the native path is built out separately. The WASIX crate does not select or load
native `liboliphaunt`; Rust native behavior is owned by `oliphaunt`.

## Source And Patch Stack

The C lane is pinned in:

```text
src/runtimes/liboliphaunt/native/postgres18/source.toml
```

It currently targets PostgreSQL `18.4` and applies the patch stack in
`src/runtimes/liboliphaunt/native/patches/postgresql-18.4`.

External PG18 extension candidates are pinned separately in:

```text
src/runtimes/liboliphaunt/native/postgres18/external-extensions.toml
```

That manifest is an internal research input, not a public SDK extension catalog. The
native validation wrapper runs
`src/runtimes/liboliphaunt/native/bin/check-external-extension-pins.sh` without network access,
which verifies the manifest shape and any local checkout that exists. Use the
script's `--online` mode only when deliberately refreshing those pins against
upstream.

The entrypoint does not use `postgres --single`. It adds a dedicated embedded
backend entrypoint, routes libpq backend reads/writes through host-owned I/O
callbacks, and runs PostgreSQL's normal exit callbacks without calling
`exit(3)`.

## Build

Build the macOS happy-path dylib with:

```sh
src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
```

The script emits:

```text
target/liboliphaunt-pg18/out/liboliphaunt.dylib
target/liboliphaunt-pg18/install/bin/initdb
target/liboliphaunt-pg18/install/bin/postgres
```

`ccache` is used automatically when available. Set `OLIPHAUNT_CCACHE=off` to
disable it, or set `OLIPHAUNT_CCACHE=/path/to/ccache` to force a specific
binary.

The dylib build is also stamped. The script hashes the edited `liboliphaunt`
headers/sources and fingerprints the PostgreSQL embedded object/archive inputs;
if the stamp still matches and the dylib exports the required C ABI symbols, it
prints `reusing native liboliphaunt dylib` and skips the C object compile plus
dylib relink. Harnesses call `src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
--check-oliphaunt-current` in no-build mode so stale C ABI sources fail fast
instead of producing false-green native evidence. Set
`OLIPHAUNT_FORCE_RELINK=1` to force that relink.

Extension builds are opt-in and intentionally cacheable. The default direct
build is core-only for fast C ABI iteration. When
`OLIPHAUNT_BUILD_EXTENSIONS=1` is set, the build script fingerprints the
extension source trees, compiler selection, PostgreSQL patch/build inputs, and
`liboliphaunt` C ABI sources. If the fingerprint and required normal/embedded
artifacts are still valid, the script reuses the extension artifacts instead of
running the expensive clean/rebuild loop again. Set
`OLIPHAUNT_FORCE_EXTENSION_REBUILD=1` to force a full extension rebuild.
Harnesses can call `src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
--check-extension-artifacts-current` to prove the same fingerprint and artifact
readiness without downloading, extracting, configuring, compiling, or relinking.

External pgrx candidates have their own opt-in harness:

```sh
src/runtimes/liboliphaunt/native/bin/build-external-pgrx-extensions-macos.sh --fetch
src/runtimes/liboliphaunt/native/bin/build-external-pgrx-extensions-macos.sh
```

It reads the same source-pin manifest, uses the manifest-pinned `cargo-pgrx`
major/minor, builds the crate subdirectory recorded by the manifest as a normal
PostgreSQL package with the native PG18 `pg_config`, then rebuilds with linker
flags that bind the module to `@rpath/liboliphaunt.dylib` for direct/broker
embedded loading. It writes per-extension input stamps and exposes
`src/runtimes/liboliphaunt/native/bin/build-external-pgrx-extensions-macos.sh --check-current`, which
is the no-build gate used by `src/runtimes/liboliphaunt/native/tools/check-track.sh
external-pgrx`. The build lane is explicit and disk-guarded because candidate
extensions can have very different compile and artifact-size profiles. A repo-local
`target/liboliphaunt-tools/bin/cargo-pgrx` is discovered automatically. The
external-pgrx fingerprint tracks build-affecting inputs rather than the whole
harness file, so comments and DX-only script edits do not stale heavy extension
artifacts. `--refresh-current-stamps` validates existing normal and embedded
payloads, then rewrites the input stamps without repackaging.

## C ABI Contract

The canonical header is:

```text
src/runtimes/liboliphaunt/native/include/oliphaunt.h
```

The current ABI is intentionally small:

- `oliphaunt_init`
- `oliphaunt_exec_protocol`
- `oliphaunt_exec_simple_query`
- `oliphaunt_exec_protocol_stream`
- `oliphaunt_cancel`
- `oliphaunt_close`
- `oliphaunt_register_static_extensions`
- `oliphaunt_last_error`
- `oliphaunt_version`
- `oliphaunt_capabilities`
- `oliphaunt_free_response`

`oliphaunt_exec_protocol` accepts frontend PostgreSQL protocol frames after
`oliphaunt_init` has initialized the embedded backend session. Responses are owned
by the native library until `oliphaunt_free_response`.

Direct mode sets the process `PGDATA` environment variable to the active
`config.pgdata` for the backend lifetime so PostgreSQL extensions that consult
standard process state resolve files inside the selected root. `oliphaunt_close`
restores the caller's previous value, or unsets `PGDATA` if it was unset before
open. Broker and server modes provide stronger process isolation for apps that
cannot tolerate a process-wide environment mutation.

`oliphaunt_register_static_extensions` is the direct/mobile extension module
loader boundary. A process that links extension code statically calls it before
`oliphaunt_init` with module stems, PostgreSQL magic functions, optional `_PG_init`
callbacks, and exported C symbols. The PostgreSQL `dfmgr` patch then resolves
those entries through the normal `CREATE EXTENSION`/`LOAD` path instead of
calling `dlopen`/`dlsym`. The registry is process-wide, rejects malformed or
duplicate entries, and freezes at first backend startup. `oliphaunt_capabilities`
advertises this as `OLIPHAUNT_CAP_STATIC_EXTENSIONS`.

The Rust runtime resourcesr now emits the portable platform handoff for this:
`oliphaunt/static-registry/manifest.properties` and, for mobile-ready packages,
`oliphaunt/static-registry/oliphaunt_static_registry.c`. That generated source
exports `liboliphaunt_selected_static_extensions(size_t *count)`. Swift, Kotlin,
and React Native native bridges discover that optional symbol through the
process image and register its rows through the loaded `liboliphaunt`
`oliphaunt_register_static_extensions` symbol before `oliphaunt_init`. This keeps the
generated registry source independent of whether a platform links liboliphaunt
statically or loads it dynamically.

`oliphaunt_exec_simple_query` executes one SQL buffer through PostgreSQL's
simple-query protocol without requiring SDKs to allocate a frontend frame first.
This is a convenience and performance ABI for the common direct `execute(sql)`
path; raw protocol remains the cross-language compatibility boundary.

`oliphaunt_exec_protocol_stream` executes the same request shape but delivers
backend bytes to a callback as chunks. The C runtime scans backend frames
incrementally and completes the call when it observes `ReadyForQuery`. Streamed
backend chunks use a bounded in-process queue with producer backpressure so a
slow callback cannot turn a large result or `COPY` stream into unbounded RSS
growth. The default queue budget is 4 MiB and can be overridden for diagnostics
with `OLIPHAUNT_STREAM_QUEUE_MAX_BYTES`.

Protocol execution does not impose a default query timeout. Startup readiness
uses `OLIPHAUNT_STARTUP_TIMEOUT_MS` with the legacy `OLIPHAUNT_TIMEOUT_MS`
fallback, but long-running SQL must run until PostgreSQL completes or the owner
explicitly calls `oliphaunt_cancel`. Ordinary close waits for active SQL and then
detaches/closes the owning SDK handle.

`oliphaunt_cancel` requests cancellation of the active embedded backend query
out-of-band. It maps to PostgreSQL's normal interrupt path by setting
`InterruptPending` and `QueryCancelPending`, waking `MyLatch` when available,
and waking the host I/O condition variables. It is advertised through
`OLIPHAUNT_CAP_QUERY_CANCEL`; the Rust SDK maps broker and server cancellation onto
their own transport-native mechanisms.

Bootstrap no longer shells through `system(3)`: the C runtime forks and execs
`initdb` directly when a PGDATA root has no `PG_VERSION`. The Rust SDK now uses
the production bootstrap path first: `BootstrapStrategy::PackagedTemplate`
hydrates new roots from a cached base PGDATA template before entering
`oliphaunt_init`, so direct mode does not pay `initdb` on every fresh open.
`initdb` remains the explicit tooling fallback.

Native v1 is one active embedded PostgreSQL backend per process. The product
path keeps this honest with a process-wide guard; robust multi-root app behavior
belongs in broker mode rather than fake direct-mode multiplexing. Every live
root is protected by explicit root ownership, so direct, broker-helper, server,
backup, and restore fail fast instead of racing on the same PGDATA directory.
Plain C ABI callers get a default stable sibling filesystem lease from
`oliphaunt_init` for `<parent-of-pgdata>`, plus
`<parent-of-pgdata>/.oliphaunt.lock` as the visible root marker. C
`oliphaunt_restore` takes the same stable lease before staging or publishing a
restored root, so restore cannot replace a root currently owned by the direct
C ABI. Stable lease filenames live beside the root directory and use the shared
`.oliphaunt-root-<sha256-prefix>.lock` algorithm used by the Rust SDK, so C, Rust,
Swift, Kotlin, and React Native platform adapters contend on the same root
identity. SDKs that own a broader root coordinator set
`OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK`; the Rust SDK does this because its
coordinator uses a same-process canonical root registry plus stable filesystem
leases across direct, broker, server, backup, and restore paths. The stable
leases are keyed by the canonical root path and remain held while restore
replacement moves the old root aside and publishes the validated new root.
Restore/import uses stable path reservation before publish, which means a
missing or intentionally empty target stays empty until the validated archive is
ready to publish.

## Rust SDK

Point the Rust SDK at the build outputs:

```sh
export LIBOLIPHAUNT_PATH="$PWD/target/liboliphaunt-pg18/out/liboliphaunt.dylib"
export OLIPHAUNT_INSTALL_DIR="$PWD/target/liboliphaunt-pg18/install"
```

```rust,no_run
use oliphaunt::Oliphaunt;

# async fn demo() -> oliphaunt::Result<()> {
let db = Oliphaunt::builder()
    .path(".oliphaunt")
    .native_direct()
    .open()
    .await?;

let result = db.query("SELECT 1::text AS value").await?;
assert_eq!(result.get_text(0, "value")?, Some("1"));

let parameterized = db
    .query_params(
        "SELECT ($1::int4 + $2::int4)::text AS sum",
        [1_i32, 41_i32],
    )
    .await?;
assert_eq!(parameterized.get_text(0, "sum")?, Some("42"));

db.execute("CREATE TABLE items(id bigint PRIMARY KEY)").await?;

let tx = db.transaction().await?;
tx.query_params("INSERT INTO items VALUES ($1)", [1_i64]).await?;
tx.commit().await?;

db.close().await?;
# Ok(())
# }
```

Without `LIBOLIPHAUNT_PATH`, the native runtime returns a clear startup
error. The old `oliphaunt-wasix` crate is still the WASIX-oriented release lane.
`NativeBroker` and `NativeServer` are selected from the same builder through
`.native_broker()` and `.native_server()`.
Broker mode starts the helper with the same storage bootstrap policy selected on
the builder. In particular, `.existing_only()` is enforced by the helper and
will not silently create a new root.

The `OliphauntRuntime` implementation is intentionally split by responsibility:

- `src/sdks/rust/src/runtimes/liboliphaunt/native/mod.rs`: runtime/session behavior.
- `src/sdks/rust/src/runtimes/liboliphaunt/native/ffi.rs`: C ABI structs, symbols, and
  library resolution.
- `src/sdks/rust/src/runtimes/liboliphaunt/native/root.rs`: process/file root locks and
  PGDATA path preparation.
- `src/sdks/rust/src/runtimes/liboliphaunt/native/root/runtime.rs`: runtime cache
  orchestration.
- `src/sdks/rust/src/runtimes/liboliphaunt/native/root/runtime/locate.rs`: native install
  and embedded-module discovery.
- `src/sdks/rust/src/runtimes/liboliphaunt/native/root/runtime/install.rs`: selected
  runtime asset installation.
- `src/sdks/rust/src/runtimes/liboliphaunt/native/root/runtime/cache_key.rs`: runtime
  cache manifest, key, and validation logic.
- `src/sdks/rust/src/runtimes/liboliphaunt/native/root/template.rs`: packaged-template
  PGDATA bootstrap and root hydration.
- `src/sdks/rust/src/runtimes/liboliphaunt/native/root/extensions.rs`: selected extension
  SQL/data/module materialization policy.

Runtime materialization is profile-aware. Direct/broker use liboliphaunt-linked
extension modules because the embedded backend resolves modules inside the
`liboliphaunt` process. Server mode uses standalone PostgreSQL extension modules
from the install tree. The filtered `share/postgresql` tree is still manifest
gated, so a symlink back to the full install tree is not used because it would
make unselected extensions visible.

The materialized runtime and base PGDATA template are content-keyed under
`$TMPDIR/oliphaunt-runtime-cache` by default. Override with
`OLIPHAUNT_RUNTIME_CACHE_DIR` when benchmarking, testing cache invalidation,
or packaging a controlled runtime cache location. Template hydration defaults to
physical byte-copy because current native matrix evidence shows better p90
stability than APFS clone-on-write on the benchmark host. Set
`OLIPHAUNT_PGDATA_COPY_MODE=prefer-clone` for diagnostics that need to
compare clone-on-write hydration explicitly.

`NativeBroker` uses the same direct C ABI inside a helper process. On Unix
platforms the Rust SDK connects to that helper over a per-session Unix-domain
socket in `/tmp`; TCP loopback remains available by setting
`OLIPHAUNT_BROKER_TRANSPORT=tcp`. Every broker session uses a generated
per-process authentication token passed to the helper through its environment
and verified as the first IPC frame, so an unrelated local client cannot drive a
fresh helper merely by finding the socket or TCP port. Broker sessions retain
their launch plan and relaunch the helper against the same root when the helper
has exited between operations. In-flight requests are not automatically replayed
after a crash because their commit state may be unknown; the caller sees that
error, and subsequent operations can recover through normal PostgreSQL WAL
recovery.

Direct/server physical backup uses PostgreSQL's low-level online backup API:
`pg_backup_start`, archive `pgdata`, then `pg_backup_stop(wait_for_archive =>
false)` to obtain and write `backup_label` and `tablespace_map` into the
archive. `pg_wal` is collected after backup stop so the archive has the WAL
needed for same-version recovery. Broker forwards the same physical backup from
its helper process. The physical archive format is a concrete single-root
archive: restore accepts only regular files and directories under `pgdata`, and
backup fails if PGDATA contains anything else. Symlinks, hardlinks, FIFOs,
sockets, device nodes, sparse/special tar records, external tablespaces, and
linked WAL directories are rejected rather than silently producing a
non-portable archive. Server mode also supports `BackupRequest::sql()` through
packaged `pg_dump`.

Same-version physical restore is a first-class Rust SDK operation:
`Oliphaunt::restore(RestoreRequest::physical_archive(path, artifact))`. The SDK
does not ask callers to unpack tar archives manually. It stages restore output
next to the target root, rejects archive path traversal, duplicate canonical
paths, malformed tar framing, unsupported tar header formats, invalid tar
numeric and fixed-width string fields, unexpected link metadata, directory
entries with payload bytes, and unsupported archive entry types. Restore writes
only to the validated canonical archive path for each entry, validates the
archive tree shape before writing staging files, validates `PG_VERSION`,
`global/pg_control`, and `backup_label`, then publishes the root atomically.
The C ABI performs the same pre-extraction archive validation, so Swift,
Kotlin, and React Native platform adapters inherit the lower-level restore
contract rather than relying on Rust-only checks.
Existing roots are protected
by default and can be replaced only with `replace_existing()`, which first takes
the root lock. Existing symlink targets are rejected because restore publishes
with directory renames at the target path; callers should pass the real database
root path explicitly.

## Smoke Tests

Use the C smoke as the fastest C ABI harness:

```sh
src/runtimes/liboliphaunt/native/bin/smoke-host-happy-path.sh
```

It compiles the host C harness, opens a database, sends raw protocol bytes for
`SELECT 1 AS value`, verifies ABI version/capability reporting, invalid init and
invalid exec argument errors, malformed frontend frame rejection and recovery,
SQL-error recovery with a second successful query, large owned-response growth,
streaming callback delivery, stream-callback failure recovery, active-query
cancellation and recovery, idempotent response cleanup, static extension
registration and PostgreSQL symbol resolution through `CREATE FUNCTION ... AS
'module', 'symbol'`, C ABI backup/restore, restore rejection for malformed tar
metadata and unsupported archive entries, backup rejection for symlinked PGDATA
entries, `PGDATA` pointing at the live root while the direct backend is active,
and restoration of the caller's `PGDATA` environment after direct backend
shutdown. It then closes cleanly and asserts that same-process direct reopen is
rejected with the documented process-lifetime error. The shell harness launches
the binary again against the same PGDATA root to verify persistence/reopen
across process boundaries.

Use the Rust SDK shape test for the separate package:

```sh
LIBOLIPHAUNT_PATH="$PWD/target/liboliphaunt-pg18/out/liboliphaunt.dylib" \
OLIPHAUNT_INSTALL_DIR="$PWD/target/liboliphaunt-pg18/install" \
cargo test -p oliphaunt --test sdk_shape -- --nocapture
```

The env-gated Rust SQL regression test exercises the same native runtime modes
for broader SQL behavior. It includes client-driven `COPY FROM STDIN` through
raw protocol frames, validates `CopyInResponse`, `CommandComplete`, and
`ReadyForQuery`, verifies the inserted payloads, and then runs a normal query to
prove post-COPY session reuse. It also drives invalid COPY input and an explicit
frontend `CopyFail`, verifies `ErrorResponse` plus `ReadyForQuery`, proves no
rows were committed, and runs follow-up queries to catch stuck COPY state. It
also includes `COPY TO STDOUT` streaming through `exec_protocol_raw_stream`,
validates `CopyOutResponse`, `CopyData`, `CommandComplete`, and `ReadyForQuery`,
verifies the expected streamed line and payload counts, and again proves the
session can execute normal queries after COPY:

```sh
OLIPHAUNT_TRACK_BUILD=never src/runtimes/liboliphaunt/native/tools/check-track.sh quick
```

## Current Deliberate Gaps

- One active direct backend per process; use broker/server for process-isolated
  lifecycles and multi-root app designs.
- `NativeDirect`, `NativeBroker`, and `NativeServer` expose out-of-band query
  cancellation. Direct maps to `oliphaunt_cancel`, broker uses a separate
  authenticated cancel IPC endpoint, and server sends PostgreSQL's native
  CancelRequest packet with the startup `BackendKeyData`.
- Rust `Oliphaunt::close()` rejects queued non-close work with `EngineStopped`
  once close begins, waits for the active SDK-owned operation to finish, and
  then closes or logically detaches the runtime. Interruption is explicit
  through `Oliphaunt::cancel()`.
- Direct native protocol streaming is implemented in the C ABI. Broker mode
  forwards native chunks over IPC. Server mode forwards complete PostgreSQL wire
  frames as it reads them from the local server connection. Direct streaming
  applies C-level producer backpressure with a bounded chunk queue.
- Extensions are materialized for selected PG18-supported extensions, and
  `NATIVE_EXTENSION_MANIFEST` records SQL/control assets, native module
  requirements, data files, smoke SQL strategy, coverage evidence, mobile
  static-link status, and first-party/external packaging policy for every
  supported row. `Extension::RELEASE_READY_PG18_SUPPORTED` is the public exact
  extension catalog; custom static manifests are restricted to release-ready
  first-party extensions. The external pgrx lane remains internal/deferred and
  must not be surfaced as shippable SDK extensions until licensing, static
  mobile linkage, and lifecycle evidence are complete. Required preload hooks
  are derived from selected extensions, so extensions that need preload can add
  `shared_preload_libraries` to direct, broker, and server startup from manifest
  data instead of app code. Resource
  packages now record package-level mobile
  static-registry readiness and the runtime-resource generator can fail iOS/Android release builds
  with `--require-mobile-static-registry` when selected module-backed extensions
  are still pending. The low-level C ABI registry now exists through
  `oliphaunt_register_static_extensions`; the Rust runtime-resource generator now generates the
  platform registry source for complete mobile packages, and platform packages
  still have to link the selected extension objects with the expected renamed
  magic/init symbols before marking a package complete. Platform package builds
  that actually link static extension
  registry rows can declare exact module stems with `--mobile-static-module`;
  unknown or unselected stems are rejected. Kotlin and React Native Android
  split-resource packaging deliberately cannot declare those stems complete,
  because that path cannot generate or verify the static-registry source; use
  the Rust runtime resources for mobile release extension artifacts. Generated
  packages record the exact selected extensions, dependency-expanded runtime
  manifest, static-registry state, and per-extension size evidence, so
  app-bundled resources are auditable without local path leakage. Signed
  dynamic desktop extension artifacts and device-tested per-platform extension
  object builds are not complete yet. The gated
  native extension matrix iterates the manifest and covers install/load,
  restart, physical backup, and physical restore for every currently packaged
  extension across broker/direct-C-ABI and server paths.
- Broker mode starts one helper process per active root and uses a shared Rust
  supervisor to enforce `.broker_max_roots(n)` and duplicate-root admission.
  Sessions report `multi_root=true` when the configured broker root budget is
  greater than one. The helper still takes the same filesystem root lock, so
  independent broker runtimes cannot accidentally own the same root. Durable
  reconnect, crash-restart policy, and upgrade orchestration remain broker
  release gates.
- Server mode starts a local PostgreSQL process and exposes a connection string;
  SDK-owned protocol traffic uses a short Unix-domain socket on Unix by default
  with buffered frame reads, while the public connection string remains
  PostgreSQL-compatible TCP. The runtime cache includes `pg_dump` and `psql`,
  while broader ORM/pool parity tests are still release gates.
- The latest complete source-current native matrix is
  `target/perf/native-liboliphaunt-20260524T090412Z/report.md`, with verified
  provenance at
  `target/perf/native-liboliphaunt-20260524T090412Z/provenance.json` for that
  recorded source/artifact set. The checkout has since gained backup ABI and
  tar-writer changes, so refresh the full matrix before making a current-source
  release claim. The
  PostgreSQL control is `postgres (PostgreSQL) 18.4`, with matched `safe`
  durability and `throughput` runtime footprint across native liboliphaunt,
  native PostgreSQL, and SQLite controls. Template bootstrap keeps the
  open-time gate fixed: direct open p90 is `440.28 ms` versus native PostgreSQL
  tokio at `576.4 ms`. The safe-profile direct path passes repeated RTT, open,
  and RSS gates, but still misses speed-suite p90 (`2.668 s` versus `2.419 s`),
  speed tail throughput (`0.907x` native PostgreSQL), and physical
  backup/restore (`0.558 s` versus `0.344 s`) against the new native PostgreSQL
  physical-archive control with equal `56.17 MB` p50 payloads.
  The benchmark harness uses 10 fresh-process RTT repeats, 20 fresh-process
  speed repeats, 10 prepared repeats, and 10 backup/restore repeats before
  classifying a run as release evidence. Direct, broker, server, native
  PostgreSQL tokio, and SQLite are `stable` on that host run. Individual direct
  speed cases `1`, `2`, `2.1`, `3`, `3.1`, `4`, `5`, `10`, and `13` remain
  above the 5% per-case tolerance in the complete matrix; isolated
  fresh-process diagnostics reproduce `1`, `2.1`, `3`, `4`, `10`, and `13`.
- A current-source focused backup diagnostic lives at
  `target/perf/native-liboliphaunt-20260524Tbackup-final-direct/report.md`.
  It is partial evidence only, but it verifies the new `oliphaunt_backup_ex`
  path that appends SDK metadata during the C archive write. Direct p90 improved
  to `0.534 s`; native PostgreSQL physical p90 in the same run is `0.324 s`.
  `OLIPHAUNT_TRACE_BACKUP=1` attributes the remaining direct cost mainly to
  `pg_backup_start` and PGDATA archiving.
  The matrix includes SQLite embedded comparison rows,
  artifact-size rows, large-result streaming, `COPY TO STDOUT` streaming, and
  prepared-update rows for sequential and pipelined direct/broker/server/native
  PostgreSQL paths. Native matrix runs build `oliphaunt-perf` explicitly, and
  the native boundary guard keeps Wasmer runtime crates behind opt-in feature
  gates. Remaining gaps are the measured speed
  and backup misses, SQLite open/RSS competitiveness, dedicated extended-query
  and typed-helper benchmark lanes, and repeating the full matrix whenever
  benchmark harness or runtime inputs change.
- Swift now has a native-direct C ABI runtime path through
  `OliphauntNativeDirectEngine`, with env-backed tests for open, raw protocol
  execution, cancellation, and close. Kotlin/Native now has the same direct
  C ABI path through `NativeDirectEngine`, including env-backed tests for
  missing-library diagnostics, raw protocol execution, process-bound reopen,
  cancellation, and close. The Kotlin public handle now treats `close()` as a
  lifecycle primitive: it marks the handle closed, waits for serialized
  execution to drain, then detaches native direct handles. Swift, Kotlin,
  and React Native now expose simple and parameterized typed result helpers
  layered over raw protocol execution, matching the Rust SDK concept without
  adding SQL semantics to the C ABI. React Native exposes the same `cancel()`
  lifecycle method in its Codegen-safe TurboModule surface. React Native iOS now
  delegates its TurboModule calls to `Oliphaunt` through an
  Objective-C-visible Swift adapter instead of carrying a duplicate C ABI
  runtime. React Native Android delegates its TurboModule calls to the
  Kotlin SDK instead of carrying a separate Kotlin/JNI/CMake runtime. The React
  Native SDK verifier now runs Android Codegen, Kotlin compilation, Gradle
  `assembleDebug`, Kotlin SDK JNI syntax, Swift adapter compilation against
  `Oliphaunt`, and a synthetic Android runtime/template asset packaging check
  when `ANDROID_HOME` is set. Android runtime materialization and template
  PGDATA hydration are owned by the Kotlin SDK; Apple materialization and
  template hydration are owned by `Oliphaunt`. Packaged Android
  `liboliphaunt.so`, extension loading with real artifacts, full New
  Architecture app builds, and iOS/Android device smoke tests are not complete
  yet.

The full maintainer track critique and release blocker list lives in
`docs/internal/OLIPHAUNT_TRACK_REVIEW.md`.
