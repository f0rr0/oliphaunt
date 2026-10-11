"""Compile the authentic postmaster roles using their separate Cargo contexts."""

load("@postmaster_compile_metadata//:cargo.bzl", "POSTMASTER_CARGO")
load("@postmaster_compiler_crates//:defs.bzl", compiler_aliases = "aliases", compiler_deps = "all_crate_deps")
load("@postmaster_executor_crates//:defs.bzl", executor_aliases = "aliases", executor_deps = "all_crate_deps")
load("@rules_rust//cargo:defs.bzl", "cargo_toml_env_vars")
load("@rules_rust//rust:defs.bzl", "rust_binary", "rust_library", "rust_test")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load(":runtime-abi.bzl", "postmaster_runtime_abi")

def _version_test_impl(ctx):
    binary = ctx.attr.binary[DefaultInfo].files_to_run.executable
    result = bun_test_entrypoint(
        ctx,
        runner = ctx.file._runner,
        arguments = [binary, ctx.file.manifest, ctx.attr.role],
        files = [binary, ctx.file.manifest],
        source_files = [ctx.file._runner],
        additional_runfiles = ctx.attr.binary[DefaultInfo].default_runfiles,
    )
    return result + ([ctx.attr.binary[RunEnvironmentInfo]] if RunEnvironmentInfo in ctx.attr.binary else [])

_version_test = rule(
    implementation = _version_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "binary": attr.label(mandatory = True, executable = True, cfg = "target"),
        "manifest": attr.label(default = "//src/wasix/postmaster:executor/Cargo.toml", allow_single_file = True),
        "role": attr.string(mandatory = True, values = ["executor", "compiler"]),
        "_runner": attr.label(default = "//build_defs/wasix/postmaster:version-test.mts", allow_single_file = True),
    }),
)

def postmaster_rust_targets(library_sources):
    cargo_toml_env_vars(name = "cargo_env", src = "executor/Cargo.toml")
    postmaster_runtime_abi(
        name = "runtime_abi",
        executor_deps = executor_deps(normal = True, package_name = ""),
        compiler_deps = compiler_deps(normal = True, package_name = ""),
        patches = POSTMASTER_CARGO["patches"],
        root_sources = library_sources + ["executor/" + facts["source"] for facts in POSTMASTER_CARGO["roles"].values()],
    )
    for role, dependencies, aliases in [
        ("executor", executor_deps, executor_aliases),
        ("compiler", compiler_deps, compiler_aliases),
    ]:
        facts = POSTMASTER_CARGO["roles"][role]
        normal = dependencies(normal = True, package_name = "")
        macros = dependencies(proc_macro = True, package_name = "")
        env = [":cargo_env", ":runtime_abi"]
        rust_library(
            name = role + "_library",
            srcs = library_sources,
            crate_root = "executor/" + POSTMASTER_CARGO["library"],
            crate_name = POSTMASTER_CARGO["crate_name"],
            edition = POSTMASTER_CARGO["edition"],
            version = POSTMASTER_CARGO["version"],
            crate_features = facts["features"],
            deps = normal,
            proc_macro_deps = macros,
            aliases = aliases(package_name = ""),
            rustc_env_files = env,
            tags = ["manual"],
        )
        # LLVM22's native archives have the same internal 2.34 construction
        # floor as the maintained serializer; the public executor is separate.
        compatible = ["@platforms//os:linux", "@platforms//cpu:x86_64", "@zig_sdk//libc:gnu.2.34"] if role == "compiler" else []
        rust_binary(
            name = role,
            binary_name = facts["binary"],
            srcs = ["executor/" + facts["source"]],
            crate_root = "executor/" + facts["source"],
            crate_name = facts["binary"].replace("-", "_"),
            edition = POSTMASTER_CARGO["edition"],
            version = POSTMASTER_CARGO["version"],
            crate_features = facts["features"],
            deps = [":" + role + "_library"] + normal,
            proc_macro_deps = macros,
            aliases = aliases(package_name = ""),
            rustc_env_files = env,
            experimental_use_cc_common_link = 1 if role == "compiler" else -1,
            target_compatible_with = compatible,
            tags = ["manual"],
        )
        # The conventional library unit lane is the compiler-free product role.
        if role == "executor":
            rust_test(
                name = role + "_unit_test",
                crate = ":" + role + "_library",
                crate_features = facts["features"],
                deps = dependencies(normal_dev = True, package_name = ""),
                proc_macro_deps = dependencies(proc_macro_dev = True, package_name = ""),
                aliases = aliases(normal = True, normal_dev = True, proc_macro = True, proc_macro_dev = True, package_name = ""),
                rustc_env_files = env,
                tags = ["manual"],
                size = "small",
            )
        _version_test(
            name = role + "_version_test",
            binary = ":" + role,
            role = role,
            args = bun_test_entrypoint_args(role + "_version_test"),
            target_compatible_with = compatible,
            tags = ["manual"],
            size = "small",
        )
