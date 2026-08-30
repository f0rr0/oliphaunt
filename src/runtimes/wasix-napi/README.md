# Oliphaunt WASIX Node-API Runtime

This private product builds the Node-API boundary used by `@oliphaunt/wasix-ts`
on Node.js, Bun, Deno, and Electron. Browser export conditions do not load this product;
they continue to use the patched Wasmer JavaScript host.

The addon supports four purpose-specific TypeScript placement paths:

- the direct TypeScript entry point opens and runs the database on its caller's
  JavaScript thread;
- the default native-host entry point uses one Rust database-owner actor so
  synchronous guest work does not block the importing event loop;
- the `/worker` entry point loads the direct class inside a real package-owned
  JavaScript Worker; and
- `/server` wraps the Rust listener owner directly.

Direct handles reject use from a thread other than their creator. The actor and
server surfaces instead expose Promise-facing Rust owners and do not publish a
movable native handle to JavaScript.

This makes the lowest-hop path explicit without making it the event-loop-blocking
default. Calls on `/direct` are synchronous at the native boundary; the root
settles promises from the Rust actor, and `/worker` adds only its requested
JavaScript Worker hop. The TypeScript facade retains one promise-shaped public
API and serialization contract.

## Binary boundary

`execProtocolRaw`, `backup`, and tool output return ordinary V8-owned
`Uint8Array` values. This keeps their lifetime and detach behavior predictable
across Node-API implementations. Direct requests borrow JavaScript input only
for the synchronous call; actor requests copy into Rust-owned admission data
before the caller returns. The `/worker` transport transfers eligible V8-owned
`ArrayBuffer` values instead of cloning them again.

`execProtocolRawStream` uses the Rust runtime's synchronous protocol callback.
It verifies that every callback remains on the creator thread before entering
Node-API, copies each chunk into V8-owned memory, and returns
`callbackAborted` only after PostgreSQL recovers to `ReadyForQuery`. An
unexpected off-thread callback is stopped without touching the JavaScript
environment.

`pgDump` and `psql` return structured `{ status, stdout, stderr }` results
whose output fields retain their exact bytes, including invalid UTF-8.
Ordinary frontend nonzero exits therefore retain stdout and stderr. A
`PostgresToolError` is still thrown with its structured diagnostics even if it
reports exit code zero; unrelated runtime failures remain thrown errors.

`extensionIdentity(sqlName)` and `toolIdentity(name)` expose each embedded
archive/module as canonical `sha256:size`. The TypeScript adapter compares
these identities with its validated public descriptors, so a same-name but
different payload fails before database startup or tool execution.

`payloadIdentity(component)` exposes the same identity form for the runtime,
standard seed, ICU data, and ICU seed payloads embedded in the single addon.

## Standard and ICU profiles

Each platform carrier contains one stable addon subpath,
`oliphaunt_wasix_napi.node`. The release feature embeds both the standard and
ICU payloads in that binary, and database open options select the requested
profile. `supportedProfiles()` reports the exact `['standard', 'icu']` contract.

The existing TypeScript `icu` option therefore changes the selected database
profile, not the package or binary that gets loaded. The default remains the
standard profile.

Release builds enable the `release` Cargo feature, which includes packaged
PostgreSQL tools and all extension features supported by the WASIX catalog.
The TypeScript API continues to accept extension descriptors, but the addon
receives the validated SQL names and resolves them against this compile-time
catalog. It never loads arbitrary extension bytes from JavaScript. A new or
updated server extension, or a changed frontend tool, therefore needs a new
N-API carrier release. This makes each carrier larger, but removes portable
archive expansion, WebAssembly compilation, and dynamic side-module linking
from server startup.

Source-only `cargo check` intentionally leaves those payload features disabled.
The artifact build validates every staged runtime, tool, extension, cluster
seed, and AOT payload before embedding it.

`tools/build-native.sh` fails closed unless the same-run producer outputs are
available through the dependency build-script contract:

- `OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR` points at the portable runtime and
  split `pg_dump`/`psql` payload root;
- `OLIPHAUNT_WASM_GENERATED_AOT_DIR` points at the root containing the current
  Rust target triple's core and tool AOT manifest;
- `OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT` points at the exact portable and
  per-target AOT extension inventory;
- `OLIPHAUNT_ICU_DATA_DIR` points at the portable ICU data tree; and
- `OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD=1` prevents every dependency crate
  from selecting its source-only fallback.

The build records and rechecks a deterministic inventory before packaging.
Its portable manifest, split tools, host AOT manifest, every selected extension
manifest/archive/AOT manifest, and ICU tree digest are embedded under
`artifact-provenance.json.buildInputs` in both distribution forms. Its `build`
object also records the release Cargo profile, disabled incremental compilation,
single codegen unit, thin LTO, symbol stripping, exact `release` feature, and
Rust target triple.
The addon's `runtimeVersion()` identity comes from the exact
`liboliphaunt-wasix-portable` dependency. Product metadata tracks that runtime
and the `oliphaunt-wasix` Rust binding as separate compatibility versions; they
are not assumed to advance together.

## Distribution

The canonical build package is private. `@oliphaunt/wasix-ts` declares public
platform carriers as optional dependencies, allowing npm-compatible package
managers to install only the matching target:

- `@oliphaunt/wasix-napi-darwin-arm64`
- `@oliphaunt/wasix-napi-linux-arm64-gnu`
- `@oliphaunt/wasix-napi-linux-x64-gnu`
- `@oliphaunt/wasix-napi-win32-x64-msvc`

Carrier packages have no install scripts and never download executable code.
`tools/build-native.sh` creates the single profile-complete addon and
`tools/package-platform.mjs` stages the matching carrier and portable release
archive with source/artifact provenance before `pnpm pack`. Per-target jobs do
not write the shared checksum filename; the aggregate release-assets task
writes one canonical checksum manifest after all four target outputs merge.

The supported target set is intentionally closed: macOS arm64, Linux arm64 or
x64 with glibc, and Windows x64 with MSVC. macOS x64, Linux musl, and Windows
arm64 do not have carriers. The native builder detects its Linux libc and
rejects musl or an unidentifiable libc before compiling a GNU carrier. The
Linux release addons are then compiled inside the pinned Rust 1.93.1 Debian
Bookworm image (glibc 2.36), with exact payload paths mounted read-only and the
actual build run without network access. This keeps them below the published
glibc 2.38 ceiling; release staging also validates their ELF shape and resolves
their dynamic dependencies in the pinned Fedora 39 glibc 2.38 consumer
fixture. The runtime loader performs the same libc check before resolving even
an explicit addon override. An unsupported target or
missing optional package fails explicitly; the server export never falls back
to the browser Wasmer implementation.

Release staging pins every carrier to the exact N-API product version. Before
loading native code, the TypeScript adapter checks the package identity,
version, target, WASIX runtime version, addon ABI, Node-API level, and presence
of both profiles. It then checks the addon's self-reported runtime and supported
profiles. Artifact provenance records the exact source and embedded input
identities used for the binary.

Deno requires a local `node_modules` directory plus `--allow-ffi`,
`--allow-read`, and `--allow-env`; directory databases need the corresponding
filesystem permissions. Its `/worker` path uses the Node-compatible Worker
implementation and does not require process-spawn permission. Managed Deno
Deploy is not a qualified distribution target. Node.js, Bun, Deno, and Electron
load the same Node-API 8 binary for their platform.

Electron applications should configure their packager to leave
`**/prebuilds/**` unpacked and ship `app.asar.unpacked` beside `app.asar`. This
keeps the addon and any platform loader companions, including the Windows
app-local VC runtime, in one loadable directory. Electron can otherwise extract
native modules to a temporary file, which adds startup work and can interact
poorly with antivirus scanners. Each carrier job exercises the ASAR-unpacked
layout and its missing-companion failure mode.
