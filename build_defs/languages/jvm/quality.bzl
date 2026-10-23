"""Source-only Kotlin formatting with the conventional Spotless tool and scope."""

load("@oliphaunt_kotlin_manifest//:metadata.bzl", "KOTLIN_QUALITY")
load("@rules_java//java/common:java_info.bzl", "JavaInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

_JAVA_RUNTIME = "@bazel_tools//tools/jdk:runtime_toolchain_type"

def _ktlint_test_impl(ctx):
    runtime = ctx.toolchains[_JAVA_RUNTIME].java_runtime
    java = [file for file in runtime.files.to_list() if file.path == runtime.java_executable_exec_path]
    if len(java) != 1:
        fail("Kotlin formatter requires the declared Java runtime executable")
    jars = ctx.attr._ktlint[JavaInfo].transitive_runtime_jars.to_list()
    arguments = [java[0], json.encode(KOTLIN_QUALITY["ktlint"]["formats"])]
    for jar in jars:
        arguments += ["jar", jar]
    files = []
    for target, format_name in ctx.attr.srcs.items():
        for file in target[DefaultInfo].files.to_list():
            if not file.short_path.startswith(ctx.label.package + "/"):
                fail("Kotlin formatter source must belong to its declared SDK package")
            arguments += ["source", format_name, file.short_path[len(ctx.label.package) + 1:], file]
            files.append(file)
    return bun_test_entrypoint(ctx, ctx.file._runner, arguments, files + jars + runtime.files.to_list(), source_files = [ctx.file._runner])

_ktlint_test = rule(
    implementation = _ktlint_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_JAVA_RUNTIME],
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "srcs": attr.label_keyed_string_dict(allow_files = [".kt", ".kts"]),
        "_ktlint": attr.label(default = "@oliphaunt_kotlin_maven//:com_pinterest_ktlint_ktlint_cli", providers = [JavaInfo]),
        "_runner": attr.label(default = "//build_defs/languages/jvm:ktlint.mts", allow_single_file = True),
    }),
)

def kotlin_format_test(name, **kwargs):
    sources = {}
    for format in KOTLIN_QUALITY["ktlint"]["formats"]:
        for source in native.glob(format["targets"], allow_empty = False):
            if source in sources:
                fail("Conventional Kotlin formatter scopes overlap: " + source)
            sources[source] = format["name"]
    _ktlint_test(name = name, srcs = sources, args = bun_test_entrypoint_args(name), **kwargs)
