# PG18 WASIX PostgreSQL Runtime

This runtime is the fresh PostgreSQL 18 WASIX build that keeps the released
Oliphaunt WASM product shape: one embedded backend behind the direct Rust API
and the local server wrapper.  It is not the concurrent full PostgreSQL WASIX
experiment and should not take postmaster or multi-backend assumptions as a
performance constraint.

## Target Shape

- PostgreSQL 18.4 source, pinned independently from the released PG17.5 lane.
- Oliphaunt-style single backend execution, engineered from first principles.
- Existing released-lane capabilities preserved before replacement:
  protocol execution, template packaging, initdb, pg_dump, bundled extensions,
  runtime support modules, and the server wrapper.
- The released artifact pipeline packages standalone WASIX `initdb` and
  `pg_dump` tools.  `pg_dumpall.c` is patched only because it shares the
  renamed pg_dump helper; pg_dumpall and psql are not separate packaged WASIX
  tools in this lane unless future work adds them explicitly.
- Patch series kept small, ordered, and reviewable.  Each patch should explain
  which PostgreSQL invariant it changes and why the embedded WASIX runtime
  still preserves the useful part of that invariant.
- Performance goal is to beat the released PG17.5 WASIX lane on the existing
  benches before this becomes a replacement candidate.

## Research Assessment

The concurrent full-PostgreSQL WASIX experiment is still valuable for finding
Wasmer, WASIX libc, fork, socket, shared-memory, and toolchain blockers, but it
is not the right replacement path for the released embedded product yet.  The
experiment evidence points to persistent process/fork/shmem/socket/RSS costs
before query execution, while the released product wins by keeping one backend,
one host lifecycle, direct FE/BE pumping, prebuilt PGDATA, and AOT reuse.

The practical direction is therefore:

- Keep full concurrent PostgreSQL under WASIX as upstream/runtime research and
  a correctness oracle for patches that should eventually make WASIX more
  POSIX-like.
- Build the replacement product as PG18 WASIX `wasix-dl`, preserving the
  released Oliphaunt-style execution model and only taking runtime patches that
  improve that model.
- Treat the PG18 experiment's PostgreSQL hot-path patches as candidates after
  parity is buildable.  The strongest candidates are WASIX-gated
  `hash_bytes()` load folding, top-level `TransactionIdIsCurrentTransactionId`
  short-circuiting, and narrow btree int4 comparator fast paths.  They attack
  hot guest CPU paths without changing the host lifecycle.
- Keep diagnostic toggles, such as bottom-up btree delete disabling, out of the
  default product path unless benchmarks prove a production-safe default.
- Defer broader planner/executor shortcuts, locale-sensitive LIKE shortcuts,
  and stack-allocation rewrites until they have focused regression coverage,
  because they can silently change SQL semantics or memory pressure.
- Record every full-PG experiment patch in
  `src/runtimes/liboliphaunt/wasix/assets/build/postgres/experiment-patch-disposition.toml`
  before porting or rejecting it.  The source-spine guard checks that manifest
  so experiment patches cannot be copied into this runtime without a WASIX
  rationale.

The immediate conclusion is that a "proper" concurrent PostgreSQL under WASIX
is unlikely to match native PostgreSQL or released Oliphaunt-style WASM performance
soon.  A fresh PG18 WASIX runtime can plausibly beat the released PG17.5 lane
because it keeps the low-overhead lifecycle while inheriting newer PostgreSQL,
newer WASIX/Wasmer fixes, tighter host ABI boundaries, and targeted hot-path
patches from the experiment.

## PG17.5 Release-Lane Implementation Comparison

The released PG17.5 WASIX lane is represented by the monolithic patch:

```sh
src/runtimes/liboliphaunt/wasix/assets/build/patches/postgres-oliphaunt-wasix-dl.patch
```

The PG18 lane represents the same product shape as a 37-patch PostgreSQL 18.4
series under:

```sh
src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches
```

The top-level execution model is equivalent.  Both lanes start PostgreSQL
through `PostgresSingleUserMain()`, attach a host-backed frontend/backend
`Port`, let the Rust host call PostgreSQL's startup-packet parser, emit normal
startup protocol messages, and then drive PostgreSQL one frontend message at a
time through an exported `PostgresMainLoopOnce()`.

The ABI is intentionally not equivalent.  PG17.5 still exposes the
Oliphaunt-shaped names and compile macro, such as `OLIPHAUNT_WASIX_DL`,
`oliphaunt_wasix_start`, `pgl_pq_flush`, `pgl_getMyProcPort`, and
`pgl_sendConnData`.  PG18 replaces those with Oliphaunt-owned symbols:
`OLIPHAUNT_WASM_SINGLE_USER`, `oliphaunt_wasix_start`,
`oliphaunt_wasix_pq_flush`, `oliphaunt_wasix_get_proc_port`, and
`oliphaunt_wasix_send_conn_data`.  The Rust host now resolves the
`oliphaunt_wasix_*` exports directly, so PG18 should not leak old `pgl*`
symbols as part of the public lane contract.

The build spine is similar but split for reviewability.  Both lanes add a
`wasix-dl` PostgreSQL template, position-independent side-module builds, a
backend `libpgcore` object, WASIX dynamic-linker makefile support, and PGXS
side-module extension installation.  PG18 keeps the same broad shape while
using `OLIPHAUNT_WASM_SINGLE_USER`, `DLSUFFIX=".so"`, and explicit pthread and
unnamed POSIX semaphore settings in the template.  PG18 also carries a later
patch that forces backend-core linking through `wasm-ld --relocatable`.

The main implementation delta is protocol I/O.  PG17.5 routes backend protocol
bytes through the old broad WASIX/Oliphaunt shim path.  PG18 adds an explicit
`OliphauntWasmHostIO` callback table to `Port`, and the backend libpq
`secure_raw_read()` and `secure_raw_write()` functions dispatch through those
callbacks only when the embedded WASIX port installs them.  This is a
cleaner boundary, but it is also one of the few places where the PG18 port is
not mechanically identical to PG17.5 and should remain on the copy/flush audit
list.

The error-recovery and protocol-state work is at least as complete in PG18 as
in PG17.5.  PG18 carries the host-callable top-level recovery export, COPY
state reset on error, active portal failure during abort, post-error
ReadyForQuery scheduling for simple-protocol recovery, and re-arming of
`PG_exception_stack` after host-forced recovery.  These are the pieces that let
one backend survive query failures in the embedded host.

The PG17.5 monolithic patch has one source hunk not currently present in the
PG18 patch stack: `src/common/file_utils.c` treats `EISDIR` like `EBADF` and
`EINVAL` when fsyncing a directory.  That is a portability/tooling delta, not a
steady-state query hot path, and it does not explain the PG18 indexed-update
regression.  It should still be either ported as a narrow PG18 patch if a WASIX
tool path needs it, or documented as unnecessary after initdb/pg_dump coverage.

PG18 carries several PostgreSQL hot-path patches that PG17.5 did not carry:
WASIX-gated `hash_bytes()` load folding, a top-XID visibility shortcut, guarded
btree int4 comparator shortcuts, btree delete scratch-buffer stack placement,
a deterministic `%literal%` LIKE fast path, upstream-style checkpoint/runtime
fast paths, an `XLogWrite()` hot-loop segment-bounds check, and an embedded-only
activity-ID reporting guard.  Diagnostic timing probes remain available around
simple-query execution, executor/storage, btree insertion, btree comparison,
and heap update subphases.  With a release-built host and the 37-patch O2
artifact, PG18 is faster than same-host PG17.5 and the documented PG17.5
release table on every speed-test head; see
`docs/internal/PG18_WASIX_PERF_STATUS.md`.

## Upstream PG18 legacy lane Hints

The upstream Oliphaunt branch
`https://github.com/postgres/postgres/tree/PG18 legacy lane` was
compared against PostgreSQL `REL_18_3` on 2026-05-29.  It is an Emscripten
single-artifact port, not a WASIX dynamic-main lane, so its symbol names and
build scripts are reference material only.  It should not be copied into PG18
WASIX with `pgl*` or `oliphaunt` ABI names.

For the comparison, the local Oliphaunt checkouts were given the real upstream
PostgreSQL base tags by fetching `REL_17_5` and `REL_18_3` from
`postgres/postgres`.  `PG17 legacy lane` changes 54 files versus PostgreSQL
`REL_17_5`; `PG18 legacy lane` changes 55 files versus PostgreSQL `REL_18_3`.
The core runtime patch surface is the same in both Oliphaunt branches:
`build-oliphaunt.sh`, `oliphaunt/src/oliphauntc/oliphauntc.c`,
`src/backend/access/transam/xlog.c`, `src/backend/postmaster/checkpointer.c`,
`src/backend/tcop/postgres.c`, `src/backend/utils/init/postinit.c`,
`src/backend/utils/misc/guc.c`, and a small set of storage/init support files.
There are no hidden upstream PG18 Oliphaunt btree, hash, LIKE, executor, or planner
speed patches.

Useful findings from that branch:

- The top-level single-user architecture matches our direction: dummy
  frontend/backend port, exported startup packet parser, startup protocol
  emission, loop-pumped `PostgresMainLoopOnce()`, and host-managed top-level
  longjmp recovery.
- The branch still relies on broad C preprocessor remaps for `recv`, `send`,
  `system`, `popen`, `pclose`, identity calls, SysV shared memory, `fcntl`,
  `munmap`, and longjmp.  Our PG18 lane deliberately replaces the protocol
  side of that with `OliphauntWasmHostIO` callbacks and uses
  `oliphaunt_wasix_*` names for the remaining WASIX bridge.
- It sets both `IsPostmasterEnvironment` and `IsUnderPostmaster` when the host
  starts the embedded backend, then patches checkpoint paths so Oliphaunt does not
  try to signal a missing checkpointer from WAL segment pressure.  Our active
  PG18 lane now ports that shape under Oliphaunt-owned markers: patch `0034`
  sets those environment flags in `oliphaunt_wasix_start()`, and patch `0032`
  keeps XLog-size checkpoint requests disabled while preserving local
  in-process `RequestCheckpoint()` behavior for embedded WASIX.
- It patches `RequestCheckpoint()` to run in-process under Oliphaunt even when the
  backend was made to look postmaster-owned.  The active PG18 lane now does the
  same under `OLIPHAUNT_WASM_SINGLE_USER`.
- It shortens `PGSemaphoreReset()` to one `sem_trywait()` under Oliphaunt.  The
  active PG18 lane ports this as part of the current 37-patch stack.  It is a
  lifecycle/runtime cleanup optimization, not an explanation for the earlier
  isolated Test 11 COMMIT gap.
- It changes `pg_flush_data()` to call `fsync()` under oliphaunt.  That is a
  portability choice for Emscripten MEMFS, not an obvious WASIX performance
  improvement.  It is likely too blunt for the PG18 release lane without a
  tool-specific failure.
- It skips `guc_strdup()` for `record->last_reported` in `ReportGUCOption()`.
  The active PG18 lane now ports this.  It can reduce long-lived GUC-report
  allocations, but it affects startup or changed GUC reporting, not the speed
  suite's steady-state query work.
- It adds private encoding symbol shims in libpq and pg_dump to avoid static
  link/LTO collisions.  Our WASIX bridge and initdb shim already expose
  `pg_char_to_encoding_private` and `pg_encoding_to_char_private`; the PG18
  lane also carries a narrower pg_dump LTO helper rename.  If future pg_dump or
  extension builds fail with encoding symbol collisions, this branch is useful
  prior art.
- It collects extension undefined symbols into import lists and then builds the
  main oliphaunt export list from those imports plus a manually included export
  file.  Our PGXS side-module lane already has analogous import-list
  generation, but the upstream branch is a good checklist for extension
  packaging completeness.
- It packages a minimal ICU data tree.  Our release lane should keep validating
  ICU/collation behavior through the existing asset pipeline instead of
  inheriting Oliphaunt's Emscripten preload layout.

None of the PG18 legacy lane source deltas explained the earlier PG18 WASIX
per-head misses.  The upstream branch's relevant lifecycle/runtime deltas are
already present in the active PG18 lane, and the branch does not carry the
btree/hash/top-XID/LIKE hot-path patches already present here.  The final Test
15 gap was closed by an Oliphaunt-specific embedded activity-ID reporting guard,
not by wholesale copying more upstream Oliphaunt code.

## Patch Stack Plan

1. Build spine: teach PostgreSQL 18 about the `wasix-dl` dynamic-main build
   target without adding behavioral changes. Done in patch 0001. This patch
   keeps PostgreSQL spinlocks on the normal WASIX toolchain atomics path; the
   old disabled-spinlock fallback is not part of this lane.
2. Host I/O: add explicit embedded backend I/O hooks instead of relying on
   broad syscall remapping. Done in patch 0002.
3. Startup parsing: expose PostgreSQL's own startup packet parser to the
   WASIX host under `OLIPHAUNT_WASM_SINGLE_USER`. Done in patch 0003.
4. Host lifecycle exports: attach a host-backed FE/BE Port after standalone
   initialization and emit the startup protocol messages expected by the
   released Rust host. Done in patch 0004.
5. Loop-pumped protocol: split the `PostgresMain()` loop so the host can drive
   one frontend message at a time without starting a second backend lifecycle.
   Done in patch 0005.
6. COPY protocol handoff: report PostgreSQL CopyIn/CopyOut/CopyBoth response
   transitions to the WASIX host so the released proxy can switch from buffered
   pumping to streaming at PostgreSQL-owned protocol boundaries. Done in patch
   0006.
7. PGXS side-module parity: add the `wasix-dl` platform makefile expected by
   configure and emit WASIX extension import lists from PGXS installs without
   inheriting Emscripten-named variables or absolute non-`DESTDIR` paths. Done
   in patch 0007.
8. Error recovery protocol state: reset PostgreSQL-owned COPY handoff state
   when top-level error recovery aborts the active subprotocol. Done in patch
   0008.
9. Error recovery: keep PostgreSQL's top-level cleanup path host-callable so
   one backend can recover from query failures. Initial recovery export done in
   patch 0005; the WASIX bridge and Rust host already route forced
   process-exit ERROR recovery through `PostgresMainLongJmp()`.
10. WASIX process identity: route PostgreSQL's process identity lookups through
   the `wasix-dl` port header instead of PG18 configure-script-wide identity
   remaps. Done in patch 0009.
11. Shared memory and semaphores: route SysV shared-memory calls through the
   `wasix-dl` port header and local WASIX headers instead of PG18
   configure-script-wide shared-memory remaps. Done for SysV shared memory in
   patch 0010. Prefer unnamed POSIX semaphores explicitly in patch 0011.
12. Startup error capture: route `InitPostgres()` failures through the
   host-backed protocol Port before the exported main-loop recovery buffer is
   active, so database/role/startup-option errors remain PostgreSQL-owned.
   Done in patch 0012.
13. Host-recovery portal cleanup: mark active portals failed during
   `AtAbort_Portals()` while the embedded backend is active, preserving
   PostgreSQL-owned cleanup when a WASIX host routes nested ERROR unwinds
   through the top-level recovery export. Done in patch 0013.
14. Hash hot path: use WASIX-only `memcpy`-based 32-bit loads in the
   unaligned little-endian `hash_bytes()` and `hash_bytes_extended()` paths.
   This keeps unaligned C access defined while giving LLVM a single-load
   lowering opportunity in hash-table-heavy query paths. Done in patch 0014;
   promotion still requires benchmark evidence.
15. Transaction visibility hot path: short-circuit
   `TransactionIdIsCurrentTransactionId()` for the common top-level case after
   the top XID comparison fails and no parallel, parent, or child XID source
   can still match. Done in patch 0015; promotion still requires benchmark
   evidence.
16. Btree int4 compare hot path: avoid the fmgr trampoline for WASIX
   embedded-runtime comparisons that prove they are the built-in integer btree
   family with int4 input on both sides and InvalidOid collation, while still
   using `index_getattr()` and falling back to upstream comparison for every
   other case. Done in patch 0016; the more aggressive direct tuple-data
   shortcut from the full-PG experiment remains intentionally unported pending
   runtime evidence and tighter layout proof.
17. Btree delete scratch buffers: keep `MaxTIDsPerBTreePage` simple-deletion
   and bottom-up-deletion scratch arrays on the stack in the embedded WASIX
   lane. The arrays are page-size bounded and PostgreSQL already uses similar
   page-local stack buffers elsewhere; upstream heap allocation remains for
   all other builds. Done in patch 0017.
18. pg_dump LTO hygiene: rename pg_dump's generic `executeQuery()` helper to
   `executeDumpQuery()` so standalone WASIX pg_dump builds do not expose an
   unnecessarily collision-prone external symbol under thin LTO. Done in patch
   0018.
19. Host-forced recovery ReadyForQuery scheduling: preserve PostgreSQL's
   post-ERROR `send_ready_for_query` behavior when the WASIX host invokes the
   recovery export directly, while still withholding ReadyForQuery during
   extended-protocol skip-till-Sync recovery. Done in patch 0019.
20. Host-forced recovery exception boundary: re-arm `PG_exception_stack` to
   `postgresmain_sigjmp_buf` when the WASIX host invokes the recovery export
   directly, matching PostgreSQL's normal post-`sigsetjmp` recovery flow. Done
   in patch 0020.
21. Extension/tool parity: rebuild contrib, pg_dump, initdb, and packaged
   extensions against the PG18 lane.
22. Performance work: carry Wasmer, WASIX libc, LTO/codegen, file-system, and
   memory-growth improvements into this lane only after parity is testable.

## Experiment Patch Disposition

The full-concurrent PG18 WASIX experiment remains useful prior art, but its
patches are not the default source of truth for this lane.  The reviewed
disposition manifest is:

```sh
src/runtimes/liboliphaunt/wasix/assets/build/postgres/experiment-patch-disposition.toml
```

The manifest records each experiment patch by filename, whether it was ported,
replaced, deferred, or rejected, and why that decision fits a single-backend
WASIX product.  The currently carried performance/tool patches are the hash
load fast path, top-XID visibility fast path, guarded btree int4 comparator,
btree delete scratch-buffer stack placement, LIKE substring shortcut, first
int4 leaf compare shortcut, and pg_dump LTO symbol hygiene.  The
bottom-up-delete runtime toggle and full EXEC_BACKEND/fork runtime patches
remain outside the default lane.

When the full-PG experiment checkout exists locally, the source-spine guard
also compares the disposition manifest against the actual experiment patch
directory, so new experiment patches cannot appear without an explicit
embedded-runtime decision.

## Current Slice

The initial source-prep entrypoint is:

```sh
src/runtimes/liboliphaunt/wasix/assets/build/prepare_postgres_source.sh
```

It downloads or reuses the PostgreSQL 18.4 tarball, verifies the upstream
checksum, extracts into `target/oliphaunt-wasix/wasix-build`,
and applies the patch series in
`src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/series`.
The source-spine guard also requires that file to match the duplicate
`[patches].series` list in `postgres/source.toml`, so build metadata
and the applied patch order cannot drift silently.  It also rejects orphan
`.patch` files that are not listed in the series; source fingerprints and
applied patch contents must describe the same stack.  The guard also checks
that the stack remains reviewable: currently exactly 31 sequentially numbered
`oliphaunt-wasix` patches, each with a matching subject/filename slug, an
Oliphaunt maintainer header, and a short rationale before the diff.  When a
prepared PG18 source tree exists, xtask recomputes the source fingerprint from
the PostgreSQL tarball metadata, patch series file, and patch file hashes, then
compares both the source-tree marker and work-root marker against that value.
The same prepared-source verifier is used by PG18 source prep and build-output
discovery, so template/package/AOT commands do not accept a stale prepared
source tree.  If source prep uses an overridden PG18 work root, xtask verifies
the marker in that actual work root rather than the default target directory.
The same guard scans the PG18 patch stack, PG18 build scripts, Rust host loader,
prepared source tree, and generated PG18 manifests/AOT metadata for legacy
Oliphaunt ABI tokens such as `__OLIPHAUNT__`, `OLIPHAUNT_*`, `PGL_*`, and `pgl_*`.  PG17
and upstream Oliphaunt remain valid references, but the PG18 release lane must use
only `oliphaunt_wasix_*` and `OLIPHAUNT_WASM_*` names in runtime/build
surfaces.

The existing PG17.5 released build remains untouched.

## Build Entry Points

The PG18 WASIX backend has dedicated configure/backend entrypoints:

```sh
src/runtimes/liboliphaunt/wasix/assets/build/configure_wasix_dl.sh
src/runtimes/liboliphaunt/wasix/assets/build/docker_oliphaunt.sh
```

The PG18 configure script uses the new source-prep path and a smaller compile
profile than the released lane: it does not define `__OLIPHAUNT__` or
`OLIPHAUNT_WASIX_DL`, and it relies on the explicit host I/O hooks instead of
remapping `recv()`/`send()`.  It still uses the existing WASIX bridge for
runtime process, identity, shared-memory, and longjmp compatibility while those
areas are being replaced by smaller PostgreSQL patches.
The PG18 backend Docker entrypoint uses the same `source_lane.sh` helper as the
companion build scripts for its build directory and prepared source path, so the
backend and extension/tool stages do not drift onto different build roots.

The companion build scripts now default to the stable PostgreSQL source and
build tree:

```sh
  src/runtimes/liboliphaunt/wasix/assets/build/docker_runtime_support.sh
  src/runtimes/liboliphaunt/wasix/assets/build/docker_initdb.sh
  src/runtimes/liboliphaunt/wasix/assets/build/docker_pgdump.sh
  src/runtimes/liboliphaunt/wasix/assets/build/docker_pgxs_extensions.sh
  src/runtimes/liboliphaunt/wasix/assets/build/docker_contrib_extensions.sh
```

The standalone WASIX `initdb` build keeps explicit frontend-tool remaps for
process identity lookups and links the dedicated `oliphaunt_wasix_initdb_shim`.
The `pg_config_wasix.sh` helper is also source-marker aware. PG18 runs must
receive an explicit prepared `PGSRC`, so standalone PGXS invocations fail closed
instead of silently returning unrelated include paths. `PGSRC` must carry the
prepared-source PostgreSQL version and source-fingerprint markers, so an
arbitrary upstream checkout cannot masquerade as the patched source stack. The
helper exposes `--includedir-server` as the selected build tree's `src/include`,
which keeps direct extension Makefile calls on the same server-header surface
as the Docker PGXS wrapper.
That shim now covers the PG18 port surface used by `wasix-dl`, including
`getegid`, `getgid`, and `getpwuid_r`, so tool builds do not accidentally depend
on whichever subset WASIX libc happens to provide.

`cargo run -p xtask -- assets build` prints the
PG18 build spine, and adding `--execute` runs the PG18 backend script followed
by the same released-lane companion scripts against the PG18 build tree.

`assets fetch` and
`assets release-build --fetch` now skip only the
released `postgres-oliphaunt` backend checkout.  They still fetch the shared
non-backend source pins, then run
`src/runtimes/liboliphaunt/wasix/assets/build/prepare_postgres_source.sh` to
materialize the pinned PostgreSQL 18.4 tarball plus the PG18 patch stack.
`assets source-spine` uses the same PG18
source-spine guard instead of the released patch checkout guard; adding
`--check-patch-applies` materializes the pinned PG18 source tree and validates
the applied runtime, tool, contrib, and hot-path patch markers.  The PG18
source-spine command defaults to source-only validation; `--strict-local` also
requires the shared non-backend source checkouts to be present, clean, and pinned.

Once those outputs exist, `assets template` and
`assets package` discover the PG18 build tree,
derive manifest PostgreSQL versions from the prepared PG18 source markers, and
write explicit PG18 source-fingerprint and PG18 source pins into
generated asset manifests.  PG18 packaged asset discovery rejects manifests
whose fingerprint does not match the current PostgreSQL tarball plus patch
series hash.  Contrib extension control files are staged from the active
PostgreSQL source tree, not from the generated PG17 catalog metadata.  The
default path remains the released PG17.5 lane unless the source selection is
explicitly selected.

PG18 build outputs must also carry the same source fingerprint and PostgreSQL
version markers as the prepared source.  The backend Docker entrypoint stamps
those markers after configure, companion build stages fail closed if either
marker drifts, and xtask checks the markers again before packaging, template, or
build-output manifest generation can consume an existing build tree.

PGDATA template manifests produced by `assets template --source fingerprint ...` also
carry camelCase `sourceLane` metadata, and the asset manifest's
`pgdata-template` entry records the same lane.  PG18 templates also carry the
same source fingerprint as the runtime assets.  Older released templates without
those fields still parse as released-lane templates.

The source-spine guard also checks the prepared PG18 tree against the runtime
assets and promoted contrib build plan.  The required `plpgsql`,
`dict_snowball`, and timezone source inputs must be present; every promoted
contrib extension must have its PG18 `contrib/<name>` source directory and
Makefile; and CREATE EXTENSION entries must have the matching PG18 control file
plus at least one packaged extension SQL file.
When optional upstream discovery checkouts are absent, xtask falls back to the
committed generated extension build plan so this parity check can still run in
source-only worktrees.

The same guard validates the applied PG18 source tree, not just the patch files:
the prepared source must contain the host I/O Port hooks, startup packet export,
single-backend lifecycle exports, loop-pumped protocol exports, COPY handoff
reports, host-forced recovery fixes, portal abort cleanup, and the carried
WASIX-gated hot-path patches.

The source-controlled WASIX export list treats hybrid protocol switching as part
of the host/runtime ABI.  `pgl_set_protocol_transport` and
`pgl_protocol_stream_active` are exported alongside the older buffered protocol
helpers so COPY streaming cannot silently disappear from a PG18 build.
The source-only guards also compare the Rust host's loaded runtime symbols with
the WASIX runtime export validator and the PG18 PostgreSQL-side
`OLIPHAUNT_WASM_HOST_EXPORT` declarations, so host ABI drift fails before a
build artifact is packaged.

The same selector is also accepted by `assets release-build`, `assets aot`,
`assets package-aot`, `assets check-aot`, and `assets export-list`, but PG18
PG18 WASIX is now the default stable runtime. Build-output manifests remain
stamped under the PG18 build tree at
`target/oliphaunt-wasix/wasix-build/build/outputs.json`, with
the old stable manifest path accepted only as a compatibility fallback during
local discovery.

Portable assets now write to the stable generated directory
`target/oliphaunt-wasix/assets`. AOT intermediates remain under
`target/oliphaunt-wasix/wasix-build/build/aot`, while packaged
AOT outputs write to the stable generated directory
`target/oliphaunt-wasix/aot`. Packaged AOT manifests carry explicit
`source fingerprint`, source-fingerprint, and `postgres-version` metadata, and
`assets check-aot` verifies those fields before checking module hashes.

The Rust asset parser preserves the same source-fingerprint metadata that xtask
writes into PG18 asset manifests. Embedded PGDATA template manifests must match
the top-level asset manifest fingerprint, and bundled AOT manifests must match
the same fingerprint and PostgreSQL version before their module hashes are
accepted. The `oliphaunt-wasix-assets` build script probes
`target/oliphaunt-wasix/assets` plus the publishable payload unless
`OLIPHAUNT_WASM_GENERATED_ASSETS_DIR` explicitly overrides the asset directory.
Any selected PG18 manifest must carry a non-empty source-fingerprint plus a
PostgreSQL 18 runtime version before embedding.

Runtime reuse has the same fail-closed stance.  A full-local runtime root is
only reused when its saved runtime source key matches the currently embedded
runtime archive key; otherwise the runtime archive is reinstalled before use.
Existing PGDATA roots are also checked against the current runtime PostgreSQL
major version before they are accepted, including overlay PGDATA manifests.  A
PG17 root must fail with an explicit migration/separate-root error under the
PG18 lane instead of being paired with PG18 binaries.

Crate package-size enforcement is deliberately released-lane only for now.  The
PG18 lane writes experimental generated assets under ignored target paths; it is
not staged into the publishable `oliphaunt-wasix-assets/payload` and AOT crate
`artifacts` directories.  Therefore `assets release-build --source fingerprint
stable` must use `--skip-package-size` until PG18 gets a dedicated
release-staging path; otherwise xtask fails instead of silently measuring the
released PG17 crate payload.

Perf reports now carry WASIX runtime asset provenance when the measured engine
is the bundled WASIX runtime.  The JSON field is `wasixRuntimeAssets` and
records the asset source selection, PostgreSQL version, optional PG18 source
fingerprint, and PGDATA-template lane/fingerprint/version.  Native PostgreSQL,
SQLite, native liboliphaunt, and Node Oliphaunt controls omit the field.  This
keeps future PG18-versus-released-lane benchmark reports self-identifying even
when both lanes can be built from the same xtask binary.

`assets check` and `assets verify-committed` now include a source-fingerprint isolation
guard.  It proves the released and PG18 build manifests, portable asset
directories, and AOT directories are distinct; it also checks that public
download, local install, and release bundle paths still target the released
PG17.5 lane, and that package-size enforcement does not silently fall back to
the released crate lane for a PG18 release-build.  The same guard checks that
PG18 fetch/release-build preflight skips the released backend source pin and
uses the tarball source-prep script instead.  PG18-owned source-prep, configure,
and backend Docker scripts are also source-guarded against released checkout
paths, the released `postgres-oliphaunt` source name, the generated PG17 patched
source root, and the old `__OLIPHAUNT__`/`OLIPHAUNT_WASIX_DL` export macro style.
Generated asset manifest
validation also checks the manifest `source fingerprint` field when a lane is selected,
so PG18 packaged assets cannot pass as released-lane assets by version inference
alone.  Build-output manifests carry the same PG18 source fingerprint and are
ignored by export-list generation if the fingerprint no longer matches the
current source stack; PG18 build-output manifest module paths must also stay
under the PG18 build root instead of the released build root.

Promoted extension packaging is also fail-closed.  PostgreSQL contrib and PGXS
style extensions are lane-scoped through the selected build directory.  The PG18
source-spine guard verifies that promoted PGXS source directories stay under
shared `target/oliphaunt-sources/checkouts/*` pins instead of the released backend checkout, that
each source directory is represented in `src/sources/third-party/**`, and, when the
checkout is present, that packaging-visible Makefile/control/SQL inputs exist.
PG18 asset manifests derive extension `control-files` from the packaged
extension archive contents, so contrib metadata cannot leak released
`postgres-oliphaunt/contrib` source paths into a PG18 manifest.
PostGIS remains `build = false` until there is a dedicated WASIX geospatial
dependency stack and lane-scoped PostGIS builder.  If PostGIS is promoted before
that work lands, xtask must fail early instead of pointing at the released
`postgres-oliphaunt/oliphaunt/other_extensions` artifact tree.

## Verification Status

This slice has moved beyond source-only verification.  The PG18 source spine,
backend build path, non-timing runtime artifact, AOT/package metadata, and
focused speed probes for the indexed-update misses have all been exercised.
The current perf package is still core-only because external PGXS extensions
were skipped with `OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1`; full extension
release packaging remains a promotion blocker.

Verified locally:

- PostgreSQL 18.4 source preparation reuses or downloads the pinned tarball,
  checks the upstream checksum, and applies patches 0001 through 0031 cleanly.
  Cached prepared sources are rebuilt if patch backup/reject files are present,
  and a prepared tree containing `.orig` or `.rej` artifacts is rejected.  The
  prepared source and work-root fingerprint markers must also match the current
  tarball metadata and patch stack hash.
- The PG18 patch stack is source-guarded for review hygiene: sequential patch
  numbering, Oliphaunt subjects matching filenames, maintainer headers, rationale
  text, and no TODO/FIXME placeholders.
- The prepared PG18 source contains the standalone `initdb` and `pg_dump` source
  files, the released-lane runtime-support inputs for `plpgsql`, `dict_snowball`,
  and timezones, plus every promoted contrib source/control input required by
  the generated extension build plan.  CREATE EXTENSION contrib entries also
  have root extension SQL files available for packaging.  Unsupported promoted
  builders such as PostGIS are rejected until they have a dedicated PG18 WASIX
  build path.  Promoted PGXS extensions are checked for lane-neutral pinned
  source directories and, when local checkouts exist, Makefile/control/SQL
  packaging inputs.  The PGXS `pg_config_wasix.sh` helper is source-marker aware
  and rejects PG18 use without an explicit prepared-source path and source
  fingerprint markers.  Extension build metadata and extension manifest metadata
  both fall back to the generated build plan when upstream Oliphaunt discovery
  inputs are absent, so PG18 packaging does not need live released-lane discovery
  files just to recover lifecycle/dependency metadata.  PG18 extension manifest
  control-file metadata is derived from packaged archive contents rather than
  released-lane source paths.
- The applied PG18 source contains the expected embedded runtime ABI hooks and
  the currently carried performance/tool patches, including hash load folding,
  top-XID lookup short-circuiting, btree int4 comparison and delete scratch
  paths, and pg_dump helper renaming.
- The source-controlled WASIX export list includes the Rust host's required
  lifecycle, protocol, buffered I/O, and hybrid streaming symbols.
- The Rust WASIX host loader, runtime export validator, and PG18 PostgreSQL
  host-export patch surface are checked together so required runtime symbols do
  not silently drift between layers.
- `assets check` validates the PG18 WASIX source-spine guard and the Rust
  startup ABI boundary in
  source-only mode.  It also runs `bash -n` over the WASIX build shell scripts,
  including the PG18 source-prep and backend entrypoint scripts.
- `assets verify-committed` additionally validates the source-fingerprint isolation
  guard and the source-controlled WASIX export list.
- Generated asset manifests now carry explicit `source fingerprint` metadata and a
  source fingerprint that must match the current PG18 tarball plus patch stack.
- Existing PG18 build trees are accepted only when their stamped source
  fingerprint and PostgreSQL version markers match the prepared source.
- Packaged AOT manifests now carry explicit `source fingerprint`, `postgres-version`,
  and source-fingerprint metadata.
- PGDATA template manifests and asset-manifest `pgdata-template` entries now
  carry lane metadata as well, plus PG18 source fingerprints for experimental
  PG18 templates.
- Runtime asset parsing preserves PG18 source fingerprints, and embedded PGDATA
  template/AOT manifests are checked against the bundled asset manifest before
  use.
- WASIX perf reports include bundled runtime asset provenance, so benchmark JSON
  identifies the measured source selection, PostgreSQL version, and PG18 source
  fingerprint before the numbers are compared.
- Unit coverage checks that PG18 extension manifests use packaged control files
  and reject released-lane path leaks; the legacy PG17 source selection is no longer
  selectable.
- The asset crate build script is source-marker aware: selected manifests are
  checked against the requested lane before embedding.
- Public release-asset bundling now validates PG18/stable portable and AOT
  manifests before writing public release archives. The download/install path
  performs the same checks on downloaded portable and AOT manifests before
  copying them into canonical generated asset directories.
- `assets build` emits the PG18 lane build
  commands without executing them; plain `assets build` selects the same PG18
  stable lane.
- `assets fetch` and release-build `--fetch`
  prepare the pinned PG18 tarball source instead of fetching the released
  `postgres-oliphaunt` backend checkout.
- `assets source-spine` validates the PG18
  source-spine guard; its `--check-patch-applies` path goes through the PG18
  tarball source-prep script, and `--strict-local` additionally checks shared
  non-backend source checkout pins.
- The PG18 source-spine guard rejects released PG17/Oliphaunt checkout markers in
  the PG18 patch stack and PG18-owned build scripts.
- `assets source-spine --check-patch-applies`
  passes against the prepared PostgreSQL 18.4 source tree in source-only mode.
- `assets source-spine` passes after the
  37-patch stack, including the PG18 source-spine guard and source fingerprint
  isolation guard.
- `assets release-build --skip-build --skip-aot
  --skip-package-size` regenerates the PG18 asset manifest, and the regenerated
  source pins contain the PostgreSQL 18.4 tarball plus PG18 patch-series
  fingerprint rather than released-lane backend provenance.
- `assets release-build` carries source-fingerprint
  validation through its package-size step; without `--skip-package-size` it now
  fails explicitly because PG18 is not staged into publishable crates yet.
- `cargo check -p xtask` passes for the current edited
  xtask surface.  Earlier `cargo check -p xtask --all-features` coverage passed
  for the feature-gated packaging/AOT/perf code paths.
- Full server-SQLx evidence after the accepted `0036` O2 artifact is in
  `target/perf/pg18-wasix-core-release-o2-36patch-skip-activity-id-release-host-speed-server-sqlx.json`
  plus its two reruns.  The three-run median is `0.759x` same-host PG17.5
  geomean and `0.826x` documented PG17.5 geomean; PG18 is faster than both
  baselines on every speed-test head.
- Shell syntax, the C bridge/initdb shim ABI harnesses, and the PG18 `wasix-dl`
  port header syntax pass local static checks.

Remaining promotion blockers are full extension/tool release packaging parity
and runtime protocol compatibility for the tokio-postgres prepared server path.
Strict speed-suite parity against both same-host PG17.5 and the documented
PG17.5 release table is now green on the current three-run median.
