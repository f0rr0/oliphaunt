# Maintained native Windows V8 patches

These patches implement Store and shared-memory interruption lifetimes for the
pinned Wasmer 7.5.0 V8 backend. They currently run through the isolated
qualification drivers; this directory does not enable a published dependency
or declare an engine release carrier.

Apply them after the DLL ownership, retained-error and callback-panic controls
in `tools/experiments/wasmer-v8/expanded-ownership`. Each `.inputs.json` fixes
the exact preceding source bytes. The drivers check those digests before
applying a patch. The WASIX patch targets 0.705.0; its three inputs are unchanged
by the separate cached-loading policy.

| Patch | Purpose |
| --- | --- |
| `0005-automatic-shared-memory-interruption` | Capture the Store isolate before creating a guest module; connect existing memory operations to WASIX cancellation; preserve the shutdown state through aliases and attachments. |
| `0006-fallible-shared-memory-attachment` | Add `try_attach`, returning a memory error after shutdown instead of unwinding through task creation. Preserve the existing `attach` API. |
| `0007-wasix-fallible-shared-memory-attachment` | Use that result in all three WASIX attachment callers, including the task manager and dynamic linker. |
| `0008-terminal-execution-and-detached-copy` | Reject guest reentry, retries and successful completion after terminal cancellation; keep detached copies independent and own their temporary native wrapper. |
| `0009-wasix-terminal-execution` | Route SIGKILL through explicit execution-context cancellation. Sys retains its existing shutdown; V8 leaves general `disable_atomics` unsupported. |
| `0010-fallible-v8-engine` | Prepare native delivery before initialization; add `V8::try_new` while preserving existing constructors. |
| `0011-sdk-fallible-v8-engine` | Select that constructor in the candidate SDK's shared fallible engine loader, covering direct/async open, prepared sessions, split initdb and tools. |

Each Store owns a capability containing its isolate pointer. A mutex serializes
termination with retirement: Store destruction clears the pointer before
deleting its native references or isolate. Memory state retains weak
capabilities and serializes attachment with terminal shutdown. Repeated shares
of the same native memory, and shares made after attachment to another Store,
keep the same state. Operations handles may outlive every Store safely.

Windows resolves the two pinned public V8 methods through the actual loaded
engine module. The Linux diagnostic uses the corresponding linked methods.
Acquisition uses a temporary C API host function, with designated type/reference
cleanup; it requires no guest export, raw handle supplied by the SDK, or private
V8 object layout.

The stress control covers single and simultaneous blocked guest waits, repeated
shutdown signals, Store teardown races, and attachments racing with shutdown.
The full catalog control tests SQL, server, restart, physical backup/restore,
materialization and tools with consumer guest compilation blocked. Exact source,
run and artifact identities belong in the
[decision ledger](../../../docs/maintainers/windows-v8-decision-log.md).

The terminal Store latch rejects typed/dynamic calls and instance starts,
including WASIX retries and completed-call results. Detached copies start with
no cancellation participants; only actual attachments register a Store.
The explicit execution-context hook replaces the earlier `disable_atomics`
override. Generic host atomic wait/notify and resumable wake-all remain
unsupported. See the
[implementation record](../../../docs/maintainers/windows-v8-implementation.md)
for delivery semantics and exact native qualification. Published engine notices,
CPU-profile artifacts and installed SDK carrier qualification remain separate
production work.

The [code and CI review](../../../docs/maintainers/windows-v8-review.md)
records the checked design, tooling corrections and SDK boundaries. Run offline
qualification-driver regressions with
`moon run liboliphaunt-wasix:engine-control-test`; native engine qualification
remains the separate source/run proof linked above.
