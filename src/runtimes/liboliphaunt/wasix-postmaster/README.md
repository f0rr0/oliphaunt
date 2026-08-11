# liboliphaunt WASIX Postmaster

This project is the reproducible research lane for a real PostgreSQL 18
postmaster on WASIX: one postmaster accepting concurrent connections and one
isolated WASIX process per PostgreSQL backend. It is independent of
`pg_durable` and independent of the existing single-user
`liboliphaunt-wasix` product.

The source was recovered from the `f0rr0/wasix-pg18-experiment` checkpoint at
commit `aa4211f4485327cb7493863ea3380acf27c5f951`. The checkpoint demonstrated
the architecture, but it does not establish native-like throughput or
resident-memory performance and contains no defensible query-tail-latency
measurement. This directory is therefore a non-release project:
it deliberately has no `release.toml`, release-product tag, SDK carrier, or
platform-support claim.

## Shared guest patch boundary

The Rust and TypeScript WASIX bindings consume the same canonical
single-backend PostgreSQL guest. It carries patches `0040` and `0041` because
both binding hosts enforce one PostgreSQL backend execution context per
isolated WebAssembly instance, disable PostgreSQL worker processes, and reject
guest process and thread creation. Under that host contract, the specialized
spinlock and atomic implementations have no concurrent PostgreSQL observer.

This postmaster lane has the opposite concurrency contract: the postmaster and
its isolated backends coordinate concurrently through shared memory. It
therefore retains PostgreSQL's normal spinlock and atomic implementations, as
does native PostgreSQL. `postgres/main-optimizations.series` accepts compatible
algorithmic optimizations but fails closed if it names patch `0040` or `0041`.

Patch `0039` is also deliberately excluded. It is the opt-in stdio pgwire
lifecycle used by the TypeScript browser-worker transport, not a general WASIX
optimization. The Rust binding does not activate that transport; it pumps the
guest lifecycle exports. This postmaster uses PostgreSQL sockets and
`EXEC_BACKEND` process handoff, so its series does not import the patch.

## Last completed stabilization checkpoint (historical, 2026-08-09)

The imported experiment had a clean, pinned-source replay and a green Linux
x86_64 runtime plus `release-o3` guest/core proof chain at this checkpoint.
The current source and builder use the newer `runtime-build-recipe.v3`
contract, so every identity in this section is historical and superseded. No
receipt, guest, or carrier built from the current source is admitted. The
current tracked Wasmer patch is 2,255,905 bytes with SHA-256
`4a164cad0ec19dbe29cf0fe3f37e94b9f2ee9f887252b74a8eeecd6dfc41e333`.
The checkpoint runtime ABI was
`5bb33347acd61470f80c55fb7905f188375b26f99252bbad2eb81f96c0374d18`;
the Wasmer and product-executor receipt SHA-256 values are
`ee49ac11894ca5f747906898bf6a8880cc52c9a7c1a7b9c34ef97faae12c8f82`
and
`201290f0690e8ac5f59add80bb8c3857fb6397b8ec1d2d6bda70789a9715b54b`.
The superseded checkpoint Wasmer and wasix-libc patch SHA-256 values were
`5d6bc8c6f8cf250daedcefc686f0ba8b0a17662ee9fc3a8c917497c9c5e2963d`
and
`59a936d5f6398b5b60c3e6e8b6c220a02a22603daf2eb0920f227021d56ffe7d`.

The checkpoint guest proof distinguishes the 1,111 pre-export-DCE fences from
the 995 fences in the sealed module. The final module preserves the exact latch
operators, all 4,739 table entries, and the canonical `bin/postgres` proof
identity. Export closure reduced 23,187 exports to 383, local functions from
16,922 to 12,777, and local globals from 10,911 to 1,020. The checkpoint guest
receipt SHA-256 is
`7203426ba7285ff11af924191ca656a841cdc36becd9e566ef0266c9af19920e`;
the final concurrency and linear-memory receipt SHA-256 values are
`5d328952ebb63bf6a788bd89796a96c2128682f812eec99495b858a28952144e`
and
`4a218ea45b57ee9472c2645216e8ca6e9b6c00f93e154e7b39261f97027b9ab7`.

No current-source carrier is admitted by the historical checkpoint. Its proof
closure contains 27 runtime-loadable side modules, while its prototype carrier
packages only five guest modules. The current builder retains that same narrow
five-module research scope. It is not a general PostgreSQL carrier, and
`runtime/policies/sealed-side-modules.v1.tsv` is a source inventory rather than
a claim that the builder packages the complete 27-module closure.

The controlled shared-memory experiment also resolves an important
performance question. Switching the same 256/224/0 MiB run from the portable
regular-file provider to Linux tmpfs raised throughput from 57,176 to 116,686
ops/s while fan-out PSS stayed effectively flat (99.731 versus 98.314 MiB) and
cgroup peak stayed near 224.68 MiB. The gain is writeback/reclaim behavior, not
elimination of a duplicated guest-memory copy. The measurement attributes the
observed high-water RSS to Wasmer's retired coroutine-stack pool and allocator
arenas; it does not establish an RSS optimization claim.

## Architecture

The default path compiles PostgreSQL with `EXEC_BACKEND`. PostgreSQL launches a
backend with `vfork()` followed by `execv()`; WASIX maps that handoff onto its
process-state and exec syscalls and starts a fresh Wasmer instance. The child
restores PostgreSQL's serialized `BackendParameters` and reattaches the
postmaster's file-backed shared-memory segment at the original guest address
with `MAP_SHARED | MAP_FIXED`.

```text
liboliphaunt supervisor (one native host process per cluster)
  pinned Wasmer libraries + one logical WASIX process group
  PostgreSQL postmaster.wasm
    TCP listen + epoll
    file-backed main shared memory
       |
       +-- vfork + execv --> backend.wasm instance
       |                                 restore BackendParameters
       |                                 fixed-address shared-memory reattach
       +-- vfork + execv --> backend.wasm instance
```

The compiler-bearing Wasmer CLI remains the diagnostic and AOT-production
path. The research lane also contains a compiler-free `wasmer-headless`
carrier prototype with a fixed five-module PostgreSQL closure. That prototype
is not a complete carrier for the currently proven 27-side-module guest
closure and is therefore not admitted by this checkpoint. Before execution, the
carrier verifier streams an exact `payload.files` inventory and rejects a
missing, unexpected, renamed, symlinked, special, changed-during-read, or
digest/size-mismatched entry. The strict loader then verifies the manifest,
runtime ABI, producer recipe, executor identity, raw modules, and AOT bytes
before deserializing the already-compiled modules. The carrier also
contains independently reproduced post-start linear-memory images for
`initdb` and `postgres`; the builder verifies and flattens their receipts into
the manifest, and the loader maps their identical initialized prefixes
privately after ordinary module start. Exact sealed guest paths then resolve
from an immutable in-memory module registry, so warm
`EXEC_BACKEND` launches do not reread, rehash, or compile PostgreSQL. This is
implemented research machinery, not a release or all-platform support claim.

The research runtime boundary described in the
[architecture notes](../../../../docs/internal/wasix-postmaster/architecture.md)
is a minimal liboliphaunt supervisor built on Wasmer libraries; it owns verified guest/AOT
loading, mappings and futex lifetime, logical processes, signals/timers,
resource policy, and telemetry. The generic CLI and its writable cache are not
a release carrier. The local sealed manifest is research provenance, not a
cryptographic release trust root.

An earlier imported experiment cloned a backend's complete private runtime
state. It trapped before PostgreSQL server readiness and consumed roughly
160 MiB per child. That prototype, its compiler-continuation machinery, and
its probes are excluded from the canonical source and qualification gates.
The selected topology is `vfork()` followed by a fresh `exec`; failure of that
capability is fatal rather than a signal to activate a fallback.

See the [architecture notes](../../../../docs/internal/wasix-postmaster/architecture.md)
for component and support boundaries, the
[replay status](../../../../docs/internal/wasix-postmaster/replay-status.md) for
the carrier and evidence identity, the
[immutable carrier deployment notes](../../../../docs/internal/wasix-postmaster/immutable-carrier-deployment.md)
for the privileged Linux ext deployment, unprivileged direct-loader contract,
crash recovery, and current path-race trust boundary,
[cold-ownership qualification](../../../../docs/internal/wasix-postmaster/cold-ownership-qualification.md)
for the Linux page-cache/cgroup ownership contract, and
[memory model](../../../../docs/internal/wasix-postmaster/rss-memory-model.md)
for the paired PSS
baseline, proven root causes, excluded claims, rejected shortcuts, and
reproducible measurement protocol. The original checkpoint reports remain
under `docs/internal/wasix-postmaster/` and are explicitly historical evidence
rather than current support claims.

## Previously retained Linux carrier evidence

The last measured five-module research runtime had runtime ABI
`995f6a9bf69ce6ff154533369eb4f9d6c45d9dfca13fdc213e0f6be8ae405217`.
Its compiler-bearing Wasmer producer is
`b4f8f34a5fc8d2419e97359a7a58c524811d8651285383525103b12eaae1e1a4`,
its headless executor is
`b9fb2eac796ddccee98cfd1277dd8518269c47d79ecb0b1426e4cca86a611327`,
and its canonical v2 build receipt is
`163b6591fe929a28a9edb6addc55714213e33fdc581299633e7cfd2b2be729a1`.
The verified carrier is reproduced at
`target/oliphaunt-wasix-postmaster/carriers/wasix-postmaster-18.4-995f6a9bf69ce6ff-8e907e600fa9d7197c2ae98ddece5cb3093e4e7e3caf8f27f325a24955c120a7/`.
The final suffix is the full `payload.files` SHA-256. Default carrier names bind
both the runtime ABI and content identity, so safe-O2 and O3 profiles cannot
collide merely because they use the same executor ABI. The sealed manifest
SHA-256 is
`cea8c0933fa01f6646184c1f97c2156300e50bcf8a5d1d2e38fbb4ed2bb11fec`.

On one Linux x86_64 host, that historical carrier's
`final-995f-embedded-c4-lower-pressure-v1` run passed the predeclared
`embedded-c4-lower-pressure-v1` memory-performance budget. Readiness PSS was
66.862 MiB. The budgeted four-client peak was 132.708 MiB PSS, 77.473 MiB
anonymous PSS, and 1.164 MiB page tables, below the 160/96/2 MiB ceilings.
Whole-run cgroup charge peaked at 224.707 MiB under a 256 MiB hard limit and
224 MiB high threshold with swap disabled. The required fan-out phases
recorded 2,528 `memory.high` events and 0.003289 memory-PSI some/full stall
fractions, below the predeclared 4,096, 0.015, and 0.010 ceilings; there were no
`memory.max`, OOM, OOM-kill, or swap events. The measured bulk row-operation
rates were 352,846.832/359,874.044/42,854.082/140,449.438 ops/s for
read/mixed-write/update/insert. This is one passed memory-performance run on one
carrier and host. It is one historical non-release measurement and makes no
aggregate embedded-viability or cross-platform claim.

That retained run is not cold page-cache ownership evidence: its complete
carrier verification and initdb occurred outside the measured server scope and
could precharge/preheat regular-file pages. Its PSS and active-scope budget
result remain valid warm-state observations and make no cold page-cache claim.
The independent cold-ownership qualifier defines that separate evidence scope.

Earlier retained Linux carrier runs moved readiness PSS from 226.940 through
150.062, 129.929, and 113.901 to 79.101 MiB while preserving fresh backend
instances and exact shared memory. These are named successive historical runs,
not additive component accounting. The prior safe-O2 carrier completed all
four one-client workloads inside a 192 MiB hard cgroup with swap disabled and
indexed read inside 96 MiB. Its four-client 100k runs completed inside 192 MiB
as a reclaim-heavy survival tier and inside 256 MiB as a lower-pressure
characterization; their values remain optimization history, not the last
retained five-module carrier's budget evidence.

The benchmark's workload duration is bulk batch wall time. Its derived rate is
logical row operations per second, not request/transaction throughput, backend
launch latency, or a per-query p95. The optimized O3/ThinLTO/Binaryen guest
reached 0.754/0.801/0.779/0.829 of native in a direct one-million-iteration
one-client characterization. A balanced one-block 100k diagnostic passed all
throughput gates at 0.746/0.788/0.833/0.874 for read/mixed-write/update/insert,
but failed the bulk-batch residual gates for mixed-write, update, and insert.
The O3 characterization was unsuccessful: a fresh
four-client, one-million-iteration mixed-write run did not finish in 300
seconds while clients serialized on relation extension, and a separate
contaminated sequence produced PostgreSQL's `IO in wrong state: 0` AIO error.
The concurrent harness now has an opt-in native-libpq true-latency lane. It
retains raw `CLOCK_MONOTONIC` nanoseconds and per-row warmup/measure status for
both repeated `SELECT 1` calls on one persistent connection and complete
`PQconnectdb` -> `SELECT 1` -> `PQfinish` reconnect/backend-launch operations.
Only an exact all-success sample set produces nearest-rank p50/p95/p99 output;
timeouts, missing rows, failed queries, and an unclean enclosing lifecycle
leave percentile fields invalid. The implementation and a tiny native smoke
are exercised; no WASIX latency result is claimed.

Compact WASIX lifecycle snapshots are intentionally excluded from every timed
workload and true-libpq qualification run: enabling them inserts timer/select,
registry-snapshot, formatting, and file-sync work into the parked-wait path.
They are used only by `--wasix-lifecycle-plateau`, an untimed reconnect lane.
`--wasix-wait-dump-verbose` is likewise diagnostic-only in that lane: it records
per-state FD, socket, and epoll inventories for long reconnect proofs, while
every timed lane rejects it so the inventory walk cannot perturb latency.
That lane opens readiness and post-quiescence windows, atomically requests a
runtime-writer fence at each close, and waits on a separate atomically published
`wasix-runtime-fence-commit-v1` ACK. The ACK names the exact synced-log byte
offset; the visible `wasix-runtime-fence-v1` line is never itself treated as a
commit signal. Runtime records use one gapless sequence starting at one and
cover process/task ownership, process topology/thread/retirement state,
runtime-state observer ownership, private/shared futex waiters and wakers,
epoll state/subscriptions/queues/guards, shared-registry slots, mappings, and
guest FDs. The harness freezes exactly the committed prefix, re-verifies the
ACK after writing, records the ACK and frozen hashes plus offset, appends the
canonical closing marker, and makes the validator independently verify that
receipt. Stable-tail coverage must reach both fences; foreign observers/wait
kinds or contradictory aggregate state inside the terminal tail fail closed.

The current idle PostgreSQL topology legitimately contains six registered
WASIX processes and five parent-child edges, with six corresponding runtime
states. It has eleven execution leases: six active task owners plus the five
suspended parent continuations retained by the postmaster's EXEC_BACKEND
vfork/exec chain. The exploratory lifecycle policy therefore does not impose
the obsolete absolute-one topology. It requires readiness and post-reconnect
occupancy tuples to remain exactly equal and independently checks the
relational six-process/five-edge invariants. Pending child
publication, quiescence wakers, retiring nodes, stale registry entries, and
contradictory ownership still fail closed. Inner resource occupancy remains an
`exploratory-unbounded` policy whose claim scope is
`relative-to-fresh-baseline`: equality proves no reconnect growth, but not that
the fresh baseline is legitimately small. The pre-run policy hash is bound to
PostgreSQL profile, Wasmer, guest-module, and sealed-carrier identities. The
checked-in `pg18-idle-postmaster-stabilized-qualified-v1` policy provides the
distinct bounded contract; relabeling exploratory evidence is rejected.
Absolute PSS/cgroup budgets are the authority on embedded baseline size.

The lifecycle lane now establishes its readiness baseline only after a
causal PostgreSQL maintenance barrier. PostgreSQL 18's background writer emits
its first periodic running-transactions WAL record after roughly 15 seconds;
that wakes the WAL writer, which lazily opens the current WAL segment and keeps
the VFD cached. The observed aggregate guest-FD transition from 70 to 71 was
therefore PID 6, the WAL writer, opening
`pg_wal/000000010000000000000001`; PID 7 already held `global/1262` before the
transition. Rather than sleeping for the timer or special-casing an FD path,
the harness invokes `pg_log_standby_snapshot()`, records its target LSN, and
polls fresh `pg_stat_io` snapshots until the `walwriter`/`wal`/`normal` write
and byte counters increase and `pg_current_wal_flush_lsn()` reaches that LSN,
with an unchanged `stats_reset`. Only then can the readiness fence define the
steady topology. The barrier is unavailable when `wal_level` is below
`replica`, which is a fail-closed/not-applicable condition rather than a reason
to accept the cold baseline.

The policy-authoring tool can freeze a clean exploratory tuple into a distinct
exact policy; doing so never qualifies the source run:

```sh
project=src/runtimes/liboliphaunt/wasix-postmaster
report=target/oliphaunt-wasix-postmaster/reports/EXPLORATORY
"$project/bin/freeze-wasix-lifecycle-policy.py" \
  --exploratory-result "$report/wasix-runtime-plateau.tsv" \
  --log "$report/wasix/wasix-runtime-evidence.log" \
  --freeze-receipt "$report/wasix/wasix-runtime-evidence.freeze.tsv" \
  --baseline-policy "$report/wasix-lifecycle-baseline-policy.tsv" \
  --baseline-binding "$report/wasix-lifecycle-baseline-binding.tsv" \
  --output target/oliphaunt-wasix-postmaster/policies/pg18-idle-postmaster-stabilized-qualified-v1.tsv \
  --policy-id pg18-idle-postmaster-stabilized-qualified-v1
```

Qualification-bounded evidence uses an independently executed campaign with an
exact `--lifecycle-baseline-policy`. Verbose inventories are diagnostic and
excluded from timed commands.

The performance lanes are independent and do not compose into an aggregate
embedded-viability claim. This project intentionally provides no composite
classifier or release decision from their separate receipts.

The declared embedded PostgreSQL profile (`io_method=sync`,
`shared_buffers=32MB`) now has a same-carrier, four-client budget pass at
256/224 MiB hard/high: 66.862 MiB readiness PSS and 97.635/132.120/117.302/
132.708 MiB read/mixed/update/insert fan-out PSS. Earlier 192/176 and 160/144
MiB runs are retained as pressure characterizations: the former completed with
4,650 high events, while the latter's 11,804 events and severe update slowdown
make 160 MiB survival-only. This profile reduces process and memory cost; it
makes no WAL-durability, query/reconnect-latency, or other-host claim.

Raw RSS is intentionally not a physical-memory qualification metric. The carrier aliases the same
PostgreSQL shared-memory backing into multiple guest memories, so RSS counts
the same resident pages at every alias. Linux PSS plus cgroup current/peak,
events, swap, and mapping identity are the current physical-memory gates. Only
Linux x86_64 has passed them. The Unix private-image mapper exists but macOS is
unqualified; the Windows private-image mapping backend is unsupported.

## Layout

- `postgres/`: PostgreSQL port overlay and ordered PG18 patch series.
- `postgres/product-patch-provenance.toml`: native behavior, WASIX fact,
  rejected alternatives, and the exact proof obligation for locally designed
  product patches.
- `docs/internal/wasix-postmaster/semantic-cache-offers.md`: exact guest relation-I/O hint seam, numeric
  ABI classes, no-op failure contract, and explicit host-support boundary.
- `docs/internal/wasix-postmaster/shared-memory-backing-experiment.md`: versioned benchmark providers
  for the host directory behind guest `/dev/shm`, exact filesystem/object
  evidence, safe cleanup, and the Linux tmpfs diagnostic boundary.
- `postgres/experiment-patch-disposition.toml`: explicit accounting for every
  experiment PostgreSQL patch; correctness patches are carried, the five
  compatible main-owned optimizations are consumed directly through
  `postgres/main-optimizations.series`, and single-user/semantic-policy changes
  are rejected.
- `runtime/`: pinned Wasmer/wasix-libc patch exports, capability ledger, and
  blocker probes.
- `profiles/`: versioned PostgreSQL runtime-footprint and durability contracts,
  plus predeclared memory-budget contracts;
  the harness records their digests, deterministic resolution, and observed
  `pg_settings` values with every named-profile run.
- `runtime/probes/`: focused process, mapping, signal, socket, durability, and
  dynamic-loading capability probes.
- `bench/sql/`: native-versus-WASIX query workloads.
- `bin/`: preparation, build, smoke, regression, benchmark, and profiling
  entrypoints.
- `sources.lock.toml`: exact experiment provenance and upstream source pins.
- `target/oliphaunt-sources/checkouts/`: immutable exact-pin upstream source
  checkouts shared with the repository source spine.
- `target/oliphaunt-wasix-postmaster/`: disposable patched source worktrees,
  builds, installs, reports, runtime caches, and run directories (ignored by
  the repository).

## Build toolchain boundary

This research project owns its PostgreSQL and runtime experiments, but it does
not own a second WASIX compiler container. Its canonical build-time dependency
is the container recipe and environment currently owned by
`liboliphaunt-wasix` under
`src/runtimes/liboliphaunt/wasix/assets/build/`; the neutral
`source-toolchains` project owns and validates the corresponding pinned
toolchain metadata. The Moon project therefore declares
`liboliphaunt-wasix` as a build-scope dependency, runs its check, and lists the
toolchain manifest, complete Docker recipe, and environment script as explicit
inputs to every task that compiles WASIX code. A recipe change cannot leave a
cached postmaster check or build apparently unaffected.

This is build-time coupling only. The research carrier neither packages nor
loads `liboliphaunt-wasix`, and it never falls back to a stock downloaded
Wasmer. The supported repository build uses the canonical recipe root; a local
`WASIX_TOOLCHAIN_ROOT` override produces a distinct build-recipe identity and
is not evidence for the canonical carrier. The canonical recipe path is
intentionally owned by `liboliphaunt-wasix` and participates in the runtime ABI
receipt; this research project does not relocate it.

## Exec-backend qualification replay

From the repository root:

```sh
OLIPHAUNT_FETCH_SOURCES=1 moon run liboliphaunt-wasix-postmaster:source-fetch
moon run liboliphaunt-wasix-postmaster:check
moon run liboliphaunt-wasix-postmaster:prepare-postgres
moon run liboliphaunt-wasix-postmaster:prepare-runtime
moon run liboliphaunt-wasix-postmaster:runtime-build
moon run liboliphaunt-wasix-postmaster:configure
moon run liboliphaunt-wasix-postmaster:postgres-build
moon run liboliphaunt-wasix-postmaster:blocker-probes
moon run liboliphaunt-wasix-postmaster:initdb-smoke
moon run liboliphaunt-wasix-postmaster:initdb-stress
moon run liboliphaunt-wasix-postmaster:smoke
moon run liboliphaunt-wasix-postmaster:regression
# Manual repeated-liveness qualification:
moon run liboliphaunt-wasix-postmaster:backend-wave-stress
```

The source-fetch and PostgreSQL preparation steps need network access.
Runtime build, configure, probes, and WASIX smoke need a reachable Docker
daemon. Runtime compilation is intentionally manual and expensive:
`runtime-build` builds the patched Wasmer and patched wasix-libc sysroot and
runs the focused tests for the selected exec-backend runtime. It emits a
canonical
`oliphaunt.wasix-postmaster.wasmer-build.v2` receipt that binds the Wasmer and
gitlink pins, both tracked patches and prepared source states, `Cargo.lock`,
the exact libc manifests, host ABI, Rust/LLVM provenance, artifact/runtime ABI,
and separate compiler-bearing producer and compiler-free executor identities
and features. Supported entrypoints reject a missing, noncanonical,
host-mismatched, feature-mismatched, or binary-mismatched receipt and never fall
back to a downloaded or `PATH` Wasmer.

The same build now emits an isolated
`oliphaunt-wasix-postmaster-executor` binary and
`postmaster-executor-build.receipt`. This postmaster executor exposes only the
sealed run/version contract needed by the PostgreSQL carrier; it does not link
the general CLI, registry, package, WCGI, or compiler command graph. The
separate v3 receipt binds its exact parent Wasmer receipt, runtime ABI,
package/feature set, bounded embedded-postmaster runtime policy, CLI contract,
host toolchain,
and binary bytes. The full `wasmer-headless` binary remains available as an
explicit control, not an implicit fallback.

`blocker-probes` names the exec-backend capability probes explicitly. It covers
fixed shared-memory remapping, spawn/exec lifecycle, cross-instance
memory-order/latch wake, wait and signal behavior, epoll/socket readiness,
dynamic loading, and exception recovery. One-shot timers are unsupported and
remain an explicitly non-gating diagnostic. The final
`smoke` starts one postmaster and concurrent native `psql` clients, then
requires distinct backend PIDs and overlapping client lifetimes. Before it,
`initdb-stress` repeats fresh cluster creation 20 times and rejects lifecycle
warnings. After it, `regression` exercises process lifecycle, C extension
loading, and representative SQL/copy behavior through `pg_regress`.
`backend-wave-stress` is a longer manual liveness gate: it repeatedly drives
read, mixed-write, and disjoint indexed-update backend waves through one
postmaster per attempt and preserves the first timeout for diagnosis. A
persistent lock sampler reduced the historical stall to a lost latch wake
after PostgreSQL had already granted a relation-extension lock. Historical
safe-O2 evidence proved Wasmer's real sequentially consistent fence lowering
with a strict 512-round latch probe and 100/100 fresh-postmaster repetitions.
The last completed 2026-08-09 structural proof recorded 1,111 pre-seal fences
and 995 final fences, including the exact latch-critical 2/1/1 counts, after
export DCE. Those historical counts do not identify an artifact produced from
the current source. A current build is admitted only when it regenerates the
structural proof and passes the focused and backend-wave gates. The
backend-wave gate is an explicit manual qualification outside
`run-acceptance.sh`; other host/compiler configurations and one-shot timers are
outside the current support claim.

For a direct replay without Moon, first materialize the immutable pinned
sources under `target/oliphaunt-sources/checkouts/`, then run
`bin/run-acceptance.sh`. The project copies those sources before patching;
all disposable worktrees, build products, caches, run directories, and reports
remain below `target/oliphaunt-wasix-postmaster/`.

For a native control measurement, run `bin/build-native-oracle.sh` followed by
`bin/smoke-native-oracle.sh`. For the concurrent acceptance path, run
`bin/smoke-wasix-concurrent-connections.sh` after the WASIX build; this is the
same exec-backend path owned by the `smoke` task above.

Internal shell variables retain the historical `FRESH_*` prefix so the
checkpoint scripts remain auditable. Their default paths and externally visible
project identity are now stable.

The receipt is local build provenance, not a release artifact:
it does not sign or bind the PostgreSQL guest/install tree, native Wasmer
dependencies, or AOT cache. `bin/pin-runtime-artifacts.sh`
therefore creates only a repo-dependent experiment snapshot for benchmark
replay. It must not be published or resolved by an SDK as a supported product.

## Sealed headless research carrier

After `runtime-build`, `postgres-build`, and an explicit precompile, build the
local carrier atomically. The builder never compiles implicitly and rejects
host-native CPU artifacts; the current research policy is LLVM aggressive
optimization against a generic baseline CPU:

```sh
project=src/runtimes/liboliphaunt/wasix-postmaster
WASIX_PRECOMPILE_SCOPE=runtime "$project/bin/precompile-wasix-core.sh"
"$project/bin/build-sealed-headless-carrier.sh" \
  --output target/oliphaunt-wasix-postmaster/carriers/headless-research
# Paired general-headless control:
"$project/bin/build-sealed-headless-carrier.sh" \
  --executor-role full-headless \
  --output target/oliphaunt-wasix-postmaster/carriers/full-headless-control
```

Without `--output`, the builder publishes under a name containing the runtime
ABI prefix and the full final `payload.files` SHA-256. The latter is computed
after staging and verification, so different PostgreSQL profiles cannot collide
under one ABI-only default directory.

The default carrier contains only the selected postmaster executor at
`bin/wasmer-headless` and copies its exact build receipt to the root as
`postmaster-executor.receipt`. The sidecar's exact presence is the role
discriminator. A `full-headless` control omits it and binds the executor
directly to `wasmer-build.receipt`; both roles retain the format-6
manifest contract. The carrier also contains PostgreSQL `initdb` and `postgres`,
the packaged `libpq`, `dict_snowball`, and `plpgsql` side-module subset, the
PostgreSQL support tree, five AOT artifacts, the v2 build receipt, a strict
format-6 `oliphaunt.wasix-postmaster.sealed-aot.v5` manifest, the canonical
guest build receipt, two immutable
linear-memory images and their capture receipts, and a full payload file
inventory. The manifest carries a deny-unknown `file-cache-policy` object that
binds the sole approved adaptive policy, compiled config ID and config digest,
and its observe-only portable fallback. `initdb` remains observe-only. The
builder first emits an image-free format-4 capture manifest,
runs two independent isolated captures for each executable, and requires both
the image bytes and receipts to match. It then checks final headless
`initdb --version` and `postgres --version` loads through the image-bearing
manifest, runs the same exact-inventory verifier used at benchmark preflight,
and only then fsyncs and atomically publishes the directory. Verify a copied or
stored carrier independently with:

```sh
src/runtimes/liboliphaunt/wasix-postmaster/bin/verify-sealed-headless-carrier.sh \
  target/oliphaunt-wasix-postmaster/carriers/headless-research
```

Materialize a deterministic identity for an exactly verified research artifact with:

```sh
src/runtimes/liboliphaunt/wasix-postmaster/bin/current-evidence-manifest.py write \
  --carrier target/oliphaunt-wasix-postmaster/carriers/headless-research \
  --output target/oliphaunt-wasix-postmaster/evidence/current-research-artifact.json
src/runtimes/liboliphaunt/wasix-postmaster/bin/current-evidence-manifest.py verify \
  --carrier target/oliphaunt-wasix-postmaster/carriers/headless-research \
  --output target/oliphaunt-wasix-postmaster/evidence/current-research-artifact.json
```

The generated manifest binds the source lock and actual patch bytes to the
receipt, sealed manifest, executor, and payload inventory. Its classification
is always `research-only-non-release` and its claim scope is only exact
artifact identity; a separate behavioral evidence receipt must bind its digest
before any documentation can call the carrier qualified or current.

The verifier treats `manifest.json`, `guest-build.receipt`,
`wasmer-build.receipt`, and `payload.files` as one canonical identity. The
guest receipt binds the explicit `release-o3` research profile or `safe-o2` control,
effective build flags, and a recomputed identity of the exact installed guest
closure. It rejects duplicate manifest or
receipt keys, noncanonical receipts, unsafe or unsorted inventory paths,
missing and unexpected files or directories, symlinks and special files,
empty unlisted directories, and files whose identity changes while their
bytes are hashed.

Run the concurrent harness without a compiler or mutable Wasmer cache:

```sh
project=src/runtimes/liboliphaunt/wasix-postmaster
"$project/bin/bench-wasix-concurrent-query-suite.sh" \
  --skip-build \
  --sealed-carrier target/oliphaunt-wasix-postmaster/carriers/headless-research \
  --target wasix \
  --connections 1 \
  --workloads 'indexed-read mixed-write indexed-update indexed-insert' \
  --runtime-footprint embedded-concurrent \
  --durability safe \
  --resource-detail full \
  --quiescence-seconds 5 \
  --memory-map-snapshots \
  --label sealed-headless-c1
```

That invocation is a Linux smaps/PSS attribution diagnostic. Because it does
not configure a dedicated cgroup, cgroup limits, events, and swap state are not
part of its evidence and it cannot qualify a physical-memory budget. Use the
frozen cgroup command and predeclared budgets in
[the memory protocol](../../../../docs/internal/wasix-postmaster/rss-memory-model.md#reproducible-measurement-protocol)
for memory qualification. Run the balanced timed lane separately so sampling
overhead cannot enter the throughput or latency distribution:

To prove that verifier and initdb activity did not preheat carrier/PGDATA
pages outside the measured server cgroup, run the independent cold campaign:

```sh
"$project/bin/qualify-wasix-cold-ownership.sh" \
  --sealed-carrier target/oliphaunt-wasix-postmaster/carriers/headless-research \
  --blocks 10 \
  --runtime-footprint embedded-concurrent \
  --durability safe \
  --memory-max 256M \
  --memory-high 224M \
  --swap-max 0 \
  --resource-interval 0.05 \
  --label sealed-headless-cold-ownership
```

This targeted lane hashes, synchronizes, evicts, and proves zero residency for
every regular carrier and fresh-PGDATA page immediately before postmaster
launch. It records spawn-to-first-query latency and whole-scope memory,
dirty/writeback, pressure, and I/O evidence without global `drop_caches`.

```sh
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
  --label sealed-headless-c1-timed
```

The qualifier uses `--resource-detail off`, freezes and repeatedly verifies the
complete packaged carrier inventory, and fails any native/WASIX pair whose effective
PostgreSQL settings differ. The named embedded footprint is
`io_method=sync`, `shared_buffers=32MB`, `max_connections=8`,
`max_wal_senders=10`, `autovacuum_worker_slots=4`, and
`max_worker_processes=8`; the worker-capacity settings are bound to the sealed
96-task host budget. The `safe` durability profile retains `fsync=on`,
`full_page_writes=on`, and `synchronous_commit=on`.
Qualification rejects an explicit `--postgres-guc` that overlaps either named
profile, while non-overlapping diagnostic settings remain recorded. Full
resource results are cumulative suite evidence; they must not be mixed into
the timed percentile population. The three cgroup options are all-or-none.
The qualifier freezes them in its pre-run policy and machine result, removes
the matching ambient `WASIX_CGROUP_*` variables before every harness launch,
and passes the exact triple explicitly to the lower-level harness. The finite
scope is enforced during the timed run, but resource sampling remains off, so
this receipt does not replace the independent memory-evidence lane.

When a constrained Linux throughput result is intended to demonstrate that
adaptive WAL cache relief actually participated, opt into the acting-evidence
policy on a WAL-producing lane:

```sh
"$project/bin/qualify-wasix-single-backend.sh" \
  --sealed-carrier target/oliphaunt-wasix-postmaster/carriers/headless-research \
  --blocks 10 \
  --connections 4 \
  --iterations 100000 \
  --rows 100000 \
  --workload indexed-update \
  --runtime-footprint embedded-concurrent \
  --durability safe \
  --cgroup-memory-max 256M \
  --cgroup-memory-high 224M \
  --cgroup-swap-max 0 \
  --adaptive-cache-evidence-policy constrained-linux-wal-action-v1 \
  --label sealed-headless-c4-256m-adaptive
```

The default `portable-correctness-v1` continues to accept either exact active
telemetry or the sealed observe-only fallback, which is required for portable
correctness campaigns. The constrained policy is CLI-only and fail-closed: it
requires adaptive-active admission, class-6 offers, positive class-6 advice
calls and advised bytes, and zero sampler, clock, or advice errors in every
WASIX sample. Native samples remain portable controls. The selected policy,
validator digest, per-sample policy receipts, and validation receipts are
bound into the qualification policy and machine result.

Qualify true persistent-query and reconnect/backend-lifecycle latency in its
own balanced fresh-server lane:

```sh
"$project/bin/qualify-wasix-libpq-latency.sh" \
  --sealed-carrier target/oliphaunt-wasix-postmaster/carriers/headless-research \
  --blocks 10 \
  --warmup 100 \
  --samples 1000 \
  --runtime-footprint embedded-concurrent \
  --durability safe \
  --cgroup-memory-max 256M \
  --cgroup-memory-high 224M \
  --cgroup-swap-max 0 \
  --label sealed-headless-true-libpq
```

The runner alternates fresh-server ABBA/BAAB blocks, declares relative and
absolute p95/p99 gates before the first sample, and binds every raw stream to
the exact carrier, native oracle, probe, libpq, named profile, and qualification
plan. See [true-libpq latency qualification](../../../../docs/internal/wasix-postmaster/libpq-latency-qualification.md)
for the gate semantics, initial evidence, and fail-closed receipt model.

Before treating a carrier as durable, exercise the host-to-guest shutdown and
WAL-recovery boundary independently of the throughput lane:

```sh
"$project/bin/qualify-wasix-immediate-recovery.sh" \
  --sealed-carrier target/oliphaunt-wasix-postmaster/carriers/headless-research \
  --require-zero-write-aot \
  --immutable-carrier-receipt /var/lib/oliphaunt/wasix-postmaster-receipts/headless-research.json \
  --cgroup-memory-max 256M \
  --cgroup-memory-high 224M \
  --cgroup-swap-max 0 \
  --transactions 16 \
  --rows-per-transaction 128 \
  --label sealed-headless-immediate-recovery
```

This Linux qualifier fixes the same `embedded-concurrent` and `safe` profile
inputs, creates a controlled checkpoint, records multiple acknowledged and
flushed commits, and proves the checkpoint did not advance. Qualification mode
fails closed unless the carrier is bound to an external immutable-deployment
receipt, all four outer executor invocations activate directly from immutable
AOT/memory-image inodes with a validated zero-write audit, and each of the
three postmaster trees proves its exact finite `MemoryMax`, `MemoryHigh`, and
`MemorySwapMax` cgroup-v2 controls and its identity-checked scope drains after
shutdown. The initdb executor legitimately activates sealed postgres for its
bootstrap/single-user work and may activate exact-manifest dynamic modules.
Those remain fully validated loader records; the population gate classifies
the one initdb and three postmaster invocations separately instead of treating
bootstrap postgres as a fourth outer postmaster. Full cryptographic carrier
verification brackets the
campaign; receipt-bound inode and `+i` verification guards each intermediate
execution. It then sends SIGQUIT only to the birth-identity-checked Wasmer
leader. Success requires PostgreSQL's immediate-shutdown path—not host
termination or bounded escalation—to drain the process group, listener, and
`/dev/shm` carrier. The same sealed closure, PGDATA, and shared-object mount
must restart through WAL redo with an exact content checksum. A bridged SIGTERM
must subsequently perform smart shutdown, and a third open must be clean.

Use `--mode diagnostic` only for compatibility investigation when immutable
deployment or cgroup delegation is unavailable. Diagnostic mode retains the
same recovery assertions but is explicitly research-only; zero-write loader
and cgroup controls may still be supplied and are then verified identically.

That test covers a guest-handled immediate shutdown. It deliberately does not
claim recovery after host SIGKILL, power loss, or supervisor crash. Those paths
are unsupported because this project has no cluster lease or runtime-owned,
crash-safe named-shared-object lifecycle.

Do not add `--skip-precompile` in sealed mode: there is no compiler or cache to
skip. The loader uses detached AOT deserialization, retaining linked executable
code and runtime-required metadata while dropping the serialized archive after
linking. On a fresh executable instance, ordinary module start still runs first
so passive data segments, LLVM TLS relocations, globals, and segment-drop state
retain their normal semantics. Before dynamic linking, the runtime compares the
captured prefix byte-for-byte and replaces only that identical range with an
immutable file-backed private mapping. Writes remain per-instance COW; a
receipt, layout, or byte mismatch fails before side-module relocations and
constructors. The memory and measurement model is documented in the
[memory model](../../../../docs/internal/wasix-postmaster/rss-memory-model.md).
