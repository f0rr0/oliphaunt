"""Exercise the real desktop-member transition without acquiring an Apple SDK."""

load("@bazel_skylib//lib:unittest.bzl", "asserts", "unittest")
load(":mobile_carriers.bzl", "mobile_host_transition")

_HostProfileInfo = provider(fields = ["macos", "linux", "apple_package"])

def _profile_impl(ctx):
    return [_HostProfileInfo(**{name: ctx.target_platform_has_constraint(getattr(ctx.attr, name)[platform_common.ConstraintValueInfo]) for name in ["macos", "linux", "apple_package"]})]

_profile = rule(implementation = _profile_impl, attrs = {
    "macos": attr.label(default = "@platforms//os:macos"),
    "linux": attr.label(default = "@platforms//os:linux"),
    "apple_package": attr.label(default = "//build_defs/host:apple_package"),
})

def _host_profile_test_impl(ctx):
    env = unittest.begin(ctx)
    profile = ctx.attr.probe[0][_HostProfileInfo]
    asserts.equals(env, ctx.attr.target == "ios-xcframework", profile.macos)
    asserts.equals(env, ctx.attr.target != "ios-xcframework", profile.linux)
    asserts.false(env, profile.apple_package, "desktop members must retain the direct carrier deployment contract")
    return unittest.end(env)

_host_profile_test = unittest.make(_host_profile_test_impl, attrs = {
    "probe": attr.label(cfg = mobile_host_transition),
    "target": attr.string(),
    "_allowlist_function_transition": attr.label(default = "@bazel_tools//tools/allowlists/function_transition_allowlist"),
})

def mobile_host_profile_tests():
    _profile(name = "mobile_host_profile_fixture", testonly = True, tags = ["manual"])
    for target in ["ios-xcframework", "android-arm64-v8a", "android-x86_64"]:
        _host_profile_test(
            name = "mobile_host_" + target.replace("-", "_") + "_test",
            probe = ":mobile_host_profile_fixture",
            target = target,
            size = "small",
        )
