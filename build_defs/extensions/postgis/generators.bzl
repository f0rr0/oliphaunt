"""Upstream PostGIS scanner execution with its fixed outfile option preserved."""

def _flex_stdout_impl(ctx):
    flex = ctx.toolchains["@rules_flex//flex:toolchain_type"].flex_toolchain
    m4 = ctx.toolchains["@rules_m4//m4:toolchain_type"].m4_toolchain
    perl = ctx.toolchains["@rules_perl//perl:exec_toolchain_type"].perl_runtime
    if len(ctx.outputs.outs) != 1:
        fail("the upstream PostGIS scanner must declare exactly one C output")
    environment = dict(flex.flex_env)
    environment.update({
        "M4": m4.m4_tool.executable.path,
        "M4_SYSCMD_SHELL": ctx.executable._deny_shell.path,
        "PERL5LIB": "",
        "PERL5OPT": "",
    })
    # -t takes precedence over the upstream source's %option outfile. The
    # declared interpreter redirects stdout without editing that source or
    # invoking an ambient shell, matching the shared PostgreSQL Perl helper.
    ctx.actions.run(
        executable = perl.interpreter,
        arguments = perl.perlopt + [
            "-e",
            "open(STDOUT, q(>), shift @ARGV) or die $!; exec {$ARGV[0]} @ARGV; die $!;",
            ctx.outputs.outs[0].path,
            flex.flex_tool.executable.path,
        ] + ctx.attr.options + ["-t", ctx.file.src.path],
        inputs = depset([ctx.file.src], transitive = [flex.all_files, m4.all_files, perl.runtime]),
        tools = [flex.flex_tool, m4.m4_tool, ctx.executable._deny_shell],
        outputs = ctx.outputs.outs,
        env = environment,
        mnemonic = "PostgisFlex",
    )
    return [DefaultInfo(files = depset(ctx.outputs.outs))]

postgis_flex = rule(
    implementation = _flex_stdout_impl,
    attrs = {
        "src": attr.label(mandatory = True, allow_single_file = True),
        "outs": attr.output_list(mandatory = True),
        "options": attr.string_list(),
        "_deny_shell": attr.label(default = "@rules_flex//flex/internal:m4_deny_shell", executable = True, cfg = "exec"),
    },
    toolchains = ["@rules_flex//flex:toolchain_type", "@rules_m4//m4:toolchain_type", "@rules_perl//perl:exec_toolchain_type"],
)
