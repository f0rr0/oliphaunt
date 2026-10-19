"""Maintained Android Clang configuration, declared SDK files and runtime ABI."""

load("@rules_android_ndk//:ndk_cc_toolchain_config.bzl", "ndk_cc_toolchain_config")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc:cc_toolchain_config_lib.bzl", "feature", "flag_group", "flag_set")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/toolchains:cc_toolchain_config_info.bzl", "CcToolchainConfigInfo")
load("@rules_android//rules:android_split_transition.bzl", "android_split_transition")
load(":configuration.bzl", "android_native_inputs")

def _android_cc_config_impl(ctx):
    # This is a qualification bound, not a second version authority. An SDK or
    # minimum-API update must review the independently proven Bionic PG profile.
    if ctx.attr.revision != "27.0.12077973" or ctx.attr.api != 24 or ctx.attr.page_alignment != 16384:
        fail("Native Android runtime configuration is qualified only for NDK 27.0.12077973 / API 24 / 16 KiB ELF pages; review the Bionic PostgreSQL profile and ABI checks before updating the canonical SDK/platform policy")
    prefix = ctx.attr.prefix
    config = ndk_cc_toolchain_config(
        api_level = ctx.attr.api,
        target_system_name = ctx.attr.triple,
        tools = {name: prefix + "/bin/" + binary for name, binary in {
            "clang": "clang",
            "gcc": "clang",
            "cpp": "clang++",
            "ar": "llvm-ar",
            "dwp": "llvm-dwp",
            "gcov": "llvm-cov",
            "ld": "ld.lld",
            "nm": "llvm-nm",
            "objcopy": "llvm-objcopy",
            "objdump": "llvm-objdump",
            "strip": "llvm-strip",
        }.items()},
        cxx_builtin_include_directories = [
            prefix + "/sysroot/usr/include/c++/v1",
            prefix + "/sysroot/usr/include/" + ctx.attr.triple,
            prefix + "/sysroot/usr/include",
            prefix + "/lib/clang/" + ctx.attr.resource + "/include",
        ],
        builtin_sysroot = prefix + "/sysroot",
        toolchain_identifier = "oliphaunt-ndk-" + ctx.attr.revision + "-" + ctx.attr.triple,
        host_system_name = "x86_64-unknown-linux-gnu",
        target_cpu = ctx.attr.cpu,
        target_libc = "bionic",
        compiler = "clang",
        abi_version = ctx.attr.triple,
        abi_libc_version = str(ctx.attr.api),
        cc_target_os = "android",
    )
    # rules_android_ndk enables static C++ runtimes. Its legacy arm64 linker
    # flags still select 4 KiB; this final feature sets our 16 KiB runtime ABI.
    config["features"] += [feature(
        name = "android_runtime_page_alignment",
        enabled = True,
        flag_sets = [flag_set(
            actions = [ACTION_NAMES.cpp_link_executable, ACTION_NAMES.cpp_link_dynamic_library, ACTION_NAMES.cpp_link_nodeps_dynamic_library],
            flag_groups = [flag_group(flags = ["-Wl,-z,max-page-size=" + str(ctx.attr.page_alignment), "-Wl,-z,common-page-size=" + str(ctx.attr.page_alignment)])],
        )],
    )]
    return [cc_common.create_cc_toolchain_config_info(ctx = ctx, **config)]

android_cc_config = rule(
    implementation = _android_cc_config_impl,
    attrs = {
        "prefix": attr.string(mandatory = True),
        "resource": attr.string(mandatory = True),
        "revision": attr.string(mandatory = True),
        "api": attr.int(mandatory = True),
        "page_alignment": attr.int(mandatory = True),
        "triple": attr.string(mandatory = True, values = ["aarch64-linux-android", "x86_64-linux-android"]),
        "cpu": attr.string(mandatory = True),
    },
    provides = [CcToolchainConfigInfo],
)

def _android_artifact_impl(ctx):
    files = ctx.attr.artifact[0][DefaultInfo].files
    if ctx.attr.output:
        physical = files.to_list()
        if len(physical) != 1:
            fail("A named Android configuration artifact must have exactly one output")
        output = ctx.actions.declare_file(ctx.attr.output)
        ctx.actions.symlink(output = output, target_file = physical[0])
        files = depset([output])
    return [DefaultInfo(files = files)]

android_artifact = rule(
    implementation = _android_artifact_impl,
    cfg = android_native_inputs,
    attrs = {
        "artifact": attr.label(mandatory = True, cfg = android_split_transition),
        "platform": attr.label(mandatory = True),
        "output": attr.string(default = ""),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)
