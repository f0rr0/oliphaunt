"""Expose authenticated historical Swift source and its conventional binding archive."""

load(":requirement-selection.bzl", "swift_requirement_inputs")

def _captured_swift_impl(ctx):
    catalog = json.decode(ctx.read(ctx.attr.catalog))
    manifest = json.decode(ctx.read(ctx.attr.manifest))
    selected = json.decode(ctx.read(ctx.attr.selected_products))
    current = json.decode(ctx.read(ctx.attr.current_source))
    version = manifest["oliphaunt"]["swiftSdkVersion"]
    decision = swift_requirement_inputs(version, selected, catalog, current)
    if "error" in decision:
        fail(decision["error"] + " at " + version)
    source, bindings, has_source = decision["source"], decision["bindings"], decision["completed"]
    if has_source:
        source_file, source_operation, source_prefix = source["file"], "source", ""
    else:
        source_file, source_operation, source_prefix = current["archive"], "current-source", "package"
        carrier = ctx.path(Label(current["carrier"]["path"]))
        ctx.watch(carrier)
        ctx.symlink(carrier, "carrier.json")
        source = dict(current, carrier = dict(current["carrier"], path = str(carrier)))
    ctx.watch(ctx.path(ctx.attr.bun))
    for helper in [ctx.attr.verifier, ctx.attr.file_verifier, ctx.attr.archive_parser, ctx.attr.manifest_parser, ctx.attr.carrier_parser, ctx.attr.package_rule]:
        ctx.read(helper)
    archives = {}
    for role, row in [("source", source), ("bindings", bindings)]:
        archive = ctx.path(Label((source_file if role == "source" else row["file"])["path"]))
        ctx.watch(archive)
        descriptor = role + ".json"
        ctx.file(descriptor, json.encode(row))
        result = ctx.execute([str(ctx.path(ctx.attr.bun)), str(ctx.path(ctx.attr.verifier)),
            source_operation if role == "source" else "file", str(archive), str(ctx.path(descriptor)),
            str(ctx.path("construction.json")) if role == "source" else ""], timeout = 60, quiet = True)
        if result.return_code:
            fail("Cannot construct the genuine held Swift package:\n" + result.stdout + result.stderr)
        ctx.symlink(archive, "archives/" + archive.basename)
        archives[role] = "archives/" + archive.basename
        ctx.extract(archive = archive, stripPrefix = source_prefix if role == "source" else "")
    construction = json.decode(ctx.read("construction.json"))
    if construction["bindingsChecksum"] != bindings["file"]["sha256"]:
        fail("Held Swift source does not require the captured original bindings File")
    source_origin = {"kind": "completed-publication", "publication": source["publication"], "artifact": source["artifact"]} if has_source else {"kind": "current-source", "producer": dict(current["carrier"]["producer"], **({"member": current["carrier"]["member"]} if "member" in current["carrier"] else {}))}
    ctx.file("construction.bzl", "SWIFT_CONSTRUCTION = " + repr(construction) + "\n")
    ctx.file("BUILD.bazel", "\n".join([
        'load("@rules_apple//apple:apple.bzl", "apple_static_xcframework_import")',
        'load("@oliphaunt//build_defs/release:identity.bzl", "release_identity")',
        'load("@oliphaunt//build_defs/release:supplier.bzl", "file_shipping_supplier")',
        'load("@oliphaunt//build_defs/release:supplier.bzl", "shipping_suppliers")',
        'load("@oliphaunt//build_defs/extensions:declared_final_inputs.bzl", "native_declared_apple_base")',
        'load(%s, "captured_swift_package")' % repr(str(ctx.attr.package_rule)),
        'load(":construction.bzl", "SWIFT_CONSTRUCTION")',
        'package(default_visibility = ["//visibility:public"])',
        'exports_files(["Package.swift", "construction.json", "construction.bzl"])',
        'filegroup(name = "source_archive", srcs = [%s])' % repr(archives["source"]),
        'filegroup(name = "bindings_archive", srcs = [%s])' % repr(archives["bindings"]),
        'filegroup(name = "carrier", srcs = [%s])' % repr(construction["carrierMember"]),
        'release_identity(name = "source_owner", product_id = "oliphaunt-swift", version = %s)' % repr(version),
        'file_shipping_supplier(name = "carrier_supplier", inputs = {":carrier": %s}, owner = ":source_owner", configuration = "portable", binding = %s, origin = %s)' % (repr(source["source"]["member"] if has_source else ""), repr("compiled-input" if has_source else "abi-contract"), repr(json.encode(source_origin))),
        'native_declared_apple_base(name = "native_requirement", version = SWIFT_CONSTRUCTION["nativeVersion"])',
        'filegroup(name = "xcframework_archive", srcs = [":native_requirement"], output_group = "framework")',
        'filegroup(name = "runtime_resources_archive", srcs = [":native_requirement"], output_group = "resources")',
        'shipping_suppliers(name = "package_suppliers", inputs = [":carrier_supplier", ":native_requirement"])',
        'apple_static_xcframework_import(name = "OliphauntNativeBindingsFFI", xcframework_imports = glob(["OliphauntNativeBindingsFFI.xcframework/**"]))',
        'captured_swift_package(runtime = %s, targets = SWIFT_CONSTRUCTION["targets"], language_version = SWIFT_CONSTRUCTION["languageVersion"])' % repr(str(ctx.attr.runtime)),
    ]) + "\n")
    return ctx.repo_metadata(reproducible = True)

apple_captured_swift_repository = repository_rule(implementation = _captured_swift_impl, attrs = {
    "catalog": attr.label(mandatory = True, allow_single_file = [".json"]),
    "manifest": attr.label(mandatory = True, allow_single_file = [".json"]),
    "selected_products": attr.label(mandatory = True, allow_single_file = [".json"]),
    "current_source": attr.label(mandatory = True, allow_single_file = [".json"]),
    "runtime": attr.label(mandatory = True),
    "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
    "verifier": attr.label(default = Label("//build_defs/apple:captured-swift-source.mts"), allow_single_file = True),
    "file_verifier": attr.label(default = Label("//build_defs/apple:captured-file.mts"), allow_single_file = True),
    "archive_parser": attr.label(default = Label("//:tools/packaging/portable-archive.mts"), allow_single_file = True),
    "manifest_parser": attr.label(default = Label("//src/native/sdks/swift:tools/prepare-swift-release-consumer.mts"), allow_single_file = True),
    "carrier_parser": attr.label(default = Label("//src/native/sdks/swift:tools/swift-native-carrier-contract.mts"), allow_single_file = True),
    "package_rule": attr.label(default = Label("//build_defs/apple:captured-swift.bzl"), allow_single_file = True),
})
