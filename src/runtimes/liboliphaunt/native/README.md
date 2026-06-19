# liboliphaunt

`liboliphaunt` is the native C boundary for embedded PostgreSQL. It owns the
PostgreSQL 18 source pin, upstreamable patch stack, C ABI header, native shim,
and local smoke/build scripts.

This directory is intentionally not the Rust SDK. Rust lives in
`src/sdks/rust`; future Swift, Kotlin, React Native, and other targets
should bind to the same C ABI instead of reaching into PostgreSQL internals.

## Layout

- `include/oliphaunt.h`: public C ABI.
- `src/runtimes/liboliphaunt/native_native.c`: direct-mode lifecycle, backend thread ownership,
  and non-query public ABI entrypoints.
- `src/runtimes/liboliphaunt/native_runtime.c`: embedded backend argv/default-GUC construction
  and backend thread stack sizing policy.
- `src/runtimes/liboliphaunt/native_protocol.c`: raw protocol execution, streaming backpressure,
  readiness scanning, and embedded backend read/write callbacks.
- `src/runtimes/liboliphaunt/native_bootstrap.c`: PGDATA bootstrap, desktop/tooling `initdb`
  process execution, runtime-tool discovery, and startup argument copying.
  Apple mobile targets compile this path as template-only because apps cannot
  rely on spawning `initdb` from app storage.
- `src/runtimes/liboliphaunt/native_process.c`: process-wide direct-mode instance guard.
- `src/runtimes/liboliphaunt/native_static_extensions.c`: process-wide static extension registry
  used by mobile-style builds that link extension modules into the app binary.
- `src/runtimes/liboliphaunt/native_trace.c`: low-overhead protocol timing counters.
- `src/runtimes/liboliphaunt/native_archive.c`: backup/restore lifecycle over the C ABI.
- `src/runtimes/liboliphaunt/native_archive_tar.c`: private ustar read/write implementation for
  same-version physical archives.
- `src/runtimes/liboliphaunt/native_fs.c`: private filesystem/path helpers shared by archive and
  restore code.
- `src/runtimes/liboliphaunt/native_internal.h`: private helpers shared between C translation
  units; not part of the public ABI.
- `patches/postgresql-18.4/`: minimal PostgreSQL patch stack.
- `postgres18/source.toml`: pinned PostgreSQL source manifest.
- `postgres18/external-extensions.toml`: pinned external PG18 extension
  candidate manifest for pgrx-backed extensions such as pgGraph and ParadeDB
  `pg_search`.
- `bin/build-postgres18-macos.sh`: macOS build harness.
- `bin/check-external-extension-pins.sh`: no-network source-pin checker for
  external extension candidates.
- `bin/build-external-pgrx-extensions-macos.sh`: opt-in pgrx artifact harness
  for SDK-known external extension candidates, producing both normal server modules and
  liboliphaunt-linked embedded modules.
- `bin/check-c-abi-conformance.sh`: consumer-style C ABI check that includes
  only `oliphaunt.h`, links the public dylib, and verifies stable constants,
  structs, exported symbols, and safe global calls.
- `bin/smoke-host-happy-path.sh`: host C ABI smoke harness for macOS, Linux,
  and Windows. `bin/smoke-macos-happy-path.sh` remains as a compatibility
  wrapper.

## Build

```sh
src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
```

The default output root is `target/liboliphaunt-pg18`. Use `OLIPHAUNT_*` for runtime and build controls. `LIBOLIPHAUNT_PATH` is reserved
for the literal C library artifact path.

The direct build produces PostgreSQL runtime artifacts without optional
extension artifacts by default. Set `OLIPHAUNT_BUILD_EXTENSIONS=1` only when
refreshing or validating exact extension artifacts; the
`src/runtimes/liboliphaunt/native/tools/check-track.sh extensions` and `full` lanes set that
flag for you.

External pgrx extensions are not folded into the first-party extension build by
default. Their source pins live in
`src/runtimes/liboliphaunt/native/postgres18/external-extensions.toml`; the native validation wrapper
runs `src/runtimes/liboliphaunt/native/bin/check-external-extension-pins.sh` without network access and
verifies any local checkout that exists under `target/oliphaunt-sources/checkouts`. Use
`src/runtimes/liboliphaunt/native/bin/check-external-extension-pins.sh --online` when intentionally
refreshing the pins against upstream refs.

Build the opt-in pgrx artifacts with:

```sh
src/runtimes/liboliphaunt/native/bin/build-external-pgrx-extensions-macos.sh --fetch
src/runtimes/liboliphaunt/native/bin/build-external-pgrx-extensions-macos.sh
```

The harness requires the manifest-pinned `cargo-pgrx` version and automatically
uses `target/liboliphaunt-tools/bin/cargo-pgrx` when it exists. It packages each
selected extension once for the normal PostgreSQL server module path and once
with linker flags that bind PostgreSQL symbols to `@rpath/liboliphaunt.dylib` for
direct/broker embedded loading. Use
`OLIPHAUNT_EXTERNAL_PGRX_EXTENSIONS=pggraph` or
`OLIPHAUNT_EXTERNAL_PGRX_EXTENSIONS=paradedb-pg-search` to restrict the build.
The ParadeDB lane is intentionally disk-guarded because `pg_search` pulls a
large DataFusion/Tantivy release build; free target space first, or set
`OLIPHAUNT_EXTERNAL_PGRX_SKIP_DISK_PREFLIGHT=1` only for local experiments.
`src/runtimes/liboliphaunt/native/tools/check-track.sh external-pgrx` runs the no-build
`--check-current` gate for those artifacts.
The currentness fingerprint excludes harness prose and other non-build text.
When only the fingerprint schema changes, use `--refresh-current-stamps` to
validate the existing normal/embedded payloads and restamp them without running
the expensive pgrx packaging step.

`OLIPHAUNT_STARTUP_TIMEOUT_MS` bounds only initial backend startup readiness.
Normal `oliphaunt_exec_protocol`, `oliphaunt_exec_simple_query`, and streaming
execution do not impose a synthetic query timeout; callers should use
`oliphaunt_cancel` to interrupt long-running SQL. Ordinary SDK close is a
lifecycle detach/wait boundary, not an implicit query cancellation primitive.
The legacy `OLIPHAUNT_TIMEOUT_MS` name remains a startup-time fallback during
the migration.

The C runtime keeps throughput-oriented PostgreSQL defaults for direct callers:
`shared_buffers=128MB`, `wal_buffers=4MB`, and `min_wal_size=80MB`. SDKs that
need mobile-sized resident footprints do not need a new C ABI; they pass
validated PostgreSQL `-c name=value` startup arguments through
`OliphauntConfig.startup_args`. Later arguments win, so Rust/Swift/Kotlin/RN
can apply balanced/small mobile profiles and benchmark-specific overrides above
the stable C boundary.

Mobile builds must hydrate PGDATA from a packaged template before calling
`oliphaunt_init`. On Apple mobile platforms the C layer compiles out the
`fork`/`exec` `initdb` fallback and returns a direct error if `PG_VERSION` is
missing. `tools/run-host-c-smoke.mjs` includes a fast iOS simulator syntax
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
links target-specific static ICU libraries for PostgreSQL collation support,
validates the exported C ABI symbols, and reuses the result through stamped
ccache-friendly paths.

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

The iOS simulator, iOS device, and Android arm64 build lanes also emit
per-extension static archives beside the generated object lists:
`out/extensions/<stem>/liboliphaunt_extension_<stem>.a`. Those archives are the
release artifact boundary for exact mobile extension selection; SDK packaging
can link only the archives for the extensions an app requested instead of
shipping one bundled extension set or rebuilding extension source in the app.
`bin/build-ios-extension-xcframeworks.sh` packages selected simulator/device
archives into per-extension XCFrameworks for Apple SDK and Xcode consumers
without rebuilding extension sources.

## Root Ownership

`oliphaunt_init` takes a non-blocking stable sibling filesystem lease for
`<parent-of-pgdata>` by default and creates
`<parent-of-pgdata>/.oliphaunt.lock` as the visible root marker. `oliphaunt_restore`
takes the same stable lease before staging or publishing a restored root. This
keeps plain C, Swift, Kotlin, React Native platform adapters, and any future
direct C ABI caller from accidentally opening, replacing, or restoring the same
embedded root concurrently.
Stable lease filenames live beside the root directory and use the same
`.oliphaunt-root-<sha256-prefix>.lock` algorithm as the Rust SDK, so direct C,
Rust, Swift, Kotlin, and React Native platform adapters contend on the same root
identity instead of merely enforcing per-SDK locks.

Callers that already own an equivalent root coordinator may set
`OLIPHAUNT_CONFIG_EXTERNAL_ROOT_LOCK` in `OliphauntConfig.reserved_flags`. Today the
Rust SDK uses that flag because `oliphaunt` coordinates direct, broker,
server, backup, and restore through its own process registry plus stable
filesystem root leases. SDKs must not set the flag unless they can prove the
same root cannot be opened or replaced concurrently.

## Physical Archive Contract

`oliphaunt_backup(..., OLIPHAUNT_BACKUP_FORMAT_PHYSICAL_ARCHIVE, ...)` emits a
same-version concrete root archive. `oliphaunt_backup_ex` uses the same archive
writer and can append generated metadata entries such as `manifest.properties`
or `.oliphaunt/backup-manifest.properties` while the archive is being produced,
which avoids a second full archive copy in SDKs. The C ABI accepts only regular
files and directories under `pgdata`; symlinks, hardlinks, device nodes, FIFOs,
sockets, sparse/special tar records, external tablespaces, and linked WAL
directories are rejected. `oliphaunt_restore` enforces the same rule before
publishing a restored root, so Swift, Kotlin, React Native, and Rust SDK callers
inherit one portable archive contract instead of platform-specific tar behavior.

## Fast Native Iteration

For product-track work, prefer the native-only validation wrapper instead of the
workspace-wide WASIX lanes:

```sh
moon run liboliphaunt-native:host-smoke
src/runtimes/liboliphaunt/native/tools/check-track.sh quick
src/runtimes/liboliphaunt/native/tools/check-track.sh sdks
src/runtimes/liboliphaunt/native/tools/check-track.sh full
```

`liboliphaunt-native:host-smoke` is the no-build host C ABI smoke for the current platform.
It reuses the release-runtime artifact produced for macOS, Linux, or Windows
and fails if that artifact is missing or stale. `quick` reuses the existing
native runtime when it is present, then runs the C ABI smoke and Rust native SDK
tests. `sdks`
validates Swift, Kotlin, and React Native package checks against the same
runtime. `full` enables native extension artifacts and the extension matrix; in
the default `missing` policy it first runs the build script's no-build
`--check-extension-artifacts-current` probe and only rebuilds when the extension
fingerprint or required artifacts are stale or absent. Set
`OLIPHAUNT_TRACK_BUILD=never` to prove the command will not rebuild native
PostgreSQL; the native track also runs the no-build
`--check-oliphaunt-current` probe so stale C ABI sources fail before tests trust
an old dylib. Use `OLIPHAUNT_TRACK_BUILD=always` for an intentional rebuild.
