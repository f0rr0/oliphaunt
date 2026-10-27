"""Canonical native Windows Flex/Bison execution toolchains."""

load("@rules_bison//bison:providers.bzl", "BisonToolchainInfo")
load("@rules_flex//flex:providers.bzl", "FlexToolchainInfo")
load(":repositories.bzl", "source_string_values")

def _executable_impl(ctx):
    executable = ctx.actions.declare_file(ctx.label.name + ".exe")
    ctx.actions.symlink(output = executable, target_file = ctx.file.binary, is_executable = True)
    return [DefaultInfo(
        files = depset([executable]),
        executable = executable,
        runfiles = ctx.runfiles(files = [ctx.file.binary] + ctx.files.data),
    )]

windows_generator_executable = rule(
    implementation = _executable_impl,
    executable = True,
    attrs = {
        "binary": attr.label(mandatory = True, allow_single_file = [".exe"]),
        "data": attr.label_list(allow_files = True),
    },
)

def _toolchain_impl(ctx):
    tool = ctx.attr.tool[DefaultInfo].files_to_run
    files = depset([tool.executable], transitive = [ctx.attr.tool[DefaultInfo].default_runfiles.files])
    if ctx.attr.kind == "flex":
        info = FlexToolchainInfo(all_files = files, flex_tool = tool, flex_env = {}, flex_lexer_h = ctx.file.data_anchor)
        return [platform_common.ToolchainInfo(flex_toolchain = info, embedded_m4 = True)]
    info = BisonToolchainInfo(all_files = files, bison_tool = tool, bison_env = {"BISON_PKGDATADIR": ctx.file.data_anchor.dirname})
    return [platform_common.ToolchainInfo(bison_toolchain = info, embedded_m4 = True)]

windows_generator_toolchain = rule(
    implementation = _toolchain_impl,
    attrs = {
        "tool": attr.label(mandatory = True, executable = True, cfg = "exec"),
        "kind": attr.string(mandatory = True, values = ["flex", "bison"]),
        "data_anchor": attr.label(mandatory = True, allow_single_file = True),
    },
)

def _repository_impl(ctx):
    source = source_string_values(ctx.read(ctx.attr.manifest))
    # Use the same reviewed native Windows payload as development/CI setup.
    ctx.download_and_extract(url = source["url"], sha256 = source["sha256"])
    ctx.file("BUILD.bazel", """load(%s, "windows_generator_executable", "windows_generator_toolchain")
package(default_visibility = ["//visibility:public"])
exports_files(["FlexLexer.h", "data/README.md"])
windows_generator_executable(name = "flex", binary = %s, data = ["FlexLexer.h"])
windows_generator_executable(name = "bison", binary = %s, data = glob(["data/**"], allow_empty = False))
windows_generator_toolchain(name = "flex_info", kind = "flex", tool = ":flex", data_anchor = "FlexLexer.h")
windows_generator_toolchain(name = "bison_info", kind = "bison", tool = ":bison", data_anchor = "data/README.md")
toolchain(name = "flex_toolchain", toolchain = ":flex_info", toolchain_type = "@rules_flex//flex:toolchain_type", exec_compatible_with = ["@platforms//os:windows", "@platforms//cpu:x86_64"])
toolchain(name = "bison_toolchain", toolchain = ":bison_info", toolchain_type = "@rules_bison//bison:toolchain_type", exec_compatible_with = ["@platforms//os:windows", "@platforms//cpu:x86_64"])
""" % (repr(str(ctx.attr.definition)), repr(source["flex_path"]), repr(source["bison_path"])))
    return ctx.repo_metadata(reproducible = True)

windows_generators_repository = repository_rule(
    implementation = _repository_impl,
    attrs = {
        "manifest": attr.label(default = Label("//tools/dev:winflexbison.toml"), allow_single_file = True),
        "definition": attr.label(default = Label(":windows-generators.bzl"), allow_single_file = True),
    },
)
