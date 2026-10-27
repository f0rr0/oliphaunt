"""One-way Cargo dependency and compile-fact projections from conventional inputs."""

def _cargo_metadata_impl(ctx):
    ctx.read(ctx.attr.workspace)
    ctx.read(ctx.attr.lockfile)
    ctx.read(ctx.attr.converter)
    ctx.read(ctx.attr.manifest_helper)
    if ctx.attr.acquisition:
        ctx.read(ctx.attr.acquisition)
    ctx.watch(ctx.path(ctx.attr.bun))
    result = ctx.execute([
        ctx.path(ctx.attr.bun),
        ctx.path(ctx.attr.converter),
        ctx.path(ctx.attr.workspace),
        ctx.path(ctx.attr.lockfile),
        ctx.path("."),
    ] + ctx.attr.roots + (["--workspace-prefix", ctx.attr.workspace_prefix] if ctx.attr.workspace_prefix else []) + (["--acquisition", ctx.path(ctx.attr.acquisition)] if ctx.attr.acquisition else []) + ["--activate", json.encode(ctx.attr.activations)], quiet = True)
    if result.return_code:
        fail("Cannot import conventional Cargo inputs: " + result.stderr)
    data = json.decode(result.stdout)
    workspace_root = ctx.path(ctx.attr.workspace).dirname
    for _ in ctx.attr.workspace_prefix.split("/") if ctx.attr.workspace_prefix else []:
        workspace_root = workspace_root.dirname
    for relative in data["watched"]:
        ctx.watch(workspace_root.get_child(relative))
    patches = []
    for source in data["sources"].values():
        resolved = []
        for patch in source["patches"]:
            if patch.startswith("//"):
                resolved.append(str(Label(patch)))
            else:
                resolved.append("@@" + ctx.name + "//:" + patch)
                patches.append(patch)
        source["patches"] = resolved
    ctx.file("cargo-sources.json", json.encode(data["sources"]))
    ctx.file("cargo.bzl", "CARGO = " + repr(data["facts"]) + "\n")
    ctx.file("BUILD.bazel", "exports_files(" + repr(["Cargo.toml", "Cargo.lock", "cargo.bzl", "cargo-sources.json"] + data["manifests"] + patches) + ', visibility = ["//visibility:public"])\n')
    return ctx.repo_metadata(reproducible = True)

cargo_metadata_repository = repository_rule(
    implementation = _cargo_metadata_impl,
    attrs = {
        "workspace": attr.label(default = Label("//:Cargo.toml"), allow_single_file = True),
        "lockfile": attr.label(default = Label("//:Cargo.lock"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/languages:cargo-metadata.mts"), allow_single_file = True),
        "manifest_helper": attr.label(default = Label("//:tools/packaging/cargo-manifest.mts"), allow_single_file = True),
        "workspace_prefix": attr.string(),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "roots": attr.string_list(),
        "activations": attr.string_list_dict(),
        "acquisition": attr.label(allow_single_file = True),
    },
)
