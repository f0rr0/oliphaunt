"""Bounded typed export and memory sealing of the native postmaster modules."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_file_action", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/wasix:wasm.bzl", "WasmModuleInfo")
load(":aot.bzl", "PostmasterModulesInfo", "postmaster_module_outputs")

def _seal_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name)
    spec = ctx.actions.declare_file(ctx.label.name + ".json")
    modules = postmaster_module_outputs(ctx, ctx.attr.module_paths)
    main = ctx.attr.main[WasmModuleInfo].module
    initdb = ctx.attr.initdb[WasmModuleInfo].module
    policies = {"mandatory": ctx.file.mandatory_policy, "dlsym": ctx.file.dlsym_policy, "sides": ctx.file.side_policy}
    tools = {"sealer": ctx.executable._sealer, "memory": ctx.executable._memory, "start": ctx.executable._start, "wasmOpt": ctx.executable._optimizer, "wasmDis": ctx.executable._disassembler}
    ctx.actions.write(spec, json.encode({
        "moduleOutputs": {path: file.path for path, file in modules.items()},
        "main": main.path,
        "initdb": initdb.path,
        "sides": [file.path for file in ctx.files.sides],
        "policies": {key: file.path for key, file in policies.items()},
        "tools": {key: file.path for key, file in tools.items()},
    }))
    arguments = ctx.actions.args()
    arguments.add_all([spec, output.path])
    bun_file_action(
        ctx,
        ctx.file._writer,
        source_files = [ctx.file._writer] + ctx.files._writer_sources,
        arguments = [arguments],
        inputs = [spec, main, initdb] + ctx.files.sides + policies.values() + ctx.files.abi_check,
        tools = [ctx.attr._sealer[DefaultInfo].files_to_run, ctx.attr._memory[DefaultInfo].files_to_run, ctx.attr._start[DefaultInfo].files_to_run] + ctx.files._binaryen_files,
        outputs = [output] + modules.values(),
        mnemonic = "PostmasterSealModules",
        progress_message = "Seal and verify exact postmaster module closure %{label}",
        resource_set = _resources,
    )
    return [DefaultInfo(files = depset([output])), PostmasterModulesInfo(modules = modules)]

def _resources(_os, _input_count):
    return {"cpu": 2, "memory": 2048}

postmaster_seal_modules = rule(
    implementation = _seal_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "module_paths": attr.string_list(mandatory = True),
        "main": attr.label(mandatory = True, providers = [WasmModuleInfo]),
        "initdb": attr.label(mandatory = True, providers = [WasmModuleInfo]),
        "sides": attr.label(mandatory = True, allow_files = True),
        "abi_check": attr.label(mandatory = True, allow_files = True),
        "mandatory_policy": attr.label(default = "//src/wasix/postmaster:wasmer/policies/sealed-main-runtime-exports.v1.txt", allow_single_file = True),
        "dlsym_policy": attr.label(default = "//src/wasix/postmaster:wasmer/policies/sealed-main-dlsym-exports.v1.txt", allow_single_file = True),
        "side_policy": attr.label(default = "//src/wasix/postmaster:wasmer/policies/sealed-side-modules.v1.tsv", allow_single_file = True),
        "_writer": attr.label(default = "//build_defs/wasix/postmaster:seal-modules.mts", allow_single_file = True),
        "_writer_sources": attr.label_list(default = [
            "//:tools/packaging/strict-json.mts",
            "//build_defs/wasix/postmaster:guest-inputs.mts",
            "//build_defs/wasix/postmaster:native-receipts.mts",
            "//src/wasix/postmaster:lib/linear-memory-profile.mts",
            "//src/wasix/postmaster:lib/receipt-files.mts",
            "//src/wasix/postmaster:lib/sealed-export-chain.mts",
            "//src/wasix/postmaster:wasmer/bin/verify-postmaster-wasm-import.mts",
            "//src/wasix/postmaster:wasmer/bin/verify-postmaster-concurrency-contract.mts",
        ], allow_files = True),
        "_sealer": attr.label(default = "//src/wasix/postmaster/tools/sealed-export-closure:sealed_export_closure", executable = True, cfg = "exec"),
        "_memory": attr.label(default = "//src/wasix/postmaster:memory_profile", executable = True, cfg = "exec"),
        "_start": attr.label(default = "//src/wasix/postmaster:start_proof", executable = True, cfg = "exec"),
        "_optimizer": attr.label(default = "@wasix_toolchain//:binaryen/bin/wasm-opt", executable = True, allow_single_file = True, cfg = "exec"),
        "_disassembler": attr.label(default = "@wasix_toolchain//:binaryen/bin/wasm-dis", executable = True, allow_single_file = True, cfg = "exec"),
        "_binaryen_files": attr.label(default = "@wasix_toolchain//:binaryen_files", cfg = "exec"),
    },
)

def _profile_test_impl(ctx):
    seed = ctx.attr.main[WasmModuleInfo].module
    sealed = ctx.file.sealed
    if not sealed.is_directory:
        fail("Postmaster profile qualification requires the real sealed module tree")
    return bun_test_entrypoint(ctx, runner = ctx.file._runner, arguments = [seed, sealed, ctx.file.profile], files = [seed, sealed, ctx.file.profile], source_files = [ctx.file._runner] + ctx.files._sources)

_postmaster_sealed_profile_test = rule(
    implementation = _profile_test_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "main": attr.label(mandatory = True, providers = [WasmModuleInfo]),
        "sealed": attr.label(mandatory = True, allow_single_file = True),
        "profile": attr.label(default = "@postmaster_cargo//:qualification-profile.json", allow_single_file = True),
        "_runner": attr.label(default = "//build_defs/wasix/postmaster:sealed-profile-test.mts", allow_single_file = True),
        "_sources": attr.label_list(default = [
            "//:tools/packaging/strict-json.mts",
            "//src/wasix/postmaster:lib/receipt-files.mts",
            "//src/wasix/postmaster:wasmer/bin/verify-postmaster-wasm-import.mts",
            "//src/wasix/postmaster:wasmer/bin/verify-postmaster-concurrency-contract.mts",
        ], allow_files = True),
    }),
)

def postmaster_sealed_profile_test(name, **kwargs):
    _postmaster_sealed_profile_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)
