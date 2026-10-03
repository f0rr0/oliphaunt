# WASIX PostgreSQL patch stack

The ordered patches live in
[`postgres/series`](../../wasix/runtime/postgres/series);
the PostgreSQL source pin lives in
[`source.toml`](../../third-party/postgres/source.toml).
Each patch header explains its change. The WASIX builder applies that series
before compiling the runtime.

Use the built runtime's protocol and extension tests for behavioral evidence.
Source fragments and generated review tables no longer gate qualification.
The concurrent Postmaster runtime has its own source, patches, and recovery tests.

## Retired patches

These embedded WASIX numbers remain reserved for traceability; they do not
identify Native or Wasmer patches. The selected series is authoritative.

| Numbers | Why they were removed |
| --- | --- |
| 0013, 0020 | Host-recovery symptom patches retained an exception boundary after its frame returned. Live guest-local recovery replaces them. |
| 0014 | The selected compiler already emitted the intended unaligned hash load; no isolated residual gain justified the fork. |
| 0015 | The current-XID shortcut lacked demonstrated isolated benefit. |
| 0016, 0026 | int4 comparison shortcuts did not prove active comparator identity and could bypass custom opclass semantics. |
| 0017 | Large stack scratch changed allocation ownership and recoverable failure behavior without an earned performance benefit. |
| 0024 | Byte searching could cross non-UTF8 multibyte character boundaries. The LIKE optimization is removed, not retained with an encoding fix. |
| 0028 | The semaphore-reset shortcut did not preserve PostgreSQL semantics. |
| 0030 | Cached WAL-segment arithmetic overflowed at an endpoint; a correction did not establish worthwhile speedup. |
| 0031 | Removing activity reporting discarded behavior without adequate justification. |
| 0035, 0036 | Scalar synchronization replacements lacked complete observer-exclusivity proof and an isolated performance win. |

Correctness removals and unearned optimizations are different decisions; neither
should be reversed merely to improve a compound benchmark score.

Guest recovery, startup identity and output contracts must be updated together
with the Rust and browser hosts. Patch 0044 establishes the host-selected catalog
principal before startup policy runs; a later `SET ROLE` is not equivalent.
