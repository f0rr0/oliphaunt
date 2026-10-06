# Wasmer 7.5 native V8: Windows feasibility experiment

This is a standalone Rust embedding probe for [Windows issue #208](https://github.com/f0rr0/oliphaunt/issues/208), using the dependency generation in [upgrade PR #247](https://github.com/f0rr0/oliphaunt/pull/247). It does not modify the production SDK, its Cargo patches, PostgreSQL build, release artifacts or supported-platform claims.

## Decision status

**The bounded native V8 feasibility gate passes. The stock integration still
does not meet the consumer contract, while a maintained patch series is an
acceptable engineering approach.** DLL, cache-only resolver, ownership,
numeric-call and interruption controls have executed evidence. The
[current decision ledger](../../../src/docs/maintainers/windows-v8-decision-log.md)
records sizing, failed combinations and exact scope. The
[private expanded ownership drivers](expanded-ownership/README.md) preserve
native source patches separately from production dependencies.

On October 4, 2026, the [final hosted run](https://github.com/f0rr0/oliphaunt/actions/runs/37237089766) passed all **22 required cases on Windows MSVC and Linux**. This includes guest exception handling, continued use after errors/traps, panic containment, typed Rust error ownership/destruction, module caching, shared memory, WASIX I/O/exit codes and instantiation of the existing PostgreSQL guest. The [earlier baseline run](https://github.com/f0rr0/oliphaunt/actions/runs/37235925649) independently passed its 16 required cases on both platforms.

**Six diagnostic cases fail on both platforms:** typed and dynamic uncontained callback panics, host-created exceptions, host atomic control, typed uncaught-exception metadata and Wasmer async invocation. These are recorded as failures even when the required suite passes. The separate V8-only Store `Send` compilation diagnostic also fails on both platforms, as expected from the thread ownership boundary.

Later private downstream controls correct the stock callback-panic handlers
on all four constructor styles and qualify the real WASIX kill registry on
both native Windows toolsets. They also qualify retained errors after Store
destruction and automatic engine delivery. The full Windows extension catalog
and strict cached-loading combination each pass all 195 extension/mode records,
server tests and the tools round-trip. Early host-only interrupt capture also
passes on both native Windows toolsets. These
results do not change the historical stock-probe results below. The historical
probe workflow is manually dispatched; ordinary branch pushes do not repeat
these expensive diagnostics. Offline lifetime-checker regressions run through
the product-owned `liboliphaunt-wasix:engine-control-test` Moon task.

Do not interpret a green experiment workflow as Windows PostgreSQL qualification. The workflow distinguishes required capability probes from deliberately exercised diagnostics. The evidence files preserve both categories.

SDK integration at `034012d0` passed 21 real Windows runtime tests and
7 PostgreSQL regression tests using the existing public API. At that commit,
V8's exact CPU/flag cache restriction and consumer-side libclang/objcopy
requirements blocked identical cross-platform installation. Later private
controls validate matching caches and tool-free engine delivery; normal SDK
release integration remains. See the
[integration ledger](../../../src/docs/maintainers/windows-v8-integration.md).
The later `cache-header-compatibility` probe adds a 23rd required capability
check; the recorded 22-case run above predates it.

## Why this experiment exists

- Wasmer 7.2.1 compiled Windows AOT artifacts but aborted during SQL error recovery in its unimplemented MSVC exception runtime. [Failing job](https://github.com/f0rr0/oliphaunt/actions/runs/34172865750/job/101905963703).
- [Wasmer PR #6826](https://github.com/wasmerio/wasmer/pull/6826), merged August 6, 2026, dropped Windows support for the Sys compiler backends: LLVM, Cranelift and Singlepass. This change first shipped in [7.3.0 on August 21](https://github.com/wasmerio/wasmer/releases/tag/v7.3.0); 7.5.0 did not introduce the policy.
- The 7.5 upgrade fails before runtime when Windows compiles LLVM. [Failing 7.5 build](https://github.com/f0rr0/oliphaunt/actions/runs/37225721762/job/111514964297). The compiler directs Windows consumers to V8.
- Wasmer's V8 backend embeds a separate native V8 library through Rust. It is distinct from the JavaScript-host backend and does not automatically reuse Node's V8 isolate. Existing Rust and N-API public APIs can potentially remain, but engine internals and artifacts require work.

In the repository history, [#201](https://github.com/f0rr0/oliphaunt/issues/201) initially favored downstream MSVC exception work; [#208](https://github.com/f0rr0/oliphaunt/issues/208) corrected that recommendation after identifying upstream's explicit V8 direction. [PR #229](https://github.com/f0rr0/oliphaunt/pull/229), merged October 1, addresses guest error recovery and SJLJ code growth. [Correctness PR #218](https://github.com/f0rr0/oliphaunt/pull/218) remains open. Those correctness changes and the host compiler policy are separate parts of the problem.

[Issue #213](https://github.com/f0rr0/oliphaunt/issues/213) tracks dependency-family/backport consolidation, while [#212](https://github.com/f0rr0/oliphaunt/issues/212) tracks extracting first-party browser code from Wasmer patches. This probe uses published upstream crates without a local Cargo patch; its success does not qualify or retire the production backports, or complete the browser-host work.

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

The PostgreSQL fixture comes from successful [portable producer job 111506164334](https://github.com/f0rr0/oliphaunt/actions/runs/37225721762/job/111506164334). Its parent upgrade run failed other jobs; it is a diagnostic input, not release qualification. The download uses immutable artifact ID `11312707536`, producer source `2f942e79f10dbc3163ed6e7d54c59051efee2e03` and archive digest `bec3e4c68e86d64bdd926587e2a178d730c0f3e13d49ae6805e4faefe3727b33`. The 10,126,285-byte PostgreSQL module must hash to `69fdbc72f9e110c1e356db8f46b941cb67591eff140231fcfaffff201d4e7cf9`. The verifier retains this guest with the new run's evidence, which has 90-day retention. After the old producer artifact expires, supply the retained verified guest manually rather than selecting a similarly named newer artifact.

## Recorded results and limits

Baseline source: `636912cb0a7a2ebc59014a0232d0c3d5be9770f0`. Expanded source: `11f5450b336a21773c7d6d363b3094bc43ddf479`. Report-only edits after these commits do not change the tested executable.

| Result | [Windows MSVC](https://github.com/f0rr0/oliphaunt/actions/runs/37237089766/job/111538278078) | [Hosted Linux](https://github.com/f0rr0/oliphaunt/actions/runs/37237089766/job/111538278305) |
| --- | --- | --- |
| Required cases | 22/22 pass | 22/22 pass |
| Uncontained typed/dynamic callback panics | Abort, `0xc0000409` | Abort, SIGABRT |
| Host-created `Exception` | Panic, exit 101 | Panic, exit 101 |
| Host notify/wait/wake-all/disable | `Unimplemented` | `Unimplemented` |
| Wasmer async invocation | Sys-only error | Sys-only error |
| Typed uncaught guest exception metadata | Unavailable | Unavailable |
| Contained callback panics | Both styles recover | Both styles recover |
| Typed host error identity and destruction | Both styles pass 100 iterations | Both styles pass 100 iterations |
| WASI exit type/code | `WasiError::Exit(42)` preserved | `WasiError::Exit(42)` preserved |
| Existing PostgreSQL module | Compiles and instantiates | Compiles and instantiates |

Raw results, per-case logs, toolchain/build logs, guest provenance and the verified guest are retained in each job's `wasmer-v8-probe-*` artifact. Maintainer-local copies are under the ignored `results/hosted-expanded-windows/` and `results/hosted-expanded-linux/` directories next to this report. There were no required-case failures or timeouts. The workflow is green because its required feasibility checks pass; it does not convert the six diagnostic failures into passes.

Both platforms create a 1,988-byte cache for the tiny EH fixture and successfully reopen it in a fresh process. Both report stack overflow as `wasm-c-api trap: Uncaught RangeError: Maximum call stack size exceeded` and then execute the successful follow-up call. The directory test writes four bytes, calls WASI `fd_sync`, closes, creates a fresh environment, reopens and checks the bytes. The blocking read receives data after approximately 100 ms, observes EOF and completes teardown.

The expanded guest metadata diagnostic returns `wasm-c-api trap: Uncaught #<Exception>`, with `is_exception=false` and no exception object. This differs from the base SDK's old case-sensitive `"uncaught exception"` string classifier. **PR #247's current source no longer contains that old recovery classifier**; do not describe the historical mismatch as an already-proven bug in the upgrade branch. Its `WasiError::Exit` downcast remains relevant and is directly probed.

The core PostgreSQL loading case covers all 92 declared imports and 1,245 exports during instantiation. It does not invoke `_start`, install a database seed, execute SQL, trigger `dlopen`, exercise futex waiters or run PostgreSQL shutdown. Imported function availability is weaker evidence than exercising those operations.

### Do the six diagnostics block us?

**We can proceed with the Windows integration prototype without implementing every missing upstream API. Production readiness remains unproven.** There are six failed test cases but five distinct limitations: typed and dynamic callback panics test the same failure through two callback interfaces. These are native V8 backend limitations observed on both operating systems, not six Windows-only defects.

| Failed diagnostic(s) | Consequence | Criticality for Oliphaunt and way forward |
| --- | --- | --- |
| `host-panic`, `host-panic-dynamic` | A Rust callback panic escaping into the engine aborts the entire process. | **Critical in stock; a scoped backend correction passes.** The upstream handlers already catch panics, but panic again in the catch arm. Returning a runtime error there passes all four constructors on both Windows toolsets, without consumer callback wrappers. The SDK's outer `catch_unwind` alone cannot catch the original abort. |
| `host-exception` | Rust cannot construct a Wasmer exception object using `Exception::new`. | **No identified requirement in the current database path.** Guest throw/catch/rethrow and ordinary host error returns passed. Host-created exception *tags* also work: the diagnostic creates its tag successfully and fails at exception-object construction. The SDK and inspected WASIX source do not call `Exception::new`; we can avoid that API. |
| `uncaught-eh-metadata` | An escaping guest exception reaches Rust as an error, but the host cannot inspect its exception object through `is_exception`/`to_exception`. | **Manageable if the error boundary is preserved.** Expected SQL errors should recover inside PostgreSQL and return through its protocol; arbitrary escaping traps must close the backend. Do not guess recoverability from the error text. Real SQL errors, savepoints, PL/pgSQL and successful reuse still need execution tests. |
| `host-atomics` | Host wait/notify/wake-all/disable APIs are unimplemented, although guest atomics and shared memory work. | **Stock native-wait cancellation is rejected.** A delivered WASIX `Sigkill` does not interrupt an indefinite native waiter. The combined private WASIX registry passes single and simultaneous waiters, late attachments and post-teardown signals on both native Windows toolsets. Automatic Store/memory lifecycle hooks remain integration work. |
| `async-call` | Wasmer's coroutine-based `Function::call_async` is Sys-only. | **No direct blocker for ordinary SDK async queries.** The SDK already opens and runs the database on an owner thread and delivers results asynchronously to callers; its database engine calls are synchronous. WASIX context switching and initialization paths that create guest tasks need separate qualification. |

This assessment combines the executed probes with a source audit; it is not an executed SDK integration result. The relevant SDK sources are [the async owner-thread implementation](../../../src/wasix/sdks/rust/src/async_api.rs) and [the single-backend task policy](../../../src/wasix/sdks/rust/src/oliphaunt/postgres_mod/task_policy.rs). The upgrade's terminal-error handling was inspected at [PR #247 source `b7c707a`](https://github.com/f0rr0/oliphaunt/blob/b7c707a22e5547908efc70706041a24fa804fd9d/src/wasix/sdks/rust/src/oliphaunt/postgres_mod.rs): it closes a failed backend and retires host descriptors after synchronous guest entry has returned, without re-entering the failed guest. That design does not establish cancellation of a guest call that has not returned.

WASIX `futex_wait`/`futex_wake` use host-managed waiter state; they are not the
failed `SharedMemory::wait`/`notify` APIs. Conversely,
[WASIX process signals](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/wasix/src/os/task/process.rs)
reach host `disable_atomics` on `Sigkill`. The resumed live wait control confirms
that this stock path fails. Static parsing finds an indefinite memory-initializer
wait in PostgreSQL and the executable extension modules, plus libc's native
futex wait in the PostGIS support library. This does not reproduce a SQL
deadlock, but a guest-task denial policy alone cannot prove those instructions
absent. The current decision ledger records the interrupt remedy and its scope.

The separate Store `Send` failure is an integration constraint rather than one of these six cases: create, use and destroy the V8 store on its owner thread. Existing owner-thread structure is promising, but the complete SDK must compile and run with that ownership enforced. The split `initdb` path also allows guest tasks and executes child PostgreSQL commands; the single-backend policy does not qualify it automatically.

The real PostgreSQL Windows gate subsequently passes initialization/open,
SQL error recovery, continued use, shutdown and directory reopen/durability.
Those results support avoiding the unused exception-object and engine-async
APIs. They do not waive the consumer, CPU, lifetime and cancellation criteria
in the current decision ledger.

The subsequent integration run at `91acf30d` passes real SQL recovery,
callback-panic recovery, async ownership and normal/terminal close paths, plus
UUID-OSSP loading and dump/restore. That strengthens the remedies above but
does not exercise interruption of an indefinitely blocked guest atomic waiter.
See the integration ledger for exact runs and fixture provenance.

### Runner and distribution identity

| Final measurement | Windows | Linux |
| --- | --- | --- |
| Actual runner image | `20260925.250.1` | `20260927.320.1` |
| OS | Windows Server 2025, build 26100 | Ubuntu 24.04, Azure kernel 6.17 |
| Wee8 archive bytes | 151,695,100 | 18,372,864 |
| Wee8 archive SHA-256 | `2aee8b6c3e8cecae2ce0325ac01b9bcaea4bef49e8f2aac599e1729d60c17285` | `54e19938a034ee77888b10cf27704b19e317dfbfe8f68d7a5f8ad8968fe731ba` |
| Probe executable bytes | 64,920,064 | 259,442,192 |
| Probe executable SHA-256 | `5c0833035d1ef9c5cca43f2d2ae6ab01ed0c36b2c396559b67ba7409e4814d90` | `f08455fd7856ea89331cdb40fd9f5e29b3aca31d0c3bf14b1c9d5b33da66272b` |

The build uses release optimization with debug level 1. Linux DWARF and Windows separate debug information make the executable sizes incomparable. They are probe executables containing the broad WASIX feature set, not SDK package sizes. The archive sizes measure build downloads, not shipped overhead. Millisecond fixture timings are diagnostic observations, not PostgreSQL performance benchmarks.

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
| `cache-header-compatibility` | Execute a trusted serialized EH fixture, verify native CPU/flag header mismatches are rejected, then execute the original again; does not prove cross-CPU portability |
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

Integer guest exception payloads, typed Rust error payload destruction and instance teardown are covered; arbitrary external-reference ownership and guest exception payload destruction instrumentation are not. The cross-module case exercises plain imports, not WASIX `dlopen` or PostgreSQL extensions.

## Important integration limits

1. **Guest EH and Rust panics have different behavior.** Guest exceptions recover on Windows and Linux; uncontained callback panics abort. Catch a possible Rust panic within the callback boundary and convert it to a controlled error before it crosses the engine ABI. The fixture proves this remedy for typed and dynamic callbacks on both platforms. Existing SDK panic-containment behavior still needs its own V8 qualification.
2. **Create the store on its executing thread.** Modules/shared-memory handles can cross threads in the probe. Store fails the `Send` compile check with both the V8-only and WASIX feature sets. V8 also checks its owner thread at runtime. Do not introduce an unsafe `Send` wrapper to bypass this boundary.
3. **Shared memory is not equivalent to host atomic control.** Attach, growth and guest atomic instructions work in the control. The host wake/disable operations are unavailable. A timeout kills the probe process; it does not demonstrate safe cancellation of an embedded database thread.
4. **Wasmer async is Sys-only in this release.** Plain synchronous WASIX imports may still work. SDK-level asynchronous Rust APIs can potentially keep an actor thread, but any coroutine, JSPI, context-switch or fork requirement needs separate proof.
5. **V8 caching is a different artifact contract.** These caches are trusted, generated and reopened by the same executable on the same machine/version. No existing LLVM AOT, cross-version compatibility, cross-platform cache interchange or sealed-loader policy is validated.
6. **A returned `fd_sync` is not database durability qualification.** This fixture uses upstream host filesystem code. Its flush delegates to Tokio; production Oliphaunt uses `SyncHostFile::poll_flush` with `std::fs::File::sync_all()`. PostgreSQL directory mode must retain and qualify that implementation, directory syncing and crash recovery.
7. **Stack trapping is not PostgreSQL SQLSTATE 54001 recovery.** The Sys `remaining_execution_stack()` API cannot establish the budget on V8. Real PostgreSQL deep-recursion errors and reuse need a V8-specific strategy and execution evidence.
8. **V8 adds a distribution obligation.** Wasmer downloads a platform-specific Wee8 archive dynamically. This experiment records its hash; upstream's build script does not itself pin the archive digest. Licensing notices, provenance, packaging and independent Node/Bun/Deno ownership remain release work.

The Windows evidence comes from a GitHub image with Visual Studio and the MSVC runtime installed. It proves x86-64 native MSVC execution on that image, not a clean downstream installation on a machine without the build tools or redistributables. Customer DLL/runtime consumption remains part of package qualification.

Typed guest exception metadata and host-created exceptions need separate treatment. Guest `throw`/`try_table`/`throw_ref` work inside Wasm, while `RuntimeError::is_exception`, exception-object access and `Exception::new` are incomplete on V8. A host adapter must preserve recoverable SQL errors and distinguish them from engine traps and terminal faults without swallowing errors or treating an arbitrary failure as recoverable.

Primary implementation references: [V8 callback handling](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/api/src/backend/v8/entities/function/mod.rs), [V8 trap representation](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/api/src/backend/v8/error.rs), [V8 exception API](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/api/src/backend/v8/entities/exception.rs), [async backend selection](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/api/src/entities/function/inner.rs), [V8 build/distribution](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/api/build.rs). Recorded execution takes precedence over a generic backend feature table.

## Alternatives after the experiment

| Option | What it provides | Decision |
| --- | --- | --- |
| Windows native V8; Linux/macOS LLVM | Upstream-supported Windows route with executed EH, shared-memory and cache evidence; Rust embedding stays possible | Preferred next prototype |
| Remain on Wasmer 7.2.1 | Keeps the former compiler build path | Does not fix the observed MSVC runtime abort; not a Windows recovery solution |
| Downstream Windows Sys/LLVM implementation | Potential continuity with existing AOT policies | Deliberate maintenance investment across compiler, loader and exception runtime; a throw-stub patch alone is insufficient |
| Cranelift or Singlepass | Other Wasmer Sys compilers | Also lost Windows support; Singlepass additionally lacks the required guest EH path |
| Wasmtime | A separate Rust runtime worth evaluating strategically | Requires a real WASIX/import/dynamic-linking port and product qualification; not a compiler-feature substitution |
| Wasmer's JavaScript-host path | Runs in a JavaScript engine with a different host architecture | Separate from native V8; reintroduces an architectural choice about the SDK/host boundary |
| Wasmi or WAMR through Wasmer | Former interpreter/embedded backend choices | Removed in [Wasmer 7.2](https://github.com/wasmerio/wasmer/releases/tag/v7.2.0); not an available supported switch here |

Keep [issue #208](https://github.com/f0rr0/oliphaunt/issues/208) open until the product acceptance criteria are met. The findings justify trying V8 rather than funding a Windows Sys unwinder first. They do not justify changing SDK support claims or merging a backend migration solely on the probe result.

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

To include the real guest, add `--postgres-module /absolute/path/to/verified/postgres.wasm` to the Python command. It must be a portable Wasm module, not a Sys/LLVM AOT artifact. The hosted workflow verifies and supplies this fixture automatically. The `store_send` example is intentionally excluded from normal builds; `cargo ... --all-targets` would select this expected compilation failure.

No physical Windows machine is needed: the experiment workflow uses GitHub-hosted Windows. It runs on the dedicated experiment branch or through manual dispatch once the workflow is available on the default branch.

## Product work still required

The October 5 follow-up adds `cpu-profile.rs` and `profile_check.py` for
fixed-flag writers and compilation-free readers. PostgreSQL native bytes are
persisted alongside the EH/SIMD cache and exchanged only between matching
native operating systems. `host_map.cpp`/`mixed_host.rs` test an ordinary MSVC
container alongside V8; `/MD` is the consumer control and `/MT` is a separate
diagnostic to reach runtime behavior with matching CRTs. `lifecycle_check.py`
measures the actual SDK test process over 25 vector open/error/query/close
cycles and retains raw Windows private-memory/working-set samples, including
on timeout. Results and unresolved blockers are recorded in the
[feasibility follow-up](../../../src/docs/maintainers/windows-wasmer-feasibility.md).

At `31e154b1`, all 25 vector cycles pass on Windows, but private memory reaches
8.588 GiB and grows by about 334 MiB per cycle over the measured interval.
This is a release blocker, not a successful memory qualification. Fresh Windows
readers also prove PostgreSQL cache acceptance for matching CPU profiles and
rejection for different profiles. Matching `/MT` native-library controls pass;
ordinary `/MD` linking still fails on both tested Windows toolsets. The linked
feasibility record identifies the exact runs, artifacts and limits.

The follow-up isolates a pinned V8 C API deletion defect: its public nonvirtual
base deletes do not reach the designated Store, shared-memory and shared-module
implementation owners. Linux controls preserve Wasmer's existing Arc lifetimes
and use the designated C++ deleters. The 1,000-store control's growth falls to
12 KiB; PostgreSQL/WASIX instantiation growth falls from about 5 MiB to
0.14 MiB per cycle, while repeated PostgreSQL module-load retention falls from
39.64 MiB to about 13 KiB per load over the initial measured interval. These
are distinct controls, without SQL or extensions; residual retention remains.

`owned_store_control.py` creates a private source-pinned Windows dependency
override and records source/lockfile receipts. `--shared-memory` and
`--shared-module` preserve existing final-owner Drops; `--observe-compilation`
logs Wasmer V8 module construction, excluding compilation internal to V8.
The first hosted ownership setup fails on a CP1252 decoding error before any
patched runtime executes. The corrected paired comparison uses explicit UTF-8,
the same physical runner and the same AOT bytes, then repeats ordinary SDK,
UUID-OSSP/tools and 25-vector-cycle tests. Its outcome is recorded in the linked
feasibility ledger. This private ABI mechanism is research, not the published
SDK's dependency closure or a complete AOT guarantee.

The corrected Windows comparison at `04ff56b6` passes all those functional
checks. Peak private memory falls from **8.590 to 0.795 GiB**, and sampled
growth from **334.2 to 2.9 MiB per cycle**. Residual retention remains. Its
patched logs prove actual Store cleanup and record no Wasmer V8
`ModuleHandle::new` calls; they cannot exclude compilation internal to V8.
Artifact `11326071452` has verified digest
`sha256:9e8075025b1d9fe9158c07b01ac4b0fce82a225c7370173bbd04f67cad3046b9`.
This validates a feasible ownership remedy, not a shipped engine fix or complete
memory/AOT/consumer qualification.

The later private expanded-ownership candidate diagnoses and fixes pinned V8's
adoption of borrowed call arguments. It then passes automatic embedded-DLL
delivery and **500 closed vector databases per Windows toolset** at `08ddac8a`
([run 37341683321](https://github.com/f0rr0/oliphaunt/actions/runs/37341683321)).
Three concurrent cold launches and a warm launch need only the executable in
the app directory. Late closed private memory is 249–252 MiB, with roughly
0.80 GiB transient peaks. Earlier memory measurements above are historical
controls; the current decision ledger contains the verified artifacts, late
growth and remaining qualification scope.

`expanded-ownership/` retains the source-pinned ownership/DLL drivers, the
argument/reentry regression, `embed-dll.py` and `embedded-engine.rs`, the scoped
`trap-ownership.diff` and runnable error-lifetime regression, and the genuine
CPU-profile producer/native-reader controls. These are research inputs. Their
manual diagnostic workflow lives only on the isolated research branch; they
are not a published engine dependency or supported Windows release.

Additional fresh-process Linux GDB controls observe zero guest function body
compilations and zero C API module constructions when loading the PostgreSQL
cache. V8 nevertheless generates 21 host-import adapters and one C-to-Wasm
entry adapter during WASIX instantiation. A fresh tiny-module compilation
control detects two guest body compilations and one module construction,
confirming the probes are active. Cached tiny EH execution returns 42 and
generates only one entry adapter. Adapter code generation happens inside the
embedded engine and needs no external compiler. This is bounded Linux evidence,
not a count of all compiler paths or a direct Windows observation; it does not
establish a headless runtime. Scripts, raw logs and hashed input receipts are
retained with the other local controls.

Only proceed after reviewing the actual Windows results and resolving relevant blockers. Qualify the existing PostgreSQL guest, full WASIX imports, side modules/extension linking, memory and directory storage, SQL errors/constraints/savepoints/PL/pgSQL, rollback and successful reuse, COPY/disconnect/reconnect, terminal-fault shutdown, clean SDK consumption and native-host coexistence. Then compare real startup/cache costs, query RTT, mixed workloads, memory and distributable package size.

A backend change or issue closure requires those product results. This bounded feasibility experiment can identify where that work must start; it cannot substitute for it.

## Change validation

The exact base-to-experiment Moon query identifies `ci-workflows` and root repository hygiene. The complete `tools/ci/check-workflows.sh` gate passes, including actionlint, zizmor, workflow security, planner/transfer and behavior tests. Rust formatting, Clippy with warnings denied for the probe binary, and the changed-file pre-commit hygiene checks pass. The `store_send` example intentionally fails compilation and is retained as diagnostic evidence.

The maintainer shell originally resolved Moon 2.3.2 with embedded proto 0.57.5, below this checkout's pins. For the complete gate, isolated checksum-verified Moon 2.5.4 and proto 0.61.3 were used; no repository toolchain pins were changed. No product runtime, browser SDK, native PostgreSQL SDK, Windows support declaration or release artifact was changed by this experiment.
