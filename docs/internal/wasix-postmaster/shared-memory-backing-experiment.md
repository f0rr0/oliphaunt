# Shared-memory backing experiment

This experiment isolates one host-substrate question in the real PostgreSQL
postmaster architecture: what should back the POSIX shared-memory object that
Wasmer mounts at guest `/dev/shm`?

It does **not** replace the postmaster, merge backends, reuse a backend guest,
or weaken `EXEC_BACKEND`. PostgreSQL still creates one main object with
`shm_open`, maps it `MAP_SHARED`, and every fresh backend reattaches the same
object at the required guest address. Only the host directory behind the
guest mount changes.

## Why this variable matters

The historical harness maps `$target_run_dir/dev-shm` into the guest. On the
Linux evidence host that directory is on the repository's ordinary ext4
filesystem, not the host `/dev/shm` tmpfs. PostgreSQL's main shared-memory
pages are consequently ordinary filesystem-cache pages. Under a tight
dedicated cgroup they compete with relation, index, WAL, carrier, and runtime
file pages for reclaim and writeback.

That is a legitimate portable implementation, but it confounds two questions:

1. how much physical memory the PostgreSQL shared state requires; and
2. how ext4 reclaim/writeback of that state interacts with useful relation
   cache under `memory.high`.

`linux-tmpfs-v1` separates those questions. It may reduce writeback and
refault latency for PostgreSQL shared state, but it does not make those pages
free. Tmpfs pages remain cgroup-charged. With `MemorySwapMax=0` they cannot be
reclaimed to swap, so they can instead reduce the headroom available to
relation and WAL cache. This is a pressure-shape experiment, not an automatic
RSS reduction.

Linux `memory.stat` also requires care: `shmem` is an attribution within the
file-backed accounting, not an independent amount to add to `file`. Compare
`anon`, `file`, `shmem`, `file_mapped`, process PSS/Pss_Shmem, cgroup peak,
events, PSI, refault/scan/steal counters, and throughput together.

### Initial diagnostic evidence

The first local same-carrier diagnostic strongly supports the substrate
hypothesis, while remaining too small and unbalanced for a support claim. With the
declared `io_method=sync`, `shared_buffers=32MB` profile, four clients, 100,000
indexed updates each, controlled checkpoints, and a 256/224/0 MiB
max/high/swap cgroup, three sampling-off tmpfs runs produced 129,157, 129,116,
and 111,701 logical row operations/second (median 129,116). A contemporaneous
portable-file run produced 53,720 operations/second; the earlier file-backed
campaign clustered around 50--57k. The diagnostic median is 2.40x the
contemporaneous portable point.

The full-detail pair explains what changed and what did not. Tmpfs reached
116,686 operations/second versus 57,176 for the file-backed run. Fan-out PSS
was effectively unchanged (98.314 versus 99.731 MiB), as was anonymous PSS
(38.160 versus 38.266 MiB). About 35.4 MiB moved from file PSS into shmem PSS;
whole-run cgroup peak remained pinned near 224.68 MiB in both runs. Total
observed PSI fell from 50,468 to 41,434 microseconds, while file refaults fell
from 11,542 to 11,058 pages and scan/steal from 80,768 to 77,184 pages.

This is the desired architectural distinction: tmpfs did not hide or remove
the PostgreSQL shared-state cost, but keeping that state out of ordinary ext4
writeback/reclaim recovered much of the tight-cgroup throughput. This remains
diagnostic evidence and makes no default-provider, capacity, failure, or
other-platform support claim.

## Versioned provider contract

The concurrent benchmark accepts one CLI-only option:

```text
--shared-memory-provider portable-file-v1|linux-tmpfs-v1
```

There is deliberately no ambient environment activation surface.

| Provider | Host root | Contract |
| --- | --- | --- |
| `portable-file-v1` | Exact historical `$target_run_dir/dev-shm` | Default. Records the observed filesystem but accepts any filesystem supported by the host/runtime. This preserves the existing backing substrate unless the caller opts in. |
| `linux-tmpfs-v1` | Private randomized mode-0700 child of physical `/dev/shm` | Linux-only diagnostic. Requires `/dev/shm` itself to be a non-symlink directory on a mountinfo-identified `tmpfs`, cross-checks mount major/minor with `st_dev`, and requires `statfs` magic `TMPFS_MAGIC` (`0x01021994`). |

Both providers require an effective-UID/effective-GID-owned, mode-0700,
non-symlink directory and bind its parent and root device/inode identities.
The receipt also records filesystem capacity/availability at preparation time;
tmpfs exhaustion remains a real startup/runtime failure rather than a reason
to fall back silently to disk.

On Linux the portable provider records `statfs` and mountinfo evidence when
those probes are available, but neither is a new requirement for the
historical default path. `linux-tmpfs-v1` requires both mountinfo and the tmpfs
magic because its explicit claim cannot be made from a best-effort probe.

## Evidence and causal proof

The WASIX target report contains immutable JSON receipts:

- `shared-memory-provider.json` binds provider ID, measurement/target,
  helper digest, host UID/GID, root and parent device/inode/mode, Linux
  mountinfo fields, statfs type/magic, capacity, and the exact cleanup policy;
- `shared-memory-objects.json`, captured after readiness, requires exactly one
  regular `postgresql-wasix-*` main object and records every live object,
  including device/inode, size, allocated blocks, owner, mode, link count,
  filesystem type, and measured server cgroup identity;
- `shared-memory-release.json` proves the provider directory is empty after a
  clean PostgreSQL shutdown and binds the parsed lifecycle receipt (zero wait
  status, no forced signal or residue, and the database shutdown marker);
- `shared-memory-exit-{objects,release}.json` is the distinct error/exit-drain
  evidence. It may prove emptiness after all owned processes drain, but never
  claims that PostgreSQL shut down cleanly;
- `shared-memory-cleanup.json` binds exact directory device/inode, original
  provider-receipt SHA-256, reason, and successful removal when cleanup was
  requested or the external tmpfs provider was released.

The live-object receipt is essential. A receipt for an empty directory alone
would not prove that Wasmer actually routed PostgreSQL's `shm_open` there.

Cleanup treats the provider receipt as evidence, not deletion authority. The
caller must also supply the expected provider, path, and frozen receipt hash.
The helper opens the parent/root by directory descriptor with no symlink
following and rechecks the exact receipt inode. Cleanup never traverses or
unlinks a child: it requires the directory to be empty and performs only an
anchored `rmdir`. An inode replacement, mode/ownership drift, receipt mutation,
mountpoint, symlink, directory, or surviving regular object therefore fails
closed. External tmpfs allocation has a trap-visible pending registry before
the helper starts, then becomes exact-root-owned immediately after receipt
adoption. Catchable termination signals trigger helper rollback; exit cleanup
can also recover a completed-but-unadopted allocation from its receipt. Final
release occurs only after owned clients, server groups, cgroups, and samplers
drain. If an object survives, it is inventoried and retained rather than
deleted under a possibly live process.

Uncatchable `SIGKILL`, kernel failure, or host power loss can leave the
randomized `/dev/shm/oliphaunt-wasix-postmaster.<uid>.*` directory behind.
When preparation reached its immutable provider receipt, recovery must use
that receipt, its frozen hash, and the exact receipt-bound helper bytes; broad
`/dev/shm` glob deletion is never part of the contract. A kill in the narrow
pre-receipt allocation window has no deletion authority and requires explicit
operator diagnosis of the exact randomized path rather than automated glob
cleanup.

## Running the diagnostic A/B

Use the same carrier, PostgreSQL settings, cgroup, workload, and ordering for
both runs. The backing provider is the sole intended variable. For example:

```sh
project=src/runtimes/liboliphaunt/wasix-postmaster
common=(
  --skip-build
  --target wasix
  --sealed-carrier target/oliphaunt-wasix-postmaster/carriers/headless-research
  --workload indexed-update
  --connections 4
  --iterations 100000
  --rows 100000
  --runtime-footprint embedded-concurrent
  --durability safe
  --checkpoint-policy controlled
  --cgroup-memory-max 256M
  --cgroup-memory-high 224M
  --cgroup-swap-max 0
  --resource-detail full
  --resource-interval 0.1
)

"$project/bin/bench-wasix-concurrent-query-suite.sh" \
  "${common[@]}" --label shm-portable-file-v1
"$project/bin/bench-wasix-concurrent-query-suite.sh" \
  "${common[@]}" --shared-memory-provider linux-tmpfs-v1 \
  --label shm-linux-tmpfs-v1
```

Those full-detail runs are memory-attribution diagnostics. Repeat the same
balanced order with `--resource-detail off` for throughput; full smaps sampling
is too perturbing to serve as latency/throughput qualification evidence. Compare
multiple fresh ABBA/BAAB samples, not one favorable run.

The single-backend qualifier does not bind this provider in its frozen policy
or raw-row identity. Direct provider runs are therefore diagnostic and make no
embedded throughput/latency claim.

## Support boundary

The benchmark provider interface is diagnostic, not a cross-platform
shared-memory API. The Linux tmpfs lane supplies one-host backing-substrate
evidence. Darwin and Windows providers, cross-platform selection, crash
recovery, and a supported shared-object abstraction are outside this project.
