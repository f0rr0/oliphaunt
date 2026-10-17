"""Native PostgreSQL resource generators with explicit inputs and exec tools."""

def _timezone_database_impl(ctx):
    output = ctx.actions.declare_directory(ctx.attr.name)
    ctx.actions.run(
        executable = ctx.executable.zic,
        arguments = ["-d", output.path] + (["-p", ctx.attr.posixrules] if ctx.attr.posixrules else []) + [ctx.file.source.path],
        inputs = [ctx.file.source],
        outputs = [output],
        mnemonic = "PostgresTimezone",
    )
    return [DefaultInfo(files = depset([output]))]

timezone_database = rule(
    implementation = _timezone_database_impl,
    attrs = {
        "source": attr.label(allow_single_file = True, mandatory = True),
        "zic": attr.label(executable = True, cfg = "exec", mandatory = True),
        "posixrules": attr.string(default = "US/Eastern"),
    },
)
