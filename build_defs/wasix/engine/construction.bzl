"""Construct Windows engine carriers once, or consume their original archives."""

load("@bazel_skylib//rules:copy_file.bzl", "copy_file")
load(":binding-generator.bzl", "windows_v8_bindings")
load(":defs.bzl", "windows_v8_engine")
load(":packages.bzl", "windows_engine_packages")

_WINDOWS = ["@platforms//os:windows", "@platforms//cpu:x86_64"]

def _execution_files_impl(ctx):
    source = ctx.attr.source
    return [DefaultInfo(files = source[DefaultInfo].files)] + ([source[OutputGroupInfo]] if OutputGroupInfo in source else [])

# Cargo build scripts and the AOT serializer already consume execution Files.
# Public envelopes must use that same configured producer and DLL as well.
_execution_files = rule(
    implementation = _execution_files_impl,
    attrs = {"source": attr.label(mandatory = True, cfg = "exec")},
)

def windows_engine_construction(available, sources):
    if available:
        native.alias(name = "packages", actual = "@wasix_engine_carriers//:packages")
        copy_file(name = "api_bindings_source", src = "@wasix_engine_carriers//:embedded_bindings", out = "prebuilt/embedded_bindings.rs", allow_symlink = True)
        native.alias(name = "embedded_bindings", actual = ":api_bindings_source")
        return
    windows_v8_bindings(
        name = "v8_c_bindings_source",
        header = "@wasix_engine_sources//:upstream/wasmer/third-party/wee8/wasm.h",
    )
    windows_v8_engine(
        name = "oliphaunt_wee8",
        archive = "@windows_wee8//:lib/v8.lib",
        header = "@windows_wee8//:wasm.hh",
        bindings = ":v8_c_bindings_source",
    )
    native.filegroup(name = "dll", srcs = [":oliphaunt_wee8"], output_group = "dll")
    native.filegroup(name = "embedded_bindings_source", srcs = [":oliphaunt_wee8"], output_group = "bindings")
    windows_engine_packages(
        name = "packages_producer",
        sdk_manifest = "//src/wasix/sdks/rust:Cargo.toml",
        source_manifests = {"@wasix_engine_sources//:upstream/" + name + "/Cargo.toml": name for name in sources},
        source_files = ["@wasix_engine_sources//:" + name + "_sources" for name in sources],
        dll = ":dll",
        embedded_bindings = ":embedded_bindings_source",
        build_script = "//build_defs/wasix/engine:build.rs.tpl",
        notices = "@wasix_engine_notices//:THIRD_PARTY_NOTICES.md",
        target_compatible_with = _WINDOWS,
        exec_compatible_with = _WINDOWS,
    )
    for name, source in [("packages", "packages_producer"), ("embedded_bindings", "embedded_bindings_source"), ("v8_c_bindings", "v8_c_bindings_source")]:
        _execution_files(name = name, source = ":" + source, target_compatible_with = _WINDOWS, exec_compatible_with = _WINDOWS)
