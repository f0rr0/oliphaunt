"""Installed SwiftPM consumer on the licensed, declared native Xcode profile."""

load("@oliphaunt_toolchain_metadata//:apple-platforms.bzl", "APPLE_DEPLOYMENT_TARGETS")
load("//build_defs/extensions:final_leaf.bzl", "NativeAppleBaseInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/native/carriers:defs.bzl", "native_payload_helpers")

_SWIFT_TOOLCHAIN = "@rules_swift//toolchains:toolchain_type"

def _consumer_impl(ctx):
    base = ctx.attr.native_base[NativeAppleBaseInfo]
    framework = [file for file in base.archive_files if file.path == base.archives["base-xcframework"]["path"]][0]
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
    receipts = [file for file in tools if file.basename == "receipt.json"]
    if len(receipts) != 1:
        fail("Installed Swift consumer requires one exact host SDK receipt")
    inputs = [ctx.file.archive, framework, ctx.file.bindings, ctx.file.consumer]
    arguments = inputs + selected + [sdk_files[0], receipts[0], "arm64-apple-macosx%s" % APPLE_DEPLOYMENT_TARGETS["package_macos"], ctx.file.source_tree, ctx.file.source_tree.path]
    inputs.append(ctx.file.source_tree)
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments, tools + inputs + ctx.files._helpers, source_files = [ctx.file._runner] + ctx.files._helpers)

_swift_package_consumer_test = rule(
    implementation = _consumer_impl,
    test = True,
    toolchains = [_SWIFT_TOOLCHAIN] + BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "archive": attr.label(mandatory = True, allow_single_file = [".zip"]),
        "source_tree": attr.label(mandatory = True, allow_single_file = True),
        "native_base": attr.label(default = Label("//src/native/sdks/swift:source_package_native_requirement"), providers = [NativeAppleBaseInfo]),
        "bindings": attr.label(mandatory = True, allow_single_file = [".zip"]),
        "consumer": attr.label(mandatory = True, allow_single_file = [".swift"]),
        "_runner": attr.label(default = Label("//build_defs/languages/swift:consumer-test.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = [Label(value) for value in [
            "//src/native/sdks/swift:tools/prepare-swift-release-consumer.mts",
            "//build_defs/native/apple:swift-candidate-contract.mts",
            "//build_defs/native/carriers:payload.mts",
            "//build_defs/languages/swift:source-delivery-contract.mts",
            "//tools/release:native-file-identity.mts",
        ] + native_payload_helpers()], allow_files = True),
    }),
)

def swift_package_consumer_test(name, args = [], **kwargs):
    _swift_package_consumer_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)
