"""Run stock Rust test binaries against the exact final native carrier Files."""

load("//build_defs/extensions:extensions.bzl", "ExtensionMemberInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

def _impl(ctx):
    binary = ctx.attr.binary[DefaultInfo].files_to_run.executable
    members = [target[ExtensionMemberInfo] for target in ctx.attr.extensions]
    names = [member.sql_name for member in members]
    if len({name: True for name in names}) != len(names) or names != sorted(names):
        fail("Rust extension lifecycle requires unique, sorted canonical members")
    if any([member.configuration != "linux-x64-gnu" for member in members]):
        fail("Rust extension lifecycle requires actual Linux x64 member Files")
    archives = [member.archive for member in members]
    arguments = [binary, ctx.file.runtime, ctx.file.tools, ctx.file.broker, json.encode(ctx.attr.test_args), json.encode(ctx.attr.environment), json.encode(names), ctx.workspace_name] + archives
    sources = [ctx.file._runner] + ctx.files._helpers
    result = bun_test_entrypoint(ctx, ctx.file._runner, arguments, arguments[:4] + archives + sources, source_files = sources, runfiles_argument = True, additional_runfiles = ctx.attr.binary[DefaultInfo].default_runfiles)
    if RunEnvironmentInfo in ctx.attr.binary:
        result.append(ctx.attr.binary[RunEnvironmentInfo])
    return result

_native_rust_runtime_test = rule(
    implementation = _impl,
    test = True,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "binary": attr.label(mandatory = True, executable = True, cfg = "target"),
        "runtime": attr.label(default = Label("//src/native/runtime:github_archive"), allow_single_file = True),
        "tools": attr.label(default = Label("//src/native/postgres-tools:github_archive"), allow_single_file = True),
        "broker": attr.label(default = Label("//src/native/broker:github_archive"), allow_single_file = True),
        "test_args": attr.string_list(default = ["--test-threads=1", "--nocapture"]),
        "environment": attr.string_dict(),
        "extensions": attr.label_list(providers = [ExtensionMemberInfo]),
        "_runner": attr.label(default = Label("//build_defs/native:rust-runtime-test.mts"), allow_single_file = True),
        "_helpers": attr.label_list(default = [Label("//build_defs/native:host-runtime-test-helpers.mts"), Label("//:tools/packaging/portable-archive.mts"), Label("//:tools/packaging/release-directory-safety.mts")], allow_files = True),
    }),
    toolchains = BUN_SOURCE_TOOLCHAINS,
)

def native_rust_runtime_test(name, **kwargs):
    _native_rust_runtime_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)
