# PR #202 refresh onto September 27 main

Base: `df2b112e866f8ea76d320d7b3e172cf7be764177`. Source of the earlier
correctness work: `41c74d85dd0114935ae751807049ea6c6acf4756`.
This is a selective port, not a restoration of the earlier repository layout.

## Product changes

- Retire the 13 embedded WASIX patches documented in
  [the patch ledger](WASIX_PATCH_STACK.md). Replace unsafe recovery boundaries
  together with the Rust/browser host ABI, rather than deleting recovery alone.
- Preserve trusted session identity, native process boundaries, checked entropy,
  bounded output and error/terminal-session handling from the correctness work.
- Stop adding native `-F`; the default no longer disables PostgreSQL fsync.
  This is a durability correction, not a write-latency optimization.
- Use strict-memory `llvm-opta-ro_ftable` AOT artifacts. Old artifacts fail
  validation and must be rebuilt. Do not rename or relabel old payloads.
- Split the Postmaster Wasmer/libc patch stacks while preserving main's extracted
  first-party executor. Keep compiler-policy corrections separate from the
  equivalent patch decomposition.
- Preserve main's extension/resource loading, seedless browser startup and
  shared-worker clock changes. Keep the current source manifests and build graph.
- Reuse existing owner checks; do not restore the old global source-grep policy
  machinery or duplicate the existing compiled bridge ABI test.

The [resource budget inventory](../maintainers/runtime-resource-budgets.md)
explains stack, buffer and capture limits. The September stack-safety packet
remains historical review material, not a newly enabled production stack guard.

## New dependency experiments: deliberately separate

The production Wasmer and browser-host pins are unchanged.

- [Wasmer 7.4.2 / WASIX 0.704.2](wasmer-engine-evaluation-20260927.md): isolated
  LLVM/AOT, exception recovery, memory growth, WASIX initialization and real host
  module tests passed. Worth a separate full SDK/guest compatibility and paired
  workload experiment; no performance win, Windows fix or stack-exhaustion fix
  has been established.
- [JavaScript SDK 0.18.0](wasmer-sdk-evaluation-20260927.md): published packages
  ran actual SQL and large local browser transfers. Its command-only API and
  missing supported JavaScript database-storage mount contract prevent a direct
  replacement of the current embedded browser host. The tested PostgreSQL
  package is Oliphaunt-derived, not ElectricSQL PGlite.

Do not fold either dependency migration into the correctness port merely
because these small probes pass.

## Evidence and remaining qualification

Completed source-level checks include strict replay of all 22 Native and 31
embedded WASIX PostgreSQL patches, all 27 browser-host patches, and the nine
Wasmer/eight libc Postmaster patches on their pinned sources. The first eight
split Wasmer patches preserve main's 129 file diffs; the strict-memory correction
is separate.

The Postmaster owner's Moon test/lint passed, including carrier/receipt,
crash/lifecycle fixtures and four host-C/C++ probes. The port also fixes an
earlier preparation bug: reversing overlapping patches individually is not a
valid test that the final series is applied. The builder now reuses its existing
prepared-tree receipt validation. A fresh Postmaster engine/libc/guest/carrier
build and concurrent runtime qualification are still required.

Focused runtime-owner checks exercise the actual compiled C bridge, entropy
failure loop, nested-checkout patch application, session reset and lifecycle.
The TypeScript suite passed 357 tests. Rust host tests passed with and without
tool execution; the AOT serializer and carrier tests reject stale profiles.

The production browser-host build and its staged ABI/type check passed, with
input/provenance digest
`6adf3079ff1f96bcbd3f9725f614b93f63f48df50c080ce7ddf223fa025fe01a`.
Its retained output is `target/oliphaunt-wasix-ts/host/wasmer-sdk`.

Fresh Linux native core compilation and the canonical C smoke passed, including
default `fsync=on`, event triggers, reopen, streaming and COPY. The process-boundary
probes also passed: host signals/masks/timer survive CPU/sleep timeout, cancellation
and incomplete COPY; working-directory restoration and early/late startup failure
cleanup are exercised. The initial CWD probe incorrectly created its temporary
directory inside a managed root; the probe was corrected, without weakening
runtime admission, and the complete smoke reran successfully.

Fresh native broker integration also passed the configured-identity/session-policy
regression and all three wire-protocol integration tests. This exposed and fixed
one additional integration bug: an omitted startup `application_name` must retain
the role default, while explicitly empty/nonempty values override it. The
regression covers all three cases. SDK and broker library suites passed 108 and
three tests respectively; formatting and all-target Clippy passed.

Artifacts are retained in `target/liboliphaunt-pg18-linux-x64-gnu/{out,install}`;
the local build and smoke logs are
`/tmp/oliphaunt-native-refresh-{build,smoke}-20260927.log`. This does not prove
Windows/macOS behavior or crash durability.

Fresh WASIX ICU, core, plpgsql, snowball and initdb builds passed, followed by
runtime staging, portable packaging and strict generated-asset checks (14 source
pins, canonical layout, source fingerprint and archive/module hashes). The core
hash matches the retained corrected September guest byte-for-byte; no old guest,
initdb or seed was substituted in this build.

Fresh Chromium 148 tests passed against that package and the rebuilt production
browser host: seedless startup in memory, IndexedDB and OPFS; repeated syntax and
division errors followed by successful queries; nested PL/pgSQL exception
recovery; 1,000 inserts; streamed COPY; a throwing output callback followed by
successful reuse; and 1,000 rows preserved through IndexedDB/OPFS close/reopen.
The configured-identity fixture also passed across direct/worker/direct reopen,
including RESET ROLE, DISCARD, role settings, login triggers, NOLOGIN rejection
and rejected superuser escalation.

Evidence: `target/refresh-browser-probe/result.json`. Portable assets:
`target/oliphaunt-wasix/assets`. Archive SHA256:
`91177f594f3de73c1b1485dacb2fd1728a55a2ec7beed4df82f0516c3506dc33`.
Core SHA256:
`ecb76dd754d25b2efd0c5acddc7b9b760c7b70e659eb5c4b1d568f5480a701b1`.

Fresh strict Wasmer 7.2.1 AOT for core, plpgsql, snowball and initdb passed
canonical packaging/hash validation. Matching Rust consumer checks passed seven
PostgreSQL regressions and all 17 existing runtime cases. An unnecessary
file-wide `extensions` gate had silently excluded the runtime suite from the
core-only owner task; it is removed. A new eighteenth runtime case separately
passed actual COPY OUT in memory and directory modes: 10,000 exact rows, callbacks
bounded to 64 KiB, ReadyForQuery completion, and successful reuse after a callback
failure. New-test formatting and Clippy passed.

AOT assets: `target/oliphaunt-wasix/aot/x86_64-unknown-linux-gnu`.
Retained serializer/input/raw/compressed proof:
`target/strict-aot-probe-20260927`. Consumer logs:
`target/refresh-evidence/rust-core-smoke.log` and `rust-copy-smoke.log`.

Required cross-platform and Postmaster runtime checks remain separate; this is
not release qualification. Historical September benchmark numbers do not measure
this refresh or either newer Wasmer experiment.

Required follow-through:

1. Extend these checks to the complete extension/resource and supported-platform
   matrix, including a freshly built concurrent Postmaster carrier.
2. Screen representative query/INSERT/COPY/OLTP performance against current
   main under matched durability settings. Report correctness costs explicitly.
3. Qualify Wasmer 7.4.2 separately. Keep the JavaScript SDK migration parked until
   a supported persistent-storage and embedding/command contract is chosen.
4. Windows/MSVC Sys exception recovery remains a merge blocker for the complete
   supported matrix. Cooperative early stack exhaustion and Postmaster signal-mask
   semantics are also unresolved runtime work, not benefits of this refresh.
