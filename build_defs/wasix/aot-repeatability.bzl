"""Exercise the actual Mach-O serializer in independently seeded processes."""

load("@wasix_tool_metadata//:targets.bzl", "WASIX_AOT_TARGETS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load(":platform.bzl", "WASIX_PORTABLE_TRANSITION")
load(":wasm.bzl", "WasmModuleInfo")

def _repeatability_impl(ctx):
    module = ctx.attr.module[0][WasmModuleInfo].module
    serializer = ctx.executable._serializer
    return bun_test_entrypoint(
        ctx,
        ctx.file._runner,
        [serializer, module, WASIX_AOT_TARGETS["macos-arm64"]],
        [serializer, module, ctx.file._runner],
        source_files = [ctx.file._runner],
        additional_runfiles = ctx.attr._serializer[DefaultInfo].default_runfiles,
    )

_wasix_aot_repeatability_test = rule(
    implementation = _repeatability_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "module": attr.label(mandatory = True, providers = [WasmModuleInfo], cfg = WASIX_PORTABLE_TRANSITION),
        "_serializer": attr.label(default = "//src/wasix/runtime/tools/xtask:aot_serializer", executable = True, cfg = "exec"),
        "_runner": attr.label(default = "//build_defs/wasix:aot-repeatability.mts", allow_single_file = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    }),
)

def wasix_aot_repeatability_test(name, **kwargs):
    _wasix_aot_repeatability_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)
