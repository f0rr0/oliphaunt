"""Actual local simulator test over a stock application and genuine candidate checkout."""
load("@rules_apple//apple:providers.bzl", "AppleBundleInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/foundation:bun-sources.bzl", "bun_source_tree", "bun_source_runfile")

_NODE = "@rules_nodejs//nodejs:toolchain_type"
InstalledAppleToolsInfo = provider(fields = ["node", "receipt", "files", "specification", "runner", "sources"])

def _simulator_transition(_settings, _attr):
    return {"//command_line_option:platforms": ["//build_defs/host:ios_simulator_arm64"]}

_SIMULATOR = transition(implementation = _simulator_transition, inputs = [], outputs = ["//command_line_option:platforms"])

def _tools_impl(ctx):
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
    tool_spec = {"helpers": helper_rows, "tools": tools}
    sources = [ctx.file._runner, ctx.file._archive_parser]
    runner_sources = bun_source_tree(ctx, ctx.label.name + ".installed-sources", sources)
    descriptor = ctx.actions.declare_file(ctx.label.name + ".tools.json")
    ctx.actions.write(descriptor, json.encode({
        "schema": "oliphaunt-installed-mobile-tools-v1", "platform": "ios", "toolSpec": tool_spec,
        "runnerRunfile": bun_source_runfile(ctx, runner_sources, ctx.file._runner), "fileCount": len(files),
    }) + "\n")
    return bun_test_entrypoint(ctx, ctx.file._manifest_runner,
        arguments = [descriptor, node, ctx.file.receipt] + files, files = [descriptor, node, ctx.file.receipt] + files,
        source_files = [], runfiles_argument = True,
        additional_runfiles = ctx.runfiles(transitive_files = runner_sources.files)) + [InstalledAppleToolsInfo(
            node = node, receipt = ctx.file.receipt, files = files, specification = tool_spec,
            runner = ctx.file._runner, sources = sources)]

def _installed_impl(ctx):
    # A function transition can return a one-element configured target list.
    app = ctx.attr.application[0] if type(ctx.attr.application) == "list" else ctx.attr.application
    archive = app[AppleBundleInfo].archive
    tools = ctx.attr.tools[InstalledAppleToolsInfo]
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode(dict(tools.specification, **{
        "extensions": ctx.attr.extensions,
        "replay": {"schema": "oliphaunt-installed-mobile-replay-v1", "platform": "ios",
            "files": {"application": archive.path, "sdk": ctx.file.sdk.path}},
    })) + "\n")
    arguments = [specification, archive, ctx.file.sdk, tools.node, tools.receipt] + tools.files
    return bun_test_entrypoint(ctx, tools.runner, arguments = arguments, files = arguments,
        source_files = tools.sources) + [
        OutputGroupInfo(observation_inputs = depset([specification, archive, ctx.file.sdk])),
        RunEnvironmentInfo(inherited_environment = [
            "OLIPHAUNT_MOBILE_CANDIDATE_CHECKOUT", "OLIPHAUNT_MOBILE_CANDIDATE_SHA", "OLIPHAUNT_MOBILE_CANDIDATE_TREE",
        ]),
    ]

_installed_tools = rule(implementation = _tools_impl, executable = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE], attrs = BUN_TEST_ENTRYPOINT_ATTRS | {
        "helpers": attr.label_list(mandatory = True, allow_files = True),
        "apple_tools": attr.label(default = Label("@native_apple_sdk//:app_tools")),
        "receipt": attr.label(default = Label("@native_apple_sdk//:receipt.json"), allow_single_file = [".json"]),
        "plutil": attr.label(default = Label("@native_apple_sdk//:tools/plutil"), allow_single_file = True),
        "_manifest_runner": attr.label(default = Label("//build_defs/apple:installed-tools.mts"), allow_single_file = True),
        "_runner": attr.label(default = Label("//build_defs/apple:installed-app.mts"), allow_single_file = True),
        "_archive_parser": attr.label(default = Label("//:tools/packaging/portable-archive.mts"), allow_single_file = True),
    })

_installed_test = rule(implementation = _installed_impl, test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS, attrs = BUN_TEST_ENTRYPOINT_ATTRS | {
        "tools": attr.label(mandatory = True, providers = [InstalledAppleToolsInfo]),
        "application": attr.label(mandatory = True, providers = [AppleBundleInfo], cfg = _SIMULATOR),
        "sdk": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "extensions": attr.string_list(mandatory = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    })

def expo_ios_installed_test(name, helpers, **kwargs):
    compatible = ["@platforms//os:macos", "@platforms//cpu:aarch64"]
    tool_attrs = {}
    for key in ["apple_tools", "receipt", "plutil"]:
        if key in kwargs:
            tool_attrs[key] = kwargs.pop(key)
    _installed_tools(name = name + "_tools", helpers = helpers, args = bun_test_entrypoint_args(name + "_tools"),
        target_compatible_with = compatible, **tool_attrs)
    _installed_test(name = name, tools = ":" + name + "_tools", args = bun_test_entrypoint_args(name),
        tags = ["local", "exclusive", "no-remote", "external"],
        target_compatible_with = compatible, size = "large", timeout = "long", **kwargs)
