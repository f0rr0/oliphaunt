# liboliphaunt

`liboliphaunt` is the native C boundary for embedded PostgreSQL. It owns the
PostgreSQL 18 source pin, upstreamable patch stack, C ABI header, native shim,
and local smoke/build scripts.

This directory is intentionally not an app SDK. Rust, Swift, Kotlin, desktop
TypeScript, and React Native bind to this C ABI instead of reaching into
PostgreSQL internals.

## Layout

- `include/oliphaunt.h`: public C ABI.
- `src/liboliphaunt_native.c`: direct-mode lifecycle, backend thread ownership,
  and non-query public ABI entrypoints.
- `src/liboliphaunt_error.c`: synchronized shared errors plus nested,
  operation-local error attribution for binding-safe copies.
- `src/liboliphaunt_runtime.c`: embedded backend argv/default-GUC construction
  and backend thread stack sizing policy.
- `src/liboliphaunt_protocol.c`: raw protocol execution, streaming backpressure,
  readiness scanning, and embedded backend read/write callbacks.
- `src/liboliphaunt_config.c`: configuration copying, PostgreSQL executable
  resolution, and startup argument copying.
- `src/liboliphaunt_process.c`: process-wide direct-mode instance guard and
  desktop dynamic-extension symbol-scope promotion.
- `src/liboliphaunt_static_extensions.c`: process-wide static extension registry
  used by mobile-style builds that link extension modules into the app binary.
- `src/liboliphaunt_trace.c`: low-overhead protocol timing counters.
- `src/liboliphaunt_backup_state.c`: physical-backup phase validation and
  one-attempt failure cleanup.
- `src/liboliphaunt_archive.c`: backup/restore lifecycle over the C ABI.
- `src/liboliphaunt_archive_tar.c`: private ustar read/write implementation for
  same-version physical archives.
- `src/liboliphaunt_fs.c`: private filesystem/path helpers shared by archive and
  restore code.
- `src/liboliphaunt_internal.h`: private helpers shared between C translation
  units; not part of the public ABI.
- `patches/postgresql-18.4/`: minimal PostgreSQL patch stack.
- `postgres/series`: ordered native patch recipe, including shared patches from `third-party/postgres/patches/`.
- `third-party/postgres/source.toml`: shared pinned PostgreSQL source manifest.
- `bin/build-postgres18-macos.sh`: macOS build harness.
- `tools/run-host-c-smoke.sh --abi-only`: consumer-style C ABI check that
  includes only `oliphaunt.h`, links the public dylib, and verifies stable
  constants, structs, exported symbols, and safe global calls.
- `bin/smoke-host-happy-path.sh`: host C ABI smoke harness for macOS, Linux,
  and Windows.

## Build

```sh
runtimes/liboliphaunt-native/bin/build-postgres18-macos.sh
```

The default output root is `target/liboliphaunt-pg18`. Use `OLIPHAUNT_*` for runtime and build controls. `LIBOLIPHAUNT_PATH` is reserved
for the literal C library artifact path.

The direct build produces PostgreSQL runtime artifacts without optional
extension artifacts by default. Set `OLIPHAUNT_BUILD_EXTENSIONS=1` only when
refreshing or validating exact extension artifacts; the
`extension-artifacts-native:build-target` sets that flag when building extension artifacts.

Released extensions use the catalog and recipes under `extensions`.

`OLIPHAUNT_STARTUP_TIMEOUT_MS` bounds only initial backend startup readiness.
Normal `oliphaunt_exec_protocol`, `oliphaunt_exec_simple_query`, and streaming
execution do not impose a synthetic query timeout; callers should use
`oliphaunt_cancel` to interrupt long-running SQL. Ordinary SDK close is a
lifecycle detach/wait boundary, not an implicit query cancellation primitive.

Hosts serialize ordinary non-cancel calls on one logical C handle;
`oliphaunt_cancel` is the cross-thread exception. Streaming callbacks borrow
each byte chunk only for the callback invocation. They may copy it, inspect an
error, or cancel, but same-handle query, backup, detach, close, and nested stream
calls fail busy until streaming drains to `ReadyForQuery`. This guard applies
while the callback lock is released as well, preventing callback reentrancy or a
concurrent close from corrupting protocol state or freeing the active handle.

FFI schedulers that resume on a different thread use the ABI 10 `_with_error`
variants with one caller-owned `OliphauntErrorCapture` per invocation. The
worker fills that fixed-layout capture before its handle lease ends; synchronous
callers may continue copying the operation-local error immediately with
`oliphaunt_copy_last_error`.

The C runtime keeps throughput-oriented PostgreSQL defaults for direct callers:
`shared_buffers=128MB`, `wal_buffers=4MB`, and `min_wal_size=80MB`. SDKs that
need different PostgreSQL settings do not need a new C ABI; they pass validated
`-c name=value` startup arguments through `OliphauntConfig.startup_args`. Later
arguments win, so SDKs and benchmark harnesses can apply concrete PostgreSQL
GUC overrides above the stable C boundary without inventing tuning profiles.

SDKs must hydrate PGDATA from a packaged cluster seed before calling
`oliphaunt_init`; the C boundary never runs `initdb` or initializes an empty
root. `tools/run-host-c-smoke.sh` performs that preparation explicitly before
running the C consumer and includes a fast iOS simulator syntax
check over the liboliphaunt C shim files. `bin/check-postgres18-ios-simulator.sh`
then validates the upstream PostgreSQL patch touchpoints that matter for the
embedded path: host I/O callbacks, the embedded backend entrypoint, lifecycle
cleanup, static extension lookup, and shell-command exclusion on Apple mobile
SDKs.
`bin/build-postgres18-ios-simulator.sh` is the fast simulator artifact lane for
Expo/RN and Swift validation. `bin/build-postgres18-ios-device.sh` builds the
matching `IOS` device slice, and `bin/build-ios-xcframework.sh` packages both
validated dylibs with public headers as
`target/liboliphaunt-ios-xcframework/out/liboliphaunt.xcframework`. Each lane
cross-builds the patched PostgreSQL backend object graph, tolerates the final
PostgreSQL executable/tool link failure after the embedded objects exist,
links target-specific static ICU code for PostgreSQL collation support, stages
ICU data into the optional ICU package sidecar instead of the base runtime
install, validates the exported C ABI symbols, and reuses the result through
stamped ccache-friendly paths.

## Static Extension Registry

Mobile-style packages cannot rely on PostgreSQL dynamically loading every
extension module from the app bundle. `oliphaunt_register_static_extensions`
registers statically linked modules before `oliphaunt_init`, and the PostgreSQL
`dfmgr` patch resolves those entries through the same normal `CREATE
EXTENSION`/`LOAD` path that dynamic modules use. The registry is process-wide,
validates extension names, magic functions, symbol names, duplicate symbols,
and ABI versions, and becomes immutable at backend startup.

The runtime-resource `--mobile-static-module <stem>` flag is only release
metadata. It must match modules that the platform package actually links and
registers through this C ABI before opening the database.

The macOS arm64, iOS simulator, iOS device, and Android build lanes also emit
per-extension static archives beside the generated object lists:
`out/extensions/<stem>/liboliphaunt_extension_<stem>.a`. Those archives are the
release artifact boundary for exact mobile extension selection; SDK packaging
can link only the archives for the extensions an app requested instead of
shipping one bundled extension set or rebuilding extension source in the app.
`bin/build-ios-extension-xcframeworks.sh` packages selected macOS arm64, iOS
simulator arm64, and iOS device arm64 archives into per-extension and
per-dependency XCFrameworks for Apple SDK and Xcode consumers without rebuilding
extension sources. Packaging rejects any such XCFramework that lacks one of
those three claimed slices.

## Root Ownership

Direct init and restore each take one non-blocking sibling lease for the target
root by default. The Rust SDK acquires the byte-identical sibling lease while
preparing direct, broker, and server roots, then passes
`OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK` for direct init so the C runtime does not
try to acquire the same lease twice. Other C ABI consumers leave the flag clear
and rely on the C runtime. The flag is only an ownership handoff; callers must
already hold the stable lease for the full native handle lifetime.
Detached reopens of a resident runtime must repeat the same root-lock ownership
mode; changing the flag is rejected rather than silently changing who protects
the live root.

`oliphaunt_init` only validates an existing managed root. It requires the exact
five-field `<root>/.oliphaunt.json`, a real `<root>/pgdata` directory,
PostgreSQL 18 `PG_VERSION`, nonempty `global/pg_control`, and a real `pg_wal`
directory. Exact native and WASIX descriptor tuples are accepted; unknown,
missing, duplicated, or mismatched fields and other PGDATA leaf names are
rejected without changing the root. SDK initialization creates PGDATA first and
publishes the descriptor last.

## Physical Archive Contract

`oliphaunt_backup` emits one PostgreSQL 18 physical archive format with no
format switch or generated-file hook. Every archive contains the exact
five-key `.oliphaunt/backup-manifest.properties`; restore requires and consumes
that manifest. The destination-owned `.oliphaunt.json` is not archive content,
and restore publishes only to a new or existing-empty destination. The C ABI
accepts only regular
files and directories under `pgdata`; symlinks, hardlinks, device nodes, FIFOs,
sockets, sparse/special tar records, external tablespaces, and linked WAL
directories are rejected. `oliphaunt_restore` enforces the same rule before
consuming archive metadata and publishing a restored root, so Swift, Kotlin,
React Native, and Rust SDK callers inherit one portable archive contract instead
of platform-specific tar behavior.

## Fast Native Iteration

Run the narrow product boundary instead of a workspace-wide track wrapper:

```sh
moon run liboliphaunt-native:host-smoke
moon run oliphaunt-rust:test-integration
moon run extension-artifacts-native:build-target oliphaunt-rust:test-extensions
```

`liboliphaunt-native:host-smoke` is the no-build host C ABI smoke for the current platform.
It reuses the release-runtime artifact produced for macOS, Linux, or Windows
and fails if that artifact is missing or stale. The Rust regression checks direct,
broker, and server behavior; the separate extension pair checks packaged extension behavior.
See [`docs/maintainers/sdk-parity-policy.md`](../../docs/maintainers/sdk-parity-policy.md)
for the SDK ownership contract.
