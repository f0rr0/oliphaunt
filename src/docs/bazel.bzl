"""Declared docs content, one Next compiler action, and checks of its static export."""

load("@aspect_rules_js//js:defs.bzl", "js_run_binary")
load("@bazel_lib//lib:directory_path.bzl", "DirectoryPathInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

_NODE_TOOLCHAIN = "@rules_nodejs//nodejs:toolchain_type"
_LINUX = ["@platforms//os:linux", "@platforms//cpu:x86_64"]
_HELPERS = [
    Label("//src/docs:tools/generate-content.mts"),
    Label("//src/docs:tools/published-products.mts"),
    Label("//src/docs:tools/check-docs-product.mts"),
    Label("//tools/release:platform-compatibility-policy.mts"),
]

DocsContentInfo = provider(fields = ["site_docs", "static", "routes", "metadata"])
DocsSiteInfo = provider(fields = ["site", "routes"])

def _sources(ctx):
    rows = []
    files = []
    names = {}
    for target, destination in ctx.attr.sources.items():
        for file in target[DefaultInfo].files.to_list():
            name = destination
            if destination.endswith("/"):
                prefix = target.label.package + "/"
                if not file.short_path.startswith(prefix):
                    fail("Docs source must retain its declared package path: " + file.short_path)
                name += file.short_path[len(prefix):]
            if name in names:
                fail("Duplicate declared docs source: " + name)
            names[name] = True
            rows.append({"path": name, "source": file.path})
            files.append(file)
    return rows, files

def _action(ctx, operation, specification, inputs, outputs, mnemonic):
    file = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(file, json.encode(specification))
    bun_file_action(
        ctx,
        entry_point = ctx.file._runner,
        arguments = [operation, file.path],
        inputs = depset(inputs + [file, ctx.file._runner] + ctx.files._helpers),
        source_files = [ctx.file._runner] + ctx.files._helpers,
        outputs = outputs,
        execution_requirements = {"block-network": "1"},
        mnemonic = mnemonic,
    )

def _content_impl(ctx):
    sources, files = _sources(ctx)
    for file, destination in [(ctx.file.release_config, "release-please-config.json"), (ctx.file.source_versions, ".release-please-manifest.json"), (ctx.file.extension_catalog, "src/extensions/generated/extensions.catalog.json")]:
        sources.append({"path": destination, "source": file.path})
        files.append(file)
    content = ctx.actions.declare_directory(ctx.label.name + "/site-docs")
    static = ctx.actions.declare_directory(ctx.label.name + "/static")
    metadata = ctx.actions.declare_directory(ctx.label.name + "/metadata")
    routes = ctx.actions.declare_file(ctx.label.name + "/routes.json")
    _action(ctx, "content", {
        "sources": sources,
        "releasesFile": ctx.file.completed_releases.path,
        "provenanceFile": ctx.file.provenance.path,
        "outputs": {"siteDocs": content.path, "static": static.path, "metadata": metadata.path, "routes": routes.path},
    }, files + [ctx.file.completed_releases, ctx.file.provenance], [content, static, metadata, routes], "DocsContent")
    return [DefaultInfo(files = depset([content, static, metadata, routes])), DocsContentInfo(site_docs = content, static = static, metadata = metadata, routes = routes), OutputGroupInfo(site_docs = depset([content]), static = depset([static]), routes = depset([routes]))]

_RUNNER_ATTRS = {
    "_runner": attr.label(default = Label("//src/docs:tools/native-docs.mts"), allow_single_file = True),
    "_helpers": attr.label_list(default = _HELPERS, allow_files = True),
}
_SOURCE_ATTRS = {"sources": attr.label_keyed_string_dict(allow_files = True, mandatory = True)}
docs_content = rule(
    implementation = _content_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(_RUNNER_ATTRS, **dict(_SOURCE_ATTRS, **{
        "completed_releases": attr.label(mandatory = True, allow_single_file = [".json"]),
        "provenance": attr.label(mandatory = True, allow_single_file = [".json"]),
        "release_config": attr.label(default = Label("//:release-please-config.json"), allow_single_file = True),
        "source_versions": attr.label(default = Label("//:.release-please-manifest.json"), allow_single_file = True),
        "extension_catalog": attr.label(default = Label("//:src/extensions/generated/extensions.catalog.json"), allow_single_file = True),
    })),
)

def _build_id_impl(ctx):
    sources, files = _sources(ctx)
    content = ctx.attr.content[DocsContentInfo]
    node = ctx.toolchains[_NODE_TOOLCHAIN].nodeinfo.node
    output = ctx.actions.declare_file(ctx.label.name + ".sha256.txt")
    _action(ctx, "build-id", {
        "sources": sources,
        "siteDocs": content.site_docs.path,
        "packages": {identity: json.decode(row) for identity, row in ctx.attr.package_identities.items()},
        "tools": [{"path": "node", "source": node.path}],
        "basePath": ctx.attr.base_path,
        "siteUrl": ctx.attr.site_url,
        "output": output.path,
    }, files + [content.site_docs, node], [output], "DocsBuildIdentity")
    return [DefaultInfo(files = depset([output]))]

_docs_build_id = rule(
    implementation = _build_id_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE_TOOLCHAIN],
    attrs = dict(_RUNNER_ATTRS, **dict(_SOURCE_ATTRS, **{
        "content": attr.label(mandatory = True, providers = [DocsContentInfo]),
        "package_identities": attr.string_dict(mandatory = True),
        "base_path": attr.string(),
        "site_url": attr.string(default = "https://oliphaunt.dev"),
    })),
)

def docs_next_export(name, content, next_binary, sources, package_identities, deps, base_path = "", site_url = "https://oliphaunt.dev", **kwargs):
    native.filegroup(name = name + "_content", srcs = [content], output_group = "site_docs")
    _docs_build_id(name = name + "_build_id", content = content, sources = sources, package_identities = package_identities, base_path = base_path, site_url = site_url, target_compatible_with = _LINUX, exec_compatible_with = _LINUX)
    js_run_binary(
        name = name,
        tool = next_binary,
        args = ["build", "--webpack"],
        srcs = sources.keys() + deps + [":" + name + "_content", ":" + name + "_build_id"],
        out_dirs = ["out"],
        chdir = native.package_name(),
        env = {
            "NEXT_TELEMETRY_DISABLED": "1",
            "NEXT_DISABLE_SWC_WASM": "1",
            "OLIPHAUNT_DOCS_BUILD_CPUS": "1",
            "OLIPHAUNT_DOCS_CONTENT_ROOT": "../../$(rootpath :" + name + "_content)",
            "OLIPHAUNT_DOCS_BUILD_ID_FILE": "../../$(rootpath :" + name + "_build_id)",
            "OLIPHAUNT_DOCS_BASE_PATH": base_path,
            "NEXT_PUBLIC_OLIPHAUNT_DOCS_URL": site_url,
        },
        execution_requirements = {"block-network": "1"},
        target_compatible_with = _LINUX,
        exec_compatible_with = _LINUX,
        mnemonic = "NextDocsExport",
        **kwargs
    )

def _export_impl(ctx):
    content = ctx.attr.content[DocsContentInfo]
    output = ctx.actions.declare_directory(ctx.label.name + "/out")
    licenses = []
    files = [ctx.file.site, content.static]
    for target, destination in ctx.attr.font_licenses.items():
        file = target[DirectoryPathInfo]
        licenses.append({"source": file.directory.path + "/" + file.path, "path": destination})
        files.append(file.directory)
    _action(ctx, "export", {"site": ctx.file.site.path, "static": content.static.path, "licenses": licenses, "output": output.path}, files, [output], "DocsProvenanceExport")
    return [DefaultInfo(files = depset([output])), DocsSiteInfo(site = output, routes = content.routes)]

docs_static_export = rule(
    implementation = _export_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(_RUNNER_ATTRS, **{
        "content": attr.label(mandatory = True, providers = [DocsContentInfo]),
        "site": attr.label(mandatory = True, allow_single_file = True),
        "font_licenses": attr.label_keyed_string_dict(providers = [DirectoryPathInfo]),
    }),
)

