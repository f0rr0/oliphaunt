# Wasmer 7.5 native V8: Windows feasibility experiment

This is a standalone Rust embedding probe for [Windows issue #208](https://github.com/f0rr0/oliphaunt/issues/208), using the dependency generation in [upgrade PR #247](https://github.com/f0rr0/oliphaunt/pull/247). It does not modify the production SDK, its Cargo patches, PostgreSQL build, release artifacts or supported-platform claims.

## Decision status

Windows execution is pending. The Linux control demonstrates that native V8 can handle guest exceptions, traps followed by continued execution, module caching, shared memory and basic WASIX imports. It also exposes unfinished host exception APIs, missing host atomic wake/shutdown operations, unsupported Wasmer async calls and process aborts on Rust callback panics. These are recorded as failures even when the core capability suite passes.

Do not interpret a green experiment workflow as Windows PostgreSQL qualification. The workflow distinguishes required capability probes from deliberately exercised diagnostics. The evidence files preserve both categories.

## Why this experiment exists

- Wasmer 7.2.1 compiled Windows AOT artifacts but aborted during SQL error recovery in its unimplemented MSVC exception runtime. [Failing job](https://github.com/f0rr0/oliphaunt/actions/runs/34172865750/job/101905963703).
- [Wasmer PR #6826](https://github.com/wasmerio/wasmer/pull/6826), merged August 6, 2026, dropped Windows support for the Sys compiler backends: LLVM, Cranelift and Singlepass. This change first shipped in 7.3.0; 7.5.0 did not introduce the policy.
- The 7.5 upgrade fails before runtime when Windows compiles LLVM. [Failing 7.5 build](https://github.com/f0rr0/oliphaunt/actions/runs/37225721762/job/111514964297). The compiler directs Windows consumers to V8.
- Wasmer's V8 backend embeds a separate native V8 library through Rust. It is distinct from the JavaScript-host backend and does not automatically reuse Node's V8 isolate. Existing Rust and N-API public APIs can potentially remain, but engine internals and artifacts require work.

## Exact inputs and evidence contract

| Input | Value |
| --- | --- |
| Repository base | `410e5dcb861b7a4110520a115e9e5d0262284ad3` |
| Wasmer | crates.io `=7.5.0`, defaults disabled, `v8` and `wat` |
| WASIX | crates.io `=0.705.0`, defaults disabled, `sys-default` and `v8` |
| Rust | `1.96.0`; native MSVC on Windows |
| V8 distribution | Wasmer's Wee8 `11.9.7`, fetched by Wasmer's build script |
| Hosted controls | `ubuntu-24.04`, `windows-2025-vs2026` |
| Dependency resolution | committed standalone `Cargo.lock`, `--locked` |

The WASIX feature set brings in the headless Sys machinery as an upstream dependency. Every execution store is explicitly constructed with `wasmer::v8::V8::new()`. No LLVM, Cranelift or Singlepass compiler backend is selected. The V8-only `store_send` example is checked separately without the WASIX feature.

The workflow records the source SHA, run ID, actual runner image revision, Rust compiler details, executable size/hash and downloaded Wee8 archive size/hash. Each case runs in a separate process with a 45-second timeout. An abort cannot hide later cases. Raw stdout/stderr and structured results are uploaded even on failure. Cache read runs in a fresh process after cache write and is blocked if cache write failed.

## Capability coverage

| Case | What it establishes |
| --- | --- |
| `basic` | 1,000 integer calls through the Rust V8 backend |
| `guest-eh` | `try_table`, typed catch, indirect throw, `catch_all_ref`/`throw_ref`, 300 payload checks with successful calls between exceptions |
| `cross-module-eh` | Imported tag identity and calls across three modules, 100 payload checks |
| `uncaught-eh` | 100 uncaught guest exceptions reach Rust as errors, followed by the full catch/rethrow suite |
| `host-error`, `host-error-dynamic` | Typed and dynamic Rust callbacks return errors; marker survives and the instance remains callable |
| `host-error-identity`, `host-error-identity-dynamic` | 100 errors retain their Rust type and destroy each payload exactly once, followed by successful calls |
| `contained-host-panic`, `contained-host-panic-dynamic` | Catch a Rust panic inside each callback style, return an error and continue using the instance |
| `shared-memory` | Shared guest atomics, memory growth and host access after growth |
| `shared-memory-thread` | Attach shared memory to a store constructed on another thread; observe atomic writes from the original store |
| `stack-overflow`, `eh-stack-overflow` | Million-depth recursion traps, with and without EH frames; subsequent call returns 42 |
| `cache-write`, `cache-read` | V8 module serialization and fresh-process reopening, including EH behavior |
| `module-thread` | Instantiate an already compiled module in a new store on its owning worker thread |
| `wasix` | WASIX environment construction, clock import and writes to guest memory |
| `wasi-exit` | A guest `proc_exit(42)` retains the `WasiError::Exit` type and numeric exit code used by the SDK |
| `blocking-io` | Guest `fd_read` blocks until delayed pipe data arrives, then sees EOF; environment shuts down |
| `directory-io` | Guest WASI file creation/write/`fd_sync`/close and a fresh environment's reopen/read/close |
| `postgres-module` | Compile and instantiate the existing PostgreSQL dynamic-main through WASIX, with 92 imports and 1,245 exports; does not execute SQL |
| `host-panic`, `host-panic-dynamic` | Diagnostic: behavior when a Rust callback panics |
| `host-exception` | Diagnostic: host-created Wasmer `Exception` API |
| `uncaught-eh-metadata` | Diagnostic: Rust `RuntimeError::is_exception` and `to_exception` for an uncaught guest exception |
| `host-atomics` | Diagnostic: host `notify`, `wait`, wake-all and disable-atomics operations |
| `async-call` | Diagnostic: Wasmer's coroutine-based async invocation on a V8 store |
| `store_send` example | Compile diagnostic for moving a V8-only store between threads |

Integer exception payloads and instance teardown are covered; arbitrary external-reference ownership and guest exception payload destruction instrumentation are not. The cross-module case exercises plain imports, not WASIX `dlopen` or PostgreSQL extensions.

## Important integration limits

1. **Guest EH and Rust panics have different behavior.** Guest exceptions recover in the Linux control; callback panics abort. Catch a possible Rust panic within the callback boundary and convert it to a controlled error before it crosses the engine ABI. Existing SDK panic-containment behavior needs its own V8 qualification.
2. **Create the store on its executing thread.** Modules/shared-memory handles can cross threads in the probe. Store fails the `Send` compile check with both the V8-only and WASIX feature sets. V8 also checks its owner thread at runtime. Do not introduce an unsafe `Send` wrapper to bypass this boundary.
3. **Shared memory is not equivalent to host atomic control.** Attach, growth and guest atomic instructions work in the control. The host wake/disable operations are unavailable. A timeout kills the probe process; it does not demonstrate safe cancellation of an embedded database thread.
4. **Wasmer async is Sys-only in this release.** Plain synchronous WASIX imports may still work. SDK-level asynchronous Rust APIs can potentially keep an actor thread, but any coroutine, JSPI, context-switch or fork requirement needs separate proof.
5. **V8 caching is a different artifact contract.** These caches are trusted, generated and reopened by the same executable on the same machine/version. No existing LLVM AOT, cross-version compatibility, cross-platform cache interchange or sealed-loader policy is validated.
6. **A returned `fd_sync` is not database durability qualification.** This fixture uses upstream host filesystem code. Its flush delegates to Tokio; production Oliphaunt uses `SyncHostFile::poll_flush` with `std::fs::File::sync_all()`. PostgreSQL directory mode must retain and qualify that implementation, directory syncing and crash recovery.
7. **Stack trapping is not PostgreSQL SQLSTATE 54001 recovery.** The Sys `remaining_execution_stack()` API cannot establish the budget on V8. Real PostgreSQL deep-recursion errors and reuse need a V8-specific strategy and execution evidence.
8. **V8 adds a distribution obligation.** Wasmer downloads a platform-specific Wee8 archive dynamically. This experiment records its hash; upstream's build script does not itself pin the archive digest. Licensing notices, provenance, packaging and independent Node/Bun/Deno ownership remain release work.

## Reproduce

From the repository root, using native MSVC on Windows:

```sh
cargo +1.96.0 build --locked --release --features wasix --manifest-path tools/experiments/wasmer-v8/Cargo.toml
python tools/experiments/wasmer-v8/run.py tools/experiments/wasmer-v8/target/release/oliphaunt-wasmer-v8-probe --wasix --output tools/experiments/wasmer-v8/results
```

Append `.exe` to the binary path on Windows. The compile diagnostic intentionally produces a nonzero result on a V8-only store:

```sh
cargo +1.96.0 check --locked --release --example store_send --manifest-path tools/experiments/wasmer-v8/Cargo.toml
```

No physical Windows machine is needed: the experiment workflow uses GitHub-hosted Windows. It runs on the dedicated experiment branch or through manual dispatch once the workflow is available on the default branch.

## Product work still required

Only proceed after reviewing the actual Windows results and resolving relevant blockers. Qualify the existing PostgreSQL guest, full WASIX imports, side modules/extension linking, memory and directory storage, SQL errors/constraints/savepoints/PL/pgSQL, rollback and successful reuse, COPY/disconnect/reconnect, terminal-fault shutdown, clean SDK consumption and native-host coexistence. Then compare real startup/cache costs, query RTT, mixed workloads, memory and distributable package size.

A backend change or issue closure requires those product results. This bounded feasibility experiment can identify where that work must start; it cannot substitute for it.
