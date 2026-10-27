"""Declared primitive probes for the exact postmaster compiler/runtime boundary."""

load("@rules_cc//cc:defs.bzl", "cc_library")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/foundation:bun-sources.bzl", "bun_source_tree")
load("//build_defs/wasix:wasm.bzl", "WasmModuleInfo", "wasix_module")

def _executor_configuration(_settings, _attr):
    return {"//command_line_option:platforms": [str(Label("//build_defs/native:linux_x86_64_glibc_2_28"))], "//command_line_option:compilation_mode": "opt"}

_EXECUTOR_CONFIGURATION = transition(implementation = _executor_configuration, inputs = [], outputs = ["//command_line_option:platforms", "//command_line_option:compilation_mode"])

def _probe_impl(ctx):
    source = ctx.attr.module[WasmModuleInfo].module
    module = ctx.actions.declare_file(ctx.label.name + ".assets/probe.wasm")
    memory_receipt = ctx.actions.declare_file(ctx.label.name + ".assets/memory.json")
    artifact = ctx.actions.declare_file(ctx.label.name + ".assets/probe.bin")
    receipt = ctx.actions.declare_file(ctx.label.name + ".assets/aot.json")
    ctx.actions.run(
        executable = ctx.executable._memory,
        arguments = ["seal", "--output", module.path, "--receipt", memory_receipt.path, source.path],
        inputs = [source],
        outputs = [module, memory_receipt],
        mnemonic = "PostmasterProbeMemory",
    )
    bun_file_action(
        ctx,
        ctx.file._aot,
        source_files = [ctx.file._aot],
        sources = bun_source_tree(ctx, ctx.label.name + ".aot-sources", [ctx.file._aot]),
        arguments = [ctx.executable._compiler.path, ctx.file._abi.path, module.dirname, module.basename, artifact.path, receipt.path],
        inputs = [module, ctx.file._abi],
        tools = [ctx.attr._compiler[DefaultInfo].files_to_run],
        outputs = [artifact, receipt],
        mnemonic = "PostmasterProbeLlvmAot",
    )
    probe = ctx.attr._probe[0]
    executable = probe[DefaultInfo].files_to_run.executable
    return bun_test_entrypoint(
        ctx,
        runner = ctx.file._runner,
        arguments = [executable, module, artifact, ctx.attr.expected],
        files = [executable, module, artifact, receipt, memory_receipt],
        source_files = [ctx.file._runner],
        additional_runfiles = probe[DefaultInfo].default_runfiles,
    )

_probe_test = rule(
    implementation = _probe_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "module": attr.label(mandatory = True, providers = [WasmModuleInfo]),
        "expected": attr.string(mandatory = True),
        "_probe": attr.label(default = "//src/wasix/postmaster:runtime_probe", cfg = _EXECUTOR_CONFIGURATION),
        "_memory": attr.label(default = "//src/wasix/postmaster:memory_profile", cfg = "exec", executable = True),
        "_compiler": attr.label(default = "//src/wasix/postmaster:compiler", cfg = "exec", executable = True),
        "_abi": attr.label(default = "//src/wasix/postmaster:runtime_abi_contract", cfg = "exec", allow_single_file = True),
        "_aot": attr.label(default = "//build_defs/wasix/postmaster:aot.mts", allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/wasix/postmaster:runtime-probe-test.mts", allow_single_file = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    }),
)

def postmaster_runtime_probes():
    compatible = ["@platforms//cpu:wasm32", "@platforms//os:wasi"]
    for name, source, expected in [
        ("sjlj", "wasm_eh_sjlj_probe.c", "sjlj-ok plain=7 signal=1"),
        ("vfork", "dynamic_vfork_exec_probe.c", "parent_value=7"),
    ]:
        cc_library(
            name = name + "_probe_objects",
            srcs = ["//src/wasix/postmaster:wasmer/probes/" + source],
            deps = ["@postmaster_wasix_libc//:sysroot"],
            copts = ["-std=gnu11", "-O3", "-g0", "-flto=thin", "-fPIC", "-pthread", "-nostdinc", "-isystem", Label("@wasix_toolchain//:llvm/bin/clang").workspace_root + "/llvm/lib/clang/21/include"],
            target_compatible_with = compatible,
        )
        wasix_module(
            name = name + "_probe_wasm",
            kind = "command",
            output_name = name + ".wasm",
            object_deps = [":" + name + "_probe_objects"],
            constructed_sysroot = "@postmaster_wasix_libc//:sysroot",
            linkopts = ["-Bsymbolic"],
            optimization_flags = ["--enable-threads", "--enable-mutable-globals", "--enable-bulk-memory", "--enable-exception-handling", "--emit-exnref", "--strip-debug", "--strip-producers"],
            target_compatible_with = compatible,
        )
        _probe_test(
            name = name + "_runtime_probe_test",
            module = ":" + name + "_probe_wasm",
            expected = expected,
            args = bun_test_entrypoint_args(name + "_runtime_probe_test"),
            target_compatible_with = compatible,
            exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64", "@zig_sdk//libc:gnu.2.34"],
            tags = ["manual"],
            size = "small",
        )
