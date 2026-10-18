# Runtime resource budgets

Equal byte counts do not imply equal purposes. A stack allocation, an I/O batch,
a queue watermark, and a protocol rejection limit must have separate owners.
This guide describes the owning constants and their trade-offs, not optimal
values for every workload. MiB and KiB mean powers of 1024.

The [resource configuration proposal](../architecture/resource-policy.md)
defines units, scopes, admission lifetime and validation. Its status separates
implemented controls from the remaining proposed APIs. The public
[performance guide](../content/reference/performance.mdx) explains the controls
and tradeoffs available to developers today.

## Read this first: what a size means

- **A batch is a delivery box.** A 64 KiB batch moves up to that much at a time.
  A 1 GiB result can use many boxes. A small result does not wait for a full box.
  Bigger boxes may mean fewer trips, but require more space for each trip.
- **A queue is a waiting room.** It holds work or bytes until the next part can
  accept them. More waiting space can absorb a burst; it does not make the
  database execute a query faster. It can increase memory use and waiting time.
- **A cache keeps things for reuse.** More space can avoid repeated reads or
  setup. It helps only when useful things would otherwise be thrown away.
- **A limit is a stop sign.** It rejects an oversized item. Raising a limit
  permits larger items; it does not make already-accepted items faster.
- **A stack is the program's working trail.** Nested function calls need more
  trail space. More space can allow deeper calls, not faster ordinary queries.
  A safe depth check must stop the program before that space runs out.
- **An initial allocation is a starting container.** It may grow later.
  Starting larger can avoid growth/copying, but wastes more space on small work.

These are explanations of the mechanisms, not measured speedup claims.

## Scope and ownership

This guide covers first-party runtime, SDK, transport and build resource limits.
It does not duplicate dependency internals or describe test workloads, ports
and binary field offsets as tuning choices. Lifecycle deadlines are separate
from SQL statement deadlines and buffer capacities.

Central documentation does not mean one global constant: equal numbers with
different purposes stay separately owned. The shared protocol contract generates
the embedded bridge C and SDK Rust/TS values. Browser-host patch literals are
still separately pinned and checked by `src/wasix/browser-host/build-sdk.sh`.
SQL startup defaults and broker-frame limits also still have multiple language owners.
Change and check every consumer together until those contracts are unified.

## Is this PostgreSQL, our choice, or a platform rule?

There are two questions: **who provides the mechanism**, and **who chooses its
size**. A standard PostgreSQL setting can still have an Oliphaunt-selected value.
"Our choice" also does not mean "proven optimization": some choices are safety
limits, some are compatibility requirements, and some are tuning candidates.

| Inventory family | Origin and purpose | Ordinary PostgreSQL equivalent? |
| --- | --- | --- |
| `shared_buffers`, `wal_buffers`, `min_wal_size` | **PostgreSQL mechanisms; Oliphaunt startup policy.** We explicitly choose 128/4/80 MiB. | Yes, the same SQL settings. Matching a normal value is not a custom optimization. |
| `work_mem`, hash multiplier, maintenance/temp memory, `max_wal_size`, `max_stack_depth` | **PostgreSQL mechanisms/defaults**, unless a caller overrides them. | Yes. Memory for sorting, caching, logging and recursion checking exists in a normal server too. |
| PostgreSQL's own 8 KiB receive/send buffers | **PostgreSQL implementation choices.** Separate from our bridge buffers even when equal. | Yes, `src/backend/libpq/pqcomm.c`; send storage can grow. |
| Our 64 KiB batches, 4 MiB stream queue cap, 256 KiB channels, initial growing containers and compaction thresholds | **Oliphaunt transport/allocation tuning.** Trade calls/copies against memory and waiting. | A server also buffers I/O, but does not have these SDK bridge constants. Their exact values need workload evidence. |
| 64/256 work admission counts | **Oliphaunt overload control.** Bounds waiting work, not backend parallelism. | Client pools/server connection admission are analogous, but not the same queues or units. |
| 16 parallel OPFS file operations, one cached runtime | **Oliphaunt browser/startup tuning.** Reuse and batching can reduce setup work. | No OPFS or compiled-Wasm module cache in a normal native server. |
| 128 MiB frontend/broker limits | **Oliphaunt safety/API policy.** Rejects oversized retained data on these paths. SQL results and collected tool output have no separate 64 MiB quota. | PostgreSQL has its own message/allocation rules; this cap is ours, not a SQL limit to attribute to PostgreSQL. |
| Diagnostic tails, startup/error text and archive/metadata ceilings | **Oliphaunt diagnostics/input protection.** | Similar needs exist elsewhere; our exact limits are not PostgreSQL query-performance settings. |
| Native backend 8 MiB thread stack, guest 8 MiB C stack, initial 128 MiB linear memory, Postmaster profile sizes | **Embedding/platform capacity choices.** Required resources with chosen budgets, not automatic speedups. | Native PostgreSQL also needs stack/heap space, but not these Wasm allocations or SDK thread defaults. |
| Wasmer execution stack and reserved-address layout | **Engine-owned mechanism**, with engine/product policy deciding capacity. | An ordinary native server uses its process/OS stack; it has no Wasmer coroutine stack. |
| Wasm page, TAR/wire headers, identifier/digest lengths, platform alignment | **Format/platform rules**, not free tuning knobs. | PostgreSQL-specific formats are shared; Wasm/TAR/Android rules belong to those respective formats/platforms. |
| Hash/copy batches and release/source/package-tool envelopes | **Build/install choices**, outside normal SQL execution. | Not PostgreSQL query settings. |

The transport/storage tuning rows are the optimization-*motivated* choices.
This inventory does not establish that 64 KiB or any other exact
selection is the optimum. Safety rows must earn their place through correct
limits and failure handling, not by producing a faster benchmark.

## Protocol and streaming

Paths in this table are relative to the repository root. Rust paths abbreviated
as `wasix-rust/...` are under `src/wasix/sdks/rust/src/oliphaunt/`.
TypeScript paths abbreviated as `wasix-ts/...` are under `src/wasix/sdks/ts/src/`.

| Owner | Size | Meaning and allocation behavior |
| --- | --- | --- |
| `src/wasix/runtime/protocol-contract/contract.json`, `bufferedOutput.limitBytes` | 2 GiB minus 1 byte | Maximum length representable by the signed-i32 host bridge, not an application quota or reservation. Grows on demand; available memory may run out earlier. Allocation/overflow failures retire the session without publishing an incomplete buffered response. |
| Same contract, `streamedOutput.callbackChunkMaxBytes`; generated Rust `protocol_limits_generated.rs::PROTOCOL_CALLBACK_CHUNK_BYTES`; TS `core/database.ts::WASIX_PROTOCOL_CALLBACK_CHUNK_BYTES` | 64 KiB | Maximum bytes per host callback, not per result or COPY operation. Rust lends a slice for the synchronous call; JavaScript delivers an owned copy. |
| `src/wasix/pgwire-server/src/proxy.rs::PROXY_READ_BUFFER_BYTES` | 64 KiB | Local stack scratch space per socket-serving call. A PostgreSQL message can span many reads. |
| `wasix-rust/client.rs::DIRECT_TOOL_READ_BUFFER_BYTES` | 64 KiB | Separate local stack scratch space for the direct-tool socket. It is not owned by the callback ABI merely because its size matches. |
| `src/query/rust/src/wire.rs::MAX_FRONTEND_MESSAGE`; TS `protocol/pgwire-connection.ts::MAX_FRONTEND_MESSAGE_BYTES` | 128 MiB | Maximum total length of one frontend frame, including header. Readers validate the declared length; they do not allocate the maximum for every query. Not a total multi-frame COPY limit. |
| `wasix-ts/protocol/byte-channel.ts::WASIX_CHANNEL_BYTES` | 256 KiB + 1 byte | Fixed shared-memory ring allocation per channel, plus a separate six-word control block. One sentinel byte leaves 256 KiB usable. Full channels apply backpressure. |
| Same file, `WASIX_BYTE_CHANNEL_CHUNK_BYTES` | 64 KiB | Default read batch from the ring, independent of its capacity and of callback ownership. |
| `src/native/runtime/src/liboliphaunt_protocol.c::DEFAULT_STREAM_QUEUE_MAX_BYTES` | 4 MiB | Native stream queue byte cap, not eager allocation. Larger writes are split into queue-sized chunks and wait for the consumer to free space. Allocations follow queued bytes. |
| Same file, `INITIAL_BUFFERED_OUTPUT_BYTES` | 8 KiB | First native buffered-output allocation, grown geometrically as needed. Native lengths are host-sized, unlike the WASIX signed-i32 bridge. |
| `src/native/runtime/src/liboliphaunt_archive_tar.c::ARCHIVE_FILE_READ_CHUNK_BYTES` | 64 KiB | Stack scratch space for reading backup files. The buffered backup API accumulates the archive; the streaming API sends it to a callback without retaining the complete archive. |

The protocol contract supplies shared numeric constants. Signatures live in
C declarations and typed host bindings. Use the existing
generator and compiled transport tests for a contract change; do not create a
second configuration file or import repository JSON at package runtime. Local
read buffers stay owned by their readers. The matching Rust/TS frontend limit
is a host admission policy, not PostgreSQL's universal maximum field size.

COPY and streamed responses can exceed an individual chunk or queue size.
Streaming avoids retaining the complete transport output, but an SDK method
that collects decoded rows can still retain the full application result. An
error after streaming a prefix cannot retract bytes already delivered.

Other similarly sized values have different owners. The optional browser-host
synchronous filesystem bridge is separate from PostgreSQL transport and the
portable OPFS copy-on-write snapshot provider; direct workers use that bridge. TS
`direct-client-common.ts::CHROMIUM_SYNC_WASM_LIMIT_BYTES` is an 8 MiB module-size
admission threshold for synchronous extension loading in a Chromium Window;
larger modules require the worker placement, not a larger query buffer. Native
startup's `wal_buffers=4MB` configures PostgreSQL WAL buffering and is unrelated
to the 4 MiB stream queue. SQL working memory and shared buffers are separate
PostgreSQL configuration, not transport tunables.

### Additional transport and allocation sizes

| Owner (repository-relative) | Selection | In simple words; effect |
| --- | --- | --- |
| `src/wasix/runtime/assets/build/wasix_shim/oliphaunt_wasix_bridge.c`, input reserve and output append | 8 KiB initially, doubles | Starting containers for guest input/output. Ordinary SQL results grow automatically. Output reset retains capacity for reuse, trading memory after a large response for fewer later allocations; streaming avoids retaining the complete response. |
| `src/native/sdks/rust/src/pgwire.rs` | 64 KiB read buffer; 8 KiB initial response vector | Socket delivery box and growing result container, respectively. Neither limits the total result to that size. |
| `src/native/broker/src/ipc.rs` and `src/native/sdks/ts/src/runtime/broker-frames.ts` | 128 MiB frame limit | Rejects a single oversized broker management message; independent of the similarly sized PostgreSQL frontend-frame limit. |
| Native TS `runtime/broker.ts::execProtocolRaw`; `runtime/pgwire.ts` | 128 MiB collected response; 128 MiB backend length field and complete request | Three separate acceptance policies. Streaming avoids the aggregate collector, but its reader still rejects one oversized backend message. The length-field check excludes the message type byte. None is owned by the admission watermark. |
| `wasix-rust/tools.rs::DIRECT_TOOL_SOCKET_BUFFER` | 256 KiB | Waiting space in the in-process tool socket. Larger capacity can absorb bursts, not speed up SQL itself. |
| Guest direct tool socket reads (`protocol-contract/contract.json`) | 64 KiB maximum read batch | Keeps libpq's large receive-buffer requests below Wasmer's per-read capability. This is separate from the size of one PostgreSQL value and total tool output. Ordinary tool responses stream from the backend before COPY starts. |
| Rust native/WASIX tools and JS tool collectors | Complete output in memory; no application byte quota | Available memory and host Vec/Buffer/string-size limits apply. Fallible capture failures discard partial stdout and stderr. Native pipes continue draining. Rust collectors grow amortized and release buffers on failure. |
| Native/WASIX Rust tool destinations; native npm tool destinations | Up to 64 KiB per stdout write; 8 KiB diagnostic tail | Writes apply destination backpressure and retain no complete stdout. Complete diagnostics can go to a separate writer/stream; summaries mark discarded diagnostics. Buffered script input and PostgreSQL's own per-value memory remain separate costs. |
| WASIX JavaScript host file destinations | Same Rust writer batches and diagnostic tail | Node-API root/direct/worker paths use the Rust file runner without a complete JavaScript stdout buffer. |
| WASIX JavaScript async destinations | 64 KiB owned chunks; 8 KiB diagnostic tail; browser channels 256 KiB each | Native actor and Node worker release one pending chunk per stream after awaited acceptance. Browser Worker tools use independent protocol/output rings and mode4 backend streaming; all ring allocations enter admission accounting. Direct/root browser async capability fails before execution. Convenience output and script input still collect. |
| Desktop broker physical backup (`src/native/broker/src/ipc.rs`; native TS `broker-frames.ts`) | 64 KiB maximum backup chunk | Streams archives through management code7/kind103 frames. A destination write failure drains the terminal response and preserves the session; buffered convenience methods still collect the full archive. The 128 MiB ordinary management-frame cap is separate from archive size. |
| Native TypeScript `backupToFile()` (direct and broker) | Bounded archive chunks; no JavaScript archive collector | Uses synchronous file writes within the native callback, including Deno's borrowed FFI callback. Slow storage can block the JavaScript thread during a write. Same-directory private staging is published without overwriting the destination after backup and file close; completion does not promise power-loss durability. |
| `src/native/postgres-tools/crates/tools/src/lib.rs`, captured pipe reader | 32 KiB | Tool-output read batch; total capture is governed by the separate contract above. |
| Native `liboliphaunt_archive_tar.c::buffer_reserve` | 4 KiB initially, doubles | Backup archive starting container. The full archive still grows in memory; larger initial capacity does not solve large-backup memory use. |
| `wasix-ts/protocol/pgwire-connection.ts`, chunk-list compaction | More than 256 consumed chunks and at least half the list consumed | Removes old list entries in batches. More frequent removal frees references sooner but spends more time moving list entries. Not a byte limit. |
| `src/native/broker/src/mobile.rs::CHUNK_BYTES`, `INPUT_BYTES` | 256 KiB data records; 128 MiB complete frontend input | Separate mobile bulk transport. Results and archives use many data records; the complete ordinary query input has its own hard ceiling. Smaller delivery chunks can preserve this record maximum. Changing the record ceiling requires coherent producer/consumer validation. |
| `wasix-rust/postgres_mod/stdio.rs`, `sync_host_fs.rs`, tool fallback and browser stderr patch | 8 KiB write-readiness report | Says a file/stream is writable with this advertised amount; does not allocate an 8 KiB buffer or guarantee a complete write. |
| Guest `oliphaunt_wasix_bridge.c`, emulated `SO_SNDBUF`/`SO_RCVBUF` | 32 KiB | Socket-option compatibility answers, not real kernel socket allocations. Do not tune these as if they were queue capacities. |
| `src/wasix/browser-host/adapter/streams.rs` | 256-byte stream watermark; 10,000,000-byte scratch ceiling; 128-byte fallback | Generic host stdio policy. The queuing strategy measures chunk bytes; the scratch request follows the controller's desired size. These are separate from the bounded protocol/tool rings and do not define a whole-output memory limit. |

### Browser storage and counted resources

| Owner | Selection | In simple words; effect |
| --- | --- | --- |
| `wasix-ts/storage/types.ts::DEFAULT_OPFS_MAX_CONCURRENT_IO` | 16 operations; `opfs(name, { maxConcurrentIO })` | Limits parallel setup, snapshot reads and cleanup. Increasing helper concurrency does not parallelize SQL or bound staging or portable snapshot memory. |
| `wasix-ts/storage/types.ts::DEFAULT_OPFS_SPARE_FILE_COUNT` | 32 unused worker handles; `opfs(name, { spareFileCount })` | More handles cost startup and browser resources but reduce overflow staging. Zero is allowed; this is not a file-count cap. |
| `wasix-ts/hosts/browser/direct-client-common.ts::MAX_PREPARED_RUNTIMES` | 1 cached runtime identity | Avoids repeating preparation for the same assets. More entries help switching between runtime versions but retain more assets; eviction does not close live databases. |
| `src/wasix/sdks/rust/src/async_api.rs::OWNER_QUEUE_CAPACITY`, `OWNER_QUEUE_BYTES` | 64 ordinary queued slots; 128 MiB input allowance | FIFO admission precedes raw/SQL construction. Count permits release on dequeue; byte permits remain through the owner action. Oversized inputs acquire the complete byte budget; zero-byte operations do not acquire byte permits. Caller-owned input and output collectors remain outside a total memory bound. Controls bypass ordinary admission. |
| `src/native/sdks/rust/src/executor.rs::ORDINARY_QUEUE_CAPACITY`, `ORDINARY_QUEUE_BYTES` | 256 ordinary queued commands; 128 MiB queued input | Raw copies and structured encoding occur after FIFO admission. Admission checks a conservative encoding allowance, then counts actual queued request capacity. Both budgets release on dequeue. An oversized input may enter an empty ordinary queue; later zero-byte commands can still fit. Executing/caller-owned inputs remain outside this bound. Recovery controls bypass these slots. |
| `src/query/ts/src/operation-budget.ts`; native Kotlin admission | 64 ordinary pending operations; 128 MiB retained allowances | Count and bytes include active work through ordered completion. Admission precedes protected copies/encoding; JS expiry alone does not release a still-queued closure. Browser tools also charge fixed channel allocations. Controls bypass ordinary limits. Results, PostgreSQL memory and caller-owned inputs are excluded. |
| Swift `OliphauntAsyncSerialGate`; `OliphauntQuery.swift` | 64 ordinary pending operations; 128 MiB encoded request bytes | Omitted policy preserves encoded-request accounting. Explicit admission reserves a checked packet allowance before encoding. The same gate covers transaction operations. Active release or removal of an expired waiter releases its reservation. Controls enter the serial gate without ordinary charges. |

The table records omitted-policy behavior. Explicit `admission` supplies both
`maxPendingOperations` and `highWaterMarkBytes`: preparation, queued and executing
work stays charged through completion, an oversized operation runs alone, and
following zero-input work cannot bypass it. JS shares normalization/accounting
in the query package; Rust shares the public limits type in its query package.
Rust owners retain their existing fair waiting and mobile/JS owners their
rejection behavior. Boundary and recovery tests cover these changes. A transaction
lease is separate from an operation reservation, so child queries must not
inherit an occupied parent slot for the entire callback.

Optional WASIX JavaScript tools share the query admission budget through complete
execution and cleanup. Strings reserve a conservative UTF-8 allowance before
encoding (three bytes per UTF-16 unit); binary stdin is counted before copying.
Browser tool protocol channels are counted before allocation. Native tools retain
script text directly instead of encoding it and decoding it again.

### PostgreSQL's own memory and disk choices

Embedded defaults are set in native `liboliphaunt_runtime.c`, Rust
`postgres_mod.rs::DEFAULT_STARTUP_GUCS`, and TS `wasix-runtime.ts`. These are
startup settings, unlike compile-time transport constants. Caller settings can
override the applicable defaults; inspect the running database rather than
assuming a seed or caller has not changed them.

| Setting | Oliphaunt embedded selection | PGlite 0.5.8 observed | Ordinary PostgreSQL / simple effect |
| --- | --- | --- | --- |
| `shared_buffers` | Explicit 128 MiB default | 128 MiB, configuration file | Standard setting, typically 128 MiB. Reuses data pages; larger caches cost memory per instance. Not the separate 128 MiB initial Wasm memory. |
| `wal_buffers` | Explicit 4 MiB default | 4 MiB, automatically selected (`boot_val=-1`) | Standard setting; normally auto-sized. Same value here, different selection policy: our fixed 4 MiB does not automatically follow a caller's larger cache. Holds recovery-log writes temporarily. |
| `min_wal_size` | Explicit 80 MiB default | 80 MiB, configuration file | Standard default 80 MiB. Recycled log-file space, not RAM. |
| `work_mem` | Inherited 4 MiB unless overridden | 4 MiB | Standard default. Per-sort/hash working space; several operations/sessions multiply use. |
| `hash_mem_multiplier` | Inherited 2 unless overridden | 2 | Standard default; hash operations can use twice `work_mem`. Not a separate fixed allocation. |
| `maintenance_work_mem` | Inherited 64 MiB unless overridden | 64 MiB | Standard default. Working space for index creation/vacuum, not a simple SELECT speed setting. |
| `temp_buffers` | Inherited 8 MiB with standard blocks | 8 MiB | Standard default. Temporary-table cache used as needed, not sorting memory. |
| `max_wal_size` | Inherited 1 GiB unless overridden | 1 GiB, configuration file | Standard default. Soft checkpoint-related target, not a hard disk quota. |
| `max_stack_depth` | PostgreSQL guard; ordinary startup commonly 2 MiB, inspect actual instance | 2 MiB | Standard SQL guard, not an allocated stack. Platform limits can affect the selected default. |

PostgreSQL owns further settings not overridden by our runtime; this guide does
not duplicate its complete configuration manual. See its [memory settings](https://www.postgresql.org/docs/18/runtime-config-resource.html)
and [WAL settings](https://www.postgresql.org/docs/18/runtime-config-wal.html).
For actual values use `SHOW shared_buffers`, `SHOW wal_buffers`, `SHOW work_mem`,
and the other setting names. These descriptions explain potential effects;
this audit did not benchmark alternative settings.

## PGlite comparison: embedding sizes

Checked 2026-09-08 against the installed **`@electric-sql/pglite@0.5.8`**
distribution and its source maps. A fresh in-memory Node 24.18.0 instance
reported PostgreSQL **18.3**; the Oliphaunt comparison then targeted **18.4**. The SQL column above
comes from that running instance's `pg_settings` (including `unit`, `source`
and `boot_val`), not guesses from a build script. No directory/browser replay
or performance comparison was run for this documentation update.

Build-source evidence is separately pinned: PGlite repository snapshot
`ae182ff8bd5ba4acb887d6c925d607a1498aa0b5`, PostgreSQL submodule
`b133782cd759f08b3aeb263b80a963b39c7b7af1`. These source snapshots are not claimed
to prove the exact compiler provenance of the published npm binary.

| Topic | Oliphaunt | PGlite counterpart | What the comparison means |
| --- | --- | --- | --- |
| Guest C/shadow stack | 8 MiB link setting | 8 MiB in pinned backend link recipe [P1] | Same kind of stack and same selected size. Neither measures the host engine's execution stack. |
| Initial guest memory | 128 MiB link setting | 128 MiB default, caller `initialMemory` option [P2] | Comparable starting capacity, not a database-size limit. Memory can grow after startup. |
| Maximum guest memory | Product/engine-specific; Postmaster's 256 MiB profile is not the embedded default | 32,768 Wasm pages = 2 GiB in JS constructor [P2] | Do not compare a different Oliphaunt product's cap as if both ran under it. Native PostgreSQL has no equivalent one-piece Wasm ceiling. |
| Native execution stack | Wasmer's separate 1 MiB default in the retained Rust runtime; Postmaster selects its own size | JS engine controls native Wasm execution; no corresponding numeric capacity selected in inspected PGlite SDK | No valid "1 MiB versus 8 MiB" comparison: the latter is PGlite's *other* stack. |
| Growing result storage | Guest/native bridge output starts at 8 KiB | JS receive container starts at 1 MiB; grows, and resets to default on a later raw call [P3] | Similar job at different layers. Smaller starts save space for small work; larger starts avoid some growth. Both may also collect decoded rows. |
| Collected-output ceiling | WASIX signed-i32 bridge length (2 GiB minus 1); no separate application quota. Native uses host-sized lengths. | A constant named `MAX_BUFFER_SIZE` is 1 GiB, but see caveat below [P3] | Both can exhaust memory first. Neither collecting API promises bounded memory; use streaming when the whole result need not remain in memory. |
| Callback/read batches | Our 64 KiB callback maximum and separate reader batches | PGlite receives bytes through the guest callback; no matching fixed 64 KiB SDK callback cap found [P3] | PGlite's 1 MiB receive container is **not** its callback batch size. |
| PostgreSQL's internal protocol buffers | Separate from our bridge allocations | Pinned PGlite PostgreSQL still defines 8 KiB receive and initial send buffers [P4] | These come from PostgreSQL; matching 8 KiB bridge starts do not make them the same allocation. |
| 4 MiB queue / 256 KiB channels | Our native streaming / browser-tool transports | No direct matching fixed-byte waiting room found in inspected PGlite core | Compare streaming/copy counts and retained memory, not invented size parity. |
| 64/256 ordinary-work limits | Our async/SDK admission policies | Query/transaction mutexes serialize PGlite work; no corresponding numeric admission bound found [P3] | A mutex orders work; it is not itself a bounded request queue. |
| Browser filesystem transfer | Direct worker OPFS uses a 1 MiB transfer window; portable OPFS reopens a complete stored snapshot. The host sync bridge accepts 8 KiB–4 MiB capacity and 64 KiB directory pages | OPFS AHP reads/writes requested file slices using synchronous access handles [P5] | Different memory and I/O ownership. The transfer window bounds each request, not database size. Overflow staging retains new-file bytes until materialisation. |
| OPFS spare files | Configurable `spareFileCount`, default 32 unused handles in direct workers | Configurable 1,000 initially, 100 maintained in the inspected version [P5] | A larger reserve reduces overflow staging but retains more browser handles. Overflow remains supported through the synchronous recovery journal. |
| OPFS batch concurrency | 16 helper operations | Pool work gathered with `Promise.all`; no matching 16-operation cap in inspected implementation [P5] | More parallel setup may help or contend for the same storage. Does not add SQL execution parallelism. |
| Cached prepared runtime | One retained identity | URL-keyed compiled-module cache; no numeric eviction bound found [P6] | Related reuse policy, not identical cached objects. More retained identities can avoid setup while retaining more memory. |
| Whole backup/archive handling | Initial containers, extraction ceilings and per-role checks documented below | TAR/compression helpers also gather whole data/chunks; no matching set of our archive ceilings found [P7] | Neither whole-result path becomes constant-memory just because reads are chunked. |
| Diagnostics, broker/tool caps, carrier proofs, build/download envelopes | Our product-specific policies | No directly comparable shared numeric contract established in this review | Mark as our policy, not a PGlite or PostgreSQL performance disadvantage. |
| Fixed-format sizes | Wasm page, TAR block, PostgreSQL page and headers | Same relevant formats; probe observed 8 KiB PG pages and 16 MiB WAL segments | Format compatibility is not an optimization. Check the cluster's WAL segment size rather than copying a test fixture. |

**PGlite output-limit caveat:** in the inspected 0.5.8 `#defaultOnData`, the
allocation length is computed before `requiredSize` is adjusted to the named
maximum; the allocation uses that earlier length. Source inspection therefore
does not establish a hard 1 GiB ceiling. No giant allocation test was attempted
on this disk/memory-constrained host. This is a source-level finding, not a
measured failure threshold.

**Durability caveat:** the PGlite probe reports SQL `fsync=off` (its startup uses
`-F`). PGlite also has filesystem-level synchronization and `relaxedDurability`
handling. Do not infer identical persistence guarantees—or no persistence—from
SQL settings alone. The same WAL buffer size cannot explain or normalize the
cost of commits across different storage implementations. No durability setting
was changed here.

### PGlite evidence and refreshing the comparison

- [P1 — backend linker settings](https://github.com/electric-sql/postgres-pglite/blob/b133782cd759f08b3aeb263b80a963b39c7b7af1/build-pglite.sh#L153).
- [P2 — pinned JS memory construction](https://github.com/electric-sql/pglite/blob/ae182ff8bd5ba4acb887d6c925d607a1498aa0b5/packages/pglite/src/pglite.ts#L317).
- [P3 — published 0.5.8 core source map](https://unpkg.com/@electric-sql/pglite@0.5.8/dist/index.js.map), original `../src/pglite.ts`: receive/growth code, raw execution, mutexes and startup flags.
- [P4 — pinned PostgreSQL protocol implementation](https://github.com/electric-sql/postgres-pglite/blob/b133782cd759f08b3aeb263b80a963b39c7b7af1/src/backend/libpq/pqcomm.c#L119).
- [P5 — published OPFS AHP source map](https://unpkg.com/@electric-sql/pglite@0.5.8/dist/fs/opfs-ahp.js.map), original `../../src/fs/opfs-ahp.ts`.
- [P6 — published module-cache source map](https://unpkg.com/@electric-sql/pglite@0.5.8/dist/chunk-NNS5RQRF.js.map), original `../../pglite-utils/src/utils.ts`.
- [P7 — published TAR helpers source map](https://unpkg.com/@electric-sql/pglite@0.5.8/dist/chunk-DDJLRBDX.js.map), original `../src/fs/tarUtils.ts`.

To refresh, pin the package version, open a fresh instance with no startup
overrides, and query `pg_settings` for the names above. Convert `8kB` units to
bytes before comparing: `shared_buffers=16384` is 128 MiB, not 16 KiB.
Record storage mode, PostgreSQL version and caller overrides. Keep package
observations separate from newer source-main settings. "No counterpart found"
means no equivalent in the inspected path, not a claim about every PGlite
extension, third-party proxy or future release.

## Stacks are a different resource

| Owner | Existing setting | Meaning |
| --- | --- | --- |
| Native `liboliphaunt_runtime.c::DEFAULT_BACKEND_STACK_BYTES` | 8 MiB | Native PostgreSQL backend thread stack; `OLIPHAUNT_STACK_BYTES` is its existing override. It does not configure WASIX. |
| `src/wasix/runtime/assets/build/profile_flags.sh::OLIPHAUNT_WASM_GUEST_STACK_SIZE` | `8MB` | Guest C/shadow stack within Wasm linear memory. Shared by backend and initdb links, not an environment override. This is not the native machine-code call stack used by an AOT engine. |
| Same file, `OLIPHAUNT_WASM_INITIAL_MEMORY_SIZE` | `128MB` | Initial guest linear-memory size, containing the C stack and heap; not all query memory is eagerly touched. Larger values increase the instance memory floor, not necessarily throughput. |
| Wasmer execution stack | Separate engine-owned allocation | AOT/native call frames use this stack. PostgreSQL's shadow-stack depth check alone cannot establish that enough native stack remains. |
| PostgreSQL `max_stack_depth` | SQL-configurable guard | Recursion safety threshold, not an allocation and not a transport budget. Raising it does not allocate either stack. |

Wasmer's native execution stack can exhaust before PostgreSQL's guest C-stack
guard detects excessive recursion. Increasing `max_stack_depth` does not fix
this: it relaxes PostgreSQL's guard without allocating more engine stack.
There is no production remaining-native-stack guard in the embedded runtime;
an engine overflow is terminal, not a recoverable SQL error.

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
split-initdb stdout and stderr stream. The backend separately retains 16 KiB
of stderr in `instantiate_wasix_module`; browser adapter
`src/wasix/browser-host/adapter/postgres_direct.rs::STDERR_LIMIT_BYTES` also uses 16 KiB.
These matching backend values are not generated from the initdb constant.
`STARTUP_OUTCOME_MAX_PROTOCOL_BYTES`
allows up to 1 MiB of startup-error protocol payload and must match the guest
startup descriptor ABI in `oliphaunt_wasix_bridge.c`. These are diagnostic bounds,
not SQL result caps. Raising them retains/copies more diagnostic data; it cannot
speed up successful queries or repair error recovery.

Native `liboliphaunt_internal.h::OLIPHAUNT_ERROR_CAPACITY` and native Rust bindings
`liboliphaunt/ffi.rs::ERROR_CAPTURE_CAPACITY` use 1 KiB for error text. This is
also the public C error-capture layout; changing it needs a coherent ABI update,
not a diagnostic-tail option. Native
temporary error strings also use 128/256/512/1,024 bytes; symbol-scope diagnostics
use 512 bytes. Deno's error-copy buffer starts at 1 KiB and can grow.
The JS broker startup-ready line has an 8 KiB limit in `runtime/node-adapter.ts`.
These determine how much diagnostic text is retained/accepted, not query speed.

## Lifecycle and scheduling

| Owner | Current selection | Meaning and tuning boundary |
| --- | --- | --- |
| Native Rust `broker.rs`, `server.rs` | 20 s startup; 5 s shutdown | Owned transport/process deadlines; ordinary SQL is separate. Both builders accept `.startup_timeout(Duration)` and `.shutdown_timeout(Duration)` for broker/server; explicit fields override legacy environment defaults. Direct placement rejects them. |
| Desktop broker `config.rs`, `server.rs` | 5 s per accepted login by default; CLI `--handshake-timeout-ms`, native TS `broker.handshakeTimeoutMs`, native Rust `.broker_handshake_timeout(Duration)` | One deadline across the complete SQL or management handshake. Larger values retain unauthenticated connections longer. Both socket limits are cleared before queries/backups. Whole milliseconds in 1..2147483647; Rust rounds up. Mobile transports do not use this handshake. |
| Native C `liboliphaunt_protocol.c::oliphaunt_startup_timeout_ms` | 60 s by default, `OLIPHAUNT_STARTUP_TIMEOUT_MS` override | Backend readiness wait beneath SDK lifecycle deadlines. The shared strict resource parser rejects prefixes/overflow and falls back for invalid legacy overrides. This is a separate backend wait, not an alias for the helper/server readiness deadline. |
| Native Rust `server.rs::CONNECT_ATTEMPT_TIMEOUT` | 250 ms per readiness connection attempt | One probe within the overall startup/shutdown deadline; not an independent limit on total startup duration. Keep it internal or derive it from remaining time. |
| Native TS `runtime/broker.ts`, `runtime/server.ts` | 60 s startup; 5 s shutdown | Startup uses `OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS` or `OLIPHAUNT_SERVER_STARTUP_TIMEOUT_MS`. `timeouts.startupTimeoutMs` / `shutdownTimeoutMs` override those environment defaults on broker/server. Lifecycle overrides reject noncanonical integers and values above the signed 32-bit timer range. |
| Native TS `native/assets.ts` runtime-cache lock | 25 ms polling; 30 s acquisition timeout; stale after 5 minutes | Asset preparation can time out before runtime startup begins. Staleness currently uses directory age, not owner liveness, so a live builder lasting over 5 minutes can lose its lock. Do not expose a stale-age tuning option as if it established safe abandoned-owner recovery. |
| Swift/Kotlin mobile broker options; React Native broker options | 30 s startup; optional operation timeout; 3 s recovery and destructive close | `recoveryTimeout` / `shutdownTimeout` in Swift; `...Millis` in Kotlin; `...Ms` in RN broker options. The same values reach client and worker, including restore. Operation budgets retain queued-time and terminal-outcome semantics. |
| WASIX TS `core/database.ts`, `hosts/browser/direct-client-common.ts` | Browser startup 120 s; Worker close 120 s | `timeouts.startupTimeoutMs` covers preparation through readiness; immutable preparation/fetch is abortable. Owned direct allocations keep their lease until cleanup. `shutdownTimeoutMs` requires `/worker` and includes accepted work draining after close. All native-addon placements reject lifecycle options because they require quiescent cleanup. Browser Worker shutdown now reaches its actual abort capability; the existing facade-only deadline did not terminate those sessions. |
| Desktop broker `server.rs` pending login and recovery | 16 pending handshakes per endpoint; 3 s disconnected-stream recovery | `broker.maxPendingHandshakes` / `.broker_max_pending_handshakes(u32)` and `broker.recoveryTimeoutMs` / `.broker_recovery_timeout(Duration)`. Authenticated connections release login permits; independent management admission prevents SQL saturation from consuming it. SQL cancellation still shares SQL admission. |
| WASIX Rust `tools.rs`, `tools/startup.rs`; npm tool options | Native-host startup 30 s; browser startup unlimited when omitted | `.startup_timeout(Duration)` / `startupTimeoutMs` ends at virtual connect (browser: first protocol activity). Guest process signals or Worker retirement precede cleanup/join; no new post-connect SQL/output deadline. |
| WASIX Rust `host_runtime.rs`, `storage.rs`; native-host TS `configureHostRuntime` | CPU/environment async workers; 512 Tokio blocking workers; max(200, CPUs × 100) dedicated task workers; 4 file helpers per operation | `configure_host_runtime(HostRuntimeOptions)` / `configureHostRuntime`. Process-wide `asyncWorkerThreads`, `maxBlockingThreads`, `maxDedicatedThreads`, `maxConcurrentIO`, selected before use and shared by database and tool execution. Conflicting reconfiguration fails. File concurrency retains publication ordering and durability barriers; small blocking ceilings can starve work. |
| Native npm tool runner | 5 s termination grace | Escalates SIGTERM to SIGKILL after abort; subprocess cleanup remains owned. |
| Browser `adapter/clock.rs`; embedded PostgreSQL timeout patches | Canonical fallback after 16 ms or 1,024 reads per clock domain; deadline clock sampled every 32 interrupt predicates | Internal scheduling policies trading host calls against responsiveness. Blocking boundaries still check deadlines directly. A sampling count is not a wall-clock cancellation guarantee. |

## Postmaster-specific budgets

Do not apply these numbers to the embedded Rust/TS defaults above.

| Owner under `src/wasix/postmaster/` | Selection | In simple words; effect |
| --- | --- | --- |
| `bin/run-release-carrier.sh`; builder/validation scripts and `lib/sealed-carrier.sh` | 32 MiB execution stack default | More space for native Wasm calls. Release runner uses `OLIPHAUNT_WASIX_POSTMASTER_STACK_SIZE`; build/validation uses `WASMER_STACK_SIZE`. Not a throughput buffer. |
| `lib/common.sh`, fresh linear-memory profile | 4,096 Wasm pages = 256 MiB maximum | A ceiling on guest linear-memory growth for that profile, not a fixed allocation per query. |
| Same profile and Wasmer patch `0008-postmaster-executor-and-build-closure.patch` | 65,536-page = 4 GiB static address bound, plus 2 GiB guard reservation on the specified U64 engine layout | Reserved address space for safe memory access. This does **not** mean 6 GiB of physical RAM is filled for every instance. It is part of the engine safety contract, not free memory to give to SQL. |
| `profiles/runtime-footprints/embedded-concurrent-v1.gucs` | 32 MiB shared buffers; 8 connections | This specific profile trades cache and connection capacity for a smaller footprint. Not the embedded SDK's 128 MiB cache default. |
| `profiles/runtime-task-budgets/embedded-postmaster-v1.tsv`; `executor/src/runtime.rs`, `execute.rs` | Shared 96 guest-thread/blocking-pool ceiling; two async worker threads; one blocking core thread; 1,000 ms excess blocking-worker idle timeout | Receipt-bound thread/pool policy, derived with PostgreSQL child-role and authentication-overlap capacity. The value goes to guest `threading.max_threads` and the blocking pool's `max_size`; it is not a bound on all async tasks. A connection/worker profile change needs a consistent budget and fresh carrier evidence. |
| `executor/src/runtime.rs::WASIX_STACK_RLIMIT_DIVISOR` | Reports one eighth of the selected engine stack through the guest resource limit | Couples PostgreSQL's stack guard to the host execution stack. It is a safety policy needing recursion evidence, not an ordinary per-open throughput control. |
| Wasmer patch `0007-wasix-instance-linker-and-sealed-runtime.patch` | 64 KiB preinitialized-image alignment | Required layout boundary for the memory image. Not a file-read batch. |
| Wasmer patch `0002-virtual-fs-file-description-and-writeback.patch::ZERO_WRITE_CHUNK_LEN` | 8 KiB | Reusable batch for writing zeros. Larger batches may reduce write calls while using more scratch space. |

## Archives, installation and startup verification

These sizes mostly affect opening, backup/restore, downloading or building—not
steady-state SQL execution.
An archive ceiling allows or rejects an archive; it does not allocate that much
memory in advance. A ceiling checked **after** decompression does not bound
peak decompression memory: TS `archive.ts::decompressIfNeeded` currently calls
`decompressZstd` before `extractTar` applies its archive limit. Do not describe
that limit as a streaming decompression memory guarantee.

| Owner (repository-relative) | Selection | Meaning / cost |
| --- | --- | --- |
| `src/wasix/sdks/ts/src/resources/archive-limits.ts` | Package TAR: 2 GiB archive; 512 MiB entry; 65,536 entries; 1,024 path bytes; 64 path levels | Package import defaults remain internal and separate from physical backup policy. |
| Same file, `PHYSICAL_ARCHIVE_LIMITS` | Browser physical TAR: same initial defaults, independently owned | `db.backup({ archiveLimits })` / `Oliphaunt.restore(storage, bytes, { archiveLimits })`. Writer and reader enforce the same selected ceilings. Native-host WASIX preserves its uncapped default and enforces an explicit policy when supplied; other native SDK backups do not inherit JS TAR quotas. |
| `src/native/rust-bindings/src/liboliphaunt/root/resources.rs` | 1 GiB resource bytes; 8,192 files | Separate seed/ICU resource acceptance. Streamed reads use the byte ceiling, while an already-owned archive still exists outside a total process-memory bound. |
| `src/extensions/contracts/extension-artifact-archive-policy.properties` | 128 MiB compressed; 512 MiB expanded; 256 MiB member; 4,096 members | Separate extension archive policy shared across consumers. Not the general runtime archive policy. |
| `src/native/sdks/ts/src/native/assets.ts` | 4,096 extension-runtime files; 48 MiB per file; 256 MiB total; 4,096-byte path check | Limits installed extension runtime resources, not query results. |
| `tools/packaging/portable-archive.mts::DEFAULT_PORTABLE_ARCHIVE_LIMITS` | 512 MiB archive/member; 1 GiB expanded; 32,768 entries | Default package-verifier envelope; callers can use a role-specific envelope. |
| Runtime asset/tools/AOT/ICU crate `build.rs` files | 128 KiB hash-read batches | Scratch used when checking binaries, separate from the Rust WASIX runtime loader, which reads and verifies owned AOT bytes before deserialization. |
| `src/native/rust-bindings/src/liboliphaunt/root/fingerprint.rs` | 32 KiB | Root fingerprint read batch, separate from the AOT hash batch. |
| `src/third-party/tools/source-fetch-core.mts` | 1 GiB download; 8 GiB checkout; 500,000 checkout entries; 64 KiB marker; 16 MiB patch file; 1 MiB hash reads | Source acquisition/build protection, checked against the refreshed owner. Increasing these permits larger inputs; it does not make database queries faster. |
| `src/third-party/tools/source-archive.mts` | 1 GiB archive; 200,000 members; 2 GiB member; at most 4 GiB expanded, further bounded by 200× compressed size with a 64 MiB minimum allowance | Shared tar/ZIP source extraction envelope in current main. It rejects excessive archives; an accepted archive still consumes build-machine memory and disk. |
| `tools/dev/maintainer-tools.toml` | 8 MiB pinned helper archive allowances | Tool download envelopes, not runtime memory. |
| `src/native/sdks/swift/tools/swift-carrier-resolver.mts` | 2 GiB carrier; 512 MiB ZIP; 1 GiB member; 4 GiB expanded; 32,768 entries | Swift installation envelope. |
| `src/native/sdks/react-native/tools/stage-ios-app.mts` | Same byte envelopes; 4,096 ordinary entries, 16,384 bundled-resource entries; 1,024 legal files, 16 MiB each | Role-specific mobile installation limits. They are not all identical to the Swift limits. |
| `src/native/sdks/react-native/tools/mobile-extension-artifact-paths.mts` | 2 GiB artifact; 4,096 bundle members; 32,768 archive members; 4 GiB expanded | Mobile extension installation envelope. |
| `src/native/sdks/react-native/tools/ios-app-transport.mts` | 256 MiB ZIP directory; 1,000,000 entries; 4 KiB name; 64 KiB symlink target | App transport metadata limits; no direct SQL effect. |
| `src/native/sdks/swift/tools/render-extension-products.mts` | 32,768 files; 512 MiB file; 2 GiB tree | XCFramework inspection envelope. |
| Android Gradle plugin `ResolveOliphauntAndroidAssetsTask.java`, `OliphauntExtensionLegalCatalog.java`, `LinkOliphauntAndroidExtensionsTask.java` | 64 KiB artifact manifest; 1 MiB bundle/registry/legal-resource metadata; 4 MiB linker output | Metadata and diagnostic limits during Android builds. |
| Android archive/resolver/linker helpers | 128 KiB extraction/hash, 64 KiB reads, 16 KiB linker-output reads | Independent build-time I/O batches. |
| Postmaster `lib/durable-publication.mts`, `lib/receipt-files.mts` | 256 MiB publication input; 16 MiB metadata; 1 MiB read/copy batches | Safe publication of carrier metadata/files, not a cap on PGDATA. |
| Postmaster `lib/sealed-export-chain.mts` | 512 MiB uninventoried input | Build/provenance validation envelope. The retired Python helpers are not current policy owners. |
| Postmaster Wasmer patch `0008-postmaster-executor-and-build-closure.patch` | 4 MiB linear-memory receipt; 16 MiB export proof; 1 MiB manifest; 4 KiB proof line; 128 KiB hashes | Carrier admission/proof limits and verification batch, not runtime SQL buffers. |

## Fixed formats, platform bounds, and unbounded growth

- A normal WebAssembly page is 64 KiB; TAR records are 512 bytes. Standard
  PostgreSQL data pages are 8 KiB, identifiers allow 63 bytes, and WAL segment
  validation accepts power-of-two sizes from 1 MiB to 1 GiB. Those are format
  rules, not interchangeable transport constants. Read the cluster's actual
  segment size; a 1 MiB regression fixture is not the runtime default.
- The startup descriptor is 32 bytes; the broker header is 13 bytes; byte-channel
  control is six 32-bit words. Digest lengths, TAR field widths, null
  terminators and wire headers follow their formats. Changing them requires
  changing the format/ABI, not performance tuning.
- Mobile bulk records have a 36-byte header and up to 1 KiB of terminal error
  detail. The header is a format layout; error-detail capacity is a shared
  diagnostic protocol policy, not the tool-runner stderr tail.
- Native path scratch includes a 4,096-byte cwd buffer and smaller leaf/name
  arrays. Windows module-path discovery grows from `MAX_PATH` and stops
  retrying after its capacity exceeds 32,768. These can affect accepted paths,
  not SQL throughput. The Windows thread shim's 64 KiB `PTHREAD_STACK_MIN`
  fallback is a platform lower bound, not the selected 8 MiB backend stack.
- Android `.so` packaging/linking uses 16 KiB alignment; other ZIP alignment
  is 4 bytes, with 4 KiB signing padding. These are loading/layout constraints.
- Collected rows, native buffered output, whole backup archives and staged
  in-memory files can grow beyond their starting buffers. A queue bounded in
  *commands* does not bound the bytes held by those commands. This inventory
  does not imply that total per-database memory is bounded.

When changing a size, update this guide and its owning constant/contract, check
mirrored consumers, and test both small and large inputs. Include slow readers,
multiple databases and memory peaks. Do not add an environment flag merely to
make every number adjustable.

## Follow-up review: constructors, justification and upstream

The 2026-10-15 follow-up checked storage constructors and path declarations in
all seven SDKs, numeric/declaration candidates across the runtime, SDK,
transport, import and producer sources, and the owning code for the additions
above. The candidate search also matches test values and format fields; it
does not prove that every dependency or numeric literal was audited. Inline
Swift/Kotlin admission checks and allocations were checked separately from
named constants. The previous 1,024-chunk compaction entry was stale; current
source uses more than 256.

The channel's 64 KiB batch/256 KiB capacity and OPFS's 16-operation helper cap
trace to the runtime/SDK consolidation history. Admission hardening describes
overload and retained-input ownership. That establishes purpose, not an optimum:
no workload sweep proving these exact admission/channel/OPFS values was found
in the inspected benchmark or architecture records. Preserve existing defaults
until there is comparative evidence; expose useful owner controls without
relabeling arbitrary policy as a PostgreSQL or platform requirement.

PGlite upstream was rechecked at commit
`550943fbca8c40a0185a2d02d11afdcea97fa869` (source, not a new installed-package
probe). Its [core](https://github.com/electric-sql/pglite/blob/550943fbca8c40a0185a2d02d11afdcea97fa869/packages/pglite/src/pglite.ts)
still chooses 128 MiB initial memory unless `initialMemory` is supplied and a
2 GiB maximum, starts receive storage at 1 MiB, and uses query/transaction
mutexes without the matching numerical operation-admission policy in that
path. The named 1 GiB receive-buffer maximum still does not bound the earlier
allocation-size calculation. Its
[OPFS implementation](https://github.com/electric-sql/pglite/blob/550943fbca8c40a0185a2d02d11afdcea97fa869/packages/pglite/src/fs/opfs-ahp.ts)
exposes initial/maintained pool counts of 1,000/100 and gathers pool work with
`Promise.all`. Those are different resource owners from our helper-I/O cap.
PGlite has numerical policies; absence of our corresponding queue or broker
limit is not proof that our mechanism or selected value is unnecessary.

Twenty existing JS storage/configuration tests passed. Direct native-directory
probes verified strings, file URL objects, percent decoding and rejection of
non-file/NUL URLs. At that review point, a native seed URL-object probe reproduced the
string-only validation failure; the implementation now normalizes file URLs. No Android/Swift runtime, alternative-size
benchmark or PGlite execution was run for this follow-up.

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

## Wider packaging and release sweep

The follow-up enumerated 2,256 production/tool files and collected 2,083 numeric
candidate locations across native, WASIX, shared query, resources, extensions,
source acquisition, packaging and release tools. These are search candidates,
not independent budgets: format tags, identity fields and inline tests also
match. The additional owner-reviewed families are below. They are maintainer
controls and service constraints, not database-open settings.

| Owner | Current policy | Purpose and tuning direction |
| --- | --- | --- |
| `tools/packaging/portable-archive.mts` | Zstandard compression level 19 | Smaller distribution archives at greater packaging CPU cost; select at the canonical archive producer and qualify decompression compatibility. |
| `tools/packaging/archive-directory.mts` | ZIP deflate level 9 | The same packaging CPU/size tradeoff for ZIP carriers; does not affect database execution. |
| `tools/packaging/release-carrier.mts` | 2 archive-entry cache records | Bounds retained packaging scans; a larger shared cache retains more archive metadata. Keep scope at the carrier reader. |
| `tools/packaging/native-cargo-payload.mts` | 64 MiB maximum payload part | Already accepts `partBytes` for smaller parts; larger parts require carrier/envelope proof. This is upload/package partitioning, not a query limit. |
| Extension carrier producer | Cargo envelope 10 MiB, split target 9 MiB, npm safety envelope 100 MiB | Keep registry ceilings distinct from the smaller split target and safety margin; lowering targets produces more carriers. External service ceilings are not arbitrary consumer knobs. |
| GitHub content writes / crates reads | 10 s write spacing / 250 ms read-start spacing | Avoid service throttling; owned by shared release HTTP pacing. Per-product overrides would defeat shared coordination. |
| GitHub asset uploads | At most 5 concurrent product uploads | Bounds release-network and upload pressure; tune at the upload scheduler with retry/throttling evidence. |
| GitHub asset upload phases | 31 min overall; phase deadlines 5, 5, 5, 10 and 6 min | Lifecycle deadlines at the release owner; account for artifact size and slow networks without resetting the overall deadline. |
| Release HTTP / npm publication / attestation asset retrieval | HTTP deadlines 15–60 s; npm publication 2 min; attestation retrieval 10 min | Different operations and timeout scopes; retain operation-specific names rather than one global network timeout. |
| Maven Central staging | Response capture 1 MiB; bundle envelope 1,000,000,000 bytes; visibility poll 1 s | Diagnostic retention, externally constrained bundle acceptance, and polling latency are separate policies. |
| Registry mutation retries | Output capture 4 MiB; base backoff 1 s | Retained diagnostics and transient retry pressure; tune on the shared mutation runner. |
| Frozen Cargo rate-limit recovery | 3 retries, maximum wait 9 min, response capture 64 KiB, clock skew allowance 2 s | Bound release delay and diagnostics while honoring rate-limit evidence; change the retry owner and its fault tests together. |

No comparative benchmark establishes these values as optimal. Existing named
producer/retry policies remain at their owners; exposing them in SDK open
options would accept settings those SDKs cannot enforce.

## Implemented controls and qualification

This checkout implements explicit admission on all seven asynchronous SDK
surfaces, OPFS helper concurrency, native TypeScript file-URL inputs and strict
legacy numeric override validation. Omitted admission preserves each product's
release points and defaults. Explicit BEGIN admission releases before the
transaction callback; the transaction lease has its own lifetime. Recovery
controls remain outside ordinary admission;
server endpoints and static restore reject a database admission setting.

The product-owned Moon checks passed for native/WASIX Rust, shared Rust/TS query,
native/WASIX TypeScript, React Native source/codegen, portable Swift, Kotlin JVM
and Android unit/lint lanes, native C queue/lifecycle tests, native tool file
publication and the docs build/check/smoke lanes. The JavaScript suites include
count capacities 1, 2 and 65, and the native actor rejects a value outside its
permit width before Worker construction. Rust tests cover executing ownership
and oversized work preceding/following zero-input work. Swift verifies rejection
before typed encoding; its omitted path performs no extra size scan. BEGIN
saturation tests verify rejection without invoking callbacks or leaving a pinned
database, followed by successful sequential work and transaction settlement.
The three JavaScript owners derive BEGIN packet accounting from the shared
extended-query encoder; the byte-boundary tests cover its complete framing.
React Native's `test-android` owner task compiles the adapter and runs its numeric
boundary tests against the local Kotlin SDK. Both Android and iOS adapters
forward the explicit limits to their SDK configuration; iOS code generation
confirms the bridge getters, while Apple compilation remains unqualified here. OPFS backing
read tests exercise concurrency 1, 2 and 5 without changing publication order.

Candidate packages were staged for the Rust SDKs/query core, TypeScript SDKs/query
core and Kotlin Maven artifacts; Swift's source archive passed. Android packaging
needed the pinned Rust Android standard-library targets installed on this host
and then passed. Full React Native/Swift Apple packaging requires Darwin and was
not qualified here. No registry publication, installed-device run, complete
native/WASIX runtime integration matrix or alternative-size benchmark was run.
The docs build type-checks the existing quickstarts; it does not execute them.

A Node 24.18.0 probe verified the maximum accepted lifecycle delay on the actual
host timer and rejection of the next integer before scheduling. Node documents
that a larger timer delay becomes 1 ms, which is why this bound is validation,
not a tunable performance default: [timer scheduling](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args).
The source evidence and candidate checks do not establish zero regressions on
unrun hosts or justify selecting different numerical defaults. Remaining transport/protocol, additional tool-output, native C runtime, package-import and producer-profile APIs are still proposals in the architecture contract.


## 2026-10-18 owner audit

The follow-up found seven omissions: physical backup/restore quota asymmetry,
WASIX tool connect waits followed by uncancelled joins, startup preparation
outside browser deadlines, desktop/mobile three-second cleanup assumptions,
shared desktop connection admission, repeated CPU-sized WASIX tool executors
and fixed four-way native-host publication helpers. Following those owners also
found Wasmer's separate dedicated task pool. Its default is now named at the
upstream constructor and independently selectable; the shared host reuses it
instead of constructing a pool for every tool. The options above now reach
their owners, rather than accepting a field that an inner fixed limit defeats.
Numerical defaults stay at their previous values. The intentional admission correction
counts pending logins instead of retaining slots for authenticated clients, and
management has its own allowance.

Browser startup cancellation reaches runtime, extension, seed and ICU reads.
Shared runtime preparation tracks callers; one timeout cannot cancel another
open. Cancellation cannot safely abandon an owned allocation or release its
storage before cleanup. Host compilation and native calls are cooperative
boundaries; the deadline is not a promise to preempt them immediately.

The native C backend timeout/stack/stream environment settings, prepared-runtime
cache size, native asset-cache lock policy, callback batches, protocol bounds,
package decompression limits and producer profiles retain their existing owners.
In particular, raising a JS TAR extraction ceiling is not a decompression-memory
bound. These have not been silently advertised as new per-open settings.


Validation for this follow-up: native broker and Rust SDK source suites passed,
including 139 native nextest cases, 109 mobile client/worker unit cases, 190
WASIX unit cases and eight public API cases. Native TypeScript passed 104 tests;
WASIX TypeScript passed 413, including a physical TAR above 65,536 entries with
an explicit policy, selected Worker lifecycle budgets, abortable fetch and shared
preparation cancellation. Real native broker tests passed all five cases,
including SQL login saturation with independent management and slot release
after authentication. The native mobile round-trip and WASIX large logical
dump/restore/destination-failure recovery test passed.

Android Kotlin build/unit/lint and React Native Android adapter/codegen checks
passed. The JNI library compiled for all four configured Android ABIs. Portable
Swift passed 102 tests; that does not compile the iOS-only broker/XPC branches.
The checked source packages passed for both Rust SDKs, broker, shared query,
native/WASIX TypeScript and WASIX tools. Docs check/build and all 49 HTML smoke
pages passed. Apple broker/adapter compilation, installed-device execution,
full cross-platform consumer qualification and alternative-size performance
benchmarks remain unrun for this follow-up.
