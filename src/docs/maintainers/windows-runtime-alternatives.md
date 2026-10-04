# Windows runtime alternatives and workarounds

Research snapshot: **October 4, 2026**. This is a maintainer decision record,
not a Windows support announcement. See the [integration ledger](windows-v8-integration.md)
and [original capability experiment](../../../tools/experiments/wasmer-v8/README.md)
for repository history, execution evidence and the six diagnostic failures.

## Conclusion

The requested consumer experience is achievable in principle: maintainers
compile and package the guest; an ordinary SDK installation loads it with the
same APIs, features and behavior on Windows, Linux and macOS. **Stock Wasmer
7.5's Windows V8 integration does not yet establish that contract.** The
prototype passes real Windows database tests, but its native cache depends on
the producer's CPU/flags and its Rust dependency build needs extra tools.

There are two credible paths:

1. **Preserve Wasmer/WASIX:** maintain a prebuilt Wee8 integration with a
   deliberately supported AOT CPU profile, pregenerated bindings and isolated
   symbols. This preserves the host implementation, but entails engine changes
   and continued V8 maintenance. No ready-made, verified portable profile was
   found in the searched upstream code, issues, forks or documentation.
2. **Use Wasmtime for Windows:** its explicit baseline targets and compiler-free
   loader fit the distribution requirement more directly. The actual PostgreSQL
   guest already cross-compiles to Windows with Wasmtime 49.0.2. The substantial
   work is porting the WASIX host, dynamic linking and SDK behavior.

**Recommendation:** treat Wasmtime as the strongest alternative to evaluate,
and compare a bounded host-port spike with the concrete cost of maintaining a
portable Wee8 build before committing to either. Continue treating the V8
integration as a prototype until the shipped artifact works across different
consumer CPUs and installed packages need no Windows-specific tool setup.

## What changed upstream

| Event | Consequence |
| --- | --- |
| [Wasmer 7.2.0](https://github.com/wasmerio/wasmer/releases/tag/v7.2.0), June 30 | Revived the V8 backend; removed Wasmi/WAMR backends. Older backend feature tables are stale. |
| [PR #6826](https://github.com/wasmerio/wasmer/pull/6826), merged August 6 | Explicitly removed Windows Sys/compiler support because it lagged other platforms, including EH; upstream chose V8. |
| [Our upgrade PR #247](https://github.com/f0rr0/oliphaunt/pull/247) | The 7.5 upgrade encounters an intentional upstream policy, rather than a missing Cargo feature alone. |
| [V8 upgrade PR #6600](https://github.com/wasmerio/wasmer/pull/6600), latest head `58f91be8504527dddb647cf565e6c349fe4013d8` | Still draft; proposes V8 15.0.1 and explicitly leaves Windows linking disabled. |
| [Windows static-link issue #7006](https://github.com/wasmerio/wasmer/issues/7006), September 13 | Reports MSVC STL symbol collisions corrupting an unrelated C++ library when linked with the existing V8 distribution. |

The download label `wee8 11.9.7` in Wasmer 7.5 actually packages **V8
13.6.233.17**; the integration ledger records the source and archive digest.
Inspected Wasmer main `9d70d53166d97d94a92c472a2936fdcba02e9e7b` still uses
that download and consumer-time bindgen/symbol rewriting. See its
[build script](https://github.com/wasmerio/wasmer/blob/9d70d53166d97d94a92c472a2936fdcba02e9e7b/lib/api/build.rs).
Switching to main therefore does not resolve these packaging requirements.

Read PR #6600's **latest commit**, not only its older description: the newer
Windows archive contains Wee8, but its Chromium libc++ references do not link
against the downstream MSVC STL. Associated [custom-build PR #12](https://github.com/wasmerio/v8-custom-builds/pull/12)
also reports a downstream test crash despite successful producer builds.
Neither proposal is a qualified replacement for the current Windows package.

## V8: the cache is the central distribution problem

The shipped engine's [serializer and compatibility check](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/wasm-serialization.cc)
compare the complete CPU feature mask, engine version, flags hash and Wasm
feature set. Even additional consumer CPU features can cause rejection. The
[C API serializer](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/wasm/c-api.cc#L1300)
stores optimized native code plus the original Wasm; its deserializer returns
null for an incompatible present native payload. This is not an ordinary
minimum-CPU executable contract.

This remains true in [V8 main `00075520df30f6d891cd9cf5f9f497f624a2efaa`](https://github.com/v8/v8/blob/00075520df30f6d891cd9cf5f9f497f624a2efaa/src/wasm/wasm-serialization.cc#L1188).
An engine version bump alone does not establish portable AOT. V8's
[browser caching documentation](https://v8.dev/blog/wasm-code-caching)
describes reuse after local compilation; it does not promise a portable native
artifact that maintainers can distribute to arbitrary consumer CPUs.

### Plausible maintainer fixes

**A supported CPU profile needs engine work.** Wasmer exposes no V8 target or
flag configuration. A C++ bridge could set flags before engine initialization,
but disabling AVX alone leaves other mask differences. The pinned engine's
[CPU probe](https://github.com/v8/v8/blob/b0a55a7dad7f536cce1f9aaddba89894c8533946/src/codegen/x64/assembler-x64.cc#L87)
records CET shadow-stack capability without an enable flag; SIMD also requires
a tested instruction baseline. Any proposed profile must constrain code
generation and cache metadata together, verify the real host supports its
requirements, and preserve applicable security/erratum behavior. Merely editing
the artifact's compatibility bytes supplies none of those guarantees.

**Prebuilt engine packaging can remove consumer tools.** Bindings and C API
symbol prefixing can be produced by maintainers. Ship versioned, digest-checked
engine binaries and matching bindings instead of requiring libclang/objcopy
during every Windows Rust consumer build. Because a dependency build script
runs before the SDK's script, an SDK-level script cannot fix the upstream build
order; an upstream change or maintained dependency fork is needed.

**A private engine DLL with a narrow C ABI merits a packaging spike.** It can
keep C++ templates and its STL/CRT implementation inside one binary and expose
only intentional symbols. This addresses the type of static-link collision
reported in #7006, and may help isolate the newer libc++ build. It does not
solve native-cache portability. All C API dependencies, shared-memory patches,
runtime DLLs and licenses still need qualification. The collision is an
upstream report, not a reproduced Oliphaunt defect; using the same distribution
makes it relevant to test native-library coexistence.

### Workarounds that do not satisfy the requirement

| Suggestion | Assessment |
| --- | --- |
| Compile on first run, or retry with `Module::new` | Familiar V8 caching model, but consumers compile the guest. Excluded by the requested contract. |
| Strip native cache bytes and retain Wasm | The pinned C API then compiles Wasm. Same problem. |
| Clear or rewrite the CPU/version header | Bypasses validation without making emitted code compatible. Not a sound fix. |
| Ship a cache for every observed runner CPU | Can cover a measured fleet, but does not establish coverage for ordinary offline consumers. |
| Use a CPU-matched compilation service | Adds network availability and artifact selection to installation/startup. No demonstrated offline parity. |
| Switch to MinGW or downgrade Wasmer | Current Sys Windows rejection applies to Windows targets; the older MSVC guest-EH abort is already recorded in the original experiment. |
| Use Node `v8.serialize`, JS cached data or startup snapshots | Different serialization mechanisms; none supplies the required portable Wasm native module through this backend. See [Node's API](https://github.com/nodejs/node/blob/main/doc/api/v8.md). |

## Alternatives screened against this guest

| Option | Maintainer-produced AOT and consumer loading | Main obstacle here |
| --- | --- | --- |
| Wasmer + maintained Wee8 profile/package | Plausible; profile not implemented or qualified | CPU contract, engine packaging, static-symbol isolation and V8 update ownership |
| Rusty V8 | Cleaner prebuilt engine/bindings; same V8 cache restriction | Not a drop-in replacement for Wasmer's patched Wee8 C API |
| Wasmtime 49.0.2 + Cranelift | Explicit baseline targeting and compiler-free loading; actual guest Windows compile passes | WASIX/import/dynamic-linking host port |
| Wasmtime + Pulley | Precompiled bytecode can avoid native instruction variation | Same host port, interpreter performance and proposal/platform qualification |
| WasmEdge 0.18.0-rc.1 | Generic AOT binary option; newly added compiled EH | New prerelease implementation, no local Windows execution evidence, WASIX host port |
| WABT wasm2c | Wasm-to-C compiled by maintainers into target binaries | New host and extension linkage, callback/unwind ABI, package/performance qualification |
| V8 DrumBrake | Interpreter avoids native AOT caches | Required modern EH instructions remain unimplemented |
| WAMR AOT | Prebuilt modules in principle | Required EH is unsupported in the examined AOT path |
| Existing native broker behind an automatic facade | Existing platform packaging and native execution | Different isolation/storage model; not equivalent to the WASIX SDK by selection alone |

### Rusty V8: copy the packaging pattern, not its library

[Rusty V8's pinned README](https://github.com/denoland/rusty_v8/blob/2f588046bf45a7b9adeda3ed0f0e881d38e6f3f5/README.md)
and [build script](https://github.com/denoland/rusty_v8/blob/2f588046bf45a7b9adeda3ed0f0e881d38e6f3f5/build.rs)
show a default binary download with pregenerated bindings; source building is
an opt-in path. That is useful evidence that Windows consumers need not build
V8 or run bindgen themselves. However, its
[build targets](https://github.com/denoland/rusty_v8/blob/2f588046bf45a7b9adeda3ed0f0e881d38e6f3f5/BUILD.gn)
are not Wasmer's patched Wee8 ABI. Replacing the archive would require a new
backend adapter or compatible bridge. The open [Wasmer issue #6303](https://github.com/wasmerio/wasmer/issues/6303)
suggests Rusty V8 for N-API interop; it is not a completed runtime migration.

### Wasmtime: strongest match for AOT distribution

Wasmtime documents [precompilation with compiler features omitted from the loader](https://docs.wasmtime.dev/examples-pre-compiling-wasm.html).
In stable 49.0.2, [explicit target configuration](https://github.com/bytecodealliance/wasmtime/blob/v49.0.2/crates/wasmtime/src/config.rs#L382)
disables inferred host CPU features. Its [loader CPU check](https://github.com/bytecodealliance/wasmtime/blob/v49.0.2/crates/wasmtime/src/engine.rs#L547)
checks required instructions against the host; extra host features do not
invalidate the artifact. Engine version and memory/configuration compatibility
still matter and must be pinned by the producer and SDK.

The [platform support policy](https://docs.wasmtime.dev/stability-platform-support.html)
includes x86-64 Windows. The current [proposal policy](https://docs.wasmtime.dev/stability-wasm-proposals.html)
lists EH as Tier 1 with Cranelift and threads as Tier 2 with allocation limits;
do not assume Winch or every allocation strategy has identical coverage.
Pulley's [Tier 2 status](https://docs.wasmtime.dev/stability-tiers.html)
and performance tradeoff make native Cranelift the first candidate here.

The hard part is the host: our fixture declares 92 imports, and the SDK depends
directly on Wasmer/WASIX stores, filesystem state, task management and module
caches. Extension `dlopen`, shared memory and tools are additional acceptance
requirements. Wasmtime's WASI implementation does not supply those WASIX
semantics automatically. The [WASIX implementation guide](https://www.wasix.org/docs/developer-guide/)
describes a separate extension namespace and reusable integration tests. No
qualified off-the-shelf Wasmtime WASIX replacement was found in this research.

### WasmEdge and wasm2c: real alternatives, separate host implementations

[WasmEdge 0.18.0-rc.1](https://github.com/WasmEdge/WasmEdge/releases/tag/0.18.0-rc.1)
adds compiled EH and changes its AOT format to version 3. Its
[compiler](https://github.com/WasmEdge/WasmEdge/blob/ffa888d5ce67c2798c3c1f4ef49c18d7b8ed8356/lib/llvm/compiler/function_compiler.cpp#L1228)
implements `try_table`/`throw_ref`; the [generic-binary setting](https://github.com/WasmEdge/WasmEdge/blob/ffa888d5ce67c2798c3c1f4ef49c18d7b8ed8356/lib/llvm/compiler/context.cpp#L100)
avoids inferred host features. Windows MSVC release assets exist. These are
source/release findings, not executed PostgreSQL evidence. Stable 0.17.2 does
not establish the new compiled-EH path. It still needs WASIX and SDK integration.

[wasm2c](https://github.com/WebAssembly/wabt/blob/93a552c0554392f9e26647ce216e21fd2581c566/wasm2c/README.md)
emits C99, or C11 for threads, with linear-memory and trap runtime helpers.
The inspected tree has [modern EH tests](https://github.com/WebAssembly/wabt/tree/93a552c0554392f9e26647ce216e21fd2581c566/test/wasm2c/spec/exception-handling),
including `try_table` and `throw_ref`, plus SIMD tests. Maintainers could compile
the result into a Windows DLL without consumer JIT. This is credible, but not
already a working PostgreSQL/WASIX runtime. Its longjmp-based runtime and
callbacks need a carefully contained ABI; extension linking is substantial work.

### Interpreters are not a shortcut for the current guest

V8's interpreter exists, but the pinned engine and inspected
[current DrumBrake source](https://github.com/v8/v8/blob/00075520df30f6d891cd9cf5f9f497f624a2efaa/src/wasm/interpreter/wasm-interpreter.cc#L9450)
leave `try_table` and `throw_ref` unhandled. A community prebuilt interpreter
archive does not supply those missing semantics.

WAMR's [EH issue #3753](https://github.com/wasm-micro-runtime/wasm-micro-runtime/issues/3753)
and [AOT throw issue #4088](https://github.com/wasm-micro-runtime/wasm-micro-runtime/issues/4088)
distinguish interpreter work from missing AOT support. Inspected main
`f5f57c09aee623436f5fb87a90798fdd2cdf39fd` still describes legacy EH in its
[build configuration](https://github.com/wasm-micro-runtime/wasm-micro-runtime/blob/f5f57c09aee623436f5fb87a90798fdd2cdf39fd/build-scripts/config_common.cmake).
Wasmer also removed its internal WAMR adapter. This is not a supported
alternative backend switch for Wasmer 7.5.

The repository's native broker already has Windows carriers, SQL transport and
physical backup management. It may be simpler if native execution is acceptable,
but its directory-based storage and process isolation differ from WASIX memory
storage and sandboxing. Matching the public facade, persistence, extensions and
failure behavior requires actual integration; silently selecting it does not
by itself preserve the contract. See [the broker](../../native/broker/README.md)
and [native storage](../../native/rust-bindings/src/storage.rs).

## Direct experiment: actual guest to Windows with Wasmtime

Executed locally on Linux with the official [Wasmtime 49.0.2 release](https://github.com/bytecodealliance/wasmtime/releases/tag/v49.0.2):

```text
wasmtime 49.0.2 (3c8a3e79a 2026-10-02)
```

```sh
wasmtime compile --target x86_64-pc-windows-msvc \
  -W exceptions=y,threads=y \
  -o postgres.windows.cwasm postgres.wasm
```

**Result: exit 0**, a 31,050,568-byte Windows-target AOT artifact. No CPU preset
or optional CPU features were requested. This proves the compiler accepts the
actual guest for that target. It does **not** prove Windows deserialization,
WASIX instantiation, SQL execution, extension loading or performance.

| Evidence | SHA-256 |
| --- | --- |
| Official Linux CLI archive, 11,635,696 bytes; release asset `606056679` | `a4d6e9e3a5a60f527cf7793d674c48930c80c2e8977995b8a275cad3254b9322` |
| Guest, 10,126,285 bytes; immutable portable artifact `11312707536` | `69fdbc72f9e110c1e356db8f46b941cb67591eff140231fcfaffff201d4e7cf9` |
| Produced Windows AOT module, 31,050,568 bytes | `01853c9be3c711fcd7ac5b5bab9a2487bf1bf75d1d965a2e934cf9ec6fb8ef21` |

The CLI archive matched GitHub's release digest. Guest producer identity and
download rules are in the original experiment. Local research inputs/output
are under `/tmp/oliphaunt-runtime-research`; these temporary files are not
release assets or durable CI evidence. The command and hashes are recorded for
reproduction; no runtime migration is implemented by this experiment.

## Decision gates that consumers must never see

For either selected engine, maintainers must prove: the same packaged artifact
loads across supported CPU configurations without guest compilation; ordinary
installed SDK consumers use no engine flags or added toolchain; SQL recovery,
async queries, persistence, backups, tools and extension loading preserve
behavior; terminal faults retire resources and required waits/cancellation
cannot strand the application; and the engine/runtime license and DLL closure
is complete. Keep engine/version profiles internal to packaging and the SDK.

The six earlier failed diagnostics do not all require new public APIs. Internal
callback panic containment and owner-thread async execution are demonstrated
workarounds; unused host exception-object APIs can be avoided. Required atomic
interruption/teardown and the new AOT/package blockers still need proof. Passing
core SQL tests on one hosted machine does not waive those requirements.
