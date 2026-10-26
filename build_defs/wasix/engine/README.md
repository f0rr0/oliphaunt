# Windows V8 construction

This directory owns the Windows engine build and its source/import boundaries.
Read version and source pins from Cargo manifests, toolchain metadata, and
`src/wasix/runtime/engine/sources.json`; update those owners instead of copying
literal versions into MODULE declarations or package rules.

The `engine_repositories` module extension declares five acquisition repositories:
`wasix_engine_sources`, `windows_wee8`, `wasix_engine_acquisition`,
`wasix_engine_notices`, and `wasix_engine_relink_sources`. They acquire pinned
sources, Cargo acquisition inputs, notices, and relink materials independently of
the resolved publication metadata. Reading crate sources does not require fetching
the larger Windows library. The acquisition Cargo skeleton is not a public crate.

MODULE registers two separate readers after Cargo metadata is available:
`wasix_constructor_inputs` routes original portable/AOT Files, and
`wasix_engine_carriers` imports the seven original Windows Cargo archives.
Keep these readers outside the acquisition extension: their dependency on resolved
source metadata would otherwise introduce a Cargo cycle. The extension also keeps
the acquisition repository namespace stable as root reader declarations change.

Construction follows the existing producer cohorts, then the host matrix:

1. Linux builds portable modules and the three LLVM AOT target sets.
2. Windows imports those modules, builds the engine's seven Cargo carriers, and
   runs the production V8 serializer for Windows AOT images.
3. Final Linux packaging imports both original packets and qualifies the complete
   runtime, extension, tools, SDK, and browser packages.
4. Native hosts consume the final five runtime Cargo carriers and the original
   Windows engine carriers through the existing installed-package requests.

`OLIPHAUNT_WASIX_CONSTRUCTOR_PHASE` selects `source`, `windows-v8`, or `package`.
Imports use the existing `OLIPHAUNT_NATIVE_PUBLICATION_INPUTS` snapshot. Internal
`constructor:` identities derive from source labels; public carriers retain their
Cargo identities. Whole original Files, hashes, source identities, and producing
cohort tuples survive forwarding. A later host does not become their producer.

Windows bindgen uses declared LLVM resource headers, captured MSVC/SDK headers,
and the Rustfmt toolchain. The C ownership bridge links pinned Wee8 with the
registered Windows C++ toolchain. Generated bindings bind the resulting DLL hash.
Consume the declared output groups; output filenames are owned by their rules.
Public envelopes, the serializer, and Cargo build scripts share the engine's
execution configuration so they consume one configured DLL producer.

All seven public engine crates share the `oliphaunt-wasix-rust` owner/version:
four maintained source crates, the DLL facade, and two compressed payload parts.
The API crate's custom build script uses the optional facade only for Windows V8.
It copies bindings and delivers the reconstructed DLL without compiling an engine.
The raw DLL belongs to the payload parts, not the API crate's `prebuilt/` directory.

The SDK publishes `oliphaunt-wasix-rust-{version}-windows-v8-relink.tar.zst`
as one GitHub asset with its standard checksum.
The kit includes the pinned Wee8 archive and original objects, all seven actual
Cargo archives, original source inputs and mappings, notices, and build glue.
`relink.json` and `kit.json` bind its paths and bytes. The relink smoke uses captured
Windows MSVC/SDK tools and pinned clang-cl, then executes the rebuilt DLL through
the native C API loader; it avoids recompiling the Rust SDK for this narrow check.

Generator, packaging, and relink checks establish their own bounded contracts.
Full configured host qualification and frozen release admission remain required;
the relink loader's small WebAssembly call does not establish SQL behavior.
