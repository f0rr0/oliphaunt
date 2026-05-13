# Upstream WASIX Runtime Work

This subtree tracks the source inputs for the Wasmer and wasix-libc blocker
work needed by the fresh PostgreSQL/WASIX experiment.

## Contents

- `bin/build-patched-wasix-libc-sysroot.sh`: rebuilds local wasix-libc variants
  and overlays them into an ignored wasixcc sysroot copy.
- `bin/record-code-grounding.sh`: records code-grounding evidence from local
  Wasmer and wasix-libc source trees.
- `bin/run-blocker-probes.sh`: compiles and runs focused WASIX probes.
  Pass `--probe NAME` to run a single probe while iterating; filtered runs use
  per-filter compile signatures and only rebuild selected probe artifacts.
- `bin/run-upstream-checks.sh`: runs the local Wasmer/libc/probe loop.
- `capabilities.tsv`: source-of-truth ledger mapping each claimed capability to
  exact code paths, local/upstream basis, probes, and PostgreSQL behavior.
- `copied-fork-continuation.md`: code-grounded design note for the generic
  copied-fork continuation boundary.
- `probes/`: C probes that reproduce PostgreSQL-relevant runtime/libc
  behavior. `libc_eh_fork_probe.c` proves the standard libc `fork()` surface
  for EH/PIC builds. `dynamic_dlopen_probe.c` is the strict dynamic
  extension-loading gate. `dynamic_fork_dlopen_probe.c` is the active decision
  probe for copied fork plus dynamic linker plus shared-memory composition.
  `dynamic_fork_indirect_probe.c` proves copied fork through an indirect
  function-pointer callsite. `rlimit_stack_probe.c` proves libc exposes the
  runtime-owned finite `RLIMIT_STACK` so C programs can set recursion guards
  below the runtime host-stack limit.
- `patches/wasmer/`: exported local Wasmer WIP patch set.
- `patches/wasix-libc/`: exported local wasix-libc WIP patch set.

## Ignored Work Roots

The scripts use these ignored paths by default:

- Wasmer checkout and build:
  `assets/wasix-build/work/upstream/wasmer`
- wasix-libc checkout and build:
  `assets/wasix-build/work/upstream/wasix-libc`
- patched sysroot:
  `assets/wasix-build/work/upstream/build/patched-wasixcc-sysroot`
- compiled probe modules:
  `assets/wasix-build/work/upstream/build/probes`
- probe reports:
  `assets/wasix-build/work/upstream/reports`

Do not move compiled artifacts into this tracked subtree.

## Current Decision Point

The production dynamic-linking path is separate from copied fork. The
`dynamic-dlopen` probe proves an EH/PIC dynamic-main module can load and call a
WASIX side module, which is the extension-loading shape used by PostgreSQL.

The patched wasix-libc now exposes `fork()` and `_Fork()` in EH builds instead
of making fork a link-time absence. The `libc-eh-fork` probe now succeeds with
a child wait under the patched runtime.

The local Wasmer LLVM patch now lowers Wasm `i32/i64.rotl/rotr` through
`llvm.fshl/fshr` instead of open-coded shifts and ors. On Apple Silicon this
lets LLVM select `ror` for rotate-heavy code; the PostgreSQL `md5_calc` debug
dump proves 64 `ror` instructions in the hot function. This is a generic
compiler-quality fix, not a PostgreSQL shim. It improves the short warm md5
query repeat but the 5M md5 pass remains behind native, so further warm-path
work should continue in LLVM/memory/executor code quality and runtime overhead.

The patched runtime now exports a generic `proc_rlimit_get` WASIX syscall, and
wasix-libc routes `getrlimit()` through it. PostgreSQL uses that POSIX surface
to choose `max_stack_depth`; with an infinite limit it raises the default to 2
MiB and can exhaust Wasmer's host stack before PostgreSQL throws its own SQL
error. The Wasmer CLI reports a conservative runtime-owned `RLIMIT_STACK`
derived from its actual `--stack-size` and capped by the guest linear-memory
stack. The current PostgreSQL lane uses a 32 MiB Wasmer stack by default, which
reports a 4 MiB `RLIMIT_STACK` and lets PostgreSQL use its normal 2 MiB dynamic
default. The `rlimit-stack` probe and PostgreSQL `infinite_recurse` regression
now prove that stack-depth protection trips inside PostgreSQL.

The local Wasmer patch now wires copied-memory `proc_fork` through the dynamic
linker's instance-group machinery and replays shared mmap mappings into the
child group. Copied-fork children now get detached dynamic-linker coordination
state, so child-only `dlopen` does not rendezvous with a parent process blocked
in `waitpid`. The copied-fork path creates/adopts child process state only
after continuation capture succeeds. The `dynamic-fork-dlopen` decision probe
now passes under strict dynamic mode: an EH/PIC dynamic-main module can load a
side module, perform copied `proc_fork`, keep shared mappings at the same guest
address, and `dlopen` from the child. Wasmer's own `test_fork_dlopen` fixture
also passes for inherited side-module calls plus child-only side-module loads.
The `dynamic-fork-indirect` probe and `test_fork_indirect` also pass, proving
the native continuation can propagate through a signature-reachable indirect
callsite without serializing host call pointers. The local LLVM continuation
path captures non-empty operand-stack frames only when active nested control
frames have no pre-existing stack prefix; this keeps the continuation-local
resume values from escaping through unrelated merge predecessors. The full
blocker suite passed with `--strict --strict-dynamic` against release Wasmer
`b9ee4b3429d7a478b7078cde3352964720454cbc680e9fe0a67be016a69caf13`, and
`pg_dump` compiled with LLVM verifier under that same binary. Treat the
remaining coverage gaps as runtime/compiler test hardening and PostgreSQL
expansion work; do not work around them in PostgreSQL.
