"""Current-source core runtime GitHub, npm and Cargo carriers."""

load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS", "PUBLICATION_CARRIERS", "WASIX_ARTIFACTS")
load("@wasix_tool_metadata//:targets.bzl", "WASIX_AOT_TARGETS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/extensions:contrib_carriers.bzl", "native_contrib_carrier_metadata")
load("//build_defs/native/carriers:defs.bzl", "native_checksum_manifest")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:shipping.bzl", "ShippingInfo", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "ShippingSupplierInfo", "shipping_suppliers")
load(":cargo.bzl", "RUNTIME_CARGO_HELPERS")
load(":npm.bzl", "RUNTIME_NPM_HELPERS", "RUNTIME_NPM_NOTICES")
load(":platform.bzl", "WASIX_PORTABLE_TRANSITION")
load(":wasm.bzl", "WasmExportPolicyInfo")

_PRODUCT = "liboliphaunt-wasix"
_OWNER = "@oliphaunt_metadata//:product_" + _PRODUCT

RUNTIME_RELEASE_HELPERS = {label: True for label in RUNTIME_CARGO_HELPERS + RUNTIME_NPM_HELPERS + [
    "//build_defs/wasix:cargo.mts",
    "//build_defs/wasix:package.mts",
    "//src/wasix/runtime:tools/package-release-assets.mts",
    "//build_defs/native/carriers:checksums.mts",
]}.keys()

def _sources(entries, inputs):
    result = {}
    for target, destination in entries.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or destination in result:
            fail("Runtime release input requires one unique declared File")
        result[destination] = files[0].path
        inputs.extend(files)
    return result

def _release_asset_impl(ctx):
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    if owner.id != _PRODUCT:
        fail("Runtime release archive has a foreign source owner")
    payload = ctx.attr.payload[DefaultInfo].files.to_list()
    if len(payload) != 1 or not payload[0].is_directory:
        fail("Runtime release archive requires its actual current payload TreeArtifact")
    artifact = json.decode(ctx.attr.artifact)
    output = ctx.actions.declare_file(ctx.label.name + "/" + artifact["asset"].replace("{version}", owner.version))
    inputs = payload + [ctx.file.toolchain, ctx.file.postgres_source, ctx.file.postgres_series, ctx.file.icu_source] + ctx.files.patches
    if artifact["target"] == "windows-x64-msvc":
        inputs.append(ctx.file.engine_sources)
    generated = _sources(ctx.attr.generated, inputs)
    if artifact["target"] == "portable":
        exports = ctx.attr.export_policy[0][WasmExportPolicyInfo].exports
        inputs.append(exports)
        generated["src/runtimes/liboliphaunt-wasix/assets/generated/wasix-dl.exports"] = exports.path
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "version": owner.version,
        "artifact": artifact,
        "payload": payload[0].path,
        "notices": _sources(ctx.attr.notices, inputs),
        "generated": generated,
        "toolchain": ctx.file.toolchain.path,
        "engineSources": ctx.file.engine_sources.path if artifact["target"] == "windows-x64-msvc" else None,
        "postgresSource": ctx.file.postgres_source.path,
        "postgresSeries": ctx.file.postgres_series.path,
        "patches": {file.short_path: file.path for file in ctx.files.patches},
        "icuSource": ctx.file.icu_source.path,
        "output": output.path,
    }))
    args = ctx.actions.args()
    args.add_all(["package", spec])
    leaves = ctx.actions.args()
    leaves.add_all(payload, expand_directories = True)
    leaves.use_param_file("--payload-files=%s", use_always = True)
    leaves.set_param_file_format("multiline")
    bun_file_action(ctx, ctx.file._runner, arguments = [args, leaves], inputs = depset(inputs + [spec]),
                    source_files = ctx.files._helpers + [ctx.file.toolchain] + ctx.files.notices,
                    outputs = [output], mnemonic = "WasixRuntimeReleaseArchive")
    return [DefaultInfo(files = depset([output])), ctx.attr.payload[ShippingSupplierInfo]]

_release_asset = rule(
    implementation = _release_asset_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "owner": attr.label(default = _OWNER, providers = [ReleaseIdentityInfo]),
        "payload": attr.label(mandatory = True, providers = [ShippingSupplierInfo]),
        "export_policy": attr.label(default = "//src/wasix/runtime:export_policy", providers = [WasmExportPolicyInfo], cfg = WASIX_PORTABLE_TRANSITION),
        "artifact": attr.string(mandatory = True),
        "generated": attr.label_keyed_string_dict(allow_files = True),
        "notices": attr.label_keyed_string_dict(default = RUNTIME_NPM_NOTICES, allow_files = True),
        "patches": attr.label_list(allow_files = [".patch"], mandatory = True),
        "toolchain": attr.label(default = "//src/wasix/runtime:toolchain.toml", allow_single_file = True),
        "engine_sources": attr.label(default = "//src/wasix/runtime/engine:sources.json", allow_single_file = True),
        "postgres_source": attr.label(default = "//src/third-party/postgres:source.toml", allow_single_file = True),
        "postgres_series": attr.label(default = "//src/wasix/runtime:postgres/series", allow_single_file = True),
        "icu_source": attr.label(default = "//src/third-party/icu:source.toml", allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/wasix:runtime-release.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = RUNTIME_RELEASE_HELPERS, allow_files = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)

def _final_packages_test_impl(ctx):
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    if owner.id != _PRODUCT:
        fail("Final runtime package test requires the canonical source owner")
    portable = ctx.attr.portable[DefaultInfo].files.to_list()
    if len(portable) != 1 or not portable[0].is_directory:
        fail("Final runtime package test requires the actual current portable TreeArtifact")
    exports = ctx.attr.export_policy[0][WasmExportPolicyInfo].exports
    inputs, packages = portable + [exports], []
    for target in ctx.attr.packages:
        info = target[ShippingInfo]
        if info.product != owner.id or info.version != owner.version:
            fail("Final runtime package test cannot mix product owners or versions")
        files = info.files.to_list()
        inputs.extend(files)
        packages.append({"ecosystem": info.ecosystem, "name": info.name, "version": info.version, "files": [file.short_path for file in files]})
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    contrib_identities = {(row["ecosystem"], row["name"]): True for row in native_contrib_carrier_metadata("wasix-portable", family = "wasix")["carriers"]}
    ctx.actions.write(spec, json.encode({
        "version": owner.version,
        "artifacts": [row for row in WASIX_ARTIFACTS if row["product"] == _PRODUCT and "github-release" in row["surfaces"]],
        "registryCarriers": [row for row in PUBLICATION_CARRIERS if row["product"] == _PRODUCT and row["ecosystem"] in ["cargo", "npm"] and (row["ecosystem"], row["name"]) not in contrib_identities],
        "packages": packages,
        "portable": portable[0].short_path,
        "exportPolicy": exports.short_path,
    }))
    return bun_test_entrypoint(ctx, ctx.file._runner, ["verify", spec], inputs + [spec] + ctx.files._helpers + ctx.files._notices + [ctx.file._toolchain])

_final_packages_test = rule(
    implementation = _final_packages_test_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    test = True,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "owner": attr.label(default = _OWNER, providers = [ReleaseIdentityInfo]),
        "portable": attr.label(mandatory = True),
        "export_policy": attr.label(default = "//src/wasix/runtime:export_policy", providers = [WasmExportPolicyInfo], cfg = WASIX_PORTABLE_TRANSITION),
        "packages": attr.label_list(mandatory = True, providers = [ShippingInfo]),
        "_runner": attr.label(default = "//build_defs/wasix:runtime-release.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = RUNTIME_RELEASE_HELPERS, allow_files = True),
        "_notices": attr.label_list(default = RUNTIME_NPM_NOTICES.keys(), allow_files = True),
        "_toolchain": attr.label(default = "//src/wasix/runtime:toolchain.toml", allow_single_file = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    }),
)

def wasix_runtime_release_assets(patches, generated, qualification):
    rows = [row for row in WASIX_ARTIFACTS if row["product"] == _PRODUCT and "github-release" in row["surfaces"]]
    archives = []
    for row in rows:
        if row["kind"] == "checksums":
            continue
        name = row["target"].replace("-", "_")
        _release_asset(name = "release_archive_" + name,
                       artifact = json.encode(row), patches = patches,
                       generated = generated if row["target"] == "portable" else {},
                       payload = ":portable_payload" if row["target"] == "portable" else ":aot_" + name + "_payload")
        archives.append(":release_archive_" + name)
    native_checksum_manifest(name = "release_assets", product = _PRODUCT, archives = archives,
                             artifact_rows = WASIX_ARTIFACTS, assemble = True)
    shipping_suppliers(name = "release_checksum_suppliers", inputs = archives)
    packages = [":npm_shipping_package", "//src/wasix/runtime/crates/assets:shipping_package"] + [
        "//src/wasix/runtime/crates/aot/" + triple + ":shipping_package" for triple in WASIX_AOT_TARGETS.values()
    ]
    for row in rows:
        name = "release_" + ("checksums" if row["kind"] == "checksums" else row["target"].replace("-", "_"))
        asset = row["asset"].replace("{version}", PRODUCTS[_PRODUCT]["version"])
        native.filegroup(name = name, srcs = [":release_assets"], output_group = "checksums" if row["kind"] == "checksums" else asset)
        shipping_package(name = name + "_shipping", owner = _OWNER, artifacts = [":" + name],
                         ecosystem = "github", package_name = asset, configuration = row.get("target") or "portable",
                         role = "github-release-asset", suppliers = ":release_checksum_suppliers" if row["kind"] == "checksums" else ":release_archive_" + row["target"].replace("-", "_"))
        packages.append(":" + name + "_shipping")
    _final_packages_test(name = "final_package_test", args = bun_test_entrypoint_args("final_package_test"), portable = ":portable_payload", packages = packages,
                         size = "medium", tags = ["manual"],
                         target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"])
    shipping_export(name = "shipping_export", packages = packages,
                    qualification = [":final_package_test"] + qualification, testonly = True,
                    target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"])
