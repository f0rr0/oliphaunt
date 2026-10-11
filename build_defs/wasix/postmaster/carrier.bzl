"""Assemble the native headless carrier from exact declared physical outputs."""

load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

def _executor_configuration(_settings, _attr):
    return {"//command_line_option:platforms": [str(Label("//build_defs/native:linux_x86_64_glibc_2_28"))], "//command_line_option:compilation_mode": "opt"}

_EXECUTOR_CONFIGURATION = transition(implementation = _executor_configuration, inputs = [], outputs = ["//command_line_option:platforms", "//command_line_option:compilation_mode"])

def _carrier_impl(ctx):
    output = ctx.actions.declare_directory(ctx.label.name)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    executor_target = ctx.attr._executor[0]
    executor = executor_target[DefaultInfo].files_to_run.executable
    trees = [ctx.file.sealed, ctx.file.sysroot]
    resources = []
    inputs = [executor, ctx.file._executor_abi, ctx.file._compiler_abi, ctx.executable._compiler, ctx.file.source, ctx.file.series, ctx.file.libc_source, ctx.file.libc_patch, ctx.file.wasmer_patch, ctx.file.clang]
    for target, destination in ctx.attr.resources.items():
        for file in target[DefaultInfo].files.to_list():
            resources.append({"source": file.path, "destination": destination + (file.basename if destination.endswith("/") and not file.is_directory else ""), "tree": file.is_directory})
            if file.is_directory:
                trees.append(file)
            else:
                inputs.append(file)
    ctx.actions.write(spec, json.encode({
        "sealed": ctx.file.sealed.path,
        "sysroot": ctx.file.sysroot.path,
        "executor": executor.path,
        "executorAbi": ctx.file._executor_abi.path,
        "compilerAbi": ctx.file._compiler_abi.path,
        "compiler": ctx.executable._compiler.path,
        "aot": [file.path for file in ctx.files.aot],
        "aotReceipts": [file.path for file in ctx.files.aot_receipts],
        "resources": resources,
        "source": ctx.file.source.path,
        "series": ctx.file.series.path,
        "patches": {file.short_path: file.path for file in ctx.files.patches},
        "overlays": {file.short_path.removeprefix("src/wasix/postmaster/postgres/overlays/wasix-core/"): file.path for file in ctx.files.overlays},
        "configuration": {file.basename: file.path for file in ctx.files.configuration},
        "libcSource": ctx.file.libc_source.path,
        "libcPatch": ctx.file.libc_patch.path,
        "wasmerPatch": ctx.file.wasmer_patch.path,
        "clang": ctx.file.clang.path,
    }))
    arguments = ctx.actions.args()
    arguments.add_all([spec, output], expand_directories = False)
    leaves = ctx.actions.args()
    leaves.add_all(trees, expand_directories = True)
    leaves.use_param_file("--tree-files=%s", use_always = True)
    leaves.set_param_file_format("multiline")
    bun_file_action(
        ctx,
        ctx.file._writer,
        source_files = ctx.files._sources,
        arguments = [arguments, leaves],
        inputs = inputs + trees + [spec] + ctx.files.aot + ctx.files.aot_receipts + ctx.files.patches + ctx.files.overlays + ctx.files.configuration,
        tools = [executor_target[DefaultInfo].files_to_run, ctx.attr._compiler[DefaultInfo].files_to_run],
        outputs = [output],
        mnemonic = "PostmasterNativeCarrier",
        progress_message = "Assemble and validate exact native postmaster carrier %{label}",
    )
    return [DefaultInfo(files = depset([output]))]

postmaster_carrier = rule(
    implementation = _carrier_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "sealed": attr.label(mandatory = True, allow_single_file = True),
        "sysroot": attr.label(mandatory = True, allow_single_file = True),
        "aot": attr.label(mandatory = True, allow_files = True),
        "aot_receipts": attr.label(mandatory = True, allow_files = True),
        "resources": attr.label_keyed_string_dict(mandatory = True, allow_files = True),
        "configuration": attr.label(mandatory = True, allow_files = True),
        "patches": attr.label_list(mandatory = True, allow_files = [".patch"]),
        "overlays": attr.label(default = "//src/wasix/postmaster:postgres_overlays", allow_files = True),
        "source": attr.label(default = "//src/third-party/postgres:source.toml", allow_single_file = True),
        "series": attr.label(default = "//src/wasix/postmaster:postgres/series", allow_single_file = True),
        "libc_source": attr.label(default = "@postmaster_wasix_libc//:source.json", allow_single_file = True),
        "libc_patch": attr.label(default = "//src/wasix/postmaster:wasmer/patches/wasix-libc/0001-postgres-wasix-blockers.patch", allow_single_file = True),
        "wasmer_patch": attr.label(default = "//src/wasix/postmaster:wasmer/patches/wasmer/0001-postgres-wasix-blockers.patch", allow_single_file = True),
        "clang": attr.label(default = "@wasix_toolchain//:llvm/bin/clang", allow_single_file = True),
        "_executor": attr.label(default = "//src/wasix/postmaster:executor", cfg = _EXECUTOR_CONFIGURATION),
        "_executor_abi": attr.label(default = "//src/wasix/postmaster:runtime_abi_contract", allow_single_file = True, cfg = _EXECUTOR_CONFIGURATION),
        "_compiler": attr.label(default = "//src/wasix/postmaster:compiler", executable = True, cfg = "exec"),
        "_compiler_abi": attr.label(default = "//src/wasix/postmaster:runtime_abi_contract", allow_single_file = True, cfg = "exec"),
        "_writer": attr.label(default = "//build_defs/wasix/postmaster:carrier.mts", allow_single_file = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
        "_sources": attr.label_list(default = [
            "//build_defs/wasix/postmaster:native-receipts.mts",
            "//:tools/packaging/strict-json.mts",
            "//src/wasix/postmaster:lib/build-sealed-carrier.mts",
            "//src/wasix/postmaster:lib/verify-sealed-carrier.mts",
            "//src/wasix/postmaster:lib/guest-build-provenance.mts",
            "//src/wasix/postmaster:lib/receipt-files.mts",
            "//src/wasix/postmaster:lib/linear-memory-profile.mts",
            "//src/wasix/postmaster:lib/sealed-export-chain.mts",
            "//src/wasix/postmaster:wasmer/bin/verify-postmaster-concurrency-contract.mts",
            "//src/wasix/postmaster:wasmer/bin/verify-postmaster-wasm-import.mts",
            "//src/wasix/postmaster:wasmer/policies/sealed-side-modules.v1.tsv",
            "//src/wasix/postmaster:wasmer/policies/sealed-main-runtime-exports.v1.txt",
            "//src/wasix/postmaster:wasmer/policies/sealed-main-dlsym-exports.v1.txt",
        ], allow_files = True),
    },
)
