"""Installed carrier consumers using conventional Cargo and declared toolchains."""

load("@rules_cc//cc:find_cc_toolchain.bzl", "use_cc_toolchain")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/languages:cargo-toolchain.bzl", "cargo_test_toolchain")

_RUST_TOOLCHAIN = "@rules_rust//rust:toolchain_type"
_NODE_TOOLCHAIN = "@rules_nodejs//nodejs:toolchain_type"

def _installed_impl(ctx):
    node = ctx.toolchains[_NODE_TOOLCHAIN].nodeinfo.node
    if not node:
        fail("installed npm tools require the declared Node toolchain")
    arguments = []
    for target in ctx.attr.inputs:
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1:
            fail("installed carrier argument must be one declared file: " + str(target.label))
        arguments.append(files[0])
    arguments.append(node)
    sources = [ctx.file._runner] + ctx.files._helpers
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments, arguments + sources, source_files = sources)

_native_installed_carrier_test = rule(
    implementation = _installed_impl,
    test = True,
    toolchains = [_NODE_TOOLCHAIN] + BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "inputs": attr.label_list(mandatory = True, allow_files = True),
        "_runner": attr.label(default = "//build_defs/native/carriers:installed.test.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ["//build_defs/native/carriers:tools-consumer.mts", "//build_defs/native:host-runtime-test-helpers.mts", "//:tools/packaging/portable-archive.mts"], allow_files = True),
    }),
)

def native_installed_carrier_test(name, args = [], **kwargs):
    _native_installed_carrier_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)

def _cargo_impl(ctx):
    rust = ctx.toolchains[_RUST_TOOLCHAIN]
    if not rust.cargo:
        fail("installed native consumers require Cargo from the declared Rust toolchain")
    cc = cargo_test_toolchain(ctx)
    arguments = [ctx.file.packages, ctx.file.archive, rust.cargo, rust.rustc, rust.rust_doc, cc.configuration]
    files = [ctx.file.packages, ctx.file.archive, ctx.file._runner, ctx.file._archive_helper, ctx.file._cargo_environment, cc.configuration] + rust.all_files.to_list() + cc.files
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments, files, runfiles_argument = True, source_files = [ctx.file._runner, ctx.file._archive_helper, ctx.file._cargo_environment])

_native_cargo_consumer_test = rule(
    implementation = _cargo_impl,
    test = True,
    toolchains = [_RUST_TOOLCHAIN] + BUN_SOURCE_TOOLCHAINS + use_cc_toolchain(),
    fragments = ["cpp"],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "packages": attr.label(mandatory = True, allow_single_file = True),
        "archive": attr.label(mandatory = True, allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/native/carriers:cargo-consumer.test.mts", allow_single_file = True),
        "_archive_helper": attr.label(default = "//:tools/packaging/portable-archive.mts", allow_single_file = True),
        "_cargo_environment": attr.label(default = "//build_defs/languages:cargo-environment.mts", allow_single_file = True),
    }),
)

def native_cargo_consumer_test(name, args = [], **kwargs):
    _native_cargo_consumer_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)
