# Windows V8 reviewed fixes: implementation

October 6, 2026. Implements the direction accepted in the
[root-cause review](windows-v8-root-cause-review.md).

The three reviewed causes now have maintained candidate implementations.
Consumer APIs and configuration remain unchanged. This is private-family
integration and qualification, not a registry release or installed SDK claim.

## Changes

| Cause | Implementation |
| --- | --- |
| Guest reentry after SIGKILL | Patches `0008`/`0009` give V8 Stores a sticky terminal state, checked before calls/starts, on retries and after completion callbacks. SIGKILL uses an explicit execution-context operation. Ordinary `disable_atomics` retains `Unimplemented` on V8. Sys keeps its existing atomics shutdown. |
| Copied memory cancels its source | Detached copies have independent participant state. Actual attachments register their Store. The existing `ResearchRef` immediately owns the temporary copy wrapper on every return path. Shared aliases still share data and cancellation. |
| DLL delivery aborts during open | The loader prepares the whole dispatch before constructing V8. SDK internals return `Result<Engine>`; runtime and tools callers propagate failures. Patches `0010`/`0011` add/use the private family's fallible constructor without changing upstream-compatible constructors or consumer SDK APIs. |

The existing candidate drivers apply the guarded patches. Duplicate proposal
files were removed. The root SDK retains its stock dependency until the private
family is installed as an actual dependency; its shared engine function and both
callers now support fallible construction. The family-specific constructor is
a guarded SDK patch, rather than a call to an absent stock Wasmer API.

Dynamic-call cleanup also copies borrowed function-reference parameters and
retains returned reference wrappers in the Store before deleting result vectors.
Null function references remain null. This prevents vector cleanup from
invalidating a still-usable function; a 1,000-cycle regression covers both
reference directions, null values and Store teardown.
The same regression crashes the earlier terminal proposal immediately after
consuming a borrowed function parameter. Copying the wrapper before the native
vector adopts it fixes that ownership cause; retaining returned wrappers fixes
the corresponding result lifetime.
Wasmer's typed `Option<Function>` calls still reach its pre-existing
unimplemented V8 `vm_funcref` conversion. A supplemental Linux control rejects
that broader parity claim. The consumer SDK exposes no Wasmer function-reference
API; this change qualifies dynamic reference cleanup rather than implementing
all upstream reference operations.

## Delivery contract

Preparation locates Windows Local App Data through the existing known-folder
API. It reads a valid warm cache without attempting writes. Missing or damaged
bytes are written to a same-directory `NamedTempFile`, synced and atomically
replaced. A competing installation is accepted only after exact byte validation.
A locked bad destination returns an ordinary error and remains untouched;
temporary owners clean up on failure. Files are never rewritten in place.

The DLL is loaded by absolute path with the existing DLL-directory/System32
dependency search. Every required symbol resolves before V8 initialization.
An unsuccessful resolution frees the uncommitted library. Only success is
cached, so a subsequent open can retry. Successful libraries remain loaded for
process life. Errors retain their path, Windows error/HRESULT and I/O source.

Generated dispatchers use the Rust ABI and call typed C ABI pointers. The pinned
headers have 314 declarations, but four unused tag declarations have no exports
in the Windows archive. These are omitted, making accidental future use a compile
error. Preparation verifies all 310 implemented C entries plus three bridge
entries. The generator regression covers nested callback signatures, complete
dispatch and unsupported-declaration rejection.

## Qualification

Local root SDK formatting, lint and package creation pass. Its two doctests,
eight public API tests and 176 unit tests pass. Offline driver/generator checks
pass; canonical patch replay verifies every exact preceding source digest.
These are source and Linux checks, not Windows runtime evidence.

The first native attempt, run `37403581019`, stopped before runtime tests at
the DLL driver's newly enforced lock comparison. Intentional producer-tool
removal also prunes unreachable packages and changes Cargo's shorthand for
dependency versions. The corrected check computes that exact pruned graph and
compares resolved identities, checksums and edges; unrelated changes still fail.
Both archived Windows lock transitions and offline rejection controls pass.

Native qualification was dispatched from private candidate
`4efe4e881172ce4b94978fb558e071c3e351c109` in
[run 37405280098](https://github.com/f0rr0/oliphaunt/actions/runs/37405280098).
It selects Windows 2022 and Windows 2025 VS2026, terminal/shutdown controls,
frozen-family consumption and full strict catalog/server/tools coverage.
Current results will be recorded here after completion.

The added controls exercise all seven typed/dynamic/start/retry/completion
paths, real WASIX SIGKILL, copied-memory isolation and retained shared growth.
Windows delivery controls cover missing/truncated/wrong files, cold write
denial, valid read-only warm files, concurrent repairs, locked bad files,
invalid DLLs, missing exports, failed-library cleanup and retry.
Blocking and async Rust open run in separate subprocesses; each must preserve
the original Windows error and query successfully after releasing the lock.
The actual direct/actor Node addon must return structured `runtime-error`, then
query and close in the same process. Node runs after cached-loading activation
with the diagnostic guest-compilation sentinel present.

Release carrier wiring, complete engine notices, the packaged CPU profiles and
installed Rust/npm package qualification retain their existing separate scope.
Previous Windows passes qualify their recorded bytes; they do not qualify
these revised patches. Nothing is merged or published by this work.
