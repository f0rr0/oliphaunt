"""Observe a maintained SDK provider without compiling Kotlin or Android code."""

_SDK_TYPE = "@rules_android//toolchains/android_sdk:toolchain_type"

def _selected_android_sdk_impl(ctx):
    sdk = ctx.toolchains[_SDK_TYPE].android_sdk_info
    snapshot = ctx.actions.declare_file(ctx.label.name + ".json")
    ctx.actions.write(snapshot, json.encode({
        "buildTools": sdk.build_tools_version,
        "androidJar": sdk.android_jar.path,
        "frameworkAidl": sdk.framework_aidl.path,
        "adb": sdk.adb.executable.path,
    }) + "\n")
    return [DefaultInfo(files = depset([snapshot]))]

selected_android_sdk = rule(
    implementation = _selected_android_sdk_impl,
    toolchains = [_SDK_TYPE],
)
