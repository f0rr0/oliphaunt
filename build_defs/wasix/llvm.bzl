"""Expose only the current execution platform's canonical Wasmer LLVM files."""

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
