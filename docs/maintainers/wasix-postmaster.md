# WASIX Postmaster Maintainer Guide

This document records the durable engineering conclusions behind the released
WASIX postmaster product. It replaces the chronological experiment reports.
Historical measurements were useful for choosing the design, but historical
receipts are not release evidence and are intentionally not preserved as an
active product mechanism.

## Product decision

The product runs one real PostgreSQL 18 postmaster and creates one isolated
WASIX process per backend. It is a peer of the single-backend WASIX runtime,
not an experimental mode hidden inside that runtime. The two products share
canonical PostgreSQL and toolchain inputs where their semantics agree, while
owning separate guest patch stacks and runtime artifacts where concurrency
changes the contract.

The products have different execution models:

- `single` is a small in-process database with one PostgreSQL execution
  context and no guest process/thread creation;
- `postmaster` is a multi-session PostgreSQL server with a listener, isolated
  backends, shared memory, signals, timers, and process lifecycle semantics.

They remain separate public products. SDKs must not hide the postmaster behind
a `topology` option on the portable single-backend database API: its storage,
packaging, listener, concurrency, and lifecycle contracts are different. A
future postmaster SDK may supervise the postmaster carrier explicitly, but it
must not silently substitute either product for the other.

## Process and ownership model

PostgreSQL is compiled with `EXEC_BACKEND`. The postmaster performs
`vfork()`/`execv()` through WASIX. The runtime creates a fresh instance, restores
serialized `BackendParameters`, and reattaches the shared-memory segment at the
same guest address using shared, fixed-address mapping semantics.

The native supervisor owns exactly one logical WASIX process group per
cluster. Runtime state is scoped to that group. Process IDs, descriptors,
signal state, wait state, shared-memory mappings, and task budgets must never
leak into a global singleton shared by unrelated clusters.

Rejected design: cloning a live Wasmer store or complete process state. It
couples backends through executor internals, preserves state that PostgreSQL
expects `exec` to reset, and makes resource ownership and failure recovery
ambiguous. Fresh instances plus explicit exec handoff are slower to create but
give the correct isolation boundary.

## Guest patch boundary

The single-backend guest may specialize spinlocks, atomics, background workers,
and process creation because one isolated instance has no concurrent
PostgreSQL observer. Those assumptions are invalid here. The postmaster guest
keeps PostgreSQL's ordinary concurrent spinlock and atomic implementation and
must not consume the single-backend-only patches that disable workers or guest
process creation.

Algorithmic optimizations can be shared when their guards and semantics are
topology-neutral. `postgres/main-optimizations.series` references those
canonical decisions. Postmaster-specific patches cover POSIX dynamic shared
memory, EXEC_BACKEND handoff, process join reliability, packed latch ordering,
and other concurrency contracts. Every local patch must be explained by
`postgres/product-patch-provenance.toml`; experiment disposition files are not
part of the product.

## Shared memory, latches, signals, and timers

Backends share PostgreSQL memory through a versioned host provider. A child
must reattach the same backing object at the same guest address. Anonymous
per-instance copies are incorrect even if a single connection appears to work.

The latch state is a packed atomic state machine. Set, reset, and wait paths
must use cross-instance atomics and the required ordering. A host wakeup is an
optimization around the PostgreSQL state transition, never a replacement for
it. Timer delivery and process wakeups must tolerate generation changes and
must not lose a wakeup between observing state and sleeping.

`wait`, signal, and join operations must retry interruption where PostgreSQL
expects it and must preserve the distinction between a still-running child,
normal exit, signalled exit, and an unknown process. The supervisor owns
cleanup; a failed backend cannot tear down another cluster's resources.

## Sealed carrier

The release carrier is compiler-free. Compilation happens in the trusted
build job and its output is tied to:

- pinned Wasmer, WASIX libc, PostgreSQL, LLVM, and Rust inputs;
- the exact runtime and guest patch sets;
- compiler features, target triple, runtime ABI, artifact ABI, CPU policy, and
  optimization policy;
- the exact installed guest closure.

The complete loadable side-module closure is declared once in
`runtime/policies/sealed-side-modules.v1.tsv`. The builder, guest provenance,
linear-memory receipt, manifest, test fixture, and independent verifier all
consume that policy. Do not reintroduce a hard-coded shortlist in any of those
layers. Aliases are regular byte-identical carrier files because sealed path
resolution rejects symlinks.

The carrier contains a complete `payload.files` inventory. Verification opens
regular files without following symlinks, hashes their bytes, checks their
sizes and modes, and rejects missing or additional payloads. AOT artifacts are
verified against their source modules before deserialization. A carrier is one
immutable unit: executor, modules, AOT, memory images, manifests, receipts, and
support files are never mixed across builds.

## Export and memory-image conclusions

The main module uses a two-pass export seal. First derive the exact dynamic
requirements of all declared side modules; then remove unused main exports and
prove that every mandatory and dynamic requirement remains satisfied. An
allowlist guessed from one workload is not sufficient.

Fresh-backend startup may use an immutable post-start linear-memory image only
when a static analyzer proves the start function has the restricted effects
recorded by the carrier. The ordinary start function is still executed for
normal instances. The fast path is an attested replay of deterministic
initialization, not a general snapshot/restore mechanism.

Images must be rebuilt when the module, runtime ABI, compiler recipe, memory
profile, or analyzer policy changes. Publication is atomic and no-replace.
Crashes may leave unreferenced staging state, but never a partially published
carrier.

## Reusable artifact conclusions

Reusable state crosses correctness boundaries only with an immutable object
and the identity and state predicates that make it safe. PostgreSQL must remain
free to execute its normal path whenever those predicates are not proved.

The release applies this rule to AOT modules and preinitialized memory images.
The research branch also explored relation-file and WAL cache offers, but those
ABIs, controllers, and telemetry were removed: they did not earn a stable
public-product contract. Raw file-descriptor reuse and handle-lifecycle
shortcuts remain invalid. Any future data-cache design must prove immutable
identity and PostgreSQL lifecycle state before it can become product code.

## Performance interpretation

Do not use raw VSZ as a physical-memory claim. The runtime reserves large
virtual ranges for guest memory and guards. RSS also double-counts shared pages
across processes; use proportional set size and cgroup totals when attributing
physical memory.

The experiments established these useful priorities:

1. retired coroutine stacks and allocator arenas can dominate the high-water
   resident set;
2. deserialized AOT artifacts and repeated child validation can create large
   anonymous or duplicated mappings;
3. every filesystem EXEC_BACKEND child rereading and rehashing the same module
   is avoidable when the sealed carrier has already proved identity;
4. preinitialized deterministic memory removes repeatable fresh-instance work;
5. shared-memory backing affects writeback and reclaim behavior, not just the
   number of guest-memory copies;
6. a compiler-bearing CLI is not an acceptable production executor.

The Linux tmpfs comparison showed that backing policy can materially change
throughput without materially changing fan-out PSS. That is evidence about
writeback/reclaim behavior, not proof that shared-memory duplication vanished.

Performance qualification must compare identical PostgreSQL settings and use
real libpq sessions, balanced run order, frozen identities, warmup, and a
predeclared statistical decision. Bulk throughput is not query-tail latency.
No number from an obsolete carrier is a current product claim.

## Checkpoint, WAL, and recovery

A release qualification must exercise checkpoint, WAL generation and recycle,
clean shutdown, immediate restart, backend churn, and concurrent connection
waves. It must prove PostgreSQL-visible outcomes as well as host resource
cleanup. File-cache or WAL-cache telemetry alone is never correctness proof.

Oliphaunt does not define a durability profile or relaxed-durability mode.
Applications that deliberately change PostgreSQL durability use ordinary
PostgreSQL GUCs; release qualification always keeps the safe PostgreSQL
defaults.

## Platform and SDK support

Release carriers are qualified for Linux arm64 GNU, Linux x86_64 GNU, and
macOS arm64. Each target builds its native executor, compiler, AOT modules,
carrier, and client tools on the target host, then runs independent carrier
verification, backend wave stress, and crash-recovery qualification. The
portable PostgreSQL guest, patched WASIX sysroot, and runtime capability probes
are produced once on Linux x86_64 and transferred as a verified build input to
both Linux target jobs and macOS; this avoids repeating the portable build and
also handles the absence of Docker on macOS runners.

Published carrier archives use the same level-19 Zstandard `.tar.zst` format
as the single-backend WASIX AOT carriers. The portable-input `.tar.gz` file is
only an internal CI handoff between build jobs; it is not a release asset and
is never included in the release checksum or attestation set.

Windows x64 is present in the CI matrix as an explicit planned no-op. It does
not build or publish an asset until its runtime, memory-mapping, packaging, and
lifecycle contracts are implemented and qualified.

Linux admits direct carrier mappings only after immutable-inode deployment and
qualifies every server tree under finite cgroup-v2 memory controls. macOS has
neither primitive, so it copies verified AOT and preinitialized-memory bytes
into runtime-owned private backing. Its loader audit must account for the exact
copy, hash every mapped byte, perform no carrier-source writes or sync calls,
and retain no mutable carrier mapping. These are platform-specific mechanisms
for the same sealed-carrier integrity contract, not a weaker unqualified mode.

Wasmer source portability alone does not make another target supported.

To add a platform, add all of the following together:

- a Moon artifact target and CI runner;
- a reproducible runtime/guest/carrier build;
- the platform memory-image and shared-memory adapters;
- an independent carrier verifier run;
- lifecycle, concurrency, recovery, and SDK consumer smokes;
- release download, publication-lock, and attestation coverage.

Browser hosts cannot provide the current process, socket, fixed shared-memory,
and native executor contract. Browser SDKs should preserve API symmetry and
report postmaster as unsupported until a real browser host implements and
qualifies those semantics. Node.js, Bun, and Deno may share one JavaScript host
adapter when they can launch the same carrier; runtime detection must not
fork three copies of product logic.

## Release qualification

The mandatory product boundary is:

1. verify pinned sources and patch provenance;
2. run static/unit checks for runtime ownership, process supervision, sealed
   export, linear memory, durable publication, and carrier verification;
3. build the exact runtime and PostgreSQL guest;
4. build a carrier containing the full declared module closure;
5. independently verify the carrier;
6. run initdb, concurrent libpq sessions, regression subset, backend-wave
   stress, and checkpoint/recovery on every target, plus immutable deployment
   and cgroup checks on Linux;
7. package only the verified carrier from the exact release commit;
8. freeze it in the publication lock and verify the GitHub release assets.

Generated checkouts, caches, reports, and measurement data remain under
`target/`. Benchmark harnesses belong under `tools/perf/` and durable benchmark
results under `benchmarks/`; neither belongs in the runtime product source.

## Retired experimental machinery

The research phase used one-off native oracles, profiling wrappers, evidence
freezers, cgroup/smaps collectors, cold-cache proofs, and report summarizers.
Their conclusions are captured above. Those scripts are not release inputs and
must not be restored to this product directory. A future diagnostic should be
implemented as shared tooling only when it has a current operator and a stable
contract; otherwise the normal product checks are the authority.
