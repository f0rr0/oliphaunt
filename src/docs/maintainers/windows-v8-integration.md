# Automatic Windows V8 integration

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
violate this contract and is not implemented.

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
initialization. That alone is not a proven portable profile:
[`CpuFeatures::ProbeImpl`](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/codegen/x64/assembler-x64.cc#L87)
still records CET shadow-stack support directly from hardware, without an
`enable_*` flag. Clearing all optional SIMD features also removes V8's
SSE4.1/SSSE3 support for Wasm SIMD. The PostgreSQL guest and supported CPU floor
must be tested against the chosen baseline. Do not patch cache headers to
bypass validation or depend on private C++ symbols from the SDK.

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
had passed the Windows database API step and was still running the new native
cache-header compatibility probe at that snapshot. A running probe is not
recorded as a pass.

Do not treat skipped child jobs with green aggregate badges as passing builds.
Qualification must identify the source SHA, actual executed jobs and artifact
identity. Keep [Windows issue #208](https://github.com/f0rr0/oliphaunt/issues/208)
open until real database and installed-consumer evidence meets its acceptance
criteria.
