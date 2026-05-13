# Copied Fork Continuation Design

## Goal

Support `proc_fork(copy_memory=true)` for WASIX modules in a way that is
generic enough for upstream Wasmer and strong enough for PostgreSQL's native
process model.

The runtime pieces are mostly separable:

- clone or recreate the Wasm instance group;
- copy private linear memory;
- replay `MAP_SHARED | MAP_FIXED` mappings at identical guest addresses;
- clone process state, file descriptors, wait state, and signal delivery;
- resume parent and child at the same guest call site with different return
  values.

The last item is the hard boundary. It is a continuation problem, not a dynamic
linking problem.

## Current State

Wasmer has an existing copied-fork path based on logical stack rewind. The
original backend is Asyncify: the module exports `asyncify_start_unwind`,
`asyncify_stop_unwind`, `asyncify_start_rewind`, and
`asyncify_stop_rewind`, and the WASIX runtime stores the logical stack plus
globals before resuming parent and child.

The local runtime/compiler patch adds a native LLVM continuation backend for
EH/PIC modules. The compiler records fork continuation frames on direct calls
and signature-reachable indirect calls that can reach `proc_fork`, the VM
stores those frames in the instance state, and the WASIX runtime installs the
captured continuation into the copied parent and child instance groups. The
native LLVM backend captures empty operand-stack callsites broadly. For
non-empty operand stacks it currently captures only control-local prefixes:
active nested Wasm control frames must have entered with an empty stack prefix,
the function body must stay under the bounded hardening threshold, and only one
non-empty callsite is captured per function. This is a conservative dominance
guard. Earlier broad capture let a continuation-local base-stack load flow
through an unrelated merge predecessor in `pg_dump`; the current guard is
proven by the dynamic fork probes plus an LLVM verifier compile of `pg_dump`.
The longer-term upstreamable endpoint is explicit PHI repair for arbitrary
non-empty operand-stack continuations. The runtime also extends the
instance-group side of copied fork to dynamic-main
modules, replays shared mmap mappings, and gives copied-fork children a
detached dynamic-linker coordination state. Thread-created instance groups still
share linker operations, but fork-created children can `dlopen` new side modules
without rendezvousing with a parent blocked in `waitpid`. The copied-fork path
creates and adopts child process state only after continuation capture succeeds.

The local wasix-libc patch exposes `fork()` and `_Fork()` for EH builds, using
the same WASIX `proc_fork(copy_memory=true)` syscall path as non-EH builds. The
`libc-eh-fork` probe proves that POSIX surface links and now succeeds with a
clean child wait under the patched runtime. This is an ABI cleanup; the
continuation machinery remains in the compiler/runtime boundary.

## Why Dynamic Linking Is Not The Blocker

`dynamic-dlopen` proves the production extension-loading shape: an EH/PIC
dynamic-main module can load a side module and call exported symbols. The
`dynamic-fork-dlopen` probe is separate because it composes dynamic linking with
copied fork, shared mmap replay, and child-side `dlopen`. It now passes under
strict dynamic mode. Wasmer's own `test_fork_dlopen` fixture adds the stronger
case: a child calls a function from a side module loaded before fork, then loads
a different side module after fork. `dynamic-fork-indirect` and
`test_fork_indirect` prove the same native continuation path through a
function-pointer callsite.

## Rejected Shortcuts

- Postgres-side fork bypasses: not generic and would hide runtime semantics.
- Asyncify in production: conflicts with the EH/PIC performance direction and
  is already rejected by the build profile unless explicitly enabled as an
  experiment.
- Host OS `fork()`: preserves native stack addresses, but is non-portable and
  unsafe in a multithreaded Rust runtime after arbitrary host state has been
  initialized. It also bypasses Wasmer's in-process WASIX process model.
- Raw coroutine stack copying: not sound in-process because native stack frames
  contain pointers to the old stack and store/runtime objects. The copied stack
  would need relocation that the runtime cannot infer.
- Guest `setjmp`/`longjmp` trampoline from a fresh entrypoint: not sufficient
  for Wasm EH/SjLj because the compiler-generated setjmp catch frames must be
  active on the current Wasm call stack.

## Upstreamable Direction

Introduce copied fork as a runtime operation over a generic continuation
backend:

1. The WASIX syscall validates that the current module has a fork continuation
   backend before forking observable state.
2. The backend captures a logical continuation at the syscall boundary.
3. The runtime clones process state, creates the copied instance group, copies
   private memory, and replays shared mappings.
4. The backend resumes the parent continuation with the child PID and the child
   continuation with zero.

Asyncify is one backend. The PostgreSQL lane now uses a native LLVM backend
that captures continuation frames without Asyncify. This belongs in the
compiler/runtime boundary rather than in PostgreSQL or libc alone.

## Near-Term Runtime Work

- Keep the dynamic instance-group copied-memory path generic and covered by
  focused tests.
- Keep the fork syscall guarded by a generic continuation capability check;
  any rejection must happen before observable child process state is adopted.
- Continue broadening upstream-style Wasmer tests beyond the current dynamic
  copied-fork fixtures.
- Add focused tests for copied fork returning an errno before process-state
  mutation when no continuation backend exists.
- Track native continuation hardening separately from dynamic linking and
  shared memory.
