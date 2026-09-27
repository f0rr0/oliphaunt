# Wasmer 7.4.2 / WASIX 0.704.2: focused integration screen

Date: 2026-09-27. Decision: **worth the next Linux/macOS integration trial;
not ready to replace the production pins**. No production dependency or
artifact identity was changed by this experiment.

## What actually ran

Linux x86_64, Rust `1.95.0 (59807616e 2026-04-14)`, LLVM `22.1.8`.
The isolated Cargo project pins Wasmer `=7.4.2` and WASIX `=0.704.2`.
Its lock resolves the engine family entirely to 7.4.2 and the WASIX/virtual
filesystem/network family entirely to 0.704.2; `webc` resolves to 12.0.1.
Production currently pins `webc =12.0.0`, so this is not an exact production
dependency-closure proof.

| Check | Result |
| --- | --- |
| LLVM scalar guest call | PASS, returns 42 |
| LLVM serialization, deserialization into a separate headless engine, guest-local throw/catch | PASS, 1,000 recovered calls |
| Shared memory growth, host callback writing the new page, guest reading it | PASS |
| WASIX runtime/task-manager builder and actual WASI `random_get` import | PASS |
| Ported `task_policy.rs`, compiled directly without adaptation | 3 tests PASS |
| Current `sync_host_fs.rs`, compiled directly without adaptation | 4 tests PASS |

The task-policy tests cover rejecting guest execution/fork paths and allowing
host asynchronous work. The filesystem tests cover seek position, cloned-handle
positional I/O, external growth/truncation and nonregular-file fallback. They do
not test every filesystem method or prove crash durability.

Cold dependency compilation took 1m41s. Later checks reused it and took seconds.
The retained project occupies about 2.5 GiB including debug compiler outputs;
no PostgreSQL producer tree was duplicated. These timings are build observations,
**not query-performance measurements**.

## Re-run locally

Retained project: `/home/sid/dev/wasmer-engine-probe-20260927-6y8hZ8`.
It contains `Cargo.toml`, `Cargo.lock`, `src/main.rs`, `build.log`, `run.log`,
`test.log` and reusable build outputs. Its two `#[path]` modules intentionally
compile the real SDK files in the refresh worktree rather than copied substitutes.

```sh
rtk proxy env LLVM_SYS_221_PREFIX=/usr/lib/llvm-22 CARGO_BUILD_JOBS=4 \
  cargo +1.95 run --locked \
  --manifest-path /home/sid/dev/wasmer-engine-probe-20260927-6y8hZ8/Cargo.toml
rtk proxy env LLVM_SYS_221_PREFIX=/usr/lib/llvm-22 CARGO_BUILD_JOBS=4 \
  cargo +1.95 test --locked \
  --manifest-path /home/sid/dev/wasmer-engine-probe-20260927-6y8hZ8/Cargo.toml
```

Refresh worktree base: `df2b112e866f8ea76d320d7b3e172cf7be764177`, with the
in-progress correctness port. Tested file SHA-256 identities:

```text
82fff91ec8c0f52d598bbc59c44d026ccf2ebd62d1a042dfec72506c311a6e3f  task_policy.rs
22a5a2b8a4206a7ba9376952568a3b9416465ecb04bccc5af101617d2bf512da  sync_host_fs.rs
09784c9a8f6f52e157c90eecfd57aa48eb30567b8caa5aa9d384df361b8e244a  probe/src/main.rs
3e989e67ef7811c168bfaba8a73d7dd9c76f75b11fc9753857df7ff25193ddcc  probe/Cargo.lock
```

No qualification workflow or exact-commit release gate was dispatched.
Warnings from unused production functions are expected in this partial probe.

## Migration map and limits

1. **Raise the coordinated Rust toolchain floor to 1.95.** The engine upgrade
   cannot be a dependency-string-only change. Update the entire constrained
   Wasmer/WASIX family together, not just `wasmer`.
2. **Rebuild AOT with the new engine and change the identities together.** The
   serializer and SDK loader currently encode 7.2.1/0.702.1. This probe only
   deserializes artifacts it just generated with the same 7.4.2 engine. It does
   not attempt unsafe reuse of older PostgreSQL AOT.
3. **Keep strict memory operations.** The 7.4.2 LLVM configuration still defaults
   `enable_non_volatile_memops` to false and explicitly calls the optimization
   not fully specification-compliant. This experiment did not enable it.
4. **The memory API changed.** `MemoryStyle::Static` is now a unit variant and
   reserves 8 GiB plus one page of virtual address space (4 GiB guest address
   space plus an offset guard). That is not 8 GiB of immediately resident RAM.
   Our directly tested host modules did not need custom memory-style changes;
   downstream code that constructed the old variant does.
5. **Do not infer stack safety or Windows support.** The released API has no
   cooperative execution-stack headroom query. Its MSVC exception implementation
   still contains panic stubs. The passing Linux throw/catch test does not cover
   near-exhausted execution stacks, nested host re-entry, terminal traps or MSVC.

The complete SDK, extensions, PostgreSQL guest, N-API, browser, macOS and Windows
were not built in this screen. No speedup or nonregression is claimed.

## Upstream status and smallest next step

- [7.4.2 release](https://github.com/wasmerio/wasmer/releases/tag/v7.4.2)
  improves libunwind detection. The intervening releases include LLVM
  indirect-call correctness and store-context changes; these motivate testing,
  not an assumed performance win.
- [Memory-style source](https://github.com/wasmerio/wasmer/blob/v7.4.2/lib/types/src/memory.rs)
  defines the new reservation contract.
- [LLVM configuration](https://github.com/wasmerio/wasmer/blob/v7.4.2/lib/compiler-llvm/src/config.rs)
  retains the nonvolatile-operation caveat.
- [Execution-stack issue #6994](https://github.com/wasmerio/wasmer/issues/6994)
  remains open. [EH guard PR #6913](https://github.com/wasmerio/wasmer/pull/6913)
  remains unmerged; emergency guard behavior is not PostgreSQL cooperative recovery.

Next, use a separate engine-upgrade branch to compile the **complete SDK** and
rebuild one representative Linux AOT guest. Run recovered SQL errors, rollback
and reuse, shared-memory host calls, and memory/directory workloads against the
correctness-port baseline. Stop if the platform/backend contract cannot be met;
do not mix engine-upgrade repairs into the correctness consolidation merely
because the small probes pass.
