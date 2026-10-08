# Native WASIX engine

This directory owns the private Wasmer/WASIX source family used by the Rust SDK
and Node addon. Its package versions follow `liboliphaunt-wasix`; upstream versions
and immutable input digests live in `source.toml`. The browser engine remains a
separate toolchain.

Linux and macOS use the existing LLVM producer and headless loader. Windows uses
V8 because Wasmer 7.5 no longer supports its LLVM backend there. All consumers
receive precompiled artifacts and the Windows engine DLL through their normal
SDK packages. Runtime loading never compiles a missing guest or extension.

The desktop x64 minimum is SSE4.1. Windows artifacts contain genuine native
caches for CPUs with and without CET, compiled with the same pinned DLL and
flags. V8 validates the original cache headers and selects a compatible profile;
we do not rewrite CPU masks or fall back to compilation.

The ordered Wasmer patches cover engine delivery, C API ownership, native cache
profiles, and shared memory/terminal lifetimes. The WASIX patches cover optional
runner features, cached module loading, and terminal shutdown. The complete
ordered series is the build and qualification unit.
The virtual filesystem patch separates write flushing from explicit data/full
sync requests, including through file wrappers and memory mounts.
These are internal compatibility patches, not a promise to support every V8
backend API exposed upstream.

`windows/bindings.rs` retains the generated C ABI for the pinned Wasmer header;
the producer verifies that header's digest before generating DLL dispatch.
Consumers use the frozen bindings and need no binding generator or native
engine build.

Use `moon run liboliphaunt-wasix:engine-sources` to replay the pinned source
patches. The Windows host workflow produces the DLL and baseline caches before
normal AOT, runtime, extension, and SDK checks. Packaging freezes those same-run
inputs using the existing deterministic Cargo carrier helpers, verifies source
and byte identities, and includes the upstream notices. Release assembly
consumes these outputs without building an engine.

Qualification must cover all desktop targets, the complete extension catalog,
and installed Rust/npm consumers. Research artifacts do not qualify a production
commit. Changes to source pins, patches, flags, or DLL bindings require fresh
native caches and qualification.
