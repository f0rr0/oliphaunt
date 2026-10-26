The Windows producer links pinned Wee8 with the C ownership bridge, then generates
Rust dispatch bound to the resulting DLL bytes. `windows_v8_engine` requires an
explicit Windows C bindgen output; it never discovers Cargo state or downloads a
compiler during construction.

The target's default files are API crate sources: `embedded_bindings.rs` and the
`build.rs` template. The raw DLL is available **only** through the `dll` output
group for the payload part packager. It must not be included in the public API
crate's `prebuilt/` directory. The API crate's optional Windows V8 build dependency
is the `oliphaunt-wasmer-v8-windows-x64-msvc` facade, which reconstructs its DLL from
two payload part crates. With V8 disabled, the build script compiles and runs
without that dependency. With V8 enabled, it copies the bindings and calls the
facade's `write_dll` function. It does not compile or link an engine.

Public packaging must verify this split and conventional Cargo resolution before
admission. The producer default output is not a complete publishable API crate.
No generated API archive may contain `prebuilt/oliphaunt_wee8.dll`; only the part
packager consumes the producer's `dll` output group.

Run the actual build-script regression with a pinned host compiler:

```sh
bun build_defs/wasix/engine/build-script-regression.mts /absolute/path/to/rustc
```

This compiles the template with a small fake facade and verifies feature-disabled,
facade delivery, wrong-target and facade-error behavior. It does not qualify the
native Windows DLL or the real part packages.
