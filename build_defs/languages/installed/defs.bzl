"""Closed checkout-composition installed qualification, separate from admission."""

load("@rules_cc//cc:find_cc_toolchain.bzl", "use_cc_toolchain")
load("//build_defs/foundation:bun-toolchain.bzl", "BUN_TOOLCHAIN_TYPE")
load("//build_defs/languages:cargo-toolchain.bzl", "cargo_test_toolchain")

_RUST = "@rules_rust//rust:toolchain_type"

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _installed_cargo_test_impl(ctx):
    rust = ctx.toolchains[_RUST]
    if not rust.cargo:
        fail("installed consumer needs the declared Cargo toolchain")
    cc = cargo_test_toolchain(ctx)
    bun = ctx.toolchains[BUN_TOOLCHAIN_TYPE].bun
    cargo_files = ctx.files.cargo_home
    archives = ctx.files.archives
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "archives": [_runfile(ctx, file) for file in archives],
        "cargoHome": {_runfile(ctx, file): file.short_path.split("/registry/")[-1] for file in cargo_files},
        "manifest": _runfile(ctx, ctx.file.manifest),
        "lock": _runfile(ctx, ctx.file.lock),
        "source": _runfile(ctx, ctx.file.source),
        "buildScript": _runfile(ctx, ctx.file.build_script),
        "cargo": _runfile(ctx, rust.cargo),
        "rustc": _runfile(ctx, rust.rustc),
        "rustdoc": _runfile(ctx, rust.rust_doc),
        "compiler": _runfile(ctx, cc.configuration),
    }))
    launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.write(launcher, """#!/usr/bin/env bash
set -euo pipefail
runfiles="$(cd "${RUNFILES_DIR:-${TEST_SRCDIR:-$0.runfiles}}" && pwd)"
exec "$runfiles/%s" "$runfiles/%s" "$runfiles/%s" "$runfiles"
""" % (_runfile(ctx, bun), _runfile(ctx, ctx.file._runner), _runfile(ctx, specification)), is_executable = True)
    return [DefaultInfo(executable = launcher, runfiles = ctx.runfiles(files = [bun, specification, cc.configuration, ctx.file.manifest, ctx.file.lock, ctx.file.source, ctx.file.build_script, ctx.file._runner] + ctx.files._helpers + cargo_files + archives + rust.all_files.to_list() + cc.files))]

installed_cargo_test = rule(
    implementation = _installed_cargo_test_impl,
    test = True,
    fragments = ["cpp"],
    toolchains = [_RUST, BUN_TOOLCHAIN_TYPE] + use_cc_toolchain(),
    attrs = {
        "archives": attr.label_list(mandatory = True, allow_files = True),
        "cargo_home": attr.label(mandatory = True),
        "manifest": attr.label(mandatory = True, allow_single_file = True),
        "lock": attr.label(mandatory = True, allow_single_file = True),
        "source": attr.label(mandatory = True, allow_single_file = True),
        "build_script": attr.label(mandatory = True, allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/languages/installed:consumer.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = ["//build_defs/languages:cargo-environment.mts", "//:tools/packaging/frozen-cargo.mts", "//:tools/packaging/portable-archive.mts"], allow_files = True),
    },
)
