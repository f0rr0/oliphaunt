"""One-way acquisition metadata for the SDK's generated engine carriers."""

def _impl(ctx):
    for source in [ctx.attr.version_manifest, ctx.attr.source_pins] + ctx.attr.helpers:
        ctx.read(source)
    ctx.watch(ctx.path(ctx.attr.bun))
    result = ctx.execute([
        ctx.path(ctx.attr.bun), "--no-env-file", "--no-install",
        ctx.path(ctx.attr.converter), ctx.path(ctx.attr.version_manifest),
        ctx.path(ctx.attr.source_pins), ctx.path("acquisition.json"),
    ], quiet = True)
    if result.return_code:
        fail("Cannot project owned Windows engine dependencies: " + result.stderr)
    pins = json.decode(ctx.read(ctx.attr.source_pins))
    for name in pins["crates"]:
        ctx.watch(ctx.path(ctx.attr.source_pins).dirname.get_child("upstream/" + name + "/Cargo.toml"))
    ctx.file("BUILD.bazel", 'exports_files(["acquisition.json"], visibility = ["//visibility:public"])\n')
    return ctx.repo_metadata(reproducible = True)

engine_acquisition_repository = repository_rule(
    implementation = _impl,
    attrs = {
        "version_manifest": attr.label(default = Label("//src/wasix/sdks/rust:Cargo.toml"), allow_single_file = True),
        "source_pins": attr.label(default = Label("@wasix_engine_sources//:sources.json"), allow_single_file = True),
        "converter": attr.label(default = Label(":acquisition.mts"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "helpers": attr.label_list(default = [
            Label(":acquisition.mts"),
            Label("//src/wasix/runtime/engine:package.mts"),
            Label("//:tools/packaging/cargo-manifest.mts"),
            Label("//:tools/packaging/cargo-source-package.mts"),
            Label("//:tools/packaging/package-archive.mts"),
            Label("//:tools/packaging/archive-directory.mts"),
            Label("//:tools/packaging/portable-archive.mts"),
            Label("//:tools/packaging/release-notices.mts"),
            Label("//:tools/packaging/release-directory-safety.mts"),
            Label("//:tools/packaging/rust-native-targets.mts"),
        ]),
    },
)

def _notices_impl(ctx):
    manifest = json.decode(ctx.read(ctx.attr.pins))
    ctx.read(ctx.attr.renderer)
    ctx.watch(ctx.path(ctx.attr.bun))
    for notice in manifest["notices"]:
        ctx.download(url = notice["url"], sha256 = notice["sha256"], output = "inputs/" + notice["id"])
    result = ctx.execute([
        ctx.path(ctx.attr.bun), "--no-env-file", "--no-install", ctx.path(ctx.attr.renderer),
        ctx.path(ctx.attr.pins), ctx.path("inputs"), ctx.path("THIRD_PARTY_NOTICES.md"),
    ], quiet = True)
    if result.return_code:
        fail("Cannot render pinned Windows engine notices: " + result.stderr)
    ctx.file("BUILD.bazel", 'exports_files(["THIRD_PARTY_NOTICES.md"], visibility = ["//visibility:public"])\n')
    return ctx.repo_metadata(reproducible = True)

engine_notices_repository = repository_rule(
    implementation = _notices_impl,
    attrs = {
        "pins": attr.label(default = Label("//src/wasix/runtime/engine:notices.json"), allow_single_file = True),
        "renderer": attr.label(default = Label("//src/wasix/runtime/engine:notices.mts"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
    },
)
