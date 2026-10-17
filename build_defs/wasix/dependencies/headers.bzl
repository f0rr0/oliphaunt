"""Declared upstream-template configuration for the actual WASI LP32 profile."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_DEPENDENCIES", "EXTENSION_SOURCES", "POSTGRES_SOURCE")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("//build_defs/foundation:bun.bzl", "BunScriptInfo", "bun_action")

def _impl(ctx):
    outputs = [ctx.actions.declare_file(ctx.label.name + "/" + path) for path in ctx.attr.outs]
    root = outputs[0].path[:-len(ctx.attr.outs[0])].rstrip("/")
    args = ctx.actions.args()
    args.add("--kind", ctx.attr.kind)
    args.add("--source", ctx.file.root.dirname)
    args.add("--output", root)
    inputs = ctx.files.inputs + [ctx.file.root]
    if ctx.attr.kind == "postgis":
        source = EXTENSION_SOURCES["postgis"]
        identity = ctx.actions.declare_file(ctx.label.name + ".identity.json")
        ctx.actions.write(identity, json.encode({
            "commit": source["commit"],
            "source_date_epoch": source["source_date_epoch"],
            "default_version": source["extension-control"]["default-version"],
            "postgres_major": int(POSTGRES_SOURCE["postgresql"]["version"].split(".")[0]),
            "postgres_version": POSTGRES_SOURCE["postgresql"]["version"],
            "dependencies": EXTENSION_DEPENDENCIES["postgis"],
        }))
        args.add("--identity", identity)
        inputs.append(identity)
    bun_action(
        ctx,
        ctx.attr._generator,
        inputs = inputs,
        outputs = outputs,
        arguments = [args],
        mnemonic = "WasixDependencyConfig",
    )
    return [
        DefaultInfo(files = depset(outputs)),
        OutputGroupInfo(control = depset([file for file in outputs if file.basename.endswith(".control")])),
        CcInfo(compilation_context = cc_common.create_compilation_context(
            headers = depset(outputs),
            includes = depset([root + ("/" + directory if directory else "") for directory in ctx.attr.include_dirs]),
        )),
    ]

wasix_dependency_headers = rule(
    implementation = _impl,
    attrs = {
        "kind": attr.string(mandatory = True),
        "root": attr.label(allow_single_file = True, mandatory = True),
        "inputs": attr.label_list(allow_files = True),
        "outs": attr.string_list(mandatory = True),
        "include_dirs": attr.string_list(default = [""]),
        "_generator": attr.label(default = "//build_defs/wasix/dependencies:configure_headers", providers = [BunScriptInfo], cfg = "exec"),
    },
)
