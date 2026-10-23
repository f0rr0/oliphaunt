"""Check authored Rust files with the declared formatter without compiling crates."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

_RUSTFMT_TOOLCHAIN = "@rules_rust//rust/rustfmt:toolchain_type"

def _rustfmt_impl(ctx):
    toolchain = ctx.toolchains[_RUSTFMT_TOOLCHAIN]
    for source in ctx.files.source_files:
        if not source.is_source or source.short_path.startswith("../"):
            fail("Rust formatting requires authored workspace sources: " + source.short_path)
    return bun_test_entrypoint(
        ctx,
        runner = ctx.file._runner,
        arguments = [toolchain.rustfmt, ctx.file.config] + ctx.files.source_files,
        files = [ctx.file.config] + ctx.files.source_files + toolchain.all_files.to_list(),
        source_files = [ctx.file._runner],
    )

_rustfmt_test = rule(
    implementation = _rustfmt_impl,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "source_files": attr.label_list(allow_files = [".rs"], mandatory = True, allow_empty = False),
        "config": attr.label(default = Label("//:rustfmt.toml"), allow_single_file = True),
        "_runner": attr.label(default = Label("//build_defs/quality:rustfmt.mts"), allow_single_file = True),
    }),
    toolchains = BUN_SOURCE_TOOLCHAINS + [_RUSTFMT_TOOLCHAIN],
    test = True,
)

def rustfmt_test(name, args = [], **kwargs):
    _rustfmt_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)

def _runner_test_impl(ctx):
    toolchain = ctx.toolchains[_RUSTFMT_TOOLCHAIN]
    formatter = toolchain.rustfmt
    runfile = formatter.short_path[3:] if formatter.short_path.startswith("../") else ctx.workspace_name + "/" + formatter.short_path
    return bun_test_entrypoint(
        ctx,
        runner = ctx.file._runner,
        arguments = [],
        files = toolchain.all_files.to_list(),
        source_files = [ctx.file._runner, ctx.file._implementation],
        environment = {"OLIPHAUNT_RUSTFMT_RUNFILE": runfile},
        runfiles_environment = ["OLIPHAUNT_BAZEL_RUNFILES"],
        test_runner = True,
    )

_rustfmt_runner_test = rule(
    implementation = _runner_test_impl,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "_runner": attr.label(default = Label("//build_defs/quality:rustfmt.test.mts"), allow_single_file = True),
        "_implementation": attr.label(default = Label("//build_defs/quality:rustfmt.mts"), allow_single_file = True),
    }),
    toolchains = BUN_SOURCE_TOOLCHAINS + [_RUSTFMT_TOOLCHAIN],
    test = True,
)

def rustfmt_runner_test(name, args = [], **kwargs):
    _rustfmt_runner_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)
