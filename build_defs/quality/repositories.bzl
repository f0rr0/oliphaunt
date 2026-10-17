"""Source-quality tool acquisition from conventional package declarations."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

def _metadata_impl(ctx):
    for source in [ctx.attr.package, ctx.attr.lockfile, ctx.attr.maintainer_tools, ctx.attr.converter]:
        ctx.read(source)
    ctx.watch(ctx.path(ctx.attr.bun))
    result = ctx.execute([ctx.path(ctx.attr.bun), ctx.path(ctx.attr.converter), ctx.path(ctx.attr.package), ctx.path(ctx.attr.lockfile), ctx.path(ctx.attr.maintainer_tools)], quiet = True)
    if result.return_code:
        fail("Cannot import conventional source-quality acquisition: " + result.stderr)
    data = json.decode(result.stdout)
    ctx.file("quality.json", json.encode(data))
    ctx.file("BUILD.bazel", 'exports_files(["quality.json"], visibility = ["//visibility:public"])\n')
    return ctx.repo_metadata(reproducible = True)

quality_metadata_repository = repository_rule(
    implementation = _metadata_impl,
    attrs = {
        "package": attr.label(default = Label("//:package.json"), allow_single_file = True),
        "lockfile": attr.label(default = Label("//:bun.lock"), allow_single_file = True),
        "maintainer_tools": attr.label(default = Label("//tools/dev:maintainer-tools.toml"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/quality:metadata.mts"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
    },
)

def _tools_impl(ctx):
    tags = [tag for module in ctx.modules for tag in module.tags.configure]
    if len(tags) != 1:
        fail("Exactly one conventional source-quality acquisition is required")
    for module in ctx.modules:
        if module.tags.configure and not module.is_root:
            fail("Only the root module may configure source-quality acquisition")
    metadata = json.decode(ctx.read(tags[0].metadata))
    data = metadata["biome"]
    if data["package"] != "@biomejs/cli-linux-x64" or data["platform"] != {"os": "linux", "cpu": "x64"}:
        fail("Source-quality acquisition requires the conventional Linux x64 Biome binary")
    http_archive(
        name = "biome_linux_x64",
        urls = ["https://registry.npmjs.org/%s/-/cli-linux-x64-%s.tgz" % (data["package"], data["version"])],
        integrity = data["integrity"],
        strip_prefix = "package",
        build_file_content = 'exports_files(["biome"], visibility = ["//visibility:public"])\n',
    )
    for name, tool in metadata["workflow"].items():
        http_archive(
            name = name + "_linux_x64",
            urls = [tool["url"]],
            sha256 = tool["sha256"],
            strip_prefix = tool["stripPrefix"],
            build_file_content = 'exports_files(["%s"], visibility = ["//visibility:public"])\n' % tool["binary"],
        )
    return ctx.extension_metadata(reproducible = True)

quality_tools = module_extension(
    implementation = _tools_impl,
    tag_classes = {"configure": tag_class(attrs = {"metadata": attr.label(mandatory = True)})},
)
