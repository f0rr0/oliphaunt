"""Run the stock collector with its required Java version, scoped to this tool."""

def _java21_impl(_settings, _attr):
    return {
        "//command_line_option:java_language_version": "21",
        "//command_line_option:tool_java_language_version": "21",
        "//command_line_option:java_runtime_version": "remotejdk_21",
        "//command_line_option:tool_java_runtime_version": "remotejdk_21",
    }

_java21 = transition(
    implementation = _java21_impl,
    inputs = [],
    outputs = [
        "//command_line_option:java_language_version",
        "//command_line_option:tool_java_language_version",
        "//command_line_option:java_runtime_version",
        "//command_line_option:tool_java_runtime_version",
    ],
)

def _bazel_disk_cache_gc_impl(ctx):
    binary = ctx.attr.binary[0][DefaultInfo]
    original = binary.files_to_run.executable
    executable = ctx.actions.declare_file(ctx.label.name + "/" + original.basename)
    ctx.actions.symlink(output = executable, target_file = original, is_executable = True)
    return [DefaultInfo(
        executable = executable,
        files = depset([executable], transitive = [binary.files]),
        runfiles = binary.default_runfiles.merge(ctx.runfiles([executable])),
    )]

bazel_disk_cache_gc = rule(
    implementation = _bazel_disk_cache_gc_impl,
    executable = True,
    attrs = {
        "binary": attr.label(default = Label("@bazel_disk_cache_gc//:gc"), cfg = _java21, executable = True),
        "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
    },
)
