"""Native iOS archives and the public dynamic Apple framework construction."""

load("@oliphaunt_metadata//:metadata.bzl", "NATIVE_RUNTIME_ARTIFACTS", "PRODUCTS")
load("@oliphaunt_toolchain_metadata//:apple-platforms.bzl", "APPLE_DEPLOYMENT_TARGETS")
load("@rules_apple//apple:apple.bzl", "apple_xcframework")
load("@rules_cc//cc:cc_static_library.bzl", "cc_static_library")
load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_import", "cc_library")
load("//build_defs/apple:slices.bzl", "apple_slice_filegroup", "apple_slice_groups")
load("//build_defs/foundation:bun.bzl", "BunScriptInfo", "bun_action", "bun_script_test")
load("//build_defs/native:platform_config.bzl", "NATIVE_BUILTIN_PLPGSQL_DEPS", "NATIVE_BUILTIN_SNOWBALL_DEPS", "NATIVE_LINKOPTS")
load("//build_defs/native/carriers:defs.bzl", "native_carrier_legal_inputs")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "shipping_suppliers")

_MAC = ["@platforms//os:macos", "@platforms//cpu:aarch64"]
_MACOS_PROFILE = "@apple_support//platforms:macos_arm64_platform"

def _package_platform_impl(settings, attr):
    return {_MACOS_PROFILE: str(Label("//build_defs/host:apple_package_macos_arm64"))}

_package_platform = transition(implementation = _package_platform_impl, inputs = [], outputs = [_MACOS_PROFILE])

def _macos_impl(settings, attr):
    return {"//command_line_option:platforms": [str(Label("//build_defs/host:apple_package_macos_arm64"))]}

def _device_impl(settings, attr):
    return {"//command_line_option:platforms": [str(Label("//build_defs/host:ios_device_arm64"))]}

def _simulator_impl(settings, attr):
    return {"//command_line_option:platforms": [str(Label("//build_defs/host:ios_simulator_arm64"))]}

_macos = transition(implementation = _macos_impl, inputs = [], outputs = ["//command_line_option:platforms"])
_device = transition(implementation = _device_impl, inputs = [], outputs = ["//command_line_option:platforms"])
_simulator = transition(implementation = _simulator_impl, inputs = [], outputs = ["//command_line_option:platforms"])

def _infoplist_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".plist")
    ctx.actions.write(output, """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>%s</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
""" % PRODUCTS["liboliphaunt-native"]["version"])
    return [DefaultInfo(files = depset([output]))]

_infoplist = rule(implementation = _infoplist_impl)

def _archive_impl(ctx):
    archive = ctx.attr.archive[0]
    return [archive[DefaultInfo], OutputGroupInfo(**apple_slice_groups([archive]))]

_framework_archive = rule(implementation = _archive_impl, attrs = {
    "archive": attr.label(mandatory = True, cfg = _package_platform),
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
})

def _source_map(targets, inputs):
    result = {}
    for target, relative in targets.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("Apple carrier source must resolve to one declared File: " + str(target.label))
        result[relative] = files[0].path
        inputs.append(files[0])
    return result

def _release_assets_impl(ctx):
    inputs = [ctx.file.intermediate, ctx.file.public_header]
    payload = ctx.attr.payload[0][DefaultInfo].files.to_list()
    if len(payload) != 1 or not payload[0].is_directory:
        fail("Apple resources require one declared native public payload tree")
    inputs += payload
    headers, receipt_paths, receipt_outputs = {}, {}, {}
    common = _source_map(ctx.attr.abi_headers, inputs)
    for target, attribute in [
        ("macos-arm64", "macos_configuration"),
        ("ios-arm64", "device_configuration"),
        ("ios-arm64-simulator", "simulator_configuration"),
    ]:
        configuration = getattr(ctx.files, attribute)
        configs = [file for file in configuration if file.basename == "pg_config.h"]
        if len(configs) != 1:
            fail("Apple ABI admission requires the actual single configured pg_config.h for " + target)
        headers[target] = common | {"src/include/pg_config.h": configs[0].path}
        inputs += configuration
        receipt = ctx.actions.declare_file(ctx.label.name + "/" + target + ".properties")
        receipt_paths[target] = receipt.path
        receipt_outputs[target] = receipt
    outputs = {name: ctx.actions.declare_file(ctx.attr.asset_names[name]) for name in ["archive", "swiftpm", "resources", "macos_resources", "checksums"]}
    outputs["ios_manifest"] = ctx.actions.declare_file(ctx.label.name + "/ios.json")
    tools = {"nm": ctx.file._nm.path, "otool": ctx.file._otool.path, "strip": ctx.file._strip.path,
             "install_name_tool": ctx.file._install_name_tool.path, "plutil": ctx.file._plutil.path}
    inputs += ctx.files._sdk_runtime + [ctx.file._nm, ctx.file._otool, ctx.file._strip, ctx.file._install_name_tool, ctx.file._plutil]
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "version": PRODUCTS["liboliphaunt-native"]["version"],
        "intermediate": ctx.file.intermediate.path,
        "payload": payload[0].path,
        "publicHeader": ctx.file.public_header.path,
        "headers": headers,
        "receipts": receipt_paths,
        "tools": tools,
        "formatter": ctx.executable._formatter.path,
        "notices": _source_map(ctx.attr.notices, inputs),
    } | {name: file.path for name, file in outputs.items()}) + "\n")
    bun_action(ctx, ctx.attr._tool, arguments = [specification.path],
               inputs = inputs + [specification], tools = [ctx.attr._formatter[DefaultInfo].files_to_run],
               outputs = outputs.values() + receipt_outputs.values(), execution_requirements = {"no-remote": "1"}, mnemonic = "NativeAppleRuntimeEnvelope")
    groups = apple_slice_groups([ctx.attr.intermediate]) | {name: depset([file]) for name, file in outputs.items()}
    for name, target in [("macos_abi", "macos-arm64"), ("ios_device_abi", "ios-arm64"), ("ios_simulator_abi", "ios-arm64-simulator")]:
        groups[name] = depset([receipt_outputs[target]])
    return [DefaultInfo(files = depset(outputs.values())), OutputGroupInfo(**groups)]

_release_assets = rule(implementation = _release_assets_impl, attrs = {
    "intermediate": attr.label(mandatory = True, allow_single_file = [".zip"]),
    "payload": attr.label(default = "//src/native/runtime:public_payload", cfg = _macos),
    "public_header": attr.label(default = "//src/native/runtime:include/oliphaunt.h", allow_single_file = True),
    "macos_configuration": attr.label(default = "@postgres//:configuration", cfg = _macos, allow_files = True),
    "device_configuration": attr.label(default = "@postgres//:configuration", cfg = _device, allow_files = True),
    "simulator_configuration": attr.label(default = "@postgres//:configuration", cfg = _simulator, allow_files = True),
    "abi_headers": attr.label_keyed_string_dict(default = {
        Label("@postgres//:src/include/pg_config_manual.h"): "src/include/pg_config_manual.h",
        Label("@postgres//:src/include/catalog/catversion.h"): "src/include/catalog/catversion.h",
        Label("@postgres//:src/include/catalog/pg_control.h"): "src/include/catalog/pg_control.h",
    }, allow_files = True),
    "notices": attr.label_keyed_string_dict(allow_files = True),
    "asset_names": attr.string_dict(mandatory = True),
    "_formatter": attr.label(default = "//src/native/runtime/packaging:resources", executable = True, cfg = "exec"),
    "_tool": attr.label(default = "//build_defs/native/apple:framework_envelope", providers = [BunScriptInfo], cfg = "exec"),
    "_nm": attr.label(default = "@native_apple_sdk//:tools/nm_files", allow_single_file = True, cfg = "exec"),
    "_strip": attr.label(default = "@native_apple_sdk//:tools/strip_files", allow_single_file = True, cfg = "exec"),
    "_otool": attr.label(default = "@native_apple_sdk//:tools/otool", allow_single_file = True, cfg = "exec"),
    "_plutil": attr.label(default = "@native_apple_sdk//:tools/plutil", allow_single_file = True, cfg = "exec"),
    "_install_name_tool": attr.label(default = "@native_apple_sdk//:tools/install_name_tool", allow_single_file = True, cfg = "exec"),
    "_sdk_runtime": attr.label(default = "@native_apple_sdk//:toolchain_files", cfg = "exec"),
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
})

def native_apple_runtime_targets(qualification):
    """Build the same dynamic device, simulator and macOS public framework."""
    _infoplist(name = "apple_framework_info")
    apple_xcframework(
        name = "apple_xcframework_raw",
        bundle_name = "liboliphaunt",
        bundle_id = "dev.oliphaunt.liboliphaunt",
        deps = [":wrapper", "@postgres//:backend_embedded", "@postgres//:main_embedded"] + NATIVE_BUILTIN_PLPGSQL_DEPS + NATIVE_BUILTIN_SNOWBALL_DEPS,
        linkopts = NATIVE_LINKOPTS,
        public_hdrs = native.glob(["include/*.h"]),
        umbrella_header = "include/oliphaunt.h",
        infoplists = [":apple_framework_info"],
        ios = {"device": ["arm64"], "simulator": ["arm64"]},
        macos = ["arm64"],
        families_required = {"ios": ["iphone"]},
        minimum_os_versions = {"macos": APPLE_DEPLOYMENT_TARGETS["package_macos"], "ios": APPLE_DEPLOYMENT_TARGETS["ios"]},
        tags = ["no-remote"],
        target_compatible_with = _MAC,
        visibility = ["//visibility:private"],
    )
    _framework_archive(name = "apple_xcframework_intermediate", archive = ":apple_xcframework_raw", target_compatible_with = _MAC)
    version = PRODUCTS["liboliphaunt-native"]["version"]
    selected = {}
    for name, kind, target in [
        ("archive", "native-runtime", "ios-xcframework"),
        ("swiftpm", "apple-swiftpm-binary", "apple-spm-xcframework"),
        ("resources", "runtime-resources", "ios-datum64"),
    ]:
        rows = [row for row in NATIVE_RUNTIME_ARTIFACTS if row["product"] == "liboliphaunt-native" and row["kind"] == kind and row["target"] == target]
        if len(rows) != 1:
            fail("Apple native carrier must have one canonical artifact: " + kind + "/" + target)
        selected[name] = rows[0]
    _release_assets(name = "apple_release_assets", intermediate = ":apple_xcframework_intermediate",
                    asset_names = {name: row["asset"].replace("{version}", version) for name, row in selected.items()} | {
                        "checksums": "apple-release-assets.sha256",
                        "macos_resources": "apple-macos-runtime-resources.tar.gz",
                    },
                    notices = native_carrier_legal_inputs(), target_compatible_with = _MAC)
    shipping_suppliers(name = "apple_suppliers", inputs = [])
    packages = []
    for name, row in selected.items():
        apple_slice_filegroup(name = "apple_" + name, src = ":apple_release_assets", output_group = name, target_compatible_with = _MAC)
        shipping_package(name = "apple_" + name + "_shipping", owner = "@oliphaunt_metadata//:product_liboliphaunt-native", artifacts = [":apple_" + name],
                         ecosystem = "github", package_name = row["asset"].replace("{version}", version), configuration = row["target"], role = "github-release-asset", suppliers = ":apple_suppliers")
        packages.append(":apple_" + name + "_shipping")
    for name in ["ios_device_abi", "ios_simulator_abi", "macos_abi", "macos_resources", "checksums", "ios_manifest"]:
        apple_slice_filegroup(name = "apple_" + name, src = ":apple_release_assets", output_group = name, target_compatible_with = _MAC)
    shipping_package(name = "apple_ios_manifest_shipping", owner = "@oliphaunt_metadata//:product_liboliphaunt-native", artifacts = [":apple_ios_manifest"],
                     ecosystem = "internal", package_name = "ios.json", configuration = "ios-xcframework", role = "apple-base-ios-manifest-input", suppliers = ":apple_suppliers")
    packages.append(":apple_ios_manifest_shipping")
    bun_script_test(
        name = "apple_final_contract_test",
        entry_point = "//build_defs/native/apple:runtime-final.test.mts",
        args = ["$(location :apple_archive)", "$(location :apple_swiftpm)", "$(location :apple_resources)",
                "$(location :apple_checksums)", "$(location include/oliphaunt.h)",
                "$(location :apple_ios_manifest)", "$(location :apple_ios_device_abi)", "$(location :apple_ios_simulator_abi)", "$(location :apple_macos_abi)"],
        data = [":apple_archive", ":apple_swiftpm", ":apple_resources", ":apple_checksums", "include/oliphaunt.h",
                ":apple_ios_manifest", ":apple_ios_device_abi", ":apple_ios_simulator_abi", ":apple_macos_abi",
                "//build_defs/native/apple:framework-envelope.mts", "//build_defs/native/apple:framework_helpers",
                "//build_defs/resources:mobile_resource_contract.mts", "//build_defs/resources:helpers"],
        target_compatible_with = _MAC + ["//build_defs/host:apple_package"],
        size = "medium",
    )
    shipping_export(name = "apple_shipping_export", packages = packages, qualification = qualification, testonly = True, target_compatible_with = _MAC)

def native_ios_runtime_targets():
    """Declare one real archive and its conventional public CcInfo consumer."""
    compatible = ["@platforms//os:ios", "@platforms//cpu:aarch64", "@apple_support//constraints:apple"]
    cc_static_library(
        name = "mobile_static_archive",
        deps = [
            ":wrapper",
            "@postgres//:backend_embedded",
            "@postgres//:main_embedded",
            "@postgres//:plpgsql_embedded",
            "@postgres//:snowball_builtin",
        ],
        target_compatible_with = compatible,
    )
    cc_import(
        name = "mobile_static_import",
        static_library = ":mobile_static_archive",
        alwayslink = True,
        target_compatible_with = compatible,
    )
    cc_library(
        name = "mobile_static",
        deps = [":mobile_static_import"],
        hdrs = ["include/oliphaunt.h"],
        includes = ["include"],
        target_compatible_with = compatible,
    )
    # Compile and link every imported object against the selected SDK. This is
    # deliberately a binary target: it must never run on the macOS executor.
    cc_binary(
        name = "mobile_static_abi_consumer",
        srcs = ["smoke/liboliphaunt_abi_conformance.c"],
        deps = [":mobile_static"],
        copts = ["-std=c11", "-Wall", "-Wextra", "-Werror"],
        target_compatible_with = compatible,
    )
