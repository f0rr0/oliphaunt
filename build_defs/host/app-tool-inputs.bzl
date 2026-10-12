"""Bind maintained Apple action selection to the same licensed SDK capture."""
load("@apple_support//lib:apple_support.bzl", "apple_support")

def apple_app_configuration_error(info, observation, sdk_versions):
    """Reject CLI overrides that would execute different ambient tool/SDK bytes."""
    versions = [line.removeprefix("Xcode ") for line in observation.split("\n") if line.startswith("Xcode ")]
    builds = [line.removeprefix("Build version ") for line in observation.split("\n") if line.startswith("Build version ")]
    if len(versions) != 1 or len(builds) != 1:
        return "Captured Xcode version/build observation is malformed"
    version, build = versions[0], builds[0]
    selected = str(info.xcode_version()).split(".")
    if len(selected) < 2 or selected[-1].lower() != build.lower():
        return "Stock Apple actions must select the captured Xcode build"
    if apple_common.dotted_version(".".join(selected[:-1])).compare_to(apple_common.dotted_version(version)) != 0:
        return "Stock Apple actions must select the captured Xcode version"
    for sdk, platform in [("macosx", apple_common.platform.macos), ("iphoneos", apple_common.platform.ios_device), ("iphonesimulator", apple_common.platform.ios_simulator)]:
        if info.sdk_version_for_platform(platform).compare_to(apple_common.dotted_version(sdk_versions[sdk])) != 0:
            return "Stock Apple actions must select the captured " + sdk + " SDK"
    if "no-remote" not in info.execution_info():
        return "The licensed application tools require the stock local Xcode execution boundary"
    return None

def _app_tools_impl(ctx):
    error = apple_app_configuration_error(ctx.attr._xcode_config[apple_common.XcodeVersionConfig], ctx.attr.xcode_observation, ctx.attr.sdk_versions)
    if error:
        fail(error)
    return [DefaultInfo(files = depset(ctx.files.tools))]

declared_apple_app_tools = rule(implementation = _app_tools_impl, attrs = apple_support.action_required_attrs() | {
    "tools": attr.label_list(mandatory = True, allow_files = True),
    "xcode_observation": attr.string(mandatory = True),
    "sdk_versions": attr.string_dict(mandatory = True),
})
