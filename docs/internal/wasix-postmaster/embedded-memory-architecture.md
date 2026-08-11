# Embedded memory and throughput architecture

This document records the measured causes of the WASIX-postmaster memory and
throughput gap, the product constraints, and the staged architecture for making
the real PostgreSQL postmaster plus fresh `EXEC_BACKEND` model viable in an
embedded memory budget. It is an architecture record, not a claim that the
current source has an admitted carrier; it does not.

## Product invariants

Optimizations in this product must preserve all of the following:

- one real PostgreSQL postmaster, with PostgreSQL's normal auxiliary roles;
- a fresh `EXEC_BACKEND` guest process for every client backend;
- normal PostgreSQL durability, crash recovery, WAL retention, archiving,
  streaming replication, checkpointing, and recycling semantics;
- sealed, compiler-free, exact-AOT product carriers;
- no ambient environment variable that can enable a new acting policy;
- fail-closed behavior when an OS cannot prove the evidence needed by a policy;
- explicit runtime, artifact, carrier, and measurement-tool identities;
- native behavior unchanged by WASIX-only guest patches.

Allocator knobs, smaller PostgreSQL settings, private-state cloning, fixed-address
prelinking, KSM, and sampled-memory tricks are not substitutes for these
invariants.

## Measured memory attribution

The paired c4 indexed-update run under a 1 GiB cgroup measured a WASIX/native
anonymous-memory delta of 52,895,744 bytes (50.445 MiB). The file-cache charges
were effectively equal, so the difference is runtime-private memory rather than
PostgreSQL data.

At quiescent readiness, exact mapping attribution found:

| Owner | Resident anonymous memory | Consequence |
| --- | ---: | --- |
| Wasmer AOT `CodeMemory` | 20,784 KiB | 17,692 KiB RX plus 3,092 KiB adjacent data/custom sections are copied into an anonymous mapping |
| Wasmer live heap and worker arenas | about 24 MiB | `MALLOC_ARENA_MAX=1` merely moved allocations into `brk` and saved less than 1 MiB |
| Four active client instances | about 9,016 KiB above pre-fanout | per-instance structures matter after the fixed engine floor |
| Six guest linear-memory groups at readiness | 2,048 KiB | preinitialized file mappings already avoid a large eager guest-memory copy |
| Resident returned coroutine stacks | less than 1 MiB | virtual reservations are large, but they are not the principal RSS cause |

The copied AOT artifact contains 21,274,624 bytes. Of 5,194 pages, 5,033
(96.90%) receive an absolute relocation in the current non-PIC layout. Mapping
the existing artifact privately would therefore retain at most 161 clean pages,
about 0.629 MiB. A direct `mmap` of today's serialized artifact is not an RSS
solution.

Sparse store snapshots reduce a PostgreSQL snapshot from 174,584 bytes to 129
bytes by recording four mutable globals instead of 10,911 dense global values.
They remove transient allocation/copy work, but the measured active c4 cgroup
anonymous charge remains essentially unchanged. They make no fixed-RSS claim;
their observable scope is backend launch/reconnect latency.

## Measured throughput split

The same c4 indexed-update workload shows two different regimes:

- at 1 GiB, the adaptive-v3 carrier reached a diagnostic paired median
  WASIX/native ratio of 0.867;
- at 512, 384, and `memory.max=256M`/`memory.high=224M` with zero swap, the
  ratios were 0.602, 0.474, and 0.338 respectively.

The exact v3 WAL-action counts expose the timing defect: 16/20 completed
segments acted at 256 MiB, 10/20 at 384 MiB, only 2--4/20 at 512 MiB, and 0/20
at 1 GiB. The one-shot descriptor capability was discarded whenever pressure
had not reached relief level 3 at close. The unique table-plus-index footprint
is about 136.4 MB (130.1 MiB), not 212 MiB; the latter double-counts indexes
already included by `pg_total_relation_size`. The workload also writes about
320 MiB of WAL. Roughly 55 MiB of extra WASIX anonymous residency therefore
leaves very little cache headroom at 224 MiB, and four retained 16 MiB WAL
segments can already displace useful relation pages. Full `smaps` sampling
materially perturbs this workload and must never be used as throughput
evidence.

The v4 unconditional-immediate experiment falsified the claim that retaining
the close-time WAL capability was sufficient. Every v4 point acted on all
20/20 WAL offers (80/80 aggregate), yet its paired c4 indexed-update ratio did
not produce a generally better knee:

| Cgroup memory | v3 ratio | v4 immediate ratio | Outcome |
| ---: | ---: | ---: | --- |
| 256 MiB | 0.3383 | 0.3486 | ratio uptick came from native variance; WASIX median fell 0.71% |
| 384 MiB | 0.4740 | 0.4579 | regression |
| 512 MiB | 0.6022 | 0.5344 | regression |
| 1 GiB | 0.8669 | 0.7598 | regression; bulk p95 gate failed at 1.559 |

At 256 MiB, v4's WASIX median was 53,884 ops/s versus v3's 54,268 ops/s;
the ratio only rose because the paired native median was lower. The result
proves both that the descriptor-loss defect was real and that
unconditional retirement-time eviction sacrifices useful cache behavior when
pressure does not justify it. It is not a candidate win. The v4 acting mode is
restricted to explicitly identified pressure experiments while the paired
stream-open/retirement architecture below replaces it; observe/retain remains
the product default. No release or general embedded profile may enable
unconditional immediate eviction from this evidence.

## Experimental pressure architecture

PostgreSQL emits semantic cache offers at boundaries where it knows more than a
generic host filesystem. The host validates the already-open regular-file
descriptor and exact range; it never reconstructs a database path.

WAL class 6 has two independent version-1 bits:

- bit 0, `WAL_RECLAIM_ELIGIBLE`, preserves the original low-expected-reuse
  predicate (`!XLogIsNeeded()` and non-direct WAL). It is not a correctness
  proof;
- bit 1, `WAL_CACHE_DROP_SAFE`, positively proves an exact fd/segment/timeline
  generation is complete, durable, and buffered. Dropping those cached pages
  cannot remove or change the WAL file. Archivers and walsenders may refault it.

An acting controller must require bit 1. Old guests, flags zero, and bit-0-only
offers remain retain-required. Old hosts reject bit 1 as an errno-preserving,
hint-only call, which is safe.

Adaptive-linux.v5/embedded-v4 preserves the useful capability insight from v4
without retaining its unconditional action rule. Its compact configuration is
bound by SHA-256
`01668b856435cb8c34b2d2324ab55b7f1f5961b8b403c1ee49d9ee4b5c865f53`:

1. Discover a descriptor-pinned cgroup-v2 pressure source with a finite
   effective limit. If discovery or sampling is incomplete, remain
   observe-only.
2. Duplicate only an exact bit-1 WAL offer's already-open regular-file
   descriptor into a path-free capability ledger. A candidate does not act at
   offer time. The ledger is capped simultaneously at four entries, four host
   descriptors, 64 MiB, and a four-second TTL.
3. Keep sampler/clock failure, causal PSI/refault breaker state, advice error,
   and finalization fail-closed. A successful action arms only the exact next
   sample interval; high but flat background pressure is not blamed on it.
4. Resolve the host page size at admission, align every range inward without
   widening it, and record that resolved alignment separately from the sealed
   host-page policy. This admits both 4 KiB and 64 KiB Linux kernels without a
   host-specific configuration identity.
5. Leave relation bulk/vacuum offers observe-only in embedded-v4. Their reuse
   is not proven by the WAL contract, and the measured thousands of small
   relation `DONTNEED` calls did not explain the cliff. The pressure/token
   planner is unsupported in the embedded-v4 profile.
6. Let only a newly acquired sample, at least 250 ms after the prior sample,
   authorize WAL work. It must be in relief level 2 or 3 and at or above the L2
   exit threshold. It drains at most one descriptor-ledger entry; reusing a
   previous high-pressure observation is forbidden. Busy advice is dropped with
   zero retries. The timer may expire and release pins but never advises.
7. Keep the global dirty veto for relations. Bit-1 WAL may bypass that global
   gauge because the exact offered range has already crossed its durability
   boundary; Linux also refuses to discard unwritten dirty pages.
8. Serialize only actionable candidate planning. Normal reads and sync hints
   update saturating telemetry atomics without taking the policy lock. A
   contended relation offer retains, while a contended proven WAL offer may be
   queued after a nonblocking state recheck; PostgreSQL WAL close never waits
   behind another cache-advice syscall.
9. Arm PSI/refault breakers only for the exact sample interval containing a
   successful advice. PSI must worsen relative to a same-source no-advice
   baseline; high but unchanged workload pressure is not attributed to the
   policy. Evaluate that causal window before the next WAL action.
10. Before the first payload write on every normal-writer, walreceiver, or
   bootstrap open, synchronously revoke class 6/flags zero for that exact file
   identity. The host marks a global sequence odd, waits for in-flight action,
   detaches and destroys matching pins, then restores an even sequence. Offers
   enqueue only when one unchanged even sequence surrounds descriptor capture;
   this closes mutation races without paths or unbounded tombstones.
11. Degrade to retain and flush deferred capabilities on sampler/clock errors,
   causal PSI/refault trips, advice errors, or revoke errors.
12. Mirror every validation and offer into the unchanged observe-only record and
   publish acting-policy telemetry separately and atomically.
13. Finalize under the action gate and publish only after queued and in-flight
   work, descriptor capabilities, and mutation identities are zero. Receipt
   fields independently recompute terminal entry and byte totals and require
   exact conservation against all enqueues.

Policy/configuration identity belongs in the sealed manifest and carrier
inventory. Output-path environment variables may select where evidence is
written; they cannot select whether eviction acts.

These rules document an experimental v5 controller. V4's unconditional immediate lane remains falsified and pressure-campaign-only; observe/retain is the supported evidence behavior. V5 makes no correctness, memory, or performance claim.

### Platform cache-relief boundary

The semantic guest proof and admission model are portable; the cache action is
not. A carrier must name its host implementation and fall back to retain when
the host cannot provide equivalent semantics.

| Host | Pressure evidence | Mechanism | Current disposition |
| --- | --- | --- | --- |
| Linux | descriptor-pinned cgroup v2 limit/events/PSI | Experimental v5 range-scoped `POSIX_FADV_DONTNEED` through a bounded, synchronously revoked descriptor ledger | Observe/retain supported; acting v5 experimental; per-I/O mode unsupported |
| macOS | No qualified source | No supported cache-relief mechanism | Observe-only; acting mode unsupported |
| Windows | No qualified source | No supported cache-relief mechanism | Observe-only; acting mode unsupported |

Linux documents `POSIX_FADV_DONTNEED` as an attempt to release cached pages,
ignores partial pages, and does not discard unwritten dirty pages; a zero return
therefore means `advice_accepted`, not physical reclamation
([Linux `posix_fadvise(2)`](https://man7.org/linux/man-pages/man2/posix_fadvise.2.html)).
`POSIX_FADV_NOREUSE` is deliberately rejected for this design. Since Linux 6.3
it changes replacement-recency treatment, but its implementation is whole-file
and does not cover descriptor reads; it neither consumes the one-shot durable
retirement capability nor proves existing WAL pages were released
([Linux NOREUSE implementation](https://github.com/torvalds/linux/commit/17e810229cb3068b692fa078bd9b3a6527e0866a)).

Linux 6.14's `RWF_DONTCACHE` prunes cache instantiated by the particular read or
write, starts writeback for pages it dirties, and explicitly leaves ranges that
were already cached before that operation alone
([Linux `preadv2`/`pwritev2` contract](https://man7.org/linux/man-pages/man2/readv.2.html)).
The generic VFS rejects it with `EOPNOTSUPP` unless the filesystem advertises
support
([VFS capability gate](https://github.com/torvalds/linux/commit/af6505e5745b9f3a670de405b08b73573343c15c));
support was added independently for
[XFS](https://github.com/torvalds/linux/commit/974c5e6139db30fae668e44c381d13bcc63b65fa)
and
[ext4](https://github.com/torvalds/linux/commit/ae21c0c0ac56aa734327e9c8b7dfef4270ab54d4).
Kernel-version detection is therefore insufficient. Per-I/O `RWF_DONTCACHE`
is unsupported by this project; the acting experiment uses only the declared
descriptor-bound `DONTNEED` path.

Apple documents `MS_INVALIDATE` as invalidating cached data for the specified
mapped range
([macOS `msync(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/msync.2.html)),
and the corresponding XNU entry describes `VM_SYNC_INVALIDATE` as discarding
pages while returning dirty/precious pages only under the declared sync mode
([XNU `vm_user.c`](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/vm/vm_user.c#L1122-L1168)).
Apple separately documents `F_NOCACHE` as turning caching off or on for a
descriptor
([macOS `fcntl(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)).
They are different adapters: retirement-time invalidation needs a bounded
mapping of the exact open file object, whereas `F_NOCACHE` must be selected
before WAL writes begin. The macOS receipt must use `mincore` only as physical
residency evidence, never as the semantic action
([macOS `mincore(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/mincore.2.html)).

On Windows, `FILE_FLAG_NO_BUFFERING` is a `CreateFile` contract, not a
post-close hint. Access sizes and offsets must be multiples of the volume's
logical sector and buffer addresses must satisfy physical-sector alignment
([Windows file-buffering contract](https://learn.microsoft.com/en-us/windows/win32/fileio/file-buffering));
write-through and no-buffering are independent creation flags
([Windows `CreateFile`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)).
The adapter must own aligned bounce buffers without changing PostgreSQL's write
grouping, report the queried logical/physical alignment, preserve durability
with the admitted write-through or documented
[`FlushFileBuffers`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
path, and fall back before the first write. Retrofitting `NO_BUFFERING` after a
buffered handle has written is not admissible.

Neither macOS mode nor Windows unbuffered I/O is a drop-in emulation of Linux
`DONTNEED`. Reopening a mutable WAL path, applying a process-wide cache purge,
or silently claiming that a no-op reclaimed memory is forbidden. macOS and
Windows remain observe-only and unsupported for acting cache relief.

### WAL safety and reuse lifecycle

Bit 1 proves cache-drop correctness, not absence of a later reader. The sealed
standalone finite-memory v5 profile retains the capability briefly and acts only
under fresh L2/L3 pressure, treating a later archive/recovery read as a refault.
A general archive/replication profile
must not infer the same reuse policy from `wal_level` or a magic memory cutoff.
No active-consumer/reuse fact or consumer-boundary offer is implemented, so
archive/replication modes always retain.

The following portable hooks are design context only and are unsupported:

```text
wal_stream_open(token, file_identity, generation, range)
wal_segment_retired_durable(
    token, file_identity, generation, range, durability_epoch
)
```

`token` is an unforgeable host capability for the exact HostFS open operation
or still-open file object; it is never a guest path or reusable integer fd.
`file_identity` binds the native volume/mount plus file identity,
`generation` binds timeline and WAL segment, and `range` must be the canonical
whole segment. `wal_stream_open` runs before the first write and atomically
selects buffered, per-I/O drop-behind, descriptor-nocache, or aligned
unbuffered admission. `wal_segment_retired_durable` is accepted exactly once
only after final-page completion and the matching configured durability
operation; its monotonic `durability_epoch` prevents a stale completion from
authorizing a newly reused token. Any identity, generation, range, mode, or
epoch mismatch retains and records failure. Closing or rebinding the token
consumes the generation.

The current version-1 class-6 bit-1 offer plus synchronous class-6/flags-zero
mutation revoke is a safe bounded implementation of only the retirement half
for buffered Linux WAL. V5 retains the exact descriptor capability until a
fresh pressure trigger, mutation, expiry, displacement, or finalization.
Stream-open admission is unsupported. No runtime may
infer the missing open event by watching generic opens or writes.

Every generation ends in exactly one result from this deny-unknown taxonomy:

| Result | Exact meaning |
| --- | --- |
| `admission_bypassed` | The open transaction admitted a descriptor/handle cache-bypass mode and every write satisfied that mode. No retirement-time eviction is claimed. |
| `per_io_dropbehind` | Every eligible write used a capability-probed per-I/O drop-behind mode; any preexisting page range was handled by the declared retirement fallback. |
| `postwrite_invalidated` | A supported host invalidated the exact handle-bound range after the durability epoch, for example qualified macOS `MS_INVALIDATE`. |
| `advice_accepted` | A range advice call such as Linux `POSIX_FADV_DONTNEED` returned success. This does not claim that pages were physically reclaimed. |
| `unsupported` | The OS, kernel, filesystem, mount, handle type, alignment, or sealed profile could not admit a mechanism; the range was retained. |
| `failed` | Validation, I/O, sync, clock, breaker, or host action failed after the hook was available; the controller degraded and retained or used only its already-declared safe fallback. |

Results cannot be collapsed into a success boolean. The per-run capability
receipt binds the hook/ABI version; sealed profile; runtime/carrier identities;
OS and kernel build; filesystem type, mount/volume and file identity; page,
allocation-granule, logical-sector, and physical-sector sizes; probe operation
and exact errno/OS result; admitted mode; generation/range/durability epoch;
fallback; per-result calls and bytes; and raw residency/cgroup evidence digest.
Unknown receipt fields, missing probes, counter imbalance, or a mode/result
combination not permitted by that platform invalidate the run.

Two policies consume the same correctness fact differently:

- `embedded-standalone` defaults to observe/retain. Its separately
  receipt-bound pressure mode may treat a durable writer-retired generation as
  a bounded cache-relief capability and accept a later recovery or consumer
  refault only after a fresh L2/L3 pressure trigger. V4 exercised immediate
  action but falsified it as an unconditional default; v5 removes immediate
  action without weakening archive, recovery, or retention correctness.
- `replication-archive` treats writer retirement as safety, not low reuse. Its
  ordinary path retains while an archiver, walsender, restore, or lagged
  standby may be a near-term consumer. Because no consumer-retirement fact
  exists, that profile always retains and makes no acting-policy claim.

The profiles have distinct manifest/configuration identities. `wal_level`, an
enabled archive command, elapsed time, or a memory cutoff cannot silently
switch between them.

## Runtime-generated relocated code image bridge

The measured 20,784 KiB anonymous `CodeMemory` can be made reclaimable before
the final position-independent carrier format exists.
`RelocatedCodeImage linux-v1` preserves today's absolute relocation model but
moves its published bytes to a reclaimable regular-disk inode. This is a strict
Linux bridge, not a new cross-platform artifact format.

### Linux-v1 construction and publication

The loader performs one transaction per activated AOT module:

1. Open the receipt-bound private scratch directory by trusted directory fd.
   Create an unnamed mode-0600 `O_TMPFILE`, verify a regular inode and the exact
   mount/filesystem identity, reject tmpfs, ramfs, memfd, DAX, network, or an
   unqualified filesystem, and preallocate the complete page-aligned image so
   allocation failure is handled before publication. Linux defines
   `O_TMPFILE` as an unnamed regular file that disappears with its last reference
   ([Linux `open(2)`](https://man7.org/linux/man-pages/man2/open.2.html)). A
   `memfd` is explicitly RAM-backed and uses anonymous memory, so it cannot
   support this RSS/reclaimability claim
   ([Linux `memfd_create(2)`](https://man7.org/linux/man-pages/man2/memfd_create.2.html)).
2. Reserve the complete final virtual-address interval as runtime-owned
   `PROT_NONE`. Validate page-aligned, nonoverlapping RX, RO, and bounded RW
   fixup segments and every relocation destination before replacing any page.
   `MAP_FIXED` is allowed only inside this exact still-owned reservation; Linux
   otherwise documents it as destructive to overlapping mappings
   ([Linux `mmap(2)`](https://man7.org/linux/man-pages/man2/mmap.2.html)).
3. Size and preallocate the inode, then map the final RX/RO extent at the final
   address as `MAP_SHARED|PROT_READ|PROT_WRITE`, never executable. Copy the
   verified serialized bytes once and apply all current absolute relocations in
   place. Reject a relocation into an undeclared page, overflow, unsupported
   width/kind, overlapping segment, or any page that would remain writable and
   executable.
4. Flush the CPU instruction cache where the architecture requires it, compute
   the relocated layout digest, `msync(MS_SYNC)` and `fdatasync` the exact
   extent, and obtain an identity-checked read-only description of the same
   unnamed inode. Remove write access from the complete staging view before
   closing every writable file description. The runtime must prove there is no
   leaked writable mapping or duplicated `O_RDWR` fd; either invalidates strict
   mode.
5. Replace only the owned reservation with page-aligned `MAP_PRIVATE` views from
   that read-only description: RX for native instructions, RO for constants and
   metadata, and a separately bounded anonymous RW fixup area where mutation is
   genuinely required. Replacement occurs without an unreserved address-space
   gap. There is no writable executable alias: staging is RW/NX, the complete
   staging view becomes inaccessible, and only then is final code RX. Linux
   protections distinguish read, write, execute, and none at page granularity
   ([Linux `mprotect(2)`](https://man7.org/linux/man-pages/man2/mprotect.2.html)).
6. Revalidate every function, trampoline, unwind, trap, custom-section, and
   fixup pointer against the final views. Wasmer may collect in-memory unwind
   descriptors while copying, but OS-visible unwind/frame and trap registration
   occurs only after W^X finalization. Then atomically publish the finished
   `CodeMemory`. On destruction, stop new users, deregister unwind/trap
   metadata, wait for the existing runtime ownership barrier, unmap views, and
   finally release the inode.
7. Drop only clean construction-induced residency after publication. A
   discard/advice return is recorded separately from subsequent `mincore`,
   `smaps`, fault, and cgroup evidence; it is never itself reported as bytes
   reclaimed. Demand faults then warm the actually used PostgreSQL paths from
   the held disk inode, while cold pages remain reclaimable.

The module registry key is the exact AOT digest, target/CPU policy, runtime ABI,
relocation recipe, and final base/layout. Construction is single-flight and
bounded; all stores in the host process share the one published immutable code
image, while mutable fixups remain at their declared ownership level. Absolute
relocations prevent cross-process sharing. The Linux relocated-code bridge is
the complete claim; a cross-process `NativeCodeImage` is unsupported.

### Failure, identity, and compatibility contract

No partially transitioned image is visible. Any validation, scratch,
preallocation, write, sync, read-only-handle, fixed-map, protection, digest, or
metadata-registration failure rolls back before publication. A carrier that
declares `relocated-code-image-linux-v1=strict` fails startup rather than
silently allocating anonymous code. A separately identified
`anonymous-code-memory-compat-v1` carrier may use the existing loader on macOS,
Windows, read-only/noexec installations, and unqualified Linux filesystems, but
its receipt reports anonymous ownership and makes no bridge RSS claim.

The strict receipt binds carrier/AOT/runtime/relocation identities; scratch
directory and mount identities; filesystem type and mount flags; page size;
inode device/number, runtime allocation generation, and exact length;
preallocation/sync results;
segment offsets, lengths, protections, and relocated digest; writable-handle
closure proof; unwind/trap registration lifetime; discard results; page-fault
counts; and before/after `smaps` plus cgroup `anon`/`file` evidence. It also
records bytes written and construction count so startup latency and flash wear
are first-class gates. O_TMPFILE crash cleanup, noexec, disk-full, inode
pressure, and abrupt teardown are tested explicitly.

This bridge succeeds only if the same workload moves `CodeMemory` from
anonymous to clean file-backed accounting and preserves balanced throughput,
tail latency, unwind/error behavior, and cold-start faults under pressure. With
`swap.max=0`, memfd/tmpfs can change a mapping label but cannot substantiate the
required reclaim-to-disk property.

## Durable file-backed native code image

The largest fixed anonymous owner requires a new artifact, not a loader trick.
`NativeCodeImage v1` is an offline-prelinked, position-independent image with:

- page-aligned file-backed RX and RO segments;
- a small anonymous private fixup/RELRO segment;
- function, trampoline, custom-section, and unwind descriptors expressed as
  RVAs;
- local PLT stubs and a deduplicated private import table for host libcalls;
- one canonical exception-personality import cell;
- target, CPU policy, linker identity, ABI, segment, and payload digests.

The producer reuses Wasmer's object emitter and a target system linker offline.
It must reject unknown relocations, text relocations, undefined symbols,
overlapping segments, W+X pages, range overflow, or any residual relocation
whose destination is RX/RO. The runtime mapper verifies the immutable carrier
handle, reserves an address range, maps RX/RO from that same handle, populates
the bounded private fixup area, makes RELRO read-only, and only then registers
unwind/trap metadata and publishes `base + RVA` pointers.

The current artifact ABI remains an explicit development fallback. Strict
carriers must bump artifact/runtime/carrier identity before admitting the new
image.

Platform backends are different implementations of this same format contract:

- Linux: `PROT_NONE` reservation, `MAP_PRIVATE|MAP_FIXED` file mappings, and
  anonymous fixup pages; verification pages may be dropped after hashing.
- macOS: vnode-backed private mappings with strict W^X and qualified compact
  unwind/hardened-runtime behavior. `MAP_JIT` is unnecessary when executable
  pages are never writable.
- Windows: reserved placeholders, 64 KiB-aligned file views, private committed
  fixups, DEP/CFG/CET qualification, and `RtlAddFunctionTable`/
  `RtlDeleteFunctionTable` lifetime ordering.

Unsupported targets reject strict native-code images; they do not silently
activate an anonymous JIT-style copy.

## Owner-census diagnostic carrier

Allocator and mapping labels are not sufficient ownership evidence. Before
compacting per-instance state, build a separate
`runtime-owner-census-linux-v1` diagnostic carrier feature. It has its own
runtime ABI and immutable carrier identity, cannot be enabled by an ambient
environment variable, and is never used as throughput qualification evidence;
its counters and registry perturb the process being measured.

The in-runtime census has two deliberately different instruments:

- a fixed-capacity range registry covers `CodeMemory` segments, guest linear
  memory reservations/committed windows, and coroutine-stack
  reservations/committed windows. Registration returns an allocation-generation
  token; only that token can update or remove the slot, so an old destructor
  cannot erase a reused address. The registry performs no unbounded allocation,
  growth, path lookup, or stack capture. Capacity, occupied/high-water slots,
  collision, overflow, stale-drop, and inconsistent-snapshot counters are
  sealed and receipted. Overflow makes the census incomplete; it never falls
  back to an unbounded map.
- saturating aggregate counters cover heap-owned `StoreObjects`, `VMInstance`,
  `VMTable`, imports/funcrefs/globals, worker/task records, and returned-stack
  pool entries. They report live, capacity, high-water, allocation, and release
  cardinalities. Unless the allocator provides an exact exclusive span, a
  counter is not converted into bytes by multiplying `size_of` by count.

Every record declares one ownership shape:

| Shape | Meaning and aggregation rule |
| --- | --- |
| `exclusive` | An exact disjoint allocated/mapped interval owned by this class; it may participate in the exact-range byte subtotal. Two live exclusive ranges may not overlap. |
| `overlap` | An alias, view, or child interval whose parent is named explicitly; report it for attribution but never add it again. |
| `virtual` | Reserved address space or guard capacity; report start/end and committed subrange but make no residency or allocation-byte claim. |
| `cardinality` | An object count without a stable exclusive address interval; report counts/capacities only. |

There is no synthetic `runtime_total_bytes`. Only nonoverlapping `exclusive`
ranges may be summed, and cardinality, virtual capacity, overlapping views,
allocator-owned heap bytes, PSS, and cgroup charge remain separate fields.
Address overflow, an unknown ownership shape, missing parent, exclusive
overlap, generation imbalance, or counter underflow invalidates the snapshot.

### Commit and OS reconciliation

At each post-activation, idle-role, active-c1/c4/c8, and drained boundary, the
runtime appends the complete bounded census record **before** the existing
runtime-writer flush/fence record and separate committed ACK. The ACK contains
the exact synced-log end offset, so a validator freezes only a prefix that
already contains the owner record. Sampling cannot move the fence or ACK and
the workload never waits for `/proc` parsing on its hot path.

After observing the committed ACK, the external Linux collector captures PID
plus `/proc/PID/stat` start time before and after one complete `smaps` read and
the cgroup sample. A changed birth identity, partial/raced read, lifecycle
sequence change, or missing cgroup key invalidates the row. Linux defines
`starttime` as time since boot
([Linux `/proc/PID/stat`](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html))
and documents `smaps` PSS, anonymous, clean/dirty, and mapping fields
([Linux `/proc/PID/smaps`](https://man7.org/linux/man-pages/man5/proc_pid_smaps.5.html)).

The reconciler splits OS mappings only at exact registered boundaries and
attributes PSS/anonymous bytes only where a complete VMA or independently
measurable mapping can be assigned without guessing. A subrange inside an
allocator arena remains `ambiguous_heap`; bytes are not apportioned by virtual
length. It publishes:

```text
attributed_exact_anon_pss
attributed_exact_file_pss
ambiguous_heap_anon_pss
unattributed_anon_pss
```

`unattributed_anon_pss` is the observed process `Pss_Anon` less only exact
attributions. A negative residual is a reconciliation error, not a value to
clamp to zero. The raw `smaps`, owner record, ACK, validator, and resulting
attribution digests are all receipt-bound.

Cgroup v2 is an independent process-tree envelope: `memory.stat` includes
anonymous memory, page cache, and kernel-owned charges
([Linux cgroup-v2 memory controller](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#memory)).
Its `anon`, `file`, `shmem`, kernel, current/peak, events, PSI, and swap values
are recorded beside, not forced to equal, summed process PSS. Differences can
come from page-cache charge ownership, shared-page proportional accounting,
kernel memory, sampling boundaries, and tasks outside a single PID. A census
passes when identities and conservation rules reconcile; equality between PSS
and cgroup charge is neither expected nor manufactured.

The first diagnostic goal is to account for the measured roughly 24 MiB live
runtime heap, validate the fixed `CodeMemory` owner, and measure the c1/c4/c8
slope. Only then can a release optimization claim which owner and lifecycle it
changed.

## Per-instance compaction after ownership census

These changes are secondary to the file-backed code image and require the
owner-census receipt above first:

- dense-rank or lazily materialize only funcref-observable local functions;
  the measured conservative opportunity is about 389,824 bytes per backend;
- pool non-exported immutable globals while preserving imported expressions,
  mutable globals, exported handle identity, side modules, and snapshots;
  the conservative opportunity is about 349 KiB per backend;
- remove the duplicate raw table pointer vector while keeping the hot
  `VMCallerCheckedAnyfunc` representation; about 37,912 bytes per backend;
- bound returned coroutine-stack ownership and discard resident payload pages;
- measure, then consider file-backed immutable bases for small guest-private
  ranges only when they preserve fresh-instance isolation.

Each compaction gets its own exact before/after owner record, `smaps` and cgroup
receipt. No saving is claimed from a type-size estimate alone.

## Evidence boundary

The implemented Linux research mechanisms have independent evidence scopes. They do not compose into an aggregate embedded-viability, release, cross-platform, crash-recovery, or performance claim.
