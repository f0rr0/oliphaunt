"""Immutable genuine Cargo resolution inputs for the installed-consumer test."""

def _installed_cargo_repository_impl(ctx):
    for source in [ctx.attr.lock, ctx.attr.index, ctx.attr.converter]:
        ctx.read(source)
    ctx.file(".anchor", "")
    result = ctx.execute([
        str(ctx.path(ctx.attr.bun)),
        str(ctx.path(ctx.attr.converter)),
        str(ctx.path(ctx.attr.lock)),
        str(ctx.path(ctx.attr.index)),
        str(ctx.path(".")),
    ], environment = {}, quiet = True)
    if result.return_code:
        fail("installed Cargo registry snapshot is invalid: " + result.stderr)
    archives = json.decode(ctx.read("archives.json"))
    for start in range(0, len(archives), 8):
        pending = []
        for archive in archives[start:start + 8]:
            name = archive["name"]
            version = archive["version"]
            pending.append(ctx.download(
                url = "https://static.crates.io/crates/%s/%s-%s.crate" % (name, name, version),
                output = "registry/cache/index.crates.io-1949cf8c6b5b557f/%s-%s.crate" % (name, version),
                sha256 = archive["sha256"],
                canonical_id = "%s@%s:%s" % (name, version, archive["sha256"]),
                block = False,
            ))
        for token in pending:
            token.wait()
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
filegroup(name = "cargo_home", srcs = glob(["registry/**"]))
exports_files(["archives.json"])
""")

installed_cargo_repository = repository_rule(
    implementation = _installed_cargo_repository_impl,
    attrs = {
        "bun": attr.label(mandatory = True, allow_single_file = True),
        "lock": attr.label(default = "//build_defs/languages/installed:fixture/Cargo.lock", allow_single_file = True),
        "index": attr.label(default = "//build_defs/languages/installed:fixture/registry-index.json", allow_single_file = True),
        "converter": attr.label(default = "//build_defs/languages/installed:context.mts", allow_single_file = True),
    },
)
