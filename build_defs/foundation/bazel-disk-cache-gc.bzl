"""Pinned stock Bazel disk cache collector, without a Bazel source build."""

def _bazel_disk_cache_gc_impl(ctx):
    version = ctx.read(ctx.attr.version).strip()
    os = ctx.os.name.lower()
    os = "darwin" if os.startswith("mac") else "windows" if os.startswith("windows") else os
    arch = {"amd64": "x86_64", "arm64": "arm64", "aarch64": "arm64"}.get(ctx.os.arch.lower(), ctx.os.arch.lower())
    asset = "bazel-%s-%s-%s%s" % (version, os, arch, ".exe" if os == "windows" else "")
    hashes = [fields[2] for line in ctx.read(ctx.attr.checksums).splitlines() for fields in [line.split("\t")] if len(fields) == 3 and fields[:2] == [version, asset]]
    if len(hashes) != 1:
        fail("Expected one pinned Bazel checksum for " + asset)

    # Official binaries are ZIP self-extractors. Rename before stripping so the
    # stock extractor reads only the server library, retaining its JNI resources.
    ctx.download_and_extract(
        url = "https://releases.bazel.build/%s/release/%s" % (version, asset),
        sha256 = hashes[0],
        type = "zip",
        rename_files = {"A-server.jar": "gc/A-server.jar"},
        strip_prefix = "gc",
    )
    ctx.download(
        url = "https://raw.githubusercontent.com/bazelbuild/bazel/%s/src/tools/diskcache/Gc.java" % version,
        sha256 = ctx.attr.source_sha256,
        output = "Gc.java",
    )
    ctx.file("BUILD.bazel", """load("@rules_java//java:defs.bzl", "java_binary", "java_import")
package(default_visibility = ["//visibility:public"])
# Restore the upstream util:blocker, unsafe:string and skyframe/serialization
# module access metadata, which is not carried by a precompiled JAR.
java_import(
    name = "server",
    jars = ["A-server.jar"],
    add_exports = ["java.base/jdk.internal.misc"],
    add_opens = ["java.base/java.lang", "java.base/java.lang.invoke"],
)
java_binary(name = "gc", srcs = ["Gc.java"], deps = [":server"], main_class = "diskcache.Gc")
""")
    return ctx.repo_metadata(reproducible = True)

bazel_disk_cache_gc_repository = repository_rule(
    implementation = _bazel_disk_cache_gc_impl,
    attrs = {
        "version": attr.label(default = Label("//:.bazelversion"), allow_single_file = True),
        "checksums": attr.label(default = Label("//tools/dev:bazel-checksums.tsv"), allow_single_file = True),
        # Unchanged upstream 8.8.1 source; review this pin when updating Bazel.
        "source_sha256": attr.string(default = "f96bc004ae64e2ad8440eaf9ecb94eb9760b7085864fc195f578a712b2b6d547"),
    },
)
