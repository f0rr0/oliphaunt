"""Bounded query packaging and tests; compilation belongs to language rules."""

load("@aspect_rules_js//js:providers.bzl", "JsInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("@rules_cc//cc:find_cc_toolchain.bzl", "use_cc_toolchain")
load("//build_defs/languages:cargo-toolchain.bzl", "cargo_test_toolchain")

_NODE_TOOLCHAIN = "@rules_nodejs//nodejs:toolchain_type"
_RUST_TOOLCHAIN = "@rules_rust//rust:toolchain_type"

def require_commonjs_package(package_type):
    """Validate Node16's sandbox default against the manifest's semantic projection."""
    if package_type != "commonjs":
        fail("query's CommonJS output requires package.json type commonjs (or absent), got " + repr(package_type))

def _envelope_impl(ctx):
    inputs = [ctx.file.manifest]
    mapping = {}
    for target, destination in ctx.attr.entries.items():
        files = target[DefaultInfo].files.to_list()
        if JsInfo in target:
            files += target[JsInfo].types.to_list()
        for file in depset(files).to_list():
            entry = destination
            if destination.endswith("/"):
                output_prefix = target.label.package + "/" + destination
                if not file.short_path.startswith(output_prefix):
                    fail("compiled query output %s is outside declared package output prefix %s" % (file.short_path, output_prefix))
                entry += file.short_path[len(output_prefix):]
            if entry in mapping:
                fail("duplicate package entry: " + entry)
            mapping[entry] = file.path
            inputs.append(file)
    specification = ctx.actions.declare_file(ctx.label.name + ".entries.json")
    ctx.actions.write(specification, json.encode(mapping))
    output = ctx.actions.declare_file(ctx.attr.out)
    args = ctx.actions.args()
    args.add(ctx.attr.format)
    args.add(output)
    args.add(ctx.file.manifest)
    args.add(specification)
    if ctx.file.workspace_manifest:
        args.add(ctx.file.workspace_manifest)
        inputs.append(ctx.file.workspace_manifest)
    bun_file_action(
        ctx,
        entry_point = ctx.file._packager,
        arguments = [args],
        inputs = depset(inputs + [specification, ctx.file._packager] + ctx.files._archive_helpers),
        source_files = [ctx.file._packager] + ctx.files._archive_helpers,
        outputs = [output],
        mnemonic = "QueryEnvelope",
        progress_message = "Packaging query %s %s" % (ctx.attr.format, ctx.label),
    )
    return [DefaultInfo(files = depset([output]))]

query_envelope = rule(
    implementation = _envelope_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "entries": attr.label_keyed_string_dict(allow_files = True),
        "format": attr.string(mandatory = True, values = ["npm", "crate"]),
        "manifest": attr.label(mandatory = True, allow_single_file = True),
        "workspace_manifest": attr.label(allow_single_file = True),
        "out": attr.string(mandatory = True),
        "_packager": attr.label(default = "//build_defs/query:package.mts", allow_single_file = True),
        "_archive_helpers": attr.label_list(default = ["//:tools/packaging/archive-directory.mts", "//:tools/packaging/portable-archive.mts"], allow_files = True),
    },
)

def _npm_consumer_test_impl(ctx):
    node = ctx.toolchains[_NODE_TOOLCHAIN].nodeinfo.node
    if not node:
        fail("query consumer tests require the pinned Node toolchain")
    files = [ctx.file.archive, ctx.file.consumer, ctx.file._runner, node]
    return bun_test_entrypoint(ctx, ctx.file._runner, [ctx.file.archive, ctx.file.consumer, node], files, source_files = [ctx.file._runner])

_npm_consumer_test = rule(
    implementation = _npm_consumer_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE_TOOLCHAIN],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "archive": attr.label(mandatory = True, allow_single_file = True),
        "consumer": attr.label(mandatory = True, allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/query:consumer-test.mts", allow_single_file = True),
    }),
)

def npm_consumer_test(name, args = [], **kwargs):
    _npm_consumer_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)

def _cargo_consumer_test_impl(ctx):
    rust = ctx.toolchains[_RUST_TOOLCHAIN]
    if not rust.cargo:
        fail("installed query consumer tests require Cargo from the pinned Rust toolchain")
    cc = cargo_test_toolchain(ctx)
    link_configuration = cc.configuration
    arguments = [ctx.file.archive, ctx.file.manifest, ctx.file.source, rust.cargo, rust.rustc, rust.rust_doc, link_configuration]
    files = [ctx.file.archive, ctx.file.manifest, ctx.file.source, ctx.file._runner, ctx.file._archive_helper, ctx.file._cargo_environment, link_configuration] + rust.all_files.to_list() + cc.files
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments, files, source_files = [ctx.file._runner, ctx.file._archive_helper, ctx.file._cargo_environment], runfiles_argument = True)

_cargo_consumer_test = rule(
    implementation = _cargo_consumer_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_RUST_TOOLCHAIN] + use_cc_toolchain(),
    fragments = ["cpp"],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "archive": attr.label(mandatory = True, allow_single_file = True),
        "manifest": attr.label(mandatory = True, allow_single_file = [".toml"]),
        "source": attr.label(mandatory = True, allow_single_file = [".rs"]),
        "_runner": attr.label(default = "//build_defs/query:cargo-consumer-test.mts", allow_single_file = True),
        "_archive_helper": attr.label(default = "//:tools/packaging/portable-archive.mts", allow_single_file = True),
        "_cargo_environment": attr.label(default = "//build_defs/languages:cargo-environment.mts", allow_single_file = True),
    }),
)

def cargo_consumer_test(name, args = [], **kwargs):
    _cargo_consumer_test(name = name, args = bun_test_entrypoint_args(name) + args, **kwargs)
