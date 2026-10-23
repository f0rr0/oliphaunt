"""Actual PostGIS core and C++ dependency WASI side modules."""

load("@rules_cc//cc:defs.bzl", "cc_library")
load("//build_defs/extensions:contrib.bzl", "contrib_generated_sources")
load("//build_defs/extensions/postgis:generators.bzl", "postgis_flex")
load("//build_defs/extensions/postgis:libraries.bzl", "postgis_source_headers")
load("//build_defs/extensions/postgis:modules.bzl", "POSTGIS_LWGEOM_SOURCES", "POSTGIS_PG_SOURCES", "POSTGIS_PGCOMMON_SOURCES", "POSTGIS_RASTER_SOURCES", "POSTGIS_RTCORE_SOURCES", "POSTGIS_TOPOLOGY_SOURCES")
load("//build_defs/extensions/postgis:sql.bzl", "postgis_sql")
load("//build_defs/wasix:config.bzl", "WASIX_COPTS")
load("//build_defs/wasix:wasm.bzl", "wasix_module")
load(":headers.bzl", "wasix_dependency_headers")
load(":postgis.bzl", "WASIX_DEPENDENCY_COMPATIBLE")

def wasix_postgis_modules(name = "postgis"):
    prefix = "@postgis//:"
    wasix_dependency_headers(
        name = name + "_config",
        kind = "postgis",
        root = prefix + "Version.config",
        inputs = [prefix + path for path in ["postgis_config.h.in", "liblwgeom/liblwgeom.h.in", "postgis/sqldefines.h.in", "raster/raster_config.h.in"]] + [prefix + "extensions/" + member + "/" + member + ".control.in" for member in ["postgis", "postgis_raster", "postgis_topology", "postgis_tiger_geocoder"]],
        outs = ["postgis_config.h", "liblwgeom/liblwgeom.h", "postgis/sqldefines.h", "raster/rt_core/raster_config.h", "postgis_revision.h"] + ["extensions/" + member + "/" + member + ".control" for member in ["postgis", "postgis_raster", "postgis_topology", "postgis_tiger_geocoder"]],
        include_dirs = ["", "liblwgeom", "postgis", "raster/rt_core"],
    )
    postgis_source_headers(
        name = name + "_headers",
        root = prefix + "Version.config",
        headers = [prefix + "postgis_headers"],
        include_dirs = ["liblwgeom", "libpgcommon", "postgis", "raster", "raster/rt_core", "raster/rt_pg", "topology", "deps", "deps/flatgeobuf", "deps/flatgeobuf/include", ""],
    )
    contrib_generated_sources(
        name = name + "_wkt",
        grammar = prefix + "liblwgeom/lwin_wkt_parse.y",
        scanner = prefix + "liblwgeom/lwin_wkt_lex.l",
        grammar_options = ["-d", "-p", "wkt_yy"],
        scanner_options = ["-i"],
        scanner_rule = postgis_flex,
    )
    cc_library(name = name + "_ryu", srcs = [prefix + "deps/ryu/d2s.c"], deps = [":" + name + "_headers"], defines = ["RYU_NO_TRAILING_ZEROS"], copts = WASIX_COPTS + ["-fPIC", "-fvisibility=hidden"], linkstatic = True, target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)
    cc_library(
        name = name + "_lwgeom",
        srcs = [prefix + source for source in POSTGIS_LWGEOM_SOURCES] + [":" + name + "_wkt"],
        deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_wkt", ":" + name + "_ryu", ":geos", ":proj", ":json_c"],
        copts = WASIX_COPTS + ["-fPIC", "-fvisibility=hidden"],
        linkstatic = True,
        target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE,
    )
    cc_library(
        name = name + "_flatgeobuf",
        srcs = [prefix + "deps/flatgeobuf/" + source + ".cpp" for source in ["flatgeobuf_c", "geometrywriter", "geometryreader", "packedrtree"]],
        deps = [":" + name + "_config", ":" + name + "_headers", ":proj"],
        copts = ["-std=c++17", "-O2", "-g0", "-fPIC", "-flto=thin", "-fvisibility=hidden", "-fvisibility-inlines-hidden"],
        defines = ["flatbuffers=postgis_flatbuffers"],
        linkstatic = True,
        target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE,
    )
    cc_library(name = name + "_lifecycle", srcs = ["postgis_lifecycle.c"], copts = WASIX_COPTS + ["-fPIC", "-fvisibility=hidden"], linkstatic = True, target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)
    cc_library(name = name + "_rtcore", srcs = [prefix + source for source in POSTGIS_RTCORE_SOURCES],
               deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_lwgeom", ":gdal"],
               copts = WASIX_COPTS + ["-fPIC", "-fvisibility=hidden"], linkstatic = True, target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)
    wasix_module(
        name = name + "_dependency_module",
        output_name = "liboliphaunt_postgis_deps.so",
        deps = [":" + name + "_lifecycle"] + [":" + library for library in ["gdal", "geos", "proj", "sqlite", "json_c", "libxml2", "iconv"]],
        cxx_runtime = True,
        linkopts = ["--export-all", "--no-gc-sections"],
        target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE,
    )
    cc_library(
        name = name + "_objects",
        srcs = [prefix + source for source in POSTGIS_PG_SOURCES],
        deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_lwgeom", ":" + name + "_flatgeobuf", ":libxml2", ":iconv", "@postgres_wasix//:server_headers"],
        copts = WASIX_COPTS + ["-fPIC", "-fvisibility=hidden"],
        linkstatic = True,
        target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE,
    )
    wasix_module(
        name = name,
        output_name = "postgis-3.so",
        deps = [":" + name + "_objects"],
        dynamic_deps = [":" + name + "_dependency_module"],
        target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE,
    )
    for member, sources, extra in [("raster", POSTGIS_RASTER_SOURCES, [":" + name + "_rtcore", ":gdal"]), ("topology", POSTGIS_TOPOLOGY_SOURCES, [])]:
        cc_library(name = name + "_" + member + "_objects", srcs = [prefix + source for source in sources + POSTGIS_PGCOMMON_SOURCES],
                   deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_lwgeom", "@postgres_wasix//:server_headers"] + extra,
                   copts = WASIX_COPTS + ["-fPIC", "-fvisibility=hidden"], linkstatic = True, target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)
        wasix_module(name = name + "_" + member, output_name = "postgis_" + member + "-3.so", deps = [":" + name + "_" + member + "_objects"],
                     dynamic_deps = [":" + name + "_dependency_module"], target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)
    postgis_sql(name = name + "_sql_resources", configuration = ":" + name + "_config", headers = ":" + name + "_headers", target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)
    native.filegroup(name = name + "_extension_sql", srcs = [":" + name + "_sql_resources"], output_group = "extension_sql")
    native.filegroup(name = name + "_data_sql", srcs = [":" + name + "_sql_resources"], output_group = "data_sql")
    native.filegroup(name = name + "_control", srcs = [":" + name + "_config"], output_group = "control")
