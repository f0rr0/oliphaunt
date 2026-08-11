# Patched WASIX runtime build

This subtree owns the runtime half of `liboliphaunt-wasix-postmaster`. It turns
repository-pinned Wasmer and wasix-libc inputs into one exact local runtime
build plus a canonical provenance receipt for the PostgreSQL `EXEC_BACKEND`
process model. It does not change the runtime used by the existing
`liboliphaunt-wasix` product. It produces a local research runtime build, not a
self-contained, signed, or distributable host carrier.

## Source and generated boundaries

Tracked inputs live here:

- `patches/wasmer/0001-postgres-wasix-blockers.patch`
- `patches/wasix-libc/0001-postgres-wasix-blockers.patch`
- `capabilities.tsv`
- focused C probes under `probes/`
- reproducible preparation, build, and probe entrypoints under `bin/`

Capability source references use explicit roots: `wasmer:`, `wasix-libc:`,
`project:` for this research project, and `repo:` for repository-owned
maintainer evidence.

Immutable upstream checkouts are materialized by the repository source spine
under `target/oliphaunt-sources/checkouts/`. Patched worktrees, compiler
outputs, libc carriers, runtime caches, and reports are generated only below
`target/oliphaunt-wasix-postmaster/runtime/` and remain untracked.

`build-runtime.sh` writes
`target/oliphaunt-wasix-postmaster/runtime/build/wasmer-build.receipt`. Its
`oliphaunt.wasix-postmaster.wasmer-build.v2` fields bind all Wasmer/gitlink and
wasix-libc pins, tracked patch digests, recomputed prepared-worktree state,
Wasmer `Cargo.lock`, the exact libc carrier/variant manifests, build features,
host OS/architecture/ABI, Rust and LLVM versions, the compiler and headless
release binary hashes, and a compile-time runtime ABI identity. The same ABI
identity binds source pins, `Cargo.lock`, native target, host ABI, producer and
executor features, artifact ABI, and the tracked build recipe; a headless
executor therefore rejects AOT bytes from a merely similar runtime build.
The current source uses the `runtime-build-recipe.v3` builder-identity
contract. A current-source receipt or carrier is admitted only when generated
and validated by this build; identities in historical evidence documents are
never current build output. The canonical current Wasmer patch is
2,255,905 bytes with SHA-256
`4a164cad0ec19dbe29cf0fe3f37e94b9f2ee9f887252b74a8eeecd6dfc41e333`.
The builder validates every input immediately before publishing the receipt;
runtime selection validates the receipt shape, expected pins/patches, host ABI,
features, and binary hash. It does not silently select a stock, downloaded, or
`PATH` Wasmer.

The runtime build also compiles the workspace package
`oliphaunt-wasix-postmaster-executor` in its own Cargo target directory with
exactly the internal `product-executor` feature. Its separate canonical
`postmaster-executor-build.receipt` binds the parent Wasmer receipt and the
executor package, feature, runtime-policy, CLI, host, and binary identities.
This keeps the compiler-bearing producer and general `wasmer-headless` control
intact while giving embedded carriers a native executable that does not retain
unrelated Wasmer CLI/package/registry roots.

The generated libc carrier contains only the selected EH/PIC variants. Its
carrier and variant manifests bind the source pins, patch digest, toolchain
image, build parameters, archives, and headers. Consumers select one exact
variant (`sysroot-exnref-ehpic` by default) and validation fails closed on a
missing, stale, stock, or tampered sysroot.

## Rebuild and qualification

From the repository root, first fetch the pinned source inputs, then run:

```sh
src/runtimes/liboliphaunt/wasix-postmaster/runtime/bin/prepare-upstream-checkouts.sh
src/runtimes/liboliphaunt/wasix-postmaster/runtime/bin/build-runtime.sh
src/runtimes/liboliphaunt/wasix-postmaster/runtime/bin/run-exec-backend-probes.sh
```

`build-runtime.sh` records code grounding, runs the focused Wasmer fixed-map
and shared-mapping tests plus the sealed-loader/headless-stack tests with
`Cargo.lock` enforced, builds both the LLVM producer and compiler-free
headless control plus the isolated postmaster executor for a controlled native
target, constructs or validates the exact libc carrier, and atomically emits
and immediately validates both native build receipts.
`run-exec-backend-probes.sh` is the supported capability gate. It names only
the 23 probes needed by the fresh-process backend topology and runs them in
strict mode, including the read-only PostgreSQL range-writeback path through
the versioned product import.

The runtime also owns the first-stage semantic file-cache offer plane. The
pointer-free `oliphaunt_postmaster_v1.fd_cache_offer` and `fd_cache_revoke`
imports validate exact signed ranges, stable PostgreSQL classes, flags,
`FD_ADVISE`, descriptor kind, and host backing before delegating to an optional
runtime-global controller.
Completed durable WAL remains observable as class 6, but only PostgreSQL's
positive bit-1 `WAL_CACHE_DROP_SAFE` proof can make a complete segment
actionable; flags-zero and legacy bit-0-only WAL are retained, including offers
from older guests. Bit 0 remains only the narrower low-expected-reuse fact.
The sealed research runtime installs one controller shared by every fresh EXEC_BACKEND
environment. It always mirrors offers into the stable observe-only stream.
For the exact `runtime:postgres` role on Linux, it may additionally admit the
manifest-bound adaptive-linux.v5/embedded-v4 candidate after proving a finite descriptor-pinned
cgroup-v2 pressure source and a Tokio maintenance runtime. `runtime:initdb`,
other platforms, and failed admission remain observe-only. Exact bit-1 whole
WAL segments enter a four-entry/four-descriptor/64 MiB/four-second ledger; only
one entry may act after a fresh 250 ms L2/L3 sample. Every first payload write
synchronously revokes the exact descriptor identity, and terminal evidence
requires zero capabilities plus exact entry/byte conservation. Relation offers
remain observe-only in this profile. An explicitly
configured absolute
`OLIPHAUNT_WASIX_CACHE_OFFER_TELEMETRY_FILE` is published atomically at workload
completion. The acting lane retains no paths or guest-visible raw descriptors,
owns only generation-checked host capabilities, and bounds all kernel work;
see the
[semantic cache-offer notes](../../../../../docs/internal/wasix-postmaster/semantic-cache-offers.md).

## Process-model boundary

Each PostgreSQL backend starts in a fresh Wasmer instance with private linear
memory. Only PostgreSQL's explicit file-backed shared mappings are replayed at
their original guest addresses. This avoids treating all guest memory and
runtime-owned process state as fork-shared state.

An earlier imported experiment cloned a backend's complete private runtime
state. It trapped before PostgreSQL server readiness and consumed roughly
160 MiB per child. That prototype, its compiler-continuation machinery, and
its probes are excluded from canonical source and qualification. The supported
topology has no full-state-cloning fallback.

`../bin/build-sealed-headless-carrier.sh` consumes that receipt, an already
precompiled generic LLVM AOT bucket, and a PostgreSQL WASIX prefix. It fails
closed instead of compiling, validates every code/artifact identity, exercises
the checked mmap loader before publication, and atomically emits a standalone
prefix with `bin`, `lib`, `share/postgresql`, `aot`, deterministic post-start
memory images and receipts, strict format-3 `manifest.json`, canonical receipt,
and a hash-and-size `payload.files` inventory. Each executable image is captured
twice in independent stores and both bytes and receipts must agree. Publication
normalizes every carrier directory to `0555` and every regular file to `0444`
or `0555`, preserving host executability while making the complete deployment
root read-only. The verifier rejects writable entries; ephemeral loader
snapshots belong in a separate scratch tier and never mutate the carrier.
By default the postmaster executor alone is copied to `bin/wasmer-headless` and
its build receipt is copied byte-for-byte as `postmaster-executor.receipt`.
`--executor-role full-headless` preserves the prior control carrier without the
sidecar. No carrier contains both native executors.

See the [architecture notes](../../../../../docs/internal/wasix-postmaster/architecture.md)
for the sealed-carrier/platform design and the
[replay status](../../../../../docs/internal/wasix-postmaster/replay-status.md)
for historical measured evidence and the explicit non-release support boundary.
