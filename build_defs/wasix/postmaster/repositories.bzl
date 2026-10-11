"""Immutable full postmaster source acquisition, separate from other Wasmer contexts."""

_WASMER_COMMIT = "1d1b3420beef28550afbb4692b664bd7f6bc2581"
_WASMER_SHA256 = "f93a21ecac7bea2aaee00a98d60069690701a3185f85b582684ff1735bf46912"
_NAPI_COMMIT = "706383f42391cb4e4e82e5fd5e63a0ebf81ae19d"
_NAPI_SHA256 = "61d281d14542bf51f54f87fb9438984b3dcb3c177e9974cb4ef7850791b43ef8"
_LIBC_COMMIT = "34178a6272804f90448b5bd08dc7bcf0d85438e3"
_LIBC_SHA256 = "8453723052a27f22ed98a3ac77d8e8cd41df5c3ded8a89150d34171093450cbf"

def _archive(ctx, pin, commit, digest, output = ""):
    result = ctx.execute([
        ctx.path(ctx.attr.bun),
        ctx.path(ctx.attr.converter),
        "source",
        ctx.path(pin),
        commit,
        digest,
    ], quiet = True)
    if result.return_code:
        fail("Cannot import canonical postmaster source: " + result.stderr)
    source = json.decode(result.stdout)
    ctx.download_and_extract(
        url = source["url"],
        sha256 = source["sha256"],
        stripPrefix = source["strip_prefix"],
        type = "tar.gz",
        output = output,
    )
    return source

def _read_inputs(ctx):
    ctx.read(ctx.attr.converter)
    ctx.read(ctx.attr.manifest_helper)
    ctx.read(ctx.attr.patch)
    ctx.read(ctx.attr.source_manifest)
    ctx.watch(ctx.path(ctx.attr.bun))

def _wasmer_impl(ctx):
    _read_inputs(ctx)
    ctx.read(ctx.attr.napi_manifest)
    wasmer = _archive(ctx, ctx.attr.source_manifest, _WASMER_COMMIT, _WASMER_SHA256)
    napi = _archive(ctx, ctx.attr.napi_manifest, _NAPI_COMMIT, _NAPI_SHA256, "lib/napi")
    ctx.patch(ctx.path(ctx.attr.patch), strip = 1)
    ctx.file("source.json", json.encode({"wasmer": wasmer, "napi": napi}))
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
exports_files(["Cargo.toml", "Cargo.lock", "source.json"])
filegroup(name = "cargo_manifests", srcs = glob(["**/Cargo.toml"]))
""")
    return ctx.repo_metadata(reproducible = True)

def _libc_impl(ctx):
    _read_inputs(ctx)
    source = _archive(ctx, ctx.attr.source_manifest, _LIBC_COMMIT, _LIBC_SHA256)
    ctx.patch(ctx.path(ctx.attr.patch), strip = 1)
    ctx.file("source.json", json.encode(source))
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
exports_files(["source.json"])
filegroup(name = "sources", srcs = glob(["**"], exclude = ["BUILD.bazel", "source.json"]))
""")
    return ctx.repo_metadata(reproducible = True)

_COMMON = {
    "converter": attr.label(default = Label("//build_defs/wasix/postmaster:metadata.mts"), allow_single_file = True),
    "manifest_helper": attr.label(default = Label("//:tools/packaging/cargo-manifest.mts"), allow_single_file = True),
    "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
}

postmaster_wasmer_repository = repository_rule(
    implementation = _wasmer_impl,
    attrs = dict(_COMMON, **{
        "source_manifest": attr.label(default = Label("//src/wasix/postmaster:sources/wasmer.toml"), allow_single_file = True),
        "napi_manifest": attr.label(default = Label("//src/wasix/postmaster:sources/wasmer-napi.toml"), allow_single_file = True),
        "patch": attr.label(default = Label("//src/wasix/postmaster:wasmer/patches/wasmer/0001-postgres-wasix-blockers.patch"), allow_single_file = True),
    }),
)

postmaster_wasix_libc_repository = repository_rule(
    implementation = _libc_impl,
    attrs = dict(_COMMON, **{
        "source_manifest": attr.label(default = Label("//src/wasix/postmaster:sources/wasix-libc.toml"), allow_single_file = True),
        "patch": attr.label(default = Label("//src/wasix/postmaster:wasmer/patches/wasix-libc/0001-postgres-wasix-blockers.patch"), allow_single_file = True),
    }),
)
