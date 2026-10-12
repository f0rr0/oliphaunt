"""Installed current-core C ABI and generated static-extension registration."""

load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS")
load("@oliphaunt_toolchain_metadata//:apple-platforms.bzl", "APPLE_DEPLOYMENT_TARGETS")
load("//build_defs/extensions:contrib_carriers.bzl", "native_contrib_carrier_legal")
load("//build_defs/extensions:final_leaf.bzl", "ExtensionFinalLeafInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

_SWIFT_TOOLCHAIN = "@rules_swift//toolchains:toolchain_type"

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _consumer_impl(ctx):
    info = ctx.toolchains[_SWIFT_TOOLCHAIN].swift_toolchain
    tools = depset(transitive = [depset(config.additional_tools) for config in info.tool_configs.values()]).to_list()
    selected = {}
    for mode in ["clang", "clang++"]:
        files = [file for file in tools if file.short_path.endswith("/toolchain/bin/" + mode)]
        if len(files) != 1:
            fail("Packaged Apple C consumer requires exactly one declared Xcode " + mode)
        selected[mode] = files[0]
    sdk_files = [file for file in tools if "/sdk_macosx/" in file.short_path]
    receipts = [file for file in tools if file.basename == "receipt.json"]
    if not sdk_files or len(receipts) != 1:
        fail("Packaged Apple C consumer requires one declared macOS SDK and receipt")

    version = PRODUCTS["liboliphaunt-native"]["version"]
    inputs = [ctx.file.base, ctx.file.ios_resources, ctx.file.macos_resources, ctx.file.base_manifest, ctx.file.owner_catalog]
    leaves = []
    if len(ctx.attr.leaves) != 1 or not ctx.attr.extensions:
        fail("Current-core registration qualification requires one contrib carrier and nonempty selected members")
    for target in ctx.attr.leaves:
        leaf = target[ExtensionFinalLeafInfo]
        if leaf.product != "oliphaunt-extension-contrib-pg18" or leaf.family != "native" or leaf.target != "ios-xcframework" or leaf.metadata["runtimeVersion"] != version:
            fail("Packaged Apple registration requires actual iOS final leaves with the selected current core version")
        inputs += leaf.github + [leaf.frozen]
        leaves.append({"product": leaf.product, "owner": leaf.owner, "version": leaf.version,
                       "runtimeVersion": leaf.metadata["runtimeVersion"], "sqlNames": sorted([member["sqlName"] for member in leaf.metadata["members"]]),
                       "github": [_runfile(ctx, file) for file in leaf.github], "frozen": _runfile(ctx, leaf.frozen)})
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "version": version, "basePackageVersion": PRODUCTS["oliphaunt-swift"]["version"],
        "base": _runfile(ctx, ctx.file.base), "iosResources": _runfile(ctx, ctx.file.ios_resources),
        "macosResources": _runfile(ctx, ctx.file.macos_resources), "baseManifest": _runfile(ctx, ctx.file.base_manifest),
        "ownerCatalog": _runfile(ctx, ctx.file.owner_catalog), "leaves": leaves, "extensions": ctx.attr.extensions,
        "clang": _runfile(ctx, selected["clang"]), "clangxx": _runfile(ctx, selected["clang++"]),
        "sdkFile": _runfile(ctx, sdk_files[0]), "receipt": _runfile(ctx, receipts[0]),
        "triple": "arm64-apple-macosx" + APPLE_DEPLOYMENT_TARGETS["package_macos"],
    }) + "\n")
    return bun_test_entrypoint(ctx, ctx.file._runner, [spec], tools + inputs + [spec] + ctx.files._helpers,
                               source_files = [ctx.file._runner] + ctx.files._helpers, runfiles_argument = True)

_consumer_test = rule(
    implementation = _consumer_impl,
    test = True,
    toolchains = [_SWIFT_TOOLCHAIN] + BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "base": attr.label(mandatory = True, allow_single_file = [".zip"]),
        "ios_resources": attr.label(mandatory = True, allow_single_file = [".tar.gz"]),
        "macos_resources": attr.label(mandatory = True, allow_single_file = [".tar.gz"]),
        "base_manifest": attr.label(mandatory = True, allow_single_file = [".json"]),
        "leaves": attr.label_list(mandatory = True, providers = [ExtensionFinalLeafInfo]),
        "extensions": attr.string_list(mandatory = True),
        "owner_catalog": attr.label(default = "//src/extensions/generated/sdk:extensions.json", allow_single_file = [".json"]),
        "_runner": attr.label(default = "//build_defs/native/apple:static-carrier-consumer.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ["//build_defs/native/apple:framework_helpers", "//src/native/sdks/swift:generator_sources"] + native_contrib_carrier_legal(), allow_files = True),
    }),
)

def apple_static_carrier_consumer_test(name, args = [], **kwargs):
    _consumer_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)
