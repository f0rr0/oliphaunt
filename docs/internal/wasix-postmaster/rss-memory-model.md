# WASIX PostgreSQL Physical-Memory and Performance Model

This document is the memory/performance evidence ledger for the
`EXEC_BACKEND` postmaster design. It supersedes the imported checkpoint's
RSS-only model. The original measurements remain useful historical evidence,
but summed RSS is not a physical-memory budget for either native PostgreSQL or
the one-process WASIX carrier.

The design objective is native single-backend-like throughput and latency with
real PostgreSQL postmaster concurrency. It does not permit replacing fresh
backend instances, exact shared-memory reattachment, PostgreSQL error recovery,
or durability semantics with a cheaper single-user approximation.

## Evidence language

Every conclusion in this document has one of four strengths:

- **Measured** means it appears directly in a retained generated report from a
  named carrier and workload. It is not automatically portable to another
  carrier, host, or workload.
- **Exploratory measurement** means a retained manual snapshot has known phase,
  repetition, control, or isolation gaps and cannot establish a causal saving
  or support budget.
- **Proven mechanism** means source inspection and mapping/process evidence
  establish a causal allocation or retention path. It does not claim an
  optimized end-to-end result.
- **Unclaimed** means an architectural prediction without paired evidence.

Do not turn an expected saving into a product claim by subtracting allocations
from an old RSS number. Reclaimable file residency, allocator reuse, page-cache
charging, and concurrent peaks make such arithmetic unreliable.

The research runtime also has a receipt-bound host-task policy. Its guest
control plane and blocking-worker pool share a 96-task ceiling, the pool keeps
only one core worker, and excess workers retire after one second. Ninety-one of
those slots conservatively cover the PostgreSQL 18 root plus every configured
PM-child slot; five are transition/overload reserve. This targets retained host
thread stacks and allocator arenas without pooling mutable PostgreSQL backends
or changing fresh EXEC_BACKEND state. It is a proven configuration mechanism,
not a measured RSS saving.

## Measured old-carrier baseline

The first paired Linux PSS baseline is retained at:

```text
target/oliphaunt-wasix-postmaster/reports/concurrent-query-suite/
  embedded-pss-baseline-c1-i100k/
```

It used PostgreSQL 18.4, the `safe-o2` guest, one client, 100,000 iterations,
100,000 seed rows, a 100 ms resource interval, and memory-map snapshots. The
WASIX carrier was Wasmer 7.2.0-alpha.2 binary
`96711c979951afe7087ca40b250cb969a87d49638d41149db82445026b0ac9b4`.
All four native and WASIX workloads completed and verified.

This is explicitly an **old-carrier baseline**. Its binary predates the tracked
elastic-worker, sealed-headless, detached-AOT, immutable-image, shared-import,
and lazy-activation changes described below. Later historical optimized
PSS/cgroup results are reported separately; this section remains the
historical starting point rather than being rewritten as though the old binary
contained those mechanisms.

### Readiness

| Target | Host processes | summed RSS | summed PSS | summed private |
| --- | ---: | ---: | ---: | ---: |
| Native | 9 | 49.39 MiB | 19.27 MiB | 14.36 MiB |
| WASIX | 1 | 241.41 MiB | 226.94 MiB | 224.65 MiB |
| WASIX minus native | — | 192.02 MiB | 207.67 MiB | 210.29 MiB |

The measured readiness PSS gap is therefore real and large; correcting the RSS
method did not make the embedded-memory problem disappear. It did make the
comparison physically meaningful.

This is one run, not a confidence interval. The readiness phase contained only
three native and four WASIX samples, and the WASIX phase peak still reported
114% lifetime-averaged `ps` CPU. It was not the new quiescent-readiness
protocol. Treat the values as a reproducible optimization baseline, not a
release budget or a stable-idle lower bound.

### One-client workload peaks and throughput

PSS and private values below are phase peaks from Linux `smaps_rollup`. Ops/s
counts logical rows processed inside bulk SQL or a server-side loop; it is not
client request or transaction throughput.

| Workload | Native ops/s | WASIX ops/s | WASIX/native | Native PSS/private | WASIX PSS/private |
| --- | ---: | ---: | ---: | ---: | ---: |
| Indexed read | 155,148 | 105,364 | 0.679x | 35.06 / 23.88 MiB | 247.41 / 239.41 MiB |
| Mixed write | 290,276 | 172,861 | 0.596x | 38.38 / 26.61 MiB | 259.99 / 251.83 MiB |
| Indexed update | 129,199 | 91,408 | 0.708x | 56.43 / 44.51 MiB | 272.83 / 264.41 MiB |
| Indexed insert | 146,199 | 106,157 | 0.726x | 44.25 / 32.23 MiB | 266.41 / 257.88 MiB |

The WASIX-minus-native PSS delta stays between 212.35 and 222.16 MiB in this
one-client run. That is consistent with a dominant fixed carrier/runtime cost;
it makes no marginal-live-backend claim.

### Readiness mapping classes

The WASIX readiness snapshot classifies 226.93 MiB PSS as follows. Categories
are mapping shapes, not allocation-owner telemetry; in particular,
`anonymous-rw` cannot by itself distinguish Wasmer objects, guest-private
pages, thread arenas, and temporary buffers.

| Mapping class | mapped virtual size | RSS | PSS | What is established |
| --- | ---: | ---: | ---: | --- |
| PostgreSQL shared aliases | 1,310,784 KiB | 22,000 KiB | 11,197 KiB | The same file-backed PostgreSQL mappings appear at multiple guest addresses. |
| Anonymous read/write | 709,256 KiB | 150,396 KiB | 150,396 KiB | This is the largest physical class and needs finer runtime ownership counters. |
| Anonymous executable | 12,284 KiB | 12,276 KiB | 12,272 KiB | JIT/AOT executable mappings are resident. |
| File executable | 81,520 KiB | 43,100 KiB | 40,440 KiB | The compiler-bearing CLI and native libraries impose a material fixed floor. |
| Other file-backed | 42,192 KiB | 10,468 KiB | 9,105 KiB | File-backed data is reclaimable under pressure but resident in this snapshot. |
| Heap | 9,128 KiB | 8,844 KiB | 8,844 KiB | The mapping named `[heap]`; this excludes secondary allocator arenas. |
| Anonymous reservations | 58,534,112 KiB | 0 KiB | 0 KiB | Static Wasm bounds/guards reserve address space without consuming resident pages. |

The snapshot total is 232,374 KiB PSS, within 13 KiB of the sampled readiness
phase peak. The category table is therefore a useful decomposition of that
moment, but its broad anonymous bucket is not a final ownership model.

## Exploratory sealed-headless snapshots

The implemented Linux x86_64 research carrier was captured manually before and
after detached AOT deserialization. The raw files are retained at:

```text
target/oliphaunt-wasix-postmaster/sealed/headless-ready-rss/
target/oliphaunt-wasix-postmaster/sealed/headless-detached-ready-rss/
```

| Evidence label | Phase | RSS | PSS | PSS anonymous | PSS file | Private | Threads |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Historical compiler-bearing v1 carrier | old non-quiescent readiness peak | 247,204 KiB | 232,387 KiB | 173,760 KiB | 58,627 KiB | 230,040 KiB | — |
| `headless-ready-rss` | sealed headless, serialized archive retained | 199,172 KiB | 184,822 KiB | 121,616 KiB | 63,206 KiB | 182,116 KiB | 46 |
| `headless-detached-ready-rss` | detached after a 20-connection exercise | 171,296 KiB | 156,870 KiB | 127,208 KiB | 29,662 KiB | 154,156 KiB | 46 |

The old `resource-summary.tsv` records 232,387 KiB and formats it as
226.940 MiB. Writing `226940 KiB` would mix those units. The descriptive PSS
deltas are:

- headless versus old peak: -47,565 KiB (-20.5%);
- detached versus non-detached: -27,952 KiB (-15.1%); and
- detached versus old peak: -75,517 KiB (-32.5%).

These are **exploratory measurements**. Each new point is one process snapshot
on one Linux host at roughly two seconds elapsed, without repeated fresh runs,
a cgroup, pressure testing, a same-phase native control, or a connection
ladder. The phases also differ: non-detached is a readiness capture, while the
detached point follows a 20-connection exercise. The 33,544 KiB file-PSS drop,
5,592 KiB anonymous-PSS increase, and 27,952 KiB total-PSS drop are directionally
consistent with releasing mapped AOT archives after linking, but they do not
isolate detachment or prove an additive 32.5% product saving. No all-platform
claim follows from Linux `smaps_rollup`.

## Last measured sealed-carrier evidence (historical)

The last measured Linux x86_64 research runtime had ABI
`995f6a9bf69ce6ff154533369eb4f9d6c45d9dfca13fdc213e0f6be8ae405217`.
Its verified historical carrier is retained at:

```text
target/oliphaunt-wasix-postmaster/carriers/wasix-postmaster-18.4-995f6a9bf69ce6ff-8e907e600fa9d7197c2ae98ddece5cb3093e4e7e3caf8f27f325a24955c120a7/
```

The suffix is the full `payload.files` SHA-256. Binding the runtime ABI and
payload content in the default name prevents safe-O2/O3 profile collisions.
The final `payload.files` and manifest SHA-256 values are respectively
`8e907e600fa9d7197c2ae98ddece5cb3093e4e7e3caf8f27f325a24955c120a7`
and `cea8c0933fa01f6646184c1f97c2156300e50bcf8a5d1d2e38fbb4ed2bb11fec`.

That carrier's `final-995f-embedded-c4-lower-pressure-v1` run passed the
predeclared candidate budget on one Linux x86_64 host:

| Gate | Observed | Predeclared ceiling |
| --- | ---: | ---: |
| Readiness PSS | 66.862 MiB | — |
| Required-phase peak PSS | 132.708 MiB | 160 MiB |
| Required-phase peak anonymous PSS | 77.473 MiB | 96 MiB |
| Required-phase peak page tables | 1.164 MiB | 2 MiB |
| Required-phase `memory.high` event delta | 2,528 | 4,096 |
| Required-phase PSI some/full fraction | 0.003289 / 0.003289 | 0.015 / 0.010 |
| Whole-run cgroup peak | 224.707 MiB | 256 MiB hard limit |

The cgroup was configured at 256/224/0 MiB hard/high/swap. There was no
`memory.max`, OOM, OOM-kill, or swap event. Bulk row-operation rates were
352,846.832/359,874.044/42,854.082/140,449.438 ops/s for
read/mixed-write/update/insert. The budget profile itself remains
`research-only`: this pass is one exact memory/workload result, not a
composed release, latency, durability, or platform qualification.
The source and builder recipe have since changed; no carrier produced from the
current source is admitted.

It is also warm-state rather than cold-ownership evidence. The outer harness
fully verified the carrier and ran initdb before creating the measured server
scope, so those operations could populate and own carrier/PGDATA page cache.
The active-scope PSS and budget observations remain useful, but cold embedded
qualification now additionally requires the targeted-eviction/mincore receipt
and controller-statused cgroup-I/O contract in
[cold-ownership-qualification.md](cold-ownership-qualification.md).
If the delegated scope has no I/O controller, the memory/page-residency proof
can still pass, but I/O totals stay blank and the run makes no storage-I/O
first-touch claim.

The earlier staged readiness/quiescent-readiness ladder is historical:

| Report | PSS | Architecture present in that run |
| --- | ---: | --- |
| `embedded-pss-baseline-c1-i100k` | 226.940 MiB | Historical compiler-bearing carrier. |
| `sealed-detached-paired-c1-i100k-r2` | 150.062 MiB | Compiler-free sealed registry and detached AOT. |
| `cow-image-fixed-c1-i100k` | 129.929 MiB | Corrected immutable post-start private image. |
| `cow-arc-import-c1-i100k` | 113.901 MiB | Shared immutable linker/import ownership. |
| `cow-lazy-artifact-c1-i100k` | 79.101 MiB | Exact eager exports and lazy activation of remaining AOT state. |

This sequence is **measured trajectory**, not component accounting. The runs
were successive implementation points, so a row can include unrelated code,
phase, allocator, and kernel-state differences. It does establish that the
postmaster idea did not have to be removed to move the stable readiness class
from roughly 227 MiB to roughly 79 MiB.

### Cgroup pressure gates

All older named results below used a compiler-free carrier, swap disabled,
verified SQL results, and no `memory.max`, OOM, or OOM-kill event. They are
retained comparison evidence, not the final `995f6a9b…` budget run:

| Report | Connections/work | Hard/high | Readiness PSS | Workload fan-out PSS |
| --- | --- | --- | ---: | --- |
| `cap-final-wasix-c1-100k-192m` | 1; all four 100k workloads | 192/160 MiB | 77.995 MiB quiescent | 98.640 read; 121.291 mixed; 149.189 update; 154.604 insert MiB. |
| `cap-content-addressed-final-c1-read-96m` | 1; read 100k | 96/88 MiB | 77.761 MiB | 95.171 MiB sampled PSS; 88.629 MiB whole-run cgroup peak; 220 high events. |
| `cap-final-wasix-c4-100k-192m-pressure` | 4; all four 100k workloads | 192/176 MiB | cgroup evidence only for key fan-out phases | All workloads passed without max/OOM/swap; active reclaim makes this a survival tier. |
| `cap-final-wasix-c4-100k-256m` | 4; all four 100k workloads | 256/224 MiB | 90.157 MiB quiescent | 107.576 read; 195.131 mixed; 219.062 update; 219.653 insert MiB. |

The final content-addressed 96 MiB read run delivered 100,548 logical row
ops/s. PSS can exceed the cgroup peak because proportional process accounting
and cgroup charge have different ownership and sampling boundaries.

The 192 MiB four-client run delivered 391,459/286,225/49,364/89,346 logical
row operations per second for read/mixed/update/insert. The 256 MiB run
delivered 381,944/330,169/65,628/110,345. The read difference is ordinary
run noise; the approximately 13%/25%/19% mixed/update/insert reductions at the
tighter limit show that 192 MiB is not a free equivalent of the 256 MiB
lower-pressure characterization. Neither historical run carried the new
predeclared PSS/high/PSI budgets, so only the 192 MiB survival distinction is
gating evidence.

`cap-final-wasix-c4-read1m-maps` provides one clean connection-slope point:
78.068 MiB at quiescent readiness, 108.274 MiB during four active read clients,
and 93.674 MiB after quiescence. That is about 7.5 MiB PSS per active read
backend above readiness. It is not a general slope for writes, idle sockets,
launch peaks, or more than four clients.

The default benchmark values are bulk batch wall time and logical row-operation
rates. They are not individual-query samples, request/transaction throughput,
backend launch latency, or p95/p99. The opt-in native-libpq lane now records
raw `CLOCK_MONOTONIC` persistent-query samples and separately measures complete
`PQconnectdb` through `SELECT 1` and `PQfinish` reconnects. Its strict parser
emits nearest-rank percentiles only from the exact requested all-success
measured rows; warmups remain visible in raw evidence but are excluded.

### Alias and private-memory attribution

Raw RSS still looks alarming because it counts each resident page-table alias.
In a live 14–15-guest diagnostic, approximately 650 MiB of RSS belonged to
repeated aliases of one approximately 142 MiB PostgreSQL shared-memory file;
proportional accounting charged roughly one physical backing. Depending on
phase, the process reported roughly 783 MiB–1.03 GiB RSS while PSS was roughly
255–262 MiB. This is why both PSS and dedicated-cgroup charge are mandatory.

The immutable memory images are not the remaining large private class: the
diagnostic attributed roughly 230 KiB private per guest and about 5 MiB
aggregate PSS to image mappings. Idle guest anonymous tails were about 219 KiB
each; four active query tails were about 5.76 MiB resident each. The material
Wasmer-specific anonymous classes were instead host arenas/heap (two observed
classes around 22 and 17.7 MiB), about 17.35 MiB anonymous RX code, and dense
per-instance metadata/tables/import state. These are mapping-shape observations
on one host, not allocation-owner byte guarantees, but they determine the next
instrumentation targets.

### Declared embedded PostgreSQL profile

Valid same-runtime-ABI runs now exercise `io_method=sync` and
`shared_buffers=32MB`. The setting removes three AIO-worker guest instances:

| Report | Hard/high | Readiness PSS | Fan-out PSS read/mixed/update/insert | Pressure and bulk-rate result |
| --- | --- | ---: | --- | --- |
| `final-995f-embedded-c4-lower-pressure-v1` | 256/224 MiB | 66.862 MiB | 97.635/132.120/117.302/132.708 MiB | Passed predeclared PSS/anonymous/page-table/high/PSI gates; 2,528 high events and no max/OOM/swap; 352,846.832/359,874.044/42,854.082/140,449.438 ops/s. |
| `cap-final-safe-o2-c4-100k-embedded192m` | 192/176 MiB | 66.515 MiB | 97.205/131.709/116.643/130.838 MiB | 4,650 high events, no max/OOM/swap; 368,201/306,396/34,344/114,580 ops/s. |
| `cap-final-safe-o2-c4-100k-embedded160m` | 160/144 MiB | 66.842 MiB | 97.618/132.100/116.262/140.044 MiB | 11,804 high events, no max/OOM/swap; update fell to 13,703 ops/s. |
| `cap-final-safe-o2-c4-100k-embedded160m-nohigh` | 160/max | 66.383 MiB | 96.955/131.446/116.424/140.772 MiB | 10,168 max events, no OOM/swap; update was 16,062 ops/s. |

The 160 MiB profile is survival-only. Removing `memory.high` merely moves
reclaim to repeated hard-limit hits; it does not create usable write headroom.
The 192 MiB profile materially lowers PSS but remains pressure-sensitive, with
page-cache reclaim dominating update throughput. The final 256/224 MiB run is
the first pass against the predeclared lower-pressure gates. It is one exact
historical memory/workload result and makes no aggregate correctness, latency,
lifecycle, durability, or release claim. It must not be presented as
carrier-overhead removal or as weakening WAL durability, fences, fsync, or
isolation.

## Why raw RSS and VSZ mislead

### RSS counts mappings, not unique physical pages

Native PostgreSQL has a postmaster plus OS backend processes. Summing every
process's RSS counts a shared buffer or shared library once for every process
whose page table maps it. That overstates the native tree's physical charge.

WASIX has the inverse-looking but related problem inside one OS process. The
same PostgreSQL main shared-memory file is mapped into each guest linear memory
at a different host virtual address. Linux RSS counts a resident page at each
alias because each alias has a resident page-table entry. The readiness map
therefore reports 1.25 GiB of PostgreSQL-shared virtual mappings while their PSS
is only 10.93 MiB. A historical stalled sample summed 371,764 KiB RSS across 13
aliases of one 145,464 KiB file even though the aliases could not represent that
many unique physical file pages.

PSS divides each physical page by its map count and is the primary comparable
process metric on Linux. It is still incomplete: it excludes kernel memory and
unmapped page cache, and cgroup charging of shared file cache depends on who
faulted the page. Pair it with a dedicated cgroup's `memory.current`,
`memory.peak`, and `memory.stat` rather than replacing one imperfect number with
another.

The guest `/dev/shm` backing is now an explicit diagnostic variable rather
than an implicit filesystem accident. The default `portable-file-v1` retains
the historical run-tree directory; opt-in `linux-tmpfs-v1` proves a private
host-tmpfs directory and the live PostgreSQL object placed on it. Tmpfs does
not erase cgroup charge and may be unreclaimable with zero swap, so this A/B
tests writeback/refault pressure rather than claiming free RSS. See
[shared-memory-backing-experiment.md](shared-memory-backing-experiment.md).

### VSZ is mostly an intentional reservation

The PostgreSQL module declares a 4 GiB maximum memory. On a 64-bit host the
pinned Wasmer tunables select a 4 GiB static bound plus a 2 GiB guard so common
accesses can avoid explicit bounds checks. Each fresh guest instance therefore
reserves about 6 GiB of virtual address space. Nine PostgreSQL roles account for
about 54 GiB before other mappings; the readiness snapshot's 55.82 GiB
anonymous-reserved class has zero RSS and PSS.

This reservation is not free in every sense: it consumes address space, VMAs,
and some page-table/kernel metadata and can collide with platform-specific
fixed mappings. It must be bounded and measured on each 64-bit embedded host.
It must not be reported as 56 GiB of RAM, and it must not be shrunk blindly at
the cost of a bounds check on every guest access.

## Proven root causes, ranked

### 1. Blocking worker retention and allocator arenas

**Proven mechanism.** The old Tokio task manager configured both the core and
maximum `rusty_pool` sizes as `max(200, available_parallelism * 100)`. On the
16-CPU evidence host that is a 1,600-worker core target. Blocking WASIX guest
tasks caused workers to be created, and core workers then remained for the
pool's lifetime.

Historical mapping evidence held the guest-instance count at nine while native
thread stacks grew from 53 at readiness to 83 after short client churn;
64 MiB-shaped glibc secondary arenas grew from 49 to 72. RSS rose by about
24.9 MiB and VSZ by about 1.97 GiB after the clients had exited. This proves a
host thread/allocator-retention path distinct from a guest-process leak.

The tracked runtime source now has one persistent core worker, elastic growth,
and a one-second idle timeout for non-core workers. A focused pool test proves
non-core workers retire. Replacing the channel-based one-slot broadcaster with
a `Mutex`/`Condvar` slot also removed 18 persistent helper threads in the
current topology. The safe-O2 cgroup runs observed 29–32 host threads across
one- and four-client phases instead of the earlier detached snapshot's 46.
This is end-to-end evidence for a lower bounded topology, but it makes no
N=0/1/2/4/8/16 retirement-curve or allocator-plateau claim. The default maximum
is an emergency ceiling, not a supported admission policy.

One host thread per currently blocking guest remains the safe near-term model.
Eliminating live-worker cost requires a compiler/runtime continuation at every
blocking WASIX import; it cannot be simulated safely by letting PostgreSQL
process state share an arbitrary asynchronous stack.

### 2. AOT cache deserialization retained the artifact anonymously

**Proven mechanism.** The old filesystem module cache read the entire artifact
into a `Vec<u8>` and passed a byte slice to `Module::deserialize`. The artifact
archive owns its input buffer, so that copy remained alive with the shared
module. A historical 28,125,576-byte artifact corresponded to a persistent
27,472 KiB resident anonymous mapping, and loading temporarily needed both the
read buffer and retained archive.

The normal cache path now maps artifacts from files instead of retaining a
`Vec<u8>`. The sealed loader goes further with detached deserialization: after
validating the complete archive it links executable sections, owns only the
module metadata/data initializers/CPU bits/frame data required for execution,
and releases the serialized archive mapping. A detached module cannot be
serialized again, preventing an API caller from assuming the discarded archive
still exists.

Receipt schema v2 now measures this boundary directly. It records Linux
`mincore(2)` pages/bytes after hash/inspection, after the detached deserializer
returns, and immediately after file DONTNEED, together with exact advisory
call/success/errno fields. The probe maps the immutable descriptor `PROT_NONE`,
so it cannot refault payload bytes and does not touch the anonymous executable
allocation. These observations separate “the loader called DONTNEED” from “the
kernel made the file pages reclaimable”; only the latter can explain a reduced
file-cache contribution.

Preinitialized-image validation has a related intentional demand-paging
tradeoff. Every fresh backend compares the complete post-start prefix before
remapping it, which faults all image-source pages even when that backend will
use only a small subset. For a direct immutable image the runtime therefore
issues file DONTNEED after a successful comparison and immediately before the
private fixed remap. This may add one later fault for each actually used clean
page, but avoids turning validation itself into a full-prefix steady-state
working set; the advice never targets the current anonymous guest memory or
dirty COW pages. Copy-backed images do not take this source-eviction path. The
call/result is traced and unit-tested, while the final latency-versus-PSS value
must be decided by the rebuilt-carrier campaign rather than assumed here.

**Exploratory measurement:** file PSS is 63,206 KiB in the non-detached
headless snapshot and 29,662 KiB after detachment. Total PSS is 27,952 KiB lower
in the latter snapshot, while anonymous PSS is 5,592 KiB higher. Different
phases prevent causal attribution. Repeated same-phase A/B runs under cgroup
pressure must prove that archive pages are released/reclaimable without
regressing cold load, backend launch, or execution.

### 3. Every filesystem EXEC_BACKEND child rereads and rehashes PostgreSQL

**Proven mechanism.** `BinFactory` caches `BinaryPackage` values but not
`Executable::Wasm`. A host filesystem `VirtualFile` does not provide an owned
buffer, so `load_executable_from_filesystem` allocates and reads the full file.
`spawn` then constructs `HashedModuleData`, hashing the bytes before the shared
module cache can return the already-compiled module. This repeats for startup
roles and every backend exec.

The measured checkpoint PostgreSQL guest was 10,853,617 bytes. Historical map
evidence found a matching approximately 10,604 KiB anonymous high-water allocation. The
module cache prevents repeated compilation; it does not prevent this raw-Wasm
I/O, allocation, and hashing path. It affects connection/launch latency and
allocator high-water even when steady-state SQL timing excludes it.

**Implemented research architecture:** the sealed manifest maps exact guest
paths to preverified raw-module digests and detached AOT modules. The loader
seeds that registry once, and `Executable::SealedModule` starts the already
loaded module while preserving its module hash. Sealed paths shadow the mutable
guest filesystem; non-sealed paths keep the ordinary lookup path. Warm sealed
`EXEC_BACKEND` children therefore perform no raw PostgreSQL read, hash, or
compile.

This optimization depends on an immutable manifest-owned closure. A generic
mutable filesystem must still retain POSIX replacement semantics by validating
a stable file identity and metadata before reuse; an unsafe path-only cache is
not acceptable. Qualification must instrument raw bytes read/hashed and prove
zero on warm sealed launches.

### 4. The research CLI carries a compiler and generic deployment machinery

**Measured and proven mechanism.** The old-carrier Wasmer executable is about
142.2 MB on disk and includes LLVM/compiler and generic CLI/package paths. The
readiness snapshot has 40,440 KiB PSS in file-executable mappings; a historical
`pmap` attribution assigned about 49,936 KiB resident to the Wasmer ELF alone.

**Implemented research architecture:** `wasmer-headless` is built without a
compiler and accepts only the receipt-bound sealed AOT closure. The benchmark
disables the generic Wasmer cache, and the carrier neither compiles guests nor
ships the LLVM producer. The v2 receipt and sealed manifest bind the producer
and executor separately, so the smaller consumer is not misrepresented as the
AOT producer. The manual headless snapshot is lower than the old carrier but is
not a paired attribution experiment. Release signing, native dependency
closure, ABI negotiation, and independent platform carriers are outside this
project.

### 5. Fresh initialized guest pages were a major removable class

**Proven boundary.** EXEC_BACKEND deliberately creates a fresh store, instance,
private linear memory, stack, tables, and process-local WASIX state. The
PostgreSQL main shared-memory file alone is replayed at its exact guest address.
The live PostgreSQL roles are not a leak, and collapsing them into one shared
instance would discard the architecture being built.

The earlier detached snapshot reported 127,208 KiB anonymous PSS after the
compiler, repeated raw-module work, and serialized archive were removed. That
broad bucket included runtime objects, allocator arenas, stacks, and
guest-private pages. The later 129.929/113.901/79.101 MiB readiness ladder and
mapping attribution show that immutable initialized pages were removable, but
that they are no longer the dominant unexplained private class.

**Implemented research optimization:** construct a sealed, immutable
post-module-start linear-memory image and map it privately into each fresh
instance after byte-for-byte validation. The PostgreSQL modules use passive
segments and LLVM's `__wasm_init_memory`, which also performs BSS, atomic
initialization, data drops, and global-TLS relocation work. The runtime must
therefore run ordinary module start; statically replaying segment bytes or
pre-setting the initialization guard would change semantics.

The carrier builder uses an image-free provisional manifest, captures each of
`initdb` and `postgres` twice in independent stores, and rejects any image or
receipt difference. The final format-6 manifest requires every executable to
bind its module/runtime ABI, lifecycle phase, memory type, memory/dylink layout,
64-KiB mapping granule, stack-low boundary, image size, and digest. At runtime,
ordinary start reproduces globals, TLS work, and segment-drop state. Before
dynamic relocations or constructors, the loader compares every image byte and
replaces the matching full pages below the stack with a private file-backed
mapping. A mismatch in the sealed carrier fails closed.

This retains a fresh store, globals, tables, stack, WASIX process state, and
private mutations. It intentionally leaves the initialized partial page next
to the stack anonymous rather than remapping across the stack boundary. Only
the PostgreSQL shared-memory windows use separately declared coherent shared
backing at exact guest addresses. Do not snapshot a running postmaster/backend
and attempt to sanitize its locks, descriptors, stacks, timers, or process
state.

The current Unix implementation maps the sealed image privately into an
allocator-owned reservation. Its focused Linux tests cover exact remapping,
partial final pages, COW isolation, lifetime, seals/identity, and growth.
macOS uses the same Unix source path but remains unqualified for private-copy
Mach/vnode behavior, native page granule, hardened-runtime interactions, and
physical footprint. Windows has no supported image mapper; it needs a
read-only section mapped write-copy into replaceable placeholders with 64 KiB
allocation-granule proof. These are separate adapters: Linux evidence cannot
qualify macOS or Windows. Each adapter must prove ordinary/template startup
equivalence, cross-instance private-write isolation, exact PostgreSQL shared
coherence, grow/guard/collision behavior, tamper rejection, crash/churn, and
dirty-page/latency budgets under pressure. The complete contract is in
[architecture.md](architecture.md#immutable-post-start-linear-memory-image).

### 6. Unclaimed runtime classes

The current diagnostic identifies three unclaimed classes rather than another
guest-semantics shortcut:

1. Host allocator/arena retention and the dense heap objects owned by the
   runtime need allocation-owner counters and bounded admission/reuse policy.
   The separate bounded diagnostic-carrier contract is specified in
   [embedded-memory-architecture.md](embedded-memory-architecture.md#owner-census-diagnostic-carrier);
   it never turns object cardinality into guessed bytes.
2. About 17.35 MiB of native code is anonymous executable memory. A robust
   staged path first relocates today's absolute code directly into a strict
   regular-disk-backed Linux image, then replaces that bridge with prelinked
   position-independent text and a small writable GOT/relocation state. The
   bridge and durable format are distinct contracts in
   [embedded-memory-architecture.md](embedded-memory-architecture.md#runtime-generated-relocated-code-image-bridge).
3. Immutable module templates are still expanded into dense per-instance
   funcref/table/import descriptors. Compact shared templates plus sparse
   per-instance overrides should reduce the backend slope while preserving a
   fresh store, private tables where required, and exact dynamic-link updates.

No saving is claimed for these classes without same-phase PSS, faults, cycles,
launch wall time, and tail-latency A/B evidence. Disk-backing executable code is not permission to accept
mutable or unsigned native bytes; it stays inside the exact carrier verifier
and runtime-ABI identity.

### Lower-priority reservations and pools

The configured 32 MiB coroutine stacks and the static memory guards mostly
appear as zero-resident reservations. The current process-global, uncapped
returned-stack queue can retain retired worker mappings and their dirty
high-water pages; no bounded-retention saving is claimed. Reducing the stack
size without PostgreSQL `max_stack_depth` and deep error-path proof risks
correctness; forcing every idle stack resident or discarding it on every query
can both hurt latency. Allocator-arena savings are likewise unclaimed.

## Explicitly unclaimed optimization scope

The retained evidence does not establish verified cross-platform native text, compact shared module templates, bounded allocator or returned-stack retention, crash-safe shared-object leases, other-host adapters, or aggregate latency and lifecycle budgets. PostgreSQL continues to use `vfork` followed by a fresh `exec`; full-state cloning is excluded.

## Rejected shortcuts

- Do not replace the postmaster with the existing single-user runtime or run
  every backend in one shared Wasmer store/linear memory. That removes the
  process isolation and EXEC_BACKEND semantics this product exists to retain.
- Do not add a full-state-cloning fallback. The historical experiment copied
  or reconstructed substantially more runtime state, made compiler-frame
  capture part of process correctness, and reached about 160 MiB per child
  before trapping on full PostgreSQL.
- Do not silently lower `shared_buffers`, `max_connections`, WAL durability,
  fences, fsync behavior, stack guards, or extension/error semantics to make a
  runtime number look smaller. Supported PostgreSQL settings may form a
  separately declared embedded product profile with its own capacity,
  durability, correctness, performance, and latency qualification; they are
  not a cure for carrier overhead.
- Do not treat `MALLOC_ARENA_MAX`, `malloc_trim`, global cache dropping, or
  unconditional `madvise` as the root fix. They are useful diagnostic A/Bs; a
  production policy needs contention, reclaim, and tail-latency evidence.
- Do not shrink the sparse 6 GiB-per-instance address reservation or 32 MiB
  coroutine stack merely to improve VSZ/RSS. Any smaller module-aware bound or
  stack must prove all guest accesses, shared fixed windows, guard and deep
  PostgreSQL stack requirements, and generated bounds-check and tail-latency
  performance.
- Do not cache an executable by path alone on a mutable filesystem. The sealed
  carrier can bind a module digest; the generic runtime must observe file
  replacement and identity correctly.
- Do not use a high-frequency SQL sampler during memory qualification. It
  creates another PostgreSQL backend and changes the object being measured.
- Do not quote process-tree RSS, a stalled run, or a five-sample maximum as
  physical memory, marginal backend cost, or tail-latency evidence.

## Reproducible measurement protocol

With prepared native and WASIX installs, a new Linux characterization run
can be started from the repository root with:

```sh
project=src/runtimes/liboliphaunt/wasix-postmaster
"$project/bin/bench-wasix-concurrent-query-suite.sh" \
  --skip-build \
  --skip-precompile \
  --target native \
  --target wasix \
  --workloads 'indexed-read mixed-write indexed-update indexed-insert' \
  --connections 1 \
  --iterations 100000 \
  --rows 100000 \
  --runtime-footprint embedded-concurrent \
  --durability safe \
  --timeout 180 \
  --resource-detail full \
  --resource-interval 0.1 \
  --quiescence-seconds 5 \
  --memory-map-snapshots \
  --label embedded-pss-baseline-c1-i100k-rerun
```

For the compiler-free path, replace `--skip-precompile` with
`--sealed-carrier DIR`. Sealed mode disables the generic cache and rejects
compiler/precompile options; build the carrier explicitly before measurement.

This command is an attribution lane, not timed qualification. It captures
full `smaps_rollup` detail but does not pass the cgroup options, so its cgroup
status is disabled and it cannot qualify a physical-memory budget. When an
attribution run does configure the dedicated cgroup and frozen budgets shown
below, collection is intentionally cumulative across the suite and may perturb
short operations. A usable cgroup report must have `passed` rows in
`memory-evidence.tsv`: every requested fan-out phase was sampled on cadence,
process birth identities remained stable across each smaps snapshot,
configured limits matched the kernel's effective values, swap stayed at zero,
and no `memory.max`/OOM event occurred. Missing optional cgroup files are
recorded as unavailable and never coerced to zero; raced or partial smaps rows
are blank and cannot contribute a peak.

Run throughput/tail qualification separately with resource sampling off:

```sh
project=src/runtimes/liboliphaunt/wasix-postmaster
"$project/bin/qualify-wasix-single-backend.sh" \
  --sealed-carrier target/oliphaunt-wasix-postmaster/carriers/headless-research \
  --blocks 10 \
  --connections 1 \
  --iterations 100000 \
  --rows 100000 \
  --runtime-footprint embedded-concurrent \
  --durability safe \
  --cgroup-memory-max 256M \
  --cgroup-memory-high 224M \
  --cgroup-swap-max 0 \
  --label embedded-timed-c1
```

The qualifier fixes one verified carrier closure and one native-oracle closure
(`postgres`, `initdb`, `psql`, regular installed `libpq` artifacts, and their
symlink topology) for the complete ABBA/BAAB run. It re-verifies both before
and after every sample, binds both identities to every raw row, compares the
exact effective native/WASIX PostgreSQL settings in every pair, verifies all
six named-profile settings against `pg_settings`, and invokes the harness with
`--resource-detail off`. Profile source digests and the deterministic
footprint -> durability -> explicit resolution are retained with the raw
samples. For native-libpq latency, the harness additionally
sets only the server's soft `RLIMIT_NOFILE` to 1024, preserves the hard limit,
and gates synchronous before/after/quiescent host-FD checkpoints. Do not merge
the full-attribution samples and timed samples into one percentile series.
The all-or-none cgroup triple is frozen in the qualifier policy and result and
is passed as explicit harness arguments after the ambient `WASIX_CGROUP_*`
variables are removed. This keeps every fresh native and WASIX server inside
the declared finite scope even though the timed lane deliberately collects no
PSS/PSI samples; use the instrumented memory lane for physical-memory claims.

The quiescence phases and `readiness-quiescent` snapshot are deliberately
stricter than the old baseline. Generated `resource-summary.tsv` contains RSS,
PSS, PSS anon/file/shmem, private pages, thread counts, and page-table totals.
Its cgroup `memory.current`, swap-current, and `pids.current` maxima are sampled
for the named phase; `memory.peak`, swap peak, and memory-event totals are
whole-run observations. A leaf scope uses `memory.events.local`; a scope with
descendant cgroups uses hierarchical `memory.events`, and the selected source
is retained in raw samples and the summary. File-cache gauges (`active_file`,
`inactive_file`, and `file_mapped`) are reported as independent phase peaks.
Exact cumulative `workingset_*_file`, `pgscan`, and `pgsteal` keys retain their
phase start/end values and first-to-last delta/rate. They are not summed with
overlapping component counters or gauges. An unavailable kernel key remains
blank and is named by the adjacent missing-key field; it is never interpreted
as zero. The column names state those distinctions. Do not assign a whole-run
peak or accumulated high event to the phase whose row happens to repeat it.

`validate-memory-evidence.sh` keeps that evidence-integrity check as its
default. A performance-tier run can additionally apply explicit, fail-closed
budgets directly to the raw full-detail samples:

```sh
"$project/bin/validate-memory-evidence.sh" \
  --samples "$report/wasix/resource-samples.tsv" \
  --target wasix \
  --interval-seconds 0.1 \
  --require-phase fanout:indexed-read \
  --require-phase fanout:mixed-write \
  --require-phase fanout:indexed-update \
  --require-phase fanout:indexed-insert \
  --require-cgroup yes \
  --memory-max 256M --memory-high 224M --swap-max 0 \
  --max-peak-pss-kib "$pss_budget_kib" \
  --max-peak-pss-anon-kib "$pss_anon_budget_kib" \
  --max-peak-page-table-kib "$page_table_budget_kib" \
  --max-cgroup-high-events-delta "$high_event_budget" \
  --max-psi-some-stall-fraction "$psi_some_budget" \
  --max-psi-full-stall-fraction "$psi_full_budget" \
  --output "$report/wasix/memory-performance-evidence.tsv"
```

The three KiB ceilings apply to the global peak across every valid sample in
the required phases; they never use summed `ps` RSS. The high-event delta and
PSI fractions are computed separately from the first and last valid cgroup
counter in each required phase and then summed. Thus setup, checkpoint, verify,
and quiescence gaps are not silently charged to fan-out. The denominator for a
PSI fraction is the corresponding summed monotonic elapsed milliseconds times
1,000, yielding elapsed microseconds. Each budgeted cgroup phase must be one
contiguous interval with at least two valid samples. Missing, raced, decreasing,
or otherwise unevaluable counters fail instead of becoming zero. Limits are
inclusive; fractions are decimal values in `[0, 1]`. The validator records
every applied limit and observed peak, delta, elapsed time, and fraction in its
`detail` field. An unbudgeted pass proves survival and evidence integrity; only
a pass against predeclared budgets can support a performance-tier claim.

The first checked-in candidate is
`profiles/memory-budgets/embedded-c4-lower-pressure-v1.tsv`. It remains
`research-only` even though the final `995f6a9b…` carrier passed its
complete four-workload memory gate: one memory pass does not compose the
independent throughput, latency, lifecycle, durability, and same-host-session
requirements. The profile fixes c4, the embedded/safe PostgreSQL profiles,
256/224 MiB hard/high limits, zero swap, and these pre-run gates: 163,840 KiB
PSS, 98,304 KiB anonymous PSS, 2,048 KiB page tables, 4,096 high events, 0.015
PSI some, and 0.010 PSI full. Those ceilings were declared before the final
carrier was measured and must not be rewritten to fit its result. Exercise the
candidate through the benchmark itself so the exact limits are frozen in its
hashed `memory-budget.tsv` receipt and bound to the validation result:

```sh
"$project/bin/bench-wasix-concurrent-query-suite.sh" \
  --skip-build \
  --sealed-carrier "$carrier" \
  --target wasix \
  --connections 4 --iterations 100000 --rows 100000 \
  --workloads 'indexed-read mixed-write indexed-update indexed-insert' \
  --runtime-footprint embedded-concurrent --durability safe \
  --checkpoint-policy controlled \
  --resource-detail full --resource-interval 0.1 --quiescence-seconds 5 \
  --cgroup-memory-max 256M --cgroup-memory-high 224M --cgroup-swap-max 0 \
  --adaptive-cache-evidence-policy constrained-linux-wal-action-v1 \
  --max-peak-pss-kib 163840 \
  --max-peak-pss-anon-kib 98304 \
  --max-peak-page-table-kib 2048 \
  --max-cgroup-high-events-delta 4096 \
  --max-psi-some-stall-fraction 0.015 \
  --max-psi-full-stall-fraction 0.010 \
  --label embedded-c4-lower-pressure-v1
```

Linux mapping snapshots are also normalized by:

```sh
bash src/runtimes/liboliphaunt/wasix-postmaster/bin/summarize-linux-smaps.sh \
  snapshot.smaps.txt mappings.tsv categories.tsv
```

A complete qualification campaign is larger than one command:

1. Put each server in its own cgroup v2; keep native `psql` clients outside it.
   Capture `memory.current`, `memory.peak`, `memory.stat`, the evidence-selected
   `memory.events.local` or `memory.events`, PSI, and `pids.current` with
   process-tree `smaps_rollup`.
2. Use the same clean `PGDATA` snapshot and explicit hot/cold cache mode. Run
   native and WASIX in randomized or balanced ABBA order for at least 20 fresh
   server repetitions; report confidence intervals, not only maxima.
3. Measure N=0,1,2,4,8,16 at stable readiness, socket-idle connection, initialized
   blocked backend, active workload, immediate disconnect, and 1/5/30/60-second
   reap points. Run both one-at-a-time churn and simultaneous waves.
4. Define stable readiness as the expected PostgreSQL role count, no transient
   control backend, low CPU, and a flat PSS slope for several seconds. Capture
   host threads, guest process/instance counts, page tables, worker queue and
   retire counters, stack-pool state, module-cache reads/hashes, and shared
   mapping identities.
5. Use `qualify-wasix-libpq-latency.sh` for alternating fresh-server ABBA/BAAB
   native/WASIX blocks. It records raw persistent-query latency and complete
   `PQconnectdb` through `SELECT 1` and `PQfinish` reconnect/backend-launch
   samples, then gates server-level paired ratios and absolute WASIX tails. The
   harness's bulk batch wall time is not either metric, and `psql` `\timing`
   excludes exec launch. See
   [true-libpq latency qualification](libpq-latency-qualification.md). Compare
   the generic filesystem
   path's guest read/hash with the sealed registry's zero-byte warm-launch
   target. Pin CPUs or cpusets, control the frequency governor, and record
   cycles, instructions, branches, cache misses, faults, migrations, and
   context switches.

On macOS use `vmmap`/physical-footprint and native mapping identity alongside
process telemetry. On Windows use process/job private working set and commit,
section-object identity, and placeholder reservation telemetry. Cross-platform
support requires the same semantic experiment on each carrier; converting a
Linux RSS threshold into another platform's differently defined metric is not
qualification.

## Evidence conclusion

The old carrier is not viable for a constrained embedded budget at 226.94 MiB
readiness PSS and 224.65 MiB private memory. The historical evidence demonstrates
that this did not require abandoning EXEC_BACKEND. The historical staged
carrier reached 79.101 MiB readiness PSS, and the last measured carrier reached 66.862
MiB while passing the predeclared four-client lower-pressure memory gate. Its
required-phase peaks were 132.708 MiB PSS, 77.473 MiB anonymous PSS, and 1.164
MiB page tables; cgroup charge peaked at 224.707 MiB under a 256/224/0 MiB
hard/high/swap configuration. Fresh instances, ordinary module start, exact
PostgreSQL shared mappings, private COW image writes, dynamic linking, and
error semantics remain part of the design.

This is viable research evidence, not release qualification. The final run's
2,528 `memory.high` events and 0.003289 PSI fractions passed the declared gates,
and its update rate improved to 42,854.082 logical row ops/s, but those are one
host and one workload shape. Earlier 192 MiB and 160 MiB tiers remain useful
pressure evidence, with the latter survival-only. O3 sustained four-client
writes exposed a relation-extension stall plus a separate AIO state error; the
balanced one-block O3 diagnostic passed throughput gates but failed three
batch-residual gates. No query-tail/reconnect-latency, WAL-durability, or
cross-platform-adapter claim is made. Guard/stack shrinking, allocator trimming,
full-state cloning, and raw-RSS accounting are excluded shortcuts. Only Linux
x86_64 has retained historical evidence; macOS and Windows are unsupported. No
current-source carrier is admitted by this historical ledger.
