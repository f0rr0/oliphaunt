# `@oliphaunt/wasix`

TypeScript binding that runs the portable Oliphaunt WASIX runtime inside a
browser Web Worker or Node worker thread. This is a separate WASIX-facing product surface;
it does not import `@oliphaunt/ts`, the native runtime, Node direct, or the
broker.

The public package owns the patched Wasmer host and its browser/Node worker
adapters. Its default runtime edge follows the generated
`@oliphaunt/liboliphaunt-wasix` carrier contract, so ordinary consumers do not
configure raw core artifacts.

## Run the browser smoke

Build the canonical portable runtime and PGDATA template, then start the example:

```sh
moon run liboliphaunt-wasix:runtime-portable
pnpm --dir src/bindings/wasix-ts dev
```

The first `dev` run builds the browser host from the exact sources and patches
recorded under `host/`; the generated SDK stays under ignored `target/`. Open
the URL printed by Vite. The example server supplies the required
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` headers and serves assets from
`target/oliphaunt-wasix/assets`.

With those runtime assets already present, the finite Chrome proof is:

```sh
pnpm --dir src/bindings/wasix-ts smoke:browser
```

That finite smoke requires the canonical portable runtime, PGDATA template,
generated asset manifest, and exact `pgtap` extension carrier. It first proves
that opening a missing database returns a `FATAL` `PostgresError` with SQLSTATE
`3D000`. It then activates `pgtap`, runs `plan`/`ok`/`finish`, reports two
different query errors with SQLSTATEs `42601` and `22012`, returns to
`ReadyForQuery` after each one, executes `SELECT 40 + 2 AS answer` on the same
handle, calls `pgtap_version()` again, persists one row through explicit
`checkpoint()`, persists a second later row only through clean `close()`,
reopens both, accepts Terminate, and requires Wasmer's final process result to
be successful with exit code zero. This proves the checked-in source and carrier
pairing, not arbitrary Wasmer or WASIX versions.

The separate native-module canary adds the canonical `pg_uuidv7` carrier and
calls its C-backed function before and after the same recovery sequence:

```sh
pnpm --dir src/bindings/wasix-ts smoke:browser:pg-uuidv7
```

That canary is narrow integration evidence. It does not add a browser target
to the extension catalog or make arbitrary WASIX dynamic modules supported.

Inside that checked-in Vite harness, application code imports only the
extension carrier it uses. `@oliphaunt/wasix` resolves the exact
`@oliphaunt/liboliphaunt-wasix` runtime carrier internally:

```ts
import Oliphaunt from '@oliphaunt/wasix';
import pgtap from '@oliphaunt/extension-pgtap-wasix';

const database = await Oliphaunt.open({
  extensions: [pgtap],
});

const result = await database.query('select $1::int4 + 1 as answer', [41]);
console.log(result.getText(0, 'answer'));
await database.close();
```

The same code runs on Node.js. Package exports select `worker_threads`
automatically; consumers do not import a Node-specific subpath:

```sh
pnpm add @oliphaunt/wasix @oliphaunt/extension-pgtap-wasix
```

```ts
import Oliphaunt from '@oliphaunt/wasix';
import pgtap from '@oliphaunt/extension-pgtap-wasix';

const database = await Oliphaunt.open({ extensions: [pgtap] });
console.log((await database.query('select pgtap_version() as version')).getText(0, 'version'));
await database.close();
```

Omitting `storage` selects a fresh Wasmer memory filesystem. Each `open()` is
independent, and closing it discards its PGDATA. The explicit spelling is
available from the main package when it helps communicate intent:

```ts
import Oliphaunt, { memory } from '@oliphaunt/wasix';

const scratch = await Oliphaunt.open({ storage: memory() });
```

## Persistent browser storage

Persistence is an optional, selectively imported adapter. Applications name an
origin-scoped IndexedDB database; they do not configure runtime archives, PGDATA
template URLs, filesystem mount paths, or a generic `temporary` boolean:

```ts
import pgtap from '@oliphaunt/extension-pgtap-wasix';
import Oliphaunt from '@oliphaunt/wasix';
import { indexedDB } from '@oliphaunt/wasix/storage/indexed-db';

const storage = indexedDB('todos');

let database = await Oliphaunt.open({
  storage,
  extensions: [pgtap],
});

await database.query('create table if not exists todo (title text not null)');
await database.query('insert into todo values ($1)', ['write the docs']);

// Optional while the database remains open: PostgreSQL CHECKPOINT reaches
// ReadyForQuery before the adapter atomically publishes a complete PGDATA copy.
await database.checkpoint();
await database.close(); // Also publishes PGDATA after a clean PostgreSQL exit.

database = await Oliphaunt.open({ storage, extensions: [pgtap] });
console.log((await database.query('select * from todo')).rows.length);
await database.close();
```

The adapter owns only `/base`, the PostgreSQL data directory. On every open the
binding fetches and verifies the selected runtime again, creates fresh
`/home` and `/tmp` mounts, and reconstructs `/bin`, `/lib`, and `/share` from
the runtime plus the selectively imported `-wasix` extension carriers. The
IndexedDB database records the exact runtime, PostgreSQL, template, manifest, and
extension-carrier identities that created its current generation. Reopen fails
closed with `WasixStorageError` code `incompatible` if any of those identities
change or a previously selected extension import is missing. Adding, upgrading,
or removing extensions from an existing database needs a future explicit migration
contract; omission never silently uninstalls one.

One worker owns a persistent database at a time. A second open in the same origin
fails immediately with `WasixStorageError` code `busy`; it does not run a second
PostgreSQL process or wait indefinitely. This is exclusive ownership, not a
multi-tab proxy or multiple database connections.

Lifecycle semantics are fixed rather than dynamically reported:
`multipleInstances = true` for separate workers using memory or different
persistent store names, `sameInstanceLogicalReopen = false`,
`instanceSwitchable = true`, and `crashRestartable = false`. A given IndexedDB
name remains exclusively leased despite support for separate instances.

This first persistence contract is intentionally narrower than a direct
filesystem:

- `checkpoint()` and a successful `close()` recursively copy the complete
  Wasmer `/base` memory directory into one atomic IndexedDB record;
- a PostgreSQL statement error still completes recovery through `ReadyForQuery`
  and remains an ordinary `PostgresError`; it does not poison persistence;
- a snapshot failure is a distinct `WasixStorageError`. The previous generation
  remains current and the handle is poisoned because application commits may
  exist in memory even though they were not published;
- browser or worker termination between checkpoints loses changes since the
  last published generation. This is clean-close/checkpoint persistence, not
  per-query flush or crash-durability; and
- OPFS is deliberately absent. The current Wasmer `Directory` API exposes a
  memory filesystem and recursive reads/writes, but no dirty-file feed or
  synchronous OPFS mount. An adapter that merely renamed the same snapshot
  behavior would be misleading.

There is likewise no browser `temporaryDirectory()` spelling: omitted storage
already means anonymous in-memory lifetime. Rust WASIX
`DatabaseStorage::TemporaryDirectory` is a different, disk-backed lifetime
policy, and must not be projected into this API
as if it meant memory. This clean-break API accepts no `root`, `temporary`, or
generic persistence compatibility aliases. Node uses the same memory default
and rejects the browser-only IndexedDB adapter. No Node directory persistence
is claimed yet, and neither host routes through the native public product.

The default runtime descriptor keeps the runtime archive, PGDATA template, and
manifest as one product/version identity. The binding validates the descriptor,
fetches all three package-relative assets, verifies their declared sizes and
hashes, and compares the runtime and PGDATA identities with the canonical
manifest before starting PostgreSQL. This happens for core-only opens too.
Decompression, filesystem materialization, Wasmer initialization, PostgreSQL,
and pgwire all stay in the worker.

Raw sources remain available only as an explicitly advanced, all-or-nothing
runtime override:

```ts
await Oliphaunt.open({
  advanced: {
    runtime: {
      schema: 'oliphaunt-wasix-runtime-v1',
      runtime: 'wasix',
      product: 'liboliphaunt-wasix',
      version: '0.1.1',
      runtimeArchive: {
        archive: 'oliphaunt.wasix.tar.zst',
        sha256: runtimeSha256,
        size: runtimeSize,
        source: runtimeBytes,
      },
      pgdataArchive: {
        archive: 'prepopulated/pgdata-template.tar.zst',
        sha256: pgdataSha256,
        size: pgdataSize,
        source: pgdataBytes,
      },
      manifest: {
        sha256: manifestSha256,
        size: manifestSize,
        source: manifestBytes,
      },
    },
  },
});
```

URLs and `Uint8Array` values are accepted, but an override cannot replace only
one of the three identity-bound assets.

`extensions` deliberately does not accept SQL-name strings. A portable carrier
package exports one dependency-free structural descriptor with
`schema: 'oliphaunt-wasix-extension-v1'` and `runtime: 'wasix'`. The descriptor
selects one root SQL name and contains the exact carrier closure needed by that
import. For example, an `earthdistance` descriptor may carry both
`earthdistance` and `cube`. Each independently versioned carrier owns its exact
dependency, lifecycle, installed-file, native-module, required-core-export, and
compatibility metadata. The stripped core runtime manifest owns only the core
identity and runtime-provided support such as `plpgsql`. Byte-identical
dependency rows shared across separately imported descriptors are deduplicated.
A descriptor that repeats one of its own rows, has an incomplete or over-broad
closure, conflicts on a SQL name/archive/install contract, or targets another
runtime/PostgreSQL identity fails closed.

The WASIX package is the special-case identifier; the existing native package
keeps its current name:

```text
@oliphaunt/extension-pgtap        native/default carrier
@oliphaunt/extension-pgtap-wasix  portable WASIX carrier
```

Both browser and Node WASIX hosts consume the same `-wasix` descriptor
and portable bytes. It is versioned in the existing
`oliphaunt-extension-pgtap` product stream, alongside the native/default
carrier, rather than owning a second release line. Each extension product
generates its own `-wasix` package; the development Vite harness derives virtual
package descriptors from current canonical target outputs during local builds
and smokes. The optional `pg_uuidv7` canary is dynamically imported only when
`?pg_uuidv7=1` is present.

The checked-in Vite app is a development and smoke harness, not a production
asset server. Public packaging copies the exact source-built host, its worker,
WebAssembly module, license, and provenance under `lib/host`; neither consumers
nor the example alias stock `@wasmer/sdk`. An application bundler must preserve the
module-Worker edge and preserve/serve the runtime carrier's package-relative
assets. The deployed application owns the required COOP/COEP headers, not
runtime artifact URL bookkeeping.

## Current scope and divergences

- Portable WASM only; browser and Node hosts never consume host AOT artifacts.
- One serialized WASIX direct session per opened worker. Its active filesystem
  is always Wasmer memory; storage adapters control how PGDATA is hydrated and
  checkpointed around that process.
- A prepopulated PGDATA template is required; browser `initdb` is not run.
- Omitted storage is fresh memory. The optional IndexedDB adapter proves exact
  compatible reopen, exclusive ownership, explicit checkpoint, clean-close
  persistence, SQL-error recovery, and extension reconstruction. It does not
  claim per-query synchronization, crash durability, OPFS, multi-tab proxying,
  or extension migrations.
- Extensions are selected by imported, runtime-discriminated WASIX
  descriptors. Each descriptor owns its exact SQL identity, archive hash/size,
  dependency closure, install inventory, lifecycle, required core exports, and
  WASIX/PostgreSQL compatibility. The stripped core manifest verifies the core
  runtime/PGDATA identity and exported-symbol authority without owning optional
  extension rows.
  The first smoke profile selects SQL-only `pgtap`, including its canonical
  `plpgsql` dependency and lifecycle SQL. A separate opt-in profile selects the
  native `pg_uuidv7` carrier and has loaded and called its `.so` in the exact
  pinned Chrome/host/runtime pairing. This remains a canary rather than a
  support claim. The current development bytes are produced by the canonical
  `liboliphaunt-wasix` asset pipeline, outside this binding; the generated WASIX
  package places that exact carrier in the owning extension product's existing
  version stream. Selected rows that require an explicit native
  `load-order` or shared-memory behavior fail closed until the browser host
  implements and qualifies those contracts.
- Optional ICU data, tools, backup/restore, server mode, query cancellation,
  and COPY streaming are not exposed yet.
- PostgreSQL `ERROR` recovery is scoped to the explicit stdio-pgwire contract.
  Wasmer JS's WASIX 0.601 runner lets the guest's wasm-EH `longjmp` escape the
  asynchronous `_start` call as a `WebAssembly.Exception`. Before Wasmer closes
  stdio or marks the process finished, the source-patched host recognizes that
  exception only when `OLIPHAUNT_WASIX_STDIO_PGWIRE=1`, calls the existing
  `PostgresMainLongJmp` cleanup export, and continues through the existing loop
  exports. Later errors use the same pump. This Wasmer version erases the wasm
  exception tag at the Rust boundary, so the pinned source pairing assumes the
  only escaping `WebAssembly.Exception` on this explicit transport is
  PostgreSQL's top-level jump. Non-exception runtime errors and traps still
  fail closed.
- PostgreSQL errors retain `PostgresError`, SQLSTATE, and backend fields across
  the worker boundary, including startup database rejection and failures in
  selected-extension lifecycle SQL during `open()`. Storage ownership and
  snapshot failures remain the separate `WasixStorageError` family.
- Like the Rust WASIX binding, a non-default `username` selects an existing
  role with `SET ROLE` after the fixed `postgres` bootstrap. It does not create
  roles or replace the single-user bootstrap identity.
- The binding imports the runtime descriptor from
  `@oliphaunt/liboliphaunt-wasix`; selected extension descriptors supply their
  own exact portable carrier URLs or bytes. Runtime payloads stay
  owned by `liboliphaunt-wasix` rather than moving into this binding.
- Every open requires and verifies the exact canonical manifest, runtime,
  PGDATA, runtime module, PostgreSQL version, and source identity. Selected
  extension carriers are additionally verified before their declared files are
  installed.
- Stock `@wasmer/sdk` 0.10.0 does **not** run the current runtime unchanged. It
  embeds Wasmer 6.1/WASIX 0.601 while canonical runtime artifacts target
  Wasmer 7.2/WASIX 0.702. `host/source.toml` and `host/patches/` own a narrow,
  source-built compatibility host; no opaque host
  binary is checked in. The patches compile large modules asynchronously,
  preserve module bytes across the blocking worker, and run the configured
  builder so args, environment, mounts, and stdio survive process launch. The
  host also owns the transport-scoped PostgreSQL recovery pump described above.
  The resulting JS, worker, Wasm, license, and provenance files are published
  package-relative so ordinary browser and Node resolution selects the same
  qualified host without an application alias.
- That host is qualified only for the single-process stdio-pgwire path.
  `proc_exit2` maps to the older normal-exit implementation, while
  `proc_fork_env` and context create/switch/destroy fail with `ENOTSUP`.
  Those shims are installed for both WASIX memory widths. The host also creates
  ephemeral `/dev/shm` and installs Wasmer's real `RandomFile` at
  `/dev/urandom`; this is not generic Linux filesystem or POSIX shared-memory
  parity. Context switching remains a generic compatibility gap, but it is not
  used for the qualified PostgreSQL error-recovery path. Generic WASIX 0.702
  compatibility, broader filesystem behavior, and general native
  dynamic-extension support are not claimed.
- The stdio lifecycle attaches the existing protocol Port before standalone
  initialization can report a PostgreSQL startup failure. An `ErrorResponse`
  can therefore end startup without `ReadyForQuery` and still retain its
  SQLSTATE. Successful startup has a nonstandard two-part boundary: the first
  response ends after authentication/connection data; the standalone main loop
  then emits `ParameterStatus*` and a second `ReadyForQuery`. The worker drains
  and validates that second batch before exposing the session.
- The Wasmer npm release records source commit `93b8b738...`, whose checked-in
  package metadata still says `0.8.0`, and its npm lock is stale. The host build
  pins that exact Git commit plus Cargo crate checksums, imports the upstream
  lock as its dependency baseline with the repository's pinned pnpm, then must
  resolve the missing build metadata without a frozen lock in its disposable
  checkout. This is intentionally not yet a hermetic release build.
- The 2026-08-12 dependency audit found `@wasmer/sdk` 0.10.0 is still npm's
  latest release. Its exact source commit nevertheless pins a coherent older
  family: `wasmer`/`wasmer-types` 6.1.0 and `wasmer-wasix`, `virtual-fs`,
  `virtual-net`, `wasmer-config`, `wasmer-package`, and
  `wasmer-backend-api` 0.601.0. `wasmer-wasix` 0.702.1 is available, but is not
  a compatible single-crate replacement: it requires Wasmer 7.2.1, the matching
  0.702.1 support family, newer WebC and wasm-bindgen APIs, and Rust 1.93. A
  coordinated compile probe against the pinned Wasmer JS source reached that
  crate only after updating the whole family, then failed across changed
  filesystem mounts, task-manager shapes, registry APIs, wasm-bindgen
  conversion ABI, module hashing, and binary-package construction. The newer
  WASIX crate already owns the imports backfilled by patch 0002, but adoption
  requires porting Wasmer JS as a unit and reapplying/requalifying the
  PostgreSQL recovery pump against its context-switching execution path. The
  coherent 0.601 host remains pinned; mixing generations is not papered over as
  an update. A full 0.702 host port also changes the exact engine identity and
  requires rebuilding and qualifying the runtime and extension carrier set.
- The `pg_uuidv7` canary proves this exact small native module, not generic
  dynamic loading. Wasmer's broader pending
  [`fd_read`/`dlopen` correction](https://github.com/wasmerio/wasmer/pull/6485)
  still has an unresolved memory-safety review concern, so native browser
  extension promotion remains blocked on a safer host boundary and broader
  qualification.
- Malformed startup packets can exit before PostgreSQL installs its normal
  top-level query recovery boundary. The binding only emits a fixed valid
  startup packet; hardening arbitrary startup traffic is deferred.
- The package is a separately versioned public SDK product. It declares an
  exact-version dependency on `@oliphaunt/liboliphaunt-wasix`; that runtime
  remains its own product and the native `@oliphaunt/ts` graph stays separate.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for ownership and lifecycle details.
