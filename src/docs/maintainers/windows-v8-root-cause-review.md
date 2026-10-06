# Windows V8 root causes and proposed fixes

Re-review of `8e67bb940e9c974d3c93e2de3d3be2b9650f6c3b`, October 6, 2026.
This follows the [public API review](windows-v8-api-review.md).

The prototypes below have since been promoted to maintained candidate patches;
the loader correction is implemented. The
[implementation record](windows-v8-implementation.md) owns current status.
This review records the preceding candidate and its diagnostic evidence.

**The findings are real, but they need more precise causes and scope.** The
loader failure is worse than previously described: its generated C ABI can
abort the process. Cancellation needs a terminal execution contract, rather
than a promise of general atomics support. A detached copy also has both an
incorrect cancellation participant and an unowned temporary native wrapper.
Small isolated prototypes address the cancellation causes. Engine delivery
still needs implementation and native Windows fault tests before activation.

## Findings, causes and decisions

| Finding | Underlying cause | Proposed fix | Evidence and scope |
| --- | --- | --- | --- |
| P1: Cache/I/O/load failures crash during open | Fallible delivery is performed lazily inside generated `extern "C"` dispatchers whose signatures cannot return delivery errors. Loader assertions attempt to unwind across that boundary. | Prepare and validate the complete engine dispatch before constructing V8; repair cached bytes transactionally; propagate I/O/load errors through SDK `Result`. | Exact frozen Windows bindings confirm the ABI. A separate Rust ABI control aborts with an outer panic catcher present. Real Windows cache/load fault injection remains required. |
| P2: Execution resumes after a completed kill | `TerminateExecution` consumes an interrupt; the patch's sticky memory flag only guards attachment. Guest entry and WASIX retry paths remain open. | Add a sticky Store termination latch and enforce it at typed calls, dynamic calls and instance creation, including retries and completed-call results. | Seven entry/retry/finish cases reproduce guest writes before the guard and reject them with the final prototype. Each final case passes in three process launches on Linux. |
| P2: Killing a copied memory affects its source | `Memory::copy()` calls the ordinary sharing path, which registers the source Store as a participant in the detached copy. Its allocation wrapper also has no owner. | Create detached cancellation state, register only actual attachments, and own the temporary C wrapper immediately with the existing `ResearchRef`. | Isolating this change removes the source interruption in three trials; shared writes, growth, independent copied bytes and use after owner teardown pass. Wrapper ownership is source-confirmed; no new allocation counter was added. |

### Delivery: move errors ahead of the ABI boundary

The frozen `oliphaunt-wasmer-7.5.0` archive from Windows 2022 run
[37381922545](https://github.com/f0rr0/oliphaunt/actions/runs/37381922545)
contains `pub unsafe extern "C" fn wasm_engine_new()`. It resolves its DLL
symbol inside `OnceLock::get_or_init`. The extracted bindings SHA-256 is
`6917193744e37ab363c7e377ff6db9aef902c7ada8ff2802c0648e3869d2fd0e`, matching
the frozen-family receipt. This is the delivered research artifact's shape,
not an assumption about bindgen.

`embedded-engine.rs` performs known-folder lookup, cache installation,
byte validation and `LoadLibraryExW` with assertions/unwraps. A cache error
there reaches a Rust function with a non-unwinding ABI. Rust specifies process
abort at that boundary; an outer `catch_unwind` cannot recover it.
The [ABI diagnostic](../../../tools/experiments/wasmer-v8/expanded-ownership/loader-boundary-review.rs)
confirms this with `panic=unwind`: the ordinary Rust dispatcher is caught and
exits zero; the C dispatcher terminates with `SIGABRT`, before the catcher
returns. This establishes the language boundary, not Windows filesystem behavior.
[Rust's FFI rules](https://doc.rust-lang.org/nomicon/ffi.html#ffi-and-unwinding)
describe the same behavior.

The earlier claim that async open would convert this particular failure into
a generic owner error was incorrect. Blocking Rust, async Rust and the Rust
Node addon can all lose their process on this path. Adding another outer
panic catcher or switching the dispatcher to `C-unwind` would leave the
fallible delivery design and permanent damaged-cache failure intact.

Implement delivery at its existing boundary:

1. Add a fallible preparation entry to the private Wasmer V8 engine family.
   It resolves the known folder, validates/installs the embedded DLL, loads it
   and verifies every generated C export plus the three bridge entries.
   Cache only successful preparation; failures must permit retry.
2. Preserve `V8::new()` source compatibility, but let the SDK use a fallible
   construction/preparation path. Change internal `aot::headless_engine()`
   to return `Result<Engine>` and propagate it in its two callers:
   `load_runtime_module()` and the tools runner. This covers `PostgresMod`,
   prepared sessions, split initdb and tools without changing consumer APIs.
3. Generate ordinary Rust dispatch functions that call typed `extern "C"`
   pointers. The dispatch wrapper itself is not a C callback. Preparation must
   establish the complete symbol table before any of these calls are needed.
4. Reuse `tempfile` for same-directory temporary ownership and replacement;
   it is already an SDK dependency and can be retained in the private engine
   family. Validate a warm file before attempting writes. For absent or
   mismatched bytes, write and sync the complete payload, then replace the
   destination atomically. On a competing-writer/replace failure, accept the
   winner only after exact payload validation; otherwise return the error.
5. Keep absolute loading and the existing DLL-directory/System32 search flags.
   Include the path and original OS/HRESULT error in SDK error context. Retain
   the successful module for process life; release an uncommitted module if
   export validation fails before V8 initialization.

Windows replacement can fail when another process has a file open without
delete sharing. Treat that as a normal, retryable error unless the winner's
bytes validate; do not delete or rewrite a mapped engine in place.
[Microsoft's replacement rules](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
and [loading rules](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibraryexw)
define these constraints. `NamedTempFile::persist` provides replacement and
retains ownership on failure; it does not by itself guarantee power-loss
durability. See its [contract](https://docs.rs/tempfile/latest/tempfile/struct.NamedTempFile.html#method.persist).

This is one loader correction, a generator/engine entry change and two internal
SDK call sites. It requires no consumer path option or Windows-specific setup.
Native acceptance must cover missing/truncated/wrong cache bytes, unavailable
cold-cache writes, a valid read-only warm cache, concurrent repair, a locked
bad destination, load/export failure and successful retry. Exercise blocking,
async and Node open in subprocesses so process survival is actually measured.

### Cancellation: make the supported operation explicit

Pinned V8's `StackGuard::FetchAndClearInterrupts` clears the termination bit
and deliberately leaves execution resumable. Its futex waiter uses the isolate's
wait node, handles that interrupt, and resets the node's interrupted flag.
The C API then snapshots the exception and clears the isolate exception.
This explains both observations: a later wait can time out normally, and
killing memory A can interrupt a wait on memory B in the same isolate.
See [stack-guard](https://github.com/v8/v8/blob/13.6.233.17/src/execution/stack-guard.cc),
[futex handling](https://github.com/v8/v8/blob/13.6.233.17/src/execution/futex-emulation.cc)
and the [C API](https://github.com/v8/v8/blob/13.6.233.17/src/wasm/c-api.cc).
All five locally inspected V8 files were freshly fetched from the pinned tag
and matched byte for byte.

A Store latch is a correct fix for terminal execution. It is insufficient to
implement memory-specific `disable_atomics`: denying all calls in a Store also
denies calls using unaffected memories. Retain the upstream V8
`AtomicsError::Unimplemented` result for that general operation.

The proposed private-family `MemoryOps::terminate_execution_contexts()` has
an explicit stronger scope. Its trait default uses the existing Sys
`disable_atomics` shutdown; V8 overrides it to mark participating Stores
terminal and interrupt active execution. WASIX's SIGKILL helper calls this hook.
The Store latch covers both function invocation loops and instance creation,
including a post-start check. Call results are checked after `OnCalledAction`
so `Finish` cannot turn shutdown into success. Dynamic calls reuse the existing
value-vector owner to release temporaries on these new error returns.

The native-pointer retirement lock remains necessary. Do not hold an admission
lock through guest execution: a blocked atomic wait must allow another thread
to request termination. Calls admitted before a concurrent kill may have
already executed; the guard cannot roll back their effects. A fresh Store is
required after terminal cancellation. Host callbacks need their own cancellation
mechanism, as with the existing SDK lifecycle.

The public SDK exposes no Wasmer Store/memory operations. Direct database
backends already deny guest threads/forks and treat terminal failure as
close-only. Tools and split initdb allow guest process trees; the copy fix is
necessary there, and their cancellation/registration races still need native
qualification. Normal SQL recovery and cancellation of queued async work must
keep their current paths, rather than invoking terminal shutdown.
The main PostgreSQL link recipe imports shared memory and uses `--no-entry`;
the SDK invokes its `_start` export after environment setup. Do not infer
support for cancelling an arbitrary module-defined memory inside its initial
Wasm start from these controls. PR 7005's review explicitly defers that case.

True V8 atomics parity is a separate engine change: a weak operation handle
to backing-store identity, a permanent closed state for that backing store,
and checks/wakeups synchronized with the native futex wait list. It must cover
32/64-bit waits, memory growth, late attachment, independent memories and
backing-store destruction/address reuse. Notifying one address, repeatedly
issuing isolate termination or guarding only SDK callers cannot satisfy it.
This alternative was source-assessed, not implemented or compiled. Reject it
for this SDK integration's scope; reconsider if a public memory API needs it.

## Upstream context refreshed

GitHub API snapshot: Wasmer main
`1befae3f829237e18bd790d919a6f9cd06e744e1`. Its native V8 sharing path still
returns shared handles without atomics operations, and `Memory::copy()` still
lacks temporary-wrapper ownership. These findings are partly limitations of
our interruption patch, rather than evidence that V8 termination is broken.

| Upstream item | Relevant conclusion |
| --- | --- |
| [PR 6536](https://github.com/wasmerio/wasmer/pull/6536), merged May 21 | Fixes WASIX waits stuck on kill. Discussion narrowed the final change to SIGKILL. This supports a terminal hook; it does not justify treating ordinary signals as permanent engine termination. |
| [PR 6644](https://github.com/wasmerio/wasmer/pull/6644), merged May 30 | Deliberately separates Store-attached memories from detached shared memories. Registering a copied detached memory's temporary source Store defeats that distinction. |
| [Issue 6607](https://github.com/wasmerio/wasmer/issues/6607), open | Tracks V8 native-wrapper ownership, including memory sharing/copying. The copied allocation's missing owner belongs to this same ownership problem. |
| [Issue 6680](https://github.com/wasmerio/wasmer/issues/6680), open | Tracks excess memory during repeated side modules/threads. It is broader than the particular copied-wrapper allocation found here. |
| [PR 6984](https://github.com/wasmerio/wasmer/pull/6984), open, `96aa18ff` | Separates addressed signals from foreground-child forwarding and resolves callbacks in the receiving Store. It concerns process routing; it does not implement native V8 per-memory atomics. |
| [PR 7005](https://github.com/wasmerio/wasmer/pull/7005), open, `31ef29da` | Adds process-family cancellation and registration gates. Its API interrupt changes target Sys/Unix, not Windows V8. The current diff spans 70 files and review identifies remaining admission races; do not import it wholesale as this small engine fix. |
| [PR 7065](https://github.com/wasmerio/wasmer/pull/7065), open, `a5d046c5` | Uses isolated N-API execution lanes and metered memory, depending on PR 7005. This provider path does not replace the pinned native V8 C API used by our headless AOT family. |

## Reviewable prototypes and evidence

The combined [Wasmer correction](../../wasix/runtime/engine/patches/0008-terminal-execution-and-detached-copy.patch)
and [WASIX correction](../../wasix/runtime/engine/patches/0009-wasix-terminal-execution.patch)
apply to the clean previously qualified research candidate. Their
[Wasmer input hashes](../../wasix/runtime/engine/patches/0008-terminal-execution-and-detached-copy.inputs.json)
and [WASIX input hashes](../../wasix/runtime/engine/patches/0009-wasix-terminal-execution.inputs.json)
identify every touched source. They were unactivated proposals at review time.
Relative to that candidate, the combined Wasmer change adds 58 and removes
24 lines across nine files; WASIX changes three lines in one file. These
measurements exclude the proposed loader correction and test fixtures.

| Control | Result |
| --- | --- |
| Loader ABI, standard Rust unwind mode | Ordinary Rust panic caught; generated-dispatch ABI aborts. |
| Detached copy fix alone | Three source waits time out normally after killing the copy; the old candidate traps them. Other cancellation limits remain, isolating this cause. |
| Seven terminal entry controls | Baseline executes subsequent typed/dynamic/start writes, retries and reports success after a cancelling `Finish`. Final hook/guard prevents new entry, retry and successful completion; three launches per case pass. |
| Real WASIX process SIGKILL | Three launches pass current-wait interruption, persistent reentry rejection, late attachment rejection and cancellation after Store destruction. Unsupported general atomics leaves an ordinary wait usable. |
| Existing shutdown stress with the explicit hook | 25 cycles, 35 waiters, 25 late attachment rejections, 2,500 post-teardown signals and 32 races involving 288 Stores pass. |
| Existing call/ownership controls | 100,000 ordinary calls and 1,000 retry/finish/trap/callback-error cycles pass; shared growth/copy and retained typed-error controls pass. |

The three new fixture files are
[terminal entry](../../../tools/experiments/wasmer-v8/expanded-ownership/terminal-entry.rs),
[terminal contract](../../../tools/experiments/wasmer-v8/expanded-ownership/terminal-contract.rs)
and the ABI diagnostic linked above. For the final hook proposal, the entry
fixture's `disable_atomics()` calls are changed to `terminate_execution_contexts()`
in its isolated harness copy. The stress control similarly changes its direct
shutdown calls to the new hook; the actual WASIX SIGKILL path uses the patched
WASIX helper. These transformations and hashes are retained in the receipt.

The local harness's Rust cancellation/function sources match the canonical
clean replay. Its sole initial source difference is the existing tag-deleter
binding adapter; build.rs and the Linux C++ ownership/borrowed-call bridge are
also existing harness adaptations. New controls compile tiny maintainer WAT
fixtures. They do not prove consumer AOT delivery or Windows runtime parity.

Logs, upstream snapshots, stage diffs, exact binaries, source hashes and receipts
are retained outside Moon discovery at
`/tmp/oliphaunt-runtime-research/root-cause-review-2026-10-06`; the indexed,
archived copy lives in ignored `expanded-controls/root-cause-review-2026-10-06`.
Local source/docs qualification is recorded with that receipt. No production
SDK, active engine patch, CPU profile, carrier or workflow changed.
Patch replay with zero fuzz and all ten input/output hashes passes. Rustfmt,
Markdown lint, JSON formatting and `moon run repo:prek docs:check` pass.
Moon selects the `repo`/`docs` projects. Site build/package tests are skipped
because these maintainer notes are outside rendered content; engine producers
and hosted release checks are skipped because no activated inputs changed.

**Accept the small copy/terminal-contract correction as the implementation
direction. Keep activation blocked on the fallible loader and fresh native
Windows qualification of the revised family.** Re-run both Windows toolsets'
shutdown/attachment controls and frozen-family consumer, then installed WASIX
Rust/Node and full catalog/server/tools coverage. Previous Windows passes remain
evidence for their earlier bytes; they cannot qualify these revised patches.
