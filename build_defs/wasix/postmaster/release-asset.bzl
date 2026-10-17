"""One canonical host archive; full-family checksum assembly stays separate."""

load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS", "WASIX_ARTIFACTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/native/carriers:release-family.bzl", "native_release_checksum_family")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")

POSTMASTER_RELEASE_HELPERS = [
    "//:tools/packaging/archive-directory.mts",
    "//:tools/packaging/portable-archive.mts",
    "//:tools/packaging/platform-binary-contract.mts",
    "//:tools/packaging/windows-vc-runtime-closure.mts",
    "//:tools/packaging/windows-vc-runtime-policy.json",
    "//tools/release:platform-compatibility-policy.mts",
    "//:tools/packaging/strict-json.mts",
    "//build_defs/wasix/postmaster:native-receipts.mts",
    "//src/wasix/postmaster:lib/verify-sealed-carrier.mts",
    "//src/wasix/postmaster:lib/guest-build-provenance.mts",
    "//src/wasix/postmaster:lib/receipt-files.mts",
    "//src/wasix/postmaster:lib/linear-memory-profile.mts",
    "//src/wasix/postmaster:lib/sealed-export-chain.mts",
    "//src/wasix/postmaster:wasmer/bin/verify-postmaster-concurrency-contract.mts",
    "//src/wasix/postmaster:wasmer/bin/verify-postmaster-wasm-import.mts",
    "//src/wasix/postmaster:wasmer/policies/sealed-side-modules.v1.tsv",
    "//src/wasix/postmaster:wasmer/policies/sealed-main-runtime-exports.v1.txt",
    "//src/wasix/postmaster:wasmer/policies/sealed-main-dlsym-exports.v1.txt",
]

def _release_asset_impl(ctx):
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    artifact = json.decode(ctx.attr.artifact)
    if artifact["product"] != owner.id:
        fail("Postmaster asset row differs from canonical owner")
    output = ctx.actions.declare_file(ctx.label.name + "/" + artifact["asset"].replace("{version}", owner.version))
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    sources = {"launcher": ctx.file.launcher.path, "readme": ctx.file.readme.path, "license": ctx.file.license.path, "notices": ctx.file.notices.path}
    ctx.actions.write(spec, json.encode({"product": owner.id, "version": owner.version, "artifact": artifact, "carrier": ctx.file.carrier.path, "sources": sources, "output": output.path}))
    leaves = ctx.actions.args()
    leaves.add_all([ctx.file.carrier], expand_directories = True)
    leaves.use_param_file("--carrier-files=%s", use_always = True)
    leaves.set_param_file_format("multiline")
    bun_file_action(ctx, ctx.file._writer, arguments = [spec.path, leaves], source_files = ctx.files._helpers,
                    inputs = [spec, ctx.file.carrier, ctx.file.launcher, ctx.file.readme, ctx.file.license, ctx.file.notices],
                    outputs = [output], mnemonic = "PostmasterPublicArchive")
    return [DefaultInfo(files = depset([output]))]

_release_asset = rule(
    implementation = _release_asset_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "owner": attr.label(providers = [ReleaseIdentityInfo], mandatory = True),
        "artifact": attr.string(mandatory = True),
        "carrier": attr.label(mandatory = True, allow_single_file = True),
        "launcher": attr.label(default = "//src/wasix/postmaster:bin/run-release-carrier.sh", allow_single_file = True),
        "readme": attr.label(default = "//src/wasix/postmaster:README.md", allow_single_file = True),
        "license": attr.label(default = "//:LICENSE", allow_single_file = True),
        "notices": attr.label(default = "//:THIRD_PARTY_NOTICES.md", allow_single_file = True),
        "_writer": attr.label(default = "//build_defs/wasix/postmaster:release-asset.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = POSTMASTER_RELEASE_HELPERS, allow_files = True),
    },
)

_ShellPathInfo = provider(fields = ["path"])

def _shell_impl(ctx):
    return [_ShellPathInfo(path = ctx.toolchains["@rules_shell//shell:toolchain_type"].path)]

_shell = rule(implementation = _shell_impl, toolchains = ["@rules_shell//shell:toolchain_type"])

def _archive_test_impl(ctx):
    shell = ctx.attr.shell[_ShellPathInfo].path
    return bun_test_entrypoint(ctx, runner = ctx.file._runner,
                              arguments = [ctx.file.archive, shell, ctx.file.launcher, ctx.file.readme, ctx.file.license, ctx.file.notices],
                              files = [ctx.file.archive, ctx.file.launcher, ctx.file.readme, ctx.file.license, ctx.file.notices],
                              source_files = [ctx.file._runner] + ctx.files._helpers)

_archive_test = rule(
    implementation = _archive_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "archive": attr.label(mandatory = True, allow_single_file = True),
        "shell": attr.label(mandatory = True, cfg = "exec", providers = [_ShellPathInfo]),
        "launcher": attr.label(default = "//src/wasix/postmaster:bin/run-release-carrier.sh", allow_single_file = True),
        "readme": attr.label(default = "//src/wasix/postmaster:README.md", allow_single_file = True),
        "license": attr.label(default = "//:LICENSE", allow_single_file = True),
        "notices": attr.label(default = "//:THIRD_PARTY_NOTICES.md", allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/wasix/postmaster:release-asset-test.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = POSTMASTER_RELEASE_HELPERS, allow_files = True),
    }),
)

def postmaster_release_asset(name, target, carrier, execution, qualification):
    rows = [row for row in WASIX_ARTIFACTS if row["product"] == "liboliphaunt-wasix-postmaster" and row["target"] == target and row["kind"] == "wasix-postmaster-runtime"]
    if len(rows) != 1:
        fail("Postmaster release needs one canonical artifact row for " + target)
    row = rows[0]
    owner = "@oliphaunt_metadata//:product_liboliphaunt-wasix-postmaster"
    compatible = ["@platforms//cpu:wasm32", "@platforms//os:wasi"]
    _release_asset(name = name + "_release_asset", owner = owner, artifact = json.encode(row), carrier = carrier,
                   target_compatible_with = compatible, exec_compatible_with = execution)
    legacy = name == "linux_x64_gnu"
    prefix = "linux" if legacy else name
    _shell(name = prefix + "_archive_shell")
    _archive_test(name = prefix + "_public_archive_test", archive = ":" + name + "_release_asset", shell = ":" + prefix + "_archive_shell",
                  args = bun_test_entrypoint_args(prefix + "_public_archive_test"), target_compatible_with = compatible,
                  exec_compatible_with = execution, tags = ["manual"], size = "medium")
    shipping_package(name = prefix + "_carrier_construction", owner = owner, artifacts = [carrier], ecosystem = "internal",
                     package_name = "native_carrier", configuration = row["target"], role = "construction")
    shipping_package(name = prefix + "_release_asset_shipping", owner = owner, artifacts = [":" + name + "_release_asset"], ecosystem = "github",
                     package_name = row["asset"].replace("{version}", PRODUCTS[row["product"]]["version"]), configuration = row["target"], role = "github-release-asset")
    shipping_export(name = prefix + "_shipping_export", packages = [":" + prefix + "_carrier_construction", ":" + prefix + "_release_asset_shipping"], qualification = [":" + prefix + "_public_archive_test"] + qualification, testonly = True)

def postmaster_linux_release_asset(qualification):
    postmaster_release_asset(name = "linux_x64_gnu", target = "linux-x64-gnu", carrier = "@postmaster_postgres//:native_carrier",
                              execution = ["@platforms//os:linux", "@platforms//cpu:x86_64", "@zig_sdk//libc:gnu.2.34"], qualification = qualification)

def postmaster_release_family():
    """Keep the three host archive roots unique; qualify and export their checksum."""
    native_release_checksum_family(product = "liboliphaunt-wasix-postmaster", artifact_rows = WASIX_ARTIFACTS,
                                   export_name = "release_shipping_export")
