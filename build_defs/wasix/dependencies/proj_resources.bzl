"""Source-built execution SQLite database and target PROJ embedded data."""

load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("//build_defs/foundation:bun.bzl", "BunScriptInfo", "bun_action")

PROJ_DICTIONARY_FILES = ["proj.ini", "world", "other.extra", "nad27", "GL27", "nad83", "nad.lst", "CH", "ITRF2000", "ITRF2008", "ITRF2014", "ITRF2020"]

def _database_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + "/proj.db")
    args = ctx.actions.args()
    args.add("--source", ctx.file.root.dirname)
    args.add("--output", output)
    args.add("--sqlite", ctx.executable.sqlite)
    bun_action(
        ctx,
        ctx.attr._generator,
        tools = [ctx.attr.sqlite[DefaultInfo].files_to_run],
        inputs = ctx.files.inputs + [ctx.file.root],
        outputs = [output],
        arguments = [args],
        mnemonic = "WasixProjDatabase",
    )
    return [DefaultInfo(files = depset([output]))]

wasix_proj_database = rule(
    implementation = _database_impl,
    attrs = {
        "root": attr.label(default = "@postgis_proj//:CMakeLists.txt", allow_single_file = True),
        "inputs": attr.label_list(default = ["@postgis_proj//:all_sources"], allow_files = True),
        "sqlite": attr.label(default = "//build_defs/extensions/postgis:sqlite_cli", executable = True, cfg = "exec"),
        "_generator": attr.label(default = "//build_defs/extensions/postgis:proj_db", providers = [BunScriptInfo], cfg = "exec"),
    },
)

def _embed_impl(ctx):
    identifiers = ["proj_db"] + [name.replace(".", "_").replace("-", "_") for name in PROJ_DICTIONARY_FILES]
    outputs = [ctx.actions.declare_file(ctx.label.name + "/file_embed/" + name + suffix) for name in identifiers for suffix in [".c", ".h"]]
    dispatcher = ctx.actions.declare_file(ctx.label.name + "/file_embed/embedded_resources.c")
    outputs.append(dispatcher)
    root = dispatcher.dirname.rsplit("/", 1)[0]
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"output": root, "database": ctx.file.database.path, "resources": {file.basename: file.path for file in ctx.files.resources}}))
    args = ctx.actions.args()
    args.add("--spec", spec)
    bun_action(
        ctx,
        ctx.attr._generator,
        inputs = [spec, ctx.file.database] + ctx.files.resources,
        outputs = outputs,
        arguments = [args],
        mnemonic = "WasixProjEmbed",
    )
    return [
        DefaultInfo(files = depset(outputs)),
        OutputGroupInfo(library_sources = depset([file for file in outputs if file.basename.endswith(".c") and file != dispatcher])),
        CcInfo(compilation_context = cc_common.create_compilation_context(headers = depset(outputs), includes = depset([root]))),
    ]

wasix_proj_embed = rule(
    implementation = _embed_impl,
    attrs = {
        "database": attr.label(allow_single_file = True, mandatory = True),
        "resources": attr.label_list(default = ["@postgis_proj//:data/" + name for name in PROJ_DICTIONARY_FILES], allow_files = True),
        "_generator": attr.label(default = "//build_defs/wasix/dependencies:proj_embed", providers = [BunScriptInfo], cfg = "exec"),
    },
)
