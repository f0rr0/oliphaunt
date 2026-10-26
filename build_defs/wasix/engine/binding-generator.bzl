"""Windows C API bindings from declared SDK, LLVM and Rust toolchains."""

load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")

_RUSTFMT = "@rules_rust//rust/rustfmt:toolchain_type"
_WINDOWS = ["@platforms//os:windows", "@platforms//cpu:x86_64"]

def _bindings_impl(ctx):
    compiler = find_cc_toolchain(ctx)
    rustfmt = ctx.toolchains[_RUSTFMT]
    llvm = ctx.files.llvm
    libraries = [file for file in llvm if file.basename.lower() == "libclang.dll"]
    resource_headers = [file for file in llvm if "/lib/clang/" in file.path and file.path.endswith("/include/stddef.h")]
    if len(libraries) != 1 or len(resource_headers) != 1:
        fail("Pinned Windows LLVM must declare one libclang.dll and one Clang resource include tree")
    if not compiler.built_in_include_directories:
        fail("Windows bindgen requires its declared MSVC/SDK include directories")
    library = libraries[0]
    resource = resource_headers[0].dirname
    runtime = [file for file in llvm if file.dirname == library.dirname and file.basename.lower().endswith(".dll")]
    headers = [file for file in llvm if file.path.startswith(resource + "/")]
    output = ctx.actions.declare_file(ctx.label.name + ".rs")
    arguments = ctx.actions.args()
    arguments.add_all([ctx.file.header, output, rustfmt.rustfmt, ctx.file._rustfmt_config, resource])
    arguments.add_all(compiler.built_in_include_directories)
    # LLVM's loader dependencies and the captured CRT are the only DLL search paths.
    dll_directories = sorted({file.dirname: True for file in runtime + compiler.all_files.to_list() if file.basename.lower().endswith(".dll")}.keys())
    ctx.actions.run(
        executable = ctx.executable._generator,
        tools = [ctx.attr._generator[DefaultInfo].files_to_run],
        arguments = [arguments],
        inputs = depset([ctx.file.header, ctx.file._rustfmt_config] + runtime + headers, transitive = [compiler.all_files, rustfmt.all_files]),
        outputs = [output],
        env = {"LIBCLANG_PATH": library.path, "PATH": ";".join(dll_directories)},
        mnemonic = "WindowsV8Bindgen",
        progress_message = "Generate declared Windows V8 C bindings %{label}",
    )
    return [DefaultInfo(files = depset([output]))]

_bindings = rule(
    implementation = _bindings_impl,
    attrs = {
        "header": attr.label(mandatory = True, allow_single_file = [".h"]),
        "llvm": attr.label(default = "@wasmer_llvm_windows_x64//:files", cfg = "exec", allow_files = True),
        "_generator": attr.label(default = Label(":binding_generator"), executable = True, cfg = "exec"),
        "_rustfmt_config": attr.label(default = Label("//:rustfmt.toml"), allow_single_file = True),
    },
    toolchains = use_cc_toolchain() + [_RUSTFMT],
    fragments = ["cpp"],
)

def windows_v8_bindings(name, header):
    _bindings(name = name, header = header, target_compatible_with = _WINDOWS, exec_compatible_with = _WINDOWS)
