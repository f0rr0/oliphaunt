"""Real object-rule analysis proves forced headers are declared compiler inputs."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load(":extensions.bzl", "native_extension_modules")

def _header_impl(ctx):
    header = ctx.actions.declare_file(ctx.label.name + ".h")
    ctx.actions.write(header, "/* Declared forced-header fixture. */\n")
    return [DefaultInfo(files = depset([header]))]

_header = rule(implementation = _header_impl)

def _inputs_test_impl(ctx):
    env = analysistest.begin(ctx)
    target = analysistest.target_under_test(env)
    headers = [file for file in target[CcInfo].compilation_context.headers.to_list() if file.basename == "forced_header_fixture.h"]
    asserts.equals(env, 1, len(headers))
    ordinary_headers = [file for file in target[CcInfo].compilation_context.headers.to_list() if file.basename == "ordinary_header_fixture.h"]
    asserts.equals(env, 1, len(ordinary_headers))
    compiles = [action for action in analysistest.target_actions(env) if action.mnemonic == "CppCompile"]
    asserts.true(env, len(compiles) > 0, "object target must retain its real C compile actions")
    for header in headers:
        for action in compiles:
            asserts.true(env, header.path in [file.path for file in action.inputs.to_list()], "forced header is absent from compile inputs")
            asserts.true(env, "-include" in action.argv and header.path in action.argv, "forced-header location is not expanded in compile flags")
    for header in ordinary_headers:
        for action in compiles:
            asserts.false(env, header.path in [file.path for file in action.inputs.to_list()], "ordinary headers must remain eligible for input discovery")
    return analysistest.end(env)

_inputs_test = analysistest.make(_inputs_test_impl)

def native_forced_header_input_tests():
    _header(name = "forced_header_fixture", tags = ["manual"])
    _header(name = "ordinary_header_fixture", tags = ["manual"])
    native.filegroup(name = "forced_header_inputs", srcs = [":forced_header_fixture"], tags = ["manual"])
    native_extension_modules(
        name = "forced_header_location",
        srcs = [":native_extension_smoke.c"],
        hdrs = [":forced_header_inputs", ":ordinary_header_fixture"],
        additional_compiler_inputs = [":forced_header_inputs"],
        copts = ["-include", "$(location :forced_header_inputs)"],
        linux_only = True,
    )
    for variant in ["server", "embedded"]:
        _inputs_test(
            name = "forced_header_" + variant + "_inputs_test",
            target_under_test = ":forced_header_location_" + variant + "_objects",
            target_compatible_with = ["@platforms//os:linux"],
        )
