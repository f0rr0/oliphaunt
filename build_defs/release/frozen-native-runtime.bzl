"""Declared immutable published native inputs; construction acquisition, not admission."""

def _frozen_native_runtime_impl(ctx):
    authored_path = ctx.attr.compatibility.package + "/" + ctx.attr.compatibility.name
    if authored_path != ctx.attr.compatibility_path:
        fail("Frozen native compatibility label must name the descriptor's exact authored source path")
    for source in [ctx.attr.releases, ctx.attr.completion, ctx.attr.descriptor, ctx.attr.compatibility, ctx.attr.converter] + ctx.attr.helpers:
        ctx.read(source)
    ctx.watch(ctx.path(ctx.attr.bun))
    command = [str(ctx.path(ctx.attr.bun)), str(ctx.path(ctx.attr.converter)), str(ctx.path(ctx.attr.releases)), str(ctx.path(ctx.attr.completion)), str(ctx.path(ctx.attr.descriptor)), str(ctx.path(ctx.attr.compatibility)), ctx.attr.compatibility_path, json.encode(ctx.attr.targets), str(ctx.path("inputs.json"))]
    checked = ctx.execute(command, timeout = 60)
    if checked.return_code:
        fail("Frozen native publication inputs are invalid:\n" + checked.stdout + checked.stderr)
    inputs = json.decode(ctx.read("inputs.json"))
    for artifact in inputs:
        ctx.download(url = artifact["url"], output = artifact["name"], sha256 = artifact["sha256"])
    checked = ctx.execute(command + [str(ctx.path("."))], timeout = 120)
    if checked.return_code:
        fail("Frozen native archive verification failed:\n" + checked.stdout + checked.stderr)
    lines = ['load("@rules_cc//cc:cc_import.bzl", "cc_import")', 'load("@rules_cc//cc:cc_library.bzl", "cc_library")', 'package(default_visibility = ["//visibility:public"])', 'exports_files(["inputs.json"])']
    for artifact in inputs:
        target = artifact["target"]
        name = target.replace("-", "_")
        os = "android" if target.startswith("android-") else "osx" if target.startswith("macos-") else "linux"
        cpu = "aarch64" if "arm64" in target else "x86_64"
        lines.extend([
            'filegroup(name = "archive_%s", srcs = [%s])' % (name, repr(artifact["name"])),
            'filegroup(name = "runtime_%s", srcs = glob(["%s/**"], exclude_directories = 1))' % (name, target),
            'filegroup(name = "library_%s", srcs = ["%s/%s"])' % (name, target, artifact["library"]),
            'filegroup(name = "headers_%s", srcs = ["%s/include/oliphaunt.h"])' % (name, target),
            'cc_import(name = "_cc_%s", shared_library = "%s/%s", visibility = ["//visibility:private"], target_compatible_with = ["@platforms//os:%s", "@platforms//cpu:%s"])' % (name, target, artifact["library"], os, cpu),
            'cc_library(name = "cc_%s", hdrs = ["%s/include/oliphaunt.h"], strip_include_prefix = "%s/include", deps = [":_cc_%s"], target_compatible_with = ["@platforms//os:%s", "@platforms//cpu:%s"])' % (name, target, target, name, os, cpu),
        ])
    ctx.file("BUILD.bazel", "\n".join(lines) + "\n")
    return ctx.repo_metadata(reproducible = True)

frozen_native_runtime_repository = repository_rule(
    implementation = _frozen_native_runtime_impl,
    attrs = {
        "releases": attr.label(allow_single_file = True, mandatory = True),
        "completion": attr.label(allow_single_file = True, mandatory = True),
        "descriptor": attr.label(allow_single_file = True, mandatory = True),
        "compatibility": attr.label(allow_single_file = True, mandatory = True),
        "compatibility_path": attr.string(mandatory = True),
        "targets": attr.string_list(mandatory = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/release:frozen-native-runtime.mts"), allow_single_file = True),
        "helpers": attr.label_list(default = [Label("//tools/release:compatibility-version-parser.mts"), Label("//:tools/packaging/portable-archive.mts")], allow_files = True),
    },
)
