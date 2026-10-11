"""A declared held npm runtime archive bound to the consumer's conventional pin."""

def _frozen_native_npm_impl(ctx):
    authored = ctx.attr.compatibility.package + "/" + ctx.attr.compatibility.name
    if authored != ctx.attr.compatibility_path:
        fail("Frozen npm compatibility label must name the exact authored descriptor source")
    sources = [ctx.attr.metadata, ctx.attr.attestations, ctx.attr.releases, ctx.attr.completion, ctx.attr.descriptor, ctx.attr.compatibility, ctx.attr.owner_descriptor]
    for source in sources + [ctx.attr.converter] + ctx.attr.helpers:
        ctx.read(source)
    ctx.watch(ctx.path(ctx.attr.bun))
    command = [str(ctx.path(ctx.attr.bun)), str(ctx.path(ctx.attr.converter))] + [str(ctx.path(source)) for source in sources[:6]] + [ctx.attr.compatibility_path, str(ctx.path(ctx.attr.owner_descriptor)), ctx.attr.target, str(ctx.path("inputs.json"))]
    checked = ctx.execute(command, timeout = 60)
    if checked.return_code:
        fail("Frozen npm input facts are invalid:\n" + checked.stdout + checked.stderr)
    artifact = json.decode(ctx.read("inputs.json"))
    ctx.download(url = artifact["url"], output = artifact["filename"], integrity = artifact["integrity"])
    checked = ctx.execute(command + [str(ctx.path(artifact["filename"]))], timeout = 120)
    if checked.return_code:
        fail("Frozen npm bytes are invalid:\n" + checked.stdout + checked.stderr)
    name = artifact["target"].replace("-", "_")
    ctx.file("BUILD.bazel", 'package(default_visibility = ["//visibility:public"])\nexports_files(["inputs.json"])\nfilegroup(name = "npm_%s", srcs = [%s])\n' % (name, repr(artifact["filename"])))
    return ctx.repo_metadata(reproducible = True)

frozen_native_npm_repository = repository_rule(
    implementation = _frozen_native_npm_impl,
    attrs = {
        "metadata": attr.label(allow_single_file = True, mandatory = True),
        "attestations": attr.label(allow_single_file = True, mandatory = True),
        "releases": attr.label(allow_single_file = True, mandatory = True),
        "completion": attr.label(allow_single_file = True, mandatory = True),
        "descriptor": attr.label(allow_single_file = True, mandatory = True),
        "compatibility": attr.label(allow_single_file = True, mandatory = True),
        "compatibility_path": attr.string(mandatory = True),
        "target": attr.string(mandatory = True),
        "owner_descriptor": attr.label(default = Label("//src/native/runtime:release.toml"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/release:frozen-native-npm.mts"), allow_single_file = True),
        "helpers": attr.label_list(default = [Label("//build_defs/release:frozen-native-runtime.mts"), Label("//tools/release:compatibility-version-parser.mts"), Label("//:tools/packaging/portable-archive.mts")], allow_files = True),
    },
)
