"""Installed SwiftPM consumer on the licensed, declared native Xcode profile."""

load("@oliphaunt_toolchain_metadata//:apple-platforms.bzl", "APPLE_DEPLOYMENT_TARGETS")
load("//build_defs/foundation:bun-toolchain.bzl", "BUN_TOOLCHAIN_TYPE")

_SWIFT_TOOLCHAIN = "@rules_swift//toolchains:toolchain_type"

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _consumer_impl(ctx):
    info = ctx.toolchains[_SWIFT_TOOLCHAIN].swift_toolchain
    tools = depset(transitive = [depset(config.additional_tools) for config in info.tool_configs.values()]).to_list()
    selected = []
    for mode in ["swift", "swiftc", "clang", "clang++"]:
        files = [file for file in tools if file.short_path.endswith("/toolchain/bin/" + mode)]
        if len(files) != 1:
            fail("Installed Swift consumer requires exactly one declared Xcode " + mode)
        selected.append(files[0])
    sdk_files = [file for file in tools if "/sdk_macosx/" in file.short_path]
    if not sdk_files:
        fail("Installed Swift consumer requires a declared macOS SDK")
    sdk = _runfile(ctx, sdk_files[0]).split("/sdk_macosx/")[0] + "/sdk_macosx"
    receipts = [file for file in tools if file.basename == "receipt.json"]
    if len(receipts) != 1:
        fail("Installed Swift consumer requires one exact host SDK receipt")
    bun = ctx.toolchains[BUN_TOOLCHAIN_TYPE].bun
    inputs = [ctx.file.archive, ctx.file.base, ctx.file.bindings, ctx.file.resources, ctx.file.consumer]
    arguments = ['"$runfiles_dir/%s"' % _runfile(ctx, file) for file in [ctx.file._runner] + inputs + selected]
    arguments += ['"$runfiles_dir/%s"' % sdk, '"$runfiles_dir/%s"' % _runfile(ctx, receipts[0]), '"arm64-apple-macosx%s"' % APPLE_DEPLOYMENT_TARGETS["package_macos"]]
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(launcher, """#!/usr/bin/env bash
set -euo pipefail
runfiles_dir="$(cd "${RUNFILES_DIR:-${TEST_SRCDIR:-$0.runfiles}}" && pwd)"
exec "$runfiles_dir/%s" %s
""" % (_runfile(ctx, bun), " ".join(arguments)), is_executable = True)
    return [DefaultInfo(executable = launcher, runfiles = ctx.runfiles(files = tools + inputs + [bun, ctx.file._runner] + ctx.files._helpers))]

swift_package_consumer_test = rule(
    implementation = _consumer_impl,
    test = True,
    toolchains = [_SWIFT_TOOLCHAIN, BUN_TOOLCHAIN_TYPE],
    attrs = {
        "archive": attr.label(mandatory = True, allow_single_file = [".zip"]),
        "base": attr.label(default = Label("@swift_frozen_native//:xcframework_archive"), allow_single_file = [".zip"]),
        "resources": attr.label(default = Label("@swift_frozen_native//:runtime_resources_archive"), allow_single_file = [".tar.gz"]),
        "bindings": attr.label(mandatory = True, allow_single_file = [".zip"]),
        "consumer": attr.label(mandatory = True, allow_single_file = [".swift"]),
        "_runner": attr.label(default = Label("//build_defs/languages/swift:consumer-test.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = [Label("//src/native/sdks/swift:tools/prepare-swift-release-consumer.mts"), Label("//:tools/packaging/portable-archive.mts")], allow_files = True),
    },
)
