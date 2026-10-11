"""Lazy SDK registrations and pinned archives using maintained Android rules."""

def _supported_host(ctx):
    return ctx.os.name == "linux" and ctx.os.arch in ["amd64", "x86_64"]

def _sdk_metadata(ctx):
    ctx.read(ctx.attr.manifest)
    ctx.read(ctx.attr.converter)
    ctx.watch(ctx.path(ctx.attr.bun))
    command = [str(ctx.path(ctx.attr.bun)), str(ctx.path(ctx.attr.converter)), str(ctx.path(ctx.attr.manifest)), str(ctx.path("sdk.json"))]
    checked = ctx.execute(command, timeout = 60)
    if checked.return_code:
        fail("Android SDK acquisition metadata is invalid:\n" + checked.stdout + checked.stderr)
    return json.decode(ctx.read("sdk.json")), command

def _android_sdk_hub_impl(ctx):
    if not _supported_host(ctx):
        ctx.template("BUILD.bazel", ctx.attr.empty_template)
        return ctx.repo_metadata(reproducible = True)
    metadata, _ = _sdk_metadata(ctx)
    archive = "@%s//:" % ctx.attr.archive
    api = metadata["api"]
    # Upstream globally registers @androidsdk//:all. The registration package
    # must contain no archive-backed toolchain types, settings or loaded .bzl
    # files. Implementation labels and ordinary aliases remain lazy.
    lines = [
        'load("@rules_android//rules/android_sdk_repository:helper.bzl", "int_flag")',
        'package(default_visibility = ["//visibility:public"])',
        'toolchain_type(name = "sdk_toolchain_type")',
        'config_feature_flag(name = "true", allowed_values = ["true", "false"], default_value = "true")',
        'config_setting(name = "always_true", flag_values = {":true": "true"})',
        'config_setting(name = "always_false", flag_values = {":true": "false"})',
        'alias(name = "has_androidsdk", actual = ":always_true")',
        'int_flag(name = "api_level", build_setting_default = %d, values = [%d])' % (api, api),
        'config_setting(name = "api_%d_enabled", flag_values = {":api_level": "%d"})' % (api, api),
        'toolchain(name = "sdk-toolchain", toolchain_type = ":sdk_toolchain_type", toolchain = "%ssdk-%d", exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"], target_settings = [":api_%d_enabled"])' % (archive, api, api),
        'alias(name = "sdk-%d-toolchain", actual = ":sdk-toolchain")' % api,
    ]
    # Keep the aliases used by the maintained Android/Kotlin rules and the SDK
    # platform jars. Actual tools and their runfiles stay in the archive repo,
    # rendered by upstream's unchanged template/helper.
    aliases = [
        "sdk", "sdk-%d" % api, "files", "aapt2", "fail",
        "platform-tools/adb", "adb", "dexdump", "build_tools_libs",
        "core-for-system-modules-jar", "d8_jar_import",
        "org_apache_http_legacy", "org_apache_http_legacy-%d" % api,
    ]
    if api >= 28:
        aliases.append("legacy_test-%d" % api)
    for name in aliases:
        lines.append('alias(name = "%s", actual = "%s%s")' % (name, archive, name))
    ctx.file("BUILD.bazel", "\n".join(lines) + "\n")
    return ctx.repo_metadata(reproducible = True)

def _android_sdk_archive_impl(ctx):
    if not _supported_host(ctx):
        # Non-Android source clients need no Linux binary SDK acquisition.
        ctx.template("BUILD.bazel", ctx.attr.empty_template)
        return ctx.repo_metadata(reproducible = True)
    metadata, command = _sdk_metadata(ctx)
    for archive in metadata["archives"]:
        ctx.download_and_extract(url = archive["url"], sha256 = archive["sha256"], output = archive["directory"], strip_prefix = archive["strip_prefix"])
    checked = ctx.execute(command + [str(ctx.path("."))], timeout = 60)
    if checked.return_code:
        fail("Android SDK archive identity is invalid:\n" + checked.stdout + checked.stderr)
    ctx.symlink(ctx.attr.helper, "helper.bzl")
    ctx.template("BUILD.bazel", ctx.attr.template, substitutions = {
        "__repository_name__": ctx.name,
        "__build_tools_version__": metadata["buildTools"],
        "__build_tools_directory__": metadata["buildTools"],
        "__api_levels__": str(metadata["api"]),
        "__default_api_level__": str(metadata["api"]),
        "__system_image_dirs__": "",
    })
    return ctx.repo_metadata(reproducible = True)

def _metadata_attrs():
    return {
        "manifest": attr.label(default = Label("//:tools/dev/android-sdk.toml"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/languages/jvm:android-sdk-metadata.mts"), allow_single_file = True),
        "empty_template": attr.label(default = Label("@rules_android//rules/android_sdk_repository:empty.template.bzl"), allow_single_file = True),
    }

_hub_attrs = _metadata_attrs()
_hub_attrs["archive"] = attr.string(mandatory = True)

android_sdk_hub_repository = repository_rule(
    implementation = _android_sdk_hub_impl,
    attrs = _hub_attrs,
)

_archive_attrs = _metadata_attrs()
_archive_attrs.update({
    "template": attr.label(default = Label("@rules_android//rules/android_sdk_repository:template.bzl"), allow_single_file = True),
    "helper": attr.label(default = Label("@rules_android//rules/android_sdk_repository:helper.bzl"), allow_single_file = True),
})

android_sdk_archive_repository = repository_rule(
    implementation = _android_sdk_archive_impl,
    attrs = _archive_attrs,
)
