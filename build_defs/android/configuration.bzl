"""Keep released producer inputs independent of the consuming Android app."""

load("@oliphaunt_toolchain_metadata//:android-platforms.bzl", "ANDROID_PLATFORMS")

ANDROID_TARGET_PLATFORMS = {"android-arm64-v8a": Label("//build_defs/android:android_arm64"), "android-x86_64": Label("//build_defs/android:android_x86_64")}
_MIN_SDK = str(Label("@rules_android//rules:min_sdk_version"))

def _native_inputs_impl(_settings, attr):
    targets = [target for target, platform in ANDROID_TARGET_PLATFORMS.items() if platform == attr.platform]
    if len(targets) != 1:
        fail("Android native construction needs a declared ABI platform")
    return {"//command_line_option:android_platforms": [str(attr.platform)], _MIN_SDK: ANDROID_PLATFORMS[targets[0]]["api"]}

# Set the product floor before upstream's split; never lower an app's JVM floor.
android_native_inputs = transition(implementation = _native_inputs_impl, inputs = [], outputs = ["//command_line_option:android_platforms", _MIN_SDK])

def _product_inputs_impl(_settings, _attr):
    # These are Linux-produced archives/data, not tools or APK dependencies.
    # The producer owns any outgoing ABI split and its minimum SDK.
    return {
        "//command_line_option:platforms": [str(Label("//build_defs/native:linux_x86_64_glibc_2_28"))],
        "//command_line_option:android_platforms": [],
        "//command_line_option:Android configuration distinguisher": "main",
        "//command_line_option:dynamic_mode": "default",
        _MIN_SDK: 0,
    }

android_product_inputs = transition(
    implementation = _product_inputs_impl,
    inputs = [],
    outputs = ["//command_line_option:platforms", "//command_line_option:android_platforms", "//command_line_option:Android configuration distinguisher", "//command_line_option:dynamic_mode", _MIN_SDK],
)
