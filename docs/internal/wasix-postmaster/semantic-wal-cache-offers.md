# Semantic inactive-durable WAL cache offers

Patch `0009-wasix-inactive-durable-wal-cache-offer.patch` extends the
versioned cache-offer seam from patch `0007` with the one WAL lifecycle fact
that the host cannot reconstruct safely: the current writer has completed a
whole segment and PostgreSQL's configured durability operation has succeeded.
It does not enable eviction.

## Guest state contract

The WASIX-only state is bound to file descriptor, WAL segment number,
timeline, whether the descriptor was opened with enabled sync-open semantics,
and `complete_and_durable`. Descriptor identity alone is not enough because a
closed descriptor number can be reused for another segment.

| Event | State transition | Can the next close offer? |
| --- | --- | --- |
| `XLogFileInit` or `XLogFileOpen` | Bind the exact fd/segment/timeline, capture enabled sync-open semantics, clear the proof, and arm one mutation revoke | No |
| First payload write on a normal-writer, walreceiver, or bootstrap open | Clear the revoke arm, synchronously revoke class 6/flags zero, then continue to the existing write | No |
| Any later `XLogWrite` write group | Clear the proof before the first `pg_pwrite` | No |
| Partial or ordinary flush | No completion transition | No |
| `finishing_seg`, final-page writes complete, `issue_xlog_fsync` returns, `enableFsync` is true | Set the proof for the matching identity | Yes |
| Bootstrap WAL | Bind false, then reset before its direct close | No |
| `XLogFileClose` | Validate and consume the exact proof, then reset before the fd can be reused | At most once |

The `finishing_seg` branch is important. Its write loop either writes the full
last page or raises PANIC. `issue_xlog_fsync` then either satisfies the selected
fsync/fdatasync method or raises PANIC. For `open_sync` and `open_datasync`, the
function returns without an extra syscall because successful writes on the
synchronously opened descriptor already provide the configured durability
semantics. The state records that fact when the descriptor is opened. This
matters because `fsync` is reloadable: changing it from false to true cannot
retroactively add `O_SYNC` or `O_DSYNC` to an already open descriptor. Such a
generation remains ineligible. If `enableFsync` is false at completion,
returning from `issue_xlog_fsync` is likewise not a durability proof.

The other `issue_xlog_fsync` call in `XLogWrite` can flush a partial active
segment. It deliberately does not establish eligibility.

## Offer contract

A close carrying a valid completion/durability proof invokes the
errno-preserving `pg_wasix_cache_offer` wrapper before `close` with:

- the still-open exact descriptor;
- offset zero and length `wal_segment_size`, meaning exactly
  `[0, wal_segment_size)`;
- class `PG_WASIX_CACHE_CLASS_WAL_INACTIVE_DURABLE` (version-1 class 6);
- bit 1, `PG_WASIX_CACHE_OFFER_V1_FLAG_WAL_CACHE_DROP_SAFE`, whenever the
  completed durable segment used buffered rather than direct WAL I/O; and
- the legacy bit 0, `PG_WASIX_CACHE_OFFER_V1_FLAG_WAL_RECLAIM_ELIGIBLE`, in
  addition to bit 1 only when `!XLogIsNeeded()`.

No new `posix_fadvise` call is added. A completed durable class-6 offer is
always emitted, so `XLogIsNeeded()` does not suppress semantic evidence. Here,
"inactive" means inactive for the WAL writer. An archiver or walsender may
still reread the segment, but it does so from the still-present durable file;
dropping clean cached pages changes neither file lifetime nor correctness and
the reader can refault them. Bit 1 records that independent safety proof. Bit
0 deliberately keeps PostgreSQL's narrower pre-existing low-reuse predicate.
Direct WAL carries flags zero because it has no buffered page-cache range to
reclaim.

The positive encoding is the compatibility boundary. An acting newer host
must retain class 6 unless bit 1 is present; class alone, flags zero, and the
legacy bit 0 are not safety proofs. An older host rejects an unknown bit with
`EINVAL`; the errno-preserving, ignored hint then changes neither PostgreSQL
I/O nor durability. Sealed guest and host artifacts are nevertheless rebuilt
together and bound by the runtime ABI digest.

## Unsupported portable handle-lifecycle design context

The project does not implement version-2 handle-lifecycle hooks. The following
interface is design context only and carries no runtime, platform, or support
claim. Such an external design would use two handle-bound hooks:

```text
wal_stream_open(token, file_identity, generation, range)
wal_segment_retired_durable(
    token, file_identity, generation, range, durability_epoch
)
```

The first hook would be inside the HostFS open transaction, before the first WAL
write. It may admit buffered I/O, Linux per-I/O drop-behind, macOS descriptor
nocache, or Windows aligned unbuffered I/O. `token` is an unforgeable runtime
capability for that exact open transaction/file object, not a guest path or
reusable fd. Native mount/volume plus file identity, timeline/segment
generation, and canonical whole-segment range are bound at admission.

The second hook would consume that same generation exactly once after final-page
completion and the matching configured durability operation. Its monotonic
`durability_epoch` prevents a stale completion from authorizing a rebound
handle. Any token, identity, generation, range, admission mode, or epoch
mismatch retains and reports failure. The existing bit-1 class-6 call maps only
to this second boundary for a buffered Linux descriptor; generic open/write
interception may not synthesize the missing first boundary.

Such a design would give every admitted generation one deny-unknown terminal result:

- `admission_bypassed`: a stream-open cache-bypass mode remained valid for all
  writes;
- `per_io_dropbehind`: every eligible write used a capability-probed
  drop-behind mode and the declared retirement fallback covered preexisting
  cache;
- `postwrite_invalidated`: a supported host invalidated the exact handle range
  after the durability epoch;
- `advice_accepted`: a retirement advice syscall returned success, without a
  claim that memory was physically reclaimed;
- `unsupported`: OS/filesystem/handle/alignment/profile admission was
  unavailable and the range was retained; or
- `failed`: validation, write-mode, durability, breaker, or host action failed
  and the controller retained or used only its predeclared safe fallback.

The complete platform semantics, exact capability-receipt fields, and why
Linux `NOREUSE`, macOS `MS_INVALIDATE`/`F_NOCACHE`, and Windows
`FILE_FLAG_NO_BUFFERING` are distinct adapters are specified in
[embedded-memory-architecture.md](embedded-memory-architecture.md#platform-cache-relief-boundary).

## Policy boundary and qualification

The research runtime keeps the observe-only controller as an exact mirror: it validates
and counts every offer and retains every page in its own role. PostgreSQL's
sealed `runtime:postgres` identity may additionally select the receipt-bound
adaptive-linux.v5/embedded-v4 controller; `runtime:initdb`, unsupported hosts,
and hosts without a finite cgroup-v2 pressure source remain observe-only. The observe
stream's version-2 telemetry schema remains stable and reports the legacy
reclaim-eligible subset separately. The patch does not change fsync,
`full_page_writes`, `synchronous_commit`, `wal_level`, archiving, streaming,
recycling, retention, or close behavior.

The adaptive role requires bit 1, offset zero, and a complete canonical
PostgreSQL segment size no larger than the sealed 16 MiB emergency ceiling. The
range must already be exactly host-page aligned; advice never trims or slices
it. A qualifying offer duplicates only the exact already-open regular-file
descriptor into a ledger capped at four entries, four descriptors, 64 MiB, and
a four-second TTL. The offer never advises immediately. Only a newly acquired
cgroup-v2 sample at least 250 ms after the preceding sample, in relief level 2
or 3, can select at most one ledger entry. Busy advice is dropped without retry.
The selected durable WAL range may bypass the unrelated cgroup-global dirty-file
veto; Linux still refuses to discard unwritten dirty pages. The maintenance
timer expires capabilities but never performs advice. Relation ranges remain
observe-only in embedded-v4, and WAL without bit 1 never enters the ledger.

Descriptor lifetime does not replace mutation ordering. Before the first WAL
payload write on each normal-writer, walreceiver, or bootstrap open, PostgreSQL
issues the pointer-free synchronous revoke with class 6 and flags zero. The host
establishes an odd global revoke epoch, waits for any in-flight advice, detaches
the matching file identity, destroys its descriptor capabilities, then restores
an even epoch before returning. An offer captured across that boundary is
rejected instead of enqueued. Final telemetry proves zero open capabilities and
exactly reconciles every enqueued entry and byte with advice, revoke, expiry,
bounded displacement, invalidation, error, or finalization.

The embedded standalone profile defaults to observe/retain. Its separately
receipt-bound v5 pressure mode may retain the writer-retired bit-1 capability
briefly and consume it only after a fresh L2/L3 sample, accepting later archive,
recovery, or standby reads as refaults.
A replication/archive profile treats the same event as a safety proof rather
than a low-reuse proof: its path always retains while an archiver, walsender,
restore, or lagged standby may consume the segment. No consumer-retirement or
bounded-emergency policy is implemented. Neither
`wal_level`, archive enablement, elapsed time, nor a memory threshold may
switch profiles implicitly.

### V4 falsification and disposition

The completed v4 knee acted on 20/20 offers at each of 256 MiB, 384 MiB,
512 MiB, and 1 GiB (80/80 aggregate), but its paired c4 indexed-update ratios
were 0.3486, 0.4579, 0.5344, and 0.7598. The corresponding v3 ratios were
0.3383, 0.4740, 0.6022, and 0.8669, and the v4 1 GiB bulk p95 gate failed at
1.559. Closing the lost-capability gap was therefore necessary but not
sufficient: unconditional immediate retirement eviction regressed the three
larger budgets.

This is a falsification result, not a supported acting policy. The v4 acting
controller is retained only for explicitly identified finite-cgroup diagnostic
campaigns. Observe/retain is the supported evidence behavior, and no general
embedded, archive, or replication mode may infer unconditional eviction from
this evidence. The v5 acting controller is experimental and makes no rollover,
crash/restart, archive/streaming, pressure/refault, RSS, latency, throughput, or
production-safety claim.
