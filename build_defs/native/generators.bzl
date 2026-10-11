"""Bounded PostgreSQL source generators using declared execution toolchains."""

_PERL = "@rules_perl//perl:exec_toolchain_type"
_BISON = "@rules_bison//bison:toolchain_type"
_FLEX = "@rules_flex//flex:toolchain_type"
_M4 = "@rules_m4//m4:toolchain_type"

def _expand(ctx, value):
    targets = ctx.attr.srcs + [ctx.attr.script]
    for target in targets:
        files = target[DefaultInfo].files.to_list()
        if len(files) == 1:
            value = value.replace("$(dirname " + target.label.name + ")", files[0].dirname)
    rule_dir = ctx.bin_dir.path + "/" + ctx.label.workspace_root
    if ctx.label.package:
        rule_dir += "/" + ctx.label.package
    value = value.replace("$(RULEDIR)", rule_dir).replace("$@", ctx.outputs.outs[0].path)
    return ctx.expand_location(value, targets = targets)

def _perl_generator_impl(ctx):
    perl = ctx.toolchains[_PERL].perl_runtime
    arguments = perl.perlopt + [_expand(ctx, value) for value in ctx.attr.options]
    arguments += [ctx.file.script.path] + [_expand(ctx, value) for value in ctx.attr.arguments]
    if ctx.attr.capture_stdout:
        # Two upstream generators emit stdout instead of accepting an output
        # path. Redirect it in the same declared interpreter, without a shell.
        arguments = perl.perlopt + [
            "-e",
            "open(STDOUT, q(>), shift @ARGV) or die $!; exec {$ARGV[0]} @ARGV; die $!;",
            ctx.outputs.outs[0].path,
            perl.interpreter.path,
        ] + arguments
    ctx.actions.run(
        executable = perl.interpreter,
        arguments = arguments,
        inputs = depset(ctx.files.srcs + [ctx.file.script], transitive = [perl.runtime]),
        outputs = ctx.outputs.outs,
        env = {"PERL5LIB": "", "PERL5OPT": ""},
        mnemonic = "PostgresPerl",
        progress_message = "Generate PostgreSQL sources %{label}",
    )
    return [DefaultInfo(files = depset(ctx.outputs.outs))]

postgres_perl = rule(
    implementation = _perl_generator_impl,
    attrs = {
        "script": attr.label(mandatory = True, allow_single_file = True),
        "srcs": attr.label_list(allow_files = True),
        "outs": attr.output_list(mandatory = True),
        "arguments": attr.string_list(),
        "options": attr.string_list(),
        "capture_stdout": attr.bool(),
    },
    toolchains = [_PERL],
)

def _parser_action(ctx, scanner):
    if scanner:
        selected = ctx.toolchains[_FLEX]
        toolchain = selected.flex_toolchain
        tool = toolchain.flex_tool
        environment = dict(toolchain.flex_env)
    else:
        selected = ctx.toolchains[_BISON]
        toolchain = selected.bison_toolchain
        tool = toolchain.bison_tool
        environment = dict(toolchain.bison_env)
    inputs = [toolchain.all_files]
    tools = [tool]
    # The canonical Windows ports call their linked M4 implementation, which
    # disables shell execution. Other maintained providers use declared M4.
    if not getattr(selected, "embedded_m4", False):
        m4 = ctx.toolchains[_M4].m4_toolchain
        environment.update({
            "M4": m4.m4_tool.executable.path,
            "M4_SYSCMD_SHELL": ctx.executable._deny_shell.path,
        })
        inputs.append(m4.all_files)
        tools.extend([m4.m4_tool, ctx.executable._deny_shell])
    ctx.actions.run(
        executable = tool,
        arguments = ctx.attr.options + ["-o", ctx.outputs.outs[0].path, ctx.file.src.path],
        inputs = depset([ctx.file.src], transitive = inputs),
        tools = tools,
        outputs = ctx.outputs.outs,
        env = environment,
        mnemonic = "PostgresFlex" if scanner else "PostgresBison",
        progress_message = "Generate PostgreSQL parser %{label}",
    )
    return [DefaultInfo(files = depset(ctx.outputs.outs))]

def _bison_impl(ctx):
    return _parser_action(ctx, False)

def _flex_impl(ctx):
    return _parser_action(ctx, True)

def _parser_attrs(deny_shell):
    return {
        "src": attr.label(mandatory = True, allow_single_file = True),
        "outs": attr.output_list(mandatory = True),
        "options": attr.string_list(),
        "_deny_shell": attr.label(default = deny_shell, executable = True, cfg = "exec"),
    }

postgres_bison = rule(
    implementation = _bison_impl,
    attrs = _parser_attrs("@rules_bison//bison/internal:m4_deny_shell"),
    toolchains = [_BISON, _M4],
)

postgres_flex = rule(
    implementation = _flex_impl,
    attrs = _parser_attrs("@rules_flex//flex/internal:m4_deny_shell"),
    toolchains = [_FLEX, _M4],
)
