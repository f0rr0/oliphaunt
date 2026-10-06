# Windows V8 public API and behavior review

Reviewed candidate `cb63302d8a95a91ed43670c1a71b622aa415281a` on October 6,
2026, against the pinned registry sources: Wasmer 7.5.0 and WASIX 0.705.0.
This review distinguishes the public Oliphaunt SDK from the private engine
family. It changes review notes and adds a diagnostic; engine patch bytes and
production SDK selection are unchanged. The subsequent
[root-cause review](windows-v8-root-cause-review.md) corrects the loader ABI
assessment below and records isolated copy/terminal-contract fix prototypes.

**The SDK can retain its existing API, but the candidate is not ready to
activate.** Engine delivery has a consumer error-handling blocker. The
interruption patch also falls short of two general Wasmer memory contracts.
Existing Windows shutdown evidence remains valid for the tested terminal
WASIX path; it does not establish general atomics parity.

## Findings

### P1: Engine delivery can abort on recoverable open failures

[`embedded-engine.rs`](../../../tools/experiments/wasmer-v8/expanded-ownership/embedded-engine.rs)
uses `expect`, `unwrap` and assertions for directory creation, file access,
cached DLL identity and `LoadLibraryExW`. An existing damaged cache file is
never replaced: the identity assertion panics on every retry. Required reads or
cold-cache writes also panic when unavailable. These are source-confirmed
failure paths; this review did not inject them on a Windows host.

The public blocking builder returns `Result`, but its `open()` calls runtime
preparation without an unwind boundary. More fundamentally, the generated
DLL dispatch function itself uses non-unwinding `extern "C"`: a loader panic
can abort before either SDK API can catch it, even with `panic=unwind`.
The deeper review verified this ABI in the frozen Windows crate and reproduced
the language boundary in a subprocess. The original assessment that async open
would catch this particular panic was incorrect. The ordinary AOT artifact
repair path does not repair the separate engine DLL cache.

Before shipping, provide fallible engine preparation before constructing the
infallible Wasmer engine. Repair invalid cached bytes from the embedded payload
when possible; return the actual I/O/load error through SDK `Result` otherwise.
Test damaged caches, failed writes and failed loads through blocking Rust,
async Rust and Node open. This belongs inside delivery, with no new consumer
configuration or DLL instructions.

### P2: Successful atomics disabling does not prevent another guest wait

The [pinned public contract](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/api/src/entities/memory/shared.rs)
says: "All subsequent atomic wait calls will produce a trap."
Patch `0005` sets memory state to disabled and interrupts attached isolates,
but checks that state only during new attachment. Existing typed/dynamic call
paths do not check it before reentry.

The diagnostic interrupts a one-second guest wait, then calls a 100 ms wait
on the same function and memory. The first call traps; the second returns
`Ok(2)`, the WebAssembly timeout result. Therefore this implements interruption
of current execution and rejection of new attachments, not permanent disabling
of guest waits. The earlier description that isolates themselves become
permanently terminal was too strong.

For the SDK, keep cancellation a terminal WASIX lifecycle operation and enforce
that no guest entry or retry follows it. An explicit engine terminal-operation
contract is preferable to advertising full `disable_atomics` behavior. If the
existing Wasmer API is retained as supported, it needs persistent enforcement
across all guest entry paths and a reentry regression, not only an attachment
test. The SDK already treats terminal failures as close-only; do not turn normal
SQL recovery or cancellation of a queued async operation into engine shutdown.

### P2: Disabling a detached copy interrupts the original Store

In patch `0005`, V8 `Memory::copy()` obtains operations through
`copied.handle.as_shared(v8_store)`. That registers the original Store's isolate
as a user of the copied memory. Disabling the copy therefore interrupts the
original Store even after the copy is attached to another Store.

The diagnostic verifies independent bytes, then disables the copy while the
original memory is waiting. The original wait receives `TerminationException`.
A separate control shows that disabling one memory also interrupts a wait on a
different memory in the same Store. The underlying mechanism operates on
isolate execution, not a particular memory's atomic waiters.

A detached copy should acquire cancellation participants when attached, without
registering its temporary source Store. Also distinguish memory operations from
whole-process termination. These are engine API limits rather than a demonstrated
Oliphaunt database regression: direct SDK backends deny guest forks/threads,
and a terminal WASIX process kill is intended to stop its execution contexts.
Do not extend this implementation to general independent-memory/fork workloads
without addressing the limits.

## Public surface and paths that remain consistent

| Contract | Review result |
| --- | --- |
| SDK builders, options and feature selection | No engine type, interrupt handle, CPU flag or loader option is exposed. The public `session` API exposes protocol and ownership descriptors, not Wasmer Stores or memories. |
| SQL errors and recovery | PostgreSQL fields and SQLSTATE come from protocol decoding, independently of V8 trap metadata. Existing native Windows SQL/startup recovery and callback tests remain relevant. Unsupported Wasmer exception-object APIs are not substituted for structured SQL errors. |
| Callback behavior | Internal FFI callback panics become runtime errors. The SDK's blocking protocol callbacks still recover and resume the original unwind; async callbacks still return the documented callback-panic error. These are separate boundaries. |
| Retained host errors | New diagnostic passes typed downcast, `Error::source`, cloning beyond Store destruction and exactly one payload destruction. Earlier Windows controls cover all four callback constructors and retained guest errors. |
| Shared memory data | New diagnostic passes shared writes, cross-Store growth, independent copied bytes and use after the original Store drops. Cancellation is the exception described above. |
| WASIX attachment errors | All three attachment callers use `try_attach` and existing memory/link/thread error types. It remains backend-specific; it is not a promise that wrong-backend or wrong-thread use cannot panic. |
| Cached module loading | The trait default preserves ordinary fallback; the SDK's private policy rejects cache misses, including runtime overrides. Native payload rejection deliberately narrows generic V8 deserialization to the AOT contract. |
| Wasmer-family source compatibility | Adding `module_cache_only` to the public `PluggableRuntime` struct breaks exhaustive downstream struct literals. The SDK uses its constructor and exposes no such type. Treat this as a private fork change, not an entirely source-compatible upstream patch. |
| Other SDKs | WASIX Node uses the shared Rust addon. Native Rust/TypeScript and current Kotlin/Swift carriers use the separate native runtime; Windows V8 diagnostics do not qualify the browser host or create a WASIX JVM adapter. |

## Evidence and qualification limits

The runnable [diagnostic](../../../tools/experiments/wasmer-v8/expanded-ownership/public-api-review.rs)
has five command-line cases: `growth`, `host-error`, `copy-cancellation`,
`memory-scope` and `repeat-wait`. The last three print observations rather than
claiming a parity pass. It uses tiny maintainer-compiled fixtures; this is not
the consumer AOT test.

Built with Cargo/Rust 1.96.0 in the existing isolated Linux V8 harness, using
the same guarded Rust patches and the existing designated-owner/borrowed-call
C API bridge. `growth` and `host-error` pass. The three cancellation observations
above each reproduce in three separate process launches. Logs, executable/source
hashes, build flags and receipts
are retained under ignored experiment results in `expanded-controls/public-api-review-2026-10-06`.
These new observations are Linux diagnostics; they are not newly run native
Windows qualification.

Local qualification passes `moon run repo:prek docs:check`, Rust formatting,
Markdown lint and the diagnostic's eleven executions. Moon's affected-task
query succeeds; raw saved Moon source files from the previous review were
archived after they interfered with project discovery, preserving all nineteen
snapshot hashes. Maintainer notes do not alter rendered site content. No SDK,
producer, carrier or workflow code changed, so this pass does not rebuild those
products or create a new hosted release gate.

Earlier native evidence remains attached to its exact sources:
[37376903556](https://github.com/f0rr0/oliphaunt/actions/runs/37376903556)
contains the successful full catalog job, while
[37381922545](https://github.com/f0rr0/oliphaunt/actions/runs/37381922545)
passes both toolsets' shutdown/attachment stress and frozen-family consumption.
Neither run tested reentry after a completed termination, cancellation isolation
of copied memories or engine-cache failure handling.

Resolve these findings before calling the final integration qualified. The
remaining engine carriers, notices, CPU artifact family and installed WASIX
Rust/Node qualification still apply. The review does not require a consumer API
change or migrating away from WASIX.
