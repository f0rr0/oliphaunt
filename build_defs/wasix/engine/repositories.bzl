"""Immutable upstream engine sources, separate from the large Windows archive."""

_SOURCE_PINS = Label("//src/wasix/runtime/engine:sources.json")

def _engine_sources_impl(ctx):
    source = ctx.read(ctx.attr.pins)
    pins = json.decode(source)
    for name, pin in pins["crates"].items():
        directory = "upstream/" + name
        ctx.download_and_extract(url = pin["url"], sha256 = pin["sha256"], stripPrefix = pin["strip_prefix"], output = directory, type = "tar.gz")
        for patch in pin["patches"]:
            # Native repository patching has no working-directory argument.
            contents = ctx.read(ctx.path(ctx.attr.pins).dirname.get_child(patch))
            for prefix in ["--- a/", "+++ b/"]:
                contents = "\n".join([prefix + directory + "/" + line[len(prefix):] if line.startswith(prefix) else line for line in contents.split("\n")])
            temporary = name + ".patch"
            ctx.file(temporary, contents)
            ctx.patch(temporary, strip = 1)
            ctx.delete(temporary)
    ctx.file("sources.json", source)
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
exports_files(["sources.json", "upstream/wasmer/third-party/wee8/wasm.h"] + glob(["upstream/*/Cargo.toml"]))
""" + "\n".join(["filegroup(name = %r, srcs = glob([%r]))" % (name + "_sources", "upstream/" + name + "/**") for name in pins["crates"]]) + "\n")

wasix_engine_sources_repository = repository_rule(
    implementation = _engine_sources_impl,
    attrs = {"pins": attr.label(default = _SOURCE_PINS, allow_single_file = True)},
)

def _windows_wee8_impl(ctx):
    pins = json.decode(ctx.read(ctx.attr.pins))["wee8"]
    ctx.download(url = pins["url"], sha256 = pins["sha256"], output = "v8-windows-amd64.tar.xz")
    ctx.extract(archive = "v8-windows-amd64.tar.xz")
    ctx.download(url = pins["header"]["url"], sha256 = pins["header"]["sha256"], output = "wasm.hh")
    if not ctx.path(pins["library"]["path"]).exists:
        fail("Pinned Wee8 archive does not contain its declared Windows library")
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
exports_files(["wasm.hh", "v8-windows-amd64.tar.xz", %r])
""" % pins["library"]["path"])

windows_wee8_repository = repository_rule(
    implementation = _windows_wee8_impl,
    attrs = {"pins": attr.label(default = _SOURCE_PINS, allow_single_file = True)},
)

def _relink_sources_impl(ctx):
    contents = ctx.read(ctx.attr.pins)
    pins = json.decode(contents)
    for pin in pins["files"]:
        ctx.download(url = pin["url"], sha256 = pin["sha256"], output = pin["path"])
    paths = [pin["path"] for pin in pins["files"]]
    ctx.file("relink.json", contents)
    ctx.file("BUILD.bazel", 'package(default_visibility = ["//visibility:public"])\nexports_files(["relink.json"])\nfilegroup(name = "sources", srcs = %r)\n' % paths)

engine_relink_sources_repository = repository_rule(
    implementation = _relink_sources_impl,
    attrs = {"pins": attr.label(default = Label("//src/wasix/runtime/engine:relink.json"), allow_single_file = True)},
)
