"""Genuine target ABI receipts for separately admitted native seed domains."""

load("//build_defs/foundation:bun.bzl", "BunScriptInfo", "bun_action")
load("//build_defs/resources:resources.bzl", "NativeSeedInfo", "native_seed_envelopes")
load("//build_defs/release:shipping.bzl", "shipping_export")
load("@oliphaunt_metadata//:metadata.bzl", "DATABASE_RESOURCE_CONTRACT")

NativeAbiReceiptInfo = provider(fields = ["receipt", "runtime", "target"])

def _constraint(ctx, name):
    return ctx.target_platform_has_constraint(getattr(ctx.attr, name)[platform_common.ConstraintValueInfo])

def _target(ctx):
    arm64 = _constraint(ctx, "_arm64")
    x64 = _constraint(ctx, "_x64")
    if _constraint(ctx, "_android"):
        if arm64:
            return "android-arm64-v8a"
        if x64:
            return "android-x86_64"
    if _constraint(ctx, "_linux"):
        if arm64:
            return "linux-arm64-gnu"
        if x64:
            return "linux-x64-gnu"
    if _constraint(ctx, "_macos") and arm64:
        return "macos-arm64"
    if _constraint(ctx, "_windows") and x64:
        return "windows-x64-msvc"
    fail("No admitted PostgreSQL target configuration supplies this native seed ABI receipt")

def _native_abi_receipt_impl(ctx):
    target = _target(ctx)
    configurations = [file for file in ctx.files.configuration if file.basename == "pg_config.h"]
    if len(configurations) != 1:
        fail("Native seed ABI receipt needs one actual configured PostgreSQL header")
    headers = {"src/include/pg_config.h": configurations[0].path}
    for dependency, relative in ctx.attr.headers.items():
        files = dependency[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("Native seed ABI receipt header must name one actual source file")
        headers[relative] = files[0].path
    runtime = [file for file in ctx.files.runtime if file.basename in ["liboliphaunt.so", "liboliphaunt.dylib", "oliphaunt.dll"]]
    if len(runtime) != 1:
        fail("Native seed ABI receipt must consume the same configured compiled runtime")
    receipt = ctx.actions.declare_file(ctx.label.name + ".properties")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({"target": target, "runtime": runtime[0].path, "headers": headers, "output": receipt.path}) + "\n")
    arguments = ctx.actions.args()
    arguments.add(specification)
    bun_action(ctx, ctx.attr._tool, arguments = [arguments],
               inputs = [specification, runtime[0]] + ctx.files.configuration + ctx.files.headers,
               outputs = [receipt], mnemonic = "NativeSeedTargetAbi")
    return [DefaultInfo(files = depset([receipt])), NativeAbiReceiptInfo(receipt = receipt, runtime = runtime[0], target = target)]

native_abi_receipt = rule(
    implementation = _native_abi_receipt_impl,
    attrs = {
        "runtime": attr.label(default = "//src/native/runtime:runtime_shared", allow_files = True),
        "configuration": attr.label(default = "@postgres//:configuration", allow_files = True),
        "headers": attr.label_keyed_string_dict(default = {
            Label("@postgres//:src/include/pg_config_manual.h"): "src/include/pg_config_manual.h",
            Label("@postgres//:src/include/catalog/catversion.h"): "src/include/catalog/catversion.h",
            Label("@postgres//:src/include/catalog/pg_control.h"): "src/include/catalog/pg_control.h",
        }, allow_files = True),
        "_tool": attr.label(default = "//build_defs/resources:abi_receipt", providers = [BunScriptInfo], cfg = "exec"),
        "_android": attr.label(default = "@platforms//os:android"),
        "_linux": attr.label(default = "@platforms//os:linux"),
        "_macos": attr.label(default = "@platforms//os:macos"),
        "_windows": attr.label(default = "@platforms//os:windows"),
        "_arm64": attr.label(default = "@platforms//cpu:aarch64"),
        "_x64": attr.label(default = "@platforms//cpu:x86_64"),
    },
)

def _native_seed_domain_impl(ctx):
    producer = ctx.attr.producer[NativeSeedInfo]
    frozen = ctx.actions.declare_file(ctx.label.name + ".tar")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    receipts = ctx.files.receipts + [producer.abi]
    ctx.actions.write(specification, json.encode({
        "seed": producer.frozen.path,
        "producerTarget": producer.target,
        "profile": producer.profile,
        "domain": ctx.attr.domain,
        "receipts": [file.path for file in receipts],
        "icu": ctx.file.icu.path if ctx.file.icu else None,
        "output": frozen.path,
    }) + "\n")
    arguments = ctx.actions.args()
    arguments.add(specification)
    bun_action(ctx, ctx.attr._tool, arguments = [arguments],
               inputs = [specification, producer.frozen] + receipts + ([ctx.file.icu] if ctx.file.icu else []),
               outputs = [frozen], mnemonic = "NativeSeedDomainAdmission")
    return [DefaultInfo(files = depset([frozen, producer.abi])),
            NativeSeedInfo(frozen = frozen, abi = producer.abi, runtime = producer.runtime,
                           profile = producer.profile, target = ctx.attr.domain),
            OutputGroupInfo(frozen = depset([frozen]), abi = depset([producer.abi]))]

native_seed_domain = rule(
    implementation = _native_seed_domain_impl,
    attrs = {
        "producer": attr.label(providers = [NativeSeedInfo], mandatory = True),
        "receipts": attr.label_list(allow_files = True, mandatory = True),
        "domain": attr.string(values = ["android-datum64", "ios-datum64"], mandatory = True),
        "icu": attr.label(allow_single_file = True),
        "_tool": attr.label(default = "//build_defs/resources:seed_domain", providers = [BunScriptInfo], cfg = "exec"),
    },
)

def android_resource_slice(name):
    """Admit the actual Linux bootstrap against both actual Android producers."""
    compatible = ["@platforms//os:linux", "@platforms//cpu:x86_64"]
    packages = []
    for profile in DATABASE_RESOURCE_CONTRACT["profiles"]:
        prefix = "android_datum64_" + profile
        icu = ":icu_payload" if profile == "icu" else None
        native_seed_domain(name = prefix + "_seed", producer = ":linux_x64_" + profile + "_seed", receipts = [":android_arm64_abi", ":android_x86_64_abi"],
                           domain = "android-datum64", icu = icu, target_compatible_with = compatible)
        native.filegroup(name = prefix + "_frozen", srcs = [":" + prefix + "_seed"], output_group = "frozen")
        packages.extend(native_seed_envelopes(prefix, "android-datum64", profile, ":" + prefix + "_seed", icu = icu, compatible = compatible))
    shipping_export(name = name, packages = packages)
