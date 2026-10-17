"""Configure portable C producers independently of their host consumers."""

def _portable_impl(_settings, _attr):
    return {"//command_line_option:platforms": [str(Label("//build_defs/wasix:portable"))]}

WASIX_PORTABLE_TRANSITION = transition(
    implementation = _portable_impl,
    inputs = [],
    outputs = ["//command_line_option:platforms"],
)

def _artifact_impl(ctx):
    return [ctx.attr.artifact[0][DefaultInfo]]

wasix_artifact = rule(
    implementation = _artifact_impl,
    attrs = {
        "artifact": attr.label(mandatory = True, cfg = WASIX_PORTABLE_TRANSITION),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)
