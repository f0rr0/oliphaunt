# Patch correctness consolidation — 2026-09-07

This is a main-based integration of completed patch work, not the research tree,
an exact-release qualification, or a new performance-parity claim. Unfinished
work and acceptance criteria are tracked in [issue #201](https://github.com/f0rr0/oliphaunt/issues/201).

## What lands

| Area | Product change |
| --- | --- |
| Native PostgreSQL/C | Restore trusted embedded-session semantics, startup admission/cleanup and working-directory restoration; isolate cancellation, wakeups, timers and COPY deadlines from the embedding process; preserve current ABI 10 and error/lifetime handling. |
| Embedded WASIX PostgreSQL | Replace host-longjmp symptom handling with live guest-local recovery boundaries and typed outcomes; model the actual standalone topology; defer checkpoint execution to a safe point; use checked entropy. Initialize the host-selected catalog role during startup, with normal admission, role/database settings and login triggers. |
| Rust and browser hosts | Match the guest ABI, distinguish ordinary output streaming from COPY, enforce signed flush failures and bounded owned output, reject unsafe reuse after terminal guest faults, and preserve current public callback-abort/drain behavior. |
| Native and WASIX tool APIs | Bound aggregate captured stdout plus stderr to 64 MiB; report sticky overflow/allocation failures rather than truncated success. Streaming APIs remain the path for larger output. |
| AOT | Stop promoting nonvolatile-memory code generation. Use the fixed strict-memory/read-only-funcref profile `llvm-opta-ro_ftable`; keep producer cache, manifest and carrier identities consistent. |
| Postmaster | Remove inert patch material, repair scoped libc/runtime correctness issues and document the seven-patch PostgreSQL series. Replace the inherited monoliths with eight Wasmer and seven libc logical patches that produce exactly the original applied trees; add separate strict-memory compiler policy and single-evaluation `sigsetjmp` corrections. Full corrected-profile runtime qualification remains distinct from clean replay. |
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
- WASIX now initializes the configured role as the actual session principal,
  not a later `SET ROLE` under a bootstrap-superuser session. `RESET ROLE` and
  `DISCARD ALL` retain the intended principal; role/database defaults and login
  policy apply before accepting queries. Rust direct/proxy and browser
  direct/worker paths share this guest behavior, so their late-role workarounds
  are deleted. The host still authenticates/selects the principal: this is not
  HBA authentication, and `system_user` does not invent an authentication
  provider. Rust startup rejection exposes PostgreSQL SQLSTATE/details while
  retaining the original response bytes for proxy clients.
- Native no longer silently adds `-F`: PostgreSQL's `fsync=on` default is
  preserved. An explicit PostgreSQL `fsync=off` setting remains available for
  disposable data. This can increase durable-write latency; functional reopen
  still does not prove crash durability. Fresh Linux ICU direct and installed
  broker tests cover both default-on and explicit-off behavior.
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

The repository-pinned Moon toolchain now runs locally: affected-project
resolution, the complete SDK contract task and graph unit tests passed.
The complete prepared-source catalog check still needs extension sources
outside the deliberately core-only build.

The subsequent configured-identity guest passed fresh standard and ICU seed
creation, strict AOT packaging/validation, and strict replay of all **31 WASIX,
22 Native and 7 Postmaster PostgreSQL patches**. On fresh guest/AOT artifacts,
Rust passed **211 library tests, 19 runtime tests, 7 proxy tests and 7 PostgreSQL
regressions** with the `extensions` feature. This count has a different feature
scope from the initial tools-enabled unit/API run; it is not a loss of tests.
Actual Chrome memory/IndexedDB tests cover recovery and COPY, plus configured
identity across direct/worker reopen, login triggers, session reset, rejected
superuser escalation and NOLOGIN rejection. The TypeScript suite passed all
343 tests in 36 files, with binding and example typechecks.

The AOT-enabled build tool now reuses its own selected serializer executable,
instead of rebuilding a shared bare `xtask` path that another worktree can
replace. The regression check and Clippy cover the serializer-enabled path;
the ordinary bootstrap path remains available. Retained benchmark binaries
are checked against their embedded portable/AOT payloads and source identities,
not merely a filename or a Cargo freshness message.

## Measured performance boundary

The frozen initial integration `34f173f6` was compared with main `e8192180`
under the **same strict-memory profile**. Nine substantial workloads, memory
and directory storage, balanced ordering and main A/A controls produced 324
accepted independent children. Fifty-four known-interference records were
replaced as complete balanced blocks; the originals were retained, not pooled.
Every accepted directory run verified `fsync`, `synchronous_commit` and
`full_page_writes` were on. Memory deliberately had `fsync=off`.

| Directory workload | Main median | Initial integration median | Median paired ratio |
| --- | ---: | ---: | ---: |
| Raw Rust query RTT | 7.386 us | 7.707 us | 1.045 |
| 250k narrow temporary INSERT | 115.2 ms | 124.9 ms | 1.107 |
| 250k wide temporary INSERT | 330.7 ms | 312.5 ms | 0.938 |

The RTT cost was consistent across six pairs; narrow INSERT was noisy and is a
warning, not a precise regression estimate. Its change was in the INSERT body,
not commit, and the table is temporary: WAL-sync weakening is not a remedy.
The wide INSERT win was consistent, but this compound comparison cannot assign
credit to one patch. Other workload changes were mostly small relative to the
controls. These numbers do **not** measure the later configured-identity guest,
the Native durability change, browser/Node SDK overhead, or main's unsafe
as-shipped compiler profile.

### Final configured-identity screen

All **220 independent children passed**: six balanced replicates for the two
earlier warning cases against main/prior/final, four balanced replicates for
seven other cases against prior/final, and two stock PostgreSQL 18.4 replicates
per case/storage mode. Loads were 250k INSERT/COPY/prepared rows, a 500k-row
indexed fixture, one million JSONB constructions and 500 mixed OLTP cycles.
Internal RTT/read samples are not counted as independent process replicates.

The final identity fix matches the prior corrected candidate's RTT and narrow
INSERT. Against strict main, paired RTT costs remain **3.5% memory / 2.3%
directory**, around 0.25–0.29 us. The historical 10.7% narrow-directory warning
was not reproduced (final/main +1.8% here), but is not erased. New warnings
against the prior candidate are wide temporary INSERT **+5.1% memory / +4.2%
directory**, memory logged wide INSERT +2.6%, and directory JSONB +3.2%.
Mixed OLTP is essentially unchanged. These small-sample warnings preclude a
blanket non-regression claim.

Stock-server context below is **descriptive, not paired cross-engine proof**.
Times are milliseconds except RTT/read microseconds and mixed milliseconds per
cycle. The stock server uses a local Unix socket; in-process WASIX RTT/read wins
include that transport difference, not evidence of a faster SQL executor.

| Case | PG memory | Final WASIX memory | Ratio | PG directory | Final WASIX directory | Ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Query RTT (us) | 49.729 | 7.707 | 0.155 | 40.581 | 7.731 | 0.191 |
| Narrow temporary INSERT | 72.412 | 101.909 | 1.407 | 70.691 | 115.739 | 1.637 |
| Wide temporary INSERT | 194.630 | 313.677 | 1.612 | 201.612 | 322.388 | 1.599 |
| Logged wide INSERT | 288.449 | 440.928 | 1.529 | 402.775 | 563.520 | 1.399 |
| Prepared multirow INSERT | 322.282 | 496.079 | 1.539 | 463.954 | 619.778 | 1.336 |
| COPY | 204.539 | 241.827 | 1.182 | 273.241 | 321.313 | 1.176 |
| Indexed read (us) | 69.929 | 24.141 | 0.345 | 70.125 | 25.709 | 0.367 |
| JSONB | 1722.288 | 1585.289 | 0.920 | 1808.254 | 1700.663 | 0.941 |
| Mixed OLTP (ms/cycle) | 3.062 | 4.140 | 1.352 | 3.812 | 5.772 | 1.514 |

All 220 reports verified actual settings: memory `fsync=off`, directory
`fsync=on`, and both modes `synchronous_commit=on`, `full_page_writes=on`.
Directory work used ext4; the stock memory control used tmpfs. The window was
2026-09-07 23:38:19–23:48:25 UTC, with equal CPU affinity 4,15 and team builds
paused. An unrelated Next.js server and shared-host activity remained: these
were not reserved cores or perfect isolation. No samples were discarded.
The earlier screen was unpinned and must not be pooled with this one.

The final retained executable SHA256 is
`93ddccec253eb6f3c059799d15d544cb0f09d195da1adac7899cd19dbe82ef89`;
guest `ecb76dd754d25b2efd0c5acddc7b9b760c7b70e659eb5c4b1d568f5480a701b1`;
raw AOT `c392b9b37c7af1ee3bcd8040c33238b5639034fb4020dfe8e1ea31f5a1d3aed6`.
It contains the final W0044/Rust-host source over `51789da1`, not the unchanged
base commit. Exact embedded payload/source checks and all raw reports remain
in the retained research evidence (`results/w0044-final-20260907.md` and its six
result directories), outside product build inputs.

### Wide-workload profiling

Four completed prior/final ABBA captures collected 45,283 user-CPU samples from
the unchanged retained strict AOT payloads. Existing Wasmer function extents
provided diagnostic address maps without recompiling the guest or switching
engines. These instrumented timings are not additional benchmark replicates.

The SQL constructs its payload with `repeat(chr(97+(g%26)),96)`. Exact guest
disassembly and error-location strings identify PostgreSQL `repeat` as the
caller of approximately 98% of sampled imported-memory-copy calls. Its loop
performs 96 one-byte copies per row. The imported helper accounts for 24.02%
of prior and 27.34% of final self samples; `pgstat_count_heap_insert` accounts
for only 0.46% and 0.45%. The wide case therefore measures substantial string
construction, not just tuple insertion.

Both guests have the same repeat loop. This identifies a shared optimization
target, **not the cause of the final/prior +5.1% warning**. Sample shares alone
cannot establish extra operations or rule out layout effects and noise. A
general cancellation-safe repeat improvement warrants a bounded experiment,
keeping the original workload alongside payload-construction controls. No
new optimization is promoted on profiling evidence alone.

Raw profiles and exact payload/source attribution remain outside product
inputs in the retained `oliphaunt-profile-20260908/REPORT.md` evidence. The
user-authorized temporary profiling setting was restored immediately after
capture (`kernel.perf_event_paranoid=4`); no persistent setting was changed.
Disabling correct identity, statistics, atomics or durability is not a remedy.
The roughly **1.4–1.6x stock-server INSERT gap remains unresolved**.

## Newly established Postmaster limitation

Libc's signal-jump macro now evaluates each argument once while retaining the
live caller's jump frame. C/C++ host execution at O0/O2 rejects the old macro
and passes the corrected one. Actual C/C++ Wasm O2 probes also pass on a newly
built strict-memory Wasmer LLVM runner, using the updated header and helper
objects over the retained EH sysroot. These are focused checks, not a rebuilt
sealed Postmaster carrier. The Postmaster source/shell unit suite and lock
verification pass; inherited memcmp checks cover independent alignment, all
byte positions and protected-page ends at O0/O2 without claiming a speedup.

This does not repair libc's underlying signal-mask
backend: pinned WASIX `pthread_sigmask` returns success without implementing
masks, `sigpending` returns `EINVAL`, and handler `sa_mask` is ignored. The
capability inventory now explicitly marks POSIX signal masks **unsupported**.

This inherited gap matters to PostgreSQL startup/fork masking, nested SIGQUIT
protection and saved-mask error boundaries. It is not an observed corruption
claim, nor a new regression introduced by splitting the patches. A correct fix
requires guest/host mask and pending-signal state, deferred delivery/unblocking,
handler masking and restoration semantics, followed by PostgreSQL stress tests.
A libc-only variable would not prevent Wasmer from delivering blocked signals.
The small macro fix and host-mask adapter tests must not be advertised as that
larger fix. See the runtime patch README and issue #201 for the concrete scope.

## Newly established embedded Rust WASIX timeout limitation

A long CPU-bound repeat accepted `statement_timeout=2ms` but returned normally
on both the retained baseline and the repeat experiment. Native PostgreSQL's
equivalent probe returned SQLSTATE `57014` and reused the connection. The
public Rust SDK and usage documentation now distinguish accepting a GUC from
enforcing its deadline; timing out a caller future does not stop guest work.

The exact consumed EH libc object reads `it_interval`, whereas PostgreSQL
sets the one-shot `it_value` and leaves the interval zero. The consumed Rust
runtime additionally interprets the nanosecond argument as milliseconds, does
not honor the stored one-shot flag at dispatch, and only dispatches intervals
at syscall pending-operation boundaries. A libc-only fix cannot interrupt pure
guest CPU work. Issue #201 records the separate setup, one-shot and owned
cooperative-interruption work and actual-guest acceptance criteria. This is
inherited behavior, not a regression introduced by the repeat experiment or
evidence that the retired patches should return.

Broad platform, extension, crash-durability and release qualification remain
separate gates. No PostgreSQL performance-parity claim is made.
