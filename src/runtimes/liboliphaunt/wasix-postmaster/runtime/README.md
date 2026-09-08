# Patched WASIX postmaster runtime

This subtree builds the host runtime for
`liboliphaunt-wasix-postmaster`. Repository-pinned Wasmer and wasix-libc inputs
are copied into disposable worktrees, patched, tested, and built into a
compiler-bearing producer plus a compiler-free product executor.

Tracked product inputs are:

- `patches/wasmer/series` and its ordered members;
- `patches/wasix-libc/series` and its ordered members;
- the current contract inventory in `capabilities.tsv`;
- focused capability fixtures under `probes/`;
- preparation, build, verification, and qualification entrypoints under `bin/`.

Immutable upstream checkouts live under
`target/oliphaunt-sources/checkouts/`. Patched worktrees, sysroots, build
outputs, caches, and reports live under
`target/oliphaunt-wasix-postmaster/runtime/` and are never patched into the
source checkout.

`build-runtime.sh` produces a Wasmer build receipt and a separate product
executor receipt. Together they bind source pins, patch digests, prepared-tree
identities, Cargo.lock, sysroot manifests, compiler/executor features, host ABI,
Rust and LLVM versions, artifact ABI, runtime ABI, CPU policy, and binary
hashes. Runtime selection never falls back to a stock or `PATH` Wasmer.

The historical `wasmer_patch_sha256`, `wasix_libc_patch_sha256` and
`source_patch_sha256` receipt fields now identify the ordered series: a
NUL-delimited hash of the series file and every member's name/content hash.
Changing a member, order or rationale invalidates old receipts. The source lock
separately records the series file and every member in order. It rejects
unlisted, duplicate, missing and symlinked patches. No generated monolithic
patch is committed or used as another source of truth.

## Runtime patch review boundaries

Each patch contains its motivation and dependency caveats. Whole-file diffs
were moved unchanged from the inherited bundles; the complete series remains
the compilation/qualification unit. The logical groups are not a claim that
every intermediate tree compiles or that a large integration slice is ready
to submit upstream unchanged.

| Wasmer order | Responsibility |
| --- | --- |
| 0001 | Engine, VM, compiler and public API memory/code/exception lifetimes |
| 0002 | Virtual filesystem descriptions, host writeback and durability |
| 0003 | Virtual I/O and network selector/readiness ownership |
| 0004 | WASIX descriptors, offsets, mapping and filesystem syscalls |
| 0005 | Process/thread creation, exec, wait/reap, signals and futex lifetimes |
| 0006 | WASIX sockets, poll and epoll readiness |
| 0007 | Instance/environment/linker, preinitialized memory and sealed runtime integration |
| 0008 | Oliphaunt-specific sealed executor/compiler and CLI/dependency closure |
| 0009 | Separate correctness delta: strict shared-memory compilation in product and CLI routes |

| libc order | Responsibility |
| --- | --- |
| 0001 | mmap writeback and allocator/exec ownership |
| 0002 | File flags and sync-range ABI/tests |
| 0003 | Socket and epoll flags |
| 0004 | Process, wait, signal and futex semantics |
| 0005 | Caller-owned EH signal-jump context |
| 0006 | Process resource-limit ABI and expected symbols |
| 0007 | Isolated inherited word-at-a-time memcmp optimization |
| 0008 | Separate correctness delta: single evaluation of the EH signal jump buffer |

Both original bundles and the decomposed Wasmer 0001-0008/libc 0001-0007 series were applied with
`git apply --index --whitespace=error-all` to the pinned upstream commits.
The complete Git index trees matched exactly:

- Wasmer `1d1b3420beef28550afbb4692b664bd7f6bc2581`:
  `9406356be467cf90570dff80bf205eeb496a6692`.
- wasix-libc `34178a6272804f90448b5bd08dc7bcf0d85438e3`:
  `4480978c85aec6ec6e6392f5b95e3a7c223b725b`.

This proves source equivalence for the decomposition, not new concurrency or
crash-durability results. Wasmer 0009 is a separate correctness change after
that proof: the product compiler/verifier and both general CLI LLVM routes now
select `non_volatile_memops(false)` because concurrent Postmaster shares guest
memory. The existing CLI disable option remains accepted as a hidden no-op;
there is no opt-in environment flag. Compiler identity tests require `nv0` and
distinguish the previous `nv1` configuration.

The ordered-series digest feeds the prepared-tree signature, runtime ABI and
runtime/compiler receipts. The AOT cache is additionally rooted in the compiler
binary hash, and sealed carriers bind that producer and runtime ABI. Therefore
the new compiler/runtime and their AOT carriers must be rebuilt; old receipts
are not proof of this corrected profile. The headless consumer cannot compile
and remains bound to the new runtime ABI. No strict-profile performance or
concurrent-runtime result is inferred from the source-equivalence proof.
Applying 0009 after either equivalent source tree yields
`fa9663dac062e8e8f05868c8a90030d5d22dbdc6` with strict whitespace checking.

Libc 0008 separately fixes the inherited `sigsetjmp` buffer-expression double
evaluation. Its pointer-returning preparation helper leaves `setjmp` in the
live caller's controlling expression; libc and callers must be rebuilt together.
The C/C++ host adapter checks argument evaluation, zero/nonzero jump values and
mask helper behavior against the host's actual mask implementation. The real-Wasm
probe checks jumps and evaluation only: **guest signal masks remain unsupported**.
Pinned WASIX `pthread_sigmask` returns success without changing or querying a
mask; `sigpending` returns `EINVAL`, and `__wasm_signal` ignores `sa_mask`.
Neither libc 0005's helper hooks nor child-wait/signal support repair this.

This is a high-priority inherited Postmaster limitation, not a performance knob.
Correct masking needs a WASIX mask/pending-signal ABI, per-thread blocked/pending
state in Wasmer, deferred delivery and wakeup on unblocking, and libc bindings
including handler `sa_mask`/`SA_NODEFER` behavior and saved-mask restoration.
PostgreSQL interrupt, error-unwind, startup and child-management stress must then
validate the result. A libc-only remembered mask would falsely claim protection
while Wasmer still delivers blocked signals, so is not a valid remediation.
Concrete PostgreSQL consumers are `quickdie()` (prevent nested `SIGQUIT`),
`PostgresMain()`'s saved-mask error boundary, postmaster startup block/unblock,
`fork_process()`'s child-creation mask and `dsm_impl_posix()`'s mapping critical
section. Background writer, WAL writer, checkpointer and autovacuum recovery
boundaries also request saved masks. These dependencies justify the priority;
this audit has not demonstrated a particular signal race or data corruption.

The inherited memcmp has bounded, alias-safe loads and only calls `ctz` on a
nonzero XOR; little-endian byte selection preserves the unsigned-byte ordering.
This correctness review does not establish independent performance benefit or
non-GNU compiler portability (the load helpers use GNU-compatible builtins).
The focused O0/O2 host check covers independent alignments, every first differing
byte, high-bit ordering and protected-page ends without changing the algorithm.

The product executor accepts only an independently verified sealed carrier. It
does not expose the general Wasmer package, registry, network, or compilation
command graph. AOT production uses an explicit generic CPU baseline; native CPU
tuning is rejected for release carriers.

## Upstream status (checked 2026-09-07)

Wasmer [6962](https://github.com/wasmerio/wasmer/pull/6962) adds the conservative
data-only sync API; [6963](https://github.com/wasmerio/wasmer/pull/6963) fixes
final-handle shutdown independently. Both remain open and require maintainer
review (no review submitted, 54 successful checks and 5 skipped checks each).
Their CI is evidence for those small submissions, not for this Postmaster
bundle. No reminder comments or new upstream submissions were sent during this
decomposition. Larger runtime slices still need independently reviewable
upstream reproducers and dependency separation before submission.

Hosted Postmaster job
[101874255096](https://github.com/f0rr0/oliphaunt/actions/runs/34164967620/job/101874255096)
succeeded at the previous exact commit `34f173f686346d42ac113f5d1184b51ccc642f7c`.
That run does not qualify the subsequent series-consumer changes or strict
compiler patch; their runtime compiler tests must run on the new commit.

Locally, the complete Postmaster source/shell unit command passed, followed by
freshly compiled `product_compiler_uses_strict_memory_identity` and
`backend::tests::llvm_cli_routes_use_strict_memory_identity` tests. Both used
the strict applied source tree above, LLVM 22, two Cargo workers, no debug info
and no incremental compilation. The CLI test exercises both compiler routes
and accepts the old disable option; the product test distinguishes `nv0` from
`nv1`. These focused checks do not replace a new sealed-carrier/concurrent SQL
qualification under the corrected compiler profile.

From the repository root:

```sh
moon run source-inputs:source-fetch-wasix-postmaster-runtime
moon run liboliphaunt-wasix-postmaster:prepare-runtime
moon run liboliphaunt-wasix-postmaster:runtime-build
moon run liboliphaunt-wasix-postmaster:runtime-patch-tests
moon run liboliphaunt-wasix-postmaster:runtime-capabilities
```

The architectural and operational rationale is maintained in
`docs/maintainers/wasix-postmaster.md`.
