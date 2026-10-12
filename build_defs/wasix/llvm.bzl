"""Expose only the current execution platform's canonical Wasmer LLVM files."""

load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")

def _exec_files_impl(ctx):
    return [DefaultInfo(files = depset(ctx.files.srcs), runfiles = ctx.runfiles(files = ctx.files.srcs))]

exec_files = rule(
    implementation = _exec_files_impl,
    attrs = {"srcs": attr.label_list(allow_files = True, cfg = "exec", mandatory = True)},
)

def _helper_runtime_impl(ctx):
    files = ctx.files.libraries
    names = {file.basename: True for file in files}
    if "libstdc++.so.6" not in names or "libgcc_s.so.1" not in names:
        fail("LLVM helper runtime requires declared GNU C++ and unwind SONAME files")
    directories = sorted({file.dirname: True for file in files}.keys())
    environment = ctx.actions.declare_file(ctx.label.name + ".env")
    ctx.actions.write(environment, "LD_LIBRARY_PATH=" + ":".join(["${pwd}/" + directory for directory in directories]) + "\n")
    return [
        DefaultInfo(files = depset([environment])),
        OutputGroupInfo(runtime_files = depset(files)),
    ]

llvm_helper_runtime = rule(
    implementation = _helper_runtime_impl,
    attrs = {"libraries": attr.label_list(allow_files = True, cfg = "exec", mandatory = True)},
)

# LLVM22 runs on glibc 2.34; its XML dependency can retain the qualified lower
# native ABI floor without expanding the published extension profiles.
def _arm64_libxml2_configuration(_settings, _attr):
    return {"//command_line_option:platforms": [str(Label("//build_defs/native:linux_aarch64_glibc_2_28"))]}

_ARM64_LIBXML2_CONFIGURATION = transition(implementation = _arm64_libxml2_configuration, inputs = [], outputs = ["//command_line_option:platforms"])

def _arm64_libxml2_impl(ctx):
    library = ctx.attr._library[0]
    return [library[DefaultInfo], library[CcInfo]]

llvm_libxml2_arm64 = rule(
    implementation = _arm64_libxml2_impl,
    attrs = {
        "_library": attr.label(default = "//build_defs/extensions/postgis:libxml2", providers = [CcInfo], cfg = _ARM64_LIBXML2_CONFIGURATION),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)
