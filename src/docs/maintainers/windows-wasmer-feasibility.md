# Windows feasibility while retaining Wasmer and WASIX

Research snapshot: **October 5, 2026**. This record narrows the
[alternatives survey](windows-runtime-alternatives.md) to the existing WASIX
architecture. Execution coverage and release blockers remain in the
[integration ledger](windows-v8-integration.md).
The resumed [decision ledger](windows-v8-decision-log.md) supersedes the
historical controls below with current acceptance/rejection evidence and patch
sizing. It includes expanded ownership and natural V8 code collection on
Linux, the diagnosed native double-free, its corrected Windows DLL combination,
and automatic executable-only delivery with 500 database cycles per toolset.
Maintaining patches is authorized; absence of a published fix is not an
engineering rejection criterion.

## Conclusion

**Wasmer/V8 retains the required WASIX behavior. The stock dependency is
rejected for the required DX; focused downstream fixes remain feasible.** The
corrected private integration passes Windows SQL recovery, dynamic vector and
UUID extension loading, tools, async APIs and **500 database lifecycles on each
of two Windows toolsets**. It also passes three concurrent cold executable-only
launches and a warm launch, without consumer compiler tools, flags, DLL
placement or path setup.

Correct designated C++ owner cleanup, Store-scoped roots and borrowed call
arguments fix the major retention and native crash. Late closed-database private
memory is roughly **249–252 MiB**, with sampled transient peaks near **0.80 GiB**.
The last 250 endpoint changes are 1.27 and 14.73 KiB/cycle; this is strong bounded
evidence, not proof of zero leakage or an indefinite bound. The earlier 8.59 GiB
and 2.9 MiB/cycle controls below are historical steps, superseded by the current
decision ledger. The separately reproduced trap-after-Store crash and callback-panic abort
now have scoped corrections that pass on both Windows toolsets. The combined
WASIX kill registry also passes there, including simultaneous waiters and
late signals. The full native Windows catalog passes all 195 extension/mode
records and the tools round-trip, including strict cached loading with the
guest-compilation entry point blocked. Exact source/run identities are in the
decision ledger.

The remaining production work is a maintainer-owned V8 flag bridge, published
patched bindings/engine carriers, a qualified bounded family of matching caches,
plus integrating the tested cache-only WASIX policy, automatic interrupt
lifecycle hooks and complete engine notices. A single portable cache profile would need
additional engine work. These changes preserve the WASIX dynamic loader.
Repairing Windows Sys is a larger, separate unwinder and code-generation
project; removing its build prohibition is insufficient.

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

### Additional executed validation on October 5

The durable probe is now in `tools/experiments/wasmer-v8/src/cpu_profile.rs`.
`profile_check.py` launches separate writer and reader processes and checks
both directions of default/fixed-profile rejection. It never rewrites native
cache headers. Cross-runner exchange also requires the same native OS;
matching this V8 header alone does not establish OS/ABI compatibility.

| Executed local check | Result | What it establishes |
| --- | --- | --- |
| Native Linux, fixed profile | CPU mask `0xe`, flag hash `0xdafb903d`; EH and SIMD pass after a fresh-process reload | Fixed flags work with the pinned engine. |
| Native Linux, default versus fixed flags | Both mismatch directions fail with V8's null-module validation error | Compatibility checks remain intact. |
| QEMU 8.2.2, Nehalem CPU | Loads the native producer's `0xe` cache; EH/SIMD pass | A different emulated CPU can consume the same fixed-profile cache. This is Linux emulation evidence. |
| QEMU 8.2.2, Skylake-Client CPU | Produces/reloads mask `0x800e` with the same flag hash; EH/SIMD pass | The JCC mitigation bit is real remaining variability. |
| Native Linux reads the Skylake cache | Rejected | Disabling optional ISA features alone cannot produce one universal cache. |
| QEMU Nehalem, actual PostgreSQL | 41,602,108 serialized bytes; deserializes and instantiates through WASIX, 92 imports/1,245 exports | The profile handles the real dynamic-main module; this check does not execute SQL. |
| QEMU Conroe, EH/SIMD fixture | Module creation rejected | The tested profile does not extend support below its SSE4.1 CPU floor. The user later approved an SSE4.1 minimum for x64 desktop SDKs; SSE2-only support is no longer required. |
| Wasmer build with libclang unavailable | Build-script panic: `Unable to find libclang` | The current Rust consumer dependency still needs an extra tool. |
| Wasmer build with libclang present but all objcopy candidates absent from PATH | Build-script panic: `No program akin to objcopy found` | Precompiled guest artifacts alone do not remove consumer build-tool requirements. |

QEMU was unpacked into a temporary directory from Ubuntu's
`qemu-user` package `1:8.2.2+ds-0ubuntu1.18`; no system package installation was
needed. CPU feature warnings from TCG are retained in the raw logs. These are
controlled emulation checks, not evidence of Windows security-feature behavior
or measurements from physical Nehalem/Skylake computers.

The owner checks also passed in one Moon invocation:
`oliphaunt-wasix-rust:{format-check,lint,test,package}`. The test task ran
8 public-API tests and 176 library tests, all passing. These source/package
checks do not execute the Windows installed-consumer path. The full
`tools/ci/check-workflows.sh` validation passed after the diagnostic changes.

At source `91acf30d`, [run 37249648979](https://github.com/f0rr0/oliphaunt/actions/runs/37249648979)
also completed the following checks:

| Hosted check | Result | Limit |
| --- | --- | --- |
| Linux fixed profile | Mask `0x1000e`, flag hash `0xdafb903d`; EH/SIMD reload and PostgreSQL WASIX instantiation pass | CET capability remains in the mask. |
| Windows 2022 and Windows 2025 fixed profile | Both masks `0x1000e`; default and fixed PostgreSQL serialization/instantiation pass | Both producer hosts report AMD EPYC 7763; no broad Windows hardware coverage. |
| Windows cache exchange | Both fresh readers accept both same-OS baseline EH/SIMD caches; flag mismatches still reject | This run exchanges the tiny fixture, not the PostgreSQL cache. |
| Windows database integration | 21 runtime tests, 7 PostgreSQL regressions, and 3 UUID-OSSP AOT tests pass | Actual `dlopen`, reopen, materialization and `pg_dump`/`psql` restore work with the default engine profile and immutable older guests. |
| Ordinary `/MD` C++ control | 10,000 map entries; zero missing/corrupt entries | Standalone control only. |
| Same library linked with Wee8 | Link fails on both Windows toolsets: `LNK2038` static/dynamic CRT mismatch, plus duplicate C++ runtime symbols | A reproduced packaging blocker; execution never reaches the #7006 hash test. |
| Windows build without libclang | Both diagnostic builds fail at bindgen as expected | Confirms an extra consumer tool remains required on Windows. |
| Repeated vector lifecycles | Build stops before the test because local archive lookup incorrectly uses runtime version `0.3.1` for vector `0.3.0` | Fixed at `31e154b1`; no memory result may be inferred from the failed harness. |

The follow-up reader at `31e154b1` does not call `Module::new`, even to probe its
header. Writers persist PostgreSQL native bytes and readers load those bytes.
Local fresh-process and QEMU Nehalem reads of the 41,602,108-byte baseline
PostgreSQL cache pass WASIX instantiation. The hosted follow-up also completes
matching-CRT native coexistence, PostgreSQL cache exchange and vector lifecycle
measurement, as recorded below. The test still does not run SQL with the fixed
flags; the SDK integration uses engine defaults. Passing instantiation cannot
qualify the whole consumer experience.

The follow-up Windows producers actually expose different CPU profiles:
Windows 2022 reports **Intel Xeon Platinum 8573C**, default mask `0x23e7f`,
baseline `0xe`; Windows 2025 reports **Intel Xeon 6973P-C**, default
`0x33eff`, baseline `0x1000e`. Both use baseline hash `0xdafb903d` and both
reload their persisted **41,574,844-byte PostgreSQL cache** through WASIX in a
fresh reader. Unlike the prior AMD-only run, this confirms remaining mask
variation on actual Windows hosts. It does not prove a universal single cache.

Both fresh Windows readers have baseline mask `0x1000e`. They accept the
Windows 2025 producer's persisted PostgreSQL cache and instantiate it through
WASIX without a `Module::new` call in the reader. Both reject the Windows 2022
producer's `0xe` cache. Thus even a subsequent machine with the **same Windows
2022 runner label** cannot necessarily load its producer's cache. The fresh
Linux reader accepts the same-OS `0x1000e` PostgreSQL cache; cross-OS artifacts
are deliberately excluded. No exchanged-cache test executes SQL.

Both Windows toolsets pass the separate matching-CRT mixed-library test:
Wasmer/V8 executes a guest returning 42, then the ordinary map retains all
10,000 entries with the same FNV control hash. This scoped reproducer does not
reproduce #7006, and does not fix or disprove the upstream issue. The ordinary
`/MD` link still fails. Matching `/MT` and Rust `crt-static` were diagnostic
settings only; consumers must not be required to use them.

The repeat at `04ff56b6`, [run 37261765016](https://github.com/f0rr0/oliphaunt/actions/runs/37261765016),
finishes all three fresh-reader jobs. Both Windows readers load both Windows
producers' 41,574,844-byte PostgreSQL caches through WASIX; this time every
producer/reader has mask `0x1000e` and hash `0xdafb903d`. The Linux reader loads
its matching 41,602,108-byte cache. These remain instantiation checks without
SQL, and matching hosts do not overturn the prior different-mask rejection.
Both ordinary `/MD` links still fail with `LNK2038`/`LNK2005`/`LNK1169`, both
matching `/MT` controls retain all 10,000 map entries, and both no-libclang
builds fail at bindgen. Expected negative-control results confirm the blockers;
they do not qualify a clean consumer installation.

### Windows database lifecycle measurement

At exact source **`31e154b1d5f47f35b384c6d2856754287d41a57f`**,
[SDK diagnostic job 111581122909](https://github.com/f0rr0/oliphaunt/actions/runs/37251912738/job/111581122909)
passes the 21 runtime tests, 7 PostgreSQL regressions, 3 UUID-OSSP/tool tests and
the explicitly selected 25-cycle vector lifecycle test. Each cycle opens an
in-memory database, dynamically loads vector, encounters `SELECT 1 / 0`, runs
a successful vector query and closes the database. The test finishes in
112.01 seconds; the harness retains 1,115 Windows process-memory samples.

| Sample point | Private memory | Working set |
| --- | --- | --- |
| First sample after 1 completed cycle | 0.562 GiB | — |
| First sample after 5 completed cycles | 1.871 GiB | — |
| First sample after 10 completed cycles | 3.499 GiB | — |
| First sample after 20 completed cycles | 6.757 GiB | — |
| First sample after 24 completed cycles | 8.072 GiB | — |
| Peak during the test | **8.588 GiB** | **7.014 GiB** |

The first-sample private-memory increase between cycles 1 and 24 is
**334.4 MiB per cycle** on average. These samples include the next cycle's
activity; they are not synchronized measurements immediately after `close()`.
Nevertheless, the rising minima and working set demonstrate severe retention
over the tested sequence. Private memory drops to 0.494 GiB during process
teardown after all 25 cycles. That drop does not prove reclamation during
normal application use, and the functional pass does not qualify memory.

This is a **release blocker for a long-running embedded application**. It does
not identify an exact leaking allocation or establish that #6607/#6680 are its
cause. Audit SDK/WASIX retention and engine-handle ownership, then repeat the
same measured workload after a fix. Do not declare a blind handle deletion or
a suggested GC call safe without that audit.

Evidence artifact **`11322237408`**, `windows-v8-sdk-diagnostic`, has digest
`sha256:39c28d183d1fa0d26af138f7b338a91f5f3be2989c22ac20e9772578052c862b`.
Its `lifecycle-memory.json`, `lifecycle.log` and build log preserve the raw
measurement and selected test identity. Core/extension/tool inputs are the
immutable earlier fixtures described in the integration ledger. This remains
diagnostic evidence rather than same-source release qualification. The overall
run is red because both ordinary `/MD` coexistence cases fail; those failures
are not waived by the passing SDK job.

### Smaller Linux retention controls

A disposable Wasmer 7.5.0/WASIX 0.705.0 release binary uses the verified fixed
flags and trusted native caches above. Each of 25 cycles drops the complete
store/instance/environment scope before reading Linux `VmRSS`. PostgreSQL is
only instantiated: no SQL, extension loading or SDK code runs. The tiny guest
executes its EH catch function and checks the result is 42.

| Control | RSS increase per cycle after cycle 3 | With glibc `malloc_trim(0)` after every drop |
| --- | --- | --- |
| Direct Wee8 C API store creation/deletion | 0.678 MiB | 0.678 MiB |
| Wasmer V8 stores only | 0.678 MiB | 0.678 MiB |
| Tiny cached guest instantiation/call | 0.707 MiB | 0.707 MiB |
| PostgreSQL/WASIX instantiation, explicit host exit cleanup | 4.962 MiB | 4.981 MiB |
| PostgreSQL/WASIX instantiation, scope drop alone | 4.962 MiB | 4.964 MiB |

The direct C API control initializes one engine, creates and deletes each
unique store handle exactly once, then deletes the engine. It bypasses Wasmer's
wrappers and does not load any Wasm module. The smallest observed growth
therefore occurs below those wrappers. Host-only
`WasiEnv::blocking_on_exit(Some(0))` and allocator trimming do not eliminate the
PostgreSQL control's growth. Neither is an established memory fix.

An extended **1,000-store direct C API run**, still trimming after every delete,
finishes below its 1 GiB RSS safety bound. RSS increases from 26,660 KiB after
cycle 3 to 718,380 KiB after cycle 1,000, about 0.678 MiB per cycle, without
plateauing over that interval. This strengthens the minimal retention
reproducer; it is not a Windows database measurement or a root-cause diagnosis.

### Store ownership defect and a partial Linux remedy

The pinned source supplies a concrete explanation for that minimal case.
[`WASM_DEFINE_OWN`](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/c-api.cc#L2498)
implements C deletes as `delete x` on a derived public API representation.
[`Store` has a default, nonvirtual destructor](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/third_party/wasm-api/wasm.hh#L234);
its designated `wasm::destroyer` instead calls `Store::destroy()`, which deletes
the real `StoreImpl` and disposes its isolate. Inspection of the downloaded
Linux engine confirms its C store/engine delete entry points only free the
public base allocation, without invoking implementation cleanup. A Rust
`Drop` that calls this C entry point therefore does not establish reclamation.

A disposable Linux linker wrapper calls the pinned C++ designated deleter for
each unique store, without guessing the implementation layout or adding a
second delete. The 1,000-store control ends at **24,808 KiB RSS**, versus
718,380 KiB with the stock C API. Its cycle-3-to-1,000 growth is only 12 KiB.
The 25-cycle Wasmer-store and tiny-EH controls grow by roughly 0.007 MiB per
cycle after warm-up; the guest still returns 42.

The PostgreSQL/WASIX instantiation control still grows by **3.001 MiB per
cycle**, down from approximately 4.96 MiB. Host exit cleanup does not eliminate
that remainder. The pinned platform also
[requires isolate shutdown notification](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/include/libplatform/libplatform.h#L97),
which the C API omits. Adding that sequence at the actual isolate disposal
boundary does not remove the remaining PostgreSQL growth in this control.
It must not be described as a complete memory fix.

The next Linux control also corrects the C API **shared-memory** deleter.
Wasmer already owns that detached handle in an `Arc` and has a final-owner
destructor; the destructor reaches the same faulty C delete mechanism. The
pinned Wee8 shared-memory specialization's designated deleter releases its
`shared_ptr<BackingStore>` independently of an isolate. The control preserves
the existing Arc ownership and changes only the actual C deletion entry point.
With both deleters corrected, PostgreSQL/WASIX growth falls to **0.141 MiB per
cycle** over cycles 3–25, ending at 164,952 KiB RSS; the no-host-exit control is
0.143 MiB per cycle. This is approximately 97% below the untouched instantiation
control, but residual growth remains and real Windows SQL/extension teardown
still needs its own proof. This does not justify adding destructors to aliased
raw memory/function handles without auditing their lifetimes.

This points to a small C API ownership patch worth qualifying before assuming
that the entire V8 backend needs replacement. The broader owned-handle audit,
including aliases and vectors of owned handles, still matters. A private C++
ABI/linker workaround is a research mechanism, not a shipping SDK boundary.

There is a third affected owner: Wasmer's `ModuleHandle` already has an Arc-owned
final destructor, but its C shared-module delete also misses the designated
[`Shared<Module>::destroy()`](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/c-api.cc#L1378),
which releases a serialized byte vector. A separate Linux control deserializes
and drops a fresh PostgreSQL cached module each cycle, rather than reusing one
Module as the instantiation controls do. With Store and shared-memory cleanup
fixed but shared-module deletion untouched, it retains **39.643 MiB per load**
over cycles 3–10 and ends at 599,008 KiB RSS. Correcting the existing unique
shared-module owner's delete reduces growth to **0.0126 MiB per load** over
cycles 3–25, ending at 193,700 KiB RSS. Both controls trim the allocator after
each complete scope drop. No SQL or extension runs in this comparison.

With all three owner deletions corrected, **1,000 tiny cached-module cycles**
also pass: each fresh Module is cloned, its first Rust owner is dropped, and
the remaining clone executes the EH catch returning 42. RSS is 28,692 KiB after
cycle 3 and 29,512 KiB after cycle 1,000. This exercises the actual Arc lifetime;
it does not justify destructors on aliased raw entity handles. The PostgreSQL
instantiation control still retains about 0.143 MiB per cycle with these three
changes. Extending that control to 100 cycles gives 0.138 MiB per cycle over
cycles 3–100 and ends at 216,132 KiB RSS, so the smaller residual remains open.
A requested 1,000-cycle PostgreSQL **module-load** control hits its 45-second
safety timeout after 355 cycles; it is retained as an incomplete control, not
counted as a 1,000-cycle pass.

The October 5 upstream check found no ready-made ownership fix to adopt.
[Wee8 release 11.9.9](https://github.com/wasmerio/v8-custom-builds/releases/tag/11.9.9)
still [builds V8 13.6.233.17](https://github.com/wasmerio/v8-custom-builds/blob/775f97e372aad1fb6ad119883ae177213c1773a8/build.ps1#L6);
inspection of its ten patches found no correction to this C deletion mechanism.
V8 main at [`00075520`](https://github.com/v8/v8/blob/00075520df30f6d891cd9cf5f9f497f624a2efaa/src/wasm/c-api.cc#L2531)
still uses the same macro, and its Store still has a default nonvirtual destructor.
Issues [#6607](https://github.com/wasmerio/wasmer/issues/6607) and
[#6680](https://github.com/wasmerio/wasmer/issues/6680) remain open. This narrows
the feasible work to correcting the maintained C API ownership boundary and
qualifying it, rather than assuming an engine version bump will reclaim memory.

At `cd35cd1de2ec7260b416e3695e4c46da1b4e2b2e`,
[diagnostic run 37258627492](https://github.com/f0rr0/oliphaunt/actions/runs/37258627492)
passes the stock runtime, UUID-OSSP/tools and 25-vector-cycle checks, but the
ownership comparison fails during setup: Python decodes Cargo's UTF-8 metadata
using Windows CP1252 and raises `UnicodeDecodeError`. **No patched Windows
runtime executes in that run.** The follow-up uses explicit UTF-8 and preserves
the source bytes in its private dependency copy.

At `04ff56b64ec6c9999ccf579a9d8a28b04e2805f5`,
[diagnostic run 37261765016](https://github.com/f0rr0/oliphaunt/actions/runs/37261765016)
tests Store, shared-memory and shared-module cleanup together. It copies exact
Wasmer 7.5.0 sources into a private local override, verifies all three original
source hashes, records the changed source/lockfile and rejects any other
dependency resolution change. The three MSVC designated-deleter symbols were
verified in the exact pinned Windows archive. Existing Arc ownership remains
intact. The job repeats runtime/EH/recovery, UUID-OSSP/tools and measured vector
lifecycles on the **same runner with the same AOT bytes**. It also logs every
Wasmer V8 `ModuleHandle::new` call; this observes WASIX resolver compilation but
does not cover internal V8 compilation. Published dependencies and the shared
Cargo registry remain unchanged.

### Paired Windows cleanup result

That Windows SDK job completes successfully. Both stock and patched runs pass
21 runtime tests, 7 PostgreSQL regressions, 3 UUID-OSSP/tool tests and all
25 vector open/error/query/close cycles. The exact private override is verified
again from its downloaded original/patched sources: all six recorded hashes
match, and lockfile package records/edges differ only by Wasmer's local source.

| Same-runner vector measurement | Stock | Three corrected owner deletes |
| --- | --- | --- |
| Completed cycles | 25 | 25 |
| Test duration | 109.24 seconds | 105.69 seconds |
| Raw 100 ms samples | 1,088 | 1,049 |
| Peak private memory | **8.590 GiB** | **0.795 GiB** |
| Peak working set | 7.016 GiB | 0.661 GiB |
| First private-memory sample after cycle 24 | 8.071 GiB | 0.311 GiB |
| Average first-sample growth, cycles 1–24 | **334.2 MiB/cycle** | **2.9 MiB/cycle** |

Peak private memory falls by **90.7%**, and the sampled growth by **99.1%**.
Samples can include the next cycle's work, so these are not exact post-close
checkpoints. The corrected run's per-cycle minima still rise across the tested
interval; this is a large improvement, not proof of a plateau or complete
memory reclamation. The two durations are observations, not a performance
benchmark. No Windows allocator trimming or process restart is used between
cycles.

The vector log records **175 Store cleanup calls**, proving the override ran.
The other patched test log records 255. Both record **zero instrumented Wasmer
V8 `ModuleHandle::new` calls** across the executed SQL, extension and tools
workloads. This covers those Wasmer construction paths, including exercised
WASIX resolver loads; it does not cover compilation internal to V8 or untested
catalog modules. Strict native-payload checks and a cache-only resolver remain
required before claiming compilation-free consumption.

Evidence artifact **`11326071452`**, `windows-v8-sdk-diagnostic`, has digest
`sha256:9e8075025b1d9fe9158c07b01ac4b0fce82a225c7370173bbd04f67cad3046b9`.
The downloaded ZIP matches that digest. It retains both raw memory/log series,
the source override, hashes and both Cargo lockfiles. Inputs remain immutable
older guests, not same-source release qualification. The overall diagnostic
is red because the ordinary `/MD` coexistence tests remain broken.

The Linux observations use RSS; the Windows comparison uses private-memory
and working-set counters. They must not be combined into one memory metric.
The paired Windows control isolates the effect of the three owner changes
together; it does not attribute each change's contribution or locate the
remaining retained allocations. A maintained C API patch, the remaining owned
handle audit, shutdown sequencing and longer lifecycle qualification are still
needed. Direct linkage to pinned private C++ symbols remains research only.
The normal SDK successful-close path releases its backend ownership; its failed
close quarantine does not explain a test in which every `close()` succeeds.
`WasiFunctionEnv::on_exit` can invoke guest cleanup and is documented for syscall
use; calling it blindly from SDK teardown is not a qualified remedy.

The disposable source/lockfile, control logs and summary are retained under
`tools/experiments/wasmer-v8/results/validation-2026-10-05/`. That ignored local
research directory also retains the downloaded Windows memory evidence; it is
not a published artifact. The hosted artifact identities above remain the
durable sources for the Windows measurements.

The Skylake/JCC PostgreSQL variant contains **41,908,784 bytes**, 306,676 more
than the `0xe` producer. Its compilation-free fresh reader also passes WASIX
instantiation under emulation. This is evidence that the remaining JCC bit
affects a real guest payload, not just the tiny fixture's compatibility header.
No cache bytes were changed to make it load.

Repeated baseline serialization on the same native Linux host produces the
same length but different hashes: 8,230 byte positions change between two
processes. Comparing the local and hosted CET baseline finds 8,231 different
positions, including the CET header byte. These measurements do not establish
the cause or semantics of those variable fields, or prove that clearing CET is
safe. They establish that raw byte equality is not a general reproducibility
guarantee; retain the exact producer artifact and its manifest digests.

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

There is a narrower flag-only option to benchmark. The pinned V8 flag
`--no-intel-jcc-erratum-mitigation` disables its software branch-alignment
optimization. [Intel's explanation](https://www.intel.com/content/www/us/en/developer/articles/technical/software-security-guidance/best-practices/mitigation-strategies-jcc-microcode.html)
and [MSVC's option contract](https://learn.microsoft.com/en-us/cpp/build/reference/qintel-jcc-erratum?view=msvc-170)
distinguish that alignment from the processor's microcode correction: alignment
recovers performance lost to the correction. This flag does not disable the
processor's microcode update or CET shadow-stack handling.

Appending that one flag in a separate temporary probe produces mask `0xe`
and hash `0x33f7aeab` on native Linux, QEMU Nehalem and QEMU Skylake-Client.
All three execute EH/SIMD after same-process serialization/deserialization and
serialize the real PostgreSQL guest to 41,602,108 bytes. This supplementary
probe does **not** execute PostgreSQL, instantiate it through WASIX, or test
Windows. Its source and logs are retained locally under the ignored
`tools/experiments/wasmer-v8/results/validation-2026-10-05` directory.

**Inference:** with that policy, only CET remains variable, suggesting two
variants (`0xe` and `0x1000e`) for this pinned engine. This is a possible
packaging simplification, not the selected product profile. Qualification must
measure affected-CPU SQL performance and Windows behavior before adopting the
tradeoff. The main hosted experiment preserves JCC alignment and CET.

Three masks have now been observed: `0xe` locally and under Nehalem emulation,
`0x800e` under Skylake emulation, and `0x1000e` on hosted Linux and Windows.
The combined `0x1800e` variant remains an inference. Producers must be able
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

The actual Windows Node-API carrier from `a4697f06` is inspected separately:
artifact **`11326436382`**, `oliphaunt-wasix-napi-npm-package-windows-x64-msvc`.
Its provenance records the exact source SHA and its binary hash matches
`34f1919a7242164f0bdc873775e8c60fdc5c79b9f4c1ee7256443233c34569ca`.
The 82,328,064-byte `.node` embeds the engine; its imported VC runtime DLLs
`vcruntime140.dll` and `vcruntime140_1.dll` are included and match the bundled
hash list. Their dependency imports are checked too. Installed Node/npm,
Node/Bun, Bun, Deno and Electron smokes pass with package scripts disabled.
Thus prebuilt JavaScript consumption works on the tested host; the Rust
libclang requirement is a different dependency path. This does not qualify a
clean Windows base image or caches on different CPUs.

The carrier still has a concrete notice gap: its only pinned license files
are PostgreSQL, ICU and OpenSSL, and neither notice file mentions V8. The
[pinned V8 license](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/LICENSE)
includes binary-distribution notices and points to additional component
licenses. The V8/Wee8 license closure and package license metadata must be
completed before publication. PE inspection also finds 2,345 exports, including
2,295 MSVC C++ names. Passing Node-API smokes does not establish the deliberately
narrow C ABI isolation proposed below. The binary import/export audit is
retained with the other local research receipts.

There is a smaller SDK-side option for strict AOT loading:
[WASIX `Runtime::resolve_module`](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/wasix/src/runtime/mod.rs#L453)
is overridable. Its default implementation first checks `ModuleCache`, then
calls `Module::new` on a miss or cache error. The SDK seeds selected core,
support, extension and tool modules with deserialized artifacts, but uses that
default loader. A cache-only runtime adapter can reject misses without an
engine fork or changed consumer APIs. It must cover synchronous, hashed and
command loads through the common resolver, preserve the existing runtime
services, and prove complete cache seeding with real dynamic-loading tests.
This adapter is not implemented by the current validation patch; passing SQL
tests alone does not count compilation calls.

Likewise, the pinned V8 C API tiers all functions up before serialization, but
can emit a Wasm-only record for a functionless module or concurrent serializer
failure. Its deserializer compiles records with no native section. Producers
and loaders therefore need an explicit native-payload contract for executable
modules; the absence of an SDK `Module::new` call is only part of that proof.

Fresh-process Linux GDB controls distinguish guest compilation from V8's
host adapters. They break on `WasmCompilationUnit::ExecuteCompilation`,
`wasm::Module::make`, `CompileWasmCapiCallWrapper` and `CompileCWasmEntry` in
the actual pinned binaries:

| Fresh process | Guest body compilation | Module construction | C API import adapters | C-to-Wasm entry adapters |
| --- | ---: | ---: | ---: | ---: |
| Load cached PostgreSQL, instantiate WASIX, close | 0 | 0 | 21 | 1 |
| Load cached tiny EH module, drop original owner, call remaining clone | 0 | 0 | 0 | 1 |
| Compile and serialize tiny EH/SIMD positive control | 2 | 1 | 0 | 2 |

The positive control verifies the guest-compilation probes are active. The
cached runs exit normally; the tiny EH call returns 42. The first adapter
backtraces pass through WASIX instantiation and its linker initialization.
This matches the pinned V8
[import adapter compilation](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/module-instantiate.cc#L1919)
and [C entry compilation](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/c-api.cc#L1683)
paths. These are generated inside the embedded engine and require no external
compiler tool. They are not recompilation of the cached guest bodies.

This bounded result supports cached guest execution, while ruling out a claim
that this V8 path is headless or performs no runtime code generation. It does
not count every possible V8 compiler entry, run SQL/full extensions under GDB,
or directly observe Windows adapter counts. Windows follows the same pinned
C API implementation; its exact counts remain unmeasured. The GDB scripts,
raw logs, binary/cache hashes and command receipts are retained locally.

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

Another packaging boundary is a **prebuilt complete Wasmer/WASIX host runtime**
behind a private C ABI, with the existing Rust SDK acting as its facade. It
would move Wasmer, its generated bindings and the C++ engine link into
maintainer builds. A downstream Rust application would then compile the facade
and load the bundled runtime, without building Wasmer or linking V8's C++
objects into its own executable. Unlike a Wee8-only DLL, this could remove the
consumer bindgen/objcopy dependency without publishing a modified Wasmer crate.
CPU-cache matching and ownership cleanup would still require fixes inside the
producer runtime.

This is a design option, not an existing drop-in artifact. Inspection confirms
that the current Windows WASIX carrier is a normal Rust library containing
generated guest AOT bytes, and the WASIX SDK directly depends on Wasmer. It
does not package a complete host runtime DLL or expose the SDK operations over
such an ABI. The native SDK has a separate bindings/runtime pattern, but
reusing that pattern must preserve WASIX services and implement the complete
WASIX operation surface: streaming callbacks, COPY, errors, cancellation,
extensions, tools, backups and async ownership. That additional ABI work must
be compared with pregenerated Wasmer bindings and a private Wee8 DLL before
choosing a route. Neither design changes consumer APIs or asks them to select
a different engine.

A **private Wasmer/WASIX worker process per database** is another boundary to
investigate if in-process ownership cleanup remains costly. Maintainers would
ship its executable inside the existing SDK packages; the unchanged public
facade would start it, communicate with it and stop it automatically. Process
exit would reclaim its retained memory, and its private CRT/STL would avoid
linking into unrelated application libraries. The guest and WASIX dynamic
loader would remain the same. This is a design inference, not an executed fix.

The repository already has a WASIX-backed CLI and PostgreSQL transport in
[`oliphaunt-pgwire-server`](../../wasix/pgwire-server/README.md), including memory
and directory storage and selected extensions. It provides a starting point,
but currently packages Cargo source rather than a tool-free worker executable.
Its CLI waits until stopped; a private worker would need supervised graceful
shutdown and qualification of callback streaming, COPY, transactions, tools,
backups and crash recovery through the existing SDK APIs. A PostgreSQL socket
alone does not implement every direct SDK operation. CPU-profile selection and
complete compilation-free cache loading would still need to be solved. This
boundary could reduce engine ABI/ownership maintenance, but has transport and
startup costs that must be measured before choosing it.

For #6607/#6680, qualification must measure repeated database opens, extension
loads and closes. Deleting handles blindly is unsafe because wrappers can
alias pointers; ownership cleanup requires an audit and exactly-once resource
release. GC suggestions in issue comments are hypotheses, not established
fixes. Our callback-payload destruction probe does not prove all engine-owned
handles are reclaimed.

The `/MD` failure adds a separate requirement: the producer's static C++ CRT
must coexist with ordinary application libraries. Forcing consumers to choose
`/MT` or set Rust `crt-static` flags would violate the requested DX. A
matching-CRT diagnostic can reach the hash test; it is not a consumer remedy.

The new [upstream Wasmer SDK](https://github.com/wasmerio/wasmer-sdk/tree/362e0db28fea57fb23af8d34cffefcb7333a883d)
does not supply a ready replacement for this integration. At the inspected
commit its Rust dependencies pin Wasmer 7.4.0/WASIX 0.704.0, the default native
backend is Cranelift, and its Rust README says registry publication is disabled
while following the development branch. Its JavaScript implementation uses
the browser Wasm host, while Python/Swift use a prebuilt Rust facade. Those
packaging examples may inform a private engine boundary; they do not prove a
published, native Windows AOT package with the required extension behavior.

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

Qualify the smallest proven ownership remedy first, then the artifact and
packaging contract:

1. Replace the three faulty C API owner deletes through a maintained public C
   boundary, audit remaining owned handles and isolate shutdown, and repeat the
   Windows database/extension lifecycle controls. Preserve exactly-once owner
   cleanup and test interruption of indefinitely blocked guest waits.
2. Add a maintainer C bridge and prove the same normalized flags on Windows,
   including machines with different CET/JCC properties. Determine which cache
   variants must actually be shipped and how producers generate them.
3. Load maintainer-produced core and extension caches with guest compilation
   unavailable. Run `CREATE EXTENSION vector`, call its functions and exercise
   guest error recovery across modules. Then test a dependency-bearing extension
   and reopen the database; qualify the full catalog on Windows. Seal the WASIX
   resolver and check V8's native payloads. An import-only cross-module test is
   insufficient.
4. Resolve ordinary `/MD` library coexistence through a maintained engine patch
   or private package boundary, then execute the upstream STL hash reproducer.
5. Install the real Rust and Node packages on a clean Windows image with no
   LLVM/Clang/objcopy. Exercise persistence, tools, async calls and terminal
   cleanup through the existing APIs; check package size and licenses.
6. Compare the constrained profile's SQL performance and memory against the
   existing default V8 diagnostic. Qualify the selected engine/package/profile
   together before making a Windows support claim.

The fixed-flag cache results and passing Windows SQL/extension/tools tests make
this a concrete feasibility path. The measured lifecycle retention and consumer
packaging failures prevent a release claim. A maintained engine package or a
private WASIX worker could preserve the consumer API, but neither is yet a
qualified solution. No new upstream comment, PR or runtime fork was published
as part of this research.
