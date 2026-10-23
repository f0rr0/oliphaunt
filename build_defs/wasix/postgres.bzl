"""Actual wasm32 PostgreSQL compilation, with separate backend/frontend roles."""

load("@rules_cc//cc:defs.bzl", _cc_library = "cc_library")
load("@rules_cc_autoconf//autoconf:autoconf.bzl", "autoconf")
load("@rules_cc_autoconf//autoconf:autoconf_hdr.bzl", "autoconf_hdr")
load("@rules_cc_autoconf//autoconf:autoconf_srcs.bzl", "autoconf_srcs")
load("@rules_cc_autoconf//autoconf:checks.bzl", "checks")
load("//build_defs/native:config.bzl", "pg_config_layout", "postgres_configuration_values")
load("//build_defs/native:host_config.bzl", "postgres_capability_checks")
load("//build_defs/native:postgres.bzl", "postgres_generated_targets", "postgres_frontend_generated_targets", "postgres_resource_targets")
load("//build_defs/native:resources.bzl", "timezone_database")
load("//build_defs/native:frontend_sources.bzl", "POSTGRES_DUMP_COMMON_SOURCES", "POSTGRES_DUMP_SOURCES", "POSTGRES_PSQL_SOURCES")
load("//build_defs/native:postgres_sources.bzl", "POSTGRES_FRONTEND_UTIL_SOURCES")
load("//build_defs/native:postgres_sources.bzl", "POSTGRES_BACKEND_SOURCES", "POSTGRES_BACKEND_LINUX_SOURCES", "POSTGRES_BACKEND_GENERATED_SOURCES", "POSTGRES_BACKEND_TEXTUAL_SOURCES", "POSTGRES_BACKEND_INCLUDE_DIRECTORIES", "POSTGRES_CATALOG_GENERATED_HEADERS", "POSTGRES_NODE_GENERATED_TEXTUAL_SOURCES", "POSTGRES_WAIT_EVENT_GENERATED_TEXTUAL_SOURCES", "POSTGRES_BACKEND_GENERATED_HEADERS", "POSTGRES_COMMON_GENERATED_HEADERS", "POSTGRES_PLPGSQL_GENERATED_HEADERS", "POSTGRES_COMMON_SOURCES", "POSTGRES_COMMON_RYU_SOURCES", "POSTGRES_COMMON_CONFIG_INFO_SOURCES", "POSTGRES_COMMON_BUILTIN_CRYPTO_SOURCES", "POSTGRES_COMMON_FRONTEND_SHARED_ADDITIONAL_SOURCES", "POSTGRES_COMMON_FRONTEND_STATIC_ADDITIONAL_SOURCES", "POSTGRES_PORT_SOURCES", "POSTGRES_PORT_REPLACEMENT_SOURCES", "POSTGRES_PORT_CRC_GENERIC_SOURCES", "POSTGRES_TIMEZONE_SOURCES", "POSTGRES_MAIN_SOURCES", "POSTGRES_PLPGSQL_SOURCES", "POSTGRES_PLPGSQL_GENERATED_SOURCES", "POSTGRES_SNOWBALL_SOURCES", "POSTGRES_LIBPQ_SOURCES", "POSTGRES_INITDB_SOURCES")
load(":config.bzl", "WASIX_POLICY", "WASIX_COPTS", "WASIX_DEFINES")

_COMPATIBLE = ["@platforms//cpu:wasm32", "@platforms//os:wasi"]
_INITDB_IDENTITY_DEFINES = [name + "=oliphaunt_wasix_" + name for name in ["geteuid", "getuid", "getegid", "getgid", "getpwuid", "getpwuid_r"]]

def cc_library(**kwargs):
    _cc_library(linkstatic = True, **kwargs)

def postgres_wasix_targets(version):
    # Probe libc itself, before the backend's host-I/O symbol redirections.
    definitions = ["_GNU_SOURCE"]
    policy = postgres_configuration_values(version, WASIX_POLICY, "wasm32 WASIX")
    facts = postgres_capability_checks(WASIX_COPTS, definitions, abi = False, excluded = ["HAVE_SYSLOG", "HAVE_PTHREAD_PRIO_INHERIT"])
    facts += [checks.AC_TRY_LINK(code = "#include <math.h>\ndouble (*volatile required_math)(double) = exp; int main(void) { return required_math(1.0) > 0; }", define = "HAVE_LIBM", copts = WASIX_COPTS, linkopts = ["-lm"], if_false = None)]
    autoconf(name = "configuration_facts", checks = [checks.AC_DEFINE(d, 1) for d in definitions + ["__STDC_WANT_LIB_EXT1__"]] + facts + [checks.AC_DEFINE(key, value) for key, value in policy.items()], visibility = ["//visibility:private"], target_compatible_with = _COMPATIBLE)
    autoconf_hdr(name = "configuration_header", out = "src/include/pg_config.h", template = "src/include/pg_config.h.in", deps = [":configuration_facts"], defaults = False, visibility = ["//visibility:private"], target_compatible_with = _COMPATIBLE)
    pg_config_layout(name = "configuration_layout", os_header = "src/include/port/wasix-dl.h", output_directory = "src/include", prefix = "", visibility = ["//visibility:private"], target_compatible_with = _COMPATIBLE)
    native.filegroup(name = "configuration", srcs = [":configuration_header", ":configuration_layout"], target_compatible_with = _COMPATIBLE)
    _cc_library(name = "configuration_contract", srcs = ["@oliphaunt//build_defs/wasix:config_probe.c"], hdrs = [":configuration"], includes = ["src/include"], copts = WASIX_COPTS, linkstatic = True, visibility = ["@oliphaunt//build_defs/wasix:__pkg__"], target_compatible_with = _COMPATIBLE)
    autoconf_srcs(name = "conditional_port_replacements", srcs = {source: "!ac_cv_func_" + macro[len("HAVE_"):].lower() for macro, source in POSTGRES_PORT_REPLACEMENT_SOURCES.items()}, deps = [":configuration_facts"], defaults = False, visibility = ["//visibility:private"], target_compatible_with = _COMPATIBLE)
    postgres_generated_targets(version)
    postgres_frontend_generated_targets()
    postgres_resource_targets()
    timezone_database(name = "timezone_data", source = "src/timezone/data/tzdata.zi", zic = "@postgres//:zic", posixrules = "")
    native.filegroup(name = "tsearch_dictionaries", srcs = native.glob(["src/backend/tsearch/dicts/*"]))
    native.filegroup(name = "wasix_timezone_abbreviations", srcs = native.glob(["src/timezone/tznames/*"], exclude = ["src/timezone/tznames/README", "src/timezone/tznames/Makefile", "src/timezone/tznames/meson.build"]))
    generated_headers = POSTGRES_CATALOG_GENERATED_HEADERS + POSTGRES_NODE_GENERATED_TEXTUAL_SOURCES + POSTGRES_WAIT_EVENT_GENERATED_TEXTUAL_SOURCES + POSTGRES_BACKEND_GENERATED_HEADERS + POSTGRES_COMMON_GENERATED_HEADERS + POSTGRES_PLPGSQL_GENERATED_HEADERS
    for role, definitions in [("server", WASIX_DEFINES), ("frontend", ["_GNU_SOURCE"])]:
        cc_library(
            name = role + "_headers",
            hdrs = native.glob(["src/include/**/*.h", "src/backend/**/*.h", "src/common/**/*.h", "src/pl/plpgsql/src/*.h", "src/interfaces/libpq/*.h", "src/timezone/*.h"]) + generated_headers + [":configuration"],
            textual_hdrs = POSTGRES_BACKEND_TEXTUAL_SOURCES,
            includes = ["src/include/port/wasix-dl"] + POSTGRES_BACKEND_INCLUDE_DIRECTORIES + ["src/common", "src/pl/plpgsql/src", "src/interfaces/libpq", "src/include/snowball", "src/timezone"],
            defines = definitions,
            deps = ["@icu_wasix//:i18n_headers", ":configuration_contract"],
            target_compatible_with = _COMPATIBLE,
        )
    common = POSTGRES_COMMON_SOURCES + POSTGRES_COMMON_RYU_SOURCES + POSTGRES_COMMON_CONFIG_INFO_SOURCES + POSTGRES_COMMON_BUILTIN_CRYPTO_SOURCES
    port = POSTGRES_PORT_SOURCES + POSTGRES_PORT_CRC_GENERIC_SOURCES + [":conditional_port_replacements"]
    for role, definitions, additions in [
        ("server", [], []),
        ("frontend", ["FRONTEND", "USE_PRIVATE_ENCODING_FUNCS"] + _INITDB_IDENTITY_DEFINES, POSTGRES_COMMON_FRONTEND_SHARED_ADDITIONAL_SOURCES + POSTGRES_COMMON_FRONTEND_STATIC_ADDITIONAL_SOURCES),
    ]:
        cc_library(name = "common_" + role, srcs = common + additions, local_defines = definitions, deps = [":" + role + "_headers"], copts = WASIX_COPTS, target_compatible_with = _COMPATIBLE)
        cc_library(name = "port_" + role, srcs = port, local_defines = definitions, deps = [":" + role + "_headers"], copts = WASIX_COPTS, target_compatible_with = _COMPATIBLE)
    cc_library(name = "timezone", srcs = POSTGRES_TIMEZONE_SOURCES, deps = [":server_headers"], copts = WASIX_COPTS, target_compatible_with = _COMPATIBLE)
    cc_library(name = "backend", srcs = POSTGRES_BACKEND_SOURCES + POSTGRES_BACKEND_LINUX_SOURCES + POSTGRES_BACKEND_GENERATED_SOURCES,
               deps = [":server_headers", ":common_server", ":port_server", ":timezone"], local_defines = ["OLIPHAUNT_WASM_SINGLE_BACKEND_ATOMICS"], copts = WASIX_COPTS, alwayslink = True, target_compatible_with = _COMPATIBLE)
    cc_library(name = "main", srcs = POSTGRES_MAIN_SOURCES, deps = [":server_headers"], local_defines = ["OLIPHAUNT_WASM_SINGLE_BACKEND_ATOMICS"], copts = WASIX_COPTS, target_compatible_with = _COMPATIBLE)
    cc_library(name = "plpgsql", srcs = POSTGRES_PLPGSQL_SOURCES + POSTGRES_PLPGSQL_GENERATED_SOURCES, deps = [":server_headers"], copts = WASIX_COPTS, alwayslink = True, target_compatible_with = _COMPATIBLE)
    cc_library(name = "snowball", srcs = POSTGRES_SNOWBALL_SOURCES, deps = [":server_headers"], copts = WASIX_COPTS, alwayslink = True, target_compatible_with = _COMPATIBLE)
    # This command-private libpq uses initdb's encoding/identity profile.
    # Keep the public libpq-facing tools closure independent below.
    cc_library(name = "libpq", srcs = POSTGRES_LIBPQ_SOURCES, deps = [":frontend_headers", ":common_frontend", ":port_frontend"],
               local_defines = ["FRONTEND", "SO_MAJOR_VERSION=5", "USE_PRIVATE_ENCODING_FUNCS"] + _INITDB_IDENTITY_DEFINES, copts = WASIX_COPTS, target_compatible_with = _COMPATIBLE)
    initdb_utils = ["src/fe_utils/option_utils.c", "src/fe_utils/string_utils.c"]
    cc_library(name = "initdb_frontend_utils", srcs = initdb_utils,
               deps = [":frontend_headers", ":common_frontend", ":port_frontend", ":libpq"], local_defines = ["FRONTEND", "USE_PRIVATE_ENCODING_FUNCS"] + _INITDB_IDENTITY_DEFINES, copts = WASIX_COPTS, target_compatible_with = _COMPATIBLE)
    cc_library(name = "initdb_objects", srcs = POSTGRES_INITDB_SOURCES,
               deps = [":frontend_headers", ":common_frontend", ":port_frontend", ":libpq", ":initdb_frontend_utils"],
               local_defines = ["FRONTEND", "USE_PRIVATE_ENCODING_FUNCS"] + _INITDB_IDENTITY_DEFINES + [name + "=oliphaunt_wasix_initdb_" + name for name in ["system", "popen", "pclose"]], copts = WASIX_COPTS, target_compatible_with = _COMPATIBLE)
    cc_library(name = "tools_headers", hdrs = native.glob(["src/bin/pg_dump/*.h", "src/bin/pg_basebackup/*.h", "src/bin/psql/*.h"]) + ["src/bin/psql/sql_help.h"],
               deps = [":frontend_headers"], includes = ["src/bin/pg_dump", "src/bin/pg_basebackup", "src/bin/psql"], target_compatible_with = _COMPATIBLE)
    # The canonical frontend-tools profile intentionally avoids ThinLTO. Keep
    # its shared archives separate from initdb's release objects, with one
    # compiled instance per source/profile and shared maintained headers.
    tools_copts = [option for option in WASIX_COPTS if option != "-flto=thin"]
    # Standalone tools use libpq's public encoding names. Project its shared
    # common profile plus the static-only memory/logging files once, rather
    # than linking both encnames variants with duplicated global tables.
    # PostgreSQL applies PQExpBuffer only to jsonapi_shlib.o.
    cc_library(name = "common_tools_json", srcs = ["src/common/jsonapi.c"],
               local_defines = ["FRONTEND", "JSONAPI_USE_PQEXPBUFFER"], deps = [":frontend_headers"], copts = tools_copts, target_compatible_with = _COMPATIBLE)
    cc_library(name = "common_tools", srcs = [source for source in common if source != "src/common/jsonapi.c"] + POSTGRES_COMMON_FRONTEND_SHARED_ADDITIONAL_SOURCES + POSTGRES_COMMON_FRONTEND_STATIC_ADDITIONAL_SOURCES,
               local_defines = ["FRONTEND"], deps = [":frontend_headers", ":common_tools_json"], copts = tools_copts, target_compatible_with = _COMPATIBLE)
    cc_library(name = "port_tools", srcs = port, local_defines = ["FRONTEND"], deps = [":frontend_headers"], copts = tools_copts, target_compatible_with = _COMPATIBLE)
    cc_library(name = "libpq_tools", srcs = POSTGRES_LIBPQ_SOURCES, deps = [":frontend_headers", ":common_tools", ":port_tools"],
               local_defines = ["FRONTEND", "SO_MAJOR_VERSION=5"], copts = tools_copts, target_compatible_with = _COMPATIBLE)
    cc_library(name = "frontend_utils_tools", srcs = POSTGRES_FRONTEND_UTIL_SOURCES + ["src/fe_utils/psqlscan.c"],
               deps = [":frontend_headers", ":common_tools", ":port_tools", ":libpq_tools"], local_defines = ["FRONTEND"], copts = tools_copts, target_compatible_with = _COMPATIBLE)
    frontend_deps = [":frontend_headers", ":common_tools", ":port_tools", ":libpq_tools", ":frontend_utils_tools", ":tools_headers"]
    # Patch 0025's no-fork stub uses SINGLE_USER. Scope it to parallel.c,
    # which has no UID/pwd/SysV calls, rather than changing every frontend ABI.
    cc_library(name = "dump_parallel", srcs = ["src/bin/pg_dump/parallel.c"], deps = frontend_deps,
               local_defines = ["FRONTEND", "OLIPHAUNT_WASM_SINGLE_USER"], copts = tools_copts, target_compatible_with = _COMPATIBLE)
    cc_library(name = "dump_common", srcs = [source for source in POSTGRES_DUMP_COMMON_SOURCES if source != "src/bin/pg_dump/parallel.c"], deps = frontend_deps + [":dump_parallel"], local_defines = ["FRONTEND"], copts = tools_copts, target_compatible_with = _COMPATIBLE)
    cc_library(name = "pg_dump_objects", srcs = POSTGRES_DUMP_SOURCES, deps = frontend_deps + [":dump_common"], local_defines = ["FRONTEND"], copts = tools_copts, target_compatible_with = _COMPATIBLE)
    cc_library(name = "psql_objects", srcs = POSTGRES_PSQL_SOURCES + ["src/bin/psql/psqlscanslash.c", "src/bin/psql/tab-complete.c", "src/bin/psql/sql_help.c"],
               deps = frontend_deps, local_defines = ["FRONTEND"], copts = tools_copts, target_compatible_with = _COMPATIBLE)
