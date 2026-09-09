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

`extensionIdentity(sqlName)` exposes an embedded contrib archive as canonical
`sha256:size`. `toolIdentity(name)` reports a tool from an explicitly registered
installed tools package. The TypeScript adapter compares these identities with
its validated public descriptors before use.

`payloadIdentity(component)` identifies the embedded runtime archive and
standard seed archive/manifest. ICU payloads come from the selected ICU package.

## Standard and ICU profiles

Each platform carrier contains one stable addon subpath,
`oliphaunt_wasix_napi.node`. It embeds the runtime, initdb, standard seed, and
contrib extensions. External extensions, ICU data with its matching seed, and
frontend tools are separate dependencies. Standard seeds remain bundled; making
those optional is a separate rollout.

`supportedProfiles()` reports `['standard', 'icu']`. Standard is the default.
Selecting ICU requires the installed ICU descriptor and its bytes; the same
addon supports both profiles without embedding the optional data.

Release builds enable the `release` feature, which enables extension and tool
APIs. It does not pull optional payload crates into the addon. TypeScript passes
contrib SQL names to Rust and resolves external descriptors to their installed
portable and host AOT package manifests. Rust validates owner, version, target,
runtime compatibility, containment, and payload hashes before loading them.
The tools package follows the same installed-package registration contract.
Compatible external package releases do not require rebuilding the addon.

Source-only `cargo check` leaves release features disabled. The artifact builder
validates its base payload closure through these inputs:

- `OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR`: portable runtime, initdb, and standard seed;
- `OLIPHAUNT_WASM_GENERATED_AOT_DIR`: the current target's core AOT manifest;
- `OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT`: contrib portable and target AOT inventory;
- `OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD=1`: reject source-only payload fallbacks.

The build records and rechecks the runtime and contrib inventories in
`artifact-provenance.json.buildInputs`. The `build` object records the release
Cargo profile, disabled incremental compilation, single codegen unit, thin LTO,
symbol stripping, exact `release` feature, and Rust target triple.
The addon's `runtimeVersion()` identity comes directly from the selected
`liboliphaunt-wasix-portable` crate. Workspace builds therefore report the
local runtime while released carriers retain exact product compatibility pins.
Product metadata tracks the runtime and `oliphaunt-wasix` Rust binding as
separate compatibility versions; they are not assumed to advance together.

## Distribution

The canonical build package is private. `@oliphaunt/wasix-ts` declares public
platform carriers as optional dependencies, allowing npm-compatible package
managers to install only the matching target:

- `@oliphaunt/wasix-napi-darwin-arm64`
- `@oliphaunt/wasix-napi-linux-arm64-gnu`
- `@oliphaunt/wasix-napi-linux-x64-gnu`
- `@oliphaunt/wasix-napi-win32-x64-msvc`

Carrier packages have no install scripts and never download executable code.
`tools/build-native.sh` creates the single base addon and
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
