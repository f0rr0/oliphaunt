"""Biome source checks with declared repository paths and conventional policy."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

def _biome_impl(ctx):
    files = [source for source in ctx.files.sources if source.is_source] + [ctx.file.config, ctx.file.gitignore]
    by_path = {}
    for source in files:
        if source.short_path.startswith("../"):
            fail("Biome source checks accept authored main-repository sources only")
        if source.short_path in by_path and by_path[source.short_path] != source:
            fail("Conflicting declared Biome source: " + source.short_path)
        by_path[source.short_path] = source
    arguments = [ctx.file.biome, ctx.attr.mode]
    for path in sorted(by_path):
        arguments.extend([path, by_path[path]])
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments, files + [ctx.file.biome], source_files = [ctx.file._runner])

_biome_test = rule(
    implementation = _biome_impl,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "sources": attr.label_list(allow_files = True),
        "mode": attr.string(values = ["format", "lint"], mandatory = True),
        "biome": attr.label(default = Label("@biome_linux_x64//:biome"), allow_single_file = True, cfg = "exec"),
        "config": attr.label(default = Label("//:biome.json"), allow_single_file = True),
        "gitignore": attr.label(default = Label("//:.gitignore"), allow_single_file = True),
        "_runner": attr.label(default = Label("//build_defs/quality:biome.mts"), allow_single_file = True),
    }),
    toolchains = BUN_SOURCE_TOOLCHAINS,
    test = True,
)

def biome_test(name, mode, sources, **kwargs):
    _biome_test(name = name, mode = mode, sources = sources, args = bun_test_entrypoint_args(name), **kwargs)

def _runner_test_impl(ctx):
    binary = ctx.file.biome
    runfile = binary.short_path[3:] if binary.short_path.startswith("../") else ctx.workspace_name + "/" + binary.short_path
    sources = [ctx.file._runner, ctx.file._implementation, ctx.file.config]
    return bun_test_entrypoint(
        ctx,
        ctx.file._runner,
        [],
        sources + [binary],
        source_files = sources,
        environment = {"OLIPHAUNT_BIOME_RUNFILE": runfile},
        runfiles_environment = ["OLIPHAUNT_QUALITY_RUNFILES"],
        test_runner = True,
    )

_biome_runner_test = rule(
    implementation = _runner_test_impl,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "biome": attr.label(default = Label("@biome_linux_x64//:biome"), allow_single_file = True, cfg = "exec"),
        "config": attr.label(default = Label("//:biome.json"), allow_single_file = True),
        "_runner": attr.label(default = Label("//build_defs/quality:biome.test.mts"), allow_single_file = True),
        "_implementation": attr.label(default = Label("//build_defs/quality:biome.mts"), allow_single_file = True),
    }),
    toolchains = BUN_SOURCE_TOOLCHAINS,
    test = True,
)

def biome_runner_test(name, **kwargs):
    _biome_runner_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)
