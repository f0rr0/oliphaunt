"""Pinned Windows V8 DLL construction; Cargo consumers receive only its output."""

load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_import", "cc_library")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

_WINDOWS = ["@platforms//os:windows", "@platforms//cpu:x86_64"]

def _exports_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".def")
    header = ctx.actions.declare_file(ctx.label.name + ".include/wasm.hh")
    ctx.actions.symlink(output = header, target_file = ctx.file.header)
    bun_file_action(ctx, entry_point = ctx.file._generator,
                    arguments = ["exports", ctx.file.bindings.path, output.path],
                    inputs = [ctx.file.bindings], source_files = [ctx.file._generator],
                    outputs = [output], mnemonic = "WindowsV8Exports")
    return [DefaultInfo(files = depset([output, header])),
            OutputGroupInfo(exports = depset([output]), header = depset([header]))]

_exports = rule(implementation = _exports_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "bindings": attr.label(mandatory = True, allow_single_file = [".rs"]),
    "header": attr.label(mandatory = True, allow_single_file = True),
    "_generator": attr.label(default = Label(":generate.mts"), allow_single_file = True),
})

def _embedded_impl(ctx):
    output = ctx.actions.declare_file("prebuilt/embedded_bindings.rs")
    bun_file_action(ctx, entry_point = ctx.file._generator,
                    arguments = ["embedded", ctx.file.bindings.path, output.path, ctx.file._loader.path, ctx.file.dll.path],
                    inputs = [ctx.file.bindings, ctx.file._loader, ctx.file.dll], source_files = [ctx.file._generator],
                    outputs = [output], mnemonic = "WindowsV8EmbeddedBindings")
    # The API crate consumes only these sources; the payload facade owns the DLL.
    return [DefaultInfo(files = depset([output, ctx.file._build_script])),
            OutputGroupInfo(bindings = depset([output]), dll = depset([ctx.file.dll]), build_script = depset([ctx.file._build_script]))]

_embedded = rule(implementation = _embedded_impl, toolchains = BUN_SOURCE_TOOLCHAINS, attrs = {
    "bindings": attr.label(mandatory = True, allow_single_file = [".rs"]),
    "dll": attr.label(mandatory = True, allow_single_file = [".dll"]),
    "_generator": attr.label(default = Label(":generate.mts"), allow_single_file = True),
    "_loader": attr.label(default = Label(":embedded-engine.rs"), allow_single_file = True),
    "_build_script": attr.label(default = Label(":build.rs.tpl"), allow_single_file = True),
})

def windows_v8_engine(name, archive, header, bindings, visibility = None):
    """Build from pinned Wee8 archive/header and declared Windows bindgen output."""
    exports = name + "_exports"
    _exports(name = exports, bindings = bindings, header = header)
    native.filegroup(name = name + "_def", srcs = [":" + exports], output_group = "exports")
    native.filegroup(name = name + "_header_file", srcs = [":" + exports], output_group = "header")
    cc_library(name = name + "_header", hdrs = [":" + name + "_header_file"], strip_include_prefix = exports + ".include")
    cc_import(name = name + "_archive", static_library = archive, target_compatible_with = _WINDOWS)
    cc_binary(
        name = name + ".dll",
        srcs = [Label(":bridge.cc")],
        deps = [":" + name + "_archive", ":" + name + "_header"],
        copts = ["/O2", "/EHsc", "/std:c++20"],
        linkopts = ["/INCREMENTAL:NO", "winmm.lib", "dbghelp.lib", "shlwapi.lib"],
        win_def_file = ":" + name + "_def",
        linkshared = True,
        linkstatic = True,
        # Wee8 is a release /MT archive, including in a debug consumer build.
        features = ["no_windows_export_all_symbols", "static_link_msvcrt", "-dynamic_link_msvcrt", "-dbg"],
        target_compatible_with = _WINDOWS,
    )
    _embedded(name = name, bindings = bindings, dll = ":" + name + ".dll", target_compatible_with = _WINDOWS, visibility = visibility)
