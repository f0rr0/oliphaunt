"""Regular, declared module files for Bun's executable import boundary."""

load("@bazel_lib//lib:copy_to_directory.bzl", "copy_to_directory_bin_action")
load(":bun-toolchain.bzl", "BUN_TOOLCHAIN_TYPE")

_COPY_TOOLCHAIN = Label("@bazel_lib//lib:copy_to_directory_toolchain_type")
BUN_SOURCE_TOOLCHAINS = [Label(BUN_TOOLCHAIN_TYPE), _COPY_TOOLCHAIN]

def _identity(ctx, file):
    if file.short_path.startswith("../"):
        parts = file.short_path[3:].split("/", 1)
        return parts[0], parts[1]
    return ctx.workspace_name, file.short_path

def bun_source_tree(ctx, name, files):
    """Copy individual declared files; keep artifact directories as explicit data.

    Bun 1.4.2 resolves symlinked modules to their real source directories even
    with preserve-symlinks flags. Each repository therefore gets a regular-file
    import tree. Directory artifacts are data inputs, never implicit code roots.
    """
    groups = {}
    destinations = {}
    for file in files:
        if file.is_directory:
            continue
        repository, relative = _identity(ctx, file)
        key = repository + "/" + relative
        if key in destinations:
            if destinations[key] != file:
                fail("Distinct Bun module inputs share an import path: " + key)
            continue
        destinations[key] = file
        groups.setdefault(repository, []).append(file)
    trees = {}
    for repository, sources in groups.items():
        tree = ctx.actions.declare_directory(name + "/" + repository)
        copy_to_directory_bin_action(
            ctx,
            name = name + "_" + repository,
            dst = tree,
            copy_to_directory_bin = ctx.toolchains[_COPY_TOOLCHAIN].copy_to_directory_info.bin,
            files = sources,
            root_paths = [],
            include_external_repositories = [repository],
            allow_overwrites = False,
            hardlink = "off",
        )
        trees[repository] = tree
    return struct(trees = trees, files = depset(trees.values()), members = destinations)

def bun_source_path(ctx, sources, file):
    repository, relative = _identity(ctx, file)
    if repository not in sources.trees:
        fail("Bun entrypoint has no declared import tree: " + file.short_path)
    return sources.trees[repository].path + "/" + relative

def bun_source_directory(ctx, sources, file):
    repository, _ = _identity(ctx, file)
    return sources.trees[repository]

def bun_source_runfile(ctx, sources, file):
    repository, relative = _identity(ctx, file)
    tree = sources.trees[repository]
    root = tree.short_path[3:] if tree.short_path.startswith("../") else ctx.workspace_name + "/" + tree.short_path
    return root + "/" + relative
