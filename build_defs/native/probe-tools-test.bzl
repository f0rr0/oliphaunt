"""Analysis-only proof that shared probe tools preserve the selected SDK inputs."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")

_ProbeToolsInfo = provider(fields = ["files"])

def _probe_tools_impl(ctx):
    files = find_cc_toolchain(ctx).all_files
    # Neither action executes; the analysis test compares their declarations.
    for name, tools in [("flat", files), ("shared", [files])]:
        ctx.actions.run(
            executable = ctx.executable.checker,
            arguments = ["--help"],
            inputs = [ctx.file.source],
            outputs = [ctx.actions.declare_file(name + ".probe")],
            tools = tools,
            mnemonic = "ProbeToolInputs",
        )
    return [
        _ProbeToolsInfo(files = files),
        DefaultInfo(files = depset([ctx.executable.checker]), runfiles = ctx.attr.checker[DefaultInfo].default_runfiles),
    ]

_probe_tools = rule(
    implementation = _probe_tools_impl,
    attrs = {
        "source": attr.label(allow_single_file = True),
        "checker": attr.label(executable = True, cfg = "exec"),
    },
    toolchains = use_cc_toolchain(),
)

def _probe_tools_test_impl(ctx):
    env = analysistest.begin(ctx)
    actions = analysistest.target_actions(env)
    asserts.equals(env, 2, len(actions))
    expected = {file.path: True for file in analysistest.target_under_test(env)[_ProbeToolsInfo].files.to_list()}
    asserts.true(env, len(expected) > 0)
    for action in actions:
        inputs = {file.path: True for file in action.inputs.to_list()}
        asserts.equals(env, expected, {path: True for path in inputs if path in expected})
    asserts.equals(env, sorted([file.path for file in actions[0].inputs.to_list()]), sorted([file.path for file in actions[1].inputs.to_list()]))
    asserts.equals(env, actions[0].argv, actions[1].argv)
    asserts.equals(env, actions[0].env, actions[1].env)
    return analysistest.end(env)

_probe_tools_test = analysistest.make(_probe_tools_test_impl)

def compiler_probe_tool_inputs_test():
    _probe_tools(
        name = "compiler_probe_tool_inputs_subject",
        source = ":probe-sanity.c",
        checker = "@rules_cc_autoconf//autoconf/private/checker:checker_bin",
        tags = ["manual"],
        testonly = True,
    )
    _probe_tools_test(
        name = "compiler_probe_tool_inputs_test",
        target_under_test = ":compiler_probe_tool_inputs_subject",
    )
