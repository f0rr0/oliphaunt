# Patch correctness consolidation — 2026-09-07

This is a main-based integration of completed patch work, not the research tree,
an exact-release qualification, or a new performance-parity claim. Unfinished
work and acceptance criteria are tracked in [issue #201](https://github.com/f0rr0/oliphaunt/issues/201).

## What lands

| Area | Product change |
| --- | --- |
| Native PostgreSQL/C | Restore trusted embedded-session semantics, startup admission/cleanup and working-directory restoration; isolate cancellation, wakeups, timers and COPY deadlines from the embedding process; preserve current ABI 10 and error/lifetime handling. |
| Embedded WASIX PostgreSQL | Replace host-longjmp symptom handling with live guest-local recovery boundaries and typed outcomes; model the actual standalone topology; defer checkpoint execution to a safe point; use checked entropy. |
| Rust and browser hosts | Match the guest ABI, distinguish ordinary output streaming from COPY, enforce signed flush failures and bounded owned output, reject unsafe reuse after terminal guest faults, and preserve current public callback-abort/drain behavior. |
| Native and WASIX tool APIs | Bound aggregate captured stdout plus stderr to 64 MiB; report sticky overflow/allocation failures rather than truncated success. Streaming APIs remain the path for larger output. |
| AOT | Stop promoting nonvolatile-memory code generation. Use the fixed strict-memory/read-only-funcref profile `llvm-opta-ro_ftable`; keep producer cache, manifest and carrier identities consistent. |
| Postmaster | Remove inert patch material, repair scoped libc/runtime correctness issues and document the seven-patch PostgreSQL series. This does not qualify the entire inherited Wasmer/libc bundle. |
| Patch maintenance | Ordered strict replay, patch-local rationale, retirement decisions, shared ABI checks and focused regression tests. No experimental benchmark framework is required by product builds. |

The previously merged seek, protocol parsing, JSONB and WAL-sync improvements
remain on main and are preserved here. The obsolete pre-N-API Node filesystem
prototype is not reintroduced.

## What was actually removed

These are embedded WASIX patch numbers, not Native or Wasmer patch numbers.
Numbers remain reserved so earlier experiments stay traceable.

| Retired patches | Reason |
| --- | --- |
| 0013, 0020 | Host-recovery symptom patches are superseded by live guest-local recovery; retaining a returned frame's exception boundary was unsafe. |
| 0014 | The selected compiler already emits the intended unaligned hash load; no isolated residual win justified the fork. |
| 0015 | Current-XID shortcut lacked a demonstrated isolated benefit. |
| 0016, 0026 | int4 B-tree shortcuts did not prove the active comparator identity and could bypass custom opclass semantics. |
| 0017 | Large stack scratch changed allocation/failure behavior without an earned performance benefit. |
| 0024 | LIKE byte searching was incorrect at non-UTF8 multibyte boundaries; repairing it did not establish an earned optimization. **The LIKE patch is removed, not retained with a fix.** |
| 0028 | The semaphore-reset shortcut did not preserve upstream semantics. |
| 0030 | Cached WAL-segment arithmetic had an endpoint overflow; correcting it did not establish a worthwhile speedup. |
| 0031 | Removing activity reporting discarded behavior without adequate justification. |
| 0035, 0036 | Scalar replacements for PostgreSQL synchronization lacked both complete observer-exclusivity proof and an isolated performance win. |

See the maintained [WASIX patch review](WASIX_PATCH_STACK.md), the patch-local
commit messages, and the experiment disposition file under the WASIX PostgreSQL
build inputs for the individual rationale. Rejected CRC and lazy-globals
experiments are not promoted and are not mandatory future work.

## Consumer and build implications

- Rebuild the guest and hosts together: the typed recovery/startup and output
  contracts intentionally reject incompatible old guests rather than guessing
  how to recover them.
- Rebuild AOT and tool AOT with the strict profile. Old `llvm-opta` profile
  manifests must not be relabelled. The underlying Wasmer compiler identifier
  and historical artifact filename suffix remain `llvm-opta`; the product
  profile identity is separate.
- No new public runtime environment flags are introduced. Legacy conflicting
  compiler overrides fail closed instead of silently enabling unsafe codegen.
  Current ICU/seed configuration is preserved; its experimental replacement is
  deferred as a complete change, not partially ported.
- A callback abort may be returned after the guest has drained the operation;
  a subsequent guest failure takes precedence. A terminal guest failure means
  the session cannot be reused.
- Native's existing `-F`/`fsync=off` default is unchanged. Explicit
  `-c fsync=on` is required for durable-storage qualification; successful
  functional reopen does not prove crash durability.
- Embedded and Postmaster cannot safely become the same runnable binary by
  adding an environment flag. Their process model, imports, lifecycle and
  recovery assumptions differ. Share safe build inputs where useful, not a
  misleading runtime switch.

## Qualification boundary

Focused source checks and fresh-build runtime results are recorded in the PR.
The core-only `assets verify-committed` gate passes with the existing
`OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1` build flag; default full-catalog
validation remains intact. Fresh standard and ICU cluster seeds have also
completed their producer/profile probes.
The local fast path uses cached third-party dependencies and keeps final
artifacts/evidence. It does not stage the research harness, historical binaries
or producer trees in Git.

The local Moon affected-task query is blocked by installed proto 0.57.5 versus
the Rust plugin's minimum 0.60.0; explicitly invoked task commands are not a
claim that the Moon graph gate passed. The complete prepared-source catalog
check also needs extension sources outside the deliberately core-only build.

Exact-candidate performance remains an explicit follow-up. Earlier compound
candidate numbers cannot be attached to this integration, and strict-memory
correctness is not represented as performance-neutral. Broad platform,
extension, crash-durability and release qualification are separate gates.
