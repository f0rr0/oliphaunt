"""Build PROJ's canonical data SQL with the source-built execution SQLite."""

load("//build_defs/extensions:platforms.bzl", NATIVE_EXTENSION_COMPATIBLE = "NATIVE_EXTENSION_LINUX_COMPATIBLE")
load("//build_defs/foundation:bun.bzl", "BunScriptInfo", "bun_action")

def _impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + "/proj.db")
    args = ctx.actions.args()
    args.add("--source", ctx.file.root.dirname)
    args.add("--output", output)
    args.add("--sqlite", ctx.executable.sqlite)
    bun_action(ctx, ctx.attr._generator,
                    tools = [ctx.attr.sqlite[DefaultInfo].files_to_run],
                    inputs = ctx.files.inputs + [ctx.file.root], outputs = [output],
                    arguments = [args], mnemonic = "ProjDatabase")
    return [DefaultInfo(files = depset([output]))]

_proj_database = rule(
    implementation = _impl,
    attrs = {
        "root": attr.label(allow_single_file = True, mandatory = True),
        "inputs": attr.label_list(allow_files = True),
        "sqlite": attr.label(executable = True, cfg = "exec", mandatory = True),
        "_generator": attr.label(default = "//build_defs/extensions/postgis:proj_db", providers = [BunScriptInfo], cfg = "exec"),
    },
)

def proj_database(name):
    _proj_database(name = name, root = "@postgis_proj//:CMakeLists.txt",
                   inputs = ["@postgis_proj//:all_sources"], sqlite = "//build_defs/extensions/postgis:sqlite_cli",
                   target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
