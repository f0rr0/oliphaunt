"""Regression for declared native Bun actions and computed test arguments."""

load(":bun.bzl", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load(":bun-toolchain.bzl", "BUN_TOOLCHAIN_TYPE")

def _impl(ctx):
    return bun_test_entrypoint(
        ctx,
        runner = ctx.file._runner,
        arguments = [ctx.file.source, ctx.file.generated, "$literal `&\"' space\n"],
        files = [ctx.file.source, ctx.file.generated, ctx.file._helper],
        environment = {"OLIPHAUNT_NATIVE_ENTRY_FIXTURE": "literal value"},
        runfiles_environment = ["OLIPHAUNT_NATIVE_ENTRY_RUNFILES"],
    )

_native_entry_test = rule(
    implementation = _impl,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "source": attr.label(mandatory = True, allow_single_file = True),
        "generated": attr.label(mandatory = True, allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/foundation:native-entry.test.mts", allow_single_file = True),
        "_helper": attr.label(default = "//build_defs/foundation:native-entry-helper.mts", allow_single_file = True),
    }),
    toolchains = [BUN_TOOLCHAIN_TYPE],
    test = True,
)

def native_entry_test(name, args = [], **kwargs):
    _native_entry_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)
