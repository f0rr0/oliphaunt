"""Compile final Cargo source envelopes offline; no runtime/admission claim."""

load("@rules_cc//cc:find_cc_toolchain.bzl", "use_cc_toolchain")
load("@native_cargo_metadata//:cargo.bzl", "CARGO")
load("@oliphaunt_metadata//:metadata.bzl", "COMPLETED_SUPPLIER_ARTIFACTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/languages:cargo-toolchain.bzl", "cargo_test_toolchain")

_RUST = "@rules_rust//rust:toolchain_type"

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _source_compile_impl(ctx):
    rust = ctx.toolchains[_RUST]
    if not rust.cargo:
        fail("installed source compilation needs the declared Cargo toolchain")
    cc = cargo_test_toolchain(ctx)
    archives = [ctx.file.archive] + ctx.files.dependencies
    held = []
    held_files = []
    for target, metadata in ctx.attr.held_sources.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory:
            fail("completed source dependency needs one actual archive File")
        facts = json.decode(metadata)
        facts["file"] = _runfile(ctx, files[0])
        held.append(facts)
        held_files.append(files[0])
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({
        "archives": [_runfile(ctx, file) for file in archives],
        "held": held,
        "cargoHome": {_runfile(ctx, file): file.short_path.split("/registry/")[-1] for file in ctx.files.cargo_home},
        "lock": _runfile(ctx, ctx.file.lock),
        "index": _runfile(ctx, ctx.file.index),
        "flags": ctx.attr.cargo_args,
        "cargo": _runfile(ctx, rust.cargo),
        "rustc": _runfile(ctx, rust.rustc),
        "rustdoc": _runfile(ctx, rust.rust_doc),
        "compiler": _runfile(ctx, cc.configuration),
    }))
    files = [specification, ctx.file.lock, ctx.file.index, cc.configuration, ctx.file._runner] + archives + held_files + ctx.files.cargo_home + ctx.files._helpers + rust.all_files.to_list() + cc.files
    return bun_test_entrypoint(ctx, runner = ctx.file._runner, arguments = [specification], files = files,
                               source_files = [ctx.file._runner] + ctx.files._helpers, runfiles_argument = True)

_source_compile_test = rule(
    implementation = _source_compile_impl,
    test = True,
    fragments = ["cpp"],
    toolchains = [_RUST] + BUN_SOURCE_TOOLCHAINS + use_cc_toolchain(),
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "archive": attr.label(mandatory = True, allow_single_file = True),
        "dependencies": attr.label_list(allow_files = True),
        "held_sources": attr.label_keyed_string_dict(allow_files = True),
        "cargo_home": attr.label(mandatory = True),
        "lock": attr.label(mandatory = True, allow_single_file = True),
        "index": attr.label(mandatory = True, allow_single_file = True),
        "cargo_args": attr.string_list(),
        "_runner": attr.label(default = "//build_defs/languages/installed:source-compile.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = [
            "//build_defs/languages/installed:consumer.mts",
            "//build_defs/languages/installed:context.mts",
            "//build_defs/languages:cargo-environment.mts",
            "//:tools/packaging/frozen-cargo.mts",
            "//:tools/packaging/cargo-manifest.mts",
            "//:tools/packaging/portable-archive.mts",
        ], allow_files = True),
    }),
)

def source_compile_test(name, dependencies = [], args = [], **kwargs):
    names = []
    for target in dependencies:
        package = native.package_relative_label(target).package
        if package not in CARGO:
            fail("source dependency is missing its conventional Cargo projection: " + package)
        names.append("cargo:" + CARGO[package]["name"])
    held = {}
    for row in COMPLETED_SUPPLIER_ARTIFACTS.values():
        if row["artifact"] in names:
            held[row["file"]["path"]] = json.encode({
                "name": row["artifact"][len("cargo:"):],
                "version": row["publication"]["version"],
                "size": row["file"]["size"],
                "sha256": row["file"]["sha256"],
            })
    _source_compile_test(name = name, dependencies = dependencies, held_sources = held, args = bun_test_entrypoint_args(name) + args, **kwargs)
