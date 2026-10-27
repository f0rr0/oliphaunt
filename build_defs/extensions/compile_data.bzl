"""Project exact authored compile data alongside generated crate sources."""

def _compile_data_impl(ctx):
    output = ctx.actions.declare_file(ctx.file.src.basename)
    ctx.actions.symlink(output = output, target_file = ctx.file.src)
    return [DefaultInfo(files = depset([output]))]

extension_compile_data = rule(
    implementation = _compile_data_impl,
    attrs = {"src": attr.label(allow_single_file = True, mandatory = True)},
)
