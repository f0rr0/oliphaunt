"""Analysis tests exercise provider rebinding, not native-host qualification."""

load("@bazel_skylib//lib:unittest.bzl", "asserts", "unittest")
load("@rules_swift//swift:providers.bzl", "SwiftToolchainInfo")
load("@rules_swift//swift/toolchains/config:tool_config.bzl", "ToolConfigInfo")
load("@rules_swift//swift/internal:developer_dirs.bzl", "swift_developer_lib_dir")
load(":swift-profile.bzl", "declared_swift_path", "declared_xcode_info")

def _profile_test(ctx):
    env = unittest.begin(ctx)
    prefix = "external/selected_sdk/"
    flags = [
        "-L__BAZEL_XCODE_DEVELOPER_DIR__/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx",
        "-F__BAZEL_XCODE_DEVELOPER_DIR__/Platforms/MacOSX.platform/Developer/Library/Frameworks",
        "-Wl,-rpath,/var/db/xcode_select_link/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-6.2/macosx",
        "-L/usr/lib/swift",
    ]
    expected = [
        "-L" + prefix + "toolchain/lib/swift/macosx",
        "-F" + prefix + "platform_macosx/Library/Frameworks",
        "-Wl,-rpath," + prefix + "toolchain/lib/swift-6.2/macosx",
        "-L/usr/lib/swift",
    ]
    info = CcInfo(linking_context = cc_common.create_linking_context(linker_inputs = depset([
        cc_common.create_linker_input(owner = ctx.label, user_link_flags = flags),
    ])))
    original = SwiftToolchainInfo(
        action_configs = [],
        developer_dirs = [struct(developer_path_label = "platform", path = "__BAZEL_XCODE_DEVELOPER_DIR__/Platforms/MacOSX.platform/Developer/Library/Frameworks")],
        implicit_deps_providers = struct(cc_infos = [info], swift_infos = []),
        test_configuration = struct(test_linking_contexts = [info.linking_context]),
        tool_configs = {"compile": ToolConfigInfo(executable = "swiftc")},
    )
    rebound = declared_xcode_info(original, {"swiftc": ctx.file.source}, struct(
        files = struct(sdk = [ctx.file.source]),
        attr = struct(prefix = prefix, sdkroot = prefix + "sdk_macosx", resource_directory = prefix + "toolchain/lib/swift", target_triple = "arm64-apple-macosx14.0.0"),
    ))
    input = rebound.implicit_deps_providers.cc_infos[0].linking_context.linker_inputs.to_list()[0]
    asserts.equals(env, expected, input.user_link_flags)
    asserts.equals(env, [ctx.file.source], input.additional_inputs)
    asserts.equals(env, prefix + "platform_macosx/Library/Frameworks", rebound.developer_dirs[0].path)
    asserts.equals(env, prefix + "platform_macosx/usr/lib", swift_developer_lib_dir(rebound.developer_dirs))
    asserts.equals(env, expected, rebound.test_configuration.test_linking_contexts[0].linker_inputs.to_list()[0].user_link_flags)
    asserts.equals(env, ctx.file.source, rebound.tool_configs["compile"].executable)
    asserts.equals(env, [ctx.file.source], rebound.tool_configs["compile"].additional_tools)
    asserts.equals(env, prefix + "sdk_macosx", rebound.tool_configs["compile"].env["SDKROOT"])
    asserts.equals(env, "1", rebound.tool_configs["compile"].execution_requirements["no-remote"])
    asserts.equals(env, prefix + "sdk_macosx/usr/include", declared_swift_path("__BAZEL_XCODE_SDKROOT__/usr/include", prefix))
    arguments = []
    recorder = struct(add = lambda flag, value, format = None: arguments.append([flag, value]))
    for configure in rebound.action_configs[-1].configurators:
        configure(None, recorder)
    asserts.equals(env, [["-target", "arm64-apple-macosx14.0.0"], ["-sdk", prefix + "sdk_macosx"], ["-resource-dir", prefix + "toolchain/lib/swift"], ["-plugin-path", prefix + "toolchain/lib/swift/host/plugins/testing"]], arguments)
    return unittest.end(env)

profile_test = unittest.make(_profile_test, attrs = {"source": attr.label(default = ":sdk-smoke.c", allow_single_file = True)})
