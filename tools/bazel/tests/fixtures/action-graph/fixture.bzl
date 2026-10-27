"""Tiny real producer actions for construction/release conformance fixtures."""

load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

def _header_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".h")
    bun_file_action(
        ctx,
        entry_point = ctx.file.tool,
        source_files = [ctx.file.tool],
        arguments = [output.path, ctx.file.config.path],
        inputs = [ctx.file.tool, ctx.file.config],
        outputs = [output],
        mnemonic = "FixtureConfigHeader",
    )
    return [DefaultInfo(files = depset([output]))]

fixture_header = rule(
    implementation = _header_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "config": attr.label(mandatory = True, allow_single_file = True),
        "tool": attr.label(mandatory = True, allow_single_file = True),
    },
)

def _package_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".json")
    bun_file_action(
        ctx,
        entry_point = ctx.file.tool,
        source_files = [ctx.file.tool],
        arguments = [output.path, ctx.file.binary.path, ctx.file.legal.path, ctx.attr.owner[ReleaseIdentityInfo].version, ctx.attr.owner[ReleaseIdentityInfo].id],
        inputs = [ctx.file.tool, ctx.file.binary, ctx.file.legal],
        outputs = [output],
        mnemonic = "FixturePackage",
    )
    return [DefaultInfo(files = depset([output]))]

fixture_package = rule(
    implementation = _package_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = {
        "binary": attr.label(mandatory = True, allow_single_file = True),
        "legal": attr.label(mandatory = True, allow_single_file = True),
        "tool": attr.label(mandatory = True, allow_single_file = True),
        "owner": attr.label(mandatory = True, providers = [ReleaseIdentityInfo]),
    },
)
