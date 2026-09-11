# WASIX TypeScript Node-API architecture

The execution architecture below also reflects explicit resource packages.
Standard seeds remain bundled; the optional-standard-seed rollout is deferred.

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
import { directory } from '@oliphaunt/wasix-ts';
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

The release topology is one addon binary per target, containing the runtime,
standard seed, and supported contrib. External extensions, ICU data and matching
seeds, and frontend tools are separate packages. TypeScript resolves installed
descriptors and passes their payloads to Rust; Rust validates owner, version,
target, runtime identity, and hashes before loading. Profile and extension
selection remain immutable per database, and reusable caches include the
selected resource identities.

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
   cross-runtime smoke tests, release policy, licenses, and provenance. Keep
   external extensions, ICU resources, and tools in their separate packages.

Public cancellation, wire `CancelRequest`, a multi-client server, and new
carrier targets remain separate proposals. Feature PRs do not edit versions or
changelogs; release automation owns those changes.

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
