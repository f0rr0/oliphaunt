"""Expose only the current execution platform's canonical Wasmer LLVM files."""

def _exec_files_impl(ctx):
    return [DefaultInfo(files = depset(ctx.files.srcs), runfiles = ctx.runfiles(files = ctx.files.srcs))]

exec_files = rule(
    implementation = _exec_files_impl,
    attrs = {"srcs": attr.label_list(allow_files = True, cfg = "exec", mandatory = True)},
)
