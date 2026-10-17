"""Expose original completed-publication archive bytes as stock Apple import Files."""

def _captured_impl(ctx):
    catalog = json.decode(ctx.read(ctx.attr.catalog))
    current = json.decode(ctx.read(ctx.attr.current_native))
    selected = json.decode(ctx.read(ctx.attr.selected_products))
    construction = json.decode(ctx.read(ctx.attr.swift_construction))
    version = construction["nativeVersion"]
    native = "liboliphaunt-native/" + version + "/github-release:liboliphaunt-" + version
    roles = [
        ("framework", "-apple-spm-xcframework.zip"),
        ("resources", "-runtime-resources-ios-datum64.tar.gz"),
    ]
    ctx.watch(ctx.path(ctx.attr.bun))
    for helper in [ctx.attr.verifier, ctx.attr.file_verifier, ctx.attr.archive_parser]:
        ctx.read(helper)
    keys = [native + suffix for _, suffix in roles]
    found = [key in catalog for key in keys]
    if found[0] != found[1]:
        fail("The completed native Apple supplier tuple is incomplete")
    if not found[0] and (not current or current["version"] != version or "liboliphaunt-native" not in selected):
        fail("Unpublished native requirement needs its exact selected final producer Files")
    for role, suffix in roles:
        key = native + suffix
        row = catalog[key] if found[0] else {"owner": current["owner"], "version": current["version"], "file": current[role]}
        if role == "framework" and row["file"]["sha256"] != construction["nativeChecksum"]:
            fail("Genuine Package.swift native checksum differs from its supplier File")
        # Labels are derived by the existing snapshot serializer from authenticated Files.
        archive = ctx.path(Label(row["file"]["path"]))
        ctx.watch(archive)
        descriptor = role + ".json"
        ctx.file(descriptor, json.encode(row))
        verified = ctx.execute([str(ctx.path(ctx.attr.bun)), str(ctx.path(ctx.attr.verifier)),
            str(archive), str(ctx.path(descriptor))], timeout = 60, quiet = True)
        if verified.return_code:
            fail("Cannot expose the genuine completed Apple archive:\n" + verified.stdout + verified.stderr)
        ctx.symlink(archive, "archives/" + archive.basename)
        ctx.extract(archive = archive, output = role)
    ctx.file("BUILD.bazel", """
load("@rules_apple//apple:apple.bzl", "apple_dynamic_xcframework_import")
load("@rules_cc//cc:defs.bzl", "cc_library")
package(default_visibility = ["//visibility:public"])
filegroup(name = "archive", srcs = glob(["archives/*-apple-spm-xcframework.zip"]))
filegroup(name = "resources_archive", srcs = glob(["archives/*-runtime-resources-ios-datum64.tar.gz"]))
filegroup(name = "xcframework_files", srcs = glob(["framework/liboliphaunt.xcframework/**"]))
filegroup(name = "ios_device_files", srcs = glob(["framework/liboliphaunt.xcframework/ios-arm64/**"]) + ["framework/liboliphaunt.xcframework/Info.plist"])
filegroup(name = "ios_simulator_files", srcs = glob(["framework/liboliphaunt.xcframework/ios-arm64-simulator/**"]) + ["framework/liboliphaunt.xcframework/Info.plist"])
filegroup(name = "runtime_resources", srcs = glob(["resources/oliphaunt/**"]))
# The original stageIosApp owns the single app resource bundle. Keep compiler/
# runtime framework Files genuine while avoiding a second embedded runtime tree.
apple_dynamic_xcframework_import(name = "runtime", xcframework_imports = glob(["framework/liboliphaunt.xcframework/**"], exclude = ["**/Resources/oliphaunt/**"]))
cc_library(name = "runtime_headers", hdrs = ["framework/liboliphaunt.xcframework/ios-arm64-simulator/liboliphaunt.framework/Headers/oliphaunt.h"],
    includes = ["framework/liboliphaunt.xcframework/ios-arm64-simulator/liboliphaunt.framework/Headers"])
exports_files(["framework/liboliphaunt.xcframework/ios-arm64-simulator/liboliphaunt.framework/Headers/oliphaunt.h"])
""")
    return ctx.repo_metadata(reproducible = True)

apple_captured_archives_repository = repository_rule(implementation = _captured_impl, attrs = {
    "catalog": attr.label(mandatory = True, allow_single_file = [".json"]),
    "current_native": attr.label(mandatory = True, allow_single_file = [".json"]),
    "selected_products": attr.label(mandatory = True, allow_single_file = [".json"]),
    "swift_construction": attr.label(mandatory = True, allow_single_file = [".json"]),
    "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
    "verifier": attr.label(default = Label("//build_defs/apple:captured-archive.mts"), allow_single_file = True),
    "file_verifier": attr.label(default = Label("//build_defs/apple:captured-file.mts"), allow_single_file = True),
    "archive_parser": attr.label(default = Label("//:tools/packaging/portable-archive.mts"), allow_single_file = True),
})
