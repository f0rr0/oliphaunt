# Windows V8 decisions and acceptance evidence

Investigation resumed October 5, 2026. The requirement is unchanged SDK APIs,
dependencies and features, with no Windows setup, guest compilation, engine
flags or manual DLL placement by consumers. This ledger records acceptance
or rejection of specific implementations. A failed prototype rejects that
prototype; it does not establish that all possible engine changes are impossible.

## Decisions established before the new controls

| Implementation | Decision | Decisive evidence |
| --- | --- | --- |
| Stock Wasmer 7.5 Windows dependency | Reject for the required DX | Real consumer build requires libclang; ordinary `/MD` C++ library link fails. |
| Stock default V8 cache as a universal Windows AOT artifact | Reject | Real different-mask Windows cache reads reject otherwise valid PostgreSQL artifacts. |
| Forcing application `/MT` flags | Reject | Matching-CRT control works, but requires the consumer changes explicitly prohibited by the contract. |
| Removing or rewriting cache compatibility headers | Reject | It bypasses the engine's validity checks and cannot establish safe instruction selection. |
| Claiming V8 is headless or emits no runtime machine code | Reject | Fresh-process debugger detects host import/entry adapter compilation while cached guest body compilation stays at zero. |
| Retaining WASIX through V8 | Functional feasibility demonstrated | Windows SQL recovery, async APIs, extension loading and tools pass in the tested environment. |

The [feasibility ledger](windows-wasmer-feasibility.md) retains upstream source
pins, artifacts, hashes, measurements and limits for those decisions.

## New controls and their decision boundaries

1. **Private Wee8 DLL and producer-generated bindings.** Build the engine DLL
   from the pinned Windows archive and restrict the consumer import library to
   C entries. Rebuild a real Rust/WASIX consumer with Clang/objcopy directories
   removed, execute an ordinary `/MD` unordered-map library in ten fresh
   processes, and load actual PostgreSQL caches through WASIX. This can accept
   or reject the packaging boundary against compiler-tool and CRT conflicts.
   Its test layout is staged by the producer; it does not prove automatic SDK
   loading, standalone executable distribution or published dependency closure.
2. **Bounded CPU profiles.** Execute both the existing constrained profile and
   its JCC-alignment-disabled variant in fresh Windows writer/reader processes.
   Preserve compatibility validation. Same-mask success is insufficient for a
   universal-cache claim: different CET masks still need actual matching
   artifacts and automatic selection. The combined JCC/CET profile must not
   be asserted from a changed header.
3. **Longer memory reclamation.** Repeat 100 vector database open/create/error/
   query/close cycles with the three corrected owners, then with unique host
   callback payload finalizers too. Capture private memory inside the process
   after the database and query results have dropped, before another open.
   Run the normal runtime/PostgreSQL/tools regressions for both dependency
   variants. Reject a variant as a complete memory remedy if retention keeps
   growing; elapsed-time samples alone cannot establish post-close reclamation.
4. **Strict guest AOT.** Cache misses, corrupt artifacts and Wasm-only executable
   records must fail before guest compilation. Cover dynamic core, tools and
   dependency-bearing extensions, SQL recovery and all catalog extensions on
   Windows. This remains separate from V8's internal host-adapter generation.
5. **Installed delivery.** A successful producer-staged DLL experiment must be
   followed by the existing consumer API on a clean Windows installation,
   automatic runtime location, ordinary native-library coexistence, complete
   engine notices and package-size/performance checks before acceptance.

No experimental dependency copy is published or installed as the production
runtime by these controls.

## New upstream evidence

Rechecked the existing ownership, STL and V8-upgrade issues; no completed
replacement was found. Two newer shutdown PRs are relevant:

- [Wasmer #7005](https://github.com/wasmerio/wasmer/pull/7005), head
  `31ef29da92d0c650acbd8dbba7270cf942d85346`, remains draft. It addresses
  complete process-family cancellation, registration races and blocked host
  work, rather than the pinned native V8 C API owner deletes.
- [Wasmer #7065](https://github.com/wasmerio/wasmer/pull/7065), head
  `c37330903d20d0cd66d2f37b1d0169077c2f5e7a`, remains open and depends on
  #7005. Its managed V8 execution lanes are in the Node host provider. Its
  shared-memory changes inspected here concern Sys memory, not the standalone
  Wee8 ownership defect. It is not an accepted substitute for our Windows
  AOT/consumer requirements.

The pinned source also shows unfreed C API import/export containers, missing
call-value cleanup and host callback payloads transferred without finalizers.
Those findings justify the new controls; they are not themselves proof that a
particular patch fixes long-lived applications.

## Qualification follow-up

The earlier [run 37267345495](https://github.com/f0rr0/oliphaunt/actions/runs/37267345495)
at `2654aa260a31b71ceb31d019770408ad20151e16` finishes with **Builds, Required
and Qualified failing**. All seven native extension producers, both Android
packaging jobs, four desktop WASIX/installed-consumer hosts, TypeScript/browser
consumers, full 39-extension portable lifecycle and final extension package
assembly pass. The selected `Packages / WASIX Runtime` job is skipped, so the
final build gate correctly rejects it. This is another wildcard-needs status
condition despite both direct runtime/AOT producers succeeding. The follow-up
uses explicit successful named producer checks. No failed run is qualified or
used as publication evidence.
