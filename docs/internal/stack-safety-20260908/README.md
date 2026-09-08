# Execution-stack safety candidate

Status: **implemented and locally tested, not enabled in consumer packages**.
This review packet preserves the actual candidate patches and regression probes.
It is deliberately outside every production patch series. Do not mistake its
presence in PR #202 for a fix shipped to Rust, N-API, browser or Windows users.

## Changes and application order

| File | Apply from | Purpose |
| --- | --- | --- |
| `0001-wasmer-vm-stack-accounting.patch` | Wasmer `lib/vm` | Active native SP accounting, nested/trap restoration, guard-page exclusion, 64 KiB exception-entry floor, VM tests |
| `0002-wasmer-fixed-stack-query.patch` | Wasmer `lib/api` | One trusted scalar binding; reject unsupported accounting at construction |
| `0003-postgres-check-execution-stack.patch` | PostgreSQL source root after our WASIX series | Keep PostgreSQL's existing check and add a 512 KiB early execution-stack reserve |
| `0004-rust-register-stack-query.patch` | Oliphaunt repository root | Register the experimental import through the patched runtime |

Wasmer base: published 7.2.1 crates, upstream commit
`c14032594b893b40e9b71456d504cf55c141c8f6`. PostgreSQL base: 18.4 with the
Oliphaunt WASIX series at `3ed64471`. Rust registration base: `3ed64471`.
The patches target different repositories/crates; they are not one PostgreSQL
series. Each passes `git apply --check` from its stated base.

The shared VM accounting reads the actual machine stack pointer, not an address
on the separate host stack or a sanitizer's fake stack. Bounds exclude guards
and excess pooled capacity. Their restoration lives on the parent stack so a
guest trap cannot skip it. Ordinary host calls do **no new snapshot bookkeeping**.
The successful fixed query allocates nothing, takes no lock, invokes no user
callback, and does not switch stacks. The hard guard is at exception entry,
not every Wasm function call.

PostgreSQL can raise normal SQLSTATE `54001` at its earlier check. Missing
accounting or reaching the engine hard reserve instead terminates the invocation;
neither is disguised as a recoverable zero-byte budget. Cold-path trace capture
runs on the parent stack and does not preserve a complete guest trace.

No stack enlargement, environment flag, parser replacement or durability change.
The engine remains at its **1 MiB** default. The 512 KiB application reserve and
64 KiB engine floor serve different purposes and remain experimental margins,
not universal proofs of safety.

## Focused checks retained with the code

- VM tests are included in patch 0001: **62/62 debug and 62/62 release** passed,
  single-threaded. Includes injected missing accounting, nested hard traps,
  restoration after panic, usable capacity and host-query unavailability.
- Baremetal compile check passed; capability is false there. This is not a
  baremetal execution or Windows qualification result.
- `binding-check.rs`: **1,000 cycles each** of scalar typed/dynamic ABI and
  nested host/guest restoration.
- `postgres-recovery.rs`: real PostgreSQL memory/directory tests. Deep valid and
  invalid JSON, expressions and PL/pgSQL at `max_stack_depth=100kB` and `2MB`
  produced `54001`; subsequent queries, caught errors and savepoint rollback
  worked. Directory close/reopen preserved committed data.
- `probe/`: serialized LLVM AOT, **100 deep throw/catch and catch_ref/throw_ref
  cycles**. A subsequent unchecked descent produced terminal `StackOverflow`
  after 1,024 extra frames. No PostgreSQL reuse is promised after an engine trap.

For the standalone engine probe, place this packet in a directory beside a
Wasmer checkout named `wasmer`, checkout the stated commit, and apply patches
0001 and 0002 in their crate roots. The probe manifest uses those sibling paths.
Run `cargo run --manifest-path probe/Cargo.toml --release`, with the matching
LLVM 22 installation configured as required by Wasmer. Run VM unit tests from
`wasmer/lib/vm` with `cargo test --lib -- --test-threads=1` and `--release`.
`binding-check.rs` can replace the probe's main source for its ABI check.
The PostgreSQL probe additionally needs `anyhow`, the patched `oliphaunt-wasix`
SDK, the guarded guest and matching AOT; it is not runnable against released
packages. Its default is memory; a positional fresh directory checks reopen.
The optional `--stack-mib` argument is diagnostic-only, unused in these results.

## Performance evidence

Linux x86_64, same PostgreSQL guest/AOT in both binaries, same SDK sources and
dependency versions. The comparison is **previous direct-binding candidate
versus hardened candidate**, not production main or an unguarded runtime.
Six cases × four balanced process pairs × two storage modes: **96/96** successful
children. Compilation and functional tests finished before scored timings.

| Case | Memory, direct → hardened | Directory, direct → hardened |
| --- | --- | --- |
| Query RTT | 7.927 → 7.722 µs (−2.6%) | 8.077 → 7.812 µs (−3.3%) |
| Prepared multirow INSERT | 511.576 → 518.980 ms (+1.4%) | 626.873 → 631.672 ms (+0.8%) |
| Indexed point query | 25.023 → 25.103 µs (+0.3%) | 27.271 → 27.091 µs (−0.7%) |
| JSONB construction | 1664.702 → 1647.965 ms (−1.0%) | 1782.054 → 1749.022 ms (−1.9%) |
| Temporary INSERT | 105.033 → 98.870 ms (−5.9%) | 117.060 → 126.621 ms (+8.2%) |
| COPY | 227.801 → 233.910 ms (+2.7%) | 315.020 → 321.797 ms (+2.2%) |

The initial directory warning prompted **eight additional pairs per case** for
RTT, temporary INSERT and COPY: **48/48** successful children. RTT was 8.107 →
7.817 µs (−3.6%, 8/8 pairs faster); temporary INSERT 111.361 → 113.268 ms
(+1.7%, 3/8 faster); COPY 307.787 → 301.735 ms (−2.0%, 5/8 faster).
The large temporary-INSERT penalty did not repeat. Its follow-up paired interval
crosses parity (0.964–1.063), as does COPY (0.954–1.010). Small execution costs
remain uncertain; do not claim universal non-regression or discard the first run.
These are process-serialized measurements on a shared, not reserved, machine.

SHA-256 provenance for retained artifacts:

| Artifact | SHA-256 |
| --- | --- |
| Direct benchmark | `96319e8e95ef3295d584075437c75494f0f02dd9dd9ab08f37ccbcf89d82da55` |
| Hardened benchmark | `962170bf38acdffdc094ca733ef879ce2d2b45358f00391cbf5b7cf4b7d2dade` |
| Guarded guest archive, embedded in both | `818b594a5d1787fafe774f6f720bd26dd1e94157e5b35d11e66eb3d9572bc09f` |
| Guarded LLVM AOT archive, embedded in both | `8c8e6658ad0a0476ec7f5a4f3fffd09fdeba83822fe5ed82caef176df94e32f7` |

Full per-process reports, binaries, exact Cargo locks and producer state remain
in the retained `oliphaunt-stack-hardened-20260908` local experiment, not this PR.
No exact-head CI, full pg_regress, extension or release claim follows from these
focused checks. Main's consumers do not gain this protection from a review packet.

## Required before enabling

1. Settle and consume the Wasmer VM/API contract. Coordinate with upstream
   [PR #6913](https://github.com/wasmerio/wasmer/pull/6913), which proposes a
   related exception-entry guard. No upstream approval is implied here.
2. Qualify recovery margins across compilers, architectures and error cleanup;
   retain a terminal failure when early recovery cannot be guaranteed.
3. Resolve Windows engine exception support and provide a separately supported
   browser contract or deliberately separate artifact ABI. This binding's
   mechanism covers Unix x86_64/AArch64; execution evidence here is Linux x86_64.
4. Integrate dependency pins, guest import and artifact invalidation together,
   then run the affected product gates. Do not activate only patch 0003 or 0004.

Architectural precedent: PostgreSQL's early stack check and its historic
[independent IA64 register-stack check](https://github.com/postgres/postgres/commit/faa90079839343e7b350c869b45f496ea3e9a05c).
See also [CPython stack protection](https://github.com/python/cpython/blob/main/InternalDocs/stack_protection.md)
for the distinction between recoverable soft limits and terminal hard limits.
