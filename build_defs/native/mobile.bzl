"""Compile/link-only iOS runtime construction from configured native PG objects."""

load("@rules_cc//cc:cc_static_library.bzl", "cc_static_library")
load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_import", "cc_library")

def native_ios_runtime_targets():
    """Declare one real archive and its conventional public CcInfo consumer."""
    compatible = ["@platforms//os:ios", "@platforms//cpu:aarch64", "@apple_support//constraints:apple"]
    cc_static_library(
        name = "mobile_static_archive",
        deps = [
            ":wrapper",
            "@postgres//:backend_embedded",
            "@postgres//:main_embedded",
            "@postgres//:plpgsql_embedded",
            "@postgres//:snowball_builtin",
        ],
        target_compatible_with = compatible,
    )
    cc_import(
        name = "mobile_static_import",
        static_library = ":mobile_static_archive",
        alwayslink = True,
        target_compatible_with = compatible,
    )
    cc_library(
        name = "mobile_static",
        deps = [":mobile_static_import"],
        hdrs = ["include/oliphaunt.h"],
        includes = ["include"],
        target_compatible_with = compatible,
    )
    # Compile and link every imported object against the selected SDK. This is
    # deliberately a binary target: it must never run on the macOS executor.
    cc_binary(
        name = "mobile_static_abi_consumer",
        srcs = ["smoke/liboliphaunt_abi_conformance.c"],
        deps = [":mobile_static"],
        copts = ["-std=c11", "-Wall", "-Wextra", "-Werror"],
        target_compatible_with = compatible,
    )
