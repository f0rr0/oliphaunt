# WASIX Postmaster Replay Status

This is the tracked evidence index for the prior-art replay. Generated logs
stay under `target/oliphaunt-wasix-postmaster/`; this file records which
results are credible, which carrier produced them, and which results are
historical only. It is not a platform-support statement or release
qualification.

## Last completed structural checkpoint (historical; no carrier admitted)

The 2026-08-09 Linux x86_64 replay produced a clean runtime and a green
`release-o3` guest/core proof chain. The current source and builder use the
newer `runtime-build-recipe.v3` builder-identity contract, so every identity in
the table below is historical and superseded. The checkpoint deliberately did
not produce or smoke a carrier: the sealed export proof covered 27
runtime-loadable side modules, while the prototype carrier below packaged only
five guest modules. No final-head receipt, guest, or carrier is admitted. The
current tracked Wasmer patch is 2,255,905 bytes with SHA-256
`4a164cad0ec19dbe29cf0fe3f37e94b9f2ee9f887252b74a8eeecd6dfc41e333`.

| Input/artifact | Identity |
| --- | --- |
| Superseded checkpoint Wasmer source/patch | 7.2.0-alpha.2 at `1d1b3420beef28550afbb4692b664bd7f6bc2581`; patch SHA-256 `5d6bc8c6f8cf250daedcefc686f0ba8b0a17662ee9fc3a8c917497c9c5e2963d` |
| wasix-libc source/patch | `34178a6272804f90448b5bd08dc7bcf0d85438e3`; patch SHA-256 `59a936d5f6398b5b60c3e6e8b6c220a02a22603daf2eb0920f227021d56ffe7d` |
| Runtime ABI/artifact ABI | `5bb33347acd61470f80c55fb7905f188375b26f99252bbad2eb81f96c0374d18`; artifact ABI 21 |
| Runtime recipe | `e8312d92966dde2e9f379f15b508c7461d126ddb0e789f2504bcda54e705e384` |
| Wasmer/headless/postmaster executor | `1b374b99b1ed0e4c7545f71944993fbd995f499dfb962f57f3385ef3da934539`; `3026f905fe30709d400d5bb342b0568c2eb26799ab96fb1d91397715090fc777`; `00433e8d2adf661d253ac56977b8537a91903dec30064a99ae7e51033b3405db` |
| Wasmer/executor receipts | `ee49ac11894ca5f747906898bf6a8880cc52c9a7c1a7b9c34ef97faae12c8f82`; `201290f0690e8ac5f59add80bb8c3857fb6397b8ec1d2d6bda70789a9715b54b` |
| Guest/core receipt | `oliphaunt.wasix-postmaster.guest-build.v4`; SHA-256 `7203426ba7285ff11af924191ca656a841cdc36becd9e566ef0266c9af19920e`; installed closure `9da4f6909003fefa8f6ae06f093e67102ceba7f0d6cd91b9000fd3670068fe24` |
| Export closure | seed `d347ebb938d007d04ed6e43faa677070aac0915c2482061ed704ddd51095d1b0` to sealed `881c9874c04488c29e96a589016b23188ebe7a6593a8b41ade345375f057436f`; 23,187 to 383 exports; 16,922 to 12,777 local functions; 10,911 to 1,020 local globals; all 4,739 element entries retained |
| Concurrency proof | 1,111 pre-seal fences and 995 final fences; final receipt SHA-256 `5d328952ebb63bf6a788bd89796a96c2128682f812eec99495b858a28952144e` |
| Linear-memory proof | 35 modules; 4,096-page/256 MiB maximum; U64 4 GiB static bound plus 2 GiB guard; receipt SHA-256 `4a218ea45b57ee9472c2645216e8ca6e9b6c00f93e154e7b39261f97027b9ab7` |

The final export proof serializes the canonical `bin/postgres` identity. The
installed PostgreSQL module is
`a71d5b1fc5ed00938bba45075819c9efef7e68b9d044e897c2ecf891a3e5dd57`
after the receipt-bound linear-memory transformation. Checkpoint executable
evidence was Linux x86_64 only; macOS, Windows, and U32 remained unqualified or
failed closed.

The five-module checkpoint artifact is excluded as an incomplete carrier.
The current builder retains the same five-module research scope;
`runtime/policies/sealed-side-modules.v1.tsv` records the larger source
inventory but does not expand that carrier closure. This historical checkpoint
makes no retired-stack, full-tree-provenance, side-receipt, or
atomic-publication claim.

## Last measured research carrier identity (historical)

The last measured five-module research carrier was:

```text
target/oliphaunt-wasix-postmaster/carriers/wasix-postmaster-18.4-995f6a9bf69ce6ff-8e907e600fa9d7197c2ae98ddece5cb3093e4e7e3caf8f27f325a24955c120a7/
```

| Input/artifact | Identity |
| --- | --- |
| PostgreSQL source/install | 18.4; source fingerprint `bf6b1003938fdcbe6fd81e6cfa15dcd04e8cc8dd30cdc7b4af321cf219e1dbea` |
| Wasmer source/patch | 7.2.0-alpha.2 at `1d1b3420beef28550afbb4692b664bd7f6bc2581`; patch SHA-256 `3b5a21c76d17b5c481948fc8451ce88f1910774075f274d618fdbac610d40196` |
| Runtime ABI | `995f6a9bf69ce6ff154533369eb4f9d6c45d9dfca13fdc213e0f6be8ae405217`; artifact ABI 21 |
| Compiler-bearing LLVM AOT producer | SHA-256 `b4f8f34a5fc8d2419e97359a7a58c524811d8651285383525103b12eaae1e1a4`; producer recipe `8cbf81e51949e6829374058e847266741be2e6428fb0019f827fa736c4b57258` |
| Headless executor | SHA-256 `b9fb2eac796ddccee98cfd1277dd8518269c47d79ecb0b1426e4cca86a611327` |
| Build receipt | `oliphaunt.wasix-postmaster.wasmer-build.v2`; SHA-256 `163b6591fe929a28a9edb6addc55714213e33fdc581299633e7cfd2b2be729a1`; build recipe `4b7ee80f1c4d0aff0058973638b9edced49afb5368b9574e318938016939e3e3` |
| Sealed manifest | `oliphaunt.wasix-postmaster.sealed-aot.v2`, format 3; SHA-256 `cea8c0933fa01f6646184c1f97c2156300e50bcf8a5d1d2e38fbb4ed2bb11fec` |
| Exact payload inventory | `payload.files`; SHA-256 `8e907e600fa9d7197c2ae98ddece5cb3093e4e7e3caf8f27f325a24955c120a7` |

This historical carrier contains exactly five guest modules (`initdb`, `postgres`,
`libpq.so.5.18`, `dict_snowball.so`, and `plpgsql.so`), five AOT objects, and
two independently reproduced executable memory images. The streaming carrier
verifier closes the local payload boundary: it validates the canonical
manifest and receipt, exact directory/file set, safe sorted paths, regular-file
identity, size and digest, and rejects mutation during read. This is stronger
than the historical pin snapshot but remains unsigned local research, not a
release trust root.

The default publication directory contains the runtime ABI prefix plus the
full final `payload.files` SHA-256. That content-addressed name fixes the former
safe-O2/O3 collision under a shared runtime ABI; `--output` remains an explicit
presentation path rather than the carrier identity.

## Historical measured snapshot identity

The comparison snapshot was recorded on 2026-08-08 on one Linux x86_64 host
(Ubuntu kernel 6.8). PostgreSQL uses the `safe-o2` profile, `EXEC_BACKEND`,
WebAssembly EH/PIC, and LLVM `aggressive`. Native-CPU, the full O3 pipeline,
and the indirect-call cache are disabled.

| Input/artifact | Identity |
| --- | --- |
| PostgreSQL | 18.4 / `REL_18_4`; archive SHA-256 `81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094` |
| Wasmer source | 7.2.0-alpha.2 / `1d1b3420beef28550afbb4692b664bd7f6bc2581` plus the local replay patch |
| Wasmer patch | SHA-256 `b11899a83293a01c003fe2e8a62f2aca62764ecfa5ab6d7e1a52e2497780ea67` |
| wasix-libc source | `34178a6272804f90448b5bd08dc7bcf0d85438e3` plus the local replay patch |
| Historical measured Wasmer binary | SHA-256 `96711c979951afe7087ca40b250cb969a87d49638d41149db82445026b0ac9b4` |
| Historical Wasmer build receipt | `oliphaunt.wasix-postmaster.wasmer-build.v1`; recipe SHA-256 `9488598c21649d5520b32f5ca8ae32b3218251413be4828df260664c73cff068`; receipt SHA-256 `b3248595d326385f353a9d45b59eb8af0cee790a3533e0cd2c98a1abdcb01126` |
| Sysroot carrier | `oliphaunt.wasix-libc-sysroots.v1`; manifest SHA-256 `c4a5bf6aaa0fe59096f9227a3e8a37e927a4a3d6072cc774ee99f0bd7c31f75e` |
| Exact libc variant | `sysroot-exnref-ehpic`; variant manifest SHA-256 `a518afe4f24134901c77a14baede4c4a0798c6e93eed632f94081e726de68538` |

The sysroot identity covers its source, patch, Docker image/archive, headers,
and exact variant. This historical v1 runtime receipt additionally covers
Wasmer/gitlink pins, both prepared source states, tracked runtime and libc patches,
`Cargo.lock`, sysroot manifests, host ABI, Rust/LLVM provenance, build
features, build recipe, and binary. The producer reruns the focused VM,
shared-mapping, and compiler-IR tests before publishing the receipt.

This is unsigned local build provenance. It does not seal the PostgreSQL
guest-set closure, native libraries, or AOT artifacts. The guest/runtime pair
uses exact-pin ABI matching and provides no negotiated feature ABI, as described
in [architecture.md](architecture.md).

## Prototype format-6 sealed headless boundary

Current source defines an `oliphaunt.wasix-postmaster.wasmer-build.v2` receipt
using builder recipe v3. This historical ledger admits no final-head receipt.
Unlike the historical v1 evidence above, v2 separately binds the
compiler-bearing LLVM AOT producer and compiler-free `wasmer-headless`
executor, their feature sets, artifact ABI, and runtime ABI. The atomic carrier
builder packages an exact five-module prototype closure and a complete payload
inventory
under `oliphaunt.wasix-postmaster.sealed-aot.v5` format 6. It uses the
image-free `sealed-aot.v3` format 4 only as a provisional capture manifest,
performs two independent captures for each executable, and publishes the
byte-identical images and receipts for `initdb` and `postgres`.

The standalone and benchmark-preflight verifier treats the manifest, v2
receipt, and `payload.files` as one exact identity. It rejects duplicate keys,
noncanonical receipts, unsafe or unsorted paths, missing and unexpected files
or directories, symlinks and special files, empty unlisted directories,
digest/size mismatches, and identity changes while streaming a file. The
builder runs the same verifier before atomic publication.

The headless loader rejects unknown manifest fields and mismatched target, host
ABI, producer recipe, Wasmer versions, CPU policy, artifact/runtime ABI,
executor digest, AOT digest, raw-module digest, or size. It deserializes the
same verified file mapping and registers exact sealed guest paths as already
loaded modules. It additionally requires a module/runtime/layout-bound memory
image on every executable, runs ordinary module start, compares the complete
captured prefix, and privately remaps identical pages before dynamic
relocations and constructors. Detached deserialization retains linked
executable sections and runtime-required metadata, then releases the serialized
archive; the detached module intentionally cannot be serialized again.

These properties were implemented, focused-tested, and exercised in the
historical Linux x86_64 carrier. They do not close the selected 27-side-module
guest set, so that carrier is not admitted for the current source.
The Unix image-mapping implementation exists, but this project has no macOS
host evidence; the Windows mapper is unsupported. No cryptographic release
signature/provenance or complete native dependency closure is implied.

## Historical measured-carrier correctness

### Strict exec-backend blocker suite: 20/20 passed

`runtime/bin/run-exec-backend-probes.sh` passed in strict mode against the
measured binary and exact exnref/EH/PIC sysroot. The generated report is
`target/oliphaunt-wasix-postmaster/runtime/reports/blocker-probes.md`.

| Contract | Passing probes |
| --- | --- |
| Shared mapping/filesystem | `mmap-fixed`, `mmap-writeback`, `dir-readdir-unlink` |
| Synchronization/limits | `futex-timeout`, `rlimit-stack` |
| Fresh child/shared replay | `spawn-shmem-reattach` |
| Cross-instance latch wake | `exec-shared-latch-sigurg` (512 immediate/delayed rounds) |
| Wait and signals | `posix-spawn-sigchld-default`, `posix-spawn-sigchld`, `waitpid-wnohang-any`, `posix-spawn-blocking-wait`, `posix-spawn-pipe` |
| Listener readiness | `epoll-listen-accept`, `epoll-listen-after-vfork-exec`, `epoll-listen-external`, `epoll-listen-external-after-pipe` |
| Socket flags | `socket-nonblock` |
| Dynamic execution/loading | `dynamic-dlopen`, `dynamic-vfork-exec` |
| PostgreSQL error substrate | `wasm-eh-sjlj` |

The historical measured carrier's compiler test also passed after checking
post-optimization LLVM IR for rotate lowering and a real `fence seq_cst`. Its cache-identity
negative test proves that default and `--disable-non-volatile-memops` compiler
configurations have different deterministic IDs. The latch litmus passed again
with `--disable-non-volatile-memops`; the same module hash was compiled into
separate `...-nv1-...` and `...-nv0-...` artifact buckets. This is a valid
focused two-mode check, not cache reuse.

### One-shot timer diagnostic: expected failure

`setitimer-epoll-one-shot` is intentionally diagnostic and non-gating. A 100 ms
one-shot `ITIMER_REAL` did not interrupt the blocked `epoll` wait: the probe
ended after 2,001 ms with `alarms=0` and exit code 8. The implementation uses
the wrong `it_interval`/`it_value` semantics and units and does not schedule an
autonomous wake. PostgreSQL timeout behavior is therefore not qualified; this
is a release blocker, not a skipped test.

## Reproduced liveness defect and repair

The original multi-wave failure is now reduced to a specific memory-ordering
defect. With one persistent diagnostic connection, one backend remained in
`Lock/extend` for all 600 samples over 30,001 ms. Its relation
`ExclusiveLock` was `granted=true` and `pg_blocking_pids` was empty in every
sample, while three peers queued with `granted=false`. Across the run that is
2,400 lock observations: 600 granted-holder and 1,800 queued-peer rows.
Unrelated updates continued through the same postmaster.

PostgreSQL had completed `GrantLock`, but the granted backend remained asleep
in `ProcSleep`/`WaitLatch` after `SetLatch`. PostgreSQL's latch objects contain
`atomic.fence` for `pg_memory_barrier()`. The pinned Wasmer LLVM backend had
lowered that operator to a no-op. That is normally compatible with a single
WebAssembly shared memory, but this runtime aliases one file backing into
separate Wasm instances. The local compiler patch now emits an LLVM
sequentially consistent fence.

That account and the evidence below describe the historical safe-O2 carrier.
The later 2026-08-09 structural checkpoint recorded 1,111 linked-module fences
and 995 sealed fences after exact export DCE. It retained the packed SC
latch-state repair and the exact `SetLatch=2`, `ResetLatch=1`, and
`WaitEventSetWait=1` fence counts. That historical proof closed the structural
regression for its source identity only. A current-source claim is accepted only
from a regenerated proof plus the repeated fresh-postmaster and backend-wave
runtime gates.

Evidence progression:

1. Pre-fence binary `94e409c5…` failed the focused lock-grant gate on attempt 1;
   a comparable persistent-sampler run passed four attempts and failed attempt
   5. Two failures in six attempted fresh postmasters show reproducibility but
   are not an incidence estimate.
2. Intermediate fence binary `cccd10e0…` passed the canonical 20-attempt
   backend-wave gate. A second nominally conservative 20-attempt label also
   passed, but reused exactly the same cached native code; the only valid claim
   is 40/40 repetitions of one artifact, not an A/B.
3. The compiler and product cache identities were repaired. The measured
   `96711c97…` carrier passes the focused 512-round latch test in both distinct
   compiler modes. A cache-keyed 100-attempt PostgreSQL gate is recorded below.

`backend-wave-fence-volatile-100` produced no workload evidence: it failed
receipt preflight and must never be counted as a liveness failure or success.

### Cache-keyed repeated PostgreSQL gate

The final conservative-memory run uses label
`backend-wave-fence-volatile-keyed-100`, a distinct top-level cache namespace,
and Wasmer's corrected `nv0` compiler identity. It passed **100/100** fresh
postmasters. Every attempt completed 4×100,000 indexed reads, 4×100,000
mixed-write iterations (800,000 logical row operations), and 4×100,000
indexed updates within the 30-second phase bounds and passed verification. No
attempt timed out or retained a failed client. This fills the 100-repetition
gate for this Linux x86_64 conservative compiler/carrier configuration; it does
not qualify another host or compiler configuration.

The 100 attempts contain 300 successful workload phases and 1,200 successful
clients. Their logical row-operation distributions were:

| Workload | Median ops/s | p5 | p95 | Range | CV |
| --- | ---: | ---: | ---: | ---: | ---: |
| Indexed read | 323,887 | 295,174 | 403,042 | 263,315–415,879 | 9.29% |
| Mixed write | 419,727 | 385,526 | 474,427 | 374,181–500,000 | 6.40% |
| Indexed update | 173,838 | 163,716 | 201,253 | 150,376–206,292 | 6.43% |

The persistent 20 Hz sampler recorded 11,703 ticks and 39,105 client-backend
observations. It saw 143 `Lock/extend` observations in 67 attempts; all but one
sampled epoch lasted one tick, and the longest lasted two ticks/49 ms. No
observed `Lock/extend` row had a non-empty `pg_blocking_pids` result. All 300
sampler stderr logs and all 300 relation-footprint stderr logs were empty.
Server logs contained no `ERROR`, `WARNING`, `PANIC`, deadlock, statement
timeout, trap, assertion, or corruption marker. Five attempts logged a
non-fatal interrupted `accept` during startup/operation.

Each attempt used a fresh cluster and postmaster but shared one warmed AOT
cache after attempt 1. Zero failures in 100 gives an approximately 2.95%
one-sided 95% upper bound under an IID binomial model; shared host/cache state
weakens that assumption. The gate proves a strong same-host liveness result,
not a crash/recovery, durability, tail-latency, or fleet failure-rate claim.

The focused old and intermediate reports remain below
`target/oliphaunt-wasix-postmaster/reports/backend-wave-stress/` and
`target/oliphaunt-wasix-postmaster/reports/concurrent-query-suite/`. See
[concurrent-root-cause.md](concurrent-root-cause.md) for the causal trace.

### Lifecycle steady-state barrier

A separate verbose lifecycle trace resolved the apparent readiness FD drift.
The aggregate guest-FD count remained 70 until PID 6, PostgreSQL's WAL writer,
opened `pg_wal/000000010000000000000001`; its local inventory increased from
11 to 12 FDs and the aggregate became 71. PID 7 already held `global/1262` in
the earliest inventory, so attributing the change to that file or process was
incorrect.

The causal PostgreSQL 18 path is the background writer's first approximately
15-second running-transactions snapshot. `LogStandbySnapshot()` inserts the
`XLOG_RUNNING_XACTS` record and publishes an asynchronous LSN; the WAL writer
wakes, writes it, and retains the current-segment VFD for later writes. The
lifecycle lane now advances that natural lazy state before readiness by calling
`pg_log_standby_snapshot()`. It records the returned LSN and the
`walwriter`/`wal`/`normal` `pg_stat_io` counters, then polls fresh snapshots
until `writes` and `write_bytes` both increase and
`pg_current_wal_flush_lsn()` reaches the target, with `stats_reset` unchanged.
This is an event barrier, not a timing sleep, synthetic bulk-WAL workaround, or
path-specific FD allowance. It requires `wal_level >= replica` and a primary;
unsupported preconditions fail closed.

At stable idle the relational topology is six registered processes, six
runtime states, and five child edges. The corresponding execution-lease count
is eleven, not six: six active tasks plus five parent continuations suspended
across the EXEC_BACKEND `vfork`/`exec` relationships.

## PostgreSQL integration evidence

The historical `96711c97…` carrier passed the focused integration ladder:

- 20/20 independent `initdb` lifecycles completed with clean logs under
  `wasix-initdb-fence-final-20`.
- The four-client `concurrent-fence-final` smoke wrote and finished 32/32 rows,
  observed four distinct backend PIDs and overlapping client intervals, and
  had no timeout.
- `pg_regress` passed `test_setup`, `create_function_c`, `boolean`, `case`, and
  `copy`; `create_function_c` loaded the WASIX-built `regress.so` side module.

The historical baseline had one blocked `initdb` in ten and two WASI `INTR`
(`errno 27`) `proc_join` reports. Rebuilding the tagged PID on each EINTR retry
and materializing the default SIGCHLD handler before early delivery removed
those reproduced races. Longer crash/recovery, WAL durability, connection
churn, dynamic shared-memory churn, and broad regression suites remain
required regardless of those focused results.

## Performance characterization

All figures below are characterization, not release budgets. “Ops/s” means
logical rows processed inside bulk SQL or a server-side PL/pgSQL loop, not
client queries, transactions, or requests. Failed/rolled-back rows are invalid
even when the harness can divide intended operations by elapsed time.

The concurrent harness's default workload fields record bulk batch wall time;
no bulk number in this section is a p95/p99 or reconnect-latency claim. An
opt-in native-libpq lane now retains raw `CLOCK_MONOTONIC` samples for repeated
`SELECT 1` calls on one persistent connection and, separately, complete
`PQconnectdb` -> `SELECT 1` -> `PQfinish` reconnect/backend-launch operations.
Its deterministic tests and a tiny native lifecycle smoke pass, but the real
paired WASIX/native latency qualification has not been run.

### Retained sealed-carrier memory and bulk-throughput evidence

The historical five-module carrier's retained budgeted run is
`final-995f-embedded-c4-lower-pressure-v1`. On one Linux x86_64 host it passed
the predeclared 256/224/0 MiB hard/high/swap profile and every required
four-client 100k workload phase:

| Evidence | Observed | Predeclared ceiling |
| --- | ---: | ---: |
| Readiness PSS | 66.862 MiB | — |
| Peak fan-out PSS | 132.708 MiB | 160 MiB |
| Peak fan-out anonymous PSS | 77.473 MiB | 96 MiB |
| Peak fan-out page tables | 1.164 MiB | 2 MiB |
| Required-phase `memory.high` event delta | 2,528 | 4,096 |
| Required-phase PSI some/full stall fraction | 0.003289 / 0.003289 | 0.015 / 0.010 |
| Whole-run cgroup peak | 224.707 MiB | 256 MiB hard limit |

No `memory.max`, OOM, OOM-kill, or swap event occurred. Bulk logical
row-operation rates were 352,846.832/359,874.044/42,854.082/140,449.438 ops/s
for read/mixed-write/update/insert. These batch rates are not transactions,
queries, launch latency, or tail latency. The exact run passes the predeclared
memory gates. It is one historical measurement, not an aggregate
embedded-viability, release, or another-platform claim.

The earlier retained readiness-PSS progression is historical optimization
evidence:

| Report | PSS | Meaning |
| --- | ---: | --- |
| `embedded-pss-baseline-c1-i100k` | 226.940 MiB | Historical compiler-bearing baseline. |
| `sealed-detached-paired-c1-i100k-r2` | 150.062 MiB | Sealed, compiler-free, detached-AOT carrier. |
| `cow-image-fixed-c1-i100k` | 129.929 MiB | Corrected immutable memory-image path. |
| `cow-arc-import-c1-i100k` | 113.901 MiB | Shared immutable linker/import ownership. |
| `cow-lazy-artifact-c1-i100k` | 79.101 MiB | Lazy AOT activation with the exact eager-export closure. |

These are successive named runs, not isolated microbenchmarks or additive
component savings. The prior safe-O2 end-to-end pressure evidence is under
`target/oliphaunt-wasix-postmaster/reports/concurrent-query-suite/`:

- `cap-final-wasix-c1-100k-192m` completed all four workloads with a 192 MiB
  hard limit, 160 MiB high threshold, and swap disabled. Quiescent readiness
  was 77.995 MiB PSS; read/mixed/update/insert fan-out peaks were
  98.640/121.291/149.189/154.604 MiB. There was no max, OOM, or swap event.
- `cap-content-addressed-final-c1-read-96m` completed indexed read through the
  final content-addressed carrier with a 96 MiB hard limit, 88 MiB high
  threshold, and swap disabled. Bulk throughput was 100,548 logical row ops/s;
  readiness/fan-out PSS was 77.761/95.171 MiB, cgroup peak was 88.629 MiB, and
  220 high events occurred without a max/OOM/swap event. PSS and cgroup charge
  differ because their accounting and sampling boundaries differ.
- `cap-final-wasix-c4-100k-192m-pressure` completed all four workloads with no
  max/OOM/swap event. Relative to the 256 MiB run, mixed-write/update/insert
  bulk rates fell about 13%/25%/19% under reclaim. It is a survival tier.
- `cap-final-wasix-c4-100k-256m` completed all four workloads with no
  max/OOM/swap event. Read/mixed/update/insert fan-out PSS was
  107.576/195.131/219.062/219.653 MiB. It is a lower-pressure sizing
  characterization, not a performance tier: the run predates explicit
  PSS/high/PSI budgets.
- `cap-final-wasix-c4-read1m-maps` measured 78.068 MiB quiescent readiness,
  108.274 MiB four-client read fan-out, and 93.674 MiB post-workload
  quiescence: roughly 7.5 MiB per active read client over that readiness point.

Raw RSS is much higher because every guest aliases the same PostgreSQL
shared-memory file at another host virtual address. A live 14–15-process
diagnostic attributed roughly 650 MiB of RSS aliases to one approximately
142 MiB backing; PSS and cgroup charge remain the physical gates. The private
memory images shared effectively (roughly 230 KiB private per guest and about
5 MiB aggregate image PSS in that snapshot). The snapshot attributes the
remaining measured residency to host arenas/heap, anonymous RX code, dense
per-instance runtime metadata, and active private tails; it makes no
optimization claim.

The release-O3 carrier produced one-client, one-million-iteration
WASIX/native bulk ratios of 0.754/0.801/0.779/0.829 for
read/mixed/update/insert in
`reports/release-o3/concurrent-query-suite/cap-final-release-o3-c1-1m-paired`.
The balanced one-block 100k diagnostic
`reports/single-backend-qualification/qualifier-final-o3-c1-b1` passed every
throughput gate at 0.746/0.788/0.833/0.874 but failed the bulk-batch residual
gates for mixed-write, update, and insert. It has only two samples per target
and remains diagnostic; residual is batch wall minus summed psql-timed
statements, not per-query or isolated launch latency. O3 is diagnostic-only. The
fresh four-client mixed-write report
`cap-final-release-o3-c4-mixed1m-fresh` timed out after 300 seconds with clients
serialized on relation extension. A separate contaminated multi-workload run
logged PostgreSQL `IO in wrong state: 0` in its AIO state machine; its derived
throughput is invalid.

The declared embedded settings `io_method=sync` and `shared_buffers=32MB` also
have the following earlier same-profile runs:

- `cap-final-safe-o2-c4-100k-embedded192m` completed all four workloads at a
  192/176 MiB hard/high limit. Readiness was 66.515 MiB PSS; fan-out PSS was
  97.205/131.709/116.643/130.838 MiB; bulk rates were
  368,201/306,396/34,344/114,580 logical row ops/s. It recorded 4,650 high
  events but no max/OOM/swap event.
- `cap-final-safe-o2-c4-100k-embedded160m` also completed at 160/144 MiB, but
  recorded 11,804 high events and only 13,703 update ops/s. With no high
  threshold, `cap-final-safe-o2-c4-100k-embedded160m-nohigh` still recorded
  10,168 max events and only 16,062 update ops/s.

Thus 160 MiB is survival-only. The 192 MiB evidence is a pressure tier whose
sustained write path is dominated by page-cache reclaim. The newer 256/224 MiB
budget pass establishes useful headroom for the exact workload, but the
embedded settings are still not a durability or latency-qualified product
profile.

### Historical measured-carrier native comparison

The final `96711c97…` binary ran the selected five 100,000-row workloads with
one warmup and five measured samples per native/WASIX target on the same host.
All 50 measured executions passed.

| Workload | Native median | WASIX median | WASIX/native |
| --- | ---: | ---: | ---: |
| md5 scan | 47.561 ms | 52.487 ms | 1.104x |
| indexed hot read | 55.540 ms | 70.558 ms | 1.270x |
| indexed update | 692.462 ms | 900.734 ms | 1.301x |
| indexed insert | 488.384 ms | 653.214 ms | 1.338x |
| indexed point loop | 275.550 ms | 389.323 ms | 1.413x |

This confirmed that the original goal was not met: CPU-heavy work was relatively
close, while tuple/index/storage paths remain roughly 27–41% slower at the
median. Five samples are too few for a tail-latency budget.

### Fence-build repeated workload

Across the valid 20-attempt `cccd10e0…` sequence, successful row-operation
rates were:

| Workload | Median ops/s | Range | Run-to-run CV |
| --- | ---: | ---: | ---: |
| Indexed read | 343,891 | 315,186–444,444 | 10.6% |
| Mixed write | 426,367 | 376,648–486,914 | 6.7% |
| Indexed update | 180,203 | 164,204–202,840 | 6.5% |

The persistent 20 Hz `pg_stat_activity`/`pg_locks` sampler adds a WASIX backend
and diagnostic work. The nominal conservative 20-run rates cannot be used to
compare lowering modes because those runs reused the default artifact.

### Pre-fence native comparison (historical)

Warm single-backend tests used 100,000-row workloads, one unrecorded warmup,
and five samples on the same host:

| Workload | Native median | WASIX median | WASIX/native |
| --- | ---: | ---: | ---: |
| md5 scan | 48.516 ms | 49.266 ms | 1.015x |
| indexed update | 720.707 ms | 884.204 ms | 1.227x |
| indexed hot read | 56.696 ms | 72.004 ms | 1.270x |
| indexed insert | 486.357 ms | 673.287 ms | 1.384x |
| indexed point loop | 272.297 ms | 388.930 ms | 1.428x |

The sustained pre-fence four-client runs that completed placed WASIX at 83.8%
of native for indexed read, 85.2% for mixed write, and 88.8% for indexed
insert. A sequence-dependent indexed-update run stalled and is part of the
liveness evidence above. These ratios are pre-fence historical
characterization and are not current carrier evidence.

### Memory boundary

The first paired physical-memory report is:

```text
target/oliphaunt-wasix-postmaster/reports/concurrent-query-suite/
  embedded-pss-baseline-c1-i100k/
```

It ran native and WASIX targets with one client, 100,000 iterations, a 100 ms
resource interval, and Linux `smaps` snapshots. All four workloads completed and
verified. Readiness was:

| Target | Host processes | summed RSS | summed PSS | summed private |
| --- | ---: | ---: | ---: | ---: |
| Native | 9 | 49.39 MiB | 19.27 MiB | 14.36 MiB |
| WASIX | 1 | 241.41 MiB | 226.94 MiB | 224.65 MiB |

WASIX one-client phase peaks and throughput ratios were:

| Workload | WASIX PSS | WASIX private | WASIX/native ops/s |
| --- | ---: | ---: | ---: |
| Indexed read | 247.41 MiB | 239.41 MiB | 0.679x |
| Mixed write | 259.99 MiB | 251.83 MiB | 0.596x |
| Indexed update | 272.83 MiB | 264.41 MiB | 0.708x |
| Indexed insert | 266.41 MiB | 257.88 MiB | 0.726x |

The readiness snapshot classified 150,396 KiB PSS as anonymous read/write,
40,440 KiB as file-executable, 12,272 KiB as anonymous executable, 9,105 KiB
as other file-backed, and 11,197 KiB as PostgreSQL shared aliases. Those shared
aliases occupy 1,310,784 KiB of virtual mappings but do not represent that much
unique physical memory. Another 58,534,112 KiB of anonymous static-memory/guard
reservation had zero RSS and PSS.

This is an old-carrier baseline, not an optimized result. The measured binary
predates the tracked elastic-worker and file-mapped-AOT changes. Readiness had
only three native and four WASIX samples and was not held at stable quiescence;
the WASIX phase still reported a 114% lifetime-averaged `ps` CPU peak. There was
one native-then-WASIX run with fixed workload order, so it provides neither
confidence bounds nor a marginal-backend slope.

### Exploratory sealed-headless memory snapshots

Two later manual Linux process snapshots are retained under:

```text
target/oliphaunt-wasix-postmaster/sealed/headless-ready-rss/
target/oliphaunt-wasix-postmaster/sealed/headless-detached-ready-rss/
```

| Evidence label | Phase | RSS | PSS | PSS anonymous/file | Private | Threads |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `headless-ready-rss` | sealed headless, archive retained | 199,172 KiB | 184,822 KiB | 121,616 / 63,206 KiB | 182,116 KiB | 46 |
| `headless-detached-ready-rss` | detached after a 20-connection exercise | 171,296 KiB | 156,870 KiB | 127,208 / 29,662 KiB | 154,156 KiB | 46 |

The old baseline report records 232,387 KiB PSS, formatted as 226.940 MiB;
226,940 KiB would be a unit-conversion error. The non-detached snapshot is
47,565 KiB (20.5%) below that old peak. The detached snapshot is 27,952 KiB
(15.1%) below the non-detached observation and 75,517 KiB (32.5%) below the old
peak.

These deltas are **exploratory**, not attributed savings or a product budget.
They are single observations on one Linux host, roughly two seconds into each
process, without repetitions, cgroup charge, a simultaneous native control, or
identical phases. The detached sample follows a 20-connection exercise while
the non-detached sample is a readiness capture. File PSS fell by 33,544 KiB and
anonymous PSS rose by 5,592 KiB, directionally consistent with archive
detachment but insufficient to isolate causality. No macOS or Windows evidence
was collected.

The 100-attempt liveness gate's earlier 353–743 MiB WASIX phase-peak RSS remains
useful operational telemetry only. It had no native target or PSS, always ran
read then mixed write then update in one postmaster, and added a persistent
diagnostic backend. Native process-tree RSS double-counts shared mappings; the
one-process WASIX carrier also counts the same PostgreSQL file pages at multiple
guest-address aliases. Neither series is a physical-memory budget.

The historical v2 carrier exercised the focused correctness suite and the
cgroup/PSS runs recorded above. It makes no repeated balanced native/WASIX,
complete N=0/1/2/4/8/16 launch/reap, persistent-query, or reconnect-latency
claim. The detailed root-cause ledger, rejected shortcuts, and reproducible protocol are in
[rss-memory-model.md](rss-memory-model.md).

## Historical evidence boundary and excluded claims

The retained evidence credibly establishes the shape of the Linux x86_64
EXEC_BACKEND/postmaster architecture, exact shared-memory replay, the historical
20-probe runtime substrate, the causal lost-wake repair, real concurrent
PostgreSQL prior art, a locally sealed headless/detached execution path, and
honest performance/memory baselines. The supported strict gate selects 23
probes; this historical checkpoint did not run that full gate, so it makes no
current-source `sync-file-range` or `epoll-ofd-lifecycle` claim. The
retained evidence also establishes a streaming exact payload verifier,
focused private-image COW/isolation tests, successful 96 MiB one-client read,
historical 192/256 MiB cgroup gates, and the five-module carrier's predeclared
four-client lower-pressure memory-budget pass and bulk-throughput
characterization. It does not establish:

- repeated sealed PostgreSQL allocator/mmap churn qualification of the
  implemented reserve-before-`MAP_FIXED` shared guest-VA protocol;
- final sealed-carrier PostgreSQL DSM/futex churn evidence showing that the
  now-implemented weak, generation-safe in-process mapping registry and its
  host descriptors return to a bounded plateau through the real syscall path;
- crash-safe named shared-object ownership, leases, reclamation, and restart;
- correct autonomous one-shot/interval timers;
- a versioned fail-closed guest/host feature negotiation protocol;
- cryptographically signed release provenance, a complete native dependency
  closure, or release-qualified sealed carriers; the local loader does already
  verify the exact opened AOT mapping without a path-reopen race;
- a repeated cross-instance image/pressure matrix, full N=0/1/2/4/8/16
  launch/reap slope, or true query/reconnect latency for the post-start image;
- Linux arm64, macOS arm64, or Windows x64 qualification; browser postmaster
  support is intentionally excluded;
- broad PostgreSQL regression, crash/recovery, WAL/power-loss, orphan/reap,
  DSM churn, and filesystem-specific correctness; or
- native-like sustained four-client write throughput, query-tail latency, and
  a workload-general marginal-backend memory budget. The O3 relation-extension
  stall and AIO-state error are explicit blockers, not omitted samples.

Focused ownership, final-drop, inode-replacement, ABA-race,
bounded-pruning, and host-FD churn tests now establish the registry's internal
lifetime contract. They are intentionally not treated as evidence for the
separate crash-safe named shared-object contract or as a substitute for real
PostgreSQL churn evidence.

This directory is non-release prior art and has no `release.toml`, release tag,
or SDK resolution metadata.
