"""One-way JavaScript acquisition from the conventional Bun workspace lock."""

load("@aspect_rules_js//npm:repositories.bzl", "npm_import")

def _metadata_impl(ctx):
    inputs = [ctx.attr.package, ctx.attr.lockfile, ctx.attr.converter] + ctx.attr.manifests
    for source in inputs:
        ctx.read(source)
    ctx.watch(ctx.path(ctx.attr.bun))
    ctx.file("consumer-selection.json", json.encode(ctx.attr.consumer_tools))
    result = ctx.execute([
        ctx.path(ctx.attr.bun),
        ctx.path(ctx.attr.converter),
        ctx.path(ctx.attr.package),
        ctx.path(ctx.attr.lockfile),
        "--consumer-tools=" + str(ctx.path("consumer-selection.json")),
    ] + [ctx.path(source) for source in ctx.attr.manifests], quiet = True)
    if result.return_code:
        fail("Cannot import canonical JavaScript workspace inputs: " + result.stderr)
    data = json.decode(result.stdout)
    ctx.file("metadata.bzl", "JAVASCRIPT = " + repr(data["workspaces"]) + "\n")
    ctx.file("acquisition.json", json.encode(data["packages"]))
    ctx.file("typescript.json", json.encode(data["typescript"]))
    ctx.file("consumer-tools.json", json.encode(data.get("consumerTools", {"roots": {}, "packages": {}, "platform": {"os": "linux", "cpu": "x64"}})))
    ctx.file("BUILD.bazel", 'exports_files(["metadata.bzl", "acquisition.json", "typescript.json", "consumer-tools.json"], visibility = ["//visibility:public"])\n')
    return ctx.repo_metadata(reproducible = True)

javascript_metadata_repository = repository_rule(
    implementation = _metadata_impl,
    attrs = {
        "package": attr.label(default = Label("//:package.json"), allow_single_file = True),
        "lockfile": attr.label(default = Label("//:bun.lock"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/languages/ts:metadata.mts"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "manifests": attr.label_list(allow_files = True, mandatory = True),
        "consumer_tools": attr.string_list_dict(default = {}),
    },
)

def _hub_impl(ctx):
    metadata = json.decode(ctx.read(ctx.attr.metadata))
    data = metadata["packages"] if ctx.attr.consumer else metadata
    lines = [
        'load("@aspect_rules_js//npm/private:npm_package_store.bzl", "npm_package_store")',
        'load("@aspect_rules_js//npm/private:npm_link_package_store.bzl", "npm_link_package_store")',
        "PACKAGES = {",
    ]
    for key in sorted(data):
        row = data[key]
        lines.append("    %s: {\"src\": Label(%s), \"dependencies\": %s}," % (
            repr(key),
            repr("@" + ctx.attr.prefix + key + "//:pkg"),
            repr(row["dependencies"]),
        ))
    lines.extend([
        "}",
        "",
        "def javascript_type_links(types):",
        "    for key in sorted(PACKAGES):",
        "        row = PACKAGES[key]",
        "        npm_package_store(name = \"_javascript_\" + key, src = row[\"src\"], deps = {\":_javascript_\" + dependency: name for name, dependency in row[\"dependencies\"].items()})",
        "    for name, key in types.items():",
        "        npm_link_package_store(name = \"node_modules/\" + name, src = \":_javascript_\" + key)",
    ])
    ctx.file("defs.bzl", "\n".join(lines) + "\n")
    ctx.file("acquisition.json", json.encode(data) if ctx.attr.consumer else ctx.read(ctx.attr.metadata))
    if ctx.attr.consumer:
        ctx.file("roots.bzl", "CONSUMER_TOOLS = " + repr(metadata["roots"]) + "\n")
    build = ['package(default_visibility = ["//visibility:public"])', 'exports_files(["defs.bzl", "acquisition.json"])']
    if ctx.attr.consumer:
        build.append('exports_files(["roots.bzl"])')
    for key in sorted(data):
        build.append("alias(name = %s, actual = %s)" % (repr(key), repr("@" + ctx.attr.prefix + key + "//:pkg")))
    ctx.file("BUILD.bazel", "\n".join(build) + "\n")
    return ctx.repo_metadata(reproducible = True)

_javascript_hub = repository_rule(
    implementation = _hub_impl,
    attrs = {
        "metadata": attr.label(mandatory = True),
        "prefix": attr.string(default = "javascript_"),
        "consumer": attr.bool(default = False),
    },
)

def _packages_impl(ctx):
    tags = [tag for module in ctx.modules for tag in module.tags.configure]
    if len(tags) != 1:
        fail("Exactly one canonical JavaScript acquisition projection is required")
    for module in ctx.modules:
        if module.tags.configure and not module.is_root:
            fail("Only the root module may configure JavaScript acquisition")
    metadata = tags[0].metadata
    packages = json.decode(ctx.read(metadata))
    for key, package in packages.items():
        npm_import(
            name = "javascript_" + key,
            package = package["package"],
            version = package["version"],
            integrity = package["integrity"],
            lifecycle_hooks = [],
        )
    _javascript_hub(name = "javascript_packages", metadata = metadata)
    repos = ["javascript_packages"]
    if tags[0].consumer_metadata:
        consumer = json.decode(ctx.read(tags[0].consumer_metadata))
        if consumer["platform"] != {"os": "linux", "cpu": "x64"}:
            fail("The browser consumer tool closure requires Linux x64")
        for key, package in consumer["packages"].items():
            npm_import(
                name = "javascript_consumer_" + key,
                package = package["package"],
                version = package["version"],
                integrity = package["integrity"],
                lifecycle_hooks = [],
            )
        _javascript_hub(name = "javascript_consumer_packages", metadata = tags[0].consumer_metadata, prefix = "javascript_consumer_", consumer = True)
        repos.append("javascript_consumer_packages")
    return ctx.extension_metadata(root_module_direct_deps = repos, root_module_direct_dev_deps = [], reproducible = True)

javascript_packages = module_extension(
    implementation = _packages_impl,
    tag_classes = {"configure": tag_class(attrs = {
        "metadata": attr.label(mandatory = True),
        "consumer_metadata": attr.label(),
    })},
)
