# Automatic Windows V8 integration

October 6 continuation: product-owned Store/memory lifetime hooks now pass
on both native Windows toolsets and in the full strict extension regression.
Follow-up attachment errors and an aligned extracted-package consumer also
pass on both Windows toolsets, including executable-only cold/warm launches.
The full strict catalog passes with the clean attachment patches. The
[engine patch record](../../wasix/runtime/engine/README.md) describes ownership,
shutdown ordering and the remaining release boundary. Exact results below are
historical snapshots; the [decision ledger](windows-v8-decision-log.md) records
the continuation.

Decision update, **October 5, 2026**: the stock integration does not meet the
requested consumer contract. A maintained patch series is acceptable and has
bounded DLL, cache-only loading, ownership and interruption controls. The
[decision ledger](windows-v8-decision-log.md) assesses patch size and current
native results; it distinguishes engineering feasibility from release readiness.
The private combined DLL/borrowed-argument candidate subsequently passes
automatic executable-only cold/warm delivery and **500 vector database cycles
on each of two Windows toolsets** in
[run 37341683321](https://github.com/f0rr0/oliphaunt/actions/runs/37341683321).
The later combined error/panic candidate also passes on both toolsets, and
the native WASIX kill registry passes simultaneous waiters and late signals.
The full native Windows catalog passes all 195 extension/mode records and
the tools round-trip, including the strict cached-loading combination with
the guest-compilation entry point blocked.
These supply native mechanism evidence without installing the private fork in
the production dependency closure.
The full selected-product [qualification run 37277184644](https://github.com/f0rr0/oliphaunt/actions/runs/37277184644)
at `6d28440f0f9227de5c76d8ce1af03e7063d2eb17` passes **Builds, Required and
Qualified**, including all 39 portable extension lifecycles and installed consumers.
Those regression checks qualify that integration revision; they do not qualify
the subsequent private patch combination or complete published carrier and CPU
profile qualification. The current decision ledger records those separate
controls and their limits.

## Consumer contract

The same Oliphaunt dependency, constructors, configuration, queries, transactions,
extensions, tools and async APIs must work on Windows. Consumers must not select
a backend, use a Windows-specific initialization path, or accept reduced SQL
error recovery. Backend and artifact selection belong to the SDK and package
producers.

Moving a cross-platform application from Linux/macOS to Windows must require
no dependency or feature changes, engine flags, environment variables, compiler
installation or first-run guest compilation. Maintainers produce and package
the PostgreSQL, extension and tools AOT artifacts. Consumers load them. An
automatic fallback to `Module::new` on an incompatible Windows cache would
violate this contract. The SDK's direct artifact loader has no such fallback;
WASIX's stock resolver can still compile on module-cache misses. The private
existing-runtime cache-only policy and native-payload checks pass the complete
Windows catalog/server/tools suite; integrating and delivering them remains
production work. See
the [feasibility follow-up](windows-wasmer-feasibility.md#engine-packaging-and-static-link-isolation).

This branch builds on [Wasmer upgrade PR #247](https://github.com/f0rr0/oliphaunt/pull/247)
and its correctness prerequisites. It is integration work, not yet a qualified
Windows release. The [standalone experiment](../../../tools/experiments/wasmer-v8/README.md)
records the upstream history and the six diagnostic failures.

The [runtime alternatives research](windows-runtime-alternatives.md) evaluates
upstream workarounds, engine packaging, Wasmtime, WasmEdge, wasm2c and interpreter
limits against this consumer contract, including an actual Windows-target
Wasmtime AOT compile of the PostgreSQL guest.

## Implementation

- Windows automatically constructs the native Wasmer V8 engine. Linux and macOS
  retain their LLVM artifacts and headless runtime.
- Windows core, tools and extension producers serialize V8 modules and publish
  `engine: v8` manifests. Windows carrier crates and the SDK reject LLVM
  manifests; other targets reject V8 manifests.
- Artifact filenames, producer cache directories and SDK cache identities
  distinguish the engines. Existing LLVM output cannot satisfy a Windows V8
  installation.
- Stores are constructed on their executing thread. The existing async owner
  thread remains the consumer-facing async implementation; no unsafe `Send`
  adapter is introduced.
- Existing SQL recovery, transaction, COPY, persistence, extension, tools and
  packaged-consumer tests remain the acceptance tests.

WASIX's `sys-minimal` feature still imports Sys types. Windows therefore enables
Wasmer's `headless` feature alongside `v8`, without LLVM, Cranelift or Singlepass.
Every execution engine is explicitly V8; the headless dependency does not select
a Windows compiler backend.

## Engine provenance and source-build prerequisites

Do not equate Wasmer's download label with the V8 engine version. Wasmer 7.5.0
downloads the **Wee8 distribution release `11.9.7`**. Its Windows
[build script at release commit `844d01dc10edaa0461715f484e06b004f1fd023e`](https://github.com/wasmerio/v8-custom-builds/blob/844d01dc10edaa0461715f484e06b004f1fd023e/build.ps1)
pins **V8 `13.6.233.17`**, official source commit
[`b0a55a7dad7f536cce1f9aaddba89894c8533946`](https://github.com/v8/v8/tree/b0a55a7dad7f536cce1f9aaddba89894c8533946).
It statically links ICU, enables pointer compression, disables the V8 sandbox,
and packages `v8.lib`. These are upstream build settings, not consumer options.

The experiment observed the Windows archive as 151,695,100 bytes with SHA-256
`2aee8b6c3e8cecae2ce0325ac01b9bcaea4bef49e8f2aac599e1729d60c17285`.
Upstream's Cargo build script downloads this archive without checking a pinned
digest, generates bindings with libclang, and prefixes C API symbols using
`llvm-objcopy`, `objcopy` or `gobjcopy` on PATH. A hosted Windows image already
containing those tools does **not** prove a plain MSVC Rust consumer build.
The clean-consumer requirement must be checked separately. A prebuilt Node-API
package should carry its static engine and normal runtime dependency closure;
its consumers should not install an engine toolchain.

## Portable AOT is a release blocker

**V8 serialization works, but the current upstream integration does not meet
the cross-platform consumer contract.** A successful producer/consumer test on
one runner does not establish that a shipped cache works on another CPU.

The exact V8 source makes the restriction explicit:

- [`Module::serialize`](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/c-api.cc#L1300)
  tiers all guest functions up to TurboFan and stores compiled native code plus
  the original Wasm bytes.
- [`WriteHeader` and `IsSupportedVersion`](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/wasm-serialization.cc#L127)
  require exact equality of the engine version hash, CPU feature mask, flags
  hash and enabled Wasm features. A consumer with additional CPU features can
  therefore reject the artifact; this is not a minimum-feature subset check.
- [`Module::deserialize`](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/c-api.cc#L1337)
  returns null when a present native payload fails validation. It does not
  automatically compile its bundled Wasm in that case. Removing the native
  payload would invoke compilation and would fail our consumer contract.
- [Wasmer's V8 engine](https://github.com/wasmerio/wasmer/blob/v7.5.0/lib/api/src/backend/v8/entities/engine.rs)
  exposes no target CPU/profile or engine-flag configuration. V8's C API
  configuration is empty in this engine generation.

V8's public C++ flag API could disable many optional instructions before engine
initialization. The follow-up proves constrained profiles and fresh-process
PostgreSQL cache reads, but those flags alone are not a universal profile:
[`CpuFeatures::ProbeImpl`](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/codegen/x64/assembler-x64.cc#L87)
still records CET shadow-stack support directly from hardware, without an
`enable_*` flag. Clearing all optional SIMD features also removes V8's
SSE4.1/SSSE3 support for Wasm SIMD. The PostgreSQL guest and supported CPU floor
must be tested against the chosen baseline. Do not patch cache headers to
bypass validation or depend on private C++ symbols from the SDK.

The user approved **SSE4.1 as the common x64 desktop minimum** on October 5.
SSE2-only processors are outside that policy; a scalar fallback is optional.
All engine flags and compatible artifact selection remain internal to the SDK.
This decision does not resolve the independent CET cache-mask difference or
mean that the production serializer's existing SSE2 metadata is already aligned.

The additional `cache-header-compatibility` probe executes the original tiny
EH artifact, changes only its native CPU/flag compatibility fields separately,
verifies that V8 itself rejects each, and then reopens and executes the original
again. This tests header enforcement, not execution on different hardware.
Local Linux evidence reports CPU mask `0x23e7f`, flag hash `0xb8ff7c37`, and
rejection of both changed fields. The Windows diagnostic workflow runs the
same check and retains its log.

To ship the requested behavior, the engine integration needs a maintainer-owned
portable AOT profile shared by serializer and loader, plus a prebuilt engine
package with pregenerated Rust bindings and already-prefixed C API symbols.
That packaging must eliminate upstream's consumer-time libclang/objcopy step.
These require upstream changes or a deliberately maintained Wasmer/Wee8 fork;
SDK-level backend selection cannot supply them. This branch does not introduce
a fork or claim the required engine contract has been implemented.

Acceptance requires loading the **same shipped artifact** on distinct supported
CPU configurations with no guest compilation, then running the ordinary SDK
tests from installed packages on a Windows image without LLVM/Clang/objcopy.
This applies to core, extensions and tools. The prebuilt Node-API package also
needs its V8 license/provenance and runtime DLL closure: the inspected Wee8
archive contains headers and libraries but no license/notice files. A single
V8 BSD notice does not establish the complete linked third-party closure.

## Validation ledger

| Source / run | Result | Meaning |
| --- | --- | --- |
| Probe `11f5450b`, [run 37237089766](https://github.com/f0rr0/oliphaunt/actions/runs/37237089766) | 22 required cases pass on Windows and Linux; six diagnostics fail | Engine feasibility only; no SQL executed |
| Integration `ce96bc89`, local owner tasks | 176 SDK unit tests, public API tests, doctests, packaging, lint, formatting and workflow gate pass | Linux source/package behavior; no Windows runtime evidence |
| Integration `ce96bc89`, [run 37240326297](https://github.com/f0rr0/oliphaunt/actions/runs/37240326297) | Windows compile fails: missing headless feature | Fixed by `d3f58e46`; no runtime tests ran |
| [Run 37240425099](https://github.com/f0rr0/oliphaunt/actions/runs/37240425099) | Release-intent ancestry check fails | Main advanced; branch merged current main before retry |
| `d3f58e46`, [run 37240866665](https://github.com/f0rr0/oliphaunt/actions/runs/37240866665) | Planner rejects selected-product qualification with a focused platform | Dispatch corrected to all platforms; no builds ran |
| `d3f58e46`, [run 37240857744](https://github.com/f0rr0/oliphaunt/actions/runs/37240857744) | Windows serializer and SDK compile; N-API diagnostic rejects missing release payloads | Source check corrected to use source adapter features; release payload gate retained |
| `034012d0563b193bf86e1752db26b807c096d241`, [run 37241565475](https://github.com/f0rr0/oliphaunt/actions/runs/37241565475/job/111551149279) | Windows serializer, SDK and N-API source checks pass; generated V8 core artifacts load; 21 runtime and 7 PostgreSQL regression tests pass | Real SQL recovery, callback panic recovery, async ownership, backup/restore and directory reopen pass on one runner; the core-only invocation executes zero extension tests, and does not qualify tools, installed consumers or CPU portability |

The successful Windows runtime diagnostic uses the immutable older portable
fixture documented by the experiment, not portable output produced from its own
source SHA. Its retained evidence artifact is `11317148754`, digest
`sha256:c615e86475e4a2f0324cd4455b98388786c09142b37c48c6c84bc42cf6219082`.
It is useful integration evidence, not release qualification.

Selected-product all-platform qualification for source
`d3f58e46272686fb0cd7dce2fa7c7264b2b064f2` is
[run 37240991549](https://github.com/f0rr0/oliphaunt/actions/runs/37240991549).
Its source checks, unit tests and portable producer passed. At 23:37 UTC on
October 4, native iOS extension production was still running, while the WASIX
extension, host AOT and installed-consumer jobs had been skipped despite being
selected in the plan. Those skips leave qualification incomplete; this run
does not prove the newer branch HEAD or the required Windows consumers.

The newer diagnostic at `b1dac573b7a307a2ae2cbbbe06cbc4635befada9`,
[run 37243260881](https://github.com/f0rr0/oliphaunt/actions/runs/37243260881),
completed successfully at 23:39 UTC on October 4. It repeats the 21 runtime and
7 PostgreSQL regression passes and confirms native CPU/flag header rejection.
Its recorded default mask is `0x33e7f`, with flag hash `0xb8ff7c37`. Extension,
tools, installed-consumer and different-CPU qualification remain outstanding.

The [October 5 Wasmer/WASIX feasibility follow-up](windows-wasmer-feasibility.md)
records a new local fixed-flag experiment and the relevant upstream fixes and
open issues. It narrows the next investigation to retaining WASIX, rather than
recommending a runtime migration from an AOT compile result alone.

At source `91acf30d6e8393b2f83e0999f1d03d1e4219768e`,
[run 37249648979](https://github.com/f0rr0/oliphaunt/actions/runs/37249648979/job/111574511372)
passed the same 21 runtime and 7 PostgreSQL regressions, then executed **three
UUID-OSSP AOT tests** covering direct dynamic loading/reopen, materialization,
and logical dump/restore through the split `pg_dump` and `psql` modules. This
is the first recorded Windows extension/tools execution in this branch. Core
fixture `11312707536` and extension/tools fixtures `11318826010`/`11318277384`
are immutable earlier compiler outputs. Evidence artifact `11320343594` has
digest `sha256:43ef2d65c5242aa3c0120124391b2e0feace99e9eb9b72ea90cf3760100137f6`.

That integration job fails later, before vector lifecycle execution: local
archive discovery assumes the runtime's version for an external extension.
The corrected lookup at `31e154b1` reads the extension manifest's version; a
real Cargo consumer regression covers differing versions. Repeated vector
opens, error recovery and memory samples were then executed in the follow-up
hosted run described below.
The separate CPU-profile Windows jobs pass their cache tests but fail native
coexistence at link time due to Wee8's static C++ CRT conflicting with an
ordinary `/MD` library. Their red results remain blockers, rather than waived
diagnostics. See the feasibility record for masks and their coverage limits.

At exact source **`31e154b1d5f47f35b384c6d2856754287d41a57f`**,
[run 37251912738 / SDK job 111581122909](https://github.com/f0rr0/oliphaunt/actions/runs/37251912738/job/111581122909)
completes successfully: source serializer, SDK and N-API checks; generated V8
core/support, extension and tools artifacts; the 21 runtime and 7 PostgreSQL
regression tests; 3 UUID-OSSP/tool tests; and 25 vector database lifecycles with
SQL error recovery. Its retained evidence is artifact `11322237408`, digest
`sha256:39c28d183d1fa0d26af138f7b338a91f5f3be2989c22ac20e9772578052c862b`.
The same immutable older fixtures are used; this is not same-run product
qualification.

**Memory remains a release blocker despite that functional pass.** Across the
25-cycle test, sampled private memory grows by about 334 MiB per cycle between
the first samples after cycles 1 and 24, and peaks at 8.588 GiB; peak working
set is 7.014 GiB. The final process-teardown drop does not qualify reclamation
inside a long-running application. The [feasibility record](windows-wasmer-feasibility.md#windows-database-lifecycle-measurement)
contains the sample scope and limits.

The same diagnostic's fresh Windows readers accept a matching-profile
PostgreSQL native cache through WASIX and reject a different CPU mask, including
a cache from another machine with the same Windows runner label. Both Windows
toolsets pass the scoped `/MT` mixed-library runtime control, but their ordinary
`/MD` link remains broken. The overall diagnostic is therefore red. These
controls do not resolve the consumer CRT requirement or upstream STL issue.

The selected-product all-platform qualification at this source is
[run 37251945930](https://github.com/f0rr0/oliphaunt/actions/runs/37251945930).
Source checks, unit tests and selected SDK packaging pass. Core compiler output
and portable packaging also finish, but the portable producer job fails when
parallel extension/tools preparation rewrites the same generated PostgreSQL
header: `install: ... File exists`. Host AOT and installed-consumer jobs cannot
qualify that run. It was cancelled after inspecting the failure.

Commit **`23962fbda83594257abf77fd0bc16821acb7e118`** makes a valid cached
header read-only and propagates preparation failures before Docker path mapping.
The new behavioral regression fails on the previous code and passes after the
fix: eight concurrent cache readers preserve the header inode; corrupt or
changed headers still rebuild. Runtime unit/orchestration tasks and the complete
workflow gate pass locally. All-platform selected-product qualification was
restarted in [run 37255463925](https://github.com/f0rr0/oliphaunt/actions/runs/37255463925).
That dispatch was rejected before builds because the manually supplied
qualification request key did not match the source/scope digest. A corrected
dispatch omits that optional key; no gate was weakened. The corrected run is
[37255647955](https://github.com/f0rr0/oliphaunt/actions/runs/37255647955), at the
same exact `23962fbd` source SHA and three selected products, with every platform
selector set to `all`.

That corrected run completes with **Required and Qualified both failing**.
Portable core, tools, all 39 WASIX extension compiler outputs, standard/ICU
seeds and all seven native extension producer platforms pass. All four desktop
host AOT build/validation/runtime/representative-extension steps also pass.
Each host then fails Node-API packaging: metadata declares runtime 0.3.0 while
the selected workspace runtime actually reports 0.3.1. Installed TypeScript
consumers and the exhaustive WASIX extension lifecycle are skipped after these
failures; they are not qualified.

Commit `8553acb2` explicitly advances this integration's Node-API runtime and
Rust binding compatibility pins to 0.3.1 in the build package and its four
carriers. ABI/profile checks are preserved, and mismatch errors now print
expected and actual identities. Local Node-API formatting/lint, ten JavaScript
package tests, the compiled packaging/failure controls, five Rust tests and
release metadata checks pass. This changes these selected consumers' pins;
it does not reinstate automatic version coupling for independently released
products.

Retry [37261508648](https://github.com/f0rr0/oliphaunt/actions/runs/37261508648)
stops before builds because main advanced; it is merged into the branch.
Retry [37261777310](https://github.com/f0rr0/oliphaunt/actions/runs/37261777310)
stops before builds because its `test:` HEAD subject lacks release intent for
the branch's production changes. The local release-intent gate passes with the
subsequent `fix:` HEAD. Full selected-product/all-platform qualification is
attempted in [run 37261920946](https://github.com/f0rr0/oliphaunt/actions/runs/37261920946)
at **`a4697f0666d2367e164363542e398c8908d9c0fb`**. Required and Qualified
finish red because final extension packaging lacks Android artifacts.

At this source, all four desktop AOT/Node-API host jobs and the installed
TypeScript/browser consumer job pass. Each host executes 21 runtime tests,
7 PostgreSQL regressions and 3 UUID-OSSP/tool tests; pgwire and packaged
Node/Bun/Deno/Electron smoke paths execute too. The Windows carrier includes
its VC runtime DLLs with verified hashes, but inspection finds the V8 notices
missing from the package. This remains required packaging work before shipping.

The full WASIX lifecycle job also passes. Artifact **`11325864072`**,
`wasix-release-regression-evidence`, has verified ZIP digest
`sha256:85acd90e4ad679a8b2779503dde80931b730e75df941899ebd94a3889a800268`.
All 39 selected catalog extensions have passed direct, server, restart,
materialization and physical backup/restore evidence, with no missing current
claims. The receipt records source tree `6e61b839e86b80770a86cef2d7fa0502d7fbe938`
and source digest
`sha256:05c44ce681c43857fb4b49081cb8a290cf3051ea102de324964ec61f4f9566d2`.
The collector enforces `--require-current-evidence` at the candidate SHA. This
exhaustive lifecycle execution is Linux/portable evidence; it does not replace
full catalog execution on Windows V8. These are diagnostic receipts from a
failed candidate, not publishable qualification evidence.

Both Android compilation jobs and the Linux support producer pass, but Android
packaging is skipped. The native aggregate incorrectly accepts that selected
skip. Final package assembly then correctly rejects missing `android-arm64-v8a`
and `android-x86_64` extension artifacts. Commit `2654aa26` replaces the Android
wildcard status check with successful named producer checks and makes the
native aggregate fail when any selected platform producer does not succeed.
The full local workflow gate and selected-skip regression pass. Qualification
is repeated in [run 37267345495](https://github.com/f0rr0/oliphaunt/actions/runs/37267345495)
at **`2654aa260a31b71ceb31d019770408ad20151e16`**, with all three selected
WASIX products, every platform selector at `all`, and its own artifacts and
lifecycle evidence. Its final gates must be recorded before qualification.
Both Android packaging jobs execute and pass at this SHA: `111633416119`
(`android-x86_64`) and `111633416131` (`android-arm64-v8a`). They download the
same-run static archives and Linux support, restore the inputs, assemble the
packages and upload final artifacts `11327921038` and `11327906132`. This
resolves the skipped-packaging defect observed in the failed candidate.

At the closing snapshot, all four desktop host jobs pass, including Windows
job `111631094438`. They execute the runtime, PostgreSQL, representative
extension/tools, pgwire and installed Node/Bun/Deno/Electron checks. The
TypeScript/browser consumer job `111635989378` also passes. Full WASIX
lifecycle job `111635989382` produces artifact **`11327404928`**, whose ZIP
digest is independently verified as
`sha256:3b01c10863bfafa5c3299552f651ee98a7371dc8a787fd05c585b2f80b9ceddb`.
Its source tree is `8ac4e817616b2f578802fa6b74b0ac3561032b40`, and source digest
is `sha256:05c44ce681c43857fb4b49081cb8a290cf3051ea102de324964ec61f4f9566d2`.
The receipt matches the exact candidate and all 39 planned catalog names:
**195 passed mode statuses**, with no missing current WASIX claims. This is
Linux/portable lifecycle execution, not exhaustive Windows V8 qualification.

Native iOS extension production and final extension package assembly also
finish successfully in that run. The selected WASIX runtime package is skipped,
so Builds, Required and Qualified finish failing. Explicit named producer-status
checks repair the skip in the resumed branch; the follow-up run and additional
acceptance controls are recorded in the decision ledger. This older run tests
`2654aa26`, not the later documentation or experiment commits. Raw logs and the
verified receipt are retained locally under the ignored
`tools/experiments/wasmer-v8/results/validation-2026-10-05/` directory; durable
run and artifact identities above allow the evidence to be retrieved again.

The [ownership investigation](windows-wasmer-feasibility.md#store-ownership-defect-and-a-partial-linux-remedy)
finds concrete defects in the pinned V8 C API Store and shared-owner deletion
paths, with bounded Linux controls showing large reductions in retention.
The corrected Windows comparison at `04ff56b6` also passes the 21 runtime,
7 PostgreSQL, 3 UUID-OSSP/tool tests and 25 vector lifecycles. Peak private
memory falls from 8.590 to 0.795 GiB and sampled growth from 334.2 to 2.9 MiB
per cycle. Residual retention remains. Artifact `11326071452` has verified
digest `sha256:9e8075025b1d9fe9158c07b01ac4b0fce82a225c7370173bbd04f67cad3046b9`.
The patched logs record zero Wasmer V8 module-construction calls; they do not
exclude internal V8 compilation. Fresh Linux debugger controls subsequently
observe zero guest body compilations while loading the PostgreSQL cache,
but 21 host-import adapters and one C-to-Wasm entry adapter generated inside
V8. A positive fresh-compilation control detects guest compilation. See the
feasibility ledger for the bounded proof and Windows limitation. This is a
source-pinned private experiment.
These changes have not been installed in the production SDK dependency closure.

Do not treat skipped child jobs with green aggregate badges as passing builds.
Qualification must identify the source SHA, actual executed jobs and artifact
identity. Keep [Windows issue #208](https://github.com/f0rr0/oliphaunt/issues/208)
open until real database and installed-consumer evidence meets its acceptance
criteria.
