# Windows V8 decisions and acceptance evidence

Investigation snapshot October 6, 2026. **Reject the current stock Wasmer 7.5
Windows integration for release under the requested consumer contract.** Real
SQL, WASIX services and extension loading work, but the complete installation,
CPU compatibility, compilation-free loading and lifetime contract does not.
Several individual remedies now have executed evidence. Maintaining downstream
patches is explicitly acceptable. The release rejection does **not** reject
patching as an engineering approach; scope and complete-contract evidence are
assessed separately below.

The contract is the same dependencies, features, public APIs and behavior on
Linux, macOS and Windows. Consumers install no extra compiler tools, provide no
engine flags, compile no guests and place no runtime DLLs themselves. WASIX and
PostgreSQL side-module loading remain required. A failure rejects the tested
implementation, not every possible maintained engine fork.

The October 6 [public API review](windows-v8-api-review.md) adds a delivery
error-handling blocker and two reproduced general memory API limits. Engine
cache failures can abort inside generated C dispatch. Linux diagnostics show that a second wait can
reenter after interruption and that disabling a detached copy interrupts the
source Store. The existing native controls prove the tested terminal WASIX
path, not permanent guest-entry prevention or memory-level atomics parity.
Resolve these findings alongside the remaining carrier/profile work.
The [root-cause re-review](windows-v8-root-cause-review.md) verifies the loader
ABI in the frozen Windows crate, corrects the earlier async-recovery claim,
and records small unactivated copy/terminal-contract prototypes. Linux
negative/positive controls pass; loader implementation and fresh native Windows
qualification remain required.

## Decisions

| Implementation or claim | Decision | Decisive evidence |
| --- | --- | --- |
| Stock Wasmer 7.5 Windows dependency | Reject for the required DX | Native consumer build requires libclang; static Wee8 fails with an ordinary `/MD` C++ library. |
| Producer-built private engine DLL with generated bindings | Accept the tested build/CRT boundary | Both Windows toolsets build without Clang/objcopy; all 20 fresh-process mixed-library runs pass. Automatic SDK delivery remains separate. |
| Application `/MT` or Rust `crt-static` configuration | Reject as a consumer remedy | Matching-CRT control works but requires prohibited consumer configuration. |
| One default or constrained V8 cache for all Windows CPUs | Reject | Genuine different-mask Windows readers reject PostgreSQL caches. Constrained same-mask exchange passes; CET remains variable. |
| Disabling JCC alignment to reduce cache variants | Accept the tested flag/profile behavior | Fresh Windows EH/SIMD and PostgreSQL WASIX cache reads pass under `baseline-no-jcc`. Genuine two-variant production and compatible-cache selection pass in both directions, with the lower CPU tested under emulation. |
| Current SIMD guest preserving the former SSE2 CPU floor | Reject; no longer required | The existing SIMD PostgreSQL guest fails under QEMU Conroe. The user subsequently approved an SSE4.1 minimum for x64 desktop SDKs. |
| Scalar PostgreSQL producer + lower-CPU profile | Accept the tested core mechanism; optional | Actual scalar PostgreSQL compiles, and one genuine cache deserializes/initializes through WASIX under Conroe and Opteron G1. Full native SQL/catalog qualification would be needed only if older-CPU support is restored. |
| Removing/rewriting compatibility headers | Reject | It bypasses engine checks and does not establish safe instruction selection. |
| Stock WASIX resolver never compiles guests | Reject | An actual PostgreSQL cache miss compiles 12,118 guest bodies. |
| Cache-only resolver override | Accept the bounded mechanism | A miss rejects with zero guest compilation; seeded PostgreSQL resolves and instantiates through WASIX with zero guest-body compilation. |
| V8 is headless or generates no runtime machine code | Reject | A cached PostgreSQL load generates 21 host-import adapters and one entry adapter despite zero guest-body compilation. |
| Three corrected C++ owners as a complete memory fix | Reject | They dramatically reduce Windows retention but leave continued growth. |
| Callback finalizers as a complete memory fix | Reject; accept exactly-once callback cleanup | 100 isolated callback cycles finalize exactly once; PostgreSQL still grows after that change. |
| Numeric typed-call value-vector cleanup alone | Reject for calls with arguments; accept only the tested zero-argument control | One million zero-argument calls retain about 48 bytes/call before cleanup; the patched warm interval grows only 12 KiB total. Native PageHeap locates the SDK crash in double cleanup of a call vector. |
| Owners + callbacks + numeric vectors + function-type cleanup as a complete fix | Reject | All 1,000 PostgreSQL instantiations finish, but late RSS grows by 77.096 KiB/cycle. |
| Stock WASIX `Sigkill` stops native guest atomic waits | Reject | The signal is delivered but the waiter does not return; a five-second parent timeout ends the process. |
| Native V8 termination through WASIX | Accept the automatic lifetime implementation | Both Windows toolsets pass 25 kill cycles with 35 waiters, aliases, 2,500 post-teardown signals and 32 teardown races. Store capture, attachment and retirement now happen inside the backend. Clean attachment errors and 256 attachment/shutdown attempts pass too. |
| Reverting to stock Windows Sys/LLVM or just upgrading V8 | Reject as ready remedies | Windows Sys EH remains unimplemented; inspected V8 15.0.1 retains the relevant C-owner macro and hardware CET mask behavior. |
| A downstream patch series | Accept as an engineering approach | Existing patch practice is authorized. Much of the tested remedy fits the V8 embedding and package boundary; maintaining patches alone is no rejection criterion. |
| Expanded ownership through the engine DLL without borrowed arguments | Reject | Both toolsets reproduce SDK isolation heap corruption; Linux natural collection cannot establish native correctness. |
| Expanded ownership plus borrowed arguments through the engine DLL | Accept the tested Windows functional combination | Both toolsets pass the argument/retry/trap control, actual SDK regression, UUID/tools and 500 closed vector databases. Late retained memory is near 249–252 MiB; zero leakage is not established. |
| Embedded DLL and generated C dispatch | Accept the tested automatic delivery mechanism | Both toolsets pass three simultaneous cold executable-only launches, a warm launch and the real SDK suite without compiler tools, DLL placement or application flags. Published carriers remain qualification work. |
| Genuine Windows cache variants without header edits | Accept the tested producer and selection | An emulated SSE4.1 reader rejects `0x1000e` and loads `0xe`; both native Windows toolsets reject `0xe` and load `0x1000e` in fresh readers. These readers never compile. The full catalog is not yet packaged with this profile. |
| Trap errors retaining native handles after Store destruction | Reject stock; accept the scoped correction | Linux reproduces SIGSEGV after Store teardown. The correction passes 10,000 formatting operations after teardown, retries and 10,001 typed/dynamic host errors on both Windows toolsets. |
| Callback panic handlers that panic again after catching a panic | Reject stock; accept the scoped correction | All four constructors abort in Linux negative controls. The correction passes 2,000 typed/dynamic calls and exactly 2,001 payload drops per constructor on both native Windows toolsets, including subsequent reuse and errors after Store teardown. |
| Complete native Windows extension catalog | Accept the tested private candidate | All 39 extensions pass five modes, including server and physical restore, and the tools round-trip passes. The strict cached-loading combination repeats all 195 records with the guest-compilation entry point blocked. |
| Aligned patched crate family | Accept the tested package boundary | All seven frozen archives build on both toolsets, contain no dependency on the four upstream API crate identities, and pass executable-only cold/warm launches without compiler-tool or engine-DLL directories. Registry publication and installed SDK carriers remain separate. |
| A complete patched release | Not established by the controls | Published carrier delivery and deployed CPU profiles remain qualification work. The combined backend and package controls pass. SSE2/scalar closure is no longer a required blocker. The fork is not rejected merely for maintenance cost. |

## Engineering scope with maintained patches allowed

**Accept a focused native-V8/WASIX patch series as the engineering approach.**
Do not reject it merely because patched crates must be maintained or published.
The executed controls locate substantial problems at the embedding and package
boundary, rather than requiring a replacement WASIX implementation. Acceptance
of a published release still depends on installed carrier and deployed profile
qualification. The native combinations below pass the tested SDK scope.

| Work | Concrete implementation | Size and remaining risk |
| --- | --- | --- |
| Consumer build and CRT boundary | Producer-built engine DLL, pregenerated bindings and generated C dispatch; automatic internal materialization/loading | Moderate packaging work. Executable-only cold/warm delivery and SDK tests pass on both toolsets. Published Rust/Node/JVM carrier qualification remains. |
| Rust and C ownership | Correct C++ designated deleters, Store-owned entity roots/export vectors, owned import copies, callback finalizers and numeric vectors; preserve borrowed call arguments | The combined research Rust patch changes **nine files, 157 added and 73 removed lines**. The engine owner wrappers add roughly 50 lines; the borrowed-argument candidate adds 15 lines. These are source scope measurements, not proof of Windows correctness or a final production line count. |
| Idle compiler isolate | Retain Engine rather than a resident compiler Store in shared modules; obtain temporary Stores for serialization/equality | A small lifetime change with natural collection demonstrated on Linux. Pinned shared modules hold serialized bytes, so their source isolate need not stay resident. SDK threading and performance still require measurement. |
| Errors outliving a Store | Snapshot native trap messages, delete their native allocation while the Store is alive, own the decoded Rust error Box, and clean up traps discarded during reentry | Three existing backend files; Linux negative/positive controls and both native Windows SDK combinations prove the concrete failure and remedy. |
| Callback panic containment | Return a normal runtime error from the existing `catch_unwind` failure arms | One existing backend file, **10 added and five removed lines**. No consumer callback wrapper is needed. Linux negative controls and both native Windows combinations cover all four constructors. This covers callback panics, not every possible internal invariant failure. |
| No consumer guest compilation | Require seeded caches inside the existing WASIX runtime, propagate the policy through runtime overrides, and reject wire-only/native-incompatible payloads before fallback | A bounded loader change, with positive and negative compiler-breakpoint controls. Four direct/overridden cache misses reject. The complete Windows catalog/server/tools suite passes with the guest-compilation entry point blocked. |
| Kill blocked guest atomic waits | Capture an engine Store interrupt capability; register attachments and retire before teardown; invoke it through the existing WASIX kill hook | Store/attach/drop hooks are implemented and pass on both toolsets. All three WASIX attachment callers propagate ordinary errors after shutdown. No generic host atomics subsystem is needed for the tested SDK path. |
| Cache CPU compatibility | Disable optional codegen internally, produce genuine CET variants and choose compatible assets inside the SDK | Moderate producer/package work. Genuine Windows caches and compatible native selection pass. Full catalog/profile delivery remains integration work. No serialization-source projection of CET or edited cache header is needed by this remedy. |
| Common x64 CPU minimum | Use the approved SSE4.1 minimum and keep flags/profile selection inside the SDK | SSE2-only support is deliberately excluded. A separate scalar catalog is unnecessary for the requested contract. The existing serializer's SSE2 metadata still needs alignment when the production profile is implemented. |
| Patched crate delivery | Keep the Wasmer API identity aligned across `wasmer`, `wasmer-wasix-types`, `wasmer-journal`, `wasmer-wasix` | Four related package identities, a small engine facade and two compressed DLL parts. The actual package family builds and launches on both toolsets. Complete provenance/notices and registry-installed SDK qualification remain. Root Cargo patches alone cannot deliver registry consumers. |

Before the automatic lifetime implementation, composing the base ownership patch with the trap, panic and native-payload
corrections changes **ten existing Wasmer Rust files, 208 added and 108 removed
lines**. The existing-runtime cached-loading policy adds **22 lines and removes
one** in one WASIX file, plus one internal SDK assignment. These measured
research changes exclude DLL packaging, generated bindings, producer/profile
delivery and automatic interrupt lifecycle hooks. They are not an estimate
of every release change.

The repository already maintains substantial Wasmer/WASIX patch series. That
supports patch maintenance as an established practice; it does not mean all
those existing patches are in this SDK's active dependency graph. No calendar
estimate is justified before the combined native result and deployed profile.

A Windows Sys/EH restoration would additionally need compiler ABI, SEH unwind,
trap and side-module exception work. That is a materially larger engine project
than the V8 embedding route demonstrated here. A new worker/IPC runtime adds a
new architecture and is not the first choice while bounded embedding controls
remain available.

## Windows DLL proof and limits

[Run 37277151739](https://github.com/f0rr0/oliphaunt/actions/runs/37277151739)
tests source **`6d28440f0f9227de5c76d8ce1af03e7063d2eb17`**. Its two private-DLL
jobs execute all functional controls successfully, then fail in the audit at
`env["VCToolsInstallDir"]`. Copying Windows' case-insensitive environment into
a normal Python dictionary loses case-insensitive lookup. The one-line fix
reads that tool location from `os.environ`. These remain failed jobs; their
observed research results are not shipping qualification.

The scoped [native audit follow-up 37282522178](https://github.com/f0rr0/oliphaunt/actions/runs/37282522178)
at **`38a0c06c9ca6ea20dfb41891b8ab8aebe8ae5a1f`** finishes **successful on
both Windows toolsets**. It executes the actual fixed environment-lookup
statement from the consumer script, verifies the retained producer hashes,
and audits the DLL and C-only import library with native MSVC `dumpbin`.
It reuses the exact preceding producer artifacts and does not rebuild guests
or claim full SDK qualification. Its isolated branch preserves the longer SDK
experiment without cancellation. Audit artifacts `11333160093` (Windows 2022)
and `11333216562` (Windows 2025 / VS 2026) retain the native receipts.

The independently downloaded immutable artifacts and GitHub ZIP digests are:

| Runner | Job | Artifact | SHA-256 |
| --- | --- | --- | --- |
| Windows 2022 / VS 2022 | `111656685104` | `11331153142` | `82351f83e1483935374b6f12d24c8ebde9c0d8c89668bc9cab17f7fb3ee80541` |
| Windows 2025 / VS 2026 | `111656685144` | `11331067461` | `b85ffad0fd14dff39287d60aca9e93cdf9687edacf7007379a10c84c5f9692bd` |

Independent LLVM 22 PE/import-library inspection verifies each producer DLL
and bindings hash, all 311 consumer imports, private dependency resolution,
fresh consumer builds, EH/SIMD and PostgreSQL WASIX instantiation in both cache
profiles, and ten mixed C++ library processes per runner. Every process checks
10,000 unordered-map entries without corruption. The DLL imports only
`WINMM.dll`, `dbghelp.dll`, `KERNEL32.dll` and `ADVAPI32.dll`. Its consumer
import library exposes no C++ symbols.

The DLL itself has 2,607 exports, including 2,295 C++ exports inherited from
archive directives. The consumer library is deliberately regenerated with
only C entries. The claim is consumer linking through that library, not removal
of every C++ export from the DLL. Four declared tag APIs are missing from the
pinned archive and explicitly omitted, not invented. The producer stages the
DLL beside the test executable. These controls do not prove automatic SDK
discovery, standalone application distribution, complete engine notices,
performance or publication of the dependency closure.

The real Windows Cargo graph has four API-dependent crates to deliver
consistently if a maintained package changes Wasmer's crate identity:
`wasmer`, `wasmer-wasix-types`, `wasmer-journal` and `wasmer-wasix`. A root
`[patch.crates-io]` is not inherited by downstream registry consumers. A
prebuilt DLL alone cannot replace the original Wasmer build script and that
dependency graph.

## Compilation and CPU controls

Fresh-process debugger controls use the actual pinned PostgreSQL guest. All
four breakpoints resolve; the compiling control proves they detect compilation:

| Resolver control | Guest bodies | `Module::make` | Host import adapters | Entry adapters |
| --- | --- | --- | --- | --- |
| Stock WASIX cache miss | 12,118 | 1 | 21 | 1 |
| Strict cache miss | 0 | 0 | 0 | 0 |
| Strict seeded cache hit + WASIX instantiation | 0 | 0 | 21 | 1 |

The cache-only wrapper is a loading control. Production must also preserve
HTTP, TTY, package loading, instantiation hooks and journals; reject Wasm-only
serialized records before V8's deserialize fallback; and qualify core, tools,
support libraries and the full catalog on Windows. This control executes no
SQL or extensions through that wrapper.

The resumed Windows peer jobs pass unmodified same-mask PostgreSQL exchange
for `baseline` and `baseline-no-jcc`. Both masks are `0x1000e`, so this
is no new evidence for different-CET compatibility. The earlier real
different-mask Windows rejection still applies. The [CPU profile analysis](windows-wasmer-feasibility.md#why-the-candidate-is-narrower-than-per-machine-caches)
explains the possible variants. QEMU Conroe rejects the actual PostgreSQL
guest, not just a synthetic SIMD fixture. The user has now explicitly approved
the SSE4.1 minimum; flags and profile selection remain SDK implementation details.

## Scalar producer and pinned library audit

The CPU names describe instructions, not a consumer configuration choice.
SSE4.1 allows some SIMD instructions that an older SSE2 computer cannot execute.
A default SIMD guest may therefore work on a newer laptop and fail on an older
Windows PC. The user subsequently approved skipping SSE2-only CPUs and using
SSE4.1 as the x64 desktop minimum. The following completed scalar experiments
are retained as optional fallback evidence, not required release work.
Producer/profile selection remains SDK-owned and requires no consumer settings.

The exact pinned `wasixcc` 0.4.3 supports overriding its default SIMD flags with
`-mno-simd128` and `-mno-relaxed-simd`. The repository already forwards these
flags into helper-library producers. Its flag string is colon-separated:
`OLIPHAUNT_WASM_WASIX_COMPILER_FLAGS=-mno-simd128:-mno-relaxed-simd`.
This is a maintainer build setting, not a consumer setup step.

Both pinned March 2, 2026 sysroots (`ehpic`, `exnref-ehpic`) were downloaded with
manifest SHA-256 verification and their archives extracted with LLVM tools.
All **2,724 executable Wasm objects contain zero SIMD operators** according to
an operator census. Each variation includes C, C++ and unwind libraries. The
33-byte `libcommon-tag-stubs.a` is a symbol-list stub, not a broken executable
archive. This rules out an assumed libc SIMD rebuild for these exact inputs;
it does not prove that every extension or produced PostgreSQL module is scalar.

Tiny scalar native caches pass deserialization and guest EH (`42`) under both
QEMU Conroe and Opteron G1. The SSSE3 lowering-flag workaround fails: a real
`pinsrq` instruction faults under Conroe during SIMD execution. Do not infer
that one unsupported instruction is the entire compiler repair scope.

The actual scalar PostgreSQL producer **passes**, using the pinned existing
Docker image, `wasixcc` 0.4.3 and WASIX LLVM 21.1.2 in an isolated checkout at
`6d28440f`. The profile receipt confirms both SIMD-disable flags through ICU
and core production. The resulting **10,088,428-byte PostgreSQL guest contains
zero SIMD operators**, SHA-256
`ac5ff3577c626e4ec40acfe51718a42f3cd63bc7f8c791c01787b231918bc907`.

A genuine scalar V8 cache produced under QEMU Conroe is **41,590,152 bytes**,
CPU mask `0x0`, flag hash `0xbc52a89b`. Both a fresh Conroe process and a fresh
Opteron G1 process deserialize that same cache and complete PostgreSQL/WASIX
initialization: 92 imports, 1,245 exports. Readers execute no `Module::new`
path and no cache header is rewritten. The first writer's header-inspection
heuristic matched incidental bytes and returned after writing the cache;
the complete follow-up matches the pinned magic/profile, then the producer
and both fresh readers all exit successfully. V8 itself continues to validate
the untouched payload. Both caches are retained by separate hash receipts.

**Accept scalar production as a tested core compatibility mechanism.** These
are Linux CPU-emulation controls of guest lowering and initialization, not
native Windows old-CPU SQL/catalog qualification. The full tools/library/
extension scalar closure, deployed CPU-profile selection and performance still
need qualification. The application developer receives no build flags or
compiler requirement.

## Memory controls

Local controls use private Wasmer 7.5 copies and C++ owners compiled against
the pinned header. No raw aliased entity pointer gains a blind Rust `Drop`.
Call-value containers use the C API vector destructor; function types use
their correct C++ owner destructor too.

One live instance completes one million cached guest calls. Before numeric
vector cleanup, RSS rises from 31,504 KiB at call 100,000 to 73,704 KiB at call
1,000,000: approximately 48.014 bytes/call. After cleanup the corresponding
interval is 27,444 to 27,456 KiB. This control has **zero arguments** and accepts
only that path. Native diagnosis below rejects applying the same cleanup to
argument-bearing calls without correcting the C API's argument ownership.

Callback-only PostgreSQL cleanup retains 127.822 KiB/cycle over instantiations
10–100. Adding numeric vector and function-type cleanup reduces that to
76.711 KiB/cycle. The longer single-process retry completes **all 1,000**
instantiations without allocator trimming: 252,328 KiB at cycle 500 and
290,876 KiB at cycle 1,000. Its late slope is **77.096 KiB/cycle**, conclusively
rejecting the combined patch as a complete fix. Two earlier concurrent attempts
hit their 180-second deadlines before cycle 1,000 and are incomplete. These
instantiate PostgreSQL and perform host-only WASIX exit without SQL, extensions
or SDK calls.

The resumed Windows SDK job **`111656685292` succeeds** at `6d28440f`. Both
ownership variants pass all 21 runtime, 7 PostgreSQL and 3 UUID/tool regression
tests, then each completes **100 vector database open/create/error/query/close
cycles**. These samples come from inside the process after query results and
the database have dropped, before another open; they improve on the earlier
outside-process sampling boundary. The patch runs log zero Wasmer V8 module
construction markers, which still does not exclude internal V8 adapters.

| Windows control | Completed cycles | First/last post-close private memory | Growth per cycle | Last-50 growth per cycle |
| --- | --- | --- | --- | --- |
| Stock dependency | 25 | 575.375 / 8,594.016 MiB | 334.110 MiB | Not measured |
| Three corrected owners | 100 | 250.824 / 441.297 MiB | 1.924 MiB | 1.569 MiB |
| Owners + callback finalizers | 100 | 251.504 / 429.566 MiB | 1.799 MiB | 1.591 MiB |

Both partial remedies therefore remain rejected as complete reclamation fixes.
The immutable SDK research artifact **`11332288506`** has independently
verified ZIP digest
`sha256:2d58be3157c3d1effacbf045d2f680b16f9ee6ec955ccb3fe2e4d34d63fa2c94`.
The parent experiment run remains red due to its stock negative linking
controls and the original DLL audit error; the SDK job itself is successful.

A further Linux source control retains the uniquely owned export vectors in
the backend Store and deletes them before isolate disposal, preserving borrowed
export aliases during the Store lifetime. It completes 100 PostgreSQL
instantiations and reduces cycle 10–100 growth from 76.711 to **28.000 KiB/cycle**.
This validates another bounded ownership mechanism but rejects it as a complete
fix too. It does not repair reusable import ownership or all remaining entities,
and is not installed in the SDK.

Remaining source defects include owning import/export vectors treated as raw
aliases, unreleased obtained module handles, unowned host-created externs and
missing cleanup on additional call/type paths. Proper cleanup needs copied
reusable imports, Store-scoped export ownership, correct drop order and alias
and Store-before-wrapper tests. This is adapter ownership work.

## Expanded ownership, collection and native combination

The expanded Linux controls clear uniquely owned export vectors and roots
before disposing their Store, copy borrowed imports before giving a vector
ownership, and release temporary module/type wrappers. They retain the alias
lifetime model: cloning a Rust entity does not acquire a new blindly deletable
raw C pointer. Callback census over 100 real PostgreSQL/WASIX instantiations
reports **37,500 created and 37,500 finalized**.

Residual Linux growth was examined with `mallinfo2` and differential Heaptrack
profiles of 10 versus 100 instantiations. The net 439.73 KB live allocation
increase is predominantly V8 import-wrapper/code bookkeeping; the biggest
stack is `WasmImportWrapperCache::AddWrapper` (287.28 KB). It is not evidence of
retained WASIX callback Boxes. The pinned V8 code collector waits for all live
isolates. The Wasmer shared module's idle `orig_store` retains an isolate that
does not service that collection work.

The next control stores the Engine and creates compiler Stores only while
needed. Shared-module storage in this pinned C++ API is serialized bytes,
not a native module requiring the source Store's lifetime. All **1,000** actual
PostgreSQL/WASIX instantiations finish without allocator trimming or forced
code collection. Live host heap falls naturally by **4,621,984 bytes at cycle
718**; from cycle 500 to 1,000 it falls from 4,667,120 to 3,452,944 bytes. RSS
moves from 195,316 to 197,616 KiB during that interval. All **375,000 callback
payloads finalize**. This accepts the mechanism for that Linux path; it does
not prove an infinite memory bound, full SQL/catalog behavior or Windows SDK
correctness. An earlier 240-second attempt stopped at cycle 727; the complete
retry uses a 480-second budget and passes. No private forced-GC API was used.

The statically linked expanded patch fails actual native Windows SDK
`memory_instances_are_isolated` with **`0xc0000374` / heap corruption** on both
VS 2022 and VS 2026. Windows 2022's first setup attempt failed before execution;
the corrected [run 37293793555](https://github.com/f0rr0/oliphaunt/actions/runs/37293793555)
at `57b773b9f9f891b541a954527168c311647ade51` reaches and reproduces the actual
failure. The current-toolset [run 37292903637](https://github.com/f0rr0/oliphaunt/actions/runs/37292903637)
at `2662dddca86016a62440b7c5eb49744740f83d59` reaches the same failure. Those
implementations are rejected. A Linux positive result cannot override them.

The follow-up [DLL + expanded ownership run 37296212076](https://github.com/f0rr0/oliphaunt/actions/runs/37296212076)
at `fe84d3c0c6bb9c817a3ea5f4c261e252d90e55f4` builds the expanded engine
DLL successfully on both toolsets, then the harness chooses System32's WSL
`bash` and stops before SDK execution. That is a harness failure, not a native
SDK result. The corrected [run 37297335476](https://github.com/f0rr0/oliphaunt/actions/runs/37297335476)
at `fa254da0` selects the validated native Git Bash path and combines both remedies. Correct designated deletion executes
inside the engine DLL; Rust imports only C entries. It tests real runtime,
SQL/isolation, extension and tools behavior and 100 fully closed vector
SDK databases with consumer Clang/objcopy removed. **Both native toolsets
reproduce `0xc0000374` heap corruption in `memory_instances_are_isolated`.**
The 100-cycle measurement and extension/tools execution do not run after that
failure. This rejects the combined implementation and the hypothesis that
moving the cleanup into a DLL alone repairs its crash. It does not diagnose
the invalid lifetime operation. Failure artifacts are `11340053492` (Windows
2022; digest `c93f28c3ba6fcf4e9fc7102e7625c9714276d1c2f6bf7f98eeae55f9ad2f0c15`)
and `11339504218` (VS 2026; digest
`c220bb998d675fca24f167faba53215ac67614d27836e8889b192404fc98bebb`).
Producer-owned DLL placement still does not establish automatic installed-package
delivery.

The subsequent [PageHeap/CDB diagnosis run 37299215512](https://github.com/f0rr0/oliphaunt/actions/runs/37299215512)
at `60e8c317` retains the failing native binary's stack and adds isolated test
stage markers. It completes on the current Windows toolset and locates the
first-open failure in `wee8_wasm_val_vec_delete`, called by
`ResearchValueVec::drop` inside `TypedFunction<i32, i32>::call_v8`. The debugger
reports an invalid read from `ffffffffffffffff` before the first database open
returns. Artifact `11341796422` was downloaded and verified against SHA-256
`77f1a6f01296d8c8dddb5441a872ca81c43ff7945d5eabc75ad45db36d5c0a93`.
PageHeap settings apply only to that diagnostic executable and are removed
afterward. This is fault-location evidence, not a weakened acceptance test.

The [pinned C API](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/c-api.cc#L3320)
passes `adopt_val_vec(args)` into the function call. That owning temporary
destroys the caller's argument allocation before returning. The adapter's new
RAII cleanup consequently deletes it twice; an `InvokeAgain` retry can also
reuse freed arguments. The pinned vector constructor initializes result slots
to null references, so uninitialized result kinds do not explain this failure.
The candidate replaces only the C call entry with a 15-line bridge using the
public pinned C++ `Func::call`: arguments are borrowed and released from the
temporary owner, while results return to the caller. This keeps allocation and
deletion inside the engine DLL and preserves the C-only consumer import surface.

A separate Linux negative/positive control selects the original C call or the
bridge inside the same link wrapper and executable. The original path exits
with **SIGSEGV / 139**. The bridge exits successfully after **100,000** ordinary
argument-bearing calls and **1,000 each** of retry, finish, guest-trap and callback
error checks. This proves the bounded call-ownership remedy on Linux; it does
not establish trap-allocation retention or native Windows SDK correctness.

[Run 37301714833](https://github.com/f0rr0/oliphaunt/actions/runs/37301714833)
tests isolated source `09a549fc95d44ecb3d1058e783fb392d89740e5f` and **passes on
both toolsets**. Its numeric argument, retry, finish, guest-trap and callback
error control passes, followed by 21 runtime tests, seven PostgreSQL tests,
three UUID/tool tests and 100 fully closed vector databases. Consumer
Clang/objcopy are absent. This accepts the combined functional remedy and
diagnoses the preceding first-open failure; it does not certify a permanent
memory bound or automatic installed-SDK delivery.

The fully closed database samples improve substantially but still rise:

| Toolset | After first close | After 100th close | Growth over last 50 closes | Artifact and verified ZIP SHA-256 |
| --- | --- | --- | --- | --- |
| VS 2022 | 178.41 MiB | 241.08 MiB | 600.96 KiB/cycle | `11343172042`, `66e052aca0de6594dc8a1e793fb014966268493e8582f75d0d74ff9f72d0f599` |
| VS 2026 | 179.87 MiB | 242.21 MiB | 293.36 KiB/cycle | `11343090816`, `761f26f819f373fb6ed93446551cf1d89503d4785f146ef64c1f4b9fa1aee1d7` |

The VS 2026 sampled peak is 788.29 MiB, so the post-close footprint is not the
maximum transient requirement. These measurements do not classify every
retained private page as a leak. A longer actual-SDK run is needed to separate
warmup/collection from continued accumulation.

The Linux lifetime control additionally intercepts `Isolate::Dispose` to call
the public platform shutdown notification, as pinned `d8` does. The Windows
DLL control has not added that notification. The earlier notification-only
control did not fix Linux growth. The current first-open failure is in call
vector cleanup, so shutdown notification is not its remedy. Native teardown
growth remains a separate measurement after call ownership passes.

## Automatic DLL delivery control

Application-level delay-load flags are an unsuitable published Cargo remedy:
[Cargo's link arguments](https://doc.rust-lang.org/cargo/reference/build-scripts.html#rustc-link-arg)
apply to the declaring package's executable-style targets, and Microsoft's
[supported object-file linker directives](https://learn.microsoft.com/en-us/cpp/preprocessor/comment-c-cpp?view=msvc-170)
do not include `/DELAYLOAD`. Consumers must not supply those flags themselves.

The private candidate instead embeds the producer's exact engine DLL in the
application and generates lazy C-function dispatch from the pregenerated
bindings. It needs no engine import library or compiler tools in the consumer
build. A small SDK-owned loader materializes the immutable DLL under the user's
[known local-app-data folder](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)
and calls [LoadLibraryExW](https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibraryexw)
with an absolute path and restricted dependency search. Symbol lookup uses the
returned module handle; the module remains resident for the engine's process
lifetime. No application DLL placement or `PATH` change is required.

[Run 37304005301](https://github.com/f0rr0/oliphaunt/actions/runs/37304005301)
at `22309e2a` builds this candidate on both toolsets. Three concurrent cold
standalone executables on each toolset pass the argument/retry/trap test and
materialize the exact hash-verified DLL. Their directory contains only the
executable; normal imports omit the engine DLL. The harness then fails because
it expects the load marker at the start of a line, while the Rust test runner
prints its test name first. This is a failed workflow with bounded positive
delivery evidence; warm launches and SDK regression do not execute. The marker
parser is corrected with a local mixed-output/path check. The follow-up also
extends the closed vector-database measurement to 500 cycles.

The corrected [run 37341683321](https://github.com/f0rr0/oliphaunt/actions/runs/37341683321)
at exact `08ddac8afcc30cf158e095b1a9d978b484160d08` **passes both toolsets**.
Each passes all three concurrent cold starts and the warm start, with only
`consumer.exe` in the app directory and no engine DLL in normal imports. The
materialized DLL hashes match the embedded producer bytes. The 21 runtime,
seven PostgreSQL regression and three UUID/tools tests pass, followed by all
500 vector open/error/query/close cycles per toolset.

Both artifact ZIPs were independently hash-verified:

| Toolset | Artifact | ZIP SHA-256 |
| --- | --- | --- |
| VS 2022 | `11361926381` | `8fe4fcae109f7ec9160bc9af133060251e588502b63ffb9744aadf213fe8ad8c` |
| VS 2026 | `11361921694` | `6bbfb9e9751357867cfbc88acc177c604f86fe22aecc27756d9fb287c5e00c67` |

Closed-database private-memory samples show substantial warmup followed by a
much flatter interval. Index 499 denotes the **500th** completed database:

| Measurement | VS 2022 | VS 2026 |
| --- | ---: | ---: |
| First closed database, MiB | 177.83 | 180.52 |
| Closed index 99, MiB | 240.22 | 237.85 |
| Closed index 249, MiB | 247.11 | 247.06 |
| Closed index 499, MiB | 251.56 | 249.05 |
| Last 250 endpoint growth, KiB/cycle | 14.73 | 1.27 |
| Last 100 endpoint growth, KiB/cycle | 42.06 | 15.03 |
| Sampled transient peak, MiB | 800.83 | 797.70 |
| Measured elapsed seconds | 2284.69 | 2341.30 |

No forced garbage collection or heap trimming is used. Natural private-memory
drops occur in the retained series. These are committed process pages, not an
allocation census: the control establishes repeatable 500-cycle behavior and
rejects the earlier multi-gigabyte-per-dozen-databases failure. It does **not**
prove a permanent bound or attribute the remaining small positive trend. The
new trap cleanup is not part of this exact source revision.

This is a delivery mechanism control, not a published-crate result. Production
integration must preserve normal SDK error reporting for cache I/O failures,
package the aligned patched crate identities, and qualify native Node/JVM
carriers. The generated wrappers are mechanical output, not hundreds of manually
maintained engine functions.

## Trap ownership after Store destruction

The pinned backend keeps native trap pointers in `RuntimeError`, leaks the
message vector when decoding a trap, and reads a leaked Rust error Box without
reclaiming its outer allocation. Its formatter consults the native pointer
again. A `RuntimeError` can outlive the Store and isolate that own that pointer.

The Linux negative control reaches SIGSEGV in `Isolate::CreateMessage` through
`wasm::Trap::message` and Wasmer's formatter, at the test's first formatting
loop **after Store teardown**. The scoped correction snapshots the message,
deletes the message vector and trap while their Store is alive, retains an
owned string for native errors, and uses `Box::from_raw` for the existing typed
Rust error transfer. Calls convert native traps before running the reentry
callback, so retries and callback failures drop their discarded traps normally.
The original and corrected controls use the same designated C++ deleters and
borrowed-argument bridge.

The positive control passes 10,000 guest error/retry/discard/reuse cycles,
10,000 formatting operations after Store teardown, and **10,001 errors each**
through typed and dynamic host callbacks. Every typed payload destroys exactly
once, including errors retained after Store teardown. The additional argument
control still passes 100,000 ordinary calls and 1,000 retry/finish/trap/error
cycles. This changes three existing backend files. The mechanism is now qualified
on Linux and both native Windows toolsets; a full allocation census remains
outside this control.
The checked-in `trap-ownership.diff` and runnable fixture preserve the remedy.

The native [run 37352664260](https://github.com/f0rr0/oliphaunt/actions/runs/37352664260)
at `71aa01137e35cdde3c2834a451b52529f5ec92e4` applies that correction and
passes automatic cold/warm delivery, the actual SDK suites and all 100 vector
database cycles on **both** toolsets. Its additional trap fixture then fails
at module creation: it passes WAT text to the SDK's Wasmer build, which
deliberately omits the WAT parser. This is a test-harness defect; it supplies
no native trap-after-Store result. The revised fixture uses producer-compiled
Wasm bytes and keeps the consumer build features unchanged.

## Callback panic containment

All three V8 callback trampolines already use `catch_unwind`, but their caught
panic branches call `unimplemented!("host function panicked")`. That causes a
second panic inside the C callback and aborts the process. The scoped correction
returns an ordinary `RuntimeError` through the existing trap conversion instead.
It changes one file by ten added and five removed lines.

Four separate Linux negative processes abort with SIGABRT: typed and dynamic
constructors, each with and without a FunctionEnv. The corrected fixture passes
2,000 typed/dynamic guest calls per constructor, successful subsequent calls,
exactly 2,001 panic-payload destructions per constructor and error formatting
after Store destruction. The producer-compiled byte fixture passes the same
control. The standard Rust unwind mode is used, as in the SDK's existing panic
recovery; changing that to `panic=abort` would also prevent ordinary Rust recovery.

The combined native [run 37356761224](https://github.com/f0rr0/oliphaunt/actions/runs/37356761224)
at `472cb6d41949593e09ba5ead58fbc32530b78a10` **passes on both Windows
toolsets**. Each passes the complete trap fixture above and all four callback
constructors: 2,000 typed/dynamic calls, exactly 2,001 payload destructions,
successful reuse and error formatting after Store teardown. It also passes
three simultaneous cold executable-only launches, a fresh warm launch, 21
runtime tests, seven PostgreSQL regressions, three UUID/tools tests and 100
closed vector database lifecycles per toolset. The final sampled private
memory is approximately 239 MiB on each host. These 100-cycle samples do not
supersede the separate 500-cycle study or prove zero retained allocation.

Both downloaded artifact ZIP digests match GitHub's immutable receipts:

| Runner | Artifact | ZIP SHA-256 |
| --- | --- | --- |
| VS 2022 | `11365967843` | `35fae640f619d3cd26571bd2515c9b48f6726631a0825ff6fa7d76f1a97a81ed` |
| VS 2026 | `11365779222` | `2b000a5af2288d694d927985f4ca505cf44e4e65f9416220db90d013e11435bf` |

This contains callback-body panics through the existing handler. It does not
claim all arbitrary internal assertions or unsupported reference-value
conversions are implemented. The preceding `71aa0113` fixture failure remains
recorded as failed, with its own retained raw logs and verified ZIP digests.

## Extension exception tags and full Windows catalog

The immutable 39-extension input is statically parsed by Wasmer's own Wasm
parser after checking each extracted module hash. Five executable modules
import exception tags: auto_explain, pg_ivm, pg_textsearch and unaccent each
import one; PostGIS's support library imports two. None defines or exports a
tag in this census.

The implemented V8 tag-import/type paths use exports present in the tested
DLL. The four absent header-declared tag APIs are different paths. Thus the
diagnostic failure in host-created `Exception::new` does not itself establish
that these guest side modules fail.

The full native [catalog run 37359854229](https://github.com/f0rr0/oliphaunt/actions/runs/37359854229)
at `7c3a3f33bd80bb1c3f0a094b150e735b407e6bc1` **passes** the combined
private ownership/error/panic/DLL candidate on Windows VS 2026. The downloaded
receipt contains exactly **39 extensions × five modes = 195 passed records**:
direct SQL, server SQL, restart, physical backup/restore and materialization.
This includes all five tag-bearing side modules identified above. The SDK's
21 runtime and seven PostgreSQL regressions, vector extension test, two full
catalog library tests, explicit server test and logical tools round-trip pass.
The lifecycle-only extension diagnostic remains deliberately ignored; its
separate 500-cycle result is recorded above.

Consumer Clang/objcopy paths are removed. Immutable artifact `11367902235`
has independently verified ZIP SHA-256
`4e812c3a01283786f1b2a4826b228fde4b3921348d48dccabde0a31ce8d54ac4`.
The mode files all contain `passed`, rather than a green job alone serving
as catalog evidence. This qualifies actual tag-bearing SDK side-module use
with the private candidate; it does not implement unused host-created exception
objects or qualify the deployed CPU-profile family. The existing four-host
selected-product gate remains separate.

## Full SDK cache-only policy

The first loading-only wrapper deliberately omitted unused services and was
never a production runtime. The smaller combined candidate changes the
existing `PluggableRuntime` policy, preserving its HTTP, networking, package
loader, TTY, hooks and journal implementations. Its `OverriddenRuntime`
propagates the policy, so a runner's engine override cannot re-enable guest
compilation. Four direct/overridden bytes/hashed cache-miss controls pass on
Linux. The SDK enables the policy internally with one assignment.

A separate small Wasmer deserialization guard rejects wire-only/truncated
serialized payloads before the pinned C API's compilation fallback. Normal
native-cache compatibility checks remain intact.

[Run 37362281079](https://github.com/f0rr0/oliphaunt/actions/runs/37362281079)
at `1940950197617bd6023930bae8bba42d77da3721` **passes** the complete
native Windows VS 2026 catalog/server/tools suite with this policy. All
**39 extensions × five modes = 195** retained mode files contain `passed`.
The four direct/overridden bytes/hashed cache-miss controls reject, and the
21 runtime tests, seven PostgreSQL regressions, vector extension test, two
catalog library tests, server test and logical tools round-trip pass.

A maintainer-only C API sentinel aborts if `wasm_module_new` is reached by
the SDK tests; it is never reached. Producers generated the immutable AOT
inputs before the blocked consumer run. Independently verified artifact
`11367594768` has ZIP SHA-256
`a45eaf6e196cf4ff19bb65e88d2732d44f55c2e3d3b98ceef16319d6de7b915c`.
The cache-only receipt also confirms unchanged dependency resolution except
for the private WASIX source. Consumer Clang/objcopy paths are removed.

The pinned V8 [C API serializer](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/c-api.cc)
calls `TierUpAllFunctions` before serializing all TurboFan guest code. If
native serialization fails, it can return wire-only bytes, which the new
payload guard rejects before deserialization. Together with the separately
executed guest-compiler breakpoint controls, these results support the
precompiled-guest contract. The sentinel blocks the C API compile entry; it
does not instrument every internal V8 compiler. Ordinary runtime host adapters
still generate machine code, so V8 is not headless. Deployed CPU-profile assets
and published carriers remain separate qualification work.

## Genuine Windows CPU-profile producer

A producer-only freestanding Windows program uses the exact tested engine DLL
to serialize the immutable PostgreSQL guest. Its reader rejects wire-only
payloads before deserialization; it never calls the compiler. Wine supplies
the Windows API environment; QEMU supplies the requested producer CPU. These
tools are maintainer infrastructure, not SDK consumer requirements.

An initial local cache has genuine native mask `0xe`, flag hash `0x33f7aeab`,
31,379,594 native bytes and the unchanged guest digest. However the first
hosted [run 37349152347](https://github.com/f0rr0/oliphaunt/actions/runs/37349152347)
at `1bad2bf7abb4b18588b6dde19a8d502caf59312e` correctly fails its mask guard:
Wine restarts itself as a native process, escaping QEMU and recording the host's
`0x1000e` mask. The earlier local low-mask success did not independently prove
that CPU emulation survived the restart.

The corrected control uses Wine's existing `WINELOADERNOEXEC` startup path,
verified in its [pinned loader source](https://github.com/wine-mirror/wine/blob/wine-9.0/dlls/ntdll/unix/loader.c).
The actual Windows process now prints CPUID leaf 1 ECX `0x80082201` and leaf 7
ECX `0x0`, confirming the requested Penryn CPU rather than the native host.
The [follow-up 37350226264](https://github.com/f0rr0/oliphaunt/actions/runs/37350226264)
confirms those CPU bits and successful cache serialization/deserialization,
but **fails on process exit**. Local stage markers show module and Store
cleanup complete before the Wine/QEMU shutdown crash. Keeping the Engine
instead of calling its C deleter still crashes. A minimal Windows executable
with no V8 work exits normally. Positive cache markers alone were therefore
insufficient to accept this producer.

The emulated helper now uses direct Win32 process termination after completing
module and Store cleanup, preserving its requested exit status. This is an
internal producer workaround for the emulation shutdown problem. Native
Windows readers use a separate executable with ordinary `ExitProcess`; SDK
applications do not use this producer workaround.

[Run 37353127348](https://github.com/f0rr0/oliphaunt/actions/runs/37353127348)
at exact `7231ac11003f96d64d503ce178f69fad4710f92a` **passes** the emulated
producer/fresh reader and both native Windows readers. All use the same
hash-verified engine DLL. The low cache has mask `0xe`; native writers produce
`0x1000e`. Both have flag hash `0x33f7aeab` and 31,379,594 native bytes for the
unchanged PostgreSQL guest. On both native hosts the low cache returns the
explicit rejection status 24, while the matching high cache deserializes and
shuts down normally with status 0. Readers have no compilation fallback.

The native cache-pair ZIP digests were independently checked:

| Evidence | Artifact | ZIP SHA-256 |
| --- | --- | --- |
| Emulated producer | `11362519443` | `f420f3d65c31197402ddce02d9885f421a9414d466bf2bc60c65cf60c99267be` |
| VS 2022 readers | `11362748953` | `c4af03a9e6e551b3458add483fda3feba02402c7f8fe693a61744eaacf3bc2c6` |
| VS 2026 readers | `11363551962` | `42206e0e1e82f7cf6f5aea5df0e3b275d40a8de82aa69d96091213a07ce77d46` |

The low cache SHA-256 is
`2fb5f3453fd6a2664edc0ce34d1418a4fa6c78f7727cba649ee28d94c2850cd0`.
Native cache headers are never edited to force acceptance. This establishes
genuine variant production and native selection, not physical older-Windows
hardware coverage, SQL under both profiles or a fully profiled extension
catalog. The reverse emulated selection and native interruption controls also
**pass** in [run 37354427792](https://github.com/f0rr0/oliphaunt/actions/runs/37354427792)
at `06093b02`. The emulated reader returns rejection status 24 for the genuine
native `0x1000e` cache, then status 0 for its compatible `0xe` cache. Native
readers again reject `0xe` and load `0x1000e`. Both selection directions use
fresh processes and keep the compatibility checks intact.

Verified ZIP digests for that final CPU/interruption control are:

| Evidence | Artifact | ZIP SHA-256 |
| --- | --- | --- |
| Emulated producer/reverse selection | `11363249858` | `2e1f1ddc7555baa0e9e647541fa30bc3ddddf7898297b4930101887c6895654a` |
| VS 2022 cache/interruption readers | `11364500748` | `c29c69ecbea2f557a2c2d3314e3d9bfa2a5f1937f883b0f468f938f9bdde9d8f` |
| VS 2026 cache/interruption readers | `11364515592` | `7f0ef46fa45cb872c8f10444eff2ef56c0255b114a0c8bc4598a913d625fcd94` |

## Atomic interruption and actual guest instructions

A 100 ms native guest wait returns timeout status normally. An indefinite
wait with registered stock shared-memory operations survives delivered WASIX
`Sigkill` and reaches the parent five-second timeout. Host atomics report
`Unimplemented`. A separate V8 API control captures the isolate inside a host
callback, keeps it alive until the sender joins, and obtains a trap after
cross-thread termination. It does not recover an isolate by guessing layout.
V8's pinned [public API](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/include/v8-isolate.h)
and [native wait implementation](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/execution/futex-emulation.cc)
support the mechanism.

A private `MemoryOps` control bridges the real `WasiProcess::signal_process`
kill path to that interruption. All **20** fresh Store/instance/WASIX cycles
return a trap in 251–252 ms and retire the interrupt capability before Store
drop; a late process signal after destruction passes each time. A mutex
serializes interruption with capability retirement. This proves the kill-path
mechanism and that tested late-signal ordering, not every concurrent race or
the full shared-memory API. Production needs a maintainer C API to obtain the
Store's isolate capability; the experiment's callback capture is not added to
the PostgreSQL guest.

The final CPU/interruption run above also executes 20 fresh Store cycles with
an indefinite native wait on **each Windows toolset**. Public V8 interruption
returns a trap and Store teardown completes every time: elapsed ranges are
265–282 ms on VS 2022 and 250–266 ms on VS 2026, including a deliberate 250 ms
sender delay. The sender joins before the Store drops. The test locates the
pinned public methods through the engine DLL's verified exports and captures
the isolate in a host callback; it never guesses native object layout.
This proves the Windows engine mechanism. The subsequent combined
[WASIX registry run 37361069023](https://github.com/f0rr0/oliphaunt/actions/runs/37361069023)
at `3bcb39a88998803f14ba1e2b9d5911b4dfd8d1a5` **passes on both Windows
toolsets**. Each executes 20 single-waiter cycles and five cycles with three
isolates waiting on the same shared memory, using the real WASIX process
signal path. All 35 waiters return errors in 250–252 ms, including the
deliberate 250 ms delay. A subsequently attached isolate stops in each of the
25 cycles; 2,500 signals after Store teardown pass. The same binary's stock
path receives Sigkill but reaches the five-second parent timeout. The registry
serializes capability retirement and interruption with one mutex.

The native control's independently checked ZIP digests are:

| Runner | Artifact | ZIP SHA-256 |
| --- | --- | --- |
| VS 2022 | `11366534140` | `f6a17577813467049e499a2e5915b5f5d0a4ee85b29ff7c56e8c0c3dd0346bca` |
| VS 2026 | `11367142308` | `d7790d9af1f9af75c096c5e77dca41ad4bcf1fd793678bd1091c1c65a1bcfadf` |

The proposed capability acquisition can be smaller than adding a new V8
Store getter. Pinned `Func::call` enters the owning isolate's scope even when
calling a host function directly. A temporary host function therefore obtains
`Isolate::GetCurrent` **before any guest module is created**, without a guest
export or private-layout access. The updated Linux registry control passes
all 25 cycles this way. Native [early-capture run 37363247840](https://github.com/f0rr0/oliphaunt/actions/runs/37363247840)
at `f10af7903d92c6d3e1687e66e230a367650c50e8`, attempt two, **passes on
both Windows toolsets**. Each repeats the 35 waiters, 25 late attachments and
2,500 signals after Store teardown. Wait elapsed ranges are 248–250 ms on
VS 2022 and 248–249 ms on VS 2026; the deliberate sender delay is 250 ms and
timing begins after initial capability acquisition. Late attachments stop in
0 ms. The stock negative control again times out after delivered Sigkill.

Attempt one failed before any step because neither hosted runner was acquired;
the same source succeeds on retry. That infrastructure failure remains
recorded separately. The downloaded attempt-two ZIPs have verified digests:

| Runner | Artifact | ZIP SHA-256 |
| --- | --- | --- |
| VS 2022 | `11368078780` | `e65114b5db9bdbb467c97a616e1228da16e11ffc6baa9deecc96b094252b2021` |
| VS 2026 | `11368183572` | `16ccdd52488896fdb848e200b3e0c15a7687889dcd2c937454e15f26a6dc475d` |

Production must capture/retire automatically with Store lifetime, register
every isolate attached to the memory, and reject new attachments after
shutdown. The current fixtures manually perform those lifetime operations.

Static parsing of both PostgreSQL fixtures and all executable modules extracted
from the immutable 39-extension fixture finds a native `memory.atomic.wait32`
in every executable module. The common body uses an initialization-state
compare/exchange and waits indefinitely when another initializer holds state
`1`. The named PostGIS support-library body is `__wasm_init_memory`; its second
waiter is `__wasilibc_futex_wait`. This disproves the claim that current guests
contain no native waits. It does not prove ordinary SQL reaches the waiting
branch or reproduce an SDK deadlock.

An engine bridge must safely retain and retire interrupt capabilities, wake
every relevant isolate sharing memory, map termination to terminal SDK cleanup,
and cover shutdown races. V8 termination alone does not implement missing host
wait/notify APIs or establish the full `disable_atomics` contract.

## Automatic lifetime hooks and package boundary, October 6 continuation

The previous fixtures required manual capability capture and retirement.
Product-owned patch `0005-automatic-shared-memory-interruption.patch` now
performs both inside the V8 Store. It connects the existing shared-memory
operations to the real WASIX kill registry, preserves a single shutdown state
through native aliases and re-sharing, and registers attached Stores
automatically. Termination and Store retirement share a mutex; retirement
happens before native references or the Store are deleted. Memory state retains
weak capabilities, so late operations cannot keep or address a deleted isolate.

[Run 37371077177](https://github.com/f0rr0/oliphaunt/actions/runs/37371077177)
at `2263e93d2e8b26396ad86d36578697a94033ad47` **passes**. The stress control
passes on VS 2022 and VS 2026 without raw isolate handles, custom memory
operations or manual retirement supplied by the test. Each toolset covers
25 wait cycles, 35 blocked waiters, 25 rejected late attachments, 2,500 signals
after teardown and 32 races involving 288 Stores. Total blocked-wait elapsed
time is 250–252 ms and 250–251 ms respectively, including the deliberate
250 ms sender delay; these are not measurements of cancellation latency alone.

The full VS 2026 catalog at that same source passes all 195 records for
39 extensions across direct SQL, server SQL, restart, physical backup/restore
and materialization, plus the existing runtime, PostgreSQL and tools checks.
The cached-loading policy and native-payload guard are active, and the
consumer `wasm_module_new` sentinel is blocked and never reached. This is
the automatic-lifetime combination, not just the earlier manual registry.

| Evidence | Artifact | Verified ZIP SHA-256 |
| --- | --- | --- |
| Automatic hooks, VS 2022, attempt one | `11371032190` | `903f2562be7fae672a6bfbdb6c7cd9eb4b2d9678b6c3aa18cd4dc6c56fb2d1fa` |
| Automatic hooks, VS 2026, attempt two | `11371323507` | `d5ba3c1e808c2ab46e67b0d3cdcf9ab730eb69038e69e13aca5c0405455e6597` |
| Full strict catalog, attempt one | `11372230013` | `e534bf4080f2230b954b22a5ddc0cddd7e9b266f7a8836278efbefc5e3b84336` |

The first VS 2026 stress job acquired no runner and executed no steps.
GitHub's annotation says the hosted runner was not acquired after multiple
attempts. Only that job was retried, at the same SHA; the successful first
catalog/VS 2022 results remain independently recorded.

The first patch rejected late attachments by panicking because the existing
`SharedMemory::attach` API is infallible. Tracing all WASIX callers found
three paths that already return errors. Follow-up patches add `try_attach`
inside Wasmer and use it in WASIX's task manager and dynamic linker. The
existing API remains available; the SDK requires no callback wrapper or public
API change. The clean local control passes all earlier interruption/retirement
cases, 25 ordinary attachment errors, 25 task-manager attachment errors, and
256 additional attachment attempts racing with shutdown. No expected panic
is needed. Local Rust sources match the clean native candidate; its Linux
C API build retains diagnostic owner/call wrappers and an unused host-tag
deleter binding adapter, so it is not native Windows qualification.

The measured combined source scope is now **13 existing Wasmer Rust files and
one new file, 403 lines added and 121 removed**. WASIX's cached-loading policy
and three attachment callers total **four files, 27 added and four removed
lines**, plus one internal SDK assignment. C++ owners/borrowed arguments,
generated dispatch, packaging and CPU-family production are excluded.
This remains a bounded embedding correction, not a WASIX implementation rewrite.

An extracted-package control stages `oliphaunt-wasmer`,
`oliphaunt-wasmer-wasix-types`, `oliphaunt-wasmer-journal` and
`oliphaunt-wasmer-wasix`. Dependency aliases and Rust library names stay
unchanged, while every family edge uses the corresponding exact private
package identity. The DLL has an internal facade and compressed payload parts.
The existing deterministic Cargo source packager freezes all seven archives;
a consumer compiles their extracted contents, checks that none of the four
upstream API packages remains in its graph, and reconstructs the exact DLL.

The local control, including the clean attachment patches, passes. Its raw
DLL is 37,411,328 bytes, SHA-256
`cd40c9c80eef9d3d796ca0ecda2be0b32c5da74c672e21d85acd4818e1451786`.
Compressed payload size is 14,524,138 bytes. The two actual `.crate` files
are **8,382,040 and 6,085,661 bytes**, each below the 10 MiB package limit.
The four API crates are all below 1 MiB. This tests actual archives and byte
reconstruction, not an estimate from raw source size.

The first native family-only
[run 37374970714](https://github.com/f0rr0/oliphaunt/actions/runs/37374970714)
at `f4bdceb4346bfef51f3203c7a32463a1fcd2635c` passes the automatic interruption
stress checks but fails the package consumer build on both hosts. Its harness
enabled WASIX's `v8` feature without the existing `sys-minimal` native services,
leaving the native instance-handle types unavailable. This is corrected to
the SDK's existing feature combination; it does not require a new consumer
feature. Failed logs/archives remain recorded. A source fingerprint generated
from an older local diagnostic copy was also caught by the exact-input guard.
[Run 37376105057](https://github.com/f0rr0/oliphaunt/actions/runs/37376105057)
at `78dd979d3ff6708cbafe0c52e1b70a489167dc8a` was cancelled before testing
that incorrect fingerprint. The corrected input is the clean registry file;
the obsolete diagnostic helper is absent from the candidate.

The clean attachment stress steps in
[run 37376903556](https://github.com/f0rr0/oliphaunt/actions/runs/37376903556)
at `cc2cacf13ae1927f92f2ba2672ad5e515f35620d` **pass on both Windows toolsets**:
25 ordinary attachment errors, 25 task-manager errors and 256 additional
attachment/shutdown attempts, alongside the earlier wait and teardown cases.
The package steps fail because the harness omitted Wasmer's existing `headless`
feature while selecting `sys`. The native SDK already selects that feature;
the correction changes only the package harness. The full strict
catalog/server/tools job at this source **passes**: all 195 records, 21 runtime
tests, seven PostgreSQL regressions, vector, server and tools checks. The compile
sentinel is blocked and never reached; the cached-loading policy is active.
The aggregate run is failed because of the older package harness steps.

| Evidence | Artifact | Verified ZIP SHA-256 |
| --- | --- | --- |
| Clean errors and failed package harness, VS 2022 | `11373115951` | `39f5ed10bc168706bbe3d96b71932d38cc3c697b0d876352e9aef5451a24b529` |
| Clean errors and failed package harness, VS 2026 | `11372423798` | `328f478a5d4622c95b4e15fdb0d4164cb8bf5ab1565ab046c8f55b0396666ea7` |
| Full strict catalog with clean attachment errors, VS 2026 | `11374645308` | `b265e4722f4b24a5874192bb87a7af54e52c40ec70bba14affce00b7aa142e72` |

The corrected package harness builds a standalone executable from the frozen
archives, removes compiler-tool and engine-DLL directories from its environment,
then checks cold and warm launches, the actual loaded DLL path, and exact DLL
bytes. It also verifies that the engine is absent from the executable's normal
imports. The strengthened local control passes. Native
[run 37380157501](https://github.com/f0rr0/oliphaunt/actions/runs/37380157501)
at `de736643a36766d8bfa6e573900bf77f27ab4f78` builds all seven frozen packages
and their consumer on both toolsets. Launch verification then fails in the
harness: it reads a mixed-case key from a plain environment dictionary, but
Python normalizes Windows environment keys to uppercase. No launch result is
claimed from that run. The corrected driver finds the existing MSVC inspector
on its filtered PATH. Follow-up
[run 37381922545](https://github.com/f0rr0/oliphaunt/actions/runs/37381922545)
at `0df8c5efad5fe26c96b8b5da6767f856b2140763` **passes on both Windows
toolsets**, including the repeated clean attachment/shutdown stress control.
Only the harness changed; the canonical interruption/attachment patches are
byte-identical to the full-catalog candidate.

Both consumers build all seven archives with no dependency on the four original
API package identities. Each starts with only its executable in the working
directory, after the matching engine cache is removed. Cold and warm launches
pass; the loaded path points to the SDK-owned engine cache and its bytes match
the producer DLL. The engine is absent from normal executable imports. The
consumer performs a real V8 host call with arguments, shares/attaches memory,
destroys both Stores and safely signals after teardown. DLL reconstruction from
the two compressed payload crates matches size and SHA-256 exactly.

| Final package evidence | Artifact | Verified ZIP SHA-256 |
| --- | --- | --- |
| Frozen archives and cold/warm launches, VS 2022 | `11375583174` | `33079c0fb84c182c280a0587c03e182118bd23737fbaddaf0562afb8b69489e7` |
| Frozen archives and cold/warm launches, VS 2026 | `11375468564` | `d5783b1476966097fb2abe72ef4967e2bdce952c1c8cc4cc03f9b87b087f39cb` |

The native payload archive sizes are 8,381,419/6,059,975 bytes on VS 2022
and 8,382,056/6,085,737 bytes on VS 2026. Every actual `.crate` remains below
10 MiB. No Clang, objcopy, application engine flags or manually placed engine
DLL is needed by these consumers. The source provenance, archive hashes,
dependency graph and cold/warm logs are retained with the receipts.

The package harness overrides only unpublished private package names. The
engine facade/parts deliberately remain `publish = false`; complete notices
and release provenance are not assembled by this experiment. The diagnostic
compilation sentinel is omitted from package contents, while the real cached
runtime policy and native-payload guard stay present. Normal registry-installed
SDKs, matching CPU families for every guest, and combined installed Rust/Node/JVM
qualification remain production work. Root SDK dependency selection is
unchanged by these private controls.

Local validation passes the affected runtime JavaScript format/lint tasks,
Python syntax checks, the formatted family consumer, Markdown lint and the
changed-file pre-commit checks. The complete tracked-file pre-commit run finds
four pre-existing EOF formatting defects and rewrites context whitespace in
seven already-qualified `.diff` files. Those unrelated edits were restored;
all 89 guarded patch/diff hashes are unchanged. The broader formatting run is
recorded as a failure, not a Windows engine failure or a green release gate.
The isolated workflow passes the complete pinned workflow validation gate.

## Code, SDK boundary and CI review

The [October 6 code review](windows-v8-review.md) records the cleanup applied
after `30b1ad2a`. It fixes the patch-rewriting pre-commit configuration, four
EOF-only defects, an unenforced dependency-resolution comparison and an
overwritten path assignment. The lifetime checker now validates every cycle
and race instead of accepting a summary alone, and fixture generation rejects
source drift. An offline Moon unit task and CI selection regression cover
those drivers. Historical stock diagnostics become manually dispatched.

The stronger parser accepts both original automatic-interruption logs and both
final fallible-attachment logs from the immutable native runs. Generated
Windows test bytes and all 89 existing patch/diff hashes are unchanged. This
review does not require another engine build or supersede the native source
identities above.

The dependency trace also corrects the earlier installed Rust/Node/JVM scope:
WASIX Rust and Node share the engine. Current Kotlin/Swift bindings use the
native runtime; Kotlin JVM compilation/tests are not installed Windows WASIX
delivery. Production qualification must cover the actual WASIX Rust/Node
carriers and retain other SDK lanes when their shared inputs change.

## Upstream disposition and qualification

Upstream issue states and PR heads were refreshed at 22:09 UTC on October 5
(October 6 local date). No completed inspected change supplies the entire remedy:

- [#6607](https://github.com/wasmerio/wasmer/issues/6607),
  [#6680](https://github.com/wasmerio/wasmer/issues/6680) and
  [#7006](https://github.com/wasmerio/wasmer/issues/7006) remain open.
- [#6930](https://github.com/wasmerio/wasmer/issues/6930) is closed, but
  maintainers explicitly declined a backport for the removed Wasmi backend.
  Its ownership design is useful evidence, not a shipped V8 fix.
- [#6752](https://github.com/wasmerio/wasmer/pull/6752) implements guest
  Wasm-C-API imports through WASIX. It does not deliver a complete native
  WASIX host DLL with the SDK operation surface.
- [#7005](https://github.com/wasmerio/wasmer/pull/7005), head
  `31ef29da92d0c650acbd8dbba7270cf942d85346`, remains draft; it concerns
  process-family cancellation and blocked host work.
  [#7065](https://github.com/wasmerio/wasmer/pull/7065), head
  `a5d046c548a6bf58de5ca3c499cb6b69bfe138ac`, remains open and depends on it.
  Compared with the previously inspected `c3733090`, its two new commits change
  only the `lib/napi` submodule to `f0446dfedfcdb3245e1a992051b591166af62b4f`.
  That provider adds native V8 lanes and metered WebAssembly for EdgeJS;
  its native Wasmer dependency still selects `sys-default`. The pinned
  [provider manifest](https://github.com/wasmerio/napi/blob/f0446dfedfcdb3245e1a992051b591166af62b4f/Cargo.toml)
  and [released-guest ABI limits](https://github.com/wasmerio/napi/blob/f0446dfedfcdb3245e1a992051b591166af62b4f/FROZEN_EDGEJS_ABI.md)
  establish a different embedding, including rejected module cached-data calls.
  The update changes no native Wasmer V8 backend files. It is not a shipped
  replacement for this SDK's Wee8 ownership, AOT or CPU-cache contract.
- [V8 15.0.1 C API](https://github.com/v8/v8/blob/15.0.1/src/wasm/c-api.cc)
  retains the relevant empty-base `delete x` macro; its
  [x64 CPU probe](https://github.com/v8/v8/blob/15.0.1/src/codegen/x64/assembler-x64.cc)
  still records hardware CET capability. An upgrade is not an accepted fix.
- The newer [Wasmer #6956](https://github.com/wasmerio/wasmer/pull/6956), head
  `7de0548fd15eed9457d2f9a53d7136b3b6767b74`, updates the SDK integration and
  N-API submodule to `fed0b9cf3c5af36e4aa026b565de7a0f82f811be`. Its native
  V8 backend edit changes only shared-memory visibility. The N-API host does
  expose V8 termination and tests JavaScript-loop shutdown, useful precedent
  for the interrupt bridge; it is a different isolate/provider from this
  Wasmer guest engine. Reported native SDK coverage is macOS, not Windows.
  It does not fix the native guest ownership or cache contract.
- Its prebuilt engine selects [Wee8 11.9.9](https://github.com/wasmerio/v8-custom-builds/releases/tag/11.9.9),
  source `775f97e372aad1fb6ad119883ae177213c1773a8`. The Windows build script
  is byte-identical to the pinned 11.9.7 build. The
  [Python shared-library fix #17](https://github.com/wasmerio/v8-custom-builds/pull/17)
  changes Linux TLS access and artifact platform coverage, not the inspected
  native guest ownership or CPU mask. A binary-version override alone cannot
  fix the unchanged Rust call/container leaks or consumer build script.

The earlier [run 37267345495](https://github.com/f0rr0/oliphaunt/actions/runs/37267345495)
at `2654aa260a31b71ceb31d019770408ad20151e16` finishes with **Builds, Required
and Qualified failing** because selected WASIX runtime packaging is skipped.
All seven native extension producers, Android packages, four desktop installed
consumer hosts, TypeScript/browser consumers, full 39-extension portable
lifecycle and final extension assembly pass. Explicit named producer-status
checks repair that skip; the full local workflow gate passes.

The full selected-product [run 37277184644](https://github.com/f0rr0/oliphaunt/actions/runs/37277184644)
**finishes successfully**, including **Builds, Required and Qualified**, at exact
source `6d28440f0f9227de5c76d8ce1af03e7063d2eb17`. All selected source checks,
unit tests, seven native extension producers, four desktop consumer hosts,
portable/browser checks, all 39 extension lifecycles, AOT and runtime packages
pass with same-run producers. Its catalog evidence artifact is `11335411171`,
ZIP SHA-256 `a6d3957cfaacbbed5946cfe005ac240dd5ff19be4d608e0eff98adaf402c9ce2`.
This qualifies that repository revision against the selected repository checks;
it does not install or qualify the newer private ownership fork, establish
older-CPU compatibility or complete the consumer contract. No upstream comment,
PR, merge or package publication is performed.

## Evidence retained locally

Verified SDK/native-audit receipts, logs, private control source snapshots,
source diffs, debugger scripts and SHA-256 indexes are retained in the ignored
`tools/experiments/wasmer-v8/results/validation-2026-10-05/` directory. The
`resumed-linux-controls/README.md` explains the control stages and replay inputs;
its `complete-receipt.json` distinguishes binary and source identities before
the subsequent export-container control. Hosted Windows evidence has durable
run/artifact identities above and 90-day retention. The Linux private controls
are local evidence, not a purported upstream patch or published dependency.
