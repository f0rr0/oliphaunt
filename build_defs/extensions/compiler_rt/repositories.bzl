"""The upstream CPU-model provider required by Clang function multiversioning."""

_BUILD = """
load("@rules_cc//cc:defs.bzl", "cc_library")
package(default_visibility = ["//visibility:public"])
exports_files(["LICENSE.TXT", "SOURCE.json", "source.bzl"])
cc_library(
    name = "cpu_model",
    srcs = ["x86.c"],
    hdrs = ["cpu_model.h"],
    copts = ["-fPIC"],
    alwayslink = True,
    target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"],
)
"""

def _compiler_rt_impl(ctx):
    source = json.decode(ctx.read(ctx.attr.source))
    if source.get("schema") != "oliphaunt-compiler-runtime-source-v1" or source.get("project") != "llvm-compiler-rt":
        fail("invalid compiler-runtime source identity")
    commit = source.get("commit", "")
    if len(commit) != 40 or any([c not in "0123456789abcdef" for c in commit.elems()]):
        fail("compiler-runtime acquisition requires an immutable LLVM commit")
    expected = {
        "x86.c": "compiler-rt/lib/builtins/cpu_model/x86.c",
        "cpu_model.h": "compiler-rt/lib/builtins/cpu_model/cpu_model.h",
        "LICENSE.TXT": "compiler-rt/LICENSE.TXT",
    }
    seen = []
    for file in source["files"]:
        destination = file["destination"]
        if destination in seen or expected.get(destination) != file["path"]:
            fail("compiler-runtime acquisition differs from the reviewed CPU-model closure")
        seen.append(destination)
        digest = file["sha256"]
        if len(digest) != 64 or any([c not in "0123456789abcdef" for c in digest.elems()]):
            fail("compiler-runtime file requires SHA256")
        ctx.download(
            url = "https://raw.githubusercontent.com/llvm/llvm-project/%s/%s" % (commit, file["path"]),
            output = destination,
            sha256 = digest,
        )
    if sorted(seen) != sorted(expected.keys()):
        fail("compiler-runtime acquisition must include C source, header, and license")
    ctx.file("SOURCE.json", json.encode(source))
    ctx.file("source.bzl", "COMPILER_RT_SOURCE = " + repr(source) + "\n")
    ctx.file("BUILD.bazel", _BUILD)

compiler_rt_repository = repository_rule(
    implementation = _compiler_rt_impl,
    attrs = {"source": attr.label(allow_single_file = True, default = Label("//build_defs/extensions/compiler_rt:source.json"))},
)
