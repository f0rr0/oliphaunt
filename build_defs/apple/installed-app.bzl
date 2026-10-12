"""Actual local simulator test over a stock application and genuine candidate checkout."""
load("@rules_apple//apple:providers.bzl", "AppleBundleInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

_NODE = "@rules_nodejs//nodejs:toolchain_type"

def _simulator_transition(_settings, _attr):
    return {"//command_line_option:platforms": ["//build_defs/host:ios_simulator_arm64"]}

_SIMULATOR = transition(implementation = _simulator_transition, inputs = [], outputs = ["//command_line_option:platforms"])

def _installed_impl(ctx):
    # A function transition can return a one-element configured target list.
    app = ctx.attr.application[0] if type(ctx.attr.application) == "list" else ctx.attr.application
    archive = app[AppleBundleInfo].archive
    node = ctx.toolchains[_NODE].nodeinfo.node
    tools, helper_rows, files = {}, [], []
    for file in ctx.files.apple_tools + [ctx.file.plutil]:
        if file.basename in ["xcrun", "plutil"]:
            tools[file.basename] = len(files)
        files.append(file)
    for file in ctx.files.helpers:
        helper_rows.append({"relative": file.short_path, "index": len(files)})
        files.append(file)
    if sorted(tools.keys()) != ["plutil", "xcrun"]:
        fail("Installed simulator proof requires the actual declared Xcode xcrun/plutil Files")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({"helpers": helper_rows, "tools": tools, "extensions": ctx.attr.extensions}) + "\n")
    return bun_test_entrypoint(ctx, ctx.file._runner,
        arguments = [specification, archive, ctx.file.sdk, node, ctx.file.receipt] + files,
        files = [specification, archive, ctx.file.sdk, node, ctx.file.receipt] + files,
        source_files = [ctx.file._archive_parser]) + [RunEnvironmentInfo(inherited_environment = [
            "OLIPHAUNT_MOBILE_CANDIDATE_CHECKOUT",
            "OLIPHAUNT_MOBILE_CANDIDATE_SHA",
            "OLIPHAUNT_MOBILE_CANDIDATE_TREE",
        ])]

_installed_test = rule(implementation = _installed_impl, test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE], attrs = BUN_TEST_ENTRYPOINT_ATTRS | {
        "application": attr.label(mandatory = True, providers = [AppleBundleInfo], cfg = _SIMULATOR),
        "sdk": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "helpers": attr.label_list(mandatory = True, allow_files = True),
        "extensions": attr.string_list(mandatory = True),
        "apple_tools": attr.label(default = Label("@native_apple_sdk//:app_tools")),
        "receipt": attr.label(default = Label("@native_apple_sdk//:receipt.json"), allow_single_file = [".json"]),
        "plutil": attr.label(default = Label("@native_apple_sdk//:tools/plutil"), allow_single_file = True),
        "_runner": attr.label(default = Label("//build_defs/apple:installed-app.mts"), allow_single_file = True),
        "_archive_parser": attr.label(default = Label("//:tools/packaging/portable-archive.mts"), allow_single_file = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    })

def expo_ios_installed_test(name, **kwargs):
    _installed_test(name = name, args = bun_test_entrypoint_args(name), tags = ["local", "exclusive", "no-remote", "external"],
        target_compatible_with = ["@platforms//os:macos", "@platforms//cpu:aarch64"], size = "large", timeout = "long", **kwargs)
