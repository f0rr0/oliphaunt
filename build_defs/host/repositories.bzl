"""Lazy native-host SDK profiles; incompatible client hosts fail acquisition."""

load(":sdk-tree.bzl", "watch_sdk_directory")

def _host_sdk_impl(ctx):
    expected_os = "mac os x" if ctx.attr.family == "apple" else "windows"
    if not ctx.os.name.lower().startswith(expected_os):
        fail("The %s SDK profile requires its native %s client host; no cross-host SDK acquisition is declared." % (ctx.attr.family, expected_os))
    for source in [ctx.attr.collector, ctx.attr.policy, ctx.attr.compatibility, ctx.attr.deployment_policy, ctx.attr._vc_runtime_contract, ctx.attr._vc_runtime_policy]:
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
            component_files[component["name"]] = [component["name"] + "/" + relative for relative in watch_sdk_directory(ctx, source)]
        else:
            ctx.watch(source)
            component_files[component["name"]] = [component["name"]]
        ctx.symlink(source, component["name"])
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
    if ctx.attr.family == "msvc":
        lines.append("exports_files(%s)" % repr([sdk["tools"]["dumpbin"], sdk["tools"]["rc"]]))
        lines.append('filegroup(name = "runtime_dlls", srcs = %s)' % repr(sdk["runtimeDlls"]))
    lines.append("host_cc_profiles(HOST_SDK)")
    if ctx.attr.family == "apple":
        lines.insert(0, 'load(%s, "declared_xcode_swift_toolchain")' % repr(str(ctx.attr.swift_profile)))
        prefix = "external/" + ctx.name + "/"
        tools = {":" + sdk["tools"][mode]: mode for mode in ["swiftc", "swift-symbolgraph-extract", "swift-synthesize-interface"]}
        lines.append('declared_xcode_swift_toolchain(name = "swift", sdk = [":receipt.json", ":toolchain_files", ":sdk_macosx_files", ":platform_macosx/Library_files", ":platform_macosx/usr/lib_files", ":tools/xcrun_files"], tools = %s, sdkroot = %s, resource_directory = %s, prefix = %s, target_triple = %s)' % (repr(tools), repr(prefix + "sdk_macosx"), repr(prefix + "toolchain/lib/swift"), repr(prefix), repr("arm64-apple-macosx" + sdk["deploymentTargets"]["package_macos"])))
    ctx.file("BUILD.bazel", "\n".join(lines) + "\n")
    return ctx.repo_metadata(reproducible = False)

_host_sdk_repository = repository_rule(
    implementation = _host_sdk_impl,
    configure = True,
    attrs = {
        "family": attr.string(mandatory = True, values = ["apple", "msvc"]),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "policy": attr.label(default = Label("//:tools/dev/native-host-toolchains.json"), allow_single_file = True),
        "compatibility": attr.label(default = Label("//tools/release:platform-compatibility-policy.mts"), allow_single_file = True),
        "collector": attr.label(default = Label("//build_defs/host:host-sdk.mts"), allow_single_file = True),
        "deployment_policy": attr.label(default = Label("//build_defs/host:deployment-policy.mts"), allow_single_file = True),
        "cc_profiles": attr.label(default = Label("//build_defs/host:cc-profiles.bzl"), allow_single_file = True),
        "swift_profile": attr.label(default = Label("//build_defs/host:swift-profile.bzl"), allow_single_file = True),
        "_vc_runtime_contract": attr.label(default = Label("//:tools/packaging/windows-vc-runtime-closure.mts"), allow_single_file = True),
        "_vc_runtime_policy": attr.label(default = Label("//:tools/packaging/windows-vc-runtime-policy.json"), allow_single_file = True),
        "_wrapped_clang": attr.label(default = Label("@apple_support//crosstool:wrapped_clang.cc"), allow_single_file = True),
        "_libtool": attr.label(default = Label("@apple_support//crosstool:libtool.cc"), allow_single_file = True),
        "_driver_patch": attr.label(default = Label("//build_defs/host:declared-apple-drivers.patch"), allow_single_file = True),
    },
    environ = ["DEVELOPER_DIR", "TOOLCHAINS", "VSCMD_VER", "VSCMD_ARG_HOST_ARCH", "VSCMD_ARG_TGT_ARCH", "VCToolsInstallDir", "VCToolsVersion", "VCToolsRedistDir", "WindowsSdkDir", "WindowsSDKVersion", "TEMP", "TMP", "ImageOS", "ImageVersion"],
)

def _host_toolchains_impl(ctx):
    lines = ['package(default_visibility = ["//visibility:public"])']
    for name, repository, compiler, os, cpu, extra, kind in [
        ("msvc_x64", "native_msvc_sdk", "cc_compiler", "windows", "x86_64", [], "@bazel_tools//tools/cpp:toolchain_type"),
        ("apple_macos_package", "native_apple_sdk", "cc_package", "macos", "aarch64", [str(ctx.attr.apple_package)], "@bazel_tools//tools/cpp:toolchain_type"),
        ("apple_macos_runtime", "native_apple_sdk", "cc_native", "macos", "aarch64", [], "@bazel_tools//tools/cpp:toolchain_type"),
        ("apple_swift_package", "native_apple_sdk", "swift", "macos", "aarch64", [str(ctx.attr.apple_package)], str(ctx.attr.swift_type)),
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
