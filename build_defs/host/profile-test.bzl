"""Analysis tests exercise provider rebinding, not native-host qualification."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@apple_support//xcode:xcode_config.bzl", "xcode_config")
load("@apple_support//xcode:xcode_version.bzl", "xcode_version")
load("@rules_cc//cc/private/toolchain:unix_cc_toolchain_config.bzl", unix_config = "cc_toolchain_config")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@apple_support//crosstool:cc_toolchain_config.bzl", apple_config = "cc_toolchain_config")
load("@rules_cc//cc/toolchains:cc_toolchain.bzl", "cc_toolchain")
load("@rules_swift//swift:providers.bzl", "SwiftToolchainInfo")
load("@rules_swift//swift/toolchains/config:tool_config.bzl", "ToolConfigInfo")
load("@rules_swift//swift/toolchains/config:action_config.bzl", "ActionConfigInfo", "add_arg")
load("@rules_swift//swift/toolchains/config:compile_config.bzl", "compiler_plugin_search_path_configurator")
load("@rules_swift//swift/internal:actions.bzl", "compiler_plugin_directory_error", "run_toolchain_action")
load("@rules_swift//swift/internal:action_names.bzl", "SWIFT_ACTION_COMPILE", "SWIFT_ACTION_DERIVE_FILES", "SWIFT_ACTION_COMPILE_MODULE_INTERFACE", "SWIFT_ACTION_SYMBOL_GRAPH_EXTRACT", "all_action_names", "all_compile_action_names", "compiler_plugin_action_names")
load("@rules_swift//swift/internal:developer_dirs.bzl", "swift_developer_lib_dir")
load(":swift-profile.bzl", "declared_swift_path", "declared_xcode_info")
load(":repositories.bzl", "apple_cc_compile_files", "apple_swift_test_runtime_files")
load(":app-tool-inputs.bzl", "apple_app_configuration_error")
load(":cc-profiles.bzl", "host_builtin_include_directories")

_APPLE_SDKS = ["macosx", "iphoneos", "iphonesimulator"]
_USE_LIBTOOL_ON_MACOS = str(Label("@rules_cc//cc/toolchains/args/archiver_flags:use_libtool_on_macos"))

def _archive_fixture_impl(_settings, attr):
    return {_USE_LIBTOOL_ON_MACOS: False, "//command_line_option:xcode_version_config": str(attr.xcode_configuration)}

_archive_fixture = transition(implementation = _archive_fixture_impl, inputs = [], outputs = [_USE_LIBTOOL_ON_MACOS, "//command_line_option:xcode_version_config"])

def _builtin_directories(sdk):
    return ["toolchain/lib/clang/20/include", "sdk_" + sdk + "/usr/include", "sdk_" + sdk + "/System/Library/Frameworks", "toolchain/include/c++/v1"]

def _plugin_arguments(source, directory, include_developer, action):
    arguments = []
    actions = struct(
        args = lambda: struct(add = lambda flag, value = None, format = None: arguments.append([flag, value])),
        run = lambda **kwargs: None,
    )
    fields = {
        "tool_configs": {action: ToolConfigInfo(executable = source)},
        "action_configs": [
            ActionConfigInfo(actions = [action], configurators = [add_arg("-marker", "preserved")]),
            ActionConfigInfo(actions = compiler_plugin_action_names(), configurators = [compiler_plugin_search_path_configurator("__BAZEL_XCODE_DEVELOPER_DIR__/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/plugins/testing")]),
            ActionConfigInfo(actions = all_compile_action_names(), configurators = [compiler_plugin_search_path_configurator("__BAZEL_SWIFT_TOOLCHAIN_PATH__/usr/lib/swift/host/plugins/testing", developer_search_only = True)]),
        ],
    }
    if directory != None:
        fields["compiler_plugin_directory"] = directory
    run_toolchain_action(
        actions = actions,
        action_name = action,
        feature_configuration = None,
        prerequisites = struct(include_dev_srch_paths = include_developer),
        swift_toolchain = SwiftToolchainInfo(**fields),
        toolchain_type = "fixture",
    )
    return arguments

def _profile_test(ctx):
    env = analysistest.begin(ctx)
    prefix = "external/selected_sdk/"
    # Inspect the actual CcToolchainInfo expansion in a non-root package: bare
    # execroot paths would be prefixed again by this toolchain's package path.
    for sdk, compiler in zip(_APPLE_SDKS, ctx.attr.cc_profiles):
        asserts.equals(env, [prefix + directory for directory in _builtin_directories(sdk)], compiler[cc_common.CcToolchainInfo].built_in_include_directories)
    resource = "toolchain/lib/clang/20"
    compiler_files = [
        "toolchain/bin/swiftc", "toolchain/include/swift/bridging", "toolchain/include/c++/v1/vector",
        resource + "/include/stddef.h", resource + "/lib/darwin/libclang_rt.osx.a", resource + "/retained.swiftmodule",
        "toolchain/lib/swift/host/libCompilerPlugin.dylib", "tools/clang", "tools/ld",
        "toolchain/lib/swift/Foo.swiftmodule/Interop.h", "toolchain/lib/swift/Foo.swiftmodule/cache.pcm",
    ] + ["sdk_" + sdk + "/System/Library/Frameworks/Foo.framework/" + suffix for sdk in _APPLE_SDKS for suffix in ["Headers/Foo.h", "Modules/module.modulemap", "Modules/cache.pcm"]]
    swift_modules = [
        "toolchain/lib/swift/macosx/Foo.swiftmodule/arm64-apple-macos.swiftinterface",
        "toolchain/lib/swift/macosx/Foo.swiftmodule/arm64-apple-macos.swiftdoc",
    ] + ["sdk_" + sdk + "/System/Library/Frameworks/Foo.framework/Modules/arm64.swiftmodule" for sdk in _APPLE_SDKS]
    asserts.equals(env, compiler_files, apple_cc_compile_files(compiler_files + swift_modules, resource))
    # Inspect stock archive expansion: native ar metadata and Apple libtool
    # actions have distinct interfaces even when they expose the same AR path.
    for index, compiler in enumerate(ctx.attr.archive_profiles):
        toolchain = compiler[cc_common.CcToolchainInfo]
        features = cc_common.configure_features(ctx = ctx, cc_toolchain = toolchain)
        variables = cc_common.create_link_variables(cc_toolchain = toolchain, feature_configuration = features, output_file = "fixture.a", is_using_linker = False)
        tool = cc_common.get_tool_for_action(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_static_library)
        flags = cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = ACTION_NAMES.cpp_link_static_library, variables = variables)
        expected_ar = "/".join([part for part in [compiler.label.workspace_root, compiler.label.package, "tools/ar"] if part])
        asserts.equals(env, expected_ar, toolchain.ar_executable)
        asserts.equals(env, expected_ar if index == 0 else ctx.file.libtool.path, tool)
        asserts.true(env, "fixture.a" in flags)
        if index == 0:
            asserts.true(env, "rcs" in flags)
            asserts.false(env, "-static" in flags)
            asserts.false(env, "-o" in flags)
        else:
            asserts.true(env, "-D" in flags)
            asserts.true(env, "-static" in flags)
            asserts.true(env, "-o" in flags)
            if "-o" in flags:
                asserts.equals(env, ["fixture.a"], flags[flags.index("-o") + 1:flags.index("-o") + 2])
        if index > 0:
            for action, source in [(ACTION_NAMES.c_compile, "fixture.c"), (ACTION_NAMES.objc_compile, "fixture.m"), (ACTION_NAMES.cpp_compile, "fixture.cpp"), (ACTION_NAMES.objcpp_compile, "fixture.mm")]:
                variables = cc_common.create_compile_variables(cc_toolchain = toolchain, feature_configuration = features, source_file = source, output_file = "fixture.o")
                flags = cc_common.get_memory_inefficient_command_line(feature_configuration = features, action_name = action, variables = variables)
                standards = [flag for flag in flags if flag.startswith("-std=")]
                if index == 2 and (source.endswith(".cpp") or source.endswith(".mm")):
                    asserts.equals(env, "-std=c++20", standards[-1] if standards else None, source + " must use the configured C++20 dialect after toolchain defaults")
                elif source.endswith(".mm"):
                    asserts.equals(env, ["-std=gnu++17"], standards, "an empty C++ profile preserves the upstream Objective-C++ default")
                else:
                    asserts.equals(env, [], standards, "C++ profile flags must not reach C or Objective-C")
    observed_xcode = "Xcode 26.5\nBuild version 17F42"
    captured_sdks = {"macosx": "26.5", "iphoneos": "26.5", "iphonesimulator": "26.5"}
    # Explicit stock Xcode configurations report UNKNOWN availability even
    # when the selected version is installed locally.
    configured = ctx.attr.xcode_configuration[apple_common.XcodeVersionConfig]
    asserts.equals(env, "unknown", configured.availability())
    asserts.equals(env, None, apple_app_configuration_error(configured, observed_xcode, captured_sdks))
    asserts.equals(env, "Stock Apple actions must select the captured Xcode build", apple_app_configuration_error(configured, "Xcode 26.5\nBuild version 17F43", captured_sdks))
    asserts.equals(env, "Stock Apple actions must select the captured Xcode version", apple_app_configuration_error(configured, "Xcode 26.4\nBuild version 17F42", captured_sdks))
    asserts.equals(env, "Stock Apple actions must select the captured iphoneos SDK", apple_app_configuration_error(configured, observed_xcode, captured_sdks | {"iphoneos": "26.4"}))
    remote = struct(xcode_version = configured.xcode_version, sdk_version_for_platform = configured.sdk_version_for_platform, execution_info = lambda: {"no-local": ""})
    asserts.equals(env, "The licensed application tools cannot use a remote-only Xcode configuration", apple_app_configuration_error(remote, observed_xcode, captured_sdks))
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
    asserts.equals(env, prefix + "toolchain/lib/swift/host/plugins/testing", rebound.compiler_plugin_directory)
    asserts.equals(env, "1", rebound.tool_configs["compile"].execution_requirements["no-remote"])
    asserts.equals(env, prefix + "sdk_macosx/usr/include", declared_swift_path("__BAZEL_XCODE_SDKROOT__/usr/include", prefix))
    for sdk, platform in [("iphoneos", "iPhoneOS"), ("iphonesimulator", "iPhoneSimulator")]:
        asserts.equals(env, prefix + "sdk_" + sdk + "/usr/include", declared_swift_path("__BAZEL_XCODE_SDKROOT__/usr/include", prefix, sdk))
        asserts.equals(env, "-F" + prefix + "platform_" + sdk + "/Library/Frameworks", declared_swift_path("-F__BAZEL_XCODE_DEVELOPER_DIR__/Platforms/" + platform + ".platform/Developer/Library/Frameworks", prefix, sdk))
    arguments = []
    recorder = struct(add = lambda flag, value, format = None: arguments.append([flag, value]))
    for configure in rebound.action_configs[-1].configurators:
        configure(None, recorder)
    asserts.equals(env, [["-target", "arm64-apple-macosx14.0.0"], ["-sdk", prefix + "sdk_macosx"], ["-resource-dir", prefix + "toolchain/lib/swift"]], arguments)
    legacy_xcode = ["-plugin-path", "__BAZEL_XCODE_DEVELOPER_DIR__/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/plugins/testing"]
    legacy_toolchain = ["-plugin-path", "__BAZEL_SWIFT_TOOLCHAIN_PATH__/usr/lib/swift/host/plugins/testing"]
    marker = ["-marker", "preserved"]
    stock_plugin_actions = [SWIFT_ACTION_COMPILE, SWIFT_ACTION_DERIVE_FILES, SWIFT_ACTION_COMPILE_MODULE_INTERFACE, SWIFT_ACTION_SYMBOL_GRAPH_EXTRACT]
    asserts.equals(env, stock_plugin_actions, compiler_plugin_action_names())
    for action in all_action_names():
        for include_developer in [False, True]:
            defaults = [marker] + ([legacy_xcode] if action in stock_plugin_actions else []) + ([legacy_toolchain] if include_developer and action in all_compile_action_names() else [])
            asserts.equals(env, defaults, _plugin_arguments(ctx.file.source, None, include_developer, action))
            # The actual stock pipeline replaces both paths once, only for
            # actions in their original scope; other driver modes get no flag.
            captured = ([["-plugin-path", rebound.compiler_plugin_directory]] if action in stock_plugin_actions else []) + [marker]
            asserts.equals(env, captured, _plugin_arguments(ctx.file.source, rebound.compiler_plugin_directory, include_developer, action))
    asserts.equals(env, None, compiler_plugin_directory_error(None))
    asserts.equals(env, None, compiler_plugin_directory_error(rebound.compiler_plugin_directory))
    for invalid in ["", 23, []]:
        asserts.equals(env, "compiler_plugin_directory must be a non-empty directory path", compiler_plugin_directory_error(invalid))
    missing = prefix + "missing-plugins"
    asserts.equals(env, [["-plugin-path", missing], marker], _plugin_arguments(ctx.file.source, missing, True, compiler_plugin_action_names()[0]))
    return analysistest.end(env)

_profile_rule_test = analysistest.make(_profile_test, fragments = ["cpp"], attrs = {"source": attr.label(default = ":sdk-smoke.c", allow_single_file = True), "libtool": attr.label(default = "@apple_support//crosstool:libtool.cc", allow_single_file = True), "cc_profiles": attr.label_list(providers = [cc_common.CcToolchainInfo]), "archive_profiles": attr.label_list(providers = [cc_common.CcToolchainInfo], cfg = _archive_fixture), "xcode_configuration": attr.label(providers = [apple_common.XcodeVersionConfig]), "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist")})

def profile_test(name, **kwargs):
    """Exercise builtin path interpretation without acquiring a licensed SDK."""
    xcode_version(name = name + "_xcode_version", version = "26.5.0.17f42", default_macos_sdk_version = "26.5", default_ios_sdk_version = "26.5")
    xcode_config(name = name + "_xcode_configuration", versions = [":" + name + "_xcode_version"], default = ":" + name + "_xcode_version")
    profiles = []
    for sdk in _APPLE_SDKS + ["native_archive", "package_archive", "ios_cpp_archive"]:
        profile = name + "_" + sdk
        selected_sdk = "macosx" if sdk in ["native_archive", "package_archive"] else "iphonesimulator" if sdk == "ios_cpp_archive" else sdk
        includes = host_builtin_include_directories("external/selected_sdk/", _builtin_directories(selected_sdk))
        if sdk in ["package_archive", "ios_cpp_archive"]:
            apple_config(
                name = profile + "_configuration",
                cpu = "ios_sim_arm64" if sdk == "ios_cpp_archive" else "darwin_arm64",
                wrapped_clang = ":sdk-smoke.c",
                wrapped_clang_pp = ":sdk-smoke.c",
                libtool = "@apple_support//crosstool:libtool.cc",
                module_map = ":" + profile + "_files",
                cxx_builtin_include_directories = includes,
                cxx_flags = ["-std=c++20"] if sdk == "ios_cpp_archive" else [],
                tool_paths_overrides = {"ar": "tools/ar"},
                testonly = True,
            )
        else:
            unix_config(
                name = profile + "_configuration",
                cpu = "darwin_arm64",
                compiler = "clang",
                host_system_name = "fixture",
                target_system_name = "fixture",
                target_libc = "macosx" if sdk == "native_archive" else "fixture",
                abi_version = "fixture",
                abi_libc_version = "fixture",
                toolchain_identifier = profile,
                cxx_builtin_include_directories = includes,
                tool_paths = {tool: "/bin/false" for tool in ["ar", "cpp", "gcc", "gcov", "ld", "nm", "objdump", "strip"]} | ({"ar": "tools/ar"} if sdk == "native_archive" else {}),
                testonly = True,
            )
        native.filegroup(name = profile + "_files", srcs = [], testonly = True)
        cc_toolchain(name = profile, toolchain_identifier = profile, toolchain_config = ":" + profile + "_configuration",
                     all_files = ":" + profile + "_files", ar_files = ":" + profile + "_files", as_files = ":" + profile + "_files",
                     compiler_files = ":" + profile + "_files", dwp_files = ":" + profile + "_files", linker_files = ":" + profile + "_files",
                     objcopy_files = ":" + profile + "_files", strip_files = ":" + profile + "_files", testonly = True)
        profiles.append(":" + profile)
    _profile_rule_test(name = name, target_under_test = profiles[0], cc_profiles = profiles[:3], archive_profiles = profiles[3:], xcode_configuration = ":" + name + "_xcode_configuration", **kwargs)
