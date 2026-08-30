# WASIX TypeScript binding architecture

## Boundary

`src/bindings/wasix-ts` is one public TypeScript API over two host adapters.
The package export conditions, not a runtime option, select the adapter:

```text
browser/default                  node/bun/deno/electron
      |                                      |
      v                                      v
patched Wasmer JavaScript host       napi-rs, Node-API 8 addon
      |                                      |
portable liboliphaunt-wasix       Rust actor, direct, Worker, server
      `---------------------+----------------'
                            v
                 shared TypeScript database API
```

The browser adapter owns the portable runtime/seed descriptors and dynamic
extension carrier installation. The server adapter owns no Wasmer JavaScript
fallback: it loads one exact, prebuilt platform carrier whose Rust dependency
embeds the runtime, AOT objects, cluster seed, tools, and supported extension
catalog. Both execute the canonical WASIX guest and preserve its physical
database and backup formats.

This boundary deliberately does not depend on `src/sdks/js`,
`liboliphaunt-native`, `node-direct`, or the broker. The N-API product wraps the
WASIX Rust binding; it is not a route into the native PostgreSQL SDK.

Protocol and typed-query helpers are exact mirrors of `src/shared/js-core`.
That is a shared semantic source, not a dependency on the native TypeScript
product.

The patched Wasmer host under `host/` is a browser-only implementation
dependency of this binding, not another Oliphaunt runtime product. Browser
PostgreSQL binaries, PGDATA, and the canonical runtime manifest remain owned by
`liboliphaunt-wasix`; each extension product owns its separately versioned
portable carrier envelope. The N-API release embeds the corresponding frozen
artifacts instead of resolving those bytes during application startup.

The canonical guest also owns the backend-only single-backend spinlock and
scalar-atomic specializations carried by PostgreSQL patches 0035 and 0036.
They follow the guest into the Rust binding's AOT artifacts and the portable
module used by the browser. They are not a TypeScript host optimization.
Frontends, PGXS side modules, and concurrent PostgreSQL builds retain the normal
atomic implementation. Each adapter asserts the shared
`OLIPHAUNT_WASIX_SINGLE_BACKEND=1` concurrency invariant and denies guest
process and thread creation under it. Browser root and `/worker` use the same
Oliphaunt export driver. Native-host root, `/direct`, `/worker`, and `/server` use the
same Rust WASIX semantics with different explicit owners. Placement changes
ownership and hop count, not the PostgreSQL protocol contract.

## Browser lifecycle

`Oliphaunt.open()` from the root package uses the host driver in the importing
realm: setup is asynchronous, but PostgreSQL lifecycle and protocol exports run
in that realm and may monopolize its event loop while active. `Oliphaunt.open()` from
`@oliphaunt/wasix-ts/worker` creates one package-owned module Worker around the
same driver. There is no public placement option and neither entrypoint falls
back to the other. Both share one database state machine, mount
construction, PostgreSQL configuration, extension/role setup, and storage
contract. Immutable preparation and compiled modules are cached by verified
runtime identity, while writable `Directory` mounts and storage leases are
recreated for every open. Each handle remains one serialized PostgreSQL
session. Only the root entrypoint contends for its caller's event loop.

The pinned host currently instantiates dynamically loaded native side modules
synchronously. Chromium refuses Window-realm modules above 8 MiB, so the root
entrypoint fails early there for a selected carrier above that threshold. The
explicit `/worker` entrypoint and the root imported from a Dedicated Worker are
outside that Window restriction and apply descriptor-declared native
load order; a real Chrome canary loads PostGIS there and verifies recovery
across its large dependency module. The core guest uses the asynchronous path;
smaller qualified side modules remain supported in a direct Window.

1. The root entrypoint imports the package-relative host lazily in the caller
   realm and creates no Worker. `/worker` creates one module Web Worker per open
   and a temporary Worker for restore.
2. The binding resolves the default `@oliphaunt/liboliphaunt-wasix` descriptor
   internally. The selected realm fetches or receives its canonical manifest, runtime,
   and cluster-seed `.tar.zst` artifacts as one product/version identity. Each
   uncached identity verifies descriptor sizes and hashes plus the manifest's
   core/module and PostgreSQL/source identity; every open uses that exact
   verified identity. Imported extension descriptors add their exact carrier
   closure.
3. The selected realm safely expands the core artifacts and overlays only each
   extension carrier's install-contract files into separate `/bin`, `/lib`, `/share`,
   writable `/base`, `/home`, and `/tmp` Wasmer memory mounts. Before `/base` is
   materialized, a storage provider lease supplies either the packaged cluster
   seed or an exact-compatible persistent PGDATA. The source-pinned
   host adds ephemeral `/dev/shm` and a real Wasmer `RandomFile` at
   `/dev/urandom`. Its narrow `Directory` mutation journal records successful
   writes and truncates through already-open descriptors as well as file,
   directory, remove, and rename paths for either execution surface and every provider.
   Both execution surfaces pass the verified precompiled main module and its original
   bytes to `instantiateOliphauntDirect`. The root keeps the resulting Store in
   the caller realm; `/worker` keeps it in its package Worker.
4. Both execution surfaces push protocol bytes through guest-owned reusable input
   and output buffers. The host writes requests directly into canonical guest
   memory and returns one owned JavaScript response copy, so PostgreSQL can
   safely reuse or grow its memory after the call. Startup preserves an
   `ErrorResponse` and its SQLSTATE even when startup terminates the guest.
5. The direct export driver completes the exported startup transition before
   exposing the session. Selected carriers contribute verified artifacts and
   required startup/preload configuration only; database-local extension SQL is
   application/ORM-owned. A requested non-default user is selected from existing
   roles with `SET ROLE`; standalone bootstrap remains the fixed `postgres`
   identity.
6. The binding frames later responses through `ReadyForQuery` and exposes
   serialized `query`, `execute`, buffered `execProtocolRaw`, callback
   `execProtocolRawStream`, and callback-scoped `transaction` calls
   through one database contract. The same contract supports explicit
   `close()` and `await using` disposal.
   Every successfully completed protocol operation reaches `ReadyForQuery`, then
   asks a persistent provider to publish only journaled `/base` paths before the
   Promise resolves. A callback transaction defers publication for `BEGIN`, its
   body, and `COMMIT`/`ROLLBACK`, then publishes exactly once after the confirmed
   final boundary. A new persistent synchronous-OPFS root uses a separate internal
   full-publication boundary after initialization; it is not a public database
   operation. PostgreSQL `CHECKPOINT` remains available through ordinary
   `execute`. If a
   PostgreSQL `ERROR` crosses the host boundary, the direct host
   invokes `PostgresMainLongJmp`, sends and flushes readiness, and continues
   through `PostgresMainLoopOnce`. Normal ErrorResponse returns receive the same
   top-level cleanup as trapping errors.
7. `close` establishes a terminal admission cutoff and lets already accepted
   database work drain. The direct owner
   sends PostgreSQL Terminate through the same direct bridge, deactivates the
   embedded lifecycle, and runs its atexit exports synchronously in the owning
   realm. A successful close completes the
   provider's final persistence boundary. Every outcome attempts provider close,
   exclusive-lease release, and entrypoint-owned host-resource release. The
   browser `/worker` waits for that close reply and then terminates its already
   quiescent Worker; a Node-compatible `/worker` closes its native handle, posts
   the reply, and exits itself. The public
   handle memoizes that single outcome and becomes closed after teardown settles;
   a rejected close never advertises the destroyed owner or guest as reusable.
   If the isolated owner terminates independently, shared session state makes the
   public handle closed immediately and prevents later work from crossing the
   dead transport. An explicit close still memoizes and reports that terminal
   failure while completing package-owned resource cleanup.
8. Each public database handle registers an opaque generation token for
   best-effort forgotten-handle recovery. The finalizer holds no reference to
   the public owner and only schedules work after returning. It atomically
   claims the exact still-active generation, then schedules the same best-effort
   close for that root, direct, or `/worker` generation. Explicit close
   unregisters the generation before teardown, so queued stale finalizers are
   harmless and cannot affect a later database.

Stock Wasmer's public browser API exposes streams and process completion, but
not arbitrary guest exports. The source-pinned host deliberately adds only the
narrow Oliphaunt export driver needed to match the Rust WASIX lifecycle; it is
not a general synchronous WASIX process API. Generic Wasmer process streams
remain upstream behavior and are not part of the TypeScript database surface.

## Node, Bun, Deno, and Electron lifecycle

Native-host conditions load one Node-API 8 addon. The root constructs
`NativeWasixActorDatabase`, which directly owns the Rust `AsyncOliphaunt`
database actor. Bounded admission is synchronous, PostgreSQL runs on its one
Rust owner thread, and completion settles the existing Promise on the importing
JavaScript thread. This is the responsive default and adds one native queue hop.

The conditional `/direct` export constructs `NativeWasixDatabase` around
synchronous `oliphaunt_wasix::Oliphaunt` on the importing JavaScript thread. It
has the fewest hops and can block that event loop. The conditional `/worker`
export creates one real package-owned Node-compatible Worker, which loads the
same `/direct` implementation inside that Worker. It adds the requested
JavaScript RPC hop and realm isolation without a child process or a second Rust
owner thread. Native direct handles remain creator-thread-affine.

Close establishes one admission cutoff. The actor drains accepted work and
settles its terminal completion. Direct close runs on its owning thread. A
package Worker closes its native database at quiescence, posts the close reply,
then closes its parent port and exits itself; the parent does not terminate a
Worker across an active Node-API frame. An unexpected Worker exit rejects
pending work and leaves the public handle terminal.

Query serialization, close semantics, the memory default, storage identity,
and public errors remain TypeScript-owned. Descriptor validation also remains
shared, but native release addons resolve validated extension SQL names against
their compile-time catalog instead of expanding portable extension archives at
open.

IndexedDB and OPFS remain browser-only and are rejected before a native-host
actor, direct, or Worker session starts. Directory persistence is exposed through matching
`storage/node`, `storage/bun`, and `storage/deno` entrypoints. They preserve the
shared managed-root descriptor and exclusive path ownership while Rust owns
the database bytes and durability. No host falls back to native
`@oliphaunt/ts`. Direct and explicit `/worker` entrypoints may themselves
be imported from an application-owned worker thread. Rust holds one OS advisory
lock for the managed-root lifetime, shared with direct Rust owners. There is no
JavaScript marker lock to recover. Callers should still close before externally
terminating their own realm.

## Protocol streams, tools, and local endpoints

The public callback stream reuses the guest's COPY-aware synchronous transport
and emits at most 64 KiB per callback. Browser root and native `/direct` invoke
the callback in their owning JavaScript realm. Browser and native-host
Workers block only their Worker with a shared-memory acknowledgement until the
importing-realm callback returns. The native actor uses a napi-rs thread-safe
function with queue size one and waits for each JavaScript acknowledgement.
Every path therefore preserves bounded backpressure and callback ordering.

Direct native requests borrow JavaScript input for the duration of their
synchronous call. Actor requests copy into owned Rust admission data before the
call returns. All native responses, backup archives, chunks, and tool output are
ordinary V8-owned typed arrays with predictable detach and lifetime behavior.
The Worker transport transfers eligible response `ArrayBuffer` values directly;
there is no external-buffer finalizer crossing an isolate or environment exit.

A callback returning a Promise or thenable is rejected: asynchronous
completion cannot acknowledge this synchronous backpressure contract, and the
PostgreSQL session is poisoned conservatively. The callback is also an
ownership boundary: it cannot queue work through the same database or
transaction while that database is waiting for the chunk acknowledgement. Such
reentry fails immediately instead of creating a hidden post-stream operation.

`@oliphaunt/wasix-tools` remains the optional public facade. In a browser it
resolves the separately published `@oliphaunt/liboliphaunt-wasix-tools` asset
carrier. `pg_dump` runs in the realm that already owns the database; `psql`
uses a separate persistent browser tool worker because COPY input is genuinely
full duplex. Its private pgwire connection has fixed, bounded shared-memory
rings.

Native release addons compile both frontends and the current extension catalog
into every platform binary. Node.js, Bun, Deno, and Electron route `pg_dump` and
`psql` through the existing Rust database owner on root, `/direct`, or `/worker` and do
not resolve portable tool bytes at invocation time. This intentionally trades
larger platform packages and a coordinated carrier release for fewer startup
reads, decompressions, compilation steps, and runtime compatibility edges.

The package export `@oliphaunt/wasix-ts/internal/tools` exists only so the
version-matched `@oliphaunt/wasix-tools` package can reach this bridge. It is not
an application API or part of the stable SDK surface, is undocumented for app
consumers, and may change only in lockstep with that companion package. Package
checks reject any other low-level query or protocol subpath exports.

The database session is exclusively serialized. It resets PostgreSQL with
`ROLLBACK`, `DISCARD ALL`, and the configured role before and after a tool, then
publishes storage once after the final safe cleanup boundary. An uncertain tool
transport outcome poisons the handle after making its stored state safe. The
tools remain outside the core public database surface on both adapters.

The host-only `/server` subpath uses conditions to export the same implementation
for Node, Bun, Deno, and Electron. It has no browser or default condition. The implementation
constructs the Rust `OliphauntServer` through the same addon rather than
adapting a JavaScript socket relay. It binds one loopback TCP or
PostgreSQL-named Unix listener and serves one active client. Another connection
may wait in the operating-system backlog, so consumers configure pools with a
maximum size of one. Each admitted connection receives a fresh embedded
backend. Server state, listener lifetime, and storage publication are
Rust-owned; the TypeScript facade retains the
existing Promise-shaped open/close and `closed` contract. The concurrent WASIX
postmaster remains a separate runtime product rather than a mode of this
single-backend SDK.

## Browser storage boundary

Storage is a binding-owned provider/lease contract rather than runtime asset
configuration:

```text
opaque storage descriptor
          |
          v
 acquire provider lease ---- exact physical compatibility
          |
          +---- synchronous OPFS /base ---- exact-range file I/O
          |
          `---- portable /base ------ journaled publication
                           |
                           v
              PostgreSQL boundary + release
```

The main package owns the fresh-memory descriptor and default. IndexedDB and
OPFS are selective `./storage/indexed-db` and `./storage/opfs` entrypoints whose
implementations load only when an opaque descriptor reaches the owning
realm. Raw serialized descriptors are not accepted from consumers. The
internal lease exposes `state`, one initial PGDATA mount,
an optional synchronous PGDATA materializer, `sync(directory, boundary)`, and
`close(directory, outcome)`; it does not own runtime or extension assets.

The source-pinned Wasmer `Directory` exposes a compact current-state mutation
journal. Write-capable files are wrapped so a PostgreSQL descriptor retained
across multiple operations records every later write, not only its initial
open. The shared portable delta layer drains the journal only at
PostgreSQL-safe host boundaries, collapses overlapping paths, reads changed
files and subtrees, and expresses removals explicitly. A provider without that
host capability falls back to a full scan, so correctness does not depend on
the optimization. Synchronous OPFS mounts bypass mutation tracking and serve the
guest synchronously in its owning worker. Process-lifetime `postmaster.pid` and
`postmaster.opts` never enter persistent storage.

Each logical IndexedDB name owns a separate physical IndexedDB database with
fixed metadata and one row per PGDATA path. Each boundary applies upserts and
removals in one atomic read-write transaction using the browser's default
commitState policy; an aborted write leaves the preceding generation intact,
and distinct logical databases do not share an object-store transaction. OPFS
stores a strict logical namespace and physical identity over flat backing files.
`/worker`, and the root inside a Dedicated Worker, preopen synchronous access
handles and perform exact-range guest I/O without a mailbox or nested worker. A
direct Window uses the portable path. Guest file flushes are immediate;
operation boundaries drain WAL; internal full-publication, close, and namespace publication
flush WAL before ordinary files and `global/pg_control`. The portable path uses
copy-on-write backing files and atomically replaces namespace state last. OPFS
has PostgreSQL recovery ordering but no cross-file transaction, so a failed
publication reports unknown state instead of claiming that nothing changed.
The synchronous path keeps a bounded private reserve of preopened backing files for
the synchronous hot path. Overflow is staged only until the mandatory host
boundary, which allocates, writes, and flushes every staged file before
publishing namespace state. A failure leaves the previous namespace
authoritative and poisons the live handle. The reserve is replenished
best-effort after successful boundaries, and hosts that cannot establish its
initial capacity use the portable path. Its size is an implementation detail,
not a public database-capacity limit.

Compatibility uses the PostgreSQL major and versioned WASIX physical format.
Runtime hashes and source fingerprints still reject mixed runtime, cluster-seed,
AOT, and extension build outputs, while package and carrier changes do not
rewrite the managed-root descriptor or reject an unchanged physical format.
Safe extension upgrade or removal remains an explicit migration concern rather
than a reason to reject every change in the available carrier set.
Cross-binding root handoff is not a supported or qualified workflow.

Persistent databases use an origin-scoped exclusive Web Lock. This preserves
the single-owner invariant rather than suggesting that one single-user
PostgreSQL backend represents independent connections. There is no leader
proxy or multi-tab transaction ownership yet.

Provider acquisition and PGDATA materialization happen before PostgreSQL
starts. Provider boundaries happen only after pgwire recovery returns
`ReadyForQuery`, so ordinary PostgreSQL errors retain their existing
`PostgresError` identity. A host persistence failure is instead a typed storage
error and poisons the live handle: guest state may be ahead of confirmed durable
storage, so retrying the application operation is not known to be safe.

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
incompatible with non-WASIX extension descriptors, and the client
runtime-validates the complete shape.
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
duplicate roots, or conflicts. The selected realm resolves dependencies solely from
the imported install contracts, treating only the stripped core manifest's
`runtime-support` entries as runtime-provided. Before reading extension bytes,
it gates every carrier on the selected WASIX runtime version, PostgreSQL major,
extension-runtime contract, and required names in `runtime.link.exports`. It
then verifies each archive's declared size/hash and overlays exactly its
carrier-owned installed-file inventory. The core manifest is required to have
`extensions: []` so it cannot quietly reclaim optional extension ownership.

That byte-closure processing is the browser implementation. Node.js, Bun, Deno,
and Electron retain the same public descriptor and perform its structural/runtime
validation, but pass only the validated, dependency-ordered SQL names across
the N-API boundary. The Rust runtime resolves those names against the exact
extension features compiled into the release carrier. Unknown names fail; the
addon never treats arbitrary descriptor bytes as native code. A new or upgraded
extension can ship independently for browsers, but it becomes available to
native-host consumers only after the N-API product is rebuilt and released
with that feature.

## Host compatibility

The host is rebuilt from source rather than maintained as hand-edited generated
JavaScript/WASM. `host/source.toml` pins the Wasmer JS Git source and Cargo
crates; the adjacent patches are the reviewable compatibility delta. The build
lands first in `target/oliphaunt-wasix-ts/host`. Public package staging copies
the exact JS module, worker module, WebAssembly module, license, and provenance
into `lib/host`; the browser root imports the host in the caller realm, while
the browser `/worker` imports it in its package Worker. Node.js, Bun, Deno, and Electron
conditions do not import this module.

This is not a general backport of WASIX 0.702 to Wasmer 0.601. The authoritative
patch order is the `series` in `host/source.toml`; this document records the
resulting invariants instead of duplicating that filename inventory. Together,
the patches:

- honor configured args, environment, mounts, cwd, and stdio; preserve original
  module bytes where the generic blocking worker needs them; and repair the
  pinned npm/toolchain inputs without mutating their lock;
- provide only the 0.702 compatibility imports and runtime devices required by
  the shipped guests, reject unavailable fork/context/thread/process behavior,
  remove the retired Rust target, and recognize standard WebAssembly exception
  reference types;
- make oversized main-module construction asynchronous through the builder and
  linker while keeping the returned database driver synchronous and rejecting
  unsupported oversized side modules before open;
- enforce the single-backend profile, use correct realtime and monotonic clocks,
  amortize bounded pending-work checks, and avoid turning synchronous-file POSIX
  close into an implicit fsync that bypasses PostgreSQL durability policy;
- expose the current-state mutation journal and the narrow caller-realm
  synchronous filesystem bridge used by synchronous OPFS, without reviving the old
  mailbox transport;
- provide the caller-realm PostgreSQL lifecycle and reusable-memory pgwire
  driver, including COPY-aware callback streaming, top-level error recovery,
  and a bounded 16 KiB failure-only stderr tail; and
- run only the packaged PostgreSQL frontend tools through a fresh caller-realm
  WASIX process with captured stdio and synchronous pgwire callbacks. This path
  uses neither the generic Wasmer scheduler worker nor a Web Streams pump.

The clock specialization is intentionally narrower than a general syscall
shortcut. Realtime uses the JavaScript epoch clock, while monotonic reads
calibrate the host's monotonic clock against the canonical Rust fallback epoch,
so fast and fallback reads cannot jump between domains. Process and thread CPU
clocks remain on the canonical fallback because wall time is not an equivalent
clock. Synthetic clock offsets remain honored by declining the direct import
for guests that import `clock_time_set`, and pending WASIX operations are
checked on a real-time bound. Invalid clock IDs, pointers, or host values use
the complete Rust syscall. Other WASIX programs retain the complete upstream
per-call path.

The exact pairing is qualified for the single-process direct Oliphaunt export
path in both execution surfaces, including repeated PostgreSQL `ERROR` recovery. The
direct driver treats every `PostgresMainLoopOnce` trap as the guest's exported
top-level recovery boundary and also cleans up non-trapping ErrorResponses.
Its JavaScript memory bridge is limited to the direct Oliphaunt driver: generic
WASIX streams keep their normal ownership and scheduling semantics. Copy failures
are caught before guest buffers are released, and protocol responses are copied
once into owned JavaScript storage rather than exposed as mutable guest views.
Browser qualification loads and calls PostGIS in a real worker and asserts that
its dependency side module exceeds Chromium's 8 MiB main-thread compilation
limit; the exemption is therefore attached to the worker realm, not to an
extension name or a benchmark payload size.
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
Lifecycle SQL for a selectively imported extension runs in the owning realm.
Isolated-host errors are serialized by PostgreSQL field and rebuilt in the caller;
direct errors retain the same `PostgresError` identity in place. Generic
transport errors retain their name, message, and owner-side stack. Neither path
collapses SQLSTATE and diagnostics into a generic error.

PGlite is also a useful ordering reference: it stages extension archives and
precompiles Emscripten side modules before PostgreSQL starts. Those
`MAIN_MODULE`/`SIDE_MODULE` binaries are not WASIX carriers, however, and its
filesystem persistence is coupled to Emscripten FS.

The browser benchmark also exposed a preparation asymmetry: PGlite reused
precompiled modules while each WASIX open recompiled the verified guest bytes.
Caller-realm execution now bounds and keys immutable preparation and compiled-module
caches by exact runtime/carrier/GUC identity. Mutable directories and storage
leases never enter those caches. The checked-in insert benchmark compares WAL
volume alongside timing; separate root-cause diagnostics compare buffer
activity and relation sizes. Both keep host/runtime overhead visible without
changing PostgreSQL work or commitState settings.

This binding keeps the following deliberate divergences:

- extension lifecycle and install metadata comes from each selectively imported
  `-wasix` package; the stripped runtime manifest cannot override it;
- runtime/PGDATA/manifest hashes, carrier hashes, required core exports, exact
  installed-file inventories, dependencies, and collisions are checked before
  startup;
- selecting an extension stages its verified artifacts and startup configuration;
  applications explicitly run ordinary `CREATE EXTENSION`, `LOAD`, schema, or
  migration SQL, matching the ownership expected by ORMs; and
- IndexedDB and OPFS now use source-pinned dirty-path synchronization at each
  completed protocol operation, matching PGlite's useful commitState boundary
  without importing Emscripten FS. Oliphaunt keeps explicit provider-specific
  atomicity and exclusive ownership; multi-tab leadership remains unsupported.

The host validates every native `load-order` entry against the carrier's exact
installed-file inventory but does not execute it as SQL. Applications explicitly
issue any required `LOAD`/`CREATE EXTENSION` lifecycle, after which PostgreSQL and
Wasmer's dynamic linker remain responsible for each module's declared
`dylink-needed` closure. `shared-memory-required` contracts remain rejected
because the single-backend runtime has not qualified that capability.

## Asset ownership

The `@oliphaunt/wasix-ts` tarball does not contain PostgreSQL binaries. Browser
conditions import `@oliphaunt/liboliphaunt-wasix`, whose generated descriptor
points at package-owned runtime, PGDATA, and manifest assets. There is no public
raw runtime-source override. Development reads
`target/oliphaunt-wasix/assets`, produced by
`liboliphaunt-wasix:runtime-portable`, through the browser example's Vite
plugin, which models that generated carrier.

Node.js, Bun, Deno, and Electron also receive one target-filtered optional dependency.
The public carriers are
`@oliphaunt/wasix-napi-darwin-arm64`,
`@oliphaunt/wasix-napi-linux-arm64-gnu`,
`@oliphaunt/wasix-napi-linux-x64-gnu`, and
`@oliphaunt/wasix-napi-win32-x64-msvc`. Each has no install script and contains
one `oliphaunt_wasix_napi.node` binary with both standard and ICU profiles. The private
`@oliphaunt/wasix-napi` product coordinates the Rust build and carrier release;
applications never import it.

Linux carriers are GNU/glibc-only. The adapter identifies libc from the
runtime diagnostic report before resolving package-adjacent, optional, or
explicit addon paths; known musl and unknown libc identities fail closed.

Native release builds embed the runtime, seed, AOT objects, frontend tools, and
complete currently supported extension feature set. Optional extensions remain
exact, separately imported `-wasix` packages at the public TypeScript boundary,
but native hosts use their descriptor identity to select compiled-in artifacts
instead of copying the carrier bytes. Their availability is consequently a
release-time N-API contract.

The source workspace manifest deliberately does not resolve that generated
carrier from npm: the carrier exists only after same-candidate runtime assets
are frozen. SDK release staging injects the exact dependency recorded by
`oliphaunt.runtimeVersion`, validates it, and publishes only that staged
manifest. This keeps fresh frozen workspace installs independent of an
unpublished candidate while making the consumer tarball's browser runtime edge
exact. The same staging step rewrites every native optional dependency to the
exact N-API product version. The loader rejects a carrier whose package name,
version, target, WASIX runtime, addon ABI, Node-API level, or profile inventory do
not match the SDK metadata; the addon then self-reports its runtime and exact
supported profile inventory before open.

The release runtime carrier owns a stripped core manifest (`extensions: []`).
The development Vite plugin projects the same core-only bytes from the build
pipeline's qualification manifest and derives separate exact extension install
contracts from its extension rows. The binding rejects a nonempty core manifest,
so the runtime carrier cannot become the authority for independently versioned
extensions.

The first browser smoke selects the SQL-only `pgtap` carrier and explicitly runs
`CREATE EXTENSION`. That isolates manifest verification, dependency ordering, archive overlay, and lifecycle SQL
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
release metadata and changelog, declares an exact browser dependency on the
published `@oliphaunt/liboliphaunt-wasix` runtime carrier, and declares the four
exact native packages as optional dependencies. It publishes the patched host
under `lib/host` for browser/default conditions. Conditional package exports
choose browser, Node.js, Bun, Deno, or Electron adapters. Browser root remains
caller-owned; the native-host root uses the Rust actor, `/direct` is caller-owned, and
the conditional `/worker` subpath is owned by its isolated Worker.

The browser smoke proves the exact runtime/host pairing can start PostgreSQL,
explicitly activate `pgtap`, retain SQLSTATE across repeated PostgreSQL error recovery,
continue with `42` on the same handle, persist through IndexedDB operation
boundaries, run an explicit `CHECKPOINT` through `execute`, and close with a
successful zero exit status. Each Node.js, Bun, Deno, and Electron host smoke installs the
packed SDK and matching packed platform carrier into a fresh external project,
verifies conditional-export and profile selection, starts the embedded
WASIX Rust runtime, activates a compiled extension, recovers from an error, and
closes cleanly. Each carrier also runs a real actor Simple Query roundtrip and
proves its V8-owned response buffer is transferable; Node additionally proves
direct and local-server lifecycles. The Deno proof uses local `node_modules`
with explicit read, environment, and FFI permissions and qualifies the declared
Deno CLI range, not managed Deno Deploy. Electron additionally qualifies the
ASAR-unpacked native-addon layout. The opt-in native browser profile
additionally loads and calls the canonical `pg_uuidv7.so`; it remains a narrow
canary rather than a generic dynamic-extension claim.

The intentional host, persistence, extension, and Wasmer compatibility limits
remain listed in [README.md](./README.md). They are explicit product boundaries,
not compatibility aliases or fallbacks to a native SDK.
