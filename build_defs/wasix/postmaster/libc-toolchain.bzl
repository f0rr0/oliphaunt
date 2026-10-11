"""Raw pinned Clang for the canonical libc bootstrap C profile."""

load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("@rules_cc//cc:cc_toolchain_config_lib.bzl", "action_config", "feature", "flag_group", "flag_set", "tool")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")

_COMPILE = [ACTION_NAMES.c_compile, ACTION_NAMES.cpp_compile, ACTION_NAMES.assemble, ACTION_NAMES.preprocess_assemble, ACTION_NAMES.linkstamp_compile]

def _config_impl(ctx):
    llvm = ctx.file.compiler.dirname.rsplit("/", 1)[0]
    return [cc_common.create_cc_toolchain_config_info(
        ctx = ctx,
        toolchain_identifier = "oliphaunt-postmaster-patched-libc-clang",
        host_system_name = "x86_64-unknown-linux-gnu",
        target_system_name = "wasm32-wasi",
        target_cpu = "wasm32",
        target_libc = "wasix",
        compiler = "clang",
        abi_version = "wasm32",
        abi_libc_version = "wasix",
        action_configs = [action_config(action_name = action, enabled = True, tools = [tool(tool = ctx.file.compiler)]) for action in _COMPILE] + [action_config(action_name = ACTION_NAMES.cpp_link_static_library, enabled = True, tools = [tool(tool = ctx.file.archiver)])],
        features = [
            feature(name = "supports_pic", enabled = True),
            feature(name = "prefer_pic_for_opt_binaries", enabled = True),
            feature(name = "target", enabled = True, flag_sets = [flag_set(actions = _COMPILE, flag_groups = [flag_group(flags = ["--target=wasm32-wasi", "-no-canonical-prefixes", "-resource-dir=" + llvm + "/lib/clang/21"])])]),
        ],
        cxx_builtin_include_directories = [llvm + "/lib/clang/21/include"],
    )]

libc_cc_toolchain_config = rule(
    implementation = _config_impl,
    attrs = {
        "compiler": attr.label(default = "@wasix_toolchain//:llvm/bin/clang", allow_single_file = True),
        "archiver": attr.label(default = "@wasix_toolchain//:llvm/bin/llvm-ar", allow_single_file = True),
    },
)

def _libc_impl(_settings, _attr):
    return {"//command_line_option:platforms": [str(Label("//build_defs/wasix/postmaster/libc_toolchain:construction"))]}

LIBC_CONSTRUCTION_TRANSITION = transition(
    implementation = _libc_impl,
    inputs = [],
    outputs = ["//command_line_option:platforms"],
)
