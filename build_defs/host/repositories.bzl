"""Lazy native-host SDK profiles; incompatible client hosts fail acquisition."""

load(":sdk-tree.bzl", "apple_sdk_documentation_directories", "watch_sdk_directory")

def apple_cc_compile_files(files, resource_directory):
    """C-family actions keep compiler resources, excluding Swift module formats."""
    return [source for source in files if source.startswith(resource_directory + "/") or not (source.endswith(".swiftmodule") or source.endswith(".swiftinterface") or source.endswith(".swiftdoc"))]

def apple_swift_test_runtime_files(component_files):
    """Keep runtime dylibs and framework resources, excluding compile inputs."""
    runtime = []
    for component in ["toolchain", "platform_macosx/Library", "platform_macosx/usr/lib"]:
        for source in component_files[component]:
            if component == "toolchain":
                parts = source.split("/")
                if len(parts) < 5 or parts[:2] != ["toolchain", "lib"] or not (parts[2] == "swift" or parts[2].startswith("swift-")) or parts[3] != "macosx":
                    continue
            if ".framework/" in source and any([part in source for part in ["/Headers/", "/PrivateHeaders/", "/Modules/"]]):
                continue
            if source.endswith(".dylib") or ".framework/" in source:
                runtime.append(source)
    return sorted(runtime)

def _host_sdk_impl(ctx):
    expected_os = "mac os x" if ctx.attr.family == "apple" else "windows"
    if not ctx.os.name.lower().startswith(expected_os):
        fail("The %s SDK profile requires its native %s client host; no cross-host SDK acquisition is declared." % (ctx.attr.family, expected_os))
    for source in [ctx.attr.collector, ctx.attr.policy, ctx.attr.compatibility, ctx.attr.deployment_policy, ctx.attr._app_tools, ctx.attr._vc_runtime_contract, ctx.attr._vc_runtime_policy]:
        ctx.read(source)
    ctx.watch(ctx.path(ctx.attr.bun))
    result = ctx.execute([ctx.path(ctx.attr.bun), ctx.path(ctx.attr.collector), ctx.path(ctx.attr.policy), ctx.attr.family], timeout = 120, quiet = True)
    if result.return_code:
        fail("Cannot declare the selected host SDK: " + result.stderr)
    sdk = json.decode(result.stdout)
    if ctx.attr.family == "apple":
        # Retain the pinned standard drivers' argument/response-file behavior,
        # while executing the exact tools in this declared SDK projection.
        for name, source in [("wrapped_clang.cc", ctx.attr._wrapped_clang), ("libtool.cc", ctx.attr._libtool)]:
            ctx.file(name, ctx.read(source))
        ctx.read(ctx.attr._driver_patch)
        ctx.patch(ctx.attr._driver_patch, strip = 1)
    component_files = {}
    for component in sdk["components"]:
        source = ctx.path(component["path"])
        if component["directory"]:
            # Perl manual names include colons, which cannot be Bazel labels.
            # Manual pages are not clang/Swift tools, headers, modules, or libs.
            excluded = apple_sdk_documentation_directories(component["name"]) if ctx.attr.family == "apple" else []
            component_files[component["name"]] = [component["name"] + "/" + relative for relative in watch_sdk_directory(ctx, source, excluded)]
        else:
            ctx.watch(source)
            component_files[component["name"]] = [component["name"]]
        ctx.symlink(source, component["name"])
    # Collector observations derive from these executable bytes independently
    # of the SDK's directory membership and ordinary action-file digests.
    if ctx.attr.family == "apple":
        for tool in ["/usr/bin/xcodebuild", "/usr/bin/sw_vers"]:
            ctx.watch(ctx.path(tool))
    for logical in sdk["tools"].values():
        matched = False
        for component in sdk["components"]:
            if logical == component["name"]:
                ctx.watch(ctx.path(component["path"]))
                matched = True
                break
            if component["directory"] and logical.startswith(component["name"] + "/"):
                ctx.watch(ctx.path(component["path"]).get_child(logical[len(component["name"]) + 1:]))
                matched = True
                break
        if not matched:
            fail("The selected host SDK tool has no declared component: " + logical)
    ctx.file("receipt.json", json.encode_indent(sdk))
    ctx.file("sdk.bzl", "HOST_SDK = " + repr(sdk) + "\n")
    ctx.file("unsupported.bat", "@echo off\r\necho This operation is not supported by the declared host compiler profile. 1>&2\r\nexit /b 1\r\n", executable = True)
    ctx.file("unsupported.sh", "#!/usr/bin/env bash\necho 'This operation is not supported by the declared host compiler profile.' >&2\nexit 1\n", executable = True)
    lines = [
        'load(%s, "host_cc_profiles")' % repr(str(ctx.attr.cc_profiles)),
        'load(":sdk.bzl", "HOST_SDK")',
        'package(default_visibility = ["//visibility:public"])',
        'exports_files(["receipt.json", "unsupported.bat", "unsupported.sh"])',
    ]
    for component in sdk["components"]:
        # glob exclusions are applied after traversal and cannot stop SDK cycles.
        sources = repr(component_files[component["name"]])
        lines.append("filegroup(name = %s, srcs = %s)" % (repr(component["name"] + "_files"), sources))
        if ctx.attr.family == "apple" and "compile" in component["roles"]:
            compile_sources = apple_cc_compile_files(component_files[component["name"]], sdk["resourceDirectory"])
            lines.append("filegroup(name = %s, srcs = %s)" % (repr(component["name"] + "_compile_files"), repr(compile_sources)))
    if ctx.attr.family == "msvc":
        lines.append("exports_files(%s)" % repr([sdk["tools"]["dumpbin"], sdk["tools"]["rc"]]))
        lines.append('filegroup(name = "runtime_dlls", srcs = %s)' % repr(sdk["runtimeDlls"]))
    lines.append("host_cc_profiles(HOST_SDK)")
    if ctx.attr.family == "apple":
        lines.insert(0, 'load(%s, "declared_apple_app_tools")' % repr(str(ctx.attr.app_tools_profile)))
        app_tools = [":receipt.json"] + [":" + sdk["tools"][name] + "_files" for name in ["actool", "ibtool", "codesign", "codesign_allocate", "ditto", "lipo", "swift-stdlib-tool", "simctl", "otool"]] + [":tools/xcrun_files"]
        lines.append('declared_apple_app_tools(name = "app_tools", tools = %s, xcode_observation = %s, sdk_versions = %s)' % (repr(app_tools), repr(sdk["observations"]["xcode"]), repr({name: sdk["observations"][name + "_version"] for name in ["macosx", "iphoneos", "iphonesimulator"]})))
        lines.append('exports_files(%s)' % repr([sdk["tools"][name] for name in ["actool", "ibtool", "codesign", "codesign_allocate", "ditto", "lipo", "swift-stdlib-tool", "simctl"]]))
        lines.append('filegroup(name = "swift_interop_headers", srcs = %s)' % repr([file for file in component_files["toolchain"] if file.startswith("toolchain/include/swift/")]))
        lines.append('exports_files(["toolchain/include/swift/bridging"])')
        lines.append("exports_files(%s)" % repr([sdk["tools"][name] for name in ["install_name_tool", "otool", "plutil"]]))
        lines.insert(0, 'load(%s, "declared_xcode_swift_toolchain")' % repr(str(ctx.attr.swift_profile)))
        prefix = "external/" + ctx.name + "/"
        runtime_prefix = str(ctx.path(".")) + "/"
        tools = {":" + sdk["tools"][mode]: mode for mode in ["swiftc", "swift-symbolgraph-extract", "swift-synthesize-interface"]}
        lines.append('filegroup(name = "swift_test_runtime", srcs = %s)' % repr(["receipt.json"] + apple_swift_test_runtime_files(component_files)))
        for name, selected_sdk, target_triple in [
            ("swift", "macosx", "arm64-apple-macosx" + sdk["deploymentTargets"]["package_macos"]),
            ("swift_native", "macosx", "arm64-apple-macosx" + sdk["deploymentTargets"]["native_macos"]),
            ("swift_ios", "iphoneos", "arm64-apple-ios" + sdk["deploymentTargets"]["ios"]),
            ("swift_ios_simulator", "iphonesimulator", "arm64-apple-ios" + sdk["deploymentTargets"]["ios"] + "-simulator"),
        ]:
            inputs = [":receipt.json", ":toolchain_files", ":sdk_" + selected_sdk + "_files", ":platform_" + selected_sdk + "/Library_files", ":platform_" + selected_sdk + "/usr/lib_files", ":tools/xcrun_files"]
            lines.append('declared_xcode_swift_toolchain(name = %s, sdk = %s, tools = %s, sdkroot = %s, sdk_name = %s, resource_directory = %s, prefix = %s, runtime_prefix = %s, target_triple = %s)' % (repr(name), repr(inputs), repr(tools), repr(prefix + "sdk_" + selected_sdk), repr(selected_sdk), repr(prefix + "toolchain/lib/swift"), repr(prefix), repr(runtime_prefix), repr(target_triple)))
    ctx.file("BUILD.bazel", "\n".join(lines) + "\n")
    return ctx.repo_metadata(reproducible = False)

_host_sdk_repository = repository_rule(
    implementation = _host_sdk_impl,
    configure = True,
    attrs = {
        "family": attr.string(mandatory = True, values = ["apple", "msvc"]),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "policy": attr.label(default = Label("//tools/dev:native-host-toolchains.json"), allow_single_file = True),
        "compatibility": attr.label(default = Label("//tools/release:platform-compatibility-policy.mts"), allow_single_file = True),
        "collector": attr.label(default = Label("//build_defs/host:host-sdk.mts"), allow_single_file = True),
        "deployment_policy": attr.label(default = Label("//build_defs/host:deployment-policy.mts"), allow_single_file = True),
        "cc_profiles": attr.label(default = Label("//build_defs/host:cc-profiles.bzl"), allow_single_file = True),
        "swift_profile": attr.label(default = Label("//build_defs/host:swift-profile.bzl"), allow_single_file = True),
        "app_tools_profile": attr.label(default = Label("//build_defs/host:app-tool-inputs.bzl"), allow_single_file = True),
        "_vc_runtime_contract": attr.label(default = Label("//:tools/packaging/windows-vc-runtime-closure.mts"), allow_single_file = True),
        "_vc_runtime_policy": attr.label(default = Label("//:tools/packaging/windows-vc-runtime-policy.json"), allow_single_file = True),
        "_app_tools": attr.label(default = Label("//build_defs/host:apple-app-tools.mts"), allow_single_file = True),
        "_wrapped_clang": attr.label(default = Label("@apple_support//crosstool:wrapped_clang.cc"), allow_single_file = True),
        "_libtool": attr.label(default = Label("@apple_support//crosstool:libtool.cc"), allow_single_file = True),
        "_driver_patch": attr.label(default = Label("//build_defs/host:declared-apple-drivers.patch"), allow_single_file = True),
    },
    environ = ["DEVELOPER_DIR", "TOOLCHAINS", "VSCMD_VER", "VSCMD_ARG_HOST_ARCH", "VSCMD_ARG_TGT_ARCH", "VCToolsInstallDir", "VCToolsVersion", "VCToolsRedistDir", "WindowsSdkDir", "WindowsSDKVersion", "TEMP", "TMP"],
)

def _host_toolchains_impl(ctx):
    lines = ['package(default_visibility = ["//visibility:public"])']
    for name, repository, compiler, os, cpu, extra, kind in [
        ("msvc_x64", "native_msvc_sdk", "cc_compiler", "windows", "x86_64", [], "@bazel_tools//tools/cpp:toolchain_type"),
        ("apple_macos_package", "native_apple_sdk", "cc_package", "macos", "aarch64", [str(ctx.attr.apple_package)], "@bazel_tools//tools/cpp:toolchain_type"),
        ("apple_macos_runtime", "native_apple_sdk", "cc_native", "macos", "aarch64", [], "@bazel_tools//tools/cpp:toolchain_type"),
        ("apple_swift_package", "native_apple_sdk", "swift", "macos", "aarch64", [str(ctx.attr.apple_package)], str(ctx.attr.swift_type)),
        ("apple_swift_runtime", "native_apple_sdk", "swift_native", "macos", "aarch64", [], str(ctx.attr.swift_type)),
        ("apple_swift_ios", "native_apple_sdk", "swift_ios", "ios", "aarch64", [str(ctx.attr.apple_device)], str(ctx.attr.swift_type)),
        ("apple_swift_ios_simulator", "native_apple_sdk", "swift_ios_simulator", "ios", "aarch64", [str(ctx.attr.apple_simulator)], str(ctx.attr.swift_type)),
        ("apple_ios", "native_apple_sdk", "cc_ios", "ios", "aarch64", [str(ctx.attr.apple_device)], "@bazel_tools//tools/cpp:toolchain_type"),
        ("apple_ios_simulator", "native_apple_sdk", "cc_ios_simulator", "ios", "aarch64", [str(ctx.attr.apple_simulator)], "@bazel_tools//tools/cpp:toolchain_type"),
    ]:
        constraints = ["@platforms//os:" + os, "@platforms//cpu:" + cpu]
        execution = ["@platforms//os:macos", "@platforms//cpu:aarch64"] if os == "ios" else constraints
        lines.append("toolchain(name = %s, toolchain = %s, toolchain_type = %s, exec_compatible_with = %s, target_compatible_with = %s)" % (repr(name), repr("@" + repository + "//:" + compiler), repr(kind), repr(execution), repr(constraints + extra)))
    ctx.file("BUILD.bazel", "\n".join(lines) + "\n")
    return ctx.repo_metadata(reproducible = True)

_host_toolchains_repository = repository_rule(
    implementation = _host_toolchains_impl,
    attrs = {
        "apple_package": attr.label(default = Label("//build_defs/host:apple_package")),
        "swift_type": attr.label(default = Label("@rules_swift//toolchains:toolchain_type")),
        "apple_device": attr.label(default = Label("@apple_support//constraints:device")),
        "apple_simulator": attr.label(default = Label("@apple_support//constraints:simulator")),
    },
)

def _native_host_toolchains_impl(ctx):
    _host_sdk_repository(name = "native_apple_sdk", family = "apple")
    _host_sdk_repository(name = "native_msvc_sdk", family = "msvc")
    _host_toolchains_repository(name = "native_host_toolchains")
    return ctx.extension_metadata(root_module_direct_deps = ["native_host_toolchains", "native_apple_sdk", "native_msvc_sdk"], root_module_direct_dev_deps = [], reproducible = True)

native_host_toolchains = module_extension(implementation = _native_host_toolchains_impl)
