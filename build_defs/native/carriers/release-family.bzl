"""Checksum-only publication roots from authenticated final public archive Files."""

load("@oliphaunt_metadata//:metadata.bzl", "NATIVE_CURRENT_ARTIFACTS", "NATIVE_HELPER_ARTIFACTS", "NATIVE_RUNTIME_ARTIFACTS", "PRODUCTS", "WASIX_ARTIFACTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/release:shipping.bzl", "shipping_export", "shipping_package")
load("//build_defs/release:supplier.bzl", "shipping_suppliers")
load(":defs.bzl", "native_checksum_manifest")

_LINUX_X64 = ["@platforms//os:linux", "@platforms//cpu:x86_64"]

def _canonical_archives_impl(ctx):
    selected = {}
    for file in ctx.files.archives:
        if file.basename not in ctx.attr.expected:
            continue
        if file.is_directory or file.basename in selected:
            fail("release family requires one actual public File per canonical archive")
        selected[file.basename] = file
    if sorted(selected.keys()) != sorted(ctx.attr.expected):
        fail("release family is missing canonical public archive Files")
    return [DefaultInfo(files = depset(selected.values()))]

_canonical_archives = rule(
    implementation = _canonical_archives_impl,
    attrs = {
        "archives": attr.label_list(allow_files = True, mandatory = True),
        "expected": attr.string_list(mandatory = True),
    },
)

def _checksum_test_impl(ctx):
    files = ctx.attr.family[DefaultInfo].files.to_list()
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "product": ctx.attr.product,
        "checksum": ctx.attr.checksum,
        "archives": ctx.attr.expected,
    }))
    return bun_test_entrypoint(ctx, runner = ctx.file._runner,
                              arguments = [spec] + files,
                              files = [spec] + files,
                              source_files = [ctx.file._runner, ctx.file._validator])

_checksum_test = rule(
    implementation = _checksum_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "family": attr.label(mandatory = True),
        "product": attr.string(mandatory = True),
        "checksum": attr.string(mandatory = True),
        "expected": attr.string_list(mandatory = True),
        "_runner": attr.label(default = Label(":release-family.test.mts"), allow_single_file = True),
        "_validator": attr.label(default = Label("//tools/release:checksum-manifest.mts"), allow_single_file = True),
    }),
)

def native_release_checksum_family(product, artifact_rows = None, export_name = "checksum_shipping_export"):
    """Each host keeps its archive root; this once-only owner exports its checksum."""
    version = PRODUCTS[product]["version"]
    if artifact_rows == None:
        artifact_rows = NATIVE_RUNTIME_ARTIFACTS + NATIVE_HELPER_ARTIFACTS + WASIX_ARTIFACTS
    rows = [row for row in artifact_rows if row["product"] == product and "github-release" in row["surfaces"]]
    checksums = [row for row in rows if row["kind"] == "checksums"]
    if len(checksums) != 1:
        fail("release family requires its unique canonical checksum descriptor")
    checksum = checksums[0]
    expected = [row["asset"].replace("{version}", version) for row in rows if row["kind"] != "checksums"]
    current = NATIVE_CURRENT_ARTIFACTS or {}
    archives = [row["file"]["path"] for name in expected
                for row in [current.get(product + "/" + version + "/github-release:" + name)] if row]
    _canonical_archives(name = "release_family_archives", archives = archives,
                        expected = expected, target_compatible_with = _LINUX_X64)
    native_checksum_manifest(name = "release_assets", product = product, artifact_rows = artifact_rows,
                             archives = [":release_family_archives"], assemble = True,
                             output_directory = "release_family/release-assets")
    native.filegroup(name = "release_checksums", srcs = [":release_assets"], output_group = "checksums")
    shipping_suppliers(name = "release_checksum_suppliers", inputs = [])
    shipping_package(name = "release_checksums_shipping", owner = "@oliphaunt_metadata//:product_" + product,
                     artifacts = [":release_checksums"], ecosystem = "github",
                     package_name = checksum["asset"].replace("{version}", version),
                     configuration = checksum.get("target", "") or "portable", role = "github-release-asset",
                     suppliers = ":release_checksum_suppliers")
    _checksum_test(name = "release_checksums_test", family = ":release_assets", product = product,
                   checksum = checksum["asset"].replace("{version}", version), expected = expected,
                   args = bun_test_entrypoint_args("release_checksums_test"), size = "small",
                   target_compatible_with = _LINUX_X64)
    shipping_export(name = export_name, packages = [":release_checksums_shipping"],
                    qualification = [":release_checksums_test"], testonly = True,
                    target_compatible_with = _LINUX_X64)
