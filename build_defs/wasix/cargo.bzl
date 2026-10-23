"""Canonical runtime Cargo envelopes from the declared portable/AOT payloads."""

load("@native_cargo_metadata//:cargo.bzl", "CARGO")
load("@oliphaunt_metadata//:metadata.bzl", "PUBLICATION_CARRIERS")
load("@wasix_tool_metadata//:targets.bzl", "WASIX_AOT_TARGETS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load(":npm.bzl", "RUNTIME_NPM_NOTICES")

RUNTIME_CARGO_HELPERS = [
    "//src/wasix/runtime:tools/package_liboliphaunt_wasix_cargo_artifacts.mts",
    "//src/wasix/runtime:tools/check-release-assets.mts",
    "//src/wasix/runtime:tools/wasix-aot-manifest.mts",
    "//src/wasix/runtime:tools/wasix-cargo-toolchain-policy.mts",
    "//src/wasix/runtime:tools/wasix-cargo-artifact-contract.mts",
    "//src/wasix/runtime:tools/wasix-runtime-npm-contract.mts",
    "//src/extensions/tools:extension-upstream-licenses.mts",
    "//src/extensions/contracts:wasix-extension-install.mts",
    "//:tools/packaging/wasix-cargo-payload.mts",
    "//:tools/packaging/cargo-source-package.mts",
    "//:tools/packaging/cargo-manifest.mts",
    "//:tools/packaging/rust-build-script-sha256.mts",
    "//:tools/packaging/package-archive.mts",
    "//:tools/packaging/archive-directory.mts",
    "//:tools/packaging/portable-archive.mts",
    "//:tools/packaging/release-notices.mts",
    "//:tools/packaging/release-directory-safety.mts",
    "//tools/release:release-artifact-targets.mts",
    "//tools/release:release-graph.mts",
    "//tools/release:release-history.mts",
    "//tools/release:compatibility-version-parser.mts",
    "//tools/release:extension-release-metadata.mts",
    "//tools/release:platform-compatibility-policy.mts",
    "//:src/extensions/artifacts/packages/tools/contrib-carriers.mts",
    "//:src/extensions/artifacts/packages/tools/extension-registry-packages.mts",
    "//src/extensions/contracts:extension-target-profiles.mts",
    "//src/database-resources:seeds/carrier-identities.mts",
    "//src/native/mobile-bindings:tools/dependency-license-contract.mts",
    "//:tools/packaging/rust-dependency-license-contract.mts",
]

def _source_map(entries, inputs):
    result = {}
    for target, destination in entries.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or destination in result:
            fail("WASIX Cargo source must be one unique declared File")
        result[destination] = files[0].path
        inputs += files
    return result

def _runtime_cargo_impl(ctx):
    payload = ctx.attr.payload[DefaultInfo].files.to_list()
    if len(payload) != 1 or not payload[0].is_directory:
        fail("WASIX Cargo envelope requires the actual portable/AOT payload tree")
    identity = ctx.attr.product[ReleaseIdentityInfo]
    if identity.id != "liboliphaunt-wasix":
        fail("WASIX runtime Cargo envelope requires its canonical release owner")
    inputs = payload + [ctx.file.toolchain]
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "version": identity.version,
        "packageName": ctx.attr.package_name,
        "target": ctx.attr.target_id or None,
        "payload": payload[0].path,
        "sources": _source_map(ctx.attr.sources, inputs),
        "notices": _source_map(ctx.attr.notices, inputs),
        "toolchain": ctx.file.toolchain.path,
    }))
    output = ctx.actions.declare_file(ctx.attr.package_name + "-" + identity.version + ".crate")
    args = ctx.actions.args()
    args.add_all(["--spec", spec, "--output", output])
    leaves = ctx.actions.args()
    leaves.add_all(payload, expand_directories = True)
    leaves.use_param_file("--payload-files=%s", use_always = True)
    leaves.set_param_file_format("multiline")
    bun_file_action(ctx, ctx.file._packager, arguments = [args, leaves], inputs = depset(inputs + [spec]),
                    source_files = ctx.files._helpers, outputs = [output], mnemonic = "WasixRuntimeCargoEnvelope")
    return [DefaultInfo(files = depset([output]))]

_runtime_cargo = rule(
    implementation = _runtime_cargo_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "payload": attr.label(mandatory = True),
        "product": attr.label(mandatory = True, providers = [ReleaseIdentityInfo]),
        "package_name": attr.string(mandatory = True),
        "target_id": attr.string(),
        "sources": attr.label_keyed_string_dict(allow_files = True, mandatory = True),
        "notices": attr.label_keyed_string_dict(default = RUNTIME_NPM_NOTICES, allow_files = True),
        "toolchain": attr.label(default = "//src/wasix/runtime:toolchain.toml", allow_single_file = True),
        "_packager": attr.label(default = "//build_defs/wasix:cargo.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = RUNTIME_CARGO_HELPERS, allow_files = True),
    },
)

def wasix_runtime_cargo(payload, target_id = ""):
    package = CARGO[native.package_name()]["name"]
    rows = [row for row in PUBLICATION_CARRIERS if row["product"] == "liboliphaunt-wasix" and row["ecosystem"] == "cargo" and row["name"] == package]
    if target_id and target_id not in WASIX_AOT_TARGETS:
        fail("WASIX runtime Cargo envelope has no canonical AOT target")
    target = WASIX_AOT_TARGETS[target_id] if target_id else "portable"
    if len(rows) != 1 or rows[0]["target"] != target:
        fail("WASIX runtime Cargo envelope must match its canonical carrier target")
    owner = "@oliphaunt_metadata//:product_liboliphaunt-wasix"
    sources = native.glob(["Cargo.toml", "README.md", "build.rs", "build-support.rs", "src/**"])
    native.filegroup(name = "package_sources", srcs = sources)
    _runtime_cargo(name = "crate", payload = payload, product = owner, package_name = package,
                   target_id = target_id, sources = {file: file for file in sources})
    shipping_package(name = "shipping_package", owner = owner, artifacts = [":crate"], ecosystem = "cargo",
                     package_name = package, configuration = target_id or "portable", role = rows[0]["role"], suppliers = "//src/wasix/runtime:runtime_public_suppliers")
    shipping_export(name = "shipping_export", packages = [":shipping_package"])

def wasix_runtime_cargo_exports():
    packages = ["//src/wasix/runtime/crates/assets"] + ["//src/wasix/runtime/crates/aot/" + triple for triple in WASIX_AOT_TARGETS.values()]
    native.filegroup(name = "cargo", srcs = [package + ":crate" for package in packages], tags = ["manual"])
    shipping_export(name = "cargo_shipping_export", packages = [package + ":shipping_package" for package in packages])
