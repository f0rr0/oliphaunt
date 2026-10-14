"""Analysis tests exercise provider rebinding, not native-host qualification."""

load("@bazel_skylib//lib:unittest.bzl", "asserts", "unittest")
load("@rules_swift//swift:providers.bzl", "SwiftToolchainInfo")
load("@rules_swift//swift/toolchains/config:tool_config.bzl", "ToolConfigInfo")
load("@rules_swift//swift/internal:developer_dirs.bzl", "swift_developer_lib_dir")
load(":swift-profile.bzl", "declared_swift_path", "declared_xcode_info")
load(":repositories.bzl", "apple_swift_test_runtime_files")
load(":app-tool-inputs.bzl", "apple_app_configuration_error")

def _profile_test(ctx):
    env = unittest.begin(ctx)
    prefix = "external/selected_sdk/"
    observed_xcode = "Xcode 26.5\nBuild version 17F42"
    captured_sdks = {"macosx": "26.5", "iphoneos": "26.5", "iphonesimulator": "26.5"}
    configured = struct(xcode_version = lambda: apple_common.dotted_version("26.5.0.17f42"), sdk_version_for_platform = lambda platform: apple_common.dotted_version("26.5"), execution_info = lambda: {"no-remote": "1"})
    asserts.equals(env, None, apple_app_configuration_error(configured, observed_xcode, captured_sdks))
    asserts.equals(env, "Stock Apple actions must select the captured Xcode build", apple_app_configuration_error(configured, "Xcode 26.5\nBuild version 17F43", captured_sdks))
    asserts.equals(env, "Stock Apple actions must select the captured Xcode version", apple_app_configuration_error(configured, "Xcode 26.4\nBuild version 17F42", captured_sdks))
    asserts.equals(env, "Stock Apple actions must select the captured iphoneos SDK", apple_app_configuration_error(configured, observed_xcode, captured_sdks | {"iphoneos": "26.4"}))
    remote = struct(xcode_version = configured.xcode_version, sdk_version_for_platform = configured.sdk_version_for_platform, execution_info = lambda: {})
    asserts.equals(env, "The licensed application tools require the stock local Xcode execution boundary", apple_app_configuration_error(remote, observed_xcode, captured_sdks))
    asserts.equals(env, "Captured Xcode version/build observation is malformed", apple_app_configuration_error(configured, "Xcode 26.5", captured_sdks))
    runtime_prefix = "/selected/output-base/external/selected_sdk/"
    implicit_flags = [
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
        cc_common.create_linker_input(owner = ctx.label, user_link_flags = implicit_flags),
    ])))
    test_linking = cc_common.create_linking_context(linker_inputs = depset([
        cc_common.create_linker_input(owner = ctx.label, user_link_flags = [
            "-Wl,-rpath,/private/var/select/developer_dir/Platforms/MacOSX.platform/Developer/Library/Frameworks",
            "-Wl,-rpath,/var/db/xcode_select_link/Platforms/MacOSX.platform/Developer/Library/PrivateFrameworks",
            "-Wl,-rpath,__BAZEL_XCODE_DEVELOPER_DIR__/Platforms/MacOSX.platform/Developer/usr/lib",
        ]),
    ]))
    stock_env = {"XCODE_VERSION_OVERRIDE": "26.5.0.17f42", "APPLE_SDK_PLATFORM": "MacOSX", "APPLE_SDK_VERSION_OVERRIDE": "26.5"}
    original = SwiftToolchainInfo(
        action_configs = [],
        developer_dirs = [struct(developer_path_label = "platform", path = "__BAZEL_XCODE_DEVELOPER_DIR__/Platforms/MacOSX.platform/Developer/Library/Frameworks")],
        implicit_deps_providers = struct(cc_infos = [info], swift_infos = []),
        test_configuration = struct(test_linking_contexts = [test_linking]),
        tool_configs = {"compile": ToolConfigInfo(executable = "swiftc", env = stock_env)},
    )
    rebound = declared_xcode_info(original, {"swiftc": ctx.file.source}, struct(
        files = struct(sdk = [ctx.file.source]),
        attr = struct(prefix = prefix, runtime_prefix = runtime_prefix, sdkroot = prefix + "sdk_macosx", sdk_name = "macosx", resource_directory = prefix + "toolchain/lib/swift", target_triple = "arm64-apple-macosx14.0.0"),
    ))
    input = rebound.implicit_deps_providers.cc_infos[0].linking_context.linker_inputs.to_list()[0]
    asserts.equals(env, expected, input.user_link_flags)
    asserts.equals(env, [ctx.file.source], input.additional_inputs)
    asserts.equals(env, prefix + "platform_macosx/Library/Frameworks", rebound.developer_dirs[0].path)
    asserts.equals(env, prefix + "platform_macosx/usr/lib", swift_developer_lib_dir(rebound.developer_dirs))
    test_expected = [
        "-Wl,-rpath," + runtime_prefix + "platform_macosx/Library/Frameworks",
        "-Wl,-rpath," + runtime_prefix + "platform_macosx/Library/PrivateFrameworks",
        "-Wl,-rpath," + runtime_prefix + "platform_macosx/usr/lib",
    ]
    asserts.equals(env, test_expected, rebound.test_configuration.test_linking_contexts[0].linker_inputs.to_list()[0].user_link_flags)
    compatibility_input = rebound.test_configuration.test_linking_contexts[1].linker_inputs.to_list()[0]
    asserts.equals(env, ["-Wl,-rpath," + runtime_prefix + "toolchain/lib/swift-6.2/macosx"], compatibility_input.user_link_flags)
    asserts.equals(env, [], compatibility_input.libraries)
    framework = "platform_macosx/Library/Frameworks/XCTest.framework/"
    private = "platform_macosx/Library/PrivateFrameworks/XCTAutomationSupport.framework/"
    runtime_files = {
        "platform_macosx/Library": [framework + "XCTest", framework + "Versions/A/XCTest", framework + "Resources/Info.plist", framework + "Versions/A/Resources/en.lproj/Messages.strings", private + "XCTAutomationSupport", private + "Resources/Helpers.bundle/Contents/MacOS/helper"],
        "platform_macosx/usr/lib": ["platform_macosx/usr/lib/libTesting.dylib", "platform_macosx/usr/lib/swift/libTesting.dylib"],
        "toolchain": ["toolchain/lib/swift/macosx/libswiftCore.dylib", "toolchain/lib/swift-6.2/macosx/libTesting.dylib", "toolchain/lib/swift/macosx/Testing.framework/Versions/A/Testing"],
    }
    compile_files = {
        "platform_macosx/Library": [framework + "Headers/XCTest.h", framework + "Versions/A/Modules/module.modulemap", framework + "Modules/libCompileOnly.dylib", private + "PrivateHeaders/XCTAutomationSupport.h"],
        "platform_macosx/usr/lib": ["platform_macosx/usr/lib/libTesting.tbd"],
        "toolchain": ["toolchain/lib/swift/iphonesimulator/libswiftCore.dylib", "toolchain/lib/swift/host/libTestingMacros.dylib", "toolchain/lib/swift_static/macosx/libswiftCore.dylib", "toolchain/bin/swiftc", "toolchain/lib/swift/macosx/Testing.swiftmodule/arm64.swiftinterface"],
    }
    asserts.equals(env, sorted([source for sources in runtime_files.values() for source in sources]), apple_swift_test_runtime_files({component: runtime_files[component] + compile_files[component] for component in runtime_files}))
    asserts.equals(env, ctx.file.source, rebound.tool_configs["compile"].executable)
    asserts.equals(env, [ctx.file.source], rebound.tool_configs["compile"].additional_tools)
    asserts.equals(env, stock_env, rebound.tool_configs["compile"].env)
    asserts.equals(env, "1", rebound.tool_configs["compile"].execution_requirements["no-remote"])
    asserts.equals(env, prefix + "sdk_macosx/usr/include", declared_swift_path("__BAZEL_XCODE_SDKROOT__/usr/include", prefix))
    for sdk, platform in [("iphoneos", "iPhoneOS"), ("iphonesimulator", "iPhoneSimulator")]:
        asserts.equals(env, prefix + "sdk_" + sdk + "/usr/include", declared_swift_path("__BAZEL_XCODE_SDKROOT__/usr/include", prefix, sdk))
        asserts.equals(env, "-F" + prefix + "platform_" + sdk + "/Library/Frameworks", declared_swift_path("-F__BAZEL_XCODE_DEVELOPER_DIR__/Platforms/" + platform + ".platform/Developer/Library/Frameworks", prefix, sdk))
    arguments = []
    recorder = struct(add = lambda flag, value, format = None: arguments.append([flag, value]))
    for configure in rebound.action_configs[-1].configurators:
        configure(None, recorder)
    asserts.equals(env, [["-target", "arm64-apple-macosx14.0.0"], ["-sdk", prefix + "sdk_macosx"], ["-resource-dir", prefix + "toolchain/lib/swift"], ["-plugin-path", prefix + "toolchain/lib/swift/host/plugins/testing"]], arguments)
    return unittest.end(env)

profile_test = unittest.make(_profile_test, attrs = {"source": attr.label(default = ":sdk-smoke.c", allow_single_file = True)})
