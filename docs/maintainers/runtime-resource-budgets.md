# Runtime resource budgets

Status: implementation reference. Last verified: 2026-09-08. Owner: runtime maintainers.

Equal byte counts do not imply equal purposes. A stack allocation, an I/O batch,
a queue watermark, and a protocol rejection limit must have separate owners.
The constants below describe existing behavior; this inventory does not change
sizes or establish that they are optimal. MiB and KiB mean powers of 1024.

## Protocol and streaming

Paths in this table are relative to the repository root. Rust paths abbreviated
as `wasix-rust/...` are under `src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/`.
TypeScript paths abbreviated as `wasix-ts/...` are under `src/bindings/wasix-ts/src/`.

| Owner | Size | Meaning and allocation behavior |
| --- | --- | --- |
| `src/shared/postgres-protocol-transport-contract/contract.json`, `bufferedOutput.limitBytes` | 64 MiB | Inclusive hard cap on WASIX buffered output, including hybrid output before COPY switches to streaming. Not a reservation. Overflow is terminal: no buffered prefix is published and the session must be reopened. |
| Same contract, `streamedOutput.callbackChunkMaxBytes`; generated Rust `protocol_limits_generated.rs::PROTOCOL_CALLBACK_CHUNK_BYTES`; TS `database.ts::WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES` | 64 KiB | Maximum bytes per host callback, not per result or COPY operation. Rust lends a slice for the synchronous call; JavaScript delivers an owned copy. |
| `wasix-rust/proxy.rs::PROXY_READ_BUFFER_BYTES` | 64 KiB | Local stack scratch space per socket-serving call. A PostgreSQL message can span many reads. |
| `wasix-rust/client.rs::DIRECT_TOOL_READ_BUFFER_BYTES` | 64 KiB | Separate local stack scratch space for the direct-tool socket. It is not owned by the callback ABI merely because its size matches. |
| Rust `wire.rs::MAX_FRONTEND_MESSAGE`; TS `pgwire-connection.ts::MAX_FRONTEND_MESSAGE_BYTES` | 128 MiB | Maximum total length of one frontend frame, including header. Readers validate the declared length; they do not allocate the maximum for every query. Not a total multi-frame COPY limit. |
| `wasix-ts/byte-channel.ts::WASIX_CHANNEL_BYTES` | 256 KiB + 1 byte | Fixed shared-memory ring allocation per channel, plus a separate five-word control block. One sentinel byte leaves 256 KiB usable. Full channels apply backpressure. |
| Same file, `WASIX_BYTE_CHANNEL_CHUNK_BYTES` | 64 KiB | Default read batch from the ring, independent of its capacity and of callback ownership. |
| `src/runtimes/liboliphaunt/native/src/liboliphaunt_protocol.c::DEFAULT_STREAM_QUEUE_MAX_BYTES` | 4 MiB | Native stream queue backpressure watermark, not eager allocation or a strict cap: one larger chunk may enter an empty queue to permit progress. Allocations follow queued bytes. |
| Same file, `INITIAL_BUFFERED_OUTPUT_BYTES` | 8 KiB | First native buffered-output allocation, grown geometrically as needed. The WASIX 64 MiB cap does **not** apply to this native buffer. |
| `src/runtimes/liboliphaunt/native/src/liboliphaunt_archive_tar.c::ARCHIVE_FILE_READ_CHUNK_BYTES` | 64 KiB | Stack scratch space for reading backup files. The returned archive is still accumulated in a growing buffer; this does not make the complete backup constant-memory. |

The protocol contract is the shared numeric/ABI authority. Use its existing
generator and compiled transport tests for a contract change; do not create a
second configuration file or import repository JSON at package runtime. Local
read buffers stay owned by their readers. The matching Rust/TS frontend limit
is a host admission policy, not PostgreSQL's universal maximum field size.

COPY and streamed responses can exceed an individual chunk or queue size.
Streaming avoids retaining the complete transport output, but an SDK method
that collects decoded rows can still retain the full application result. An
error after streaming a prefix cannot retract bytes already delivered.

Other similarly sized values have different owners: TS
`storage/opfs-provider.ts::DIRECT_BRIDGE_CAPACITY` supplies 1 MiB to the direct
filesystem bridge, not the PostgreSQL transport. TS
`direct-client-common.ts::CHROMIUM_SYNC_WASM_LIMIT_BYTES` is an 8 MiB module-size
admission threshold for synchronous extension loading in a Chromium Window;
larger modules require the worker placement, not a larger query buffer. Native
startup's `wal_buffers=4MB` configures PostgreSQL WAL buffering and is unrelated
to the 4 MiB stream queue. SQL working memory and shared buffers are separate
PostgreSQL configuration, not transport tunables.

## Stacks are a different resource

| Owner | Existing setting | Meaning |
| --- | --- | --- |
| Native `liboliphaunt_runtime.c::DEFAULT_BACKEND_STACK_BYTES` | 8 MiB | Native PostgreSQL backend thread stack; `OLIPHAUNT_STACK_BYTES` is its existing override. It does not configure WASIX. |
| `src/runtimes/liboliphaunt/wasix/assets/build/profile_flags.sh::OLIPHAUNT_WASM_GUEST_STACK_SIZE` | `8MB` | Guest C/shadow stack within Wasm linear memory. Shared by backend and initdb links, not an environment override. This is not the native machine-code call stack used by an AOT engine. |
| Same file, `OLIPHAUNT_WASM_INITIAL_MEMORY_SIZE` | `128MB` | Initial guest linear-memory size, containing the C stack and heap; not all query memory is eagerly touched. Larger values increase the instance memory floor, not necessarily throughput. |
| Wasmer execution stack | Separate engine-owned allocation | AOT/native call frames use this stack. PostgreSQL's shadow-stack depth check alone cannot establish that enough native stack remains. |
| PostgreSQL `max_stack_depth` | SQL-configurable guard | Recursion safety threshold, not an allocation and not a transport budget. Raising it does not allocate either stack. |

The retained JSON reproduction exposed the distinction: Wasmer's 1 MiB
execution stack exhausted before PostgreSQL's guest shadow-stack guard could
recover safely. An 8 MiB execution-stack diagnostic passed the 100 kB SQL guard
case, but that is not proof for the ordinary 2 MiB guard or arbitrary queries.
It is **not** a selected production fix. A robust solution needs a trustworthy
remaining-native-stack check or another proven bound. Sampling a local address
inside a host import is insufficient: that import runs on the parent stack,
not the guest's execution stack. No new stack environment flag is introduced
by this inventory.

### Required stack-safety integration

The intended fix adds a second guard; it does not replace PostgreSQL's existing
linear-stack check or convert an engine overflow into a recoverable SQL error:

1. The engine measures remaining native guest-stack capacity **before** moving
   a callback onto the host stack. Exclude guard pages and exception reserves;
   cap accounting to the configured budget even when a larger pooled stack is
   reused. Nested calls, normal return, traps, and panics must restore the
   previous measurement context.
2. A small host import exposes that measurement to the guest. PostgreSQL's
   `stack_is_too_deep()` checks both its current C-stack depth and the native
   recovery reserve. The host returns normally; PostgreSQL raises SQLSTATE
   `54001` inside its live guest exception boundary.
3. Reserve enough space for the import boundary, work between checks, error
   reporting, and nested error cleanup. PostgreSQL's existing 512 KiB platform
   stack slop is a reference, **not** proof that the same reserve is sufficient
   for AOT frames. Select the engine capacity per engine, not by changing
   Wasmer's process-global default from an SDK.
4. An unavailable measurement must not silently mean unlimited space on a
   runtime claiming this guard. Browser engines need a separately supported
   contract; a Node/V8 stack setting is not a Wasmer setting. Code that bypasses
   PostgreSQL's checks can still hit a terminal engine trap, which must close
   the affected session rather than masquerade as success.

Status: an isolated Wasmer 7.2.1 headroom API prototype passes its 60 VM tests in
debug and optimized builds. It is **not consumed by this repository**. The
PostgreSQL import, reserve selection, supported engine dependency, and
cross-platform qualification remain outstanding. No production guard or
larger execution stack is claimed by the constants cleanup.

Admission checks must include low (100 kB) and default (2 MiB) SQL limits,
repeated errors followed by valid queries, nested PL/pgSQL/savepoint cleanup,
memory and directory storage, direct and TCP paths, and COPY/disconnect/reconnect.
Check small-query overhead as well as deep-query correctness: a host import at
every recursion checkpoint is not free. Keep actual engine-overflow tests in
isolated processes and require bounded connection teardown rather than hanging.

The backend/initdb link sizes are included in the build-profile signature so
an incremental producer cannot silently reuse the old memory layout after a
constant changes. Changing them requires regenerated guest/AOT artifacts, not
a consumer runtime flag. The protocol generator likewise emits C, JavaScript,
and packaged Rust bounds from one JSON owner; generated-view checks detect drift.

Postmaster has a separate carrier stack setting (currently a 32 MiB default in
its runner scripts). That is neither an embedded SDK default nor evidence that
the embedded recovery issue is fixed. Keep carrier and embedded validation
separate.

## Diagnostic retention

Rust `postgres_mod.rs::DIAGNOSTIC_TAIL_BYTES` retains the latest 8 KiB from each
startup/tool stdout and stderr stream. `STARTUP_OUTCOME_MAX_PROTOCOL_BYTES`
allows up to 1 MiB of startup-error protocol payload and must match the guest
startup descriptor ABI in `oliphaunt_wasix_bridge.c`. These are diagnostic bounds,
not SQL result caps. Raising them retains/copies more diagnostic data; it cannot
speed up successful queries or repair error recovery.

## Small queries, large results, and tuning

- Small queries do not wait to fill a read batch or queue. They do pay for any
  eagerly allocated scratch/ring space and for each boundary crossing. Larger
  buffers do not inherently improve their latency.
- Large operations may benefit from larger batches through fewer reads,
  callbacks, or wakeups. Costs include larger scratch allocations, retained
  capacity, longer producer bursts, and more queued data for slow consumers.
- Native `OLIPHAUNT_STREAM_QUEUE_MAX_BYTES` is an existing per-stream override
  read when streaming starts. Lowering it increases backpressure; raising it
  allows more data to accumulate. It is not a durability or query-size switch.
- Other transport sizes above are compile-time contract or implementation
  choices, not consumer environment knobs. Change an ABI bound coherently across
  guest and hosts; change an I/O batch only at its owner. Do not unify unrelated
  constants just because both happen to be 64 KiB.
- Re-evaluate sizes using both query RTT and large/fragmented COPY/results,
  including a slow consumer and cancellation/error recovery. Measure peak and
  retained memory as well as throughput. A larger stack must also prove normal
  SQL errors recover rather than merely moving the crash threshold.

These budgets apply independently of memory-backed versus directory-backed
PGDATA. They do not relax WAL synchronization, filesystem durability, or Wasm
memory-access/trap semantics.
