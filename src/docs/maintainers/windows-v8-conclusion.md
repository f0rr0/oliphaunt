# Windows while retaining Wasmer and WASIX

Investigation snapshot: October 6, 2026. Hosted run timestamps use UTC.

**A maintained Windows V8 integration is feasible, and the fixes are
proportionate to the existing architecture.** Keep WASIX dynamic loading and
the SDK's public API. Reject the stock Wasmer 7.5 integration for release until
the tested fixes and delivery work are integrated.

The [public API review](windows-v8-api-review.md) adds three findings to resolve
before activation: engine-cache failures can abort, subsequent waits can reenter
after interruption, and cancellation of a detached copy can interrupt its source
Store. These narrow the engine contract; the tested SDK lifecycle remains
feasible without changing its consumer API. The subsequent
[root-cause review](windows-v8-root-cause-review.md) verifies the abort boundary,
records small copy/terminal-contract prototypes and specifies the fallible
loader correction. The prototypes pass Linux controls; their native Windows
qualification and production activation remain outstanding.

The same SDK dependencies, features, configuration, SQL, extensions, tools and
async APIs can remain. Engine flags, CPU-profile selection, compiler tools and
engine DLL placement belong inside SDK/package production. Consumers must not
compile PostgreSQL or side modules.

| Concern | Finding |
| --- | --- |
| SQL errors and guest exceptions | Real Windows SQL recovery and successful reuse pass. Guest exception handling works; the unsupported host exception-object APIs are not required by the SDK. |
| Dynamic extensions | All 39 extensions pass direct SQL, server SQL, restart, physical backup/restore and materialization: 195 records. This includes the modules that import exception tags. Tools pass too. |
| Callback panics and retained errors | Scoped backend corrections pass all four callback constructors and error use after Store destruction on both Windows toolsets. Consumers need no callback wrappers. |
| Build tools, CRT and DLL delivery | A producer-built DLL, generated C bindings and automatic internal loading pass executable-only cold/warm starts and ordinary consumer builds on both toolsets. |
| CPU compatibility | Genuine compatible caches pass in both selection directions with untouched headers. Use internal normalized flags and a small cache family. The approved x64 minimum is SSE4.1; SSE2-only support is excluded. |
| Blocked native waits | Automatic Store/memory lifetime hooks and clean WASIX attachment errors pass on both Windows toolsets, including simultaneous waits, aliases, repeated signals, teardown races and attachment/shutdown races. |
| Patched dependency delivery | An aligned four-crate family, engine facade and two bounded DLL payload crates compile from frozen package contents on both Windows toolsets. Executable-only cold/warm launches, direct engine calls, safe teardown and exact DLL reconstruction pass. These candidates are unpublished. |
| Guest compilation fallback | The full Windows catalog, server and tools pass with the guest-compilation entry point blocked. Four direct/overridden cache-miss controls reject without compiling. |
| Memory | The corrected engine passes 500 vector database lifecycles per toolset. Late private memory is about 249–252 MiB, with transient peaks near 0.80 GiB. This is bounded evidence, not a zero-leak or infinite-bound claim. |

The original callback-panic and blocked-wait gaps now have backend fixes.
The unsupported host exception-object/typed metadata APIs and Wasmer's own
async-call API are outside the SDK path; the SDK's existing async API and SQL
error behavior pass. Generic host atomics parity remains unsupported; required
WASIX cancellation uses the tested lifetime hooks.

The candidate Wasmer Rust changes now touch thirteen existing files and one new
file, with 403 lines added and 121 removed. Cached loading and clean attachment
errors change four WASIX files, with 27 lines added and four removed, plus one
internal SDK assignment. These measurements include automatic interruption;
they exclude engine packaging, generated bindings and CPU-profile delivery.
They are not the total release implementation size.

Remaining production work is concrete:

1. Deliver the aligned patched Wasmer/WASIX crate family and engine, with
   provenance and complete notices, through normal SDK packages.
2. Produce and package matching CPU variants for core, support libraries,
   extensions and tools; select them internally and align the SSE4.1 metadata.
3. Qualify installed WASIX Rust/Node carriers and deployed CPU profiles.
   Current Kotlin/Swift bindings use the separate native runtime; JVM test
   compilation is not Windows WASIX SDK delivery. The private experiment is
   not a published release.
4. Resolve engine delivery errors and the explicit terminal-interruption
   contract, including reentry and copied-memory cancellation regressions.

The [code and CI review](windows-v8-review.md) records cleanup, regression
checks and actual SDK dependency boundaries. The
[decision ledger](windows-v8-decision-log.md) contains exact source/run
identities, verified artifact digests, negative controls and remaining limits.
The [integration record](windows-v8-integration.md) and
[upstream/history record](windows-wasmer-feasibility.md) provide the context.
