# Windows feasibility while retaining Wasmer and WASIX

Research snapshot: **October 5, 2026**. This record narrows the
[alternatives survey](windows-runtime-alternatives.md) to the existing WASIX
architecture. Execution coverage and release blockers remain in the
[integration ledger](windows-v8-integration.md).

## Conclusion

**Retaining Wasmer/WASIX is a feasible direction to investigate.** The strongest
evidence is the Windows V8 database diagnostic, plus a new local experiment
that constrains V8 CPU features without removing guest EH or SIMD. No examined
upstream fix supplies a complete portable, tool-free Windows AOT package yet.

The first candidate is a maintainer-owned V8 flag bridge, prebuilt bindings and
engine packaging, with a bounded family of matching caches if necessary. A
single portable cache profile would need additional engine work. Both preserve
the WASIX dynamic loader. Repairing Windows Sys is a larger, separate unwinder
and code-generation project; removing its build prohibition is insufficient.

Consumer requirements remain unchanged: the same dependency, features, SDK
APIs and extension behavior; no engine flags, Windows setup or guest compilation
by the application developer. Maintainer CPU/profile selection must stay inside
the SDK and package production.

## What WASIX already provides

WASIX's [dynamic-linking implementation and design](https://wasmer.io/posts/dynamic-linking-in-wasm-wasix)
include guest filesystem lookup, dependency loading, symbol resolution,
relocations, shared memory/function tables, thread-local initialization and
runtime `dlopen`/`dlsym`. These are the services PostgreSQL side modules need.
The runtime loads Wasm side modules, rather than arbitrary host-native DLLs.
Using V8 through Wasmer retains this host layer.

The earlier Wasmtime/static-WASI direction was removed in
[PR #13](https://github.com/f0rr0/oliphaunt/pull/13); the
[historical runtime record](../internal/DONE.md#runtime-direction) explicitly
selects WASIX dynamic linking and maintainer-produced AOT. This investigation
keeps that architecture. A successful compiler experiment with another engine
is insufficient evidence to reverse it.

## Upstream issues and fixes

Statuses below were checked on October 5. A closed umbrella issue is weaker
evidence than the implementation and remaining child issues.

| Issue or PR | Status | Meaning for this project |
| --- | --- | --- |
| [Wasmer #5347](https://github.com/wasmerio/wasmer/pull/5347), LLVM EH | Merged February 2025 | Its description explicitly leaves Windows EH as follow-up work. |
| [Wasmer #6523](https://github.com/wasmerio/wasmer/pull/6523) | Merged April 2026 | Disables Windows EH tests; does not fix the implementation. |
| [Wasmer #6826](https://github.com/wasmerio/wasmer/pull/6826) | Merged August 2026 | Removes Windows compiler support and selects V8 upstream. |
| [Wasmer #6121](https://github.com/wasmerio/wasmer/issues/6121) | Closed, with child work left open | V8 revival fixes were real, but the umbrella closure is not complete backend parity. |
| [Wee8 #15](https://github.com/wasmerio/v8-custom-builds/pull/15), [Wasmer #6544](https://github.com/wasmerio/wasmer/pull/6544), [#6644](https://github.com/wasmerio/wasmer/pull/6644) | Merged | Shared memory across isolates is a patched Wasmer requirement. An arbitrary upstream V8 archive is insufficient. |
| [Wasmer #6621](https://github.com/wasmerio/wasmer/pull/6621) | Merged May 2026 | Preserves `dylink.0`, copies import/export metadata for thread safety and fixes function-table placement. Directly relevant to side-module loading. |
| [Wasmer #6658](https://github.com/wasmerio/wasmer/pull/6658), [Wee8 #16](https://github.com/wasmerio/v8-custom-builds/pull/16) | Merged | Enables some Windows WASIX tests and restores the Windows Wasm C API library. This makes the present V8 route credible. |
| [Wasmer #6600](https://github.com/wasmerio/wasmer/pull/6600), [Wee8 #12](https://github.com/wasmerio/v8-custom-builds/pull/12) | Open; #6600 is draft | V8 15 producer builds exist, but downstream bindings/linking are unfinished. No portable cache contract is added. |
| [Wee8 #19](https://github.com/wasmerio/v8-custom-builds/pull/19) | Open | Fixes nested Windows header copying and build-script details; does not address cache portability, STL collisions or EH. |
| [Wasmer #7006](https://github.com/wasmerio/wasmer/issues/7006) | Open | Reports MSVC STL hash/template symbol collisions with an unrelated host library. No linked, qualified fix was found. |
| [Wasmer #6607](https://github.com/wasmerio/wasmer/issues/6607) | Open | Reports missing ownership cleanup for V8 entity/type handles. Relevant to repeated database and extension lifecycles. |
| [Wasmer #6680](https://github.com/wasmerio/wasmer/issues/6680) | Open | Reports about 8.7 GB versus 620 MB under a many-side-module/thread workload; V8 test intensity was reduced to unblock CI. This is upstream evidence, not an Oliphaunt measurement. |
| [Wasmer #6913](https://github.com/wasmerio/wasmer/pull/6913), [#6994](https://github.com/wasmerio/wasmer/issues/6994) | Open | Sys unwinder hardening and cooperative stack-budget work; neither implements Windows MSVC EH or a V8 stack-budget contract. |
| [Wasmer #6790](https://github.com/wasmerio/wasmer/pull/6790) | Merged | Experimental ELF shared-library artifacts are explicitly LLVM/x86-64 Linux only. This is not a Windows DLL workaround. |

Inspected V8-upgrade head `58f91be8504527dddb647cf565e6c349fe4013d8` still
disables Windows linking. The PR description predates parts of that head; see
the [survey's source comparison](windows-runtime-alternatives.md#what-changed-upstream).
Wee8 #12 head `3b3bef137c59eb29e10a2ff7c2e8198838a4b03c` reports a downstream
`global_get` crash and has unresolved C++ runtime integration. Successful engine
producer builds alone do not qualify the SDK.

## Candidate 1: fixed flags and a bounded cache family

The pinned engine is V8 **13.6.233.17**, source
`b0a55a7dad7f536cce1f9aaddba89894c8533946`. Its
[CPU probe](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/codegen/x64/assembler-x64.cc#L87)
allows most optional x86 instructions to be disabled. It still records CET
shadow-stack capability and, with mitigation enabled, the Intel JCC erratum
condition. Its [cache header](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/wasm-serialization.cc#L127)
compares exact CPU/flag/version values.

### Executed local experiment

Using the existing Linux Wee8 archive and Wasmer 7.5, a temporary probe calls
V8's public `SetFlagsFromString` before constructing any engine/store. It then
compiles and serializes a guest, loads the trusted native artifact and executes
both a modern `try_table` catch and SIMD vector addition. The flags are:

```text
--mcpu=generic
--no-enable-sse4-2 --no-enable-sahf
--no-enable-avx --no-enable-avx2
--no-enable-avx-vnni --no-enable-avx-vnni-int8
--no-enable-fma3 --no-enable-f16c
--no-enable-bmi1 --no-enable-bmi2
--no-enable-lzcnt --no-enable-popcnt
```

SSE3, SSSE3 and SSE4.1 remain enabled for the chosen SIMD baseline. This is an
experimental CPU floor, not a new supported-product policy.

| Process configuration | CPU mask | Flag hash | Serialized execution |
| --- | --- | --- | --- |
| Unchanged engine defaults | `0x23e7f` | `0xb8ff7c37` | Catch returns 42; SIMD returns 5 |
| Fixed flags above | `0xe` | `0xdafb903d` | Catch returns 42; SIMD returns 5 |

The same fixed-flag process also successfully serialized the actual PostgreSQL
guest from the [earlier immutable fixture](windows-runtime-alternatives.md#direct-experiment-actual-guest-to-windows-with-wasmtime):
10,126,285 input bytes, SHA-256
`69fdbc72f9e110c1e356db8f46b941cb67591eff140231fcfaffff201d4e7cf9`,
producing **41,602,108 serialized bytes**. This establishes compiler acceptance,
not PostgreSQL instantiation, SQL execution or extension qualification under
the new flags.

Temporary source is `/tmp/oliphaunt-runtime-research/v8-profile-probe`; its
release binary uses the standalone experiment's existing target directory.
The probe directly names the verified Linux C++ symbol to avoid rebuilding V8
for this research. Product code needs a deliberate C bridge and pregenerated
bindings; this research linkage is not a portable SDK interface.

### Why the candidate is narrower than per-machine caches

**Inference from the pinned source:** with these fixed flags and hardware that
meets the chosen SSE4.1 floor, only JCC mitigation and CETSS remain variable in
this CPU mask. The possible masks are `0xe`, `0x800e`, `0x1000e` and `0x1800e`.
This suggests at most four cache variants per guest module for this exact engine
and profile, rather than an unbounded list of observed consumer CPUs.

That inference is not a cross-machine execution result. Producers must be able
to generate the required variants with genuine matching environments, and the
SDK must automatically select the matching variant. V8's existing validation
must remain intact. Runtime features, engine build and flags must also match.
Every required core, tool, extension and support module needs the same selected
profile; package size and the CPU floor need evaluation. Future V8 versions
require a fresh audit of the probe and flags.

The ordinary Windows diagnostic independently recorded `0x33e7f` under default
flags and rejected modified CPU/flag headers. Its passing result is in
[run 37243260881](https://github.com/f0rr0/oliphaunt/actions/runs/37243260881).
Those Windows and Linux default masks must not be treated as interchangeable
artifacts; their native OS targets also differ.

This candidate avoids changing V8's serializer compatibility rules. It still
needs Wasmer integration changes: its
[global engine initialization](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/api/src/backend/v8/entities/engine.rs)
does not expose a profile/flag API, and flags must be installed before its first
engine creation. Consumers must never be asked to set them.

## Candidate 2: one maintained V8 CPU profile

A controlled engine build could separate a declared guest-code target profile
from incidental host capabilities and emit/cache code for that profile. This
could avoid multiplying artifacts, but it must constrain actual instruction
selection, validate the host's minimum capabilities and preserve security and
erratum handling. Clearing compatibility bytes in an already-built artifact
does none of this.

CETSS needs care: the pinned
[macro assembler](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/codegen/x64/macro-assembler-x64.cc#L3673)
checks an engine runtime variable before adjusting the shadow stack in embedded
builtins. Hiding the CPU bit by globally disabling that mechanism is not an
adequate portability design. A single-profile patch needs an explicit audit of
serialized guest code, engine helpers and Windows shadow-stack behavior.

The source areas are CPU probing/code generation, native-cache profile checks,
the initialization bridge, matching build manifests and compatibility tests.
This is a targeted engine-maintenance proposal, not a demonstrated completed
patch or a delivery-time estimate.

## Engine packaging and static-link isolation

Both V8 candidates need producer-generated Rust bindings and symbol preparation
to remove consumer-time libclang/objcopy. Wasmer's
[current build script](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/api/build.rs)
performs those operations during dependency builds. An SDK build script runs
too late to change that. A root Cargo `[patch]` also does not propagate to an
ordinary downstream consumer; the change needs an upstream published runtime
or a published maintained dependency closure.

For #7006, two concrete packaging investigations remain:

1. **Keep static linking and repair the hash integration.** The pinned
   [hash header](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/base/hashing.h#L363)
   adds a constrained `std::hash<T>` specialization using `v8::base::hash`.
   Preventing conflicting fundamental-type instantiations, or explicitly using
   V8's own hash type in its containers, merits a small Windows rebuild spike.
   No working patch is asserted here; all consumers of the header must compile
   and the mixed-library reproducer must pass.
2. **Put Wee8 behind a private C ABI DLL.** Keep its C++/STL implementation and
   exports inside that DLL. This may also help the V8 15 libc++ integration, but
   is not an AOT-profile fix. SDK packaging must resolve and ship the DLL
   automatically; consumers cannot be asked to copy DLLs or edit PATH. Size,
   CRT dependencies, versioning, licenses and installed-package loading need
   proof before choosing this route over static linking.

For #6607/#6680, qualification must measure repeated database opens, extension
loads and closes. Deleting handles blindly is unsafe because wrappers can
alias pointers; ownership cleanup requires an audit and exactly-once resource
release. GC suggestions in issue comments are hypotheses, not established
fixes. Our callback-payload destruction probe does not prove all engine-owned
handles are reclaimed.

## Candidate 3: repair Windows Sys EH

The 7.5 [MSVC EH implementation](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/vm/src/libcalls/eh/mod.rs)
still implements exception throwing, personality functions, exception-reference
access and deletion with `panic!()` stubs. LLVM's translator uses personality
functions and landing pads; native
[Windows EH requires a different IR/runtime contract](https://llvm.org/docs/ExceptionHandling.html#exception-handling-using-the-windows-runtime).
Existing [Windows unwind-table registration](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/compiler/src/engine/unwind/windows_x64.rs)
does not implement guest exception matching and cleanup by itself.

The work includes an MSVC/SEH-compatible throw/catch/rethrow and payload-lifetime
implementation, compiler lowering and unwind metadata, serialized-AOT
registration, imported-tag matching across dynamically loaded modules, host
trampoline/coroutine interaction, trap containment and regression qualification.
No examined current fix PR implements this missing Windows path. #6913 hardens
the existing GCC-style unwinder; #6712 adds Mach-O support, not Windows support.

MinGW is not an established escape hatch. The source selects a GCC-style EH
implementation for Windows GNU, but 7.5's compiler prohibition covers Windows
targets. Re-enabling it still requires proving compatible code generation,
unwind registration, side-module EH and a maintainer-owned deployment bridge
for MSVC consumers. Older-version pinning leaves the observed MSVC EH failure.

## Next proof that would justify implementation

Start with the fixed-flag V8 candidate before committing to a core-engine fork:

1. Add a maintainer C bridge and prove the same normalized flags on Windows,
   including machines with different CET/JCC properties. Determine which cache
   variants must actually be shipped and how producers generate them.
2. Load maintainer-produced core and extension caches with guest compilation
   unavailable. Run `CREATE EXTENSION vector`, call its functions and exercise
   guest error recovery across modules. Then test a dependency-bearing extension
   and reopen the database. An import-only cross-module test is insufficient.
3. Measure repeated database/extension lifecycles and test coexistence with
   unrelated C++ libraries. Resolve reproduced ownership or STL-collision defects
   through the smallest qualified patch or package boundary.
4. Install the real Rust and Node packages on a clean Windows image with no
   LLVM/Clang/objcopy. Exercise persistence, tools, async calls and terminal
   cleanup through the existing APIs; check package size and licenses.
5. Compare the constrained profile's SQL performance and memory against the
   existing default V8 diagnostic. Qualify the selected engine/package/profile
   together before making a Windows support claim.

The local fixed-flag result and the passing 21-runtime/7-PostgreSQL Windows
diagnostic make this a concrete feasibility path. They do not establish full
cross-platform product parity yet. No new upstream comment, PR or runtime fork
was published as part of this research.
