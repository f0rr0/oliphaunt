"""Compare the actual release and app-link archive Files for each supported ABI."""

load("@bazel_skylib//lib:unittest.bzl", "asserts", "unittest")
load("@rules_android//rules:android_split_transition.bzl", "android_split_transition")
load(":app.bzl", "android_app_configuration")
load(":configuration.bzl", "ANDROID_TARGET_PLATFORMS")

def _apps_impl(settings, attr):
    return {target + "/" + str(minimum): android_app_configuration(settings, struct(abi = target.removeprefix("android-"), min_sdk_version = minimum)) for target in ANDROID_TARGET_PLATFORMS for minimum in [attr.min_sdk_version, attr.min_sdk_version + 1]}

_apps = transition(implementation = _apps_impl, inputs = [], outputs = ["//command_line_option:android_platforms", "//command_line_option:compilation_mode", str(Label("@rules_android//rules:min_sdk_version"))])

def _view_impl(ctx):
    return [ctx.attr.assets[0][OutputGroupInfo]]

_view = rule(implementation = _view_impl, attrs = {
    "assets": attr.label(default = "//src/examples/native/react-native-expo:selected_runtime_assets", cfg = android_split_transition),
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
})

def _reuse_impl(ctx):
    env = unittest.begin(ctx)
    asserts.equals(env, sorted([target + "/" + str(minimum) for target in ANDROID_TARGET_PLATFORMS for minimum in [ctx.attr.min_sdk_version, ctx.attr.min_sdk_version + 1]]), sorted(ctx.split_attr.apps))
    for abi, targets in ctx.split_attr.apps.items():
        asserts.equals(env, 1, len(targets))
        views = targets[0][OutputGroupInfo]
        raw = views.mobile_raw_archives.to_list()
        linked = views.mobile_linked_archives.to_list()
        asserts.true(env, len(raw) > 0, abi + " must observe actual release archives")
        asserts.equals(env, sorted([file.path for file in raw]), sorted([file.path for file in linked]), abi + " release and APK link must consume the same configured archive Files")
    return unittest.end(env)

_reuse_test = unittest.make(_reuse_impl, attrs = {
    "apps": attr.label_list(cfg = _apps),
    "min_sdk_version": attr.int(mandatory = True),
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
})

def android_cpp_reuse_test(name, min_sdk_version):
    _view(name = name + "_view", testonly = True, tags = ["manual"])
    _reuse_test(name = name, apps = [":" + name + "_view"], min_sdk_version = min_sdk_version,
                target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"], size = "small")
