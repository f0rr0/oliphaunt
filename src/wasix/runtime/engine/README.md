# Windows V8 source inputs

`sources.json` pins the official Wasmer 7.5.0 / WASIX 0.705.0 crate archives and
the Wee8 Windows archive used by the retained native Windows implementation.
Wee8's distribution label is 11.9.7; its actual V8 source version is 13.6.233.17.

The two patches contain only the final Rust `src/` changes. Apply each with
`git apply -p1` from its extracted upstream crate directory. They preserve the
complete retained ownership, fallible engine/memory attachment, terminal
cancellation, detached shared-memory copy and cache-only loading behavior.
Types and journal need renamed package identities for type coherence, but their
Rust source is unchanged. These source patches do not rename Cargo packages or
change build scripts, generated bindings, SDK policy or Bazel integration.

## Reconstruction and scope

The patches were reconstructed from the exact source `.crate` envelopes in
GitHub artifact 11389566342, run 37409777766, source
`9d6906435e85652b6a6edfd4834d6242b390a3f8`. The artifact ZIP SHA-256 is
`897e3348635e56e4641cfef9de593432b5a3d140a7bcb48245ef16e313731a57`.
Both official and retained crate checksums were verified before extraction.

Applying the patches to freshly extracted official sources reproduces every
retained `src/` file after CRLF-to-LF normalization: Wasmer changes 16 files
(+481/-131), WASIX changes five (+30/-7), types and journal change none.
Manifest, packaging, build script and generated binding differences are outside
this source-only comparison. No runtime build or current-package qualification
is asserted by that check.

The retained implementation passed four fresh native Windows SQL cases in run
40322763308: division catch, missing-schema catch, nested rethrow and
subtransaction rollback. That result covers retained PostgreSQL 18.4 bytes;
current source and final installed packages still require qualification.

Internal `Research*` names are preserved to avoid silently changing the proven
logic during extraction. They implement ownership and lifetime behavior rather
than diagnostic controls. Their names require cleanup before production; no
guest-compilation abort sentinel is included in either patch.

## Required generated binding and DLL inputs

The unchanged `src/backend/v8/bindings.rs` includes `OUT_DIR/v8_bindings.rs`.
The producer must generate that file from the pinned crate's
`third-party/wee8/wasm.h` (SHA-256
`97f49de5418f02c55633dbcdc96b72fb404659c9275e9a47a3b4d6bdce384b96`)
and the private DLL dispatch/loader implementation. The retained 195 KB generated
file is deliberately not checked in here.

The patched Rust source requires these additional binding functions:

- `oliphaunt_v8_prepare() -> std::io::Result<()>` for retryable engine delivery.
- `oliphaunt_v8_current_isolate() -> *mut std::ffi::c_void`.
- `oliphaunt_v8_terminate_execution(*mut std::ffi::c_void)`.
- `research_externtype_delete(*mut wasm_tagtype_t)`.

The first three belong to the generated Rust loader/dispatch. The isolate entries
resolve the pinned MSVC exports `?GetCurrent@Isolate@v8@@SAPEAV12@XZ` and
`?TerminateExecution@Isolate@v8@@QEAAXXZ`. The externtype function is the private
C++ bridge destructor; the retained Rust API accepts the tag-type pointers used
by both patched call sites. Existing ownership deletion aliases must also continue to
destroy their objects inside the DLL, and `wee8_wasm_func_call` must retain the
borrowed-argument bridge required for WASIX reentry. A stock generated binding
file or unmodified Wee8 C dispatch is insufficient for these patches.
