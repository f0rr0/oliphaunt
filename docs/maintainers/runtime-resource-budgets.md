# Runtime resource budgets

Status: implementation reference. Last verified: 2026-09-08. Owner: runtime maintainers.

Equal byte counts do not imply equal purposes. A stack allocation, an I/O batch,
a queue watermark, and a protocol rejection limit must have separate owners.
The constants below describe existing behavior; this inventory does not change
sizes or establish that they are optimal. MiB and KiB mean powers of 1024.

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

## Audit scope and ownership

The second pass on 2026-09-08 checked first-party native C, Rust and TS runtimes
and SDKs, shared contracts, browser-host patches, Postmaster patches/profiles,
and source/package/release tooling. Searches covered named limits, literal
allocations, powers of two, underscored decimal values, queue counts and linker
settings. It found omissions in the first version: SQL cache/WAL settings,
request queues, OPFS staging, tool sockets/output, archive limits, backend
stderr, hash buffers and Postmaster memory accounting.

This is the inventory of resource-size decisions found in that audit, not a
claim to list every numeric literal in PostgreSQL, Wasmer or the repository.
Unmodified dependency internals, test/benchmark-only workloads, timeouts, bit
flags, port numbers, checksums and binary field offsets are not tuning choices
covered here. Important fixed-format sizes are classified below. Experimental
8 MiB execution stacks are not production defaults.

Central documentation does not mean one global constant: equal numbers with
different purposes stay separately owned. The shared protocol contract generates
the embedded bridge C and SDK Rust/TS values. Browser-host patch literals are
still separately pinned and checked by `src/bindings/wasix-ts/host/build-sdk.sh`;
the earlier generator change did **not** remove those copies. SQL startup
defaults and broker-frame limits also still have multiple language owners.
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
| Our 64 KiB batches, 4 MiB stream watermark, 256 KiB channels, initial growing containers and compaction thresholds | **Oliphaunt transport/allocation tuning.** Trade calls/copies against memory and waiting. | A server also buffers I/O, but does not have these SDK bridge constants. Their exact values need workload evidence. |
| 64/256 work admission counts | **Oliphaunt overload control.** Bounds waiting work, not backend parallelism. | Client pools/server connection admission are analogous, but not the same queues or units. |
| OPFS bridge sizes, 32 spares, 16 parallel file operations, one cached runtime | **Oliphaunt browser/startup tuning.** Reuse and batching can reduce setup work. | No OPFS or compiled-Wasm module cache in a normal native server. |
| 64 MiB SQL/tool output and 128 MiB frontend/broker limits | **Oliphaunt safety/API policy.** Rejects oversized retained data. | PostgreSQL has its own message/allocation rules; these particular caps are ours, not SQL limits to attribute to PostgreSQL. |
| Diagnostic tails, startup/error text and archive/metadata ceilings | **Oliphaunt diagnostics/input protection.** | Similar needs exist elsewhere; our exact limits are not PostgreSQL query-performance settings. |
| Native backend 8 MiB thread stack, guest 8 MiB C stack, initial 128 MiB linear memory, Postmaster profile sizes | **Embedding/platform capacity choices.** Required resources with chosen budgets, not automatic speedups. | Native PostgreSQL also needs stack/heap space, but not these Wasm allocations or SDK thread defaults. |
| Wasmer execution stack and reserved-address layout | **Engine-owned mechanism**, with engine/product policy deciding capacity. | An ordinary native server uses its process/OS stack; it has no Wasmer coroutine stack. |
| Wasm page, TAR/wire headers, identifier/digest lengths, platform alignment | **Format/platform rules**, not free tuning knobs. | PostgreSQL-specific formats are shared; Wasm/TAR/Android rules belong to those respective formats/platforms. |
| Hash/copy batches and release/source/package-tool envelopes | **Build/install choices**, outside normal SQL execution. | Not PostgreSQL query settings. |

The transport/storage tuning rows are the optimization-*motivated* choices.
This inventory does not establish that 64 KiB, 32 spares, or any other exact
selection is the optimum. Safety rows must earn their place through correct
limits and failure handling, not by producing a faster benchmark.

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

### Additional transport and allocation sizes

| Owner (repository-relative) | Selection | In simple words; effect |
| --- | --- | --- |
| `src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_bridge.c`, input reserve and output append | 8 KiB initially, doubles | Starting containers for guest input/output. Larger starts avoid some resizing but use more space for small queries. Input capacity is not the output's 64 MiB safety cap. |
| `src/sdks/rust/src/pgwire.rs` | 64 KiB read buffer; 8 KiB initial response vector | Socket delivery box and growing result container, respectively. Neither limits the total result to that size. |
| `src/sdks/rust/src/ipc.rs` and `src/sdks/js/src/runtime/broker-frames.ts` | 128 MiB frame limit | Rejects a single oversized broker message; independent of the similarly sized PostgreSQL frontend-frame limit. |
| `wasix-rust/tools.rs::DIRECT_TOOL_SOCKET_BUFFER` | 256 KiB | Waiting space in the in-process tool socket. Larger capacity can absorb bursts, not speed up SQL itself. |
| `src/shared/postgres-tool-output-contract/contract.json::capturedOutputLimitBytes`; Rust native tools, WASIX tools and JS consumers | 64 MiB, stdout + stderr together per process | Limit for collected tool output. It is not the SQL buffered-output contract. Larger valid output needs the streaming path. |
| `src/runtimes/liboliphaunt/native/crates/tools/src/lib.rs`, captured pipe reader | 32 KiB | Tool-output read batch; total capture is governed by the separate contract above. |
| Native `liboliphaunt_archive_tar.c::buffer_reserve` | 4 KiB initially, doubles | Backup archive starting container. The full archive still grows in memory; larger initial capacity does not solve large-backup memory use. |
| `wasix-ts/pgwire-connection.ts`, chunk-list compaction | 1,024 consumed chunks and at least half the list consumed | Removes old list entries in batches. More frequent removal frees references sooner but spends more time moving list entries. Not a byte limit. |
| `wasix-rust/postgres_mod/stdio.rs`, `sync_host_fs.rs`, tool fallback and browser stderr patch | 8 KiB write-readiness report | Says a file/stream is writable with this advertised amount; does not allocate an 8 KiB buffer or guarantee a complete write. |
| Guest `oliphaunt_wasix_bridge.c`, emulated `SO_SNDBUF`/`SO_RCVBUF` | 32 KiB | Socket-option compatibility answers, not real kernel socket allocations. Do not tune these as if they were queue capacities. |

### Browser storage and counted resources

| Owner | Selection | In simple words; effect |
| --- | --- | --- |
| `wasix-ts/storage/opfs-provider.ts::DIRECT_BRIDGE_CAPACITY` | 1 MiB | Maximum file-transfer batch offered to the browser filesystem bridge. Larger batches can reduce calls for big files; they do not make tiny reads faster. |
| Browser patch `0015-wasmer-js-add-sync-filesystem-bridge.patch`, `Backend::new` | Accepts 8 KiB–4 MiB bridge capacity | Allowed range for that batch setting, not a database-size limit. |
| Same patch, `READ_DIR_PAGE_CAPACITY` | 64 KiB | One page of directory names. Larger pages reduce trips for directories with many files, at a memory/copy cost. |
| `wasix-ts/storage/opfs-pool.ts::#ensureStagedCapacity` | At least 8 KiB on growth; doubles or meets requested size | Growing in-memory file storage before publication. Spare capacity saves repeated allocations but increases retained memory. No total database cap follows from this number. |
| Same file, `PREOPENED_FILE_RESERVE` | 32 spare files | Keeps files ready to use so creation can be quicker. Costs file handles/resources even before those spares hold useful data. |
| Same file, `MAX_PARALLEL_IO` | 16 operations | Limits simultaneous work in the helper's file batches. More may speed setup/publication, or compete for the same storage. Not 16 concurrent SQL queries. |
| `wasix-ts/direct-client-common.ts::MAX_PREPARED_RUNTIMES` | 1 cached runtime identity | Avoids repeating preparation for the same assets. More entries help switching between runtime versions but retain more assets; eviction does not close live databases. |
| `src/bindings/wasix-rust/crates/oliphaunt-wasix/src/async_api.rs::OWNER_QUEUE_CAPACITY` | 64 ordinary work permits | Bounds ordinary admitted work in the async wrapper. More permits let more callers wait; they do not add backend execution parallelism. |
| `src/sdks/rust/src/executor.rs::ORDINARY_QUEUE_CAPACITY` | 256 ordinary queued commands | A separate SDK waiting room. Cleanup/recovery commands do not consume these slots. A command-count limit is not a byte-memory limit. |

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
reported PostgreSQL **18.3**; Oliphaunt targets **18.4**. The SQL column above
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
| Initial guest memory | 128 MiB link setting | 128 MiB default, caller `initialMemory` option [P2] | Comparable starting capacity, not a database-size limit. Our probe already grew to 197,722,112 bytes after startup. |
| Maximum guest memory | Product/engine-specific; Postmaster's 256 MiB profile is not the embedded default | 32,768 Wasm pages = 2 GiB in JS constructor [P2] | Do not compare a different Oliphaunt product's cap as if both ran under it. Native PostgreSQL has no equivalent one-piece Wasm ceiling. |
| Native execution stack | Wasmer's separate 1 MiB default in the retained Rust runtime; Postmaster selects its own size | JS engine controls native Wasm execution; no corresponding numeric capacity selected in inspected PGlite SDK | No valid "1 MiB versus 8 MiB" comparison: the latter is PGlite's *other* stack. |
| Growing result storage | Guest/native bridge output starts at 8 KiB | JS receive container starts at 1 MiB; grows, and resets to default on a later raw call [P3] | Similar job at different layers. Smaller starts save space for small work; larger starts avoid some growth. Both may also collect decoded rows. |
| Collected-output ceiling | Enforced 64 MiB WASIX cap; native buffer has no matching cap | A constant named `MAX_BUFFER_SIZE` is 1 GiB, but see caveat below [P3] | Not evidence for a reliably enforced 1 GiB PGlite limit. |
| Callback/read batches | Our 64 KiB callback maximum and separate reader batches | PGlite receives bytes through the guest callback; no matching fixed 64 KiB SDK callback cap found [P3] | PGlite's 1 MiB receive container is **not** its callback batch size. |
| PostgreSQL's internal protocol buffers | Separate from our bridge allocations | Pinned PGlite PostgreSQL still defines 8 KiB receive and initial send buffers [P4] | These come from PostgreSQL; matching 8 KiB bridge starts do not make them the same allocation. |
| 4 MiB queue / 256 KiB channels | Our native streaming / browser-tool transports | No direct matching fixed-byte waiting room found in inspected PGlite core | Compare streaming/copy counts and retained memory, not invented size parity. |
| 64/256 ordinary-work limits | Our async/SDK admission policies | Query/transaction mutexes serialize PGlite work; no corresponding numeric admission bound found [P3] | A mutex orders work; it is not itself a bounded request queue. |
| Browser filesystem transfer | 1 MiB bridge batch, 64 KiB directory page; 8 KiB starting staged files | OPFS AHP reads/writes requested file slices using synchronous access handles [P5] | Same filesystem problem, different route. No matching 1 MiB bridge/staging budget found there. |
| OPFS spare files | 32 maintained spares | Configurable 1,000 initially, 100 maintained [P5] | Directly comparable concept, not identical lifecycle. PGlite spends more setup/resources preparing spare files; fewer spares can mean more later replenishment. |
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

1. A fixed trusted engine operation measures remaining native guest-stack
   capacity without moving the query onto the host stack. Ordinary callbacks
   keep their host-stack isolation and need no budget snapshots.
   Exclude guard pages and exception reserves;
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

Status: the hardened candidate passes 62 VM tests in both debug and optimized
builds, focused PostgreSQL recovery checks in memory/directory, and 144 benchmark
children. The [review packet](../internal/stack-safety-20260908/README.md) contains
the VM/API, PostgreSQL and Rust registration patches, regression probes and
performance caveats. It is **not consumed by production dependencies or patch
series**. Reserve qualification, the supported engine dependency and browser/
Windows contracts remain outstanding. No production guard or larger execution
stack is claimed by the constants cleanup.

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
split-initdb stdout and stderr stream. The backend separately retains 16 KiB
of stderr in `instantiate_wasix_module`; browser patch
`0018-wasmer-js-bound-direct-stderr.patch::STDERR_LIMIT_BYTES` also uses 16 KiB.
These matching backend values are not generated from the initdb constant.
`STARTUP_OUTCOME_MAX_PROTOCOL_BYTES`
allows up to 1 MiB of startup-error protocol payload and must match the guest
startup descriptor ABI in `oliphaunt_wasix_bridge.c`. These are diagnostic bounds,
not SQL result caps. Raising them retains/copies more diagnostic data; it cannot
speed up successful queries or repair error recovery.

Native `liboliphaunt_internal.h::OLIPHAUNT_ERROR_CAPACITY` and Rust SDK
`liboliphaunt/ffi.rs::ERROR_CAPTURE_CAPACITY` use 1 KiB for error text. Native
temporary error strings also use 128/256/512/1,024 bytes; symbol-scope diagnostics
use 512 bytes. Deno's error-copy buffer starts at 1 KiB and can grow.
The JS broker startup-ready line has an 8 KiB limit in `runtime/node-adapter.ts`.
These determine how much diagnostic text is retained/accepted, not query speed.

## Postmaster-specific budgets

Do not apply these numbers to the embedded Rust/TS defaults above.

| Owner under `src/runtimes/liboliphaunt/wasix-postmaster/` | Selection | In simple words; effect |
| --- | --- | --- |
| `bin/run-release-carrier.sh`; builder/validation scripts and `lib/sealed-carrier.sh` | 32 MiB execution stack default | More space for native Wasm calls. Release runner uses `OLIPHAUNT_WASIX_POSTMASTER_STACK_SIZE`; build/validation uses `WASMER_STACK_SIZE`. Not a throughput buffer. |
| `lib/common.sh`, fresh linear-memory profile | 4,096 Wasm pages = 256 MiB maximum | A ceiling on guest linear-memory growth for that profile, not a fixed allocation per query. |
| Same profile and Wasmer patch `0008-postmaster-executor-and-build-closure.patch` | 65,536-page = 4 GiB static address bound, plus 2 GiB guard reservation on the specified U64 engine layout | Reserved address space for safe memory access. This does **not** mean 6 GiB of physical RAM is filled for every instance. It is part of the engine safety contract, not free memory to give to SQL. |
| `profiles/runtime-footprints/embedded-concurrent-v1.gucs` | 32 MiB shared buffers; 8 connections | This specific profile trades cache and connection capacity for a smaller footprint. Not the embedded SDK's 128 MiB cache default. |
| Wasmer patch `0007-wasix-instance-linker-and-sealed-runtime.patch` | 64 KiB preinitialized-image alignment | Required layout boundary for the memory image. Not a file-read batch. |
| Wasmer patch `0002-virtual-fs-file-description-and-writeback.patch::ZERO_WRITE_CHUNK_LEN` | 8 KiB | Reusable batch for writing zeros. Larger batches may reduce write calls while using more scratch space. |

## Archives, installation and startup verification

These sizes were missing from the original inventory. They mostly affect
opening, backup/restore, downloading or building—not steady-state SQL execution.
An archive ceiling allows or rejects an archive; it does not allocate that much
memory in advance. A ceiling checked **after** decompression does not bound
peak decompression memory: TS `archive.ts::decompressIfNeeded` currently calls
`decompressZstd` before `extractTar` applies its archive limit. Do not describe
that limit as a streaming decompression memory guarantee.

| Owner (repository-relative) | Selection | Meaning / cost |
| --- | --- | --- |
| `src/bindings/wasix-ts/src/archive.ts` | 2 GiB tar; 512 MiB entry; 65,536 entries; 1,024-byte paths; 64 path levels | Runtime archive acceptance limits. Larger allowances accept larger archives and increase worst-case processing/memory exposure. |
| `src/shared/extension-runtime-contract/extension-artifact-archive-policy.properties` | 128 MiB compressed; 512 MiB expanded; 256 MiB member; 4,096 members | Separate extension archive policy shared across consumers. Not the general runtime archive policy. |
| `src/sdks/js/src/native/assets-node.ts` | 4,096 extension-runtime files; 48 MiB per file; 256 MiB total; 4,096-byte path check | Limits installed extension runtime resources, not query results. |
| `src/shared/artifact-packaging/portable-archive.mjs::DEFAULT_PORTABLE_ARCHIVE_LIMITS` | 512 MiB archive/member; 1 GiB expanded; 32,768 entries | Default package-verifier envelope; callers can use a role-specific envelope. |
| Rust WASIX `aot.rs`; runtime asset/tools/AOT/ICU crate `build.rs` files | 128 KiB hash-read batches | Scratch used when checking binaries. Can change verification time and scratch use, not execution speed of a verified query. |
| `src/sdks/rust/src/liboliphaunt/root/fingerprint.rs` | 32 KiB | Root fingerprint read batch, separate from the AOT hash batch. |
| `src/sources/tools/source-fetch-core.mjs`; `verify-source-tree.py` | 1 GiB download; 8 GiB checkout; 500,000 checkout entries; 64 KiB marker; 16 MiB command capture; 1 MiB hash reads | Source acquisition/build protection. Increasing these permits larger inputs; it does not make database queries faster. |
| `src/sources/tools/source-archive.py` and `source-zip.py` | 200,000 members; 2 GiB member; 4 GiB expanded; 200× expansion with 64 MiB minimum allowance; 4,096-byte paths; 1 MiB copying | Rejects excessive archives before/during source extraction. Copy size trades calls against scratch memory. |
| `src/sources/toolchains/maintainer-tools.toml` | 8 MiB pinned helper archive allowances | Tool download envelopes, not runtime memory. |
| `src/sdks/swift/tools/swift-carrier-resolver.mjs` | 2 GiB carrier; 512 MiB ZIP; 1 GiB member; 4 GiB expanded; 32,768 entries | Swift installation envelope. |
| `src/sdks/react-native/tools/stage-ios-app.mjs` | Same byte envelopes; 4,096 ordinary entries, 16,384 bundled-resource entries; 1,024 legal files, 16 MiB each | Role-specific mobile installation limits. They are not all identical to the Swift limits. |
| `src/sdks/react-native/tools/mobile-extension-artifact-paths.mjs` | 2 GiB artifact; 4,096 bundle members; 32,768 archive members; 4 GiB expanded | Mobile extension installation envelope. |
| `src/sdks/react-native/tools/ios-app-transport.mjs` | 256 MiB ZIP directory; 1,000,000 entries; 4 KiB name; 64 KiB symlink target | App transport metadata limits; no direct SQL effect. |
| `src/sdks/swift/tools/render-extension-products.mjs` | 32,768 files; 512 MiB file; 2 GiB tree | XCFramework inspection envelope. |
| Android Gradle plugin `ResolveOliphauntAndroidAssetsTask.java`, `OliphauntExtensionLegalCatalog.java`, `LinkOliphauntAndroidExtensionsTask.java` | 64 KiB artifact manifest; 1 MiB bundle/registry/legal-resource metadata; 4 MiB linker output | Metadata and diagnostic limits during Android builds. |
| Android archive/resolver/linker helpers | 128 KiB extraction/hash, 64 KiB reads, 16 KiB linker-output reads | Independent build-time I/O batches. |
| Postmaster `lib/durable_publication.py` | 16 MiB comparison; 256 MiB publication; 1 MiB copy batches | Safe publication of carrier metadata/files, not a cap on PGDATA. |
| Postmaster `lib/sealed_export_chain.py` and `linear_memory_transaction.py` | 512 MiB uninventoried input; 16 MiB small metadata; 1 MiB read/copy batches | Build/provenance validation envelopes. |
| Postmaster Wasmer patch `0008-postmaster-executor-and-build-closure.patch` | 4 MiB linear-memory receipt; 16 MiB export proof; 1 MiB manifest; 4 KiB proof line; 128 KiB hashes | Carrier admission/proof limits and verification batch, not runtime SQL buffers. |

### Release-tool sizes (not SQL tuning)

Under `tools/`, the additional choices are:

- `dev/capture-command-output.mjs`: 64 MiB default command-output limit.
  Callers use 4/16/32/64/128 MiB bounds according to the command. Examples:
  `release/github-release-mutations.mjs` (4 MiB), public-consumer smoke
  (16 MiB), carrier packagers (32 MiB), `release/github-read.mjs` (128 MiB).
- Registry/publication metadata: 64 KiB responses in frozen Cargo/trusted
  publishing; 256 KiB trusted-publisher responses/help; 8 MiB registry/npm
  metadata; 1 MiB Maven responses, public keys and Swift checksum manifests;
  64 MiB registry evidence/receipts; 8 MiB public-consumer evidence. Owners are
  the corresponding `tools/release/` scripts, not the SQL transport contract.
- `release/bootstrap-publication-capsule.mjs`: 1 MiB copies, 64 MiB metadata.
- `release/extract-node-headers.mjs`: 64 MiB archive, 256 MiB expanded,
  32 MiB file. `release/ios-carrier-manifest.mjs`: 2 GiB archive.
- Cargo artifact packagers: 10 MiB local package ceiling.
  `release/frozen-maven-publish.mjs`: 1,000,000,000-byte bundle ceiling
  (decimal bytes, not 1 GiB). These are repository checks, not a promise that
  a remote registry's policy will never change.
- `xtask/src/asset_checks.rs`: 8 GiB expanded-asset envelope.

These limits protect the development/release machine from excessive input or
output. Raising them can increase build-time memory/disk exposure. Their only
connection to ordinary query latency is indirect competition for machine
resources if builds and queries run on the same host.

## Fixed formats, platform bounds, and unbounded growth

- A normal WebAssembly page is 64 KiB; TAR records are 512 bytes. Standard
  PostgreSQL data pages are 8 KiB, identifiers allow 63 bytes, and WAL segment
  validation accepts power-of-two sizes from 1 MiB to 1 GiB. Those are format
  rules, not interchangeable transport constants. Read the cluster's actual
  segment size; a 1 MiB regression fixture is not the runtime default.
- The startup descriptor is 32 bytes; the broker header is 13 bytes; byte-channel
  control is five 32-bit words. Digest lengths, TAR field widths, null
  terminators and wire headers follow their formats. Changing them requires
  changing the format/ABI, not performance tuning.
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
