# Cold page-cache ownership qualification

## What this lane closes

Running the sealed-carrier verifier and `initdb` before a measured postmaster
is correct for integrity, but it warms carrier and PGDATA pages in the caller's
cgroup. A later server-only cgroup can then fault already-resident pages without
owning the storage I/O or the original page-cache charge. Such a run is useful
warm-state evidence, but it is not cold embedded memory evidence.

The cold-ownership lane keeps full verification and initdb outside the timed
server, then establishes a new, explicit boundary:

1. Enumerate every directory and regular path below the immutable carrier and
   the newly initialized PGDATA. Symlinks and special entries fail closed.
2. Open with `O_NOFOLLOW`, content-hash every unique inode, recheck exact file
   identity/size/timestamps, and `fdatasync` each file.
3. Record the resident-page count with `mincore(2)`, apply
   `POSIX_FADV_DONTNEED` to each exact file, and run `mincore(2)` again.
4. Accept the boundary only when every unique regular-file page is nonresident.
   The JSON receipt binds the two root content/metadata digests, exact
   path/file/page/byte counts, host page size, UTC and monotonic timestamps,
   tool identity, and the benchmark execution/carrier identities.
5. Perform no carrier or PGDATA verification, hash, stat, or content read after
   proof completion. The benchmark takes one monotonic timestamp and launches
   the process group; `systemd-run --user --scope` places the postmaster tree in
   its fresh cgroup-v2 scope.

This is targeted eviction, not a machine-wide benchmark trick. The lane never
writes `/proc/sys/vm/drop_caches`, never invokes allocator purges, and does not
disturb unrelated page cache. `mincore` is the authority: advisory eviction
without the zero-page observation is rejected.

## Evidence contract

`--cold-ownership` is a startup-only WASIX lane. It requires Linux, a fully
verified ext-family immutable sealed carrier and its exact external deployment
receipt, one WASIX target, full smaps/resource
sampling, and explicit `MemoryMax`, `MemoryHigh`, and `MemorySwapMax` controls.
It always enables the zero-write loader policy and requires every AOT and
executable memory-image row to report `direct-immutable-inode`; a reflink,
streamed copy, or generic read-only-filesystem row fails this candidate lane.
Loader mapping rows use
`oliphaunt.wasix-postmaster.sealed-loader-receipt.v2`. After complete
process-tree execution and child-publication quiescence, each loaded
`(pid,module)` must also have exactly one terminal
`oliphaunt.wasix-postmaster.attested-start-runtime-summary.v1` row. The lane
accepts only
`oliphaunt.wasix-postmaster.sealed-loader-audit-validation.v3`, which binds both
row kinds to the final format-6 manifest and proves one full comparison,
`starts - 1` successful reuses, one successful remap per start, exact
mapped-size byte accounting, and zero nonfresh/failure/overflow counts.
The per-run validator requires:

- exactly two disjoint roots (`carrier` and `pgdata`) and no inode shared
  across them;
- carrier mode invariants (`0555` directories; `0444`/`0555` files);
- zero resident pages at the proof boundary and a boundary-to-spawn gap no
  greater than one second;
- a successful real libpq `SELECT 1`, with spawn-to-query completion measured
  by `CLOCK_MONOTONIC`;
- first-query and pre-stop snapshots from the same exact cgroup identity;
- exact cgroup limits, positive scope-owned file charge, and no swap beyond
  the declared limit;
- an explicit I/O-observation contract: when `io.stat` is present it is parsed
  strictly and positive attributed reads plus non-regressing counters are
  required; when the delegated cgroup lacks the I/O controller or `io.stat`,
  status/reason are bound as unavailable and all I/O totals remain null/blank;
  that run makes no storage-I/O first-touch claim;
- at least one race-free full process-tree smaps plus cgroup sample;
- scope-lifetime `memory.peak` and `swap.peak`, instantaneous
  `memory.stat` file-dirty/writeback peaks, pressure totals, and, only when the
  controller is observable, `io.stat` read/write byte and operation counts.

The first query is the readiness probe itself. Native `psql` runs outside the
server scope, so client memory is not charged to the embedded server budget.
PGDATA is fresh per block. The repeated qualifier rejects reused PGDATA,
carrier/execution identity drift, changed limits, a missing sample, or any
failed per-run validation, then reports nearest-rank p50/p95 startup latency.

## Campaign

After building the final sealed carrier and native client install, run:

```sh
bash src/runtimes/liboliphaunt/wasix-postmaster/bin/qualify-wasix-cold-ownership.sh \
  --sealed-carrier target/oliphaunt-wasix-postmaster/carriers/<exact-carrier> \
  --immutable-carrier-receipt /var/lib/oliphaunt/wasix-postmaster/<exact-receipt>.json \
  --blocks 10 \
  --runtime-footprint embedded-concurrent \
  --durability safe \
  --memory-max 256M \
  --memory-high 224M \
  --swap-max 0 \
  --resource-interval 0.05 \
  --label cold-ownership-c4-final-v1
```

Add `--max-p95-ms <ceiling>` only when a performance ceiling has been declared
before measurement. Without it, latency is report-only; all ownership,
integrity, isolation, and memory-resource gates remain mandatory. I/O gates
remain mandatory when `io.stat` is available; an unavailable delegated I/O
controller is reported rather than converted to zero or an I/O first-touch
claim. The output is research-only, non-release Linux evidence and makes no WASIX
claim for platforms without cgroup v2, `mincore`, and POSIX file advice.
