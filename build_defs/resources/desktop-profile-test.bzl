"""Analyze the real desktop constructors beneath package and target profiles."""

load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts")
load("@rules_pkg//pkg:providers.bzl", "PackageFilesInfo")
load("//build_defs/foundation:bun.bzl", "bun_test_entrypoint_args")
load("//build_defs/native/carriers:defs.bzl", "native_public_payload")
load(":resources.bzl", "native_seed", "native_seed_consumer_test")

def _fixture_impl(ctx):
    profile = [name for name in ["macos", "linux", "windows", "ios", "android"] if ctx.target_platform_has_constraint(ctx.attr._oses[name][platform_common.ConstraintValueInfo])][0]
    if ctx.target_platform_has_constraint(ctx.attr._package[platform_common.ConstraintValueInfo]):
        profile += "-package"
    output = ctx.actions.declare_file(ctx.label.name + "/profile-fixture/" + profile + "/" + ctx.attr.filename)
    ctx.actions.write(output, profile)
    return [DefaultInfo(files = depset([output]), runfiles = ctx.runfiles(files = [output])),
            PackageFilesInfo(dest_src_map = {ctx.attr.filename: output}, attributes = {"mode": "0644"})]

_fixture = rule(implementation = _fixture_impl, attrs = {
    "filename": attr.string(mandatory = True),
    "_package": attr.label(default = "//build_defs/host:apple_package"),
    "_oses": attr.string_keyed_label_dict(default = {name: "@platforms//os:" + name for name in ["macos", "linux", "windows", "ios", "android"]}),
})

def _profile_test_impl(ctx):
    env = analysistest.begin(ctx)
    target = analysistest.target_under_test(env)
    if ctx.attr.consumer:
        files = target[DefaultInfo].default_runfiles.files.to_list()
    else:
        actions = [action for action in analysistest.target_actions(env) if action.mnemonic == ctx.attr.mnemonic]
        asserts.equals(env, 1, len(actions))
        files = actions[0].inputs.to_list() if actions else []
    fixtures = [file.path for file in files if "/profile-fixture/" in file.path]
    asserts.true(env, len(fixtures) >= ctx.attr.minimum_files, "must inspect the actual constructor inputs/runfiles")
    for file in fixtures:
        asserts.true(env, "/profile-fixture/" + ctx.attr.expected + "/" in file, file)
    return analysistest.end(env)

_ATTRS = {"mnemonic": attr.string(default = "NativePublicPayload"), "expected": attr.string(default = "macos"), "consumer": attr.bool(), "minimum_files": attr.int(default = 1)}
_package_test = analysistest.make(_profile_test_impl, attrs = _ATTRS, config_settings = {"//command_line_option:platforms": str(Label("//build_defs/host:apple_package_macos_arm64"))})
_linux_test = analysistest.make(_profile_test_impl, attrs = _ATTRS, config_settings = {"//command_line_option:platforms": str(Label("//build_defs/native:linux_x86_64_glibc_2_28"))})
_windows_test = analysistest.make(_profile_test_impl, attrs = _ATTRS, config_settings = {"//command_line_option:platforms": str(Label("//build_defs/host:native_windows_x64"))})
_ios_test = analysistest.make(_profile_test_impl, attrs = _ATTRS, config_settings = {"//command_line_option:platforms": str(Label("//build_defs/host:ios_device_arm64"))})
_android_test = analysistest.make(_profile_test_impl, attrs = _ATTRS, config_settings = {"//command_line_option:platforms": str(Label("//build_defs/android:android_arm64"))})

def desktop_profile_tests():
    for name, filename in [("runtime", "runtime.tar"), ("configuration", "pg_config.h"), ("header", "pg_control.h")]:
        _fixture(name = "desktop_profile_" + name, filename = filename, testonly = True, tags = ["manual"])
    native_public_payload(name = "desktop_profile_payload", root_mappings = [":desktop_profile_runtime"], runtime_mappings = [], metadata = "{}", testonly = True, tags = ["manual"])
    native_seed(name = "desktop_profile_seed", runtime = ":desktop_profile_runtime", configuration = ":desktop_profile_configuration",
                headers = {":desktop_profile_header": "src/include/catalog/pg_control.h"}, profile = "standard", target = "macos-arm64", testonly = True, tags = ["manual"])
    name = "desktop_profile_consumer_subject_test"
    native_seed_consumer_test(name = name, runtime = ":desktop_profile_runtime", consumer = ":desktop_profile_header",
                              specification = ":desktop_profile_configuration", args = bun_test_entrypoint_args(name), tags = ["manual"])
    _package_test(name = "desktop_seed_profile_test", target_under_test = ":desktop_profile_seed", mnemonic = "PostgresClusterSeed", minimum_files = 3, size = "small")
    _package_test(name = "desktop_seed_consumer_profile_test", target_under_test = ":" + name, consumer = True, minimum_files = 3, size = "small")
    for test, profile in [(_package_test, "macos"), (_linux_test, "linux"), (_windows_test, "windows"), (_ios_test, "ios"), (_android_test, "android")]:
        test(name = "desktop_payload_" + profile + "_profile_test", target_under_test = ":desktop_profile_payload", expected = profile, size = "small")
