"""Canonical static PostGIS component archives and actual mobile module objects."""

load("@rules_cc//cc:defs.bzl", "cc_import", "cc_library")
load("//build_defs/extensions:mobile.bzl", "MOBILE_EXTENSION_COMPATIBLE", "mobile_static_archive", "native_mobile_extension")
load(":compiler_facts.bzl", "postgis_mobile_compiler_facts")
load(":libraries.bzl", "POSTGIS_MATH_LINKOPTS", "POSTGIS_THREAD_LINKOPTS", "postgis_geos", "postgis_iconv", "postgis_json_c", "postgis_libxml2", "postgis_proj")
load(":modules.bzl", "POSTGIS_PG_SOURCES", "postgis_standalone")
load(":sqlite.bzl", "postgis_sqlite")

POSTGIS_MOBILE_ARCHIVES = {
    "geos-c": "//build_defs/extensions/postgis/mobile:geos_c",
    "geos": "//build_defs/extensions/postgis/mobile:geos",
    "proj": "//build_defs/extensions/postgis/mobile:proj",
    "sqlite": "//build_defs/extensions/postgis/mobile:sqlite3",
    "libxml2": "//build_defs/extensions/postgis/mobile:xml2",
    "json-c": "//build_defs/extensions/postgis/mobile:json-c",
    "libiconv": "//build_defs/extensions/postgis/mobile:iconv",
    "libcharset": "//build_defs/extensions/postgis/mobile:charset",
}
POSTGIS_MOBILE_LIBRARIES = {identity: archive + "_library" for identity, archive in POSTGIS_MOBILE_ARCHIVES.items()}

_ANDROID = select({"//build_defs/native:android": [":iconv_objects"], "//conditions:default": []})
_ANDROID_LIBRARIES = select({"//build_defs/native:android": [":iconv_library", ":charset_library"], "//conditions:default": []})

def _database_impl(ctx):
    return [DefaultInfo(files = ctx.attr.database[DefaultInfo].files)]

_execution_database = rule(implementation = _database_impl, attrs = {
    "database": attr.label(default = "//build_defs/extensions/postgis:database", cfg = "exec", allow_single_file = True),
})

def _archive(name, roots, link_deps = [], linkopts = []):
    mobile_static_archive(name = name, roots = roots, target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    # Ordinary dependency imports allow libiconv/libcharset to resolve their
    # shared localcharset unit once, as their upstream static link recipe does.
    cc_import(name = name + "_import", static_library = ":" + name, target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    cc_library(name = name + "_library", deps = [":" + name + "_import"] + link_deps, linkopts = linkopts,
               target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)

def mobile_postgis():
    profile = "mobile-static"
    postgis_mobile_compiler_facts()
    _execution_database(name = "database", target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    postgis_sqlite(name = "sqlite_objects", profile = profile)
    postgis_geos(name = "geos_objects", capi_name = "geos_c_objects", profile = profile)
    postgis_json_c(name = "json_c_objects", profile = profile)
    postgis_proj(name = "proj_objects", sqlite = ":sqlite_objects", database = ":database", profile = profile)
    postgis_iconv(name = "iconv_objects", charset_name = "charset_objects", profile = profile)
    postgis_libxml2(name = "xml2_objects", profile = profile)
    _archive(name = "sqlite3", roots = [":sqlite_objects"])
    _archive(name = "geos", roots = [":geos_objects", ":geos_objects_ryu"], linkopts = POSTGIS_THREAD_LINKOPTS)
    _archive(name = "geos_c", roots = [":geos_c_objects"], link_deps = [":geos_library"])
    _archive(name = "json-c", roots = [":json_c_objects"], linkopts = POSTGIS_MATH_LINKOPTS)
    _archive(name = "proj", roots = [":proj_objects", ":proj_objects_c"], link_deps = [":sqlite3_library"], linkopts = POSTGIS_THREAD_LINKOPTS)
    _archive(name = "iconv", roots = [":iconv_objects"])
    _archive(name = "charset", roots = [":charset_objects"])
    _archive(name = "xml2", roots = [":xml2_objects"], linkopts = POSTGIS_MATH_LINKOPTS)
    postgis_standalone(name = "postgis", profile = profile)
    native_mobile_extension(name = "extension", sql_name = "postgis",
                            srcs = ["@postgis//:" + source for source in POSTGIS_PG_SOURCES],
                            deps = [":postgis_config", ":postgis_headers", ":postgis_lwgeom", ":postgis_flatgeobuf", ":xml2_objects"] + _ANDROID,
                            object_roots = [":postgis_lwgeom", ":postgis_flatgeobuf", ":postgis_ryu"],
                            consumer_deps = [":geos_c_library", ":proj_library", ":json-c_library", ":xml2_library"] + _ANDROID_LIBRARIES)
    native.filegroup(name = "dependency_archives", srcs = [":" + name for name in ["geos_c", "geos", "proj", "sqlite3", "xml2", "json-c"]] +
                     select({"//build_defs/native:android": [":iconv", ":charset"], "//conditions:default": []}),
                     target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
