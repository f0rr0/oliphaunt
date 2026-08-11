# WASIX Postmaster Architecture and Support Boundary

## Research boundary and status

`liboliphaunt-wasix-postmaster` is a third runtime lane. It is independent of
`pg_durable`, and it does not replace or modify the single-user WASIX runtime.
Its purpose is narrower and harder: preserve PostgreSQL's postmaster process
model closely enough to retain real backend isolation, shared-memory
coordination, sockets, extension loading, and PostgreSQL error recovery.

This directory is replayable research, not a release product. Linux x86_64 is
the only host with retained evidence in [replay-status.md](replay-status.md).
The current support boundary is local Linux x86_64 research; other hosts and a
release carrier are explicitly outside this project.

## Canonical guest and concurrency-specific patches

The Rust and TypeScript bindings share the canonical single-backend WASIX
guest, including PostgreSQL patches `0040` and `0041`. Their safety depends on
the binding hosts, not merely on the WASIX target: each host permits one
PostgreSQL backend execution context per isolated WebAssembly instance,
disables PostgreSQL workers, and rejects guest process and thread creation.
Only under that contract can the guest replace PostgreSQL's spinlock and atomic
instructions with single-backend specializations.

The postmaster runtime deliberately does not satisfy that contract. Its real
postmaster, auxiliary processes, and connection backends may execute
concurrently while observing shared PostgreSQL memory across instances. This
lane therefore keeps PostgreSQL's normal atomics and spinlocks; the concurrent
native lane keeps them for the same reason. The postmaster optimization series
rejects `0040` and `0041` rather than silently inheriting a target-wide
optimization that would violate its process model.

Patch `0039` is a separate placement-specific boundary. It lets the TypeScript
browser-worker transport enter pgwire through process stdio when the explicit
host marker is present. Rust does not activate that transport and instead pumps
the canonical guest lifecycle exports. The postmaster serves PostgreSQL
sockets, so its optimization series does not import the patch.

## Selected process and memory model

The selected implementation uses PostgreSQL's `EXEC_BACKEND` seam. It keeps process
semantics at the runtime boundary and avoids making PostgreSQL aware of Wasmer
stores, instances, or compiler continuations.

1. The postmaster accepts a connection and serializes PostgreSQL's normal
   `BackendParameters` handoff.
2. WASIX spawn/exec creates a logical child and starts the same PostgreSQL
   module with its backend entry arguments.
3. Wasmer creates a fresh store, module instance, private linear memory, guest
   stack, tables, and process-local runtime state for the backend.
4. The backend restores the serialized handoff and reopens the named,
   file-backed PostgreSQL shared-memory object.
5. The runtime maps that same backing at PostgreSQL's recorded guest virtual
   address with `MAP_SHARED | MAP_FIXED` semantics.
6. Process-shared futexes coordinate over the shared backing; sockets, epoll,
   signals, wait, files, and dynamic loading remain host-runtime services.

The selected carrier topology is one host Wasmer process and one instance group
per PostgreSQL postmaster tree. “Process” below means a logical guest process
unless explicitly qualified as an OS process. The shared-futex registry is an
in-process registry inherited by those logical children; it is not an
OS-process-shared futex implementation. A carrier that places backends in
separate host processes is a different topology and must provide and qualify a
real cross-OS-process wait/wake mechanism.

Only mappings explicitly registered as shared PostgreSQL mappings are replayed.
Parent-private heap pages, guest stacks, tables, file-wrapper state, and Wasmer
object graphs are not copied into the child. This is the important performance
and correctness invariant: a new backend receives a clean private instance and
the minimum shared state required by PostgreSQL.

The fixed address is not an optimization. PostgreSQL stores pointers inside
shared memory, so relocating the mapping changes their meaning. A collision,
unsupported exact mapping, wrong backing identity, or failed futex association
must abort backend creation. The runtime must never silently substitute a
private mapping or copy-on-write snapshot.

The replay now implements the collision rule: a fresh exec child installs a
bounded, aligned allocator reservation before exact `MAP_FIXED` reattachment,
pre-grows the memory when required, rolls back failed transitions, and rejects
moving-memory configurations. The implemented protocol is Linux research
functionality; it makes no maximum-size allocator-churn or cross-platform claim.

## Research supervisor boundary

The generic Wasmer CLI is the diagnostic and AOT-production path, not a
supported deployment boundary. The local postmaster executor is built directly
from pinned Wasmer sources and owns the verified loader, one logical WASIX
process table, the shared mapping/futex registry, signals, resource policy,
lifecycle cleanup, and telemetry. Backend isolation is fresh Wasm-instance
isolation inside one host process; it is not OS-process crash, address-space,
or resource-accounting isolation.

The local payload binds the complete guest closure, AOT objects, source and
patch identities, target/CPU policy, memory/table configuration, Wasm features,
and dynamic-link plan. It is unsigned research provenance and has no
cross-platform or release-selection contract. The generic CLI and writable
cache remain research tools and are never an automatic fallback.

Cold embedded accounting is a separate loader/measurement contract. Full
carrier verification and initdb may execute before the measured postmaster,
but the Linux qualification lane must then synchronize and individually evict
the exact immutable-carrier and fresh-PGDATA regular files, prove zero resident
pages with `mincore(2)`, and launch without another read of either root. First
faults, storage I/O, charged file pages, dirty/writeback state, and
scope-lifetime memory peak then belong to the fresh server cgroup. See
[cold-ownership-qualification.md](cold-ownership-qualification.md); warm runs
without that receipt cannot establish cold cgroup ownership.

## Rejected full-state-cloning experiment

An earlier imported experiment cloned a backend's complete private runtime
state. It made compiler frame reconstruction part of process correctness,
reached roughly 160 MiB per child, and trapped before PostgreSQL server
readiness. That prototype, its compiler-continuation machinery, and its probes
are excluded from canonical source and qualification. It is historical
observation only, not an alternate backend or an automatic fallback when
EXEC_BACKEND capability checks fail.

## Host contract

The selected design depends on a coherent set of host semantics, not merely on
the ability to instantiate WebAssembly:

- an allocator-integrated guest virtual-address layout that reserves every
  exact-address shared-mapping window in the postmaster and every exec child,
  with explicit size, 64 KiB Wasm-page, and host-page alignment rules;
- exact-address, file-backed shared mappings with cross-process visibility and
  no later heap/mmap allocation overlap;
- stable shared-backing identities, reference-counted futex-registry lifetime,
  deterministic removal on unmap/last close, and protection against stale
  inode reuse during mapping churn;
- crash-safe named shared-object ownership, stale-object reclamation, and
  unlink semantics that allow a cluster to restart after a hard host failure;
- real sequentially consistent fences ordering ordinary shared loads/stores
  across separately instantiated memories that alias one host backing;
- futex wait/wake keyed to the shared backing, including timeout behavior;
- fresh child instance creation, exec, child adoption and cleanup;
- blocking wait, `WNOHANG`, EINTR, SIGCHLD, and guest signal delivery;
- process-signal delivery that interrupts an indefinitely blocked private
  self-pipe/epoll wait, including PostgreSQL latch wakeups;
- autonomous POSIX one-shot and interval timers with nanosecond-correct host
  scheduling that can interrupt such blocked waits;
- level-triggered epoll readiness for listening sockets under connection
  bursts, plus correct nonblocking and close-on-exec flags;
- filesystem sync and open-flag behavior sufficient for PostgreSQL WAL;
- WASIX dynamic loading for PostgreSQL extension side modules;
- finite runtime-owned stack limits and explicit core/open-file limits; and
- WebAssembly EH-compatible setjmp/longjmp behavior.

These capabilities compose. Passing mmap, futex, spawn, or epoll in isolation
does not establish postmaster support; the strict blocker suite and PostgreSQL
integration gates are both required.

## Versioned Oliphaunt host ABI

Most current replay patches still add behavior to the broad `wasix_32v1`
surface. The range-writeback bridge is the first deliberate exception:
wasix-libc imports `fd_sync_range` from `oliphaunt_postmaster_v1`, and the
runtime exposes no compatibility alias under `wasix_32v1`. This establishes the
namespace and exact core-Wasm ABI shape, but it does not by itself negotiate
availability. This research lane therefore claims only exact-pin ABI matching;
it does not claim negotiated feature compatibility.

The following compatibility contract is explicitly unsupported here:

- The canonical guest carries an
  `oliphaunt.postmaster.requirements.v1` custom section. It declares an ABI
  major/minor, required and optional feature bits, the expected WASIX ABI, and
  the PostgreSQL/shared-memory layout version.
- Non-standard imports live under a versioned core-Wasm import namespace such
  as `oliphaunt_postmaster_v1`; they are not disguised as portable WASIX
  behavior. Standard WASIX calls can remain under `wasix_32v1`.
- The carrier validates the requirements section and its own signed feature
  manifest before instantiating any PostgreSQL process. A diagnostic records
  the guest hash, carrier hash, ABI version, and every missing feature.
- A major version changes when an existing call or bit changes meaning. Minor
  versions are additive. Unknown required bits, a major-version mismatch, or a
  missing minimum minor version are hard errors.
- Preflight computes one immutable `supported ∩ requested` result. Unknown
  optional bits are ignored but reported, and the same result is exposed to
  every helper/side module through a stable query surface. Optional imports
  have guarded calls or stable `ENOTSUP` stubs; module load order cannot change
  negotiation.
- Validation occurs before opening a database directory, binding a listener,
  or deserializing an AOT artifact. There is no best-effort mode, full-state-
  cloning fallback, or private-mmap fallback.

An external compatibility layer would need to distinguish at least:

| Feature | Required semantic |
| --- | --- |
| `exec_backend_fresh_instance` | Child has new private instance state and only declared shared mappings are replayed. |
| `reserved_shared_va_layout` | Every replayed shared range is reserved in each fresh child's allocator before `MAP_FIXED`, with bounded layout and no later allocation collision. |
| `fixed_shared_file_mapping` | Exact-address mappings share one coherent file backing and write back correctly. |
| `shared_mapping_registry_lifecycle` | Mapping identity and futex registries are reference-counted, reclaimed on final unmap/close, and cannot alias stale inode reuse. |
| `shared_object_lifecycle` | Cluster-scoped shared objects have a live-owner lease, safe stale reclamation/unlink, and hard-crash restart behavior. |
| `cross_instance_memory_order` | `atomic.fence` provides a real seq-cst barrier for ordinary PostgreSQL shared fields across aliased instance memories. |
| `shared_futex` | Wait/wake crosses child instances over that backing. |
| `wait_sigchld` | Blocking wait, `WNOHANG`, EINTR, default disposition, and reaping obey the tested contract. |
| `blocked_signal_wake` | A process signal reaches its handler and wakes a backend blocked indefinitely in private self-pipe/epoll state. |
| `posix_one_shot_timers` | `setitimer` honors `it_value` and `it_interval`, uses correct time units, fires without unrelated signal polling, and interrupts blocked waits. |
| `level_triggered_socket_epoll` | Listener readiness persists while accept backlog remains. |
| `range_writeback` | Linux HostFS delegates exact `sync_file_range` offset, length, and flag semantics on PostgreSQL's read-only pre-sync descriptors under the advisory `FD_ADVISE` right, without substituting a stronger sync; unsupported adapters fail explicitly. |
| `dynamic_linking` | Main and side modules use the supported EH/PIC model. |
| `rlimit_contract` | Stack, core, and open-file values have the semantics below. |
| `wasm_eh_sjlj` | PostgreSQL error recovery can cross the supported Wasm EH paths. |

The sysroot builder already records, binds, and validates source, patch,
toolchain-image, archive, header, and variant hashes in
`oliphaunt.wasix-libc-sysroots.v1` manifests. The runtime builder now also emits
an `oliphaunt.wasix-postmaster.wasmer-build.v2` receipt. It binds all Wasmer
and gitlink pins, both prepared source states, tracked patches, `Cargo.lock`,
the exact sysroot manifests, host ABI, Rust/LLVM provenance, artifact ABI, and
runtime ABI. It records the LLVM AOT producer and compiler-free headless
executor as separate binary digests with separate feature sets. Producer
validation recomputes every available build input immediately before atomic
publication; runtime selection validates the canonical schema, expected pins
and patches, host ABI/features, and selected binary hash without depending on
disposable compiler worktrees.

The embedded lane adds a third native artifact without changing that producer
receipt: `oliphaunt-wasix-postmaster-executor` is built in an isolated Cargo
target with only `product-executor`. Its canonical
`postmaster-executor-build.v3` receipt binds the exact parent Wasmer receipt,
runtime ABI, package/feature set, sealed runtime policy, narrow CLI contract,
host toolchain, executor bytes, and the exact bounded-linear-memory tool and
profile identity. The runtime build recipe includes the exact
`embedded-postmaster-v1` task-budget profile, and the runtime-policy identity
names its 96-task ceiling. This separates native code
reachability from guest process semantics: fresh EXEC_BACKEND instances,
private backend state, shared-mapping replay, durability, AOT, and memory-image
contracts are unchanged.

### Receipt-bound task and worker budget

The postmaster executor uses one immutable budget at both admission boundaries.
It sets `Capabilities.threading.max_threads=96` before `WasiRunner` constructs
the process tree, so `WasiControlPlane`'s exact compare-and-swap counter rejects
task 97 before its memory or instance is created. The same 96 is
`TokioTaskManagerConfig.max_threads`; its blocking pool retains one core worker
and retires every excess worker after 1000 ms. The two Tokio reactor workers
are a separate fixed executor service and are not guest backend slots. The
generic/full-headless control keeps Wasmer's default blocking-worker policy.

The profile ceiling is above PostgreSQL 18's complete tracked child-slot shape,
not merely the four-client benchmark shape. For the embedded profile,
`InitializeMaxBackends()` gives 32: 8 connections, 4 autovacuum worker slots,
8 background workers, 10 WAL senders, and 2 special workers. PostgreSQL's
`MaxLivePostmasterChildren()` allocation then adds 18 authentication-overlap
slots, 32 compile-time I/O-worker slots, and 8 other fixed PM-child roles, for
90 tracked children. One root postmaster plus five overload/helper slots gives
the receipt-bound budget of 96. `io_method=sync` means the 32 I/O slots cannot
become active in this profile, but retaining them in the derivation makes the
admission proof conservative.

Control-plane task count is deliberately not execution-lease count. Each
guest process main thread owns one `TaskCountGuard`; execution leases are
lifecycle ownership tokens around the same callback. The qualified idle shape
therefore has six active tasks and six live guest threads even though it has
eleven execution leases. Multiplying the budget by lease count would create
host workers that no guest thread can use. Conversely, unauthenticated
dead-end children are intentionally unbounded in upstream PostgreSQL and
cannot be promised unbounded residency by an embedded host. The five reserve
slots absorb bounded transitions; sustained excess ingress fails as resource
admission rather than growing host threads without limit.

The profile bytes participate in `fresh_runtime_build_recipe_sha256`; that
digest is in both the Wasmer and postmaster-executor receipts and therefore in
the verified carrier closure. Changing the GUC capacity, formula, budget,
blocking core, or retirement interval rotates the runtime ABI and invalidates
old executors/carriers. This is a bounded local research policy and makes no
overload, recovery, replication, or maximum-role support claim.

These are useful fail-closed build-provenance layers, but neither is runtime
feature negotiation or a sealed release carrier. The receipt is unsigned and
does not bind the PostgreSQL guest/install tree, native runtime libraries, or
AOT cache. This project does not provide a guest requirements section, general
feature negotiation, a pre-instantiation compatibility check, or a signed
full-bundle verifier. The versioned `fd_sync_range` import is an exact local ABI,
not evidence of a broader compatibility contract.

## Local guest and sealed host carriers

The local PostgreSQL guest-set closure is built from exact PostgreSQL,
wasix-libc, extension, toolchain, patch, share-tree, and configuration inputs.
Its manifest and file digests are research provenance, not a portable release
contract. The local carrier contains:

- a pinned, patched Wasmer runtime and required native libraries;
- a host adapter implementing the versioned feature set;
- a manifest containing host OS/architecture, runtime and ABI versions,
  feature bits, source and patch digests, build configuration, and hashes for
  every shipped file; and
- provenance sufficient to reject mixed or locally mutated runtime/libc/guest
  combinations.

The Linux result is local evidence only and cannot qualify macOS or Windows.

### Historical five-module sealed headless research carrier

The Linux x86_64 research lane implements the execution shape below the
release trust boundary. Its fixed five-module inventory is historical: the
guest proof closure now contains 27 runtime-loadable side modules. The
current builder retains the five-module research scope and is not a general
PostgreSQL carrier. `runtime/policies/sealed-side-modules.v1.tsv` records the
larger source inventory; it does not expand the builder's closure:

- `build-sealed-headless-carrier.sh` accepts only an already validated v2
  receipt and its exact precompiled LLVM AOT bucket. It does not compile or
  accept native-CPU code implicitly.
- The atomically published closure contains only one native executor plus
  `initdb`, `postgres`,
  `libpq.so.5.18`, `dict_snowball.so`, and `plpgsql.so`, their five AOT
  artifacts, deterministic memory images and receipts for both executables,
  the PostgreSQL support tree, with the selected executor installed at
  `bin/wasmer-headless`. Postmaster-executor carriers contain
  `postmaster-executor.receipt`; its exact presence selects the executor role.
  Full-headless controls omit the sidecar and remain bound directly to the v2
  Wasmer receipt. No carrier contains both executors. It contains no symlinks
  or special files and has a complete hash/size inventory.
- The project verifier streams that inventory from opened regular files and
  requires an exact directory/file set. It rejects unsafe or unsorted paths,
  duplicate manifest/receipt keys, missing or unexpected entries, symlinks,
  special files, unlisted empty directories, and files whose identity changes
  while they are read. The builder, standalone verifier, and benchmark
  preflight apply the same policy.
- The strict format-6 `oliphaunt.wasix-postmaster.sealed-aot.v5` manifest binds
  the raw modules, AOT artifacts, executable memory image metadata, source and
  patch identities, compiler/capture recipe, artifact/runtime ABI, generic CPU
  policy, target and host ABI, LLVM producer, and headless executor. Producer
  and executor identities remain distinct. It also binds `core-profile` and
  `guest-build-recipe-sha256`; the canonical guest receipt includes the
  effective flags and an installed-closure identity recomputed from both the
  source prefix and staged carrier. A deny-unknown `file-cache-policy` object
  additionally binds the requested adaptive algorithm ID, the sole approved
  compiled config ID and SHA-256, and the observe-only portable fallback.
  Executable selection makes `initdb` unconditionally observe-only while
  allowing only `postgres` to request the approved adaptive policy.
- The headless loader opens regular non-symlink files, validates the same
  mapped bytes it deserializes, checks the embedded raw-module digest, and
  preloads an in-memory module registry. Exact sealed paths shadow the mutable
  guest filesystem; other paths retain ordinary filesystem replacement
  semantics.
- The builder uses an image-free format-4 `sealed-aot.v3` manifest only as a
  capture capability. It performs two captures in independent headless stores
  for each executable and requires byte-identical images and receipts. The
  provisional manifest and capture workspaces are removed before inventory.
- The builder validates final `postgres --version` and a real disposable
  `initdb` bootstrap through the image-bearing manifest, runs the exact inventory
  verifier, fsyncs the payload, and renames the complete directory into place.
- Its default publication name contains both the runtime ABI prefix and the
  full final `payload.files` SHA-256. Content identity is computed after
  staging, so two PostgreSQL build profiles sharing one executor ABI cannot
  collide at an ABI-only carrier path.

This closes the warm-exec raw-Wasm read/hash/compile path without collapsing
fresh backend instances. It is a digest-verified local research carrier. The
payload inventory and strict loader are not a substitute for release signing,
transparent provenance, dependency closure, selection-time policy, or
per-platform qualification.

### Linux direct immutable deployment

The ext-family Linux research deployment adds a boundary after carrier
construction. A privileged, capability-bounded step verifies the complete
payload closure, publishes an external root-owned immutable receipt, and marks
every carrier file and directory with `FS_IMMUTABLE_FL`. Execution is a
separate unprivileged phase. Its pre-run policy binds the receipt SHA-256,
device and inode plus carrier closure identity, and Wasmer must report
`direct-immutable-inode` with zero loader writes and sync calls for each AOT
and selected executable memory image. Reflink and streamed compatibility modes
are diagnostic-only and cannot satisfy direct-immutable qualification.

Full content hashing occurs once at each qualification campaign boundary.
Between those boundaries, the external immutable receipt supplies the frozen
content identities while a fast verifier checks every receipt-bound inode's
device, inode, type, size, mode, uid/gid, and immutable flag without rereading AOT or
memory-image contents. This prevents integrity bookkeeping from preheating the
cold lane or adding roughly one carrier read per measured sample.
Carrier ownership is preserved and receipt-bound; only the external receipt is
required to be root-owned. The authority boundary is
`CAP_LINUX_IMMUTABLE`, not a destructive recursive ownership conversion.

The generic loader also recognizes direct mappings on a read-only filesystem,
which is the intended SquashFS/EROFS portability seam; that mode is not
silently treated as ext immutable evidence. The full transition order, crash
recovery journal, unprivileged qualification commands, and explicit
ancestor-path trust assumption are specified in
[immutable-carrier-deployment.md](immutable-carrier-deployment.md).

The tracked `pin-runtime-artifacts.sh` utility is intentionally below this
boundary. It copies a matched Wasmer/receipt pair, PostgreSQL install, and cache
for local benchmark replay, but its file index is not a signed selection-time
trust root. This project provides no signed release bundle or SDK-selection
manifest.

### AOT cache rules

AOT output is a derived, host-specific accelerator, never the distributable
semantic source of truth. A cache key must include at least:

- guest-set closure digest and exact module digest;
- sealed carrier, AOT-producer binary/recipe, and runtime-executor binary
  digests as separate identities;
- Wasmer serialization/artifact ABI version;
- exact Rust target triple/environment, minimum platform ABI, native page
  granule, and baseline plus actually used CPU features;
- compiler backend/recipe and every code-generation/optimization flag;
- Wasm features, memory/table tunables, middleware, and dynamic-link plan; and
- Oliphaunt host ABI version and exact configured feature set.

The local carrier distinguishes two artifact classes. Carrier AOT is an
immutable, digest-verified, unsigned research file. A locally derived cache is
mutable performance state and is never a trust root. Wasmer serialized modules
contain host-native executable code; the current
[`Module` API](https://docs.rs/wasmer/latest/wasmer/struct.Module.html#method.deserialize)
also documents deserialization as unsafe because it loads executable code. The
pinned API's safe-named file deserializer delegates to its unchecked
deserializer, so the local carrier owns the loader boundary instead
of trusting the Wasmer CLI auto-cache.

The implemented research loader opens without following links, verifies size
and hash over the exact opened mapping, checks the target, host ABI, artifact
ABI, runtime ABI, CPU policy, producer recipe, executor identity, and raw-module
digest, then deserializes those same immutable bytes without a path-reopen race.
This project provides no signature or release-provenance validation around this
boundary. The compiler-bearing path discards an invalid local entry instead of
executing it. A headless carrier cannot recompile: it requires matching AOT and
fails closed when it is absent or invalid. Cache entries are never copied
between host triples, runtime builds, or CPU feature sets, and cache presence
must not change database behavior.

The sealed raw-module-digest to AOT mapping belongs to the manifest-owned module
registry. It must not be moved into a generic `engine-headless-*` cache bucket:
that namespace is derived from the consumer, while AOT provenance belongs to
the compiler-bearing producer and its exact recipe. Keeping those identities
separate also permits a smaller executor without falsely claiming that it
produced the native code.

### Detached AOT runtime image

The sealed loader uses a dedicated detached deserialization path. Wasmer first
validates the complete serialized archive, allocates and links executable
sections, and materializes only the module metadata, owned data initializers,
CPU-feature bits, and frame information needed at runtime. It then drops the
serialized archive and its file mapping. The resulting module executes
normally but cannot be serialized again; attempting to do so is a hard error.

Detachment removes redundant host-side retention after executable code and
runtime metadata have been published. The sealed memory-image path separately
replaces the verified full 64-KiB pages below the guest stack with private
file-backed mappings after module start. It does not deduplicate WASIX process
state, tables, stacks, PostgreSQL backend state, the initialized partial page
adjacent to the stack, or any page later dirtied by the guest. Those remaining
classes require the instance/PSS ladder rather than another semantic shortcut.

The loader receipt does not infer reclamation from a successful hint. On Linux
it takes non-faulting `mincore(2)` checkpoints through a temporary `PROT_NONE`
descriptor mapping after the exact hash/inspection, immediately after detached
deserialization has released the archive, and immediately after
`POSIX_FADV_DONTNEED`. The receipt persists hint call/success/errno data and
resident pages/bytes independently. This makes a kernel-retained archive page
visible without reading it again, delaying launch, dropping process-wide
caches, or applying advice to the anonymous executable allocations that the
detached engine has already published. Preinitialized images use the same
source-file boundary, while separately recording the `MADV_DONTNEED` result on
their short-lived verification mapping; the later private image mapping and
its dirty COW pages are not the target of this loader audit.

Compatibility activation has two possible cache owners. A streamed copy reads
the original carrier inode and hashes a private snapshot; a reflink hashes a
private COW inode without a userspace source read. The snapshot object therefore
retains the exact original source descriptor until activation completes. It
records and advises original-source and activation-snapshot residency
separately, then releases both descriptors. Direct immutable activation has no
second inode and marks snapshot-only advice not applicable. This distinction is
required even though direct-immutable qualification rejects compatibility modes: otherwise a
successful private-snapshot DONTNEED could be misreported as reclaiming the
original streamed carrier pages.

This is already a correctness issue in the replay, not just release hardening.
The pinned LLVM compiler's original `deterministic_id()` included only the
optimization level, so default and `--disable-non-volatile-memops` runs reused
the same native artifact. The local patch versions that identity and binds NaN
canonicalization, volatile-memory semantics, read-only table policy, the full
O3/indirect-call toggles, and PIC mode, with a focused negative identity test.
The project-owned key above remains broader and authoritative.

## Platform support boundary

| Host | Current support claim | Excluded scope |
| --- | --- | --- |
| `linux-x64-gnu` | Local research implementation; retained 2026-08-09 structural, five-module, private-image, cgroup, and throughput evidence is historical. | No release, signed-provenance, one-shot timer, hard-crash recovery, ABI-negotiation, aggregate latency, or full-closure claim. |
| `linux-arm64-gnu` | Unsupported | No carrier or qualification evidence. |
| `macos-arm64` | Unsupported; a Unix private-image implementation exists without host evidence. | No exact-mapping, wait/signal/timer, dynamic-linking, or footprint claim. |
| `windows-x64-msvc` | Unsupported | No private-image, fixed-address shared-region, process, wait/signal/timer, filesystem, or DLL-carrier implementation. |
| macOS x64, Windows arm64, musl, mobile, BSD | Unsupported/out of catalog | No project release or resolution metadata. |
| Browser/worker runtimes | Full postmaster excluded | Browser hosts do not provide the required listener, process/wait, durable filesystem, and exact coherent shared-mapping contract. The separate single-user product remains the browser path. |

“All platforms” therefore means the same canonical guest plus separately
implemented and sealed native host carriers. It does not mean emulating missing
host semantics in PostgreSQL or advertising Wasmer's general platform matrix as
postmaster support.

Every native carrier is additionally bound to an exact Rust target/ABI,
minimum OS/kernel/libc, native page and mapping granule, filesystem/locking
semantics, and an explicit baseline/optional CPU-feature policy. Matching the
host name alone is insufficient for carrier selection.

The Linux adapter cannot be generalized by a single conditional wrapper around
`mmap`. Linux's
[`MAP_FIXED_NOREPLACE`](https://man7.org/linux/man-pages/man2/munmap.2.html)
can reserve without clobbering but does not itself replace an owned reservation;
the adapter must prove ownership of a bounded placeholder before an exact
replacement. Windows provides explicit placeholder reservation and exact
replacement through
[`VirtualAlloc2`](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtualalloc2)
and
[`MapViewOfFile3`](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-mapviewoffile3),
with 64 KiB allocation-granule constraints outside placeholder replacement.
The Unix source path present for macOS is unqualified and unsupported here.
Windows placeholder APIs and macOS Mach VM primitives are architecture context,
not implementation or support evidence.

## Immutable post-start linear-memory image

The implemented research path is a module-start image, not a snapshot of a
running PostgreSQL process and not a static reconstruction of data segments.
The current PostgreSQL Wasm modules use passive segments, BSS fills, an atomic
initialization protocol, data drops, and LLVM global-TLS relocation work inside
`__wasm_init_memory`. Reconstructing only segment bytes would omit semantic
effects, while marking memory initialized would incorrectly skip per-instance
global state.

The carrier therefore executes ordinary module start in each independent
capture store and snapshots only the complete 64-KiB pages below `stack-low`.
It repeats the capture from a second independent store and requires the image
and receipt bytes to match. The final identity binds at least:

- canonical module, AOT, and guest-source/closure digests;
- runtime and artifact ABI, memory type, initial/maximum pages, fixed 64-KiB
  mapping alignment, and Wasm feature set;
- the post-module-start/pre-link-relocation phase, image digest and mapped
  length, module memory base, dylink size/alignment, initial/maximum pages,
  shared-memory bit, mapping alignment, and stack-low boundary;
- target, host ABI, CPU policy, producer recipe, and executor identity; and
- the capture receipt itself in the complete carrier payload inventory.

Instance creation still constructs a fresh store, WASIX process, globals,
tables, stacks, descriptors, clocks, signals, locks, and extension state, and
then runs normal module start. Immediately afterward, before dynamic module
loading, relocations, or constructors, the runtime validates the module and
layout receipt, compares the live prefix byte-for-byte, and replaces only those
identical pages with the immutable image as a writable private mapping. This
keeps global TLS relocation and data-drop semantics per instance while making
clean initialized pages reclaimable/shareable. A private write faults a COW
page visible only to that instance; `memory.grow` and PostgreSQL's separately
declared coherent shared mappings retain their normal behavior.

The image may contain deterministic linear-memory TLS initializer bytes because
ordinary start has just reproduced them, but it never contains guest-entry
stack state, mutable globals, tables, descriptors, timers, locks, WASIX process
objects, or a running postmaster/backend snapshot. The final sealed carrier
fails closed on an identity, layout, granule, size, digest, or byte-comparison
mismatch before side-module code can run. It does not set the LLVM initialization
guard or skip `__wasm_init_memory`.

### Native image adapters

The shared template bytes and invariants are cross-platform; the mapping
mechanism is not:

| Host adapter | Current implementation | Support boundary |
| --- | --- | --- |
| Linux | Seals the verified image against mutation, then remaps it `MAP_PRIVATE` at an allocator-owned reservation. `MAP_FIXED` follows exact ownership/range checks; PostgreSQL shared windows remain separate coherent file mappings. | Focused seal/identity, partial-page, private/shared remap, COW-isolation, lifetime, grow, and sparse-copy tests pass. No pressure/reclaim or huge-page policy claim. |
| macOS | Unix mapper source exists without macOS evidence. | Unsupported. |
| Windows | No placeholder/section mapper. | Unsupported. |

The Linux row describes implemented local research; the macOS and Windows rows
remain design requirements, not support claims. A Linux result does not
establish that either other adapter is correct.

### Image evidence boundary

The focused Linux tests cover seal and identity checks, partial-page handling,
private/shared remapping, COW isolation, lifetime, growth, sparse copying, and
fail-closed identity/layout mismatches. They do not establish crash recovery,
other-host behavior, aggregate pressure, tail latency, or release resolution.

## Child wait and signal reliability

The experiment exposed two independent races and one runtime lifecycle gap:

1. A direct `proc_join` can return WASI errno 27 (`INTR`) after clearing its
   in/out PID selector. PostgreSQL's direct join shims now retry EINTR and
   reconstruct the tagged PID before every attempt.
2. SIGCHLD can arrive before the application calls `sigaction`. wasix-libc now
   materializes its built-in default handler before the first indirect callback,
   avoiding an uninitialized function-table entry while preserving default and
   ignored dispositions.
3. The patched Wasmer join path implements true nonblocking “any child” lookup,
   processes signals during blocking waits, and removes an adopted child only
   once an exit status is available.

These fixes are one contract. Removing the PostgreSQL retry because the Wasmer
wait path improved would reintroduce an ordinary POSIX EINTR bug. Likewise,
handling EINTR alone does not make early default SIGCHLD dispatch safe.

At the 2026-08-08 upstream review, the inspected Wasmer main did not contain
this complete wait/reap/spawn-cleanup behavior, and the inspected wasix-libc
retained a different `waitpid(..., WNOHANG)` status-decoding defect. The patched
runtime and every local sealed carrier therefore retain and probe the pinned
local patches; no upstream-equivalence claim is made.

Immutable upstream snapshots supporting that boundary are Wasmer's
[`proc_join`](https://github.com/wasmerio/wasmer/blob/1276e8462a66a2a218ae1d1600de5fa6afd0be4a/lib/wasix/src/syscalls/wasix/proc_join.rs#L116-L205)
and
[`proc_spawn3`](https://github.com/wasmerio/wasmer/blob/1276e8462a66a2a218ae1d1600de5fa6afd0be4a/lib/wasix/src/syscalls/wasix/proc_spawn3.rs#L125-L186),
plus wasix-libc's
[`waitpid`](https://github.com/wasix-org/wasix-libc/blob/35224ad8f837e35a9c76d9474c455156a2330a7f/libc-top-half/musl/src/process/waitpid.c#L24-L61).
Likewise, stock wasix-libc
[`mmap`](https://github.com/wasix-org/wasix-libc/blob/35224ad8f837e35a9c76d9474c455156a2330a7f/libc-bottom-half/mman/mman.c#L322-L447)
does not provide the fixed coherent shared-page contract used here. Wasmer's
[general runtime platform matrix](https://docs.wasmer.io/runtime/features/)
must not be read as a PostgreSQL postmaster support matrix.

## Cross-instance latch ordering and timer wakeups

The backend-wave gate exposed a stronger failure than a generic lock timeout.
With one persistent diagnostic connection, one PostgreSQL backend reported
`Lock/extend` for 600 samples while its relation `ExclusiveLock` was
`granted=true` and `pg_blocking_pids` was empty. Three peers queued behind it,
and unrelated backends continued updating through the same postmaster. The
heavyweight lock manager had therefore completed `GrantLock`; the granted
backend remained asleep in the `ProcSleep`/`WaitLatch` path after `SetLatch`.

The historical safe-O2 PostgreSQL module contains `atomic.fence` for
`pg_memory_barrier()`. Wasmer's repaired LLVM backend emits an LLVM
sequentially consistent fence when that operator reaches it. This carrier
deliberately aliases file-backed pages across distinct Wasm instances, so the
operator remains required even though the WebAssembly threads specification
defines
[`atomic.fence`](https://webassembly.github.io/threads/core/syntax/instructions.html)
as a synchronization primitive.

The last completed 2026-08-09 release-O3 structural checkpoint had a two-stage
concurrency contract. Its linked module contained 1,111 `atomic.fence`
operators. Exact export-closure DCE removed 116 fences in dead functions,
leaving 995 in the sealed module.
`SetLatch`, `ResetLatch`, and `WaitEventSetWait` retain exactly 2, 1, and 1
fences respectively, together with their packed atomic load/RMW operators;
all 4,739 function-table entries are unchanged. Both inventories are checked
and source-signature-bound. Unmeasured profiles fail closed instead of
borrowing these release-O3 totals. The checkpoint predates the current
`runtime-build-recipe.v3` builder identity; current source must regenerate the
proof and pass the runtime gates before a carrier can be admitted.

The project-scoped repair is guarded by
`PG_WASIX_ATOMIC_LATCH_STATE`. It packs SET and SLEEPING into one lock-free SC
atomic word, preserves the upstream `Latch` layout with a reserved word and
static offset checks, and makes wake responsibility an atomic clear-to-set
transition. Existing fences remain a secondary contract. Each optimized
carrier must prove the packed atomic load/RMW operators and fences in its final
module, then pass the focused latch and repeated fresh-postmaster ladders.

Timers are independently unsupported. The pinned wasix-libc `setitimer`
implementation derives the delay from `it_interval` rather than `it_value` and
requests repetition even for PostgreSQL's one-shot timers. The pinned Wasmer
interval path interprets a WASI nanosecond timestamp as milliseconds, records
but does not consume the repeat flag, and polls timers only while processing
another signal. It therefore cannot autonomously wake a backend blocked
forever in epoll. `deadlock_timeout`, `statement_timeout`, and related
PostgreSQL recovery/diagnostic timers cannot be considered implemented. The
focused 100 ms one-shot diagnostic reached its 2,001 ms bound with zero alarms.
One-shot and interval timer semantics are unsupported and excluded from the
current postmaster claim.

## Shared-object and registry lifecycle

The patched mapping/futex registry is keyed by backing device/inode (or the
native Windows volume/file identity) within one host runtime process, but its
table owns only a weak reference plus an allocation-generation token. Every
live mapping and in-flight waiter owns the registry strongly; the registry in
turn owns the exact same `Arc<File>` already used for the mapping. That pins
the backing identity without opening another host descriptor. The last strong
drop removes only its exact generation, so an old destructor cannot erase a
replacement after identity reuse. A deterministic round-robin sweep examines
at most 16 weak slots per lookup as a poisoned-lock/abandoned-slot backstop,
and telemetry separates active, stale, and total slots.

Focused ownership, replacement, split-mapping, pruning, and exec-child tests
plus the full WASIX library suite cover the in-process invariants. They make no
claim for repeated real PostgreSQL DSM map/unmap, cross-instance futex
wait/wake, host-FD, or registry-slot plateau under churn. The implemented
untimed lifecycle lane closes each measured window with a runtime-writer
flush/fence record followed by a separate committed ACK containing its exact
synced-log end offset. It validates one global sequence beginning at one,
freezes only that committed byte prefix, re-reads the ACK to close replacement
races, and binds ACK/frozen hashes and the offset into a receipt that the
validator checks independently. Its terminal stable tail rejects foreign
observers, foreign wait kinds, stale runtime/shared registry entries, slot
imbalance, count drift, and sample gaps. The legitimate idle PostgreSQL shape is
six registered processes and six runtime states in one rooted topology with
five child edges. It has eleven execution leases: six active tasks plus five
parent continuations suspended across the EXEC_BACKEND `vfork`/`exec` edges.
The exploratory validator requires those relational invariants and exact
readiness-to-post-reconnect equality; it also requires no pending child
publication, quiescence waker, retiring node, or stale entry.

Cold readiness is not the stable baseline. PostgreSQL 18's background writer
logs a running-transactions snapshot on its first approximately 15-second
maintenance interval. That record publishes an asynchronous WAL LSN and wakes
the WAL writer, which opens the current segment on first write and deliberately
retains its VFD while the segment remains current. The verbose trace proves
that the persistent aggregate guest-FD transition from 70 to 71 belongs to PID
6 opening `pg_wal/000000010000000000000001`; PID 7's `global/1262` descriptor
was already present in the earliest inventory and did not cause the delta.

The lifecycle lane advances this timer-controlled lazy state with an event
barrier rather than a guessed delay or an FD-name exception. During a dedicated
maintenance phase it samples the `pg_stat_io` row for
`backend_type='walwriter'`, `object='wal'`, `context='normal'`, invokes
`pg_log_standby_snapshot()`, and records the returned LSN. It then polls using
fresh statistics snapshots until both `writes` and `write_bytes` increase and
`pg_current_wal_flush_lsn()` reaches that LSN, rejecting a changed
`stats_reset`. Readiness measurement begins only afterward. This exercises the
same `LogStandbySnapshot` -> asynchronous-LSN -> WAL-writer path as the periodic
event without relying on timing, filesystem paths, or runtime-internal FD
knowledge. It requires `wal_level >= replica` and is unavailable in recovery;
those preconditions fail closed instead of silently restoring the cold
baseline.

Every compact field is present in a versioned, pre-run-hashed baseline policy
bound to the resolved PostgreSQL profile, runtime, guest module, and carrier
identities. The checked-in policy is deliberately `exploratory-unbounded` with
`claim_scope=relative-to-fresh-baseline`: its equality gate proves reconnects
did not accumulate state relative to readiness, not that every nonzero
readiness resource is intrinsically leak-free or small. The distinct checked-in
qualified policy has exact bounds for every observed field; changing only an
exploratory status or leaving a near-u64 range is rejected. Absolute PSS/cgroup budgets govern legitimate
baseline size.
Wait-dump instrumentation is prohibited in timed throughput and latency
qualification because it changes the parked-wait hot path.

The independent performance lanes do not compose into an aggregate embedded-
viability or release claim. This project provides no composite classifier.

Hard-crash restart is unsupported. The PostgreSQL WASIX overlay
treats an existing named main-shared-memory object as live because its
`PGSharedMemoryIsInUse` path has no reliable lock/lease primitive. A terminated
runtime can therefore leave an object that prevents restart without external
cleanup. This project has no cluster lease or crash-safe named-object lifecycle.

## Resource-limit semantics

The patched runtime implements `proc_rlimit_get`, consumed by wasix-libc
`getrlimit`:

- `RLIMIT_STACK`: current and maximum are the runtime-owned finite guest stack
  policy (4 MiB in the recorded blocker run), allowing PostgreSQL's
  `max_stack_depth` guard to fire before host-stack exhaustion;
- `RLIMIT_CORE`: current and maximum are zero because the guest runtime does
  not produce POSIX core files;
- `RLIMIT_NOFILE`: current and maximum are `RLIM_INFINITY`; actual descriptor
  allocation can still fail, but PostgreSQL is not given a false host soft
  limit; and
- unsupported resources return `EINVAL` rather than fabricated values.

The contract covers reads, not mutable `setrlimit`, finite-descriptor-policy, or
guest-core semantics; those are unsupported.

## Performance and memory model

The target is native single-backend-like steady-state behavior while retaining
real postmaster concurrency. Measurements must separate cold AOT production,
postmaster startup, warm backend launch, persistent-connection query latency,
connect/select/disconnect latency, fan-out bulk throughput, tail latency,
WAL/fsync-heavy work, and extension/error paths. The concurrent harness's bulk
fields measure batch wall time and derive logical row operations per second;
they do **not** measure request or transaction throughput, backend launch
latency, or a per-query p95. Its opt-in native-libpq lane separately records raw
`CLOCK_MONOTONIC` persistent-query samples and complete `PQconnectdb` through
`SELECT 1` and `PQfinish` reconnect/backend-launch samples. The lane exists and
fails closed; no aggregate WASIX/native latency claim is made without an exact
paired evidence receipt.

The research memory budget has five independently measured parts:

1. fixed supervisor/runtime and verified module cost;
2. PostgreSQL's file-backed shared mappings, counted once by physical identity;
3. marginal private memory for each live logical process;
4. transient backend-launch and workload peaks; and
5. kernel, page-table, socket, and file-cache charge owned by the carrier's
   resource group.

Aggregate host RSS alone cannot supply those values. Native PostgreSQL's
process-tree RSS counts shared mappings once per OS process. The WASIX carrier
maps the same PostgreSQL shared-memory file at a different address in every
guest instance, so even its one host process can count the same physical file
page at several aliases. VSZ is dominated by a 4 GiB static memory bound plus a
2 GiB guard per instance and is largely zero-resident. Linux qualification uses
PSS/private mapping data together with a dedicated cgroup's physical charge;
other hosts require their native physical/private/commit equivalents and
shared-backing identity. See [rss-memory-model.md](rss-memory-model.md) for the
measurement contract and full attribution.

The historical five-module carrier with runtime ABI
`995f6a9bf69ce6ff154533369eb4f9d6c45d9dfca13fdc213e0f6be8ae405217`
and payload inventory
`8e907e600fa9d7197c2ae98ddece5cb3093e4e7e3caf8f27f325a24955c120a7`
with manifest
`cea8c0933fa01f6646184c1f97c2156300e50bcf8a5d1d2e38fbb4ed2bb11fec`
produced the last retained budgeted Linux x86_64 result. On the one measured host,
`final-995f-embedded-c4-lower-pressure-v1` passed the predeclared
`embedded-c4-lower-pressure-v1` four-client budget:

| Readiness PSS | Peak fan-out PSS / anonymous PSS / page tables | Whole-run cgroup peak and limits | Required-phase pressure | Bulk rates read/mixed/update/insert |
| ---: | --- | --- | --- | --- |
| 66.862 MiB | 132.708 / 77.473 / 1.164 MiB, within 160 / 96 / 2 MiB | 224.707 MiB; 256/224/0 MiB hard/high/swap | 2,528 high events; PSI some/full 0.003289; no max/OOM/OOM-kill/swap | 352,846.832 / 359,874.044 / 42,854.082 / 140,449.438 ops/s |

The row is a passed historical memory-performance run for one exact carrier,
Linux host, and workload shape. It is not an aggregate embedded-viability,
release, all-workload, latency, or cross-platform claim.

The original compiler-bearing carrier used 226.940 MiB readiness PSS. The
successive retained evidence runs below show the architecture's historical
optimization trajectory. The values are named run observations, not a claim
that each delta belongs exclusively to the feature in its label.

| Evidence run | Readiness or quiescent-readiness PSS | Boundary exercised |
| --- | ---: | --- |
| `embedded-pss-baseline-c1-i100k` | 226.940 MiB | Historical compiler-bearing baseline. |
| `sealed-detached-paired-c1-i100k-r2` | 150.062 MiB | Compiler-free sealed registry and detached AOT. |
| `cow-image-fixed-c1-i100k` | 129.929 MiB | Corrected immutable post-start private image. |
| `cow-arc-import-c1-i100k` | 113.901 MiB | Shared immutable linker/import ownership. |
| `cow-lazy-artifact-c1-i100k` | 79.101 MiB | Exact eager exports with lazy AOT activation of the remainder. |

The prior safe-O2 carrier then passed the following explicit cgroup gates with
swap disabled. They remain historical comparison points rather than the final
`995f6a9b…` carrier's budget result:

| Run | Hard/high limit | Result | Relevant physical evidence |
| --- | --- | --- | --- |
| `cap-final-wasix-c1-100k-192m` | 192/160 MiB | All four 100k workloads passed; no max/OOM/swap event | 77.995 MiB quiescent readiness PSS; fan-out peaks 98.640/121.291/149.189/154.604 MiB for read/mixed/update/insert. |
| `cap-content-addressed-final-c1-read-96m` | 96/88 MiB | Indexed read passed through the final content-addressed carrier; no max/OOM/swap event | 77.761 MiB readiness, 95.171 MiB fan-out PSS, 88.629 MiB cgroup peak, and 220 high events. |
| `cap-final-wasix-c4-100k-192m-pressure` | 192/176 MiB | All four workloads passed; no max/OOM/swap event | Reclaim pressure reduced write throughput; this is a survival tier, not the preferred performance budget. |
| `cap-final-wasix-c4-100k-256m` | 256/224 MiB | All four workloads passed; no max/OOM/swap event | Fan-out PSS 107.576/195.131/219.062/219.653 MiB; lower-pressure sizing characterization only because no PSS/high/PSI budgets were predeclared. |

The 192 MiB four-client run's mixed-write, update, and insert rates were about
13%, 25%, and 19% below the 256 MiB run respectively, consistent with active
reclaim rather than a free memory reduction. `cap-final-wasix-c4-read1m-maps`
measured 78.068 MiB quiescent readiness, 108.274 MiB during four active read
clients, and 93.674 MiB after quiescence: about 7.5 MiB PSS per concurrently
active read backend over that readiness point. One workload and one host do
not define the general marginal-backend budget.

Mapping inspection explains why raw RSS remains much larger. A live diagnostic
with 14–15 guest processes counted roughly 650 MiB of RSS across aliases of
one approximately 142 MiB PostgreSQL shared-memory backing; proportional
accounting charged approximately one physical copy. The immutable initializer
images themselves shared effectively, with roughly 230 KiB private per guest
and about 5 MiB aggregate image PSS in that snapshot. The checkpoint resident
optimization targets are instead host allocator/arena retention, approximately
17 MiB of anonymous executable code, and dense per-instance runtime metadata
plus active guest-private tails.

A declared embedded PostgreSQL profile (`io_method=sync`,
`shared_buffers=32MB`) removes three AIO-worker instances and materially lowers
PSS. The last retained budgeted run is the 256/224 MiB result above. Earlier
same-profile 192/176 and 160/144 MiB runs remain pressure evidence: the former
completed all four workloads at 66.515 MiB readiness and at most 131.709 MiB
fan-out PSS but recorded 4,650 high events; the latter recorded 11,804 high
events and only 13,703 update ops/s. Removing `memory.high` at a 160 MiB hard
limit did not create headroom: it completed with 10,168 `memory.max` events.
The profile makes no broader correctness, durability, or latency claim and is
never a hidden substitute for fixing carrier overhead.

The release-O3 PostgreSQL guest is also characterization only. At one client
and one million iterations, its WASIX/native bulk-throughput ratios were
0.754/0.801/0.779/0.829 for read/mixed/update/insert. A fresh four-client
one-million-iteration mixed-write run did not complete within 300 seconds;
sampling showed clients serialized on PostgreSQL's relation-extension lock. A
different contaminated sequence emitted PostgreSQL `IO in wrong state: 0` from
the AIO state machine. The O3 result is therefore diagnostic-only despite its
single-client gain. A balanced one-block 100k diagnostic also passed all throughput gates at
0.746/0.788/0.833/0.874, but failed the batch-residual gates for mixed-write,
update, and insert. Its overall classification remains diagnostic; the
residual is not per-query or launch latency.

Detailed cache-lifecycle, relocated-code, and owner-census evidence boundaries
are documented in
[embedded-memory-architecture.md](embedded-memory-architecture.md). This
project makes no claim for cross-platform code mappings, compacted runtime
metadata, aggregate performance composition, release signing, or SDK resolution.

These optimizations preserve fresh stores, private process state, exact
file-backed PostgreSQL shared memory, signals/timers, extension loading, and
error recovery. Sharing one mutable instance between backends, a full-state-
cloning fallback, weakening WAL/fence/fsync semantics, unsafe path-only executable
caching, shrinking guards solely to improve VSZ, or using allocator trimming as
the primary fix are explicitly outside the architecture. The PostgreSQL path
is `vfork` to fresh `exec`; the excluded alternative is not supported.
Shrinking the sparse 4 GiB bound/2 GiB guard
or 32 MiB stack reservation solely to improve RSS/VSZ is not an acceptable
shortcut: those mappings are mostly nonresident, and any change must prove
bounds-check, collision, deep-stack, and tail-latency effects.

## Explicitly excluded claims

This research project has no release boundary, release artifacts, SDK resolver,
platform-support metadata, compatibility-negotiation guarantee, signed
provenance root, hard-crash recovery contract, cross-platform carrier, or
aggregate performance claim. Its checked-in qualification tools report only
the exact Linux research scopes they measure.
