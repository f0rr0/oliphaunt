"""Pinned source-built GPP execution tool, supported by upstream PostGIS SQLPP."""

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

_BUILD = """
load("@rules_cc//cc:defs.bzl", "cc_binary")
package(default_visibility = ["//visibility:public"])
exports_files(["configure.ac", "src/Makefile.am", "COPYING", "COPYING.LESSER"])
cc_binary(
    name = "gpp",
    srcs = ["src/gpp.c"],
    # gpp.c's upstream WIN_NT branch owns CRT aliases and its fnmatch fallback.
    defines = select({
        "@platforms//os:windows": ["WIN_NT", "PACKAGE_STRING=\\\"GPP 2.28\\\""],
        "//conditions:default": ["HAVE_FNMATCH_H=1", "HAVE_STRDUP=1", "HAVE_STRCASECMP=1", "'PACKAGE_STRING=\\\"GPP 2.28\\\"'"],
    }),
    target_compatible_with = select({
        "@platforms//os:linux": [], "@platforms//os:macos": [], "@platforms//os:windows": [],
        "//conditions:default": ["@platforms//:incompatible"],
    }),
)
"""

def _impl(_module_ctx):
    http_archive(name = "postgis_gpp",
                 urls = ["https://codeload.github.com/logological/gpp/tar.gz/fc9cc00078999dabd795b782eebc94780cf39a29"],
                 sha256 = "c172969881f7f76918c18b5406a8bf8ac3aeca6ea859628e4edabe4e8a7fbcd1",
                 type = "tar.gz",
                 strip_prefix = "gpp-fc9cc00078999dabd795b782eebc94780cf39a29", build_file_content = _BUILD)

postgis_gpp = module_extension(implementation = _impl)
