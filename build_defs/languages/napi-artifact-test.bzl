"""Node-API projections select the Rust cdylib even when import libraries coexist."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@rules_rust//rust:defs.bzl", "rust_common")
load(":rust.bzl", "napi_artifact")

def _library_impl(ctx):
    library = ctx.actions.declare_file(ctx.label.name + ".dll")
    import_library = ctx.actions.declare_file(ctx.label.name + ".dll.lib")
    ctx.actions.write(library, "dynamic library fixture")
    ctx.actions.write(import_library, "import library fixture")
    return [
        DefaultInfo(files = depset([library, import_library])),
        rust_common.test_crate_info(crate = rust_common.crate_info(type = ctx.attr.kind, output = library)),
    ]

_library = rule(implementation = _library_impl, attrs = {"kind": attr.string()})

def _projection_impl(ctx):
    env = analysistest.begin(ctx)
    actions = analysistest.target_actions(env)
    asserts.equals(env, 1, len(actions))
    asserts.equals(env, ["napi_projection_library.dll"], [file.basename for file in actions[0].inputs.to_list()])
    asserts.equals(env, ["fixture.node"], [file.basename for file in analysistest.target_under_test(env)[DefaultInfo].files.to_list()])
    return analysistest.end(env)

_projection_test = analysistest.make(_projection_impl)

def _rejected_impl(ctx):
    env = analysistest.begin(ctx)
    asserts.expect_failure(env, "Node-API artifacts require a Rust cdylib")
    return analysistest.end(env)

_rejected_test = analysistest.make(_rejected_impl, expect_failure = True)

def napi_artifact_tests():
    _library(name = "napi_projection_library", kind = "cdylib", tags = ["manual"])
    napi_artifact(name = "napi_projection", library = ":napi_projection_library", out = "fixture.node", tags = ["manual"])
    _projection_test(name = "napi_artifact_projection_test", target_under_test = ":napi_projection")
    _library(name = "napi_rejected_library", kind = "staticlib", tags = ["manual"])
    napi_artifact(name = "napi_rejected", library = ":napi_rejected_library", out = "rejected.node", tags = ["manual"])
    _rejected_test(name = "napi_artifact_kind_test", target_under_test = ":napi_rejected")
