"""Declare the Xcode tools and SDK used by the standard Swift actions."""

load("@rules_swift//swift:providers.bzl", "SwiftToolchainInfo")
load("@rules_swift//swift/toolchains/config:action_config.bzl", "ActionConfigInfo", "add_arg")
load("@rules_swift//swift/toolchains/config:tool_config.bzl", "ToolConfigInfo")

def declared_swift_path(value, prefix):
    """Bind stock Xcode paths to this repository's watched SDK projection."""
    for developer in ["__BAZEL_XCODE_DEVELOPER_DIR__", "/private/var/select/developer_dir", "/var/db/xcode_select_link"]:
        value = value.replace(developer + "/Toolchains/XcodeDefault.xctoolchain/usr/", prefix + "toolchain/")
        value = value.replace(developer + "/Platforms/MacOSX.platform/Developer/Library", prefix + "platform_macosx/Library")
        value = value.replace(developer + "/Platforms/MacOSX.platform/Developer/usr/lib", prefix + "platform_macosx/usr/lib")
    value = value.replace("__BAZEL_XCODE_SDKROOT__", prefix + "sdk_macosx")
    if "__BAZEL_XCODE_" in value or "/var/select/developer_dir" in value or "/xcode_select_link" in value:
        fail("Unsupported ambient Xcode path in the declared Swift profile: " + value)
    return value

def _declared_linking_context(context, ctx):
    return cc_common.create_linking_context(linker_inputs = depset([
        cc_common.create_linker_input(
            owner = item.owner,
            libraries = depset(item.libraries),
            additional_inputs = depset(ctx.files.sdk + item.additional_inputs),
            user_link_flags = [declared_swift_path(flag, ctx.attr.prefix) for flag in item.user_link_flags],
        )
        for item in context.linker_inputs.to_list()
    ]))

def _declared_implicit(providers, ctx):
    return struct(
        cc_infos = [CcInfo(compilation_context = info.compilation_context, linking_context = _declared_linking_context(info.linking_context, ctx)) for info in providers.cc_infos],
        swift_infos = providers.swift_infos,
    )

def _fields(value):
    return {name: getattr(value, name) for name in dir(value) if name not in ["to_json", "to_proto"]}

def declared_xcode_info(original, tools, ctx):
    """Rebind a standard Swift provider without changing its action model."""
    fields = _fields(original)
    fields["developer_dirs"] = [struct(developer_path_label = item.developer_path_label, path = declared_swift_path(item.path, ctx.attr.prefix)) for item in original.developer_dirs]
    fields["implicit_deps_providers"] = _declared_implicit(original.implicit_deps_providers, ctx)
    test = _fields(original.test_configuration)
    test["test_linking_contexts"] = [_declared_linking_context(context, ctx) for context in test["test_linking_contexts"]]
    fields["test_configuration"] = struct(**test)
    configs = {}
    for action, configuration in original.tool_configs.items():
        values = _fields(configuration)
        values["additional_tools"] = values["additional_tools"] + ctx.files.sdk
        mode = values["executable"].rsplit("/", 1)[-1]
        if mode not in tools:
            fail("The declared Xcode profile has no tool for Swift driver mode " + mode)
        values["executable"] = tools[mode]
        values["env"] = values["env"] | {"SDKROOT": ctx.attr.sdkroot}
        # This profile imports a licensed SDK from the local Apple host.
        values["execution_requirements"] = values["execution_requirements"] | {"no-remote": "1"}
        configs[action] = ToolConfigInfo(**values)
    fields["tool_configs"] = configs
    # Last SDK/resource flags bind stock Xcode action configuration to our inputs.
    fields["action_configs"] = fields["action_configs"] + [ActionConfigInfo(
        actions = configs.keys(),
        configurators = [
            add_arg("-target", ctx.attr.target_triple),
            add_arg("-sdk", ctx.attr.sdkroot),
            add_arg("-resource-dir", ctx.attr.resource_directory),
            add_arg("-plugin-path", ctx.attr.resource_directory + "/host/plugins/testing"),
        ],
    )]
    info = SwiftToolchainInfo(**fields)
    return info

def _declared_xcode_swift_impl(ctx):
    tools = {mode: target.files.to_list()[0] for target, mode in ctx.attr.tools.items()}
    info = declared_xcode_info(ctx.attr.base[SwiftToolchainInfo], tools, ctx)
    return [platform_common.ToolchainInfo(swift_toolchain = info), info]

declared_xcode_swift_toolchain = rule(
    implementation = _declared_xcode_swift_impl,
    attrs = {
        "base": attr.label(default = "@rules_swift//swift/toolchains:xcode-sdk-toolchain", providers = [SwiftToolchainInfo]),
        "sdk": attr.label_list(allow_files = True, mandatory = True),
        "tools": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "sdkroot": attr.string(mandatory = True),
        "resource_directory": attr.string(mandatory = True),
        "prefix": attr.string(mandatory = True),
        "target_triple": attr.string(mandatory = True),
    },
)
