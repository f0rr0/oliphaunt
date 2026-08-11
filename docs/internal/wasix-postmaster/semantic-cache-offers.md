# Semantic cache offers

Patches `0007-wasix-semantic-relation-cache-offers.patch` and
`0009-wasix-inactive-durable-wal-cache-offer.patch` add narrow guest-side seams
for a product-owned page-cache controller. The pinned libc and Wasmer patches
implement their shared version-1 ABI. The exact sealed product always installs
an observe-only mirror and may separately admit a narrowly bounded Linux
adaptive candidate for `runtime:postgres`. The mirror records demand and
always retains pages. Neither role intercepts generic file I/O or changes
PostgreSQL durability.

## Why the seam is semantic

The host cannot reliably infer PostgreSQL reuse or durability from `read`,
`write`, and `fsync` calls alone. The patch therefore offers only facts known at
existing PostgreSQL boundaries:

- `ProcessReadBuffersResult()` offers exactly the newly completed, non-temporary
  relation blocks. Shared-buffer hits do not produce offers. The existing
  `BufferAccessStrategy` maps reads to normal, bulk-read, or vacuum classes.
- `mdsyncfiletag()` offers the exact segment only after its checkpointer
  `FileSync()` succeeds.
- `mdimmedsync()` offers each segment only after its immediate `FileSync()`
  succeeds. Its class is distinct because near-term reuse differs from a
  checkpoint sync.
- The WAL writer offers one full segment only when closing the same descriptor,
  segment number, and timeline generation whose final-page writes and
  `issue_xlog_fsync()` completed successfully with `enableFsync`. Opening or
  writing a generation invalidates that proof; partial, bootstrap, mismatched,
  and unsynced generations do not offer. The generation also captures whether
  its descriptor was opened for synchronous writes, so an `fsync` SIGHUP
  transition cannot reinterpret an older descriptor as `O_SYNC`/`O_DSYNC`.
  “Inactive” means writer-inactive, not unreachable: an archiver or walsender
  may still reread the segment from the durable file. PostgreSQL sets bit 1,
  `WAL_CACHE_DROP_SAFE`, after a complete durable buffered-WAL generation; it
  independently adds the legacy bit 0, `WAL_RECLAIM_ELIGIBLE`, only when its
  existing `!XLogIsNeeded()` low-reuse predicate also holds. Direct WAL carries
  neither bit.

The numeric version-1 classes are stable guest/host ABI input:

| Value | Class |
| ---: | --- |
| 1 | relation read, normal strategy |
| 2 | relation read, bulk-read strategy |
| 3 | relation read, vacuum strategy |
| 4 | relation durable after checkpointer sync |
| 5 | relation durable after immediate sync |
| 6 | completed durable, writer-inactive WAL segment |

Relation read ranges are split defensively at `RELSEG_SIZE` boundaries in
`md.c`. Relation offers use the exact `MdfdVec` virtual descriptor already
opened by PostgreSQL. The VFD layer does not call `FileAccess()`: if its raw
descriptor has already been reclaimed, the hint returns `EBADF` rather than
reopening a mutable path or perturbing the descriptor LRU. A length of zero on
a post-sync relation offer means the whole segment through EOF. WAL close uses
the exact still-open raw descriptor and range `[0, wal_segment_size)` before
the descriptor can be reused.

## Failure and portability contract

Every added behavior is compiled only for `__wasi__`. Native PostgreSQL follows
the same preprocessed control flow as upstream PostgreSQL 18.4.

The public `<wasix/cache_offer.h>` wrappers save and restore `errno` around
every offer and revoke. The caller ignores the positive errno result, so an
invalid, unsupported, rejected, or failed hint cannot change the database
operation's result. They import exactly:

```text
oliphaunt_postmaster_v1.fd_cache_offer
(i32 fd, i64 offset, i64 length, i32 class, i32 flags) -> i32 errno

oliphaunt_postmaster_v1.fd_cache_revoke
(i32 fd, i32 class, i32 flags) -> i32 errno
```

The scalar ABI contains no guest pointers and is therefore identical for
Wasm32 and Wasm64. Version 1 accepts only classes 1 through 6. Flags are zero
for classes 1 through 5. Class 6 accepts either zero (retain-required,
including every older guest), bit 0
`PG_WASIX_CACHE_OFFER_V1_FLAG_WAL_RECLAIM_ELIGIBLE`, bit 1
`PG_WASIX_CACHE_OFFER_V1_FLAG_WAL_CACHE_DROP_SAFE`, or both. Either class-6
bit on another class and every unknown bit are `EINVAL`.
The offer host requires `FD_ADVISE`, an open regular host-backed descriptor, a
nonnegative signed range, and a representable finite end. Invalid range/class/
flags return `EINVAL`, missing rights returns `ENOTCAPABLE`, missing or
non-regular descriptors return `EBADF` (pipes return `ESPIPE`), and synthetic
regular files return `ENOTSUP`. Revoke accepts only class 6 and flags zero, and
applies the same exact-descriptor validation. With no controller, either valid
call succeeds and retains the range. The observe-only offer path adds no
descriptor pin. The admitted v5 acting path duplicates only a proven bit-1 WAL
descriptor with `F_DUPFD_CLOEXEC` and owns that narrow capability until action,
revoke, expiry, bounded displacement, error, or finalization.

The positive flags are backward-safe in both directions. An old host rejects
an unknown bit with `EINVAL`, which is harmless because the guest preserves
`errno` and ignores the hint result. A new acting host treats an old guest's
flags-zero class-6 offer as retain-required. It also treats legacy bit 0 as a
reuse hint only: no host may infer cache-drop safety from class 6 or bit 0.

This pointer-free version-1 ABI is intentionally a retirement-only seam. The
project does not implement portable open/write lifecycle hooks. Unsupported
design context for a handle-bound interface is recorded in
[semantic-wal-cache-offers.md](semantic-wal-cache-offers.md#unsupported-portable-handle-lifecycle-design-context);
it is not a runtime or support claim.

The controller is an `Arc` owned by the Wasmer runtime and forwarded through
runtime wrappers. Every fresh EXEC_BACKEND `WasiEnv` therefore shares one
controller and one set of counters; it is not copied per backend. Only an exact
sealed `runtime:initdb` or `runtime:postgres` identity installs the postmaster
controller. The aggregate Wasmer/libc patch digests feed the compile-time
runtime ABI identity, and the guest module's required versioned import is the
exact-pin ABI boundary.

Set `OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE` to an absolute host path to
publish deterministic version-2 observe JSON at workload completion. The
executor derives a distinct `.adaptive.json` sibling for acting-policy or
portable-fallback evidence; this environment variable selects output paths,
never policy activation. Publication writes and syncs a private sibling,
atomically renames it, and syncs the parent directory.
The record binds the ABI module/function/signature, compiled runtime ABI ID,
sealed workload, observe-only policy ID, per-class calls/finite bytes/
through-EOF calls, the class-6 reclaim-eligible subset in the same dimensions,
and every validation outcome. The controller never calls
`advise` in this mode; a successful hint or telemetry record is not evidence of
reclamation.

The sealed manifest explicitly requests
`oliphaunt.wasix-postmaster.file-cache.adaptive-linux.v5`, binds the sole
`oliphaunt.wasix-postmaster.file-cache.adaptive-linux.embedded-v4`
configuration digest, and requires observe-only portable fallback.
The compact deny-unknown configuration SHA-256 is
`01668b856435cb8c34b2d2324ab55b7f1f5961b8b403c1ee49d9ee4b5c865f53`.
Only `runtime:postgres` can activate it, and only after a finite,
descriptor-pinned Linux cgroup-v2 pressure source and the bounded maintenance
runtime are proved. `runtime:initdb`, non-Linux hosts, and missing or unbounded
pressure sources stay observe-only. The adaptive controller uses the exact
already-open validated handle. A deferred WAL candidate pins that handle and
its descriptor generation; it stores no path or raw descriptor and revalidates
identity, size, and timestamps before advice. It never reopens a path or
intercepts generic I/O.

Relation bulk/vacuum ranges are validated and observed but do not act in
embedded-v4. There is no immediate WAL lane. A bit-1 offer with offset zero, a
complete canonical PostgreSQL segment size from 1 through 16 MiB, and exact
alignment with no trimming may enter a descriptor-only ledger capped at four
entries, four host descriptors, 64 MiB, and a four-second TTL. Busy outcomes
are never retried. Only a newly acquired sample at least 250 ms after the prior
sample can trigger work, only in relief level 2 or 3, and it can advise at most
one ledger entry. The expiry task releases pins but never performs advice.

Every normal-writer, walreceiver, and bootstrap open arms one synchronous
class-6/flags-zero revoke before its first WAL payload write. The host changes a
global offer epoch to odd, waits for the action gate, removes the matching
descriptor identity, destroys those pins, and only then publishes the next even
epoch and returns. An offer can enqueue only if the same even epoch surrounds
its descriptor capture. This closes offer/mutation races without paths,
unbounded tombstones, or a guest-visible raw host descriptor. Any sampling,
clock, breaker, advice, pin, or revoke error fails closed. Terminal telemetry
must report zero queued and in-flight entries, zero open descriptor
capabilities, zero mutation-epoch identities, and exact entry/byte conservation.
Acting and fallback telemetry remains separate from the stable observe stream.
The acting controller is experimental and makes no crash-recovery,
archive/replication/refault, pressure-breaker, RSS, latency, or throughput claim.

The completed v4 memory knee is a falsification, not support evidence: all
80/80 WAL offers acted, but v4 regressed v3 at 384 MiB, 512 MiB, and 1 GiB and
failed the 1 GiB bulk p95 gate. The unconditional immediate configuration is
therefore pressure-campaign-only. Observe/retain remains the supported behavior
outside those explicitly identified experiments.

Qualification has two deny-unknown acceptance policies. The default
`portable-correctness-v1` accepts either exact active-v5 telemetry or the exact
portable fallback schema, so non-Linux correctness campaigns remain valid.
An explicitly constrained Linux performance run selects
`constrained-linux-wal-action-v1`; that policy requires a sealed finite-cgroup
run and rejects fallback, active telemetry with no class-6 offers, or class-6
offers with no successful advice. It also requires positive class-6 advised
bytes, a current admitted sample, at least one fresh L2/L3 descriptor-ledger
trigger, terminal conservation, and zero sampler, clock, advice, pin, or revoke
errors. Each sample is bound to the exact transient
cgroup identity and configured memory
limits, host monotonic launch interval, raw telemetry digest, sealed manifest,
policy/config identities, and frozen validator digest. The outer qualifier
revalidates those raw inputs rather than trusting a transferable validation
row.

## Scope checks

Run the patch's static and clean-apply check against an exact clean PostgreSQL
18.4 worktree:

```sh
python3 postgres/patches/0007-wasix-semantic-relation-cache-offers.test.py \
  --postgres-source /path/to/clean/postgresql-18.4
python3 postgres/patches/0009-wasix-inactive-durable-wal-cache-offer.test.py \
  --postgres-source /path/to/clean/postgresql-18.4
```

The source lock binds the patch bytes, PostgreSQL tag, available ABI state,
versioned module/function, and pointer-free signature. The test also rejects
direct `DONTNEED`, path reopening, generic interception, or edits outside each
patch's intended PostgreSQL seams.
