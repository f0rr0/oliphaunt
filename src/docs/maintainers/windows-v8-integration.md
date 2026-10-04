# Automatic Windows V8 integration

## Consumer contract

The same Oliphaunt dependency, constructors, configuration, queries, transactions,
extensions, tools and async APIs must work on Windows. Consumers must not select
a backend, use a Windows-specific initialization path, or accept reduced SQL
error recovery. Backend and artifact selection belong to the SDK and package
producers.

This branch builds on [Wasmer upgrade PR #247](https://github.com/f0rr0/oliphaunt/pull/247)
and its correctness prerequisites. It is integration work, not yet a qualified
Windows release. The [standalone experiment](../../../tools/experiments/wasmer-v8/README.md)
records the upstream history and the six diagnostic failures.

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

## Validation ledger

| Source / run | Result | Meaning |
| --- | --- | --- |
| Probe `11f5450b`, [run 37237089766](https://github.com/f0rr0/oliphaunt/actions/runs/37237089766) | 22 required cases pass on Windows and Linux; six diagnostics fail | Engine feasibility only; no SQL executed |
| Integration `ce96bc89`, local owner tasks | 176 SDK unit tests, public API tests, doctests, packaging, lint, formatting and workflow gate pass | Linux source/package behavior; no Windows runtime evidence |
| Integration `ce96bc89`, [run 37240326297](https://github.com/f0rr0/oliphaunt/actions/runs/37240326297) | Windows compile fails: missing headless feature | Fixed by `d3f58e46`; no runtime tests ran |
| [Run 37240425099](https://github.com/f0rr0/oliphaunt/actions/runs/37240425099) | Release-intent ancestry check fails | Main advanced; branch merged current main before retry |
| `d3f58e46`, [run 37240866665](https://github.com/f0rr0/oliphaunt/actions/runs/37240866665) | Planner rejects selected-product qualification with a focused platform | Dispatch corrected to all platforms; no builds ran |
| `d3f58e46`, [run 37240857744](https://github.com/f0rr0/oliphaunt/actions/runs/37240857744) | Windows serializer and SDK compile; N-API diagnostic rejects missing release payloads | Source check corrected to use source adapter features; release payload gate retained |

Do not treat skipped child jobs with green aggregate badges as passing builds.
Qualification must identify the source SHA, actual executed jobs and artifact
identity. Keep [Windows issue #208](https://github.com/f0rr0/oliphaunt/issues/208)
open until real database and installed-consumer evidence meets its acceptance
criteria.
