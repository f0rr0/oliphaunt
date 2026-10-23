"""Schedule exact package prerequisites by SDK without changing their actions."""

def apple_slice_groups(targets):
    """Union the selected slice Files already consumed by these producers."""
    groups = {}
    for target in targets:
        if OutputGroupInfo not in target:
            continue
        info = target[OutputGroupInfo]
        for name in dir(info):
            if name.startswith("apple_slice_"):
                groups.setdefault(name, []).append(getattr(info, name))
    return {name: depset(transitive = files) for name, files in groups.items()}

def _alias_impl(ctx):
    source = ctx.attr.src
    files = getattr(source[OutputGroupInfo], ctx.attr.output_group)
    return [
        DefaultInfo(files = files, runfiles = ctx.runfiles(transitive_files = files)),
        OutputGroupInfo(**apple_slice_groups([source])),
    ]

# Use only for outputs of a constructor that consumes every forwarded slice.
# Compiler-output aliases can bypass that constructor and must use filegroup.
apple_slice_filegroup = rule(
    implementation = _alias_impl,
    attrs = {
        "src": attr.label(mandatory = True),
        "output_group": attr.string(mandatory = True),
    },
)
