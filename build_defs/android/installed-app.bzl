"""Local installed smoke over the exact existing final signed APK."""
load("@rules_android//providers:providers.bzl", "AndroidSdkInfo")
load("@rules_java//java/common:java_common.bzl", "java_common")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")

_NODE = "@rules_nodejs//nodejs:toolchain_type"

def _installed_impl(ctx):
    sdk = ctx.attr.android_sdk[AndroidSdkInfo]
    if sdk.adb.executable not in ctx.files.platform_tools:
        fail("Installed Android qualification requires the declared original platform-tools adb binary")
    node = ctx.toolchains[_NODE].nodeinfo.node
    runtime = ctx.attr._java_runtime[java_common.JavaRuntimeInfo]
    files, helper_rows, sdk_rows = [], [], []
    for file in ctx.files.helpers:
        helper_rows.append({"relative": file.short_path, "index": len(files)})
        files.append(file)
    emulator_root = ctx.file.emulator_metadata.dirname + "/"
    for file in ctx.files.emulator_files:
        if not file.path.startswith(emulator_root):
            fail("Emulator Files must belong to their exact acquisition repository")
        sdk_rows.append({"relative": file.path[len(emulator_root):], "index": len(files)})
        files.append(file)
    for file in ctx.files.platform_tools:
        marker = "/platform-tools/"
        if marker not in file.path:
            fail("Platform tool File lacks its canonical SDK path")
        sdk_rows.append({"relative": "platform-tools/" + file.path.split(marker)[-1], "index": len(files)})
        files.append(file)
    java = [file for file in runtime.files.to_list() if file.path.endswith("/bin/java")]
    if len(java) != 1:
        fail("Installed Android qualification requires its exact declared Java executable")
    java_index = len(files)
    files.append(java[0])
    files += [file for file in runtime.files.to_list() if file != java[0]]
    specification = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(specification, json.encode({"helpers": helper_rows, "sdkFiles": sdk_rows, "java": java_index,
        "extensions": ctx.attr.extensions, "timeoutSeconds": ctx.attr.timeout_seconds}) + "\n")
    return bun_test_entrypoint(ctx, ctx.file._runner,
        arguments = [specification, ctx.file.apk, ctx.file.proof, ctx.file.sdk, node, ctx.file.emulator_metadata, sdk.adb.executable] + files,
        files = [specification, ctx.file.apk, ctx.file.proof, ctx.file.sdk, node, ctx.file.emulator_metadata, sdk.adb.executable] + files,
        source_files = [ctx.file._candidate_helpers, ctx.file._archive_parser, ctx.file._metadata_helpers]) + [RunEnvironmentInfo(inherited_environment = [
            "OLIPHAUNT_MOBILE_CANDIDATE_CHECKOUT", "OLIPHAUNT_MOBILE_CANDIDATE_SHA", "OLIPHAUNT_MOBILE_CANDIDATE_TREE",
        ])]

_installed_test = rule(implementation = _installed_impl, test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS + [_NODE], attrs = BUN_TEST_ENTRYPOINT_ATTRS | {
        "apk": attr.label(mandatory = True, allow_single_file = [".apk"]),
        "proof": attr.label(mandatory = True, allow_single_file = [".json"]),
        "sdk": attr.label(mandatory = True, allow_single_file = [".tgz"]),
        "helpers": attr.label_list(mandatory = True, allow_files = True),
        "extensions": attr.string_list(mandatory = True),
        "timeout_seconds": attr.int(default = 600),
        "android_sdk": attr.label(default = Label("@oliphaunt_android_sdk//:sdk"), providers = [AndroidSdkInfo]),
        "platform_tools": attr.label(default = Label("@oliphaunt_android_sdk//:platform_tools_files"), allow_files = True),
        "emulator_metadata": attr.label(default = Label("@oliphaunt_android_emulator//:emulator.json"), allow_single_file = [".json"]),
        "emulator_files": attr.label(default = Label("@oliphaunt_android_emulator//:files"), allow_files = True),
        "_java_runtime": attr.label(default = Label("@bazel_tools//tools/jdk:current_java_runtime"), cfg = "exec", providers = [java_common.JavaRuntimeInfo]),
        "_runner": attr.label(default = Label("//build_defs/android:installed-app.mts"), allow_single_file = True),
        "_candidate_helpers": attr.label(default = Label("//build_defs/apple:installed-app.mts"), allow_single_file = True),
        "_archive_parser": attr.label(default = Label("//:tools/packaging/portable-archive.mts"), allow_single_file = True),
        "_metadata_helpers": attr.label(default = Label("//build_defs/languages/jvm:android-sdk-metadata.mts"), allow_single_file = True),
    })

def expo_android_installed_test(name, **kwargs):
    _installed_test(name = name, args = bun_test_entrypoint_args(name), tags = ["local", "exclusive", "no-remote", "no-sandbox", "external"],
        target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"], size = "large", timeout = "long", **kwargs)
