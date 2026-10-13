"""Genuine target ABI receipts for separately admitted native seed domains."""

load("//build_defs/foundation:bun.bzl", "BunScriptInfo", "bun_action", "bun_script_test")
load("//build_defs/resources:resources.bzl", "NativeSeedInfo", "SEED_REUSE_ATTRS", "native_seed_envelopes", "seed_constructor_inputs", "seed_constructor_tree_members", "seed_promotion", "seed_reuse")
load("//build_defs/release:shipping.bzl", "shipping_export")
load("@oliphaunt_metadata//:metadata.bzl", "DATABASE_RESOURCE_ARTIFACTS", "DATABASE_RESOURCE_CONTRACT", "PRODUCTS", "SEED_REUSE_CONTROLS")
load("//build_defs/native/carriers:defs.bzl", "native_carrier_legal_inputs")
load("//build_defs/release:shipping.bzl", "shipping_package")

NativeAbiReceiptInfo = provider(fields = ["receipt", "runtime", "target"])

def _constraint(ctx, name):
    return ctx.target_platform_has_constraint(getattr(ctx.attr, name)[platform_common.ConstraintValueInfo])

def _target(ctx):
    arm64 = _constraint(ctx, "_arm64")
    x64 = _constraint(ctx, "_x64")
    if _constraint(ctx, "_ios") and arm64:
        device = _constraint(ctx, "_apple_device")
        simulator = _constraint(ctx, "_apple_simulator")
        if device == simulator:
            fail("iOS seed ABI requires exactly one actual device/simulator compiler configuration")
        return "ios-arm64" if device else "ios-arm64-simulator"
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
    runtime = ctx.file.runtime
    receipt = ctx.actions.declare_file(ctx.label.name + ".properties")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({"target": target, "runtime": runtime.path, "headers": headers, "output": receipt.path}) + "\n")
    arguments = ctx.actions.args()
    arguments.add(specification)
    bun_action(ctx, ctx.attr._tool, arguments = [arguments],
               inputs = [specification, runtime] + ctx.files.configuration + ctx.files.headers,
               outputs = [receipt], mnemonic = "NativeSeedTargetAbi")
    return [DefaultInfo(files = depset([receipt])), NativeAbiReceiptInfo(receipt = receipt, runtime = runtime, target = target)]

native_abi_receipt = rule(
    implementation = _native_abi_receipt_impl,
    attrs = {
        "runtime": attr.label(default = "//src/native/runtime:runtime_abi_binary", allow_single_file = True),
        "configuration": attr.label(default = "@postgres//:configuration", allow_files = True),
        "headers": attr.label_keyed_string_dict(default = {
            Label("@postgres//:src/include/pg_config_manual.h"): "src/include/pg_config_manual.h",
            Label("@postgres//:src/include/catalog/catversion.h"): "src/include/catalog/catversion.h",
            Label("@postgres//:src/include/catalog/pg_control.h"): "src/include/catalog/pg_control.h",
        }, allow_files = True),
        "_tool": attr.label(default = "//build_defs/resources:abi_receipt", providers = [BunScriptInfo], cfg = "exec"),
        "_android": attr.label(default = "@platforms//os:android"),
        "_ios": attr.label(default = "@platforms//os:ios"),
        "_apple_device": attr.label(default = "@apple_support//constraints:device"),
        "_apple_simulator": attr.label(default = "@apple_support//constraints:simulator"),
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
    construction = ctx.actions.declare_file(ctx.label.name + ".seed-construction.json")
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    receipts = ctx.files.receipts + [producer.abi]
    constructor_inputs = [producer.frozen] + receipts + ([ctx.file.icu] if ctx.file.icu else [])
    logical_roles = {}
    for dependency in ctx.attr.receipts:
        for file in dependency[DefaultInfo].files.to_list():
            name = "abi/" + dependency.label.package + "/" + dependency.label.name + "/" + file.basename
            if file.path in logical_roles and logical_roles[file.path] != name:
                fail("Native domain ABI input has ambiguous dependency roles")
            logical_roles[file.path] = name
    reuse, reuse_inputs = seed_reuse(ctx)
    promotion, promotion_inputs = seed_promotion(ctx)
    ctx.actions.write(specification, json.encode({
        "seed": producer.frozen.path,
        "producerConstruction": producer.construction.path,
        "producerTarget": producer.target,
        "profile": producer.profile,
        "domain": ctx.attr.domain,
        "receipts": [file.path for file in receipts],
        "icu": ctx.file.icu.path if ctx.file.icu else None,
        "contract": DATABASE_RESOURCE_CONTRACT,
        "constructionInputs": seed_constructor_inputs(ctx, constructor_inputs, logical_roles),
        "constructionTreeMembers": seed_constructor_tree_members(ctx),
        "constructionOutput": construction.path,
        "reuse": reuse,
        "promotion": promotion,
        "output": frozen.path,
    }) + "\n")
    arguments = ctx.actions.args()
    arguments.add(specification)
    bun_action(ctx, ctx.attr._tool, arguments = [arguments],
               inputs = [specification, producer.construction] + constructor_inputs + reuse_inputs + promotion_inputs,
               outputs = [frozen, construction], mnemonic = "NativeSeedDomainAdmission")
    observation_inputs = depset(
        [frozen, construction],
        transitive = [ctx.attr.producer[OutputGroupInfo].observation_inputs],
    )
    return [DefaultInfo(files = depset([frozen, producer.abi, construction])),
            NativeSeedInfo(frozen = frozen, abi = producer.abi, runtime = producer.runtime,
                           profile = producer.profile, target = ctx.attr.domain, construction = construction),
            OutputGroupInfo(frozen = depset([frozen]), abi = depset([producer.abi]), construction = depset([construction]), observation_inputs = observation_inputs)]

native_seed_domain = rule(
    implementation = _native_seed_domain_impl,
    attrs = dict(SEED_REUSE_ATTRS, **{
        "producer": attr.label(providers = [NativeSeedInfo], mandatory = True),
        "receipts": attr.label_list(allow_files = True, mandatory = True),
        "domain": attr.string(values = ["android-datum64", "ios-datum64"], mandatory = True),
        "icu": attr.label(allow_single_file = True),
        "_tool": attr.label(default = "//build_defs/resources:seed_domain", providers = [BunScriptInfo], cfg = "exec"),
    }),
)

def android_resource_slice(name, qualification):
    """Admit the actual Linux bootstrap against both actual Android producers."""
    compatible = ["@platforms//os:linux", "@platforms//cpu:x86_64"]
    packages = []
    for profile in DATABASE_RESOURCE_CONTRACT["profiles"]:
        prefix = "android_datum64_" + profile
        icu = ":icu_payload" if profile == "icu" else None
        native_seed_domain(name = prefix + "_seed", producer = ":linux_x64_" + profile + "_seed", receipts = [":android_arm64_abi", ":android_x86_64_abi"],
                           domain = "android-datum64", icu = icu, target_compatible_with = compatible,
                           **SEED_REUSE_CONTROLS.get("native/android-datum64/" + profile, {}))
        native.filegroup(name = prefix + "_frozen", srcs = [":" + prefix + "_seed"], output_group = "frozen")
        native.filegroup(name = prefix + "_construction", srcs = [":" + prefix + "_seed"], output_group = "construction")
        packages.extend(native_seed_envelopes(prefix, "android-datum64", profile, ":" + prefix + "_seed", icu = icu, compatible = compatible))
    shipping_export(name = name, packages = packages, qualification = qualification, testonly = True, target_compatible_with = compatible)

def _swift_seed_envelope_impl(ctx):
    output = ctx.actions.declare_file(ctx.attr.out)
    notices = {}
    inputs = ctx.files.assets
    for target, relative in ctx.attr.notices.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("Swift seed notice must resolve to one declared source")
        notices[relative] = files[0].path
        inputs += files
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "version": PRODUCTS["database-resources"]["version"],
        "contract": DATABASE_RESOURCE_CONTRACT,
        "assets": [file.path for file in ctx.files.assets],
        "notices": notices,
        "output": output.path,
    }) + "\n")
    bun_action(ctx, ctx.attr._tool, arguments = [specification.path], inputs = inputs + [specification], outputs = [output], mnemonic = "SwiftSeedEnvelope")
    return [DefaultInfo(files = depset([output]))]

_swift_seed_envelope = rule(implementation = _swift_seed_envelope_impl, attrs = {
    "assets": attr.label_list(allow_files = True, mandatory = True),
    "notices": attr.label_keyed_string_dict(allow_files = True),
    "out": attr.string(mandatory = True),
    "_tool": attr.label(default = "//build_defs/native/apple:seed_envelope", providers = [BunScriptInfo], cfg = "exec"),
})

def ios_resource_slice(name, qualification):
    """Admit the real Mac bootstrap against both actual dynamic iOS producers."""
    compatible = ["@platforms//os:macos", "@platforms//cpu:aarch64"]
    packages, assets, seeds = [], [":icu_payload"], []
    for profile in DATABASE_RESOURCE_CONTRACT["profiles"]:
        prefix = "ios_datum64_" + profile
        icu = ":icu_payload" if profile == "icu" else None
        native_seed_domain(name = prefix + "_seed", producer = ":macos_arm64_" + profile + "_seed",
                           receipts = ["//src/native/runtime:apple_ios_device_abi", "//src/native/runtime:apple_ios_simulator_abi"],
                           domain = "ios-datum64", icu = icu, target_compatible_with = compatible,
                           **SEED_REUSE_CONTROLS.get("native/ios-datum64/" + profile, {}))
        native.filegroup(name = prefix + "_frozen", srcs = [":" + prefix + "_seed"], output_group = "frozen")
        native.filegroup(name = prefix + "_construction", srcs = [":" + prefix + "_seed"], output_group = "construction")
        packages.extend(native_seed_envelopes(prefix, "ios-datum64", profile, ":" + prefix + "_seed", icu = icu, compatible = compatible))
        assets.append(":" + prefix + "_assets")
        seeds.append(":" + prefix + "_seed")
    rows = [row for row in DATABASE_RESOURCE_ARTIFACTS if row["kind"] == "swift-source"]
    if len(rows) != 1:
        fail("Swift seed envelope requires exactly one canonical artifact")
    asset = rows[0]["asset"].replace("{version}", PRODUCTS["database-resources"]["version"])
    _swift_seed_envelope(name = "swift_seed_archive", assets = assets, notices = native_carrier_legal_inputs(), out = asset, target_compatible_with = compatible)
    shipping_package(name = "swift_seed_shipping", owner = "@oliphaunt_metadata//:product_database-resources", artifacts = [":swift_seed_archive"],
                     ecosystem = "github", package_name = asset, configuration = rows[0]["target"], role = "github-release-asset", observation_inputs = seeds)
    shipping_export(name = name, packages = packages + [":swift_seed_shipping"], qualification = qualification, testonly = True, target_compatible_with = compatible)

def mobile_resource_test(name, target):
    """Compare every actual final carrier to its admitted frozen mobile seed."""
    if target not in ["android-datum64", "ios-datum64"]:
        fail("mobile resource qualification requires its native domain")
    android = target == "android-datum64"
    compatible = ["@platforms//os:linux", "@platforms//cpu:x86_64"] if android else ["@platforms//os:macos", "@platforms//cpu:aarch64"]
    files = [":icu_payload"] + ([] if android else [":swift_seed_archive"])
    seed_files = []
    for profile in sorted(DATABASE_RESOURCE_CONTRACT["profiles"]):
        prefix = target.replace("-", "_") + "_" + profile
        seed_files.extend([":" + prefix + "_" + suffix for suffix in ["frozen", "archive", "manifest", "carriers_npm_files", "carriers_cargo_files", "construction"]])
        if android:
            seed_files.append(":" + prefix + "_carriers_maven_files")
    bun_script_test(
        name = name,
        entry_point = "//build_defs/resources:mobile_resource_contract.mts",
        args = [target, PRODUCTS["database-resources"]["version"], PRODUCTS["liboliphaunt-native"]["version"],
                "$(location :icu_payload)", "-" if android else "$(location :swift_seed_archive)"] +
               ["$(location " + file + ")" for file in seed_files],
        data = files + seed_files + ["//build_defs/resources:helpers"],
        target_compatible_with = compatible,
        size = "medium",
    )
