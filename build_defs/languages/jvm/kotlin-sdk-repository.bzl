"""Bounded import of existing conventional Kotlin construction defaults."""

def _kotlin_sdk_metadata_impl(ctx):
    sources = [ctx.attr.catalog, ctx.attr.gradle, ctx.attr.plugin_gradle, ctx.attr.properties, ctx.attr.version, ctx.attr.android_sdk]
    for source in sources + [ctx.attr.converter, ctx.attr.pom_helper]:
        ctx.read(source)
    ctx.watch(ctx.path(ctx.attr.bun))
    command = [str(ctx.path(ctx.attr.bun)), str(ctx.path(ctx.attr.converter))] + [str(ctx.path(source)) for source in sources] + [str(ctx.path("metadata.bzl"))]
    result = ctx.execute(command, timeout = 60)
    if result.return_code:
        fail("Kotlin SDK conventional import failed:\n" + result.stdout + result.stderr)
    ctx.file("BUILD.bazel", "exports_files([\"metadata.bzl\"], visibility=[\"//visibility:public\"])\n")
    return ctx.repo_metadata(reproducible = True)

kotlin_sdk_metadata_repository = repository_rule(
    implementation = _kotlin_sdk_metadata_impl,
    attrs = {
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/languages/jvm:kotlin-sdk-metadata.mts"), allow_single_file = True),
        "pom_helper": attr.label(default = Label("//build_defs/languages/jvm:maven-pom.mts"), allow_single_file = True),
        "catalog": attr.label(default = Label("//src/native/sdks/kotlin:gradle/libs.versions.toml"), allow_single_file = True),
        "gradle": attr.label(default = Label("//src/native/sdks/kotlin:oliphaunt/build.gradle.kts"), allow_single_file = True),
        "plugin_gradle": attr.label(default = Label("//src/native/sdks/kotlin/oliphaunt-android-gradle-plugin:build.gradle.kts"), allow_single_file = True),
        "properties": attr.label(default = Label("//src/native/sdks/kotlin:gradle.properties"), allow_single_file = True),
        "version": attr.label(default = Label("//src/native/sdks/kotlin:VERSION"), allow_single_file = True),
        "android_sdk": attr.label(default = Label("//tools/dev:android-sdk.toml"), allow_single_file = True),
    },
)
