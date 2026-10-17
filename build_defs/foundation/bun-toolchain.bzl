"""Pinned Bun selected for the action execution platform."""

BUN_TOOLCHAIN_TYPE = "//build_defs/foundation:bun_toolchain_type"

def _bun_runtime_toolchain_impl(ctx):
    return [platform_common.ToolchainInfo(
        bun = ctx.executable.binary,
        runtime_platform = ctx.attr.runtime_platform,
        binary_sha256 = ctx.attr.binary_sha256,
    )]

bun_runtime_toolchain = rule(
    implementation = _bun_runtime_toolchain_impl,
    attrs = {
        "binary": attr.label(mandatory = True, executable = True, allow_single_file = True, cfg = "exec"),
        "runtime_platform": attr.string(mandatory = True),
        "binary_sha256": attr.string(mandatory = True),
    },
)
