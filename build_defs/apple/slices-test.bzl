"""Packaging aliases preserve exact slice Files; compiler aliases stay narrow."""

load("@bazel_skylib//lib:unittest.bzl", "asserts", "unittest")
load(":slices.bzl", "apple_slice_filegroup", "apple_slice_groups")

def _producer_impl(ctx):
    selected = ctx.actions.declare_file(ctx.label.name + ".selected.a")
    alternative = ctx.actions.declare_file(ctx.label.name + ".unused.a")
    archive = ctx.actions.declare_file(ctx.label.name + ".zip")
    ctx.actions.write(selected, "selected")
    ctx.actions.write(alternative, "unused")
    ctx.actions.expand_template(output = archive, template = selected, substitutions = {})
    return [DefaultInfo(files = depset([archive])), OutputGroupInfo(
        archive = depset([archive]),
        compiled_core = depset([selected]),
        unused = depset([alternative]),
        apple_slice_ios_arm64 = depset([selected]),
    )]

_producer = rule(implementation = _producer_impl)

def _test_impl(ctx):
    env = unittest.begin(ctx)
    source = ctx.attr.producer[OutputGroupInfo]
    selected = source.apple_slice_ios_arm64.to_list()
    groups = apple_slice_groups([ctx.attr.alias, ctx.attr.alias, ctx.attr.compiled])
    asserts.equals(env, ["apple_slice_ios_arm64"], groups.keys())
    asserts.equals(env, selected, groups["apple_slice_ios_arm64"].to_list())
    asserts.equals(env, source.archive.to_list(), ctx.attr.alias[DefaultInfo].files.to_list())
    asserts.equals(env, selected, ctx.attr.compiled[DefaultInfo].files.to_list())
    asserts.equals(env, {}, apple_slice_groups([ctx.attr.compiled]))
    asserts.false(env, source.unused.to_list()[0] in groups["apple_slice_ios_arm64"].to_list())
    return unittest.end(env)

_test = unittest.make(_test_impl, attrs = {
    "producer": attr.label(),
    "alias": attr.label(),
    "compiled": attr.label(),
})

def apple_slices_test(name):
    _producer(name = name + "_producer", testonly = True)
    apple_slice_filegroup(name = name + "_archive", src = ":" + name + "_producer", output_group = "archive", testonly = True)
    native.filegroup(name = name + "_compiled", srcs = [":" + name + "_producer"], output_group = "compiled_core", testonly = True)
    _test(name = name, producer = ":" + name + "_producer", alias = ":" + name + "_archive", compiled = ":" + name + "_compiled")
