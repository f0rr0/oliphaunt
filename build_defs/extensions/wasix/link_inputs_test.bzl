"""Source helper flags stay explicit; opaque CcInfo link flags fail closed."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts", "unittest")
load("@rules_cc//cc:defs.bzl", "cc_library")
load("//build_defs/extensions:external.bzl", "external_extension_inputs")
load("//build_defs/extensions:wasix_carriers.bzl", "wasix_extension_source_candidate", "wasix_extension_uses_current_host")
load("//build_defs/wasix:wasm.bzl", "wasix_module")
load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_COMPATIBILITY")

def _inputs_test_impl(ctx):
    env = unittest.begin(ctx)
    flags = external_extension_inputs(name = "probe", sql_name = "pg_hashids", link_profile = "wasix")["linkopts"]
    asserts.equals(env, "list", type(flags))
    asserts.equals(env, ["-lm"], flags)
    asserts.equals(env, None, external_extension_inputs(name = "probe", sql_name = "pg_uuidv7", link_profile = "wasix").get("linkopts"))
    names = sorted(EXTENSION_COMPATIBILITY.keys())
    # Few, partial and full adoption preserve each unchanged immutable host.
    for count in [1, len(names) // 2, len(names)]:
        requirements = {name: "0.3.3" if index < count else "0.3.2" for index, name in enumerate(names)}
        selected = [name for name in names if wasix_extension_uses_current_host(requirements[name], "0.3.3", ["liboliphaunt-wasix"])]
        asserts.equals(env, names[:count], selected)
    asserts.false(env, wasix_extension_uses_current_host("0.3.3", "0.3.3", []))
    asserts.false(env, wasix_extension_uses_current_host("0.3.3", "0.3.3", ["oliphaunt-extension-vector"]))
    asserts.false(env, wasix_extension_uses_current_host("0.3.2", "0.3.3", ["liboliphaunt-wasix"]))
    asserts.true(env, wasix_extension_source_candidate("0.3.2", "0.3.2", False))
    asserts.false(env, wasix_extension_source_candidate("0.3.2", "0.3.3", False))
    # An explicitly empty prepared selection still forbids source fallback.
    asserts.false(env, wasix_extension_source_candidate("0.3.2", "0.3.2", True))
    return unittest.end(env)

_inputs_test = unittest.make(_inputs_test_impl)

def _invalid_profile_impl(ctx):
    external_extension_inputs(name = "probe", sql_name = "pg_hashids", link_profile = "undeclared")
    return []

_invalid_profile = rule(implementation = _invalid_profile_impl)

def _rejected_impl(ctx):
    env = analysistest.begin(ctx)
    asserts.expect_failure(env, ctx.attr.message)
    return analysistest.end(env)

_rejected_test = analysistest.make(_rejected_impl, expect_failure = True, attrs = {"message": attr.string()})

def wasix_extension_link_input_tests():
    _inputs_test(name = "link_inputs_test")
    _invalid_profile(name = "invalid_link_profile_subject", tags = ["manual"])
    _rejected_test(name = "invalid_link_profile_test", target_under_test = ":invalid_link_profile_subject", message = "unknown external extension link profile")
    cc_library(name = "unhandled_linkopts_inputs", linkopts = ["-lundeclared"], linkstatic = True, tags = ["manual"])
    wasix_module(name = "unhandled_linkopts_subject", output_name = "rejected.so", deps = [":unhandled_linkopts_inputs"], tags = ["manual"])
    _rejected_test(name = "unhandled_linkopts_test", target_under_test = ":unhandled_linkopts_subject", message = "WASIX static archive link needs explicit handling of CcInfo flags/additional inputs")
