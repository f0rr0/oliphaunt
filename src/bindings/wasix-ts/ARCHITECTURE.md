# WASIX TypeScript binding architecture

## Boundary

`src/bindings/wasix-ts` and `src/bindings/wasix-rust` are peer bindings over
`src/runtimes/liboliphaunt/wasix`. Neither binding is an implementation detail
of the native TypeScript SDK. There is intentionally no source or package edge
from this binding to `src/sdks/js`, `liboliphaunt-native`, `node-direct`, or the
broker.

The dependency direction is:

```text
liboliphaunt-wasix portable assets
                 |
                 v
      wasix-ts direct or host worker
                 |
                 v
       PostgreSQL pgwire helpers
```

Portable extension descriptors are a second input edge. Their package identity
is runtime-specific but host-neutral, so browser, Node, Bun, and Deno WASIX adapters
consume the same extension package:

```text
@oliphaunt/extension-<name>-wasix
        descriptor + portable carrier closure
                         |
                         v
          carrier install/compatibility check
                         +
              stripped core manifest check
                         |
                         v
                 WASIX host adapter
```

Protocol and typed-query helpers are exact mirrors of `src/shared/js-core`.
That is a shared semantic source, not a dependency on the native TypeScript
product.

The patched Wasmer host under `host/` is an implementation dependency
of this binding, not another Oliphaunt runtime product. PostgreSQL binaries,
PGDATA, and the canonical runtime manifest remain owned by
`liboliphaunt-wasix`; each extension product owns its separately versioned
carrier envelope and portable extension bytes.

The canonical guest also owns the backend-only single-backend spinlock and
scalar-atomic specializations carried by PostgreSQL patches 0040 and 0041.
They follow the guest into the Rust binding's AOT artifacts and the portable
module used by browser direct, browser worker, and Node/Bun/Deno worker execution; they
are not a TypeScript or server-runtime host optimization. Frontends, PGXS side modules,
and concurrent PostgreSQL builds retain the normal atomic implementation. Host
lifecycle stays separate. All TypeScript placements assert the shared
`OLIPHAUNT_WASIX_SINGLE_BACKEND=1` concurrency invariant and the pinned host
denies guest process and thread creation under it. Only browser worker placement
also uses `OLIPHAUNT_WASIX_STDIO_PGWIRE=1` for the patched stdio-pgwire pump;
browser direct and server-runtime worker placement remove that transport marker and use
the Oliphaunt export driver that mirrors the Rust host.

## Browser lifecycle

`Oliphaunt.open()` returns one database contract for both placements. The
default `execution: 'worker'` path uses the lifecycle below in a package-owned
module worker. `execution: 'direct'` uses a caller-realm host driver that
instantiates PostgreSQL asynchronously, then invokes its lifecycle and protocol
exports on the calling stack. It creates no Web Worker; a direct database call blocks that
JavaScript agent until PostgreSQL returns. Both paths share one database state
machine, mount construction, PostgreSQL configuration, extension/role setup,
and storage contract. Direct preparation and compiled modules are cached by
verified runtime identity, but writable `Directory` mounts and storage leases
are recreated for every open. Separate in-memory databases or persistent store
names can remain open in either placement. Each remains one serialized
PostgreSQL session; direct calls also contend for the caller realm's event loop.

The pinned host currently instantiates dynamically loaded native side modules
synchronously. Chromium refuses main-realm modules above 8 MiB, so direct open
fails early for a selected carrier above that threshold. The current PostGIS
carrier also requires native load-order handling that neither browser
placement implements, so the error does not advertise worker placement as a
working fallback. The core guest uses the asynchronous path; smaller qualified
side modules remain supported.

1. Worker execution creates one module Web Worker; direct execution imports the
   package-relative host lazily in the caller realm.
2. The binding resolves the default `@oliphaunt/liboliphaunt-wasix` descriptor
   internally. The worker fetches or receives its canonical manifest, runtime,
   and PGDATA `.tar.zst` artifacts as one product/version identity. Each
   uncached identity verifies descriptor sizes and hashes plus the manifest's
   core/module and PostgreSQL/source identity; every open uses that exact
   verified identity. Imported extension descriptors add their exact carrier
   closure.
3. The selected realm safely expands the core artifacts and overlays only each
   extension carrier's install-contract files into separate `/bin`, `/lib`, `/share`,
   writable `/base`, `/home`, and `/tmp` Wasmer memory mounts. Before `/base` is
   materialized, a storage provider lease supplies either the packaged PGDATA
   template or an exact-compatible IndexedDB checkpoint. The source-pinned
   host adds ephemeral `/dev/shm` and a real Wasmer `RandomFile` at
   `/dev/urandom`. Worker execution passes the verified precompiled main module
   and its original bytes to `runWasix`; direct execution gives the same pair to
   `instantiateOliphauntDirect` and keeps the resulting Store in the caller
   realm.
4. Worker execution enables the explicit `OLIPHAUNT_WASIX_STDIO_PGWIRE=1`
   contract, attaches the existing Oliphaunt Port to stdio, and frames backend
   output through `ReadyForQuery`. Direct execution filters that transport flag
   and instead pushes protocol bytes through the runtime's exported input and
   output buffers, mirroring the WASIX Rust host. Both preserve a startup
   `ErrorResponse` and its SQLSTATE even when startup terminates the guest.
5. The worker's standalone loop emits a maintained second startup transition,
   which `WasixProcess` drains before exposing the session. The direct export
   driver completes startup without that stdio-only transition. Carrier-owned
   extension lifecycle SQL then runs while the fixed bootstrap superuser is
   active. As in the Rust binding, a requested non-default user is selected
   from existing roles with `SET ROLE`; standalone bootstrap itself remains the
   fixed `postgres` identity.
6. The binding frames later responses through `ReadyForQuery` and exposes
   serialized `query`, `execute`, `execProtocolRaw`, `checkpoint`, and
   callback-scoped `transaction` calls through one database contract. The same
   contract supports explicit `close()` and `await using` disposal.
   `checkpoint` first sends PostgreSQL `CHECKPOINT`, validates the normal pgwire
   result after `ReadyForQuery`, then asks the provider to publish a complete
   `/base` snapshot. If a
   PostgreSQL `ERROR` crosses either host boundary, the transport-scoped host
   invokes `PostgresMainLongJmp`, sends and flushes readiness, and continues
   through `PostgresMainLoopOnce`. Normal ErrorResponse returns receive the same
   top-level cleanup as trapping errors.
7. Worker `close` writes PostgreSQL Terminate, closes stdin, and waits for a
   successful zero process exit. Direct `close` deactivates the embedded
   lifecycle and runs its atexit exports synchronously. Only a successful close
   publishes a final persistent snapshot. Every outcome closes the provider,
   releases its exclusive database lease, and frees its placement-owned host
   resources.

The stdio guest entry mode exists because stock Wasmer's public browser API
exposes streams and process completion, but not arbitrary guest exports. The
source-pinned direct host deliberately adds only the narrow Oliphaunt export
driver needed to match the WASIX Rust lifecycle; it is not a general
synchronous WASIX process API.

## Node, Bun, and Deno lifecycle

Node, Bun, and Deno select `lib/index.node.js`, `lib/index.bun.js`, or
`lib/index.deno.js` through explicit package export conditions. Each facade
uses the runtime's `node:worker_threads` compatibility surface. Worker placement
creates one `worker_threads.Worker`; direct placement loads
the same synchronous guest driver lazily in the caller realm. The worker reads
package-relative runtime and extension `file:` URLs and calls the shared
dispatcher around that driver, preserving caller isolation without a second
worker hop or stream pump. Direct placement removes the remaining RPC boundary
and explicitly accepts blocking the calling JavaScript thread. Descriptor validation,
archive verification, extension installation, query serialization, close
semantics, and the memory default are not forked by placement.

IndexedDB remains browser-only and is rejected before a server-runtime worker
starts. Directory persistence is exposed through matching `storage/node`,
`storage/bun`, and `storage/deno` entrypoints backed by one portable,
snapshot-backed provider
with exclusive path ownership. Direct host filesystem mounts, server mode,
OPFS, and any fallback to native `@oliphaunt/ts` are intentionally absent.

## Browser storage boundary

Storage is a binding-owned provider/lease contract rather than runtime asset
configuration:

```text
opaque storage descriptor
          |
          v
 acquire provider lease ---- exact compatibility metadata
          |
          v
 hydrate worker-owned /base Directory
          |
          v
 PostgreSQL ReadyForQuery / clean exit
          |
          v
 atomic checkpoint + release
```

The main package owns the fresh-memory descriptor and default. IndexedDB is a
selective `./storage/indexed-db` entrypoint whose implementation is loaded only
when its opaque descriptor reaches the worker. Raw serialized descriptors are
not accepted from consumers. The internal lease exposes `state`, one initial
PGDATA mount, `checkpoint(directory)`, and `close(directory, outcome)`; it does
not own runtime or extension assets.

An IndexedDB checkpoint recursively reads the current Wasmer `Directory`, omits
process-lifetime `postmaster.pid` and `postmaster.opts`, and stores the complete
file/directory set with its exact compatibility envelope in a single object
store transaction. Replacing one database record is the atomic publication
point: an interrupted or rejected write leaves its preceding generation intact.
This is deliberately a full snapshot because the current public Wasmer
JavaScript API provides `readDir` and `readFile`, but no dirty-path list, host
filesystem mount, metadata-preserving snapshot, or flush hook.

Compatibility includes the exact runtime product/version, manifest, runtime
archive, PGDATA template, module, source fingerprint, PostgreSQL version, and
the sorted selected extension carrier/install identities. A reopen remounts
the extension files before PostgreSQL starts and skips first-open extension
lifecycle SQL. Any identity-set change fails before stored bytes reach Wasmer.
That fail-closed restriction is an explicit first implementation divergence;
safe extension add/upgrade/remove requires separately versioned migration
semantics.

Persistent databases use an origin-scoped exclusive Web Lock. This preserves
the single-owner invariant rather than suggesting that one single-user
PostgreSQL backend represents independent connections. There is no leader
proxy or multi-tab transaction ownership yet.

Provider acquisition and hydration happen before PostgreSQL starts. Snapshot
publication happens only after pgwire recovery returns `ReadyForQuery`, so
ordinary PostgreSQL errors retain their existing `PostgresError` identity. A
host snapshot failure is instead a typed storage error and poisons the live
handle: committed work may be present in its memory directory while the prior
IndexedDB generation remains current, so retrying the application operation is
not known to be safe.

## Selective extension descriptor contract

The consumer API accepts exact structural values rather than SQL strings:

```ts
type WasixExtensionDescriptor = {
  schema: 'oliphaunt-wasix-extension-v1';
  runtime: 'wasix';
  product: string;
  version: string;
  compatibility: {
    extensionRuntimeContract: 'oliphaunt-extension-runtime-contract-v1';
    postgresMajor: string;
    wasixRuntimeProduct: 'liboliphaunt-wasix';
    wasixRuntimeVersion: string;
  };
  sqlName: string;
  carriers: readonly {
    product: string;
    version: string;
    sqlName: string;
    archive: string;
    sha256: string;
    size: number;
    source: string | URL | ArrayBuffer | Uint8Array;
    install: {
      schema: 'oliphaunt-wasix-extension-install-v1';
      dependencies: readonly string[];
      coreExportsRequired: readonly string[];
      // exact native-module, lifecycle, and installed-file projections
    };
  }[];
};
```

This is structural rather than nominal so a generated extension package can be
dependency-free; it does not import the host binding merely to acquire a brand.
The literal `runtime: 'wasix'` still makes native descriptors statically
incompatible, and the main-thread client runtime-validates the complete shape.
The binding keeps an internal validation/freezing helper for fixtures. It is not
part of the consumer entrypoint and generated packages do not depend on it.

Generated leaf packages can point at their package-owned payload without any
host conditional:

```ts
const carrier = {
  source: new URL('./extensions/pgtap/extension.tar.zst', import.meta.url),
  // product, version, SQL identity, archive key, hash, and size
} as const;
```

The development Vite harness derives virtual package descriptors from the current
canonical target outputs and uses development route strings while serving those
exact artifacts directly.

Each descriptor selects only its root `sqlName`. Its carrier array is a
dependency-complete byte closure, not an alternate dependency declaration. The
client validates each root's exact dependency closure, unions closures in
deterministic SQL-name order, deduplicates shared rows only when their complete
identity/install/compatibility metadata agrees, and rejects repeated rows,
duplicate roots, or conflicts. The worker resolves dependencies solely from
the imported install contracts, treating only the stripped core manifest's
`runtime-support` entries as runtime-provided. Before reading extension bytes,
it gates every carrier on the selected WASIX runtime version, PostgreSQL major,
extension-runtime contract, and required names in `runtime.link.exports`. It
then verifies each archive's declared size/hash and overlays exactly its
carrier-owned installed-file inventory. The core manifest is required to have
`extensions: []` so it cannot quietly reclaim optional extension ownership.

## Host compatibility

The host is rebuilt from source rather than maintained as hand-edited generated
JavaScript/WASM. `host/source.toml` pins the Wasmer JS Git source and Cargo
crates; the adjacent patches are the reviewable compatibility delta. The build
lands first in `target/oliphaunt-wasix-ts/host`. Public package staging copies
the exact JS module, worker module, WebAssembly module, license, and provenance
into `lib/host`; direct browser execution imports the host in the caller realm,
while browser and Node/Bun/Deno direct/worker placements import the same
package-relative module.

This is not a general backport of WASIX 0.702 to Wasmer 0.601. The eleven patches:

1. compile the large module asynchronously, preserve raw module bytes across
   the blocking worker, and launch the configured `WasiEnvBuilder` rather than
   discarding args, environment, mounts, and stdio;
2. map `proc_exit2` to normal 0.601 process exit and return `ENOTSUP` from
   `proc_fork_env` and context create/switch/destroy for both memory widths;
3. add ephemeral `/dev/shm` and Wasmer's unbounded random device without
   replacing the SDK's stream-backed stdio;
4. recover PostgreSQL wasm-EH exceptions only for the explicit
   `OLIPHAUNT_WASIX_STDIO_PGWIRE=1` contract, then remain in the existing
   PostgreSQL export pump for the process lifetime;
5. call wasm-bindgen through the object-form initializer required by the pinned
   host toolchain;
6. accept a verified precompiled guest `WebAssembly.Module` together with its
   original bytes, so the blocking inner worker can reuse compilation without
   depending on unsupported Wasmer module serialization; and
7. add a narrow caller-realm Oliphaunt driver that owns one Store, invokes the
   existing PostgreSQL startup/protocol/cleanup exports synchronously, and
   rejects generic WASIX task, thread, fork, and network work that would require
   another execution context;
8. add Wasmer's Promise-backed JavaScript instance construction for modules
   that exceed Chromium's synchronous main-realm limit; and
9. carry that async boundary through the pinned WASIX builder and linker only
   while constructing the main module. The returned database driver remains
   synchronous, and oversized dynamic side modules are rejected before open;
   and
10. repair the pinned source commit's stale npm-lock root metadata, then install
    that integrity-pinned dependency graph without lockfile mutation; and
11. deny guest process replacement, process creation, and thread creation in
    every TypeScript placement while the explicit single-backend contract is
    active; the separate stdio-pgwire marker remains transport-only.

The exact pairing is qualified for the single-process stdio-pgwire and direct
Oliphaunt export paths, including repeated PostgreSQL `ERROR` recovery. The
direct driver treats every `PostgresMainLoopOnce` trap as the guest's exported
top-level recovery boundary and also cleans up non-trapping ErrorResponses.
This remains an integration contract with the pinned Oliphaunt runtime rather
than a generic Wasmer guarantee.
Missing WASIX context switching is a broader compatibility gap, but is not part
of this PostgreSQL recovery path. Ordinary package resolution never selects
stock `@wasmer/sdk`; the published binding owns the source-pinned host. A larger
current-Wasmer JS port is outside this host's compatibility contract.

The version skew is upstream-owned rather than a loose Oliphaunt dependency.
The commit referenced by the latest npm `@wasmer/sdk` 0.10.0 release identifies
its checked-in source as 0.8.0 and embeds Wasmer 6.1 with the 0.601 Wasmer
support family. `wasmer-wasix` 0.702.1 embeds Wasmer 7.2.1 and
matching 0.702.1 virtual filesystem/network, package, configuration, backend,
and types contracts. A coordinated compile probe exposed incompatible
`FileSystem` mounting, `TaskWasm`, wasm-bindgen conversion, registry calls,
module hashing, and binary-package construction before the Oliphaunt runner and
recovery changes could be reapplied. Consequently 0.702.1 adoption is a full
source-host port plus browser qualification, not an isolated crate bump.
`host/source.toml` records the intentionally coherent 0.601 source family until
that port exists.

## PGlite reference, not product inheritance

PGlite independently validates the recovery shape used here. Its Emscripten
guest turns the active PostgreSQL top-level `longjmp` into a known exit status;
the TypeScript host then calls `PostgresMainLongJmp`, sends readiness, flushes,
and resumes `PostgresMainLoopOnce`. Its public database error is separately
decoded from pgwire. See PGlite's
[runtime loop](https://github.com/electric-sql/pglite/blob/67872123b637ba132cceb8dbb3f739a09685ee87/packages/pglite/src/pglite.ts#L932-L965)
and [guest shim](https://github.com/electric-sql/postgres-pglite/blob/7b4ee5086055dc5e54ae1e13e487888249438e68/pglite/src/pglitec/pglitec.c#L52-L84).
Oliphaunt deliberately uses an environment-gated Wasmer exception discriminator
instead of Emscripten's numeric sentinel, but preserves the same separation
between control-flow recovery and the pgwire `PostgresError` seen by callers.
Lifecycle SQL for a selectively imported extension runs in the selected
execution realm. Worker errors are serialized by PostgreSQL field and rebuilt
on the main thread; direct errors retain the same `PostgresError` identity in
place. Neither path collapses SQLSTATE and diagnostics into a generic error.

PGlite is also a useful ordering reference: it stages extension archives and
precompiles Emscripten side modules before PostgreSQL starts. Those
`MAIN_MODULE`/`SIDE_MODULE` binaries are not WASIX carriers, however, and its
filesystem persistence is coupled to Emscripten FS.

The browser benchmark also exposed a preparation asymmetry: PGlite reused
precompiled modules while each WASIX open recompiled the verified guest bytes.
Direct execution now bounds and keys immutable preparation and compiled-module
caches by exact runtime/carrier/GUC identity. Mutable directories and storage
leases never enter those caches. The checked-in insert benchmark compares WAL
volume alongside timing; separate root-cause diagnostics compare buffer
activity and relation sizes. Both keep host/runtime overhead visible without
changing PostgreSQL work or durability settings.

This binding keeps the following deliberate divergences:

- extension lifecycle and install metadata comes from each selectively imported
  `-wasix` package; the stripped runtime manifest cannot override it;
- runtime/PGDATA/manifest hashes, carrier hashes, required core exports, exact
  installed-file inventories, dependencies, and collisions are checked before
  startup;
- selecting an extension also runs its canonical lifecycle while the bootstrap
  superuser is active, whereas PGlite normally stages it for an explicit
  `CREATE EXTENSION`; and
- IndexedDB uses a full checkpoint/clean-close snapshot rather than PGlite's
  Emscripten dirty-file synchronization. OPFS, per-query flush, and multi-tab
  leadership are unsupported without corresponding Wasmer/WASIX host contracts
  and are not inherited from PGlite's browser filesystem.

The manifest's native `load-order` metadata is retained but is not driven by
this host. Selection therefore rejects nonempty `load-order` and
`shared-memory-required` contracts. `pgtap` and the `pg_uuidv7` canary declare
neither; affected extensions remain outside the qualified TypeScript host slice.

## Asset ownership

The binding does not commit or package PostgreSQL binaries. Its ordinary open
path imports `@oliphaunt/liboliphaunt-wasix`, whose generated descriptor points
at package-owned runtime, PGDATA, and manifest assets. `advanced.runtime` is the
only raw-source escape hatch and still requires the complete integrity metadata
for all three assets. Development reads `target/oliphaunt-wasix/assets`, produced
by `liboliphaunt-wasix:runtime-portable`, through a checked-in Vite plugin that
models that generated carrier. Optional extensions remain exact, separately
imported `-wasix` carriers; they do not become an implicit browser SDK bundle.
Their package versions follow the owning extension product's existing release
and changelog stream, so WASIX is another carrier rather than an independently
versioned product.

The source workspace manifest deliberately does not resolve that generated
carrier from npm: the carrier exists only after same-candidate runtime assets
are frozen. SDK release staging injects the exact dependency recorded by
`oliphaunt.runtimeVersion`, validates it, and publishes only that staged
manifest. This keeps fresh frozen workspace installs independent of an
unpublished candidate while making the consumer tarball's runtime edge exact.
The Node, Bun, and Deno consumer smokes use the same staging function, not a test-only package
rewrite.

The release runtime carrier owns a stripped core manifest (`extensions: []`).
The development Vite plugin projects the same core-only bytes from the build
pipeline's qualification manifest and derives separate exact extension install
contracts from its extension rows. The worker rejects a nonempty core manifest,
so the runtime carrier cannot become the authority for independently versioned
extensions.

The first browser smoke selects the SQL-only `pgtap` carrier. That isolates
manifest verification, dependency ordering, archive overlay, and lifecycle SQL
from dynamic linking. The separate `smoke:browser:pg-uuidv7` profile selects the
native carrier, calls `uuid_generate_v7()` before and after the two error
recovery cases, verifies both results are UUIDv7 values, and checks clean
process exit. That proves one exact `.so` against the pinned package-owned host; it
does not add or widen a canonical extension target claim. Generic native-module
support remains gated on a safer loader boundary and broader qualification.

The example's virtual Vite modules model the intended
`@oliphaunt/extension-pgtap-wasix` and
`@oliphaunt/extension-pg-uuidv7-wasix` package roots from current target
outputs. Its asset middleware and COOP/COEP headers are development-only.
Production hosting, cache policy, and asset integrity are application/carrier
concerns; the binding does not silently copy target-owned assets into its npm
bundle.

## Public package and qualification

`@oliphaunt/wasix-ts` is a separately versioned public SDK product. It has its own
release metadata and changelog, declares an exact dependency on the published
`@oliphaunt/liboliphaunt-wasix` runtime carrier, and publishes the patched host
under `lib/host`. Conditional package exports choose browser, Node, Bun, or Deno
adapters; all support direct and Worker placement without changing the consumer import.

The browser smoke proves the exact runtime/host pairing can start PostgreSQL,
activate `pgtap`, retain SQLSTATE across repeated PostgreSQL error recovery,
continue with `42` on the same handle, checkpoint IndexedDB, and close with a
successful zero exit status. Each server-runtime smoke installs packed release
candidates into a fresh external project, verifies the runtime selects its conditional export,
starts the same portable runtime with package-relative assets, activates
`pgtap`, recovers from an error, and closes cleanly. The opt-in native browser
profile additionally loads and calls the canonical `pg_uuidv7.so`; it remains
a narrow canary rather than a generic dynamic-extension claim.

The intentional host, persistence, extension, and Wasmer compatibility limits
remain listed in [README.md](./README.md). They are explicit product boundaries,
not compatibility aliases or fallbacks to a native SDK.
