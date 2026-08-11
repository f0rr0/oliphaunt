# Checkpoint, WAL recycle, and clean postmaster recycle qualification

This lane asks whether the fresh-backend WASIX postmaster remains viable when
durable write traffic, periodic checkpoints, WAL retention, and a clean
postmaster recycle are included. It does not replace the single-backend
architecture and it makes no release claim. Every result is explicitly
`research-only-*-non-release`.

## Why this is a separate lane

The steady query benchmarks showed that process RSS alone is the wrong control
surface for an embedded database. Under write load, the cgroup also charges
PostgreSQL data and WAL page cache, dirty/writeback pages, page tables, and
kernel memory. In the observed high-water samples, charged file memory was a
larger pressure source than anonymous runtime memory. Reducing Wasmer stack
reservation or retaining a warm worker cannot bound that file-backed component.

The qualification therefore controls and reports two different quantities:

- summed process PSS, PSS-anon, private pages, and page tables; and
- scope-wide `memory.current`, `memory.peak`, swap, selected `memory.stat`,
  `memory.events`, and memory PSI counters.

The standalone WASIX server runs in a fresh cgroup-v2 scope with
`MemoryMax=256M`, `MemoryHigh=224M`, and `MemorySwapMax=0`. A second fresh scope
is created after clean shutdown. The epoch receipt binds each sample stream to
its distinct cgroup path, filesystem identity, creation timestamp, and limits.
Cumulative counters are counted from the fresh-scope zero boundary, not from
the first process sample, so startup pressure is not subtracted away. Rates use
the sum of observed epoch durations, excluding the process-free recycle gap;
the second startup boundary is also gated independently.

## Workload semantics

The probe is a compiled libpq client linked to the exact native-oracle libpq.
It opens four persistent connections and offers 15 transactions per second per
client using absolute `CLOCK_MONOTONIC` deadlines. Each transaction performs
exactly 48 updates, 16 inserts, and 8 reads in one PostgreSQL transaction. The
updated and inserted payloads are 512 bytes so the lane exercises WAL and
writeback instead of measuring a read-mostly toy workload.

The evidence validator reconstructs the exact per-client schedule from the
configured interval and stagger. It verifies every scheduled timestamp,
deadline lateness, sequence, result shape, realtime/monotonic duration, and
flush receipt. Late offers are skipped by the probe rather than caught up in a
burst, and any skip fails qualification. Achieved TPS is calculated over the
observed monotonic window rather than the configured duration.

The checkpoint policy is intentionally explicit:

- `checkpoint_timeout=30s` and `checkpoint_completion_target=0.9`;
- `max_wal_size=256MB` and `min_wal_size=64MB`;
- WAL recycling enabled, archiving and WAL retention consumers disabled;
- checkpoint logging plus WAL and I/O timing enabled; and
- the existing embedded runtime and durability profiles remain in force.

The paired lane starts a new cluster and postmaster for every position in an
ABBA/BAAB block. Adjacent positions form native/WASIX pairs, which bounds drift
without sharing a warm runtime. PostgreSQL settings are captured and hashed;
each pair must have the same command-line settings. Diagnostic and qualification
modes gate both absolute WASIX latency and paired native/WASIX ratios. Smoke
mode still gates structure, durability, offered-load completion, WAL volume,
and checkpoint overlap, but only observes the latency thresholds.

## WAL and recycle proof

The standalone lane adds an explicit high-volume transaction after the first
steady epoch. It requires a logged WAL-triggered checkpoint, then takes six
host-side snapshots of regular 24-hex WAL segment files:

1. `before-steady`
2. `after-steady`
3. `after-volume`
4. `plateau-1`
5. `plateau-2`
6. `plateau-3`

The snapshot validator requires that exact order, ordinal reset and contiguous
ordering inside each snapshot, unique names and filesystem identities within a
snapshot, a logged positive recycle count, and the same `(device, inode)` under
a different segment name in two adjacent snapshots. Thus a duplicate row cannot be
misreported as recycling. The last three snapshots must form a bounded byte
and file-count plateau, and the latest `pg_wal` footprint must remain at or
below 512 MiB. `max_wal_size` is a checkpoint trigger, not a strict disk cap;
the separate observed plateau is the relevant embedded-footprint evidence.

## Clean postmaster recycle proof

The first WASIX postmaster receives PostgreSQL's smart-shutdown signal. Forced
termination is not an allowed success path. Qualification waits for the owned
process group, cgroup, TCP port, and private `/dev/shm` directory to become
empty and requires PostgreSQL's clean-shutdown markers.

The same PGDATA is then opened by a new Wasmer/postmaster process in a new
cgroup scope. The new birth identity and cgroup identity must differ. Startup
must report a previously shut-down database and must not report crash recovery
or redo. Logical row counts, numeric aggregates, and two independent 64-bit
content aggregates are captured before shutdown and compared byte-for-byte
immediately after restart. Only then does the second fixed-offer epoch run.

Both the native controls and WASIX clusters are initialized with PostgreSQL
data checksums. Each running postmaster must independently report
`data_checksums=on`. After the second smart shutdown, the exact pinned native
PostgreSQL 18 `pg_checksums` binary performs an offline `--check` over the
WASIX-produced PGDATA; its binary identity, exit status, complete log, and log
hash are retained. The logical-state comparison and physical page-checksum
scan are separate gates, so agreement at the SQL layer cannot conceal page
corruption.

This preserves the core idea: every backend and every recycled postmaster is a
fresh execution context. No warm-worker reuse, hidden connection pool, relaxed
durability, dropped transaction work, or catch-up batching is used to obtain
the numbers.

## Running the lane

First inspect the bounded plan without requiring built artifacts:

```bash
src/runtimes/liboliphaunt/wasix-postmaster/bin/qualify-wasix-checkpoint-recycle.sh \
  --mode smoke --print-plan
```

Then supply an already verified compiler-free sealed carrier:

```bash
src/runtimes/liboliphaunt/wasix-postmaster/bin/qualify-wasix-checkpoint-recycle.sh \
  --sealed-carrier /absolute/path/to/sealed-carrier \
  --immutable-carrier-receipt /absolute/path/to/immutable-carrier-receipt.tsv \
  --mode smoke \
  --label checkpoint-smoke
```

Smoke uses one four-position block and 40-second epochs. Diagnostic uses three
blocks and 240-second epochs. Qualification uses at least ten blocks. Every
mode produces research-only, non-release evidence. Raw transaction, checkpoint,
full `pg_stat_io`/WAL/checkpointer, memory, WAL snapshot, shutdown, identity,
and gate receipts remain alongside the summary.

## Reading a failure

- A high PSS-anon result points toward runtime heap, compiled-code metadata, or
  guest-private allocation work.
- A high cgroup result with bounded PSS but high file/dirty/writeback values
  points toward PostgreSQL buffer/WAL pacing and host page-cache reclaim.
- `memory.events high` or PSI failure with no OOM means the limit is inducing
  reclaim stalls before correctness fails.
- Checkpoint-overlap tail failure with acceptable non-overlap latency points to
  writeback scheduling, not general query dispatch.
- WAL plateau or inode-reuse failure means retention/recycling has not been
  proven even if the final directory happens to be small.
- A clean-recycle failure must be treated as lifecycle or durability work; it
  cannot be papered over by deleting PGDATA or accepting crash recovery.

These distinctions keep optimization tied to the measured root cause without
changing PostgreSQL transaction semantics or fresh-backend isolation. This
document makes no claim for unmeasured runtime-metadata, checkpoint-admission,
or host-cache designs.
