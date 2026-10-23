"""Compiler-derived native facts, qualified separately before PG config cutover.

The maintained checker compiles/links probes with the actual target CC toolchain;
it never executes a target program to establish type size or alignment.
"""

load("@bazel_skylib//rules:write_file.bzl", "write_file")
load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_library", "cc_test")
load("@rules_cc_autoconf//autoconf:autoconf.bzl", "autoconf")
load("@rules_cc_autoconf//autoconf:autoconf_hdr.bzl", "autoconf_hdr")
load("@rules_cc_autoconf//autoconf:checks.bzl", "checks", "macros")
load(":postgres_sources.bzl", "POSTGRES_PORT_REPLACEMENT_SOURCES")

def native_compiler_probe_targets(name):
    """Expose a real positive link, negative probes and target ABI facts."""
    # This is a platform preflight, not a replacement pg_config.h. Backend
    # features, source roles and platform libraries need separate PG evidence.
    probe_checks = macros.AC_CHECK_HEADERS([
        "stdio.h", "stdint.h", "stdlib.h", "strings.h", "string.h",
        "unistd.h", "sys/types.h", "sys/epoll.h", "sys/event.h",
        "oliphaunt-native-probe-missing-header.h",
    ]) + macros.AC_CHECK_FUNCS([
        macro[len("HAVE_"):].lower()
        for macro in POSTGRES_PORT_REPLACEMENT_SOURCES.keys()
    ]) + [
        checks.AC_CHECK_SIZEOF("long", define = "SIZEOF_LONG"),
        checks.AC_CHECK_SIZEOF("long long", define = "SIZEOF_LONG_LONG"),
        checks.AC_CHECK_SIZEOF("size_t", define = "SIZEOF_SIZE_T"),
        checks.AC_CHECK_SIZEOF("void *", define = "SIZEOF_VOID_P"),
        checks.AC_CHECK_ALIGNOF("double", define = "ALIGNOF_DOUBLE"),
        checks.AC_CHECK_ALIGNOF("int", define = "ALIGNOF_INT"),
        checks.AC_CHECK_ALIGNOF("int64_t", define = "ALIGNOF_INT64_T", includes = ["#include <stdint.h>"]),
        checks.AC_CHECK_ALIGNOF("long", define = "ALIGNOF_LONG"),
        checks.AC_CHECK_ALIGNOF("short", define = "ALIGNOF_SHORT"),
        checks.AC_CHECK_TYPE("oliphaunt_native_probe_missing_type", define = "HAVE_OLIPHAUNT_MISSING_TYPE"),
    ]
    probe_checks = [checks.AC_DEFINE("_GNU_SOURCE", "1")] + [
        json.encode(json.decode(probe) | {"compile_defines": ["_GNU_SOURCE"]})
        for probe in probe_checks
    ]
    autoconf(
        name = name + "_facts",
        checks = probe_checks,
    )
    write_file(
        name = name + "_template",
        out = name + ".h.in",
        content = ["#undef " + json.decode(probe)["define"] for probe in probe_checks],
    )
    autoconf_hdr(
        name = name + "_header",
        out = name + ".h",
        template = ":" + name + "_template",
        deps = [":" + name + "_facts"],
        defaults = False,
    )
    cc_library(
        name = name + "_headers",
        hdrs = [":" + name + "_header"],
        includes = ["."],
    )
    # A broken compiler/sysroot may return the same status as an absent optional
    # feature. Require one genuine standard-library compile/link per target
    # configuration, rather than repeating a sanity compile inside every probe.
    cc_binary(name = name + "_sanity", srcs = ["probe-sanity.c"])
    cc_library(
        name = name + "_contract",
        srcs = ["compiler-probe-contract.c"],
        deps = [":" + name + "_headers"],
        local_defines = ["OLIPHAUNT_COMPILER_PROBE_HEADER=" + name + ".h"],
    )
    native.filegroup(
        name = name + "_configuration",
        srcs = [":" + name + "_header", ":" + name + "_sanity", ":" + name + "_contract"],
    )
    cc_test(
        name = name + "_test",
        deps = [":" + name + "_contract"],
        data = [":" + name + "_sanity"],
        # The contract is a compile-only assertion plus trivial main, not a
        # shared-library ABI consumer. Avoid constructing an unused probe DSO.
        linkstatic = True,
        size = "small",
    )
