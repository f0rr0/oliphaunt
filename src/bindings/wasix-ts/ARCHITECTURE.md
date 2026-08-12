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
        wasix-ts host worker
                 |
                 v
       PostgreSQL pgwire helpers
```

Portable extension descriptors are a second input edge. Their package identity
is runtime-specific but host-neutral, so browser and Node WASIX adapters
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

## Browser lifecycle

1. The main thread creates one module Web Worker.
2. The binding resolves the default `@oliphaunt/liboliphaunt-wasix` descriptor
   internally. The worker fetches or receives its canonical manifest, runtime,
   and PGDATA `.tar.zst` artifacts as one product/version identity, then verifies
   descriptor sizes and hashes plus the manifest's core/module and
   PostgreSQL/source identity on every open. Imported extension descriptors add
   their exact carrier closure.
3. The worker safely expands the core artifacts and overlays only each
   extension carrier's install-contract files into separate `/bin`, `/lib`, `/share`,
   writable `/base`, `/home`, and `/tmp` Wasmer memory mounts. Before `/base` is
   materialized, a storage provider lease supplies either the packaged PGDATA
   template or an exact-compatible IndexedDB checkpoint. The source-pinned
   host adds ephemeral `/dev/shm` and a real Wasmer `RandomFile` at
   `/dev/urandom`. The worker passes the raw main module bytes to `runWasix`
   with `program: '/bin/oliphaunt'`.
4. The explicit `OLIPHAUNT_WASIX_STDIO_PGWIRE=1` guest contract attaches the
   existing Oliphaunt Port to stdio before standalone initialization can report
   a PostgreSQL startup failure. After successful initialization, it reads a
   standard startup packet and subsequent frontend messages from stdin and
   writes ordinary backend messages to stdout. A startup `ErrorResponse` may
   terminate the guest without `ReadyForQuery`; the worker stops at the complete
   error message so it can retain PostgreSQL's SQLSTATE and diagnostics.
5. Explicit connection data ends with one `ReadyForQuery`; the standalone main
   loop then emits `ParameterStatus*` plus a second `ReadyForQuery`. The worker
   drains and validates this maintained compatibility transition before it
   exposes the session. Carrier-owned extension lifecycle SQL runs while the fixed
   bootstrap superuser is still active. As in the Rust binding, a requested
   non-default user is then selected from existing roles with `SET ROLE`;
   standalone bootstrap itself remains the fixed `postgres` identity.
6. The worker frames later responses through `ReadyForQuery`; the main thread
   exposes serialized `query`, `execute`, `execProtocolRaw`, and `checkpoint`
   calls. `checkpoint` first sends PostgreSQL `CHECKPOINT`, validates the normal
   pgwire result after `ReadyForQuery`, then asks the provider to publish a
   complete `/base` snapshot. If a
   PostgreSQL `ERROR` escapes `_start` as a wasm exception, the transport-scoped
   host patch intercepts it before process cleanup, invokes
   `PostgresMainLongJmp`, sends and flushes readiness, and continues through
   `PostgresMainLoopOnce`. The same pump handles subsequent errors.
7. `close` writes a PostgreSQL Terminate message, closes stdin, and waits for
   the WASIX process to exit. Only a successful zero exit publishes a final
   persistent snapshot. Every outcome closes the provider and releases its
   exclusive database lease.

This guest entry mode exists because the public Wasmer browser SDK exposes
stdio and process completion, but not arbitrary guest exports. The existing
Rust binding continues to drive those exports and is unaffected unless the new
environment variable is explicitly set.

## Node lifecycle

Node selects `lib/index.node.js` through the package's `node` export condition.
It creates one `worker_threads.Worker`; that worker reads package-relative
runtime and extension `file:` URLs, then calls the same dispatcher and
`WasixProcess` used by the browser worker. Wasmer's own inner Web Worker edge is
adapted to worker threads by a narrow package-owned bridge. RPC framing,
descriptor validation, archive verification, extension installation, pgwire
recovery, query serialization, close semantics, and the memory default are not
forked by host.

IndexedDB remains browser-only and is rejected before a Node worker starts.
Node directory persistence, server mode, OPFS, and any fallback to native
`@oliphaunt/ts` are intentionally absent.

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
the exact JS module, inner worker, WebAssembly module, license, and provenance
into `lib/host`; the browser and Node workers import that package-relative host.

This is not a general backport of WASIX 0.702 to Wasmer 0.601. The five patches:

1. compile the large module asynchronously, preserve raw module bytes across
   the blocking worker, and launch the configured `WasiEnvBuilder` rather than
   discarding args, environment, mounts, and stdio;
2. map `proc_exit2` to normal 0.601 process exit and return `ENOTSUP` from
   `proc_fork_env` and context create/switch/destroy for both memory widths;
3. add ephemeral `/dev/shm` and Wasmer's unbounded random device without
   replacing the SDK's stream-backed stdio; and
4. recover PostgreSQL wasm-EH exceptions only for the explicit
   `OLIPHAUNT_WASIX_STDIO_PGWIRE=1` contract, then remain in the existing
   PostgreSQL export pump for the process lifetime.
5. call wasm-bindgen through the object-form initializer required by the pinned
   host toolchain.

The exact pairing is qualified only for the single-process stdio-pgwire path,
including repeated PostgreSQL `ERROR` recovery. The recovery discriminator is
the Wasmer 6.1 JS representation of a `WebAssembly.Exception`; its Rust error
surface no longer exposes the underlying wasm tag. The exact source pairing
therefore assumes PostgreSQL's top-level jump is the only such exception that
escapes while the explicit transport is active. This remains an integration
divergence rather than a generic Wasmer guarantee.
Missing WASIX context switching is still a broader compatibility gap, but is
not part of this PostgreSQL recovery path. Ordinary package resolution never
selects stock `@wasmer/sdk`; the published binding owns the source-pinned host.
Completing the larger current-Wasmer JS port remains future host work.

The version skew is upstream-owned rather than a loose Oliphaunt dependency.
The latest npm `@wasmer/sdk` 0.10.0 source commit embeds Wasmer 6.1 and the
0.601 Wasmer support family. `wasmer-wasix` 0.702.1 embeds Wasmer 7.2.1 and
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
Lifecycle SQL for a selectively imported extension runs inside the worker, so
that error family is explicitly serialized by PostgreSQL field and rebuilt on
the main thread; SQLSTATE and diagnostics are not collapsed into a generic
worker error.

PGlite is also a useful ordering reference: it stages extension archives and
precompiles Emscripten side modules before PostgreSQL starts. Those
`MAIN_MODULE`/`SIDE_MODULE` binaries are not WASIX carriers, however, and its
filesystem persistence is coupled to Emscripten FS. This binding therefore
keeps the following deliberate divergences:

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
  leadership still need Wasmer/WASIX host contracts and are not inherited from
  PGlite's browser filesystem.

The manifest's native `load-order` metadata is retained but not yet explicitly
driven by this host. Selection therefore rejects nonempty `load-order` and
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
The Node consumer smoke uses the same staging function, not a test-only package
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

`@oliphaunt/wasix` is a separately versioned public SDK product. It has its own
release metadata and changelog, declares an exact dependency on the published
`@oliphaunt/liboliphaunt-wasix` runtime carrier, and publishes the patched host
under `lib/host`. Conditional package exports choose a browser module Worker or
a Node worker-thread adapter without changing the consumer import.

The browser smoke proves the exact runtime/host pairing can start PostgreSQL,
activate `pgtap`, retain SQLSTATE across repeated PostgreSQL error recovery,
continue with `42` on the same handle, checkpoint IndexedDB, and close with a
successful zero exit status. The Node smoke installs packed release candidates
into a fresh external project, verifies Node selects the conditional export,
starts the same portable runtime with package-relative assets, activates
`pgtap`, recovers from an error, and closes cleanly. The opt-in native browser
profile additionally loads and calls the canonical `pg_uuidv7.so`; it remains
a narrow canary rather than a generic dynamic-extension claim.

The intentional host, persistence, extension, and Wasmer compatibility limits
remain listed in [README.md](./README.md). They are explicit product boundaries,
not compatibility aliases or fallbacks to a native SDK.
