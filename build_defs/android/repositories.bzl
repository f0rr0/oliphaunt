"""Checksummed NDK acquisition from the existing SDK and platform authorities."""

def _android_ndk_impl(ctx):
    # All imported inputs are watched explicitly; the program is just a TOML/
    # conventional-policy projection, not a compiler or SDK-install handoff.
    for source in [ctx.attr.manifest, ctx.attr.converter, ctx.attr.policy]:
        ctx.read(source)
    ctx.watch(ctx.path(ctx.attr.bun))
    result = ctx.execute([ctx.path(ctx.attr.bun), ctx.path(ctx.attr.converter), ctx.path(ctx.attr.manifest)], quiet = True)
    if result.return_code:
        fail("Cannot import Android native NDK metadata: " + result.stderr)
    metadata = json.decode(result.stdout)
    ctx.download_and_extract(url = metadata["url"], sha256 = metadata["sha256"], stripPrefix = metadata["strip_prefix"])
    revision = None
    for line in ctx.read("source.properties").splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() == "Pkg.Revision":
            revision = value.strip()
    if revision != metadata["revision"]:
        fail("Acquired Android NDK revision %s differs from packages.ndk %s" % (revision, metadata["revision"]))
    prefix = "toolchains/llvm/prebuilt/linux-x86_64"
    resources = [path.basename for path in ctx.path(prefix + "/lib/clang").readdir() if path.is_dir]
    if len(resources) != 1:
        fail("Android NDK must expose exactly one declared Clang resource directory")
    ctx.file("ndk.bzl", "NDK = " + repr(metadata | {"prefix": prefix, "resource": resources[0]}) + "\n")
    ctx.symlink(ctx.attr.build_file, "BUILD.bazel")
    return ctx.repo_metadata(reproducible = True)

android_ndk_repository = repository_rule(
    implementation = _android_ndk_impl,
    attrs = {
        "manifest": attr.label(default = Label("//tools/dev:android-sdk.toml"), allow_single_file = True),
        "converter": attr.label(default = Label("//build_defs/android:metadata.mts"), allow_single_file = True),
        "policy": attr.label(default = Label("//tools/release:platform-compatibility-policy.mts"), allow_single_file = True),
        "bun": attr.label(default = Label("@bun_runtime//:bun"), allow_single_file = True),
        "build_file": attr.label(default = Label("//build_defs/android:ndk.BUILD.bazel"), allow_single_file = True),
    },
)
