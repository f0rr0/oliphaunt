"""Standard C/C++ toolchain using the pinned WASIX compiler driver."""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc:cc_toolchain_config_lib.bzl", "artifact_name_pattern", "env_entry", "env_set", "feature", "flag_group", "flag_set", "tool_path")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/toolchains:cc_toolchain_config_info.bzl", "CcToolchainConfigInfo")

_COMPILE = [ACTION_NAMES.c_compile, ACTION_NAMES.cpp_compile, ACTION_NAMES.assemble, ACTION_NAMES.preprocess_assemble, ACTION_NAMES.linkstamp_compile]
_LINK = [ACTION_NAMES.cpp_link_executable, ACTION_NAMES.cpp_link_dynamic_library, ACTION_NAMES.cpp_link_nodeps_dynamic_library]

def _wasix_cc_toolchain_config_impl(ctx):
    llvm = ctx.file.llvm_compiler.dirname.rsplit("/", 1)[0]
    binaryen = ctx.file.optimizer.dirname.rsplit("/", 1)[0]
    sysroot = ctx.file.sysroot_header.dirname.rsplit("/", 1)[0]
    environment = [
        env_entry(key = "WASIXCC_LLVM_LOCATION", value = llvm),
        env_entry(key = "WASIXCC_BINARYEN_LOCATION", value = binaryen),
        env_entry(key = "WASIXCC_SYSROOT_PREFIX", value = sysroot.rsplit("/", 1)[0]),
        env_entry(key = "WASIXCC_RUN_WASM_OPT", value = "no"),
    ]
    return [cc_common.create_cc_toolchain_config_info(
        ctx = ctx,
        toolchain_identifier = "oliphaunt-wasix-linux-x86_64",
        host_system_name = "x86_64-unknown-linux-gnu",
        target_system_name = "wasm32-wasix",
        target_cpu = "wasm32",
        target_libc = "wasix",
        compiler = "wasixcc",
        abi_version = "wasm32",
        abi_libc_version = "wasix-2026-03-02.1",
        builtin_sysroot = sysroot,
        cxx_builtin_include_directories = [sysroot + "/include", llvm + "/lib/clang/21/include"],
        features = [
            feature(name = "supports_pic", enabled = True),
            feature(name = "prefer_pic_for_opt_binaries", enabled = True),
            feature(name = "supports_dynamic_linker", enabled = True),
            feature(name = "wasix_environment", enabled = True, env_sets = [env_set(actions = _COMPILE + _LINK + [ACTION_NAMES.cpp_link_static_library], env_entries = environment)]),
            feature(name = "wasix_compile_flags", enabled = True, flag_sets = [
                flag_set(actions = _COMPILE + _LINK, flag_groups = [flag_group(flags = ["-sWASM_EXCEPTIONS=yes", "-sPIC=yes"])]),
                flag_set(actions = _COMPILE, flag_groups = [flag_group(flags = ["-Wno-unused-command-line-argument", "-no-canonical-prefixes", "-resource-dir=" + llvm + "/lib/clang/21"])]),
            ]),
        ],
        artifact_name_patterns = [artifact_name_pattern(category_name = "dynamic_library", prefix = "", extension = ".wasm")],
        tool_paths = [
            tool_path(name = "gcc", path = "bin/wasixcc"),
            tool_path(name = "cpp", path = "bin/wasixcc"),
            tool_path(name = "ar", path = "bin/wasixar"),
            tool_path(name = "ld", path = "bin/wasixld"),
            tool_path(name = "nm", path = "bin/wasixnm"),
            tool_path(name = "objdump", path = "llvm/bin/llvm-objdump"),
            tool_path(name = "strip", path = "llvm/bin/llvm-strip"),
            tool_path(name = "gcov", path = "llvm/bin/llvm-cov"),
        ],
    )]

wasix_cc_toolchain_config = rule(
    implementation = _wasix_cc_toolchain_config_impl,
    attrs = {
        "compiler": attr.label(allow_single_file = True, mandatory = True),
        "llvm_compiler": attr.label(allow_single_file = True, mandatory = True),
        "optimizer": attr.label(allow_single_file = True, mandatory = True),
        "sysroot_header": attr.label(allow_single_file = True, mandatory = True),
    },
    provides = [CcToolchainConfigInfo],
)
