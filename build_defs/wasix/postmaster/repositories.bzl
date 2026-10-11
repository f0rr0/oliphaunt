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
exports_files(["Cargo.toml", "Cargo.lock", "source.json", "lib/types/src/serialize.rs"])
filegroup(name = "cargo_manifests", srcs = glob(["**/Cargo.toml"]))
""")
    return ctx.repo_metadata(reproducible = True)

def _libc_impl(ctx):
    _read_inputs(ctx)
    source = _archive(ctx, ctx.attr.source_manifest, _LIBC_COMMIT, _LIBC_SHA256)
    ctx.patch(ctx.path(ctx.attr.patch), strip = 1)
    ctx.read(ctx.attr.mode_converter)
    result = ctx.execute([ctx.path(ctx.attr.bun), "--no-install", "--no-env-file", ctx.path(ctx.attr.mode_converter), "patch", ctx.path("."), ctx.path(ctx.attr.patch)], quiet = True)
    if result.return_code:
        fail("Cannot apply patch-declared libc new-file modes: " + result.stderr)
    ctx.file("source.json", json.encode(source))
    ctx.read(ctx.attr.inventory_converter)
    result = ctx.execute([ctx.path(ctx.attr.bun), ctx.path(ctx.attr.inventory_converter), ctx.path("."), ctx.path("source-inventory.bzl")], quiet = True)
    if result.return_code:
        fail("Cannot project canonical patched libc source inventory: " + result.stderr)
    ctx.symlink(ctx.attr.build_file, "BUILD.bazel")
    return ctx.repo_metadata(reproducible = True)

def _cargo_impl(ctx):
    for source in [ctx.attr.workspace, ctx.attr.lockfile, ctx.attr.wasmer_manifest, ctx.attr.source_identity, ctx.attr.patch, ctx.attr.converter, ctx.attr.manifest_helper]:
        ctx.read(source)
    ctx.watch(ctx.path(ctx.attr.bun))
    result = ctx.execute([
        ctx.path(ctx.attr.bun),
        ctx.path(ctx.attr.converter),
        "cargo",
        ctx.path(ctx.attr.workspace),
        ctx.path(ctx.attr.lockfile),
        ctx.path(ctx.attr.wasmer_manifest),
        ctx.path(ctx.attr.source_identity),
        ctx.path(ctx.attr.patch),
        ctx.path("."),
        json.encode(ctx.attr.roles),
    ], quiet = True)
    if result.return_code:
        fail("Cannot import canonical postmaster Cargo roles: " + result.stderr)
    observed = json.decode(result.stdout)
    wasmer = ctx.path(ctx.attr.wasmer_manifest).dirname
    for relative in observed["manifests"]:
        ctx.watch(wasmer.get_child(relative))
    for relative in observed["targets"]:
        ctx.watch(ctx.path(ctx.attr.workspace).dirname.get_child(relative))
    ctx.read(ctx.attr.qualification_source)
    ctx.read(ctx.attr.qualification_converter)
    result = ctx.execute([ctx.path(ctx.attr.bun), "--no-install", "--no-env-file", ctx.path(ctx.attr.qualification_converter), ctx.path(ctx.attr.qualification_source), ctx.path("qualification-profile.json")], quiet = True)
    if result.return_code:
        fail("Cannot project canonical postmaster qualification profile: " + result.stderr)
    exported = ["cargo-sources.json", "qualification-profile.json"] + observed["patches"]
    for role in ctx.attr.roles:
        ctx.symlink(wasmer, role + "/wasmer")
        exported.extend([role + "/Cargo.toml", role + "/Cargo.lock"])
    sources = json.decode(ctx.read("cargo-sources.json"))
    for crate_id, source in sources.items():
        source["patches"] = ["@@" + ctx.name + "//:" + patch for patch in source["patches"]]
    ctx.file("cargo-sources.json", json.encode(sources))
    ctx.file("BUILD.bazel", "package(default_visibility = [\"//visibility:public\"])\nexports_files(" + repr(exported) + ")\n")
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
        "inventory_converter": attr.label(default = Label("//build_defs/wasix/postmaster:libc-metadata.mts"), allow_single_file = True),
        "mode_converter": attr.label(default = Label("//build_defs/wasix/postmaster:source-modes.mts"), allow_single_file = True),
        "build_file": attr.label(default = Label("//build_defs/wasix/postmaster:libc.BUILD.bazel"), allow_single_file = True),
    }),
)

postmaster_cargo_repository = repository_rule(
    implementation = _cargo_impl,
    attrs = dict(_COMMON, **{
        "workspace": attr.label(default = Label("//src/wasix/postmaster:executor/Cargo.toml"), allow_single_file = True),
        "lockfile": attr.label(default = Label("//src/wasix/postmaster:executor/Cargo.lock"), allow_single_file = True),
        "wasmer_manifest": attr.label(default = Label("@postmaster_wasmer//:Cargo.toml"), allow_single_file = True),
        "source_identity": attr.label(default = Label("@postmaster_wasmer//:source.json"), allow_single_file = True),
        "patch": attr.label(default = Label("//src/wasix/postmaster:wasmer/patches/wasmer/0001-postgres-wasix-blockers.patch"), allow_single_file = True),
        "roles": attr.string_dict(mandatory = True),
        "qualification_source": attr.label(default = Label("//src/wasix/postmaster:lib/common.sh"), allow_single_file = True),
        "qualification_converter": attr.label(default = Label("//build_defs/wasix/postmaster:qualification-profile.mts"), allow_single_file = True),
    }),
)

def _compile_metadata_impl(ctx):
    for file in [ctx.attr.manifest, ctx.attr.executor, ctx.attr.compiler, ctx.attr.compiler_rendering, ctx.attr.converter]:
        ctx.read(file)
    ctx.watch(ctx.path(ctx.attr.bun))
    result = ctx.execute([
        ctx.path(ctx.attr.bun),
        ctx.path(ctx.attr.converter),
        ctx.path(ctx.attr.manifest),
        ctx.path(ctx.attr.executor),
        ctx.path(ctx.attr.compiler),
        ctx.path(ctx.attr.compiler_rendering),
        ctx.attr.compiler.workspace_name,
        ctx.path("cargo.bzl"),
    ], quiet = True)
    if result.return_code:
        fail("Cannot project actual postmaster Cargo compile facts: " + result.stderr)
    ctx.file("BUILD.bazel", "exports_files([\"cargo.bzl\"], visibility = [\"//visibility:public\"])\n")
    return ctx.repo_metadata(reproducible = True)

postmaster_compile_metadata_repository = repository_rule(
    implementation = _compile_metadata_impl,
    attrs = {
        "manifest": attr.label(default = Label("//src/wasix/postmaster:executor/Cargo.toml"), allow_single_file = True),
        "executor": attr.label(default = Label("@postmaster_executor_crates//:cargo-bazel.json"), allow_single_file = True),
        "compiler": attr.label(default = Label("@postmaster_compiler_crates//:cargo-bazel.json"), allow_single_file = True),
        "compiler_rendering": attr.label(default = Label("@postmaster_compiler_crates//:crates.bzl"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/wasix/postmaster:compile-metadata.mts"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
    },
)
