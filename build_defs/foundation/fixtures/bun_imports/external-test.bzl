"""Exercise repository-relative collisions through the actual source copier."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/foundation:bun-sources.bzl", "bun_source_directory", "bun_source_tree")

def _impl(ctx):
    sources = bun_source_tree(ctx, ctx.label.name + ".repositories", ctx.files.modules)
    arguments = []
    for module in ctx.files.modules:
        arguments.extend([module, bun_source_directory(ctx, sources, module), module.basename])
    return bun_test_entrypoint(
        ctx,
        runner = ctx.file._runner,
        arguments = arguments,
        files = ctx.files.modules + sources.trees.values(),
        source_files = [ctx.file._runner],
    )

_external_source_test = rule(
    implementation = _impl,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "modules": attr.label_list(mandatory = True, allow_files = True),
        "_runner": attr.label(default = ":external-source.test.mts", allow_single_file = True),
    }),
    toolchains = BUN_SOURCE_TOOLCHAINS,
    test = True,
)

def external_source_test(name, args = [], **kwargs):
    _external_source_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)
