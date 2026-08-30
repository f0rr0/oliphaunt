# WASIX TypeScript Node-API architecture and implementation checklist

Status: implemented locally; exact-commit hosted qualification pending
Reviewed against: `origin/main` at `4384d1bdfafee07e4e1963ac68027b4bcf002a1e`
Last reviewed: 2026-08-30

This document is the decision record and delivery checklist for replacing the
Node, Bun, Deno, and Electron Wasmer-JS execution path in
`@oliphaunt/wasix-ts` with a Rust Node-API path over `oliphaunt-wasix`.
Browser execution remains on the existing patched Wasmer-JS path.

The design optimizes the common path without adding concepts to the normal
database API. Runtime placement is selected by an import; database, query,
transaction, error, persistence, and lifecycle semantics stay aligned with the
other Oliphaunt SDKs.

## Final decisions

| Surface | Node/Bun/Deno/Electron implementation | Caller event loop | Purpose |
| --- | --- | --- | --- |
| package root | one Rust owner thread per database, running synchronous `Oliphaunt` | does not block on PostgreSQL work | default and recommended |
| `/direct` | synchronous `Oliphaunt` in the importing JavaScript realm | blocks while native work runs | lowest latency and benchmarks |
| `/worker` | a real JavaScript Worker which loads `/direct` | remains responsive | explicit realm isolation |
| `/server` | Rust WASIX TCP or Unix listener and backend | lifecycle calls are asynchronous | ordinary PostgreSQL drivers and ORMs |
| browser root and `/worker` | existing Wasmer-JS direct and Web Worker paths | unchanged | portable browser support |

The default root, `/direct`, and `/worker` are execution placements for the
same embedded database API. `/server` is deliberately different: it returns
only an endpoint/lifecycle handle and independent PostgreSQL clients own SQL,
transactions, and pooling. PostgreSQL wire cancellation is deferred explicitly
below.

### Decisions that reduce scope

- Use synchronous `oliphaunt_wasix::Oliphaunt` inside both the native owner and
  the real JavaScript Worker. Reuse the mature owner/queue/lifecycle core behind
  `AsyncOliphaunt`, but add a callback-completion admission path below its
  Future facade so the Node-API hot path does not add a Tokio task, oneshot
  wake, libuv async-work item, or second owner state machine. Do not use a child
  process in the normal Node-API request path.
- Keep the existing TypeScript logical-operation serialization initially. A
  query can span describe plus execute exchanges, and a callback transaction
  spans calls; a native FIFO alone cannot safely replace this ownership layer.
- Use an internal bounded native command channel with a fixed package-owned
  limit. This protects the Rust owner but does not bound end-to-end memory while
  the existing JavaScript `#tail` scheduler can retain arbitrary queued input
  snapshots. Do not add public queue settings or a queue-full error type without
  load/RSS evidence and a cross-SDK product decision; add an overload stress
  gate so this limitation is measured rather than hidden.
- Start with napi-rs `JsDeferred` per operation. It already provides a
  foreign-thread-safe settlement and environment cleanup path, and still uses
  only one owner-to-JavaScript dispatch for non-streaming operations. Streaming
  necessarily dispatches and acknowledges every bounded chunk. A
  persistent/coalescing dispatcher is deferred until profiling shows its
  per-operation allocation is material.
- A JavaScript Worker provides scheduling and realm isolation, not hard crash
  containment. Do not preserve the provisional child-process implementation or
  describe a Worker as a process sandbox.
- Do not refactor the shared query decoder, storage system, extension catalog,
  or browser host merely to complete the Node-API migration.
- Do not add public query cancellation in this migration. No current Oliphaunt
  binding exposes it, and a blocking `/direct` call cannot service a cancel
  request from the same JavaScript realm. Close stops admission and drains
  admitted work exactly as it does today.
- Remove the redundant TypeScript `wal_sync_method` startup override. The
  shared WASIX PostgreSQL port defines `PLATFORM_DEFAULT_WAL_SYNC_METHOD` as
  `FDATASYNC`; browser smoke must prove the effective compiled default.
- Do not add release targets. The first carrier set remains Linux x64/arm64
  GNU, macOS arm64, and Windows x64 MSVC. In particular, do not add macOS x64,
  Linux musl, or Windows arm64 here.
- Do not edit versions or changelogs in feature PRs. Release Please owns those
  changes.

## Public API and developer experience

### Embedded database

The root, `/direct`, and `/worker` exports must present the same
`OliphauntClient` and `OliphauntDatabase` contract. Existing application code
using the package root should need no configuration change. The default root
becomes responsive instead of executing guest CPU work on the importing event
loop.

The only placement-specific fact a developer needs is:

- use the root normally;
- use `/direct` when knowingly trading event-loop responsiveness for the
  smallest dispatch overhead; or
- use `/worker` when a separate JavaScript realm is required.

Keep Promise-returning database methods on all three surfaces. Keep query,
row, transaction, backup/restore, storage, error, close, and async-disposal
shapes aligned. Do not expose Rust actor IDs, operation generations, channels,
Node-API objects, or buffer ownership.

Do not add `database.cancel()` or per-call `AbortSignal` options in this
project. Cancellation is a separate cross-SDK product decision. In particular,
the synchronous `/direct` placement cannot accept a same-realm JavaScript
cancel while its event loop is blocked, so pretending that all placements have
identical live-cancel behavior would be misleading.

### Server

The server capability is justified. Native Rust, Rust WASIX, and desktop
TypeScript already expose a distinct PostgreSQL server lifecycle, and ordinary
drivers and ORMs need a `connectionString` when an embedded adapter is not
appropriate.

The `/server` import is the one justified spelling difference from the
host-only SDKs. Rust crates and desktop TypeScript can expose server construction
from their root because every supported host can listen on a local socket.
`@oliphaunt/wasix-ts` has one browser-compatible root, where that capability is
impossible. A separate host-only subpath keeps the root truthful, keeps native
socket code out of browser module graphs, and avoids a method that exists only
to throw. The semantic contract remains the same server-builder/connection-
string/lifecycle contract; only capability discovery moves to an import.

The public shape is exactly one host-only conditional subpath:

```ts
import { openServer } from '@oliphaunt/wasix-ts/server';

await using server = await openServer({
  storage: directory('./data'),
  listen: { transport: 'tcp' },
});

console.log(server.connectionString);
```

The existing `/server/node`, `/server/bun`, and `/server/deno` aliases are
redundant and must be replaced by `/server`; this package has not been released,
so compatibility aliases are unnecessary. Do not add `openServer()` to the
browser-capable package root: browsers cannot create local TCP or Unix
listeners, and an API that only throws there is misleading.

`OliphauntServer` contains only:

- read-only `connectionString` and `closed`;
- memoized terminal `close(): Promise<void>`; and
- `Symbol.asyncDispose`.

It has no query, transaction, backup, restore, or `cancel()` method. It binds
loopback TCP or a local Unix socket only. UDP, remote bind, TLS, GSS, a health
API, restart, server placement variants, and multi-session postmaster work are
out of scope. Until the Rust server has an accept coordinator, document its
single-active-client behavior accurately: another connection may wait in the
OS backlog rather than being deterministically rejected.

## Ownership and dispatch

### Root owner

- Construct, use, close, and drop each `Oliphaunt` on the existing dedicated
  `AsyncOliphaunt` owner OS thread. An opened `Oliphaunt` must never move
  between threads.
- Snapshot asynchronous input before returning control to JavaScript. Admit
  commands to a bounded FIFO and preserve logical-operation order.
- Add an immediate callback admission primitive to the shared owner core.
  Complete JavaScript promises through `JsDeferred`; never allocate a Tokio
  task, waiter thread, OS thread, runtime, or libuv async-work item for a query.
- Opening happens on the owner thread. A successful `open()` publishes only a
  ready handle.
- `close()` is ordered behind admitted work, terminal, and memoized. Reject new
  work once closing begins.
- A finalizer or environment cleanup hook requests shutdown but never blocks
  an environment thread joining a potentially hung owner.

### Direct

- Construct and use the synchronous handle in its creator JavaScript realm.
- Enforce creator-thread/environment affinity.
- Before direct construction can initialize Wasmer/WASIX's process-wide native
  runtime, request napi-rs's process-once addon-image retention. A Worker that
  only loads `/direct` otherwise has no deferred or threadsafe function to make
  that request, and its environment may unload the addon while runtime threads
  can still reach Rust code. The loader reference must not keep the JavaScript
  event loop alive.
- Borrow input bytes for the duration of a call.
- Rely on napi-rs's generated native borrow scope to reject synchronous
  reentry from a raw streaming callback before a second Rust borrow is formed;
  keep a live-addon regression for that boundary.
- Wrap database-affecting calls in an explicit panic boundary. Restore the
  handle only after a normal Rust return; a panic terminalizes and quarantines
  ownership rather than continuing with unknown state.

### Worker

- Use the package's real Worker abstraction on Node, Bun, Deno, Electron, and
  browsers. On host runtimes its Worker loads the synchronous Node-API direct
  entry; in browsers it loads the existing Wasmer-JS direct entry.
- Transfer exact input buffers into the Worker and borrow them there. Transfer
  ordinary V8-owned output buffers back.
- Never call `worker.terminate()` while a native operation is active. Active
  termination has reproduced a whole-process Node abort during Node-API output
  conversion.
- Close by stopping admission, settling the queue, waiting for the current
  native frame and stream callback to quiesce, closing/releasing the direct
  native handle, and allowing the Worker to exit itself. Observing that clean
  self-exit is the final host shutdown contract; do not redundantly call
  `worker.terminate()` afterward because Bun does not settle that call.
  Forced termination is reserved for startup/fatal cleanup before self-exit,
  and never while a native operation is active.
- An unrecoverable native hang, segfault, abort, or OOM remains process-fatal.
  Hard containment would require an explicit process product and is not part
  of `/worker`.

## Cancellation decision

Reusable query cancellation is not a prerequisite for this migration and is
not added to the public TypeScript API. This matches the current SDK contract,
avoids a placement-specific promise that `/direct` cannot honor, and removes a
large PostgreSQL/Wasmer patch from the Node-API delivery path. Root and Worker
remain responsive because of placement; responsiveness does not imply that
already-running guest code is interruptible.

`close()` stops new admission, drains already-admitted work, closes on the
owner, and settles once. Worker shutdown uses that same ordered close and
self-exits only after native quiescence. It never force-terminates an active
native frame. A hung guest can therefore make close remain pending, just as a
blocking direct call can remain blocked; hard hang containment requires a
separate process product.

If cancellation is designed later, it needs its own cross-SDK ADR and bounded
PR. That design must use database identity plus a never-reused active-operation
generation, deliver through PostgreSQL's normal
`InterruptPending`/`QueryCancelPending`, `SetLatch(MyLatch)`,
`CHECK_FOR_INTERRUPTS()`, and recovery path, and prove SQLSTATE `57014` plus a
valid `ReadyForQuery` before reusing the handle. `WasiProcess::signal_process`
or `Store::interrupter()` alone is not a reusable cancel protocol. CPU work and
each blocking wait family must be tested before making the smallest necessary
lower-runtime patch; a blanket Wasmer scheduler change is not justified.

PostgreSQL wire `CancelRequest` for external server clients is also deferred.
It requires an authenticated backend PID/secret, a concurrent accept
coordinator, and the same lower cancellation primitive; it does not justify a
`server.cancel()` method.

## Bytes and streaming

The public contract is ordinary `Uint8Array`, not externally backed storage.

- Public raw input is already copied by the TypeScript scheduler before its
  deferred operation is queued. `/direct` borrows that TypeScript-owned
  snapshot for the synchronous call.
- Root actor input takes the TypeScript snapshot plus one required
  JavaScript-to-Rust `Vec` snapshot before returning control to JavaScript.
- `/worker` transfers the TypeScript-owned snapshot into the Worker without an
  additional transfer copy, then borrows it synchronously there.
- Raw protocol, backup, tool output, and binary/raw row bytes that escape to
  JavaScript use V8-owned, transferable ArrayBuffers. Do not expose napi-rs
  external ArrayBuffers: Node rejects their transfer even when other runtimes
  accept it.
- At deferred settlement, use the `JsDeferred` resolver's JavaScript-thread
  `Env` to allocate and copy into a V8-owned typed array. Do not rely on the
  automatic `Vec<u8>`/`Uint8Array::from` conversion, which creates externally
  backed storage on the current napi-rs path.
- Start with V8-owned output for every Node-API response. External Rust-owned
  output is a later profile-gated optimization only if lifetime and escape
  analysis proves that no public view can observe it and every runtime has a
  safe fallback.
- Streaming permits one in-flight chunk. The root actor uses a bounded
  one-chunk TSFN/message rendezvous: copy borrowed guest memory into V8-owned
  memory, invoke JavaScript, send an explicit acknowledgement, and only then
  allow the owner to continue. Environment teardown must wake an owner waiting
  for that acknowledgement. JavaScript retains an exact thrown callback value;
  the final deferred rejects with that value only after the owner proves
  PostgreSQL recovery.

Do not promise zero copies as a product property. Track copies at each boundary
and remove only avoidable copies proven by benchmarks and lifetime tests.

## Errors, recovery, and lifecycle

- A PostgreSQL `ErrorResponse` followed by a valid `ReadyForQuery`, including
  SQLSTATE `57014`, rejects only that operation and leaves the database usable.
- A stream callback error leaves the database usable only after successful
  recovery; preserve the original callback value.
- A runtime trap, panic, protocol failure without a proven boundary, storage
  failure with unknown commit state, or owner loss makes the handle terminal.
  Do not replay or silently restart a session.
- An actor panic rejects the active and queued work with one stable terminal
  error. Direct panic quarantine follows the same rule.
- Environment teardown marks the environment dead before destroying completion
  machinery. Late completions are dropped without calling Node-API.
- Explicit close is one terminal attempt. Concurrent and later callers observe
  the same result. `closed` changes according to the repository-wide lifecycle
  contract, not by parsing error strings.

## Packaging and distribution

Use the existing private build product plus public optional platform carriers:

- `@oliphaunt/wasix-napi-linux-x64-gnu`
- `@oliphaunt/wasix-napi-linux-arm64-gnu`
- `@oliphaunt/wasix-napi-darwin-arm64`
- `@oliphaunt/wasix-napi-win32-x64-msvc`

`@oliphaunt/wasix-ts` declares exact-version optional dependencies and resolves
one local carrier. Packages use no install script and never download code at
runtime. A missing, mismatched, unsupported, musl, or wrong-libc carrier fails
with a useful setup error; host runtimes never fall back silently to
Wasmer-JS.

Keep Node-API 8 as the ABI floor. Qualify the declared Node, Bun, Deno, and
Electron versions rather than inventing a Node maximum unrelated to evidence.
Linux carriers follow the repository's existing glibc build and maximum-symbol
policy; this project does not redefine that baseline.

The release topology is one addon binary per target. It contains both qualified
standard and ICU seed/data profiles plus the release's frozen extension and
tool catalog; opening a database selects the profile without loading a second
addon. Profile selection is immutable per builder/database, including server
builders, and every reusable runtime, seed, and materialization cache is keyed
by profile. This removes duplicate runtime/code/catalog payload while
preserving the existing descriptor-based application API. Do not redesign
native extension loading in this migration. Independent native extension
carriers are a future package-size optimization and need their own measurements
and threat model.

`@oliphaunt/wasix-ts` deliberately remains one universal browser-and-server npm
package. The published tarball includes the patched browser Wasmer host and its
release-staging step adds an exact dependency on
`@oliphaunt/liboliphaunt-wasix`; npm therefore installs the browser payload for
host-only consumers too. Conditional exports prevent Node.js, Bun, Deno, and
Electron from loading that payload, but npm conditions cannot omit a normal
dependency at install time. This package-size cost preserves one package name,
offline browser assets, and deterministic resolution; it is not a server
fallback. The matching native carrier remains a target-filtered optional
dependency.

Deno consumers need local `node_modules` resolution plus `--allow-ffi`,
`--allow-read`, and `--allow-env`; `/worker` does not need process-spawn
permission. Electron packagers should leave `**/prebuilds/**` unpacked and ship
`app.asar.unpacked` beside `app.asar`, keeping the addon and platform loader
companions such as the Windows app-local VC runtime together. Carrier
qualification exercises that layout and proves that a missing unpacked
companion fails explicitly.

## Delivery and review boundaries

The implementation landed as one coherent end-to-end change because the actor,
Worker, profile-keyed runtime, carrier metadata, and packed-consumer contracts
must agree before any public package is usable. Review and qualification should
still use these bounded slices; they are not a requirement to manufacture
separate intermediate PRs with knowingly incomplete package contracts:

1. Consolidate the unreleased server export to `/server` and align package,
   SDK manifest, generated surface, and documentation.
2. Add callback admission to the shared Rust owner core and prove the existing
   Future API's ordering, abandonment, transaction, close, and owner-loss
   invariants before any adapter depends on it.
3. Review the Node-API actor and direct classes over that proven core.
4. Review the Node/Bun/Deno/Electron root routing and the real Worker
   over `/direct`, prove quiescent shutdown, and remove the child-process path.
5. Review the existing Rust `AsyncOliphauntServer` adaptation for `/server` and remove
   duplicate JavaScript listener policy without changing the public handle.
6. Review Rust catalog selection and caches as an immutable per-builder
   standard/ICU profile and prove mixed-profile process behavior.
7. Review the one profile-selecting addon per target, carrier topology,
   cross-runtime smoke tests, release policy, licenses, and provenance. Keep the
   frozen extension/tool catalog.

Public cancellation, wire `CancelRequest`, a multi-client server, and new
carrier targets remain separate proposals. Feature PRs do not edit versions or
changelogs; release automation owns those changes.

## Implementation checklist

### Phase 0 — preserve and separate the existing work

- [x] Confirm the implementation base is current `origin/main`.
- [x] Audit the dirty tree and treat all existing changes as user-owned WIP.
- [x] Record the final architecture and scope in this document.
- [x] Keep the integrated change reviewable through the bounded slices above
  and co-locate each slice's tests, generated contracts, and documentation.
- [x] Retain useful structured storage errors and exact tool stdout/stderr from
  the provisional implementation.

### Phase 1 — minimal functional Node-API placements

Rust shared owner and Node-API bridge:

- [x] Extend the existing `AsyncOliphaunt` owner core with immediate
  callback-completion admission for open, buffered raw protocol, backup, and
  close. Its bounded FIFO, transaction ownership, terminal close, owner-loss
  handling, and panic quarantine remain the single source of truth.
- [x] Gate the completion seam behind an exact-purpose private
  `__internal-napi` Cargo feature (plus tests). The Node-API crate enables it;
  ordinary Rust WASIX users and generated public API docs do not gain adapter
  methods.
- [x] Retain the Future API's fair, waiting async admission and oneshot replies.
  Share the typed owner command, execution, close, and owner-loss state machine
  with immediate callback admission; do not turn Rust Future calls into
  immediate busy rejection or fork lifecycle semantics for Node-API.
- [x] Export separate async actor and synchronous direct native classes. Keep
  creator affinity only on direct.
- [x] Settle one napi-rs `JsDeferred` directly from each owner callback, giving
  exactly one cross-thread completion dispatch per non-streaming operation and
  napi-rs-owned environment cleanup. Streaming additionally uses its bounded
  per-chunk rendezvous. Do not route replies through `napi_async_work`, a
  blocking receiver, or a custom runtime.
- [x] Map structured Rust errors at the ABI boundary. Remove text/source-chain
  inference once every Rust error carries its classification.
- [x] Return V8-owned public output bytes; retain external buffers only for
  proven internal nonescaping use.
- [x] Add focused Rust unit tests for callback ordering/admission, exact-once
  rejection, callback panic, queue/owner loss, close cutoff/retry/reentry,
  shared close, and terminal replay; keep the full Rust library suite green.
- [x] Add the live Node-API integration roundtrip for actor open, recoverable
  raw protocol work and reuse, backup, repeated close, and environment cleanup.
- [x] Remove the rejected standalone N-API actor prototype; do not ship two
  lifecycle state machines.

TypeScript integration:

- [x] Root Node/Bun/Deno/Electron exports use the actor class while preserving the
  Promise-shaped database API.
- [x] Add `/direct` as the explicit synchronous-placement import and wire it to
  the direct class.
- [x] Restore/adapt the real Node/Bun/Deno/Electron Worker implementation and load the
  direct class inside it.
- [x] Remove `node-child.ts`, child ports/options, liveness watchdogs,
  `child_process` permissions, fixtures, tests, and documentation after the
  Worker replacement is proven.
- [x] Keep the existing logical-operation scheduler and transaction ownership;
  do not replace `#tail` as part of placement migration.
- [x] Keep browser root and Worker module graphs byte-for-byte behaviorally on
  Wasmer-JS and prove that they cannot resolve a native carrier.
- [x] Add root/direct/Worker parity tests covering query, raw protocol,
  streaming callback failure, transaction, backup/restore, storage errors,
  close, and async disposal.

Server surface:

- [x] Replace `/server/{node,bun,deno}` with one conditional `/server` export.
- [x] Consolidate `ServerListen`, `ServerOpenConfig`, and `OliphauntServer` in
  one TS module.
- [x] Adapt the existing Rust `AsyncOliphauntServer` owner and its exact
  open/close memoization for Node-API lifecycle. Do not create a database-actor
  command or a second N-API/server owner state machine for this cold path.
- [x] Run N-API server open/close lifecycle off the importing event loop while
  Rust continues to own all socket traffic.
- [x] Remove duplicated JavaScript socket/filesystem policy and TOCTOU checks;
  snapshot/resolve options in TS and let Rust atomically create and own the
  listener path.
- [x] Correct manifest/docs ownership from child process to Rust owner/native
  listener.
- [x] Test TCP automatic/fixed port, Unix ownership-safe cleanup, close during
  an active client, recoverable SQL error, reconnect, exact public shape, and
  browser export exclusion.

Phase 1 acceptance:

- [x] No Node/Bun/Deno/Electron root or `/worker` import loads Wasmer-JS.
- [x] No normal host-runtime path spawns a child process.
- [x] Root heartbeat remains responsive during a long query; `/direct` blocks;
  `/worker` remains responsive.
- [x] Add a reproducible direct-versus-actor-versus-Worker harness which reports
  tiny-operation overhead, p50/p95/p99, event-loop delay, throughput, copies,
  fan-out, and overload/RSS instead of assuming the result.
- [x] Repeated close/finalization and environment exit produce no hang, abort,
  use-after-free, or late Node-API call.
- [x] Pin the addon image before a direct-only Worker can initialize the
  process-wide WASIX runtime, and exercise a fresh process whose parent never
  loads the addon while repeated direct Workers open, query, close, and
  self-exit.
- [x] Prove raw direct streaming callback reentry is rejected by napi-rs's
  generated native borrow guard and leaves the database reusable.

### Phase 2 — safe Worker shutdown

- [x] Make Worker close stop admission, settle the active operation and queue,
  quiesce stream callbacks, close/release the direct native handle, acknowledge
  the complete shutdown state, and self-exit.
- [x] Ensure every error and finalization path tracks that full shutdown state.
  Treat an observed clean self-exit as final without a redundant terminate;
  reserve forced termination for startup/fatal cleanup before self-exit and
  never use an idle native frame alone as proof that active termination is safe.
- [x] Add regressions for close during a long query, idle termination,
  environment teardown during open/query/stream/close, and the reproduced
  active-termination process abort.
- [x] Document that a hung guest can leave close pending and that `/worker` is
  scheduling/realm isolation, not process containment.

### Phase 3 — packaging optimization before first release

- [x] Refactor standard/ICU seed selection from compile-time global selection
  to an immutable per-builder/database profile so one addon binary per target
  supports both without changing default catalog or storage behavior.
- [x] Thread that profile through manifest identity, seed selection, runtime
  materialization, ICU-data installation, database and server builders, and
  compatibility checks. Key every reusable seed/runtime/materialization cache
  by profile rather than sharing singleton `OnceLock` state.
- [x] Test standard and ICU databases/servers in both construction orders and
  concurrently in one process; prove their receipts, directories, manifests,
  and extension catalogs cannot contaminate each other.
- [x] Keep the first release's qualified extension/tool catalog frozen inside
  that addon. Preserve descriptor identity checks; do not introduce dynamic
  native extension loading in this migration.
- [x] Update the private build package, carrier manifests, loader identities,
  artifact provenance, notices/licenses, checksum aggregation, and publication
  catalog together.
- [x] Preserve the exact four-target release matrix and existing Linux ABI
  policy.
- [x] Verify clean install, optional-dependency pruning, unsupported target,
  missing carrier, wrong ABI/version/runtime identity, pnpm/npm, and archive
  contents without network-time install hooks.
- [x] Wire packaged Node, Bun, Deno, and Electron smoke tests into every matching
  carrier job; document and test Deno permissions and the Electron ASAR-unpacked
  layout, including its missing-companion failure.
- [ ] Observe those packaged smokes on all four physical hosted carrier jobs for
  the exact candidate commit.

### Phase 4 — documentation, cleanup, and release qualification

- [x] Update `README.md`, `ARCHITECTURE.md`, API reference, SDK parity/product
  policies, package surface inventory, examples, and migration notes.
- [x] Describe root as actor-backed, `/direct` as blocking, `/worker` as a real
  Worker, and `/server` as a Rust listener. Never call realm isolation crash
  containment.
- [x] Remove stale child-process, Wasmer-on-server, external-zero-copy output,
  duplicate-addon, and runtime-named server-subpath claims.
- [x] Remove dead modules only after `rg`, TypeScript build output, packed
  package inspection, browser bundle inspection, and Moon graph checks prove
  they are unreachable.
- [x] Update focused CI first; add the full carrier/runtime matrix only with the
  packaging PR. Avoid duplicating Moon-owned checks in workflows.
- [x] Run `moon run oliphaunt-wasix-napi:check`,
  `moon run oliphaunt-wasix-napi:package`,
  `moon run oliphaunt-wasix-rust:check`,
  `moon run oliphaunt-wasix-ts:test`,
  `moon run oliphaunt-wasix-ts:typecheck`, and the product package checks.
- [x] Run `moon run sdk-contracts:check` for public-surface changes.
- [x] Run workflow-policy, release-check, committed-asset, extension-model,
  WASIX source/patch, portable/AOT, carrier, license, provenance, and Linux ABI
  checks selected by the repository qualification graph.
- [ ] Before merge/release, prove the exact commit with the repository
  `Qualified` gate and all required WASIX lifecycle evidence.

## Performance proof

Maintain a reproducible benchmark rather than a single favorable number.
Measure direct versus actor versus Worker using:

- dispatch-only/no-op and raw `SELECT 1` latency at p50, p95, and p99;
- structured query/decoding, batched statements, 1 KiB/1 MiB/64 MiB raw input
  and output, streaming, and backup;
- 1, 4, and 16 active databases plus idle-database RSS;
- event-loop delay, CPU, allocations, resident memory, and bytes copied; and
- Node, Bun, Deno, and Electron on supported operating systems;
- an overload/RSS test with large concurrently submitted raw inputs, recording
  JavaScript queued bytes separately from the bounded native owner queue.

The actor is accepted when it keeps the caller responsive and its integrated
overhead is small relative to real query work. `/direct` remains the explicit
latency floor. Optimize only profiles that move end-to-end p95/p99 or material
throughput; do not add public knobs to improve a microbenchmark.

## Explicitly deferred

These items are not prerequisites for the Node-API migration:

- public queue limits, scheduler selection, or per-query `AbortSignal`;
- public query cancellation, its lower PostgreSQL/Wasmer wake path, and any
  cross-Worker cancellation registry;
- a persistent or process-wide completion dispatcher until `JsDeferred`
  allocation is proven material;
- hard process containment or an automatic-restart/replay product;
- browser server stubs or polyfills;
- general multi-client/postmaster server behavior, TLS/GSS, remote bind, or UDP;
- a broad ORM-specific adapter matrix beyond one representative packaged
  driver smoke;
- PostgreSQL wire `CancelRequest` and a concurrent server accept coordinator;
  when undertaken, they reuse the lower cancellation handle and do not add
  `server.cancel()`;
- extracting the duplicate JavaScript query codec into a new shared package;
- independently loaded native extension carriers or a user-visible native
  profile package split;
- new native carrier targets or a new glibc policy; and
- unrelated storage, extension-catalog, SDK, or release-system redesigns.

Any deferred item needs its own evidence, design review, and bounded PR. It
must not be smuggled into a checklist checkbox for this migration.

## Definition of done

The migration is complete only when the root actor, direct, Worker, and server
surfaces are packaged; browser behavior is unchanged; public bytes are safe and
transferable; active Worker shutdown cannot abort the process; all dead
child/old host-runtime Wasmer paths are removed; the four carriers pass their
runtime matrices; docs match the shipped surface; and the exact release commit
is `Qualified`.
