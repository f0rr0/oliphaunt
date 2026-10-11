"""Acquire the actual native files frozen in a published Swift source carrier."""

def _frozen_native_carrier_impl(ctx):
    facts = json.decode(ctx.read(ctx.attr.source))
    for source in [ctx.attr.converter, ctx.attr.parser, ctx.attr.basis, ctx.attr.compatibility, ctx.attr.bun, ctx.attr.native_releases, ctx.attr.native_completion, ctx.attr.source_publication]:
        ctx.watch(ctx.path(source))
    source_command = [str(ctx.path(ctx.attr.bun)), str(ctx.path(ctx.attr.converter)), str(ctx.path(ctx.attr.source))]
    checked = ctx.execute(source_command, timeout = 60)
    if checked.return_code:
        fail("published native source facts are invalid:\n" + checked.stdout + checked.stderr)
    # The URL binds the member to an immutable source commit; its original Git
    # blob and SHA-256 are checked by the shared parser before assets are used.
    ctx.download(url = checked.stdout.strip(), output = "carrier.json", sha256 = facts["sha256"])
    command = [str(ctx.path(ctx.attr.bun)), str(ctx.path(ctx.attr.converter)), str(ctx.path(ctx.attr.source)), str(ctx.path("carrier.json")), str(ctx.path(ctx.attr.compatibility)), str(ctx.path("assets.json")), str(ctx.path(ctx.attr.native_releases)), str(ctx.path(ctx.attr.native_completion)), str(ctx.path(ctx.attr.source_publication))]
    checked = ctx.execute(command, timeout = 60)
    if checked.return_code:
        fail("published native carrier import failed:\n" + checked.stdout + checked.stderr)
    assets = json.decode(ctx.read("assets.json"))
    for asset in assets:
        ctx.download(url = asset["url"], output = asset["name"], sha256 = asset["sha256"])
    checked = ctx.execute(command + [str(ctx.path("."))], timeout = 60)
    if checked.return_code:
        fail("published native asset verification failed:\n" + checked.stdout + checked.stderr)
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
exports_files(["carrier.json", "assets.json"])
filegroup(name = "carrier", srcs = ["carrier.json"])
filegroup(name = "xcframework_archive", srcs = [%s])
filegroup(name = "runtime_resources_archive", srcs = [%s])
""" % (repr(assets[0]["name"]), repr(assets[1]["name"])))
    return ctx.repo_metadata(reproducible = True)

frozen_native_carrier_repository = repository_rule(
    implementation = _frozen_native_carrier_impl,
    attrs = {
        "source": attr.label(allow_single_file = True, mandatory = True),
        "compatibility": attr.label(allow_single_file = True, mandatory = True),
        "native_releases": attr.label(allow_single_file = True, mandatory = True),
        "native_completion": attr.label(allow_single_file = True, mandatory = True),
        "source_publication": attr.label(allow_single_file = True, mandatory = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/release:frozen-native-carrier.mts"), allow_single_file = True),
        "parser": attr.label(default = Label("//src/native/sdks/swift:tools/swift-native-carrier-contract.mts"), allow_single_file = True),
        "basis": attr.label(default = Label("//src/native/sdks/swift:tools/native-legal-source-basis.mts"), allow_single_file = True),
    },
)
