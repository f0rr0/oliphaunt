"""The actual LP32 EXEC_BACKEND PostgreSQL source graph for the postmaster."""

load("@rules_cc//cc:defs.bzl", "cc_library")
load("//build_defs/native:config.bzl", "pg_config")
load("//build_defs/native:postgres.bzl", "postgres_generated_targets", "postgres_resource_targets")
load("//build_defs/native:resources.bzl", "timezone_database")
load("//build_defs/native:postgres_sources.bzl", "POSTGRES_BACKEND_SOURCES", "POSTGRES_BACKEND_LINUX_SOURCES", "POSTGRES_BACKEND_GENERATED_SOURCES", "POSTGRES_BACKEND_TEXTUAL_SOURCES", "POSTGRES_BACKEND_INCLUDE_DIRECTORIES", "POSTGRES_CATALOG_GENERATED_HEADERS", "POSTGRES_NODE_GENERATED_TEXTUAL_SOURCES", "POSTGRES_WAIT_EVENT_GENERATED_TEXTUAL_SOURCES", "POSTGRES_BACKEND_GENERATED_HEADERS", "POSTGRES_COMMON_GENERATED_HEADERS", "POSTGRES_PLPGSQL_GENERATED_HEADERS", "POSTGRES_COMMON_SOURCES", "POSTGRES_COMMON_RYU_SOURCES", "POSTGRES_COMMON_CONFIG_INFO_SOURCES", "POSTGRES_COMMON_BUILTIN_CRYPTO_SOURCES", "POSTGRES_COMMON_FRONTEND_SHARED_ADDITIONAL_SOURCES", "POSTGRES_COMMON_FRONTEND_STATIC_ADDITIONAL_SOURCES", "POSTGRES_PORT_SOURCES", "POSTGRES_PORT_REPLACEMENT_SOURCES", "POSTGRES_PORT_CRC_GENERIC_SOURCES", "POSTGRES_TIMEZONE_SOURCES", "POSTGRES_MAIN_SOURCES", "POSTGRES_PLPGSQL_SOURCES", "POSTGRES_PLPGSQL_GENERATED_SOURCES", "POSTGRES_SNOWBALL_SOURCES", "POSTGRES_LIBPQ_SOURCES", "POSTGRES_INITDB_SOURCES")
load("//build_defs/wasix:wasm.bzl", "wasix_module")
load(":postgres-config.bzl", "POSTMASTER_PG_CONFIG")
load(":sealing.bzl", "postmaster_seal_modules")
load(":aot.bzl", "postmaster_aot")
load(":carrier.bzl", "postmaster_carrier")
load("@postmaster_postgres//:patches.bzl", "POSTGRES_PATCHES")

_COMPATIBLE = ["@platforms//cpu:wasm32", "@platforms//os:wasi"]
_SYSROOT = "@postmaster_wasix_libc//:sysroot"
_OPTIMIZATION = ["--enable-threads", "--enable-mutable-globals", "--enable-bulk-memory", "--enable-bulk-memory-opt", "--enable-exception-handling", "--enable-simd", "--enable-relaxed-simd", "--enable-extended-const", "--emit-exnref", "--converge", "--strip-debug", "--strip-producers"]

def postmaster_patch_inputs(paths):
    result = []
    for path in paths:
        found = False
        for owner in ["src/wasix/postmaster", "src/third-party/postgres"]:
            if path.startswith(owner + "/"):
                result.append("@oliphaunt//" + owner + ":" + path.removeprefix(owner + "/"))
                found = True
                break
        if not found:
            fail("Unsupported canonical postmaster patch owner: " + path)
    return result

def postgres_postmaster_targets(version):
    """Use canonical patched sources, native generators, and real libc headers."""
    pg_config(name = "configuration", template = "src/include/pg_config.h.in", os_header = "src/include/port/wasix-core.h", version = version, values = POSTMASTER_PG_CONFIG, profile = "Bazel wasm32 WASIX EXEC_BACKEND", prefix = "")
    postgres_generated_targets(version)
    postgres_resource_targets()
    timezone_database(name = "timezone_data", source = "src/timezone/data/tzdata.zi", zic = "@postgres//:zic", posixrules = "")
    native.filegroup(name = "tsearch_dictionaries", srcs = native.glob(["src/backend/tsearch/dicts/*"]))
    native.filegroup(name = "postmaster_timezone_abbreviations", srcs = native.glob(["src/timezone/tznames/*"], exclude = ["src/timezone/tznames/README", "src/timezone/tznames/Makefile", "src/timezone/tznames/meson.build"]))
    generated_headers = POSTGRES_CATALOG_GENERATED_HEADERS + POSTGRES_NODE_GENERATED_TEXTUAL_SOURCES + POSTGRES_WAIT_EVENT_GENERATED_TEXTUAL_SOURCES + POSTGRES_BACKEND_GENERATED_HEADERS + POSTGRES_COMMON_GENERATED_HEADERS + POSTGRES_PLPGSQL_GENERATED_HEADERS
    cc_library(
        name = "headers",
        hdrs = native.glob(["src/include/**/*.h", "src/backend/**/*.h", "src/common/**/*.h", "src/pl/plpgsql/src/*.h", "src/interfaces/libpq/*.h", "src/timezone/*.h"]) + generated_headers + [":configuration"],
        textual_hdrs = POSTGRES_BACKEND_TEXTUAL_SOURCES + native.glob(["src/backend/utils/mb/Unicode/*.map", "src/backend/utils/mb/conversion_procs/**/*.map"]),
        includes = POSTGRES_BACKEND_INCLUDE_DIRECTORIES + ["src/common", "src/pl/plpgsql/src", "src/interfaces/libpq", "src/include/snowball", "src/timezone"],
        defines = ["_GNU_SOURCE", "PG_WASIX_ATOMIC_LATCH_STATE=1"],
        deps = [_SYSROOT],
        target_compatible_with = _COMPATIBLE,
    )
    prefix = native.package_relative_label(":src/include/pg_config.h.in").workspace_root + "/"
    copts = ["-ffile-prefix-map=" + prefix + "=postgres/", "-std=gnu11", "-O3", "-g0", "-flto=thin", "-fPIC", "-pthread", "-fno-strict-aliasing", "-fwrapv", "-nostdinc", "-isystem", Label("@wasix_toolchain//:llvm/bin/clang").workspace_root + "/llvm/lib/clang/21/include", "-Wno-declaration-after-statement", "-Wno-macro-redefined", "-Wno-unused-function", "-Wno-missing-prototypes"]
    common = POSTGRES_COMMON_SOURCES + POSTGRES_COMMON_RYU_SOURCES + POSTGRES_COMMON_CONFIG_INFO_SOURCES + POSTGRES_COMMON_BUILTIN_CRYPTO_SOURCES
    cc_library(name = "abi_check", srcs = ["@oliphaunt//build_defs/wasix/postmaster:postgres-abi.c"], deps = [":headers"], copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
    port = POSTGRES_PORT_SOURCES + POSTGRES_PORT_CRC_GENERIC_SOURCES + [source for macro, source in POSTGRES_PORT_REPLACEMENT_SOURCES.items() if macro not in POSTMASTER_PG_CONFIG]
    for role, definitions, additions in [
        ("server", [], []),
        ("frontend_static", ["FRONTEND", "USE_PRIVATE_ENCODING_FUNCS"], POSTGRES_COMMON_FRONTEND_SHARED_ADDITIONAL_SOURCES + POSTGRES_COMMON_FRONTEND_STATIC_ADDITIONAL_SOURCES),
        ("frontend_shared", ["FRONTEND"], POSTGRES_COMMON_FRONTEND_SHARED_ADDITIONAL_SOURCES),
    ]:
        sources = [source for source in common if source != "src/common/jsonapi.c"] if role == "frontend_shared" else common
        dependencies = [":headers"]
        if role == "frontend_shared":
            cc_library(name = "common_shared_json", srcs = ["src/common/jsonapi.c"], local_defines = ["FRONTEND", "JSONAPI_USE_PQEXPBUFFER"], deps = dependencies, copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
            dependencies = dependencies + [":common_shared_json"]
        cc_library(name = "common_" + role, srcs = sources + additions, local_defines = definitions, deps = dependencies, copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
        cc_library(name = "port_" + role, srcs = port, local_defines = definitions, deps = [":headers"], copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
    cc_library(name = "timezone", srcs = POSTGRES_TIMEZONE_SOURCES, deps = [":headers"], copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
    cc_library(name = "backend", srcs = POSTGRES_BACKEND_SOURCES + POSTGRES_BACKEND_LINUX_SOURCES + POSTGRES_BACKEND_GENERATED_SOURCES, deps = [":headers", ":common_server", ":port_server", ":timezone"], copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
    cc_library(name = "main", srcs = POSTGRES_MAIN_SOURCES, deps = [":headers"], copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
    # The postmaster Makefile expands backend/main/timezone object files before
    # its common and port archives. Preserve ThinLTO until that final link;
    # the embedded core's early no-inline relocatable lowering is a different
    # construction profile.
    wasix_module(name = "postgres_seed", kind = "command", output_name = "postgres", object_deps = [":backend", ":main", ":timezone"], archive_deps = [":common_server", ":port_server"], constructed_sysroot = _SYSROOT, linkopts = ["--export-all", "-Bsymbolic"], optimization_flags = _OPTIMIZATION, target_compatible_with = _COMPATIBLE)
    for role, sources, definitions, dependencies in [
        ("libpq_static", POSTGRES_LIBPQ_SOURCES + ["src/interfaces/libpq/wasix_encoding_shim.c"], ["FRONTEND", "SO_MAJOR_VERSION=5"], [":common_frontend_static", ":port_frontend_static"]),
        ("libpq_shared", POSTGRES_LIBPQ_SOURCES, ["FRONTEND", "SO_MAJOR_VERSION=5", "USE_DYNAMIC_OAUTH"], []),
    ]:
        cc_library(name = role, srcs = sources, local_defines = definitions, deps = [":headers"] + dependencies, copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
    cc_library(name = "initdb_utils", srcs = ["src/fe_utils/option_utils.c", "src/fe_utils/string_utils.c"], deps = [":headers", ":libpq_static"], local_defines = ["FRONTEND", "USE_PRIVATE_ENCODING_FUNCS"], copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
    cc_library(name = "initdb_objects", srcs = POSTGRES_INITDB_SOURCES, deps = [":headers", ":libpq_static", ":initdb_utils"], local_defines = ["FRONTEND", "USE_PRIVATE_ENCODING_FUNCS"], copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
    wasix_module(name = "initdb", kind = "command", output_name = "initdb", deps = [":initdb_objects"], constructed_sysroot = _SYSROOT, linkopts = ["-Bsymbolic"], optimization_flags = _OPTIMIZATION, target_compatible_with = _COMPATIBLE)
    # The libpq Makefile links its own OBJS directly, then selects members of
    # libpgcommon_shlib.a and libpgport_shlib.a on demand. Their unrelated
    # frontend utilities must not become exported libpq definitions.
    wasix_module(name = "libpq", output_name = "libpq.so.5.18", deps = [":libpq_shared"], archive_deps = [":common_frontend_shared", ":port_frontend_shared"], constructed_sysroot = _SYSROOT, linkopts = ["-Bsymbolic"], optimization_flags = _OPTIMIZATION, target_compatible_with = _COMPATIBLE)
    for name, sources in [("plpgsql", POSTGRES_PLPGSQL_SOURCES + POSTGRES_PLPGSQL_GENERATED_SOURCES), ("dict_snowball", POSTGRES_SNOWBALL_SOURCES)]:
        cc_library(name = name + "_objects", srcs = sources, deps = [":headers"], copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
        wasix_module(name = name, output_name = name + ".so", deps = [":" + name + "_objects"], constructed_sysroot = _SYSROOT, linkopts = ["-Bsymbolic"], optimization_flags = _OPTIMIZATION, target_compatible_with = _COMPATIBLE)
    side_targets = [":libpq", ":plpgsql", ":dict_snowball"]
    module_paths = {"libpq": "lib/libpq.so.5.18", "plpgsql": "lib/postgresql/plpgsql.so", "dict_snowball": "lib/postgresql/dict_snowball.so"}
    for makefile in native.glob(["src/backend/utils/mb/conversion_procs/*/Makefile"]):
        directory = makefile.rsplit("/", 1)[0]
        name = directory.rsplit("/", 1)[1]
        cc_library(name = name + "_objects", srcs = native.glob([directory + "/*.c"]), deps = [":headers"], copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
        wasix_module(name = name, output_name = name + ".so", deps = [":" + name + "_objects"], constructed_sysroot = _SYSROOT, linkopts = ["-Bsymbolic"], optimization_flags = _OPTIMIZATION, target_compatible_with = _COMPATIBLE)
        side_targets.append(":" + name)
        module_paths[name] = "lib/postgresql/" + name + ".so"
    native.filegroup(name = "side_modules", srcs = side_targets, target_compatible_with = _COMPATIBLE)
    native.filegroup(name = "unsealed_modules", srcs = [":postgres_seed", ":initdb", ":side_modules"], target_compatible_with = _COMPATIBLE)
    postmaster_seal_modules(name = "sealed_modules", module_paths = ["bin/postgres", "bin/initdb"] + module_paths.values(), main = ":postgres_seed", initdb = ":initdb", sides = ":side_modules", abi_check = ":abi_check", target_compatible_with = _COMPATIBLE, exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64", "@zig_sdk//libc:gnu.2.34"])
    native.alias(name = "sealed_profile_test", actual = "@oliphaunt//src/wasix/postmaster:linux_sealed_profile_test")
    aot_targets = []
    for name, path in dict(module_paths, postgres = "bin/postgres", initdb = "bin/initdb").items():
        target = name + "_aot"
        postmaster_aot(name = target, sealed = ":sealed_modules", module_path = path, target_compatible_with = _COMPATIBLE, exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64", "@zig_sdk//libc:gnu.2.34"])
        aot_targets.append(":" + target)
    native.filegroup(name = "aot_modules", srcs = aot_targets, target_compatible_with = _COMPATIBLE)
    native.filegroup(name = "aot_receipts", srcs = aot_targets, output_group = "receipt", target_compatible_with = _COMPATIBLE)
    postmaster_carrier(
        name = "native_carrier",
        sealed = ":sealed_modules",
        sysroot = _SYSROOT,
        clang = "@wasix_toolchain//:llvm/bin/clang",
        aot = ":aot_modules",
        aot_receipts = ":aot_receipts",
        configuration = ":configuration",
        patches = postmaster_patch_inputs(POSTGRES_PATCHES),
        resources = {
            ":catalog_runtime_data": "share/postgresql/",
            ":builtin_extension_data": "share/postgresql/extension/",
            ":tsearch_dictionaries": "share/postgresql/tsearch_data/",
            ":stopwords": "share/postgresql/tsearch_data/",
            ":postmaster_timezone_abbreviations": "share/postgresql/timezonesets/",
            ":timezone_data": "share/postgresql/timezone",
        },
        target_compatible_with = _COMPATIBLE,
        exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64", "@zig_sdk//libc:gnu.2.34"],
    )
    native.alias(name = "runtime_test", actual = "@oliphaunt//src/wasix/postmaster:linux_runtime_test")
