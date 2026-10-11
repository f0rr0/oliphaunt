"""Native SDK manifest projection and consumers of actual npm envelopes."""

load("@aspect_rules_js//npm:providers.bzl", "NpmPackageInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")

_NODE_TOOLCHAIN = "@rules_nodejs//nodejs:toolchain_type"

def _publish_files_impl(ctx):
    outputs = [ctx.actions.declare_file(ctx.label.name + "/" + name) for name in ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]]
    bun_file_action(
        ctx,
        entry_point = ctx.file._writer,
        arguments = [ctx.attr.profile, ctx.file.manifest.path, outputs[0].dirname],
        inputs = [ctx.file.manifest, ctx.file._writer, ctx.file.profile_helper] + ctx.files._helpers,
        source_files = [ctx.file._writer, ctx.file.profile_helper] + ctx.files._helpers,
        outputs = outputs,
        mnemonic = "SourceSdkManifest",
    )
    return [DefaultInfo(files = depset(outputs)), OutputGroupInfo(manifest = depset([outputs[0]]), license = depset([outputs[1]]), notices = depset([outputs[2]]))]

_source_sdk_publish_files = rule(
    implementation = _publish_files_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "manifest": attr.label(mandatory = True, allow_single_file = [".json"]),
        "profile": attr.string(default = "js", values = ["js", "wasix-ts"]),
        "_writer": attr.label(default = "//build_defs/languages/ts:publish-manifest.mts", allow_single_file = True),
        "profile_helper": attr.label(mandatory = True, allow_single_file = True),
        "_helpers": attr.label_list(default = [
            "//:LICENSE",
            "//:THIRD_PARTY_NOTICES.md",
            "//:tools/packaging/release-notices.mts",
            "//:tools/packaging/release-directory-safety.mts",
            "//:tools/packaging/portable-archive.mts",
        ], allow_files = True),
    },
)

def source_sdk_publish_files(name, manifest, profile = "js", **kwargs):
    _source_sdk_publish_files(
        name = name,
        manifest = manifest,
        profile = profile,
        profile_helper = "//:tools/packaging/source-only-sdk-package.mts" if profile == "js" else "//src/wasix/sdks/ts:tools/package.mts",
        **kwargs
    )

def _archive_package_impl(ctx):
    return [
        DefaultInfo(files = depset([ctx.file.archive])),
        NpmPackageInfo(package = ctx.attr.package_name, version = ctx.attr.version, src = ctx.file.archive, npm_package_store_infos = depset()),
    ]

npm_archive_package = rule(
    implementation = _archive_package_impl,
    attrs = {
        "archive": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "package_name": attr.string(mandatory = True),
        "version": attr.string(mandatory = True),
    },
)

def _runfile(ctx, file):
    return file.short_path[3:] if file.short_path.startswith("../") else ctx.workspace_name + "/" + file.short_path

def _consumer_impl(ctx):
    node = ctx.toolchains[_NODE_TOOLCHAIN].nodeinfo.node
    if not node:
        fail("SDK consumers require the pinned Node toolchain")
    type_files = []
    packages = {}
    for key, target in ctx.attr.type_packages.items():
        source = key[NpmPackageInfo].src
        type_files.append(source)
        packages[target] = _runfile(ctx, source)
    specification = ctx.actions.declare_file(ctx.label.name + ".types.json")
    ctx.actions.write(specification, json.encode({"packages": packages, "types": ctx.attr.types}))
    files = [ctx.file.archive, ctx.file.query, ctx.file.consumer, ctx.file._runner, ctx.file.acquisition, ctx.file.typescript, specification, node] + type_files
    arguments = [ctx.file.archive, ctx.file.query, ctx.file.consumer, node, ctx.file.typescript, ctx.file.acquisition, specification]
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments, files, source_files = [ctx.file._runner], runfiles_environment = ["OLIPHAUNT_BAZEL_RUNFILES"])

_source_sdk_consumer_test = rule(
    implementation = _consumer_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE_TOOLCHAIN],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "archive": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "query": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "consumer": attr.label(mandatory = True, allow_single_file = True),
        "typescript": attr.label(default = "@npm_typescript//:node_modules/typescript/dir", allow_single_file = True),
        "acquisition": attr.label(default = "@javascript_packages//:acquisition.json", allow_single_file = True),
        "type_packages": attr.label_keyed_string_dict(providers = [NpmPackageInfo]),
        "types": attr.string_dict(mandatory = True),
        "_runner": attr.label(default = "//build_defs/languages/ts:consumer-test.mts", allow_single_file = True),
    }),
)

def source_sdk_consumer_test(name, args = [], **kwargs):
    _source_sdk_consumer_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)
