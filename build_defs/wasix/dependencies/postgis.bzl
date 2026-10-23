"""Direct WASI PostGIS dependency compilation with real LP32 configuration."""

load("@rules_cc//cc:defs.bzl", "cc_library")
load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_DEPENDENCIES")
load("//build_defs/extensions/postgis:libraries.bzl", "postgis_source_headers")
load("//build_defs/extensions/postgis:sqlite.bzl", "SQLITE_CORE_SOURCES", "SQLITE_FTS3_SOURCES", "sqlite_generate")
load(":headers.bzl", "wasix_dependency_headers")
load(":proj_resources.bzl", "wasix_proj_database", "wasix_proj_embed")

WASIX_DEPENDENCY_COMPATIBLE = ["@platforms//cpu:wasm32", "@platforms//os:wasi"]
# The maintained WASIX recipe emits conventional O2 objects for the aggregate
# geospatial side module; its complete C++ archive closure must not use ThinLTO.
_C = ["-std=gnu11", "-O2", "-g0", "-fPIC", "-fvisibility=hidden"]
_CXX = ["-std=c++17", "-O2", "-g0", "-fPIC", "-fvisibility=hidden", "-fvisibility-inlines-hidden"]
_JSON_C = "arraylist debug json_c_version json_object json_object_iterator json_tokener json_util json_visit linkhash printbuf random_seed strerror_override json_pointer json_patch".split(" ")
_XML = "HTMLparser HTMLtree SAX2 buf c14n catalog chvalid debugXML dict encoding entities error globals hash list nanohttp parser parserInternals pattern relaxng schematron threads tree uri valid xinclude xlink xmlIO xmlmemory xmlmodule xmlreader xmlregexp xmlsave xmlschemas xmlschemastypes xmlstring xmlunicode xmlwriter xpath xpointer xzlib".split(" ")

def _pin(name, commit):
    if EXTENSION_DEPENDENCIES["postgis"][name]["commit"] != commit:
        fail("review the WASI %s source/configuration recipe before updating its canonical pin" % name)

def wasix_postgis_sqlite(name):
    _pin("sqlite", "ccd445d76a9362c63add000354fac84ba9022176")
    prefix = "@postgis_sqlite//:"
    generated = name + "_generated"
    sqlite_generate(
        name = generated,
        inputs = [prefix + "all_sources"],
        version = prefix + "VERSION",
        jim = "//build_defs/extensions/postgis:sqlite_jim",
        lemon = "//build_defs/extensions/postgis:sqlite_lemon",
        mksourceid = "//build_defs/extensions/postgis:sqlite_mksourceid",
        mkkeywordhash = "//build_defs/extensions/postgis:sqlite_mkkeywordhash",
    )
    native.filegroup(name = name + "_generated_sources", srcs = [":" + generated], output_group = "library_sources")
    postgis_source_headers(name = name + "_headers", root = prefix + "VERSION", headers = [prefix + "headers", prefix + "ext/rtree/geopoly.c"], include_dirs = ["src", "ext/rtree", "ext/icu", "ext/fts3", "ext/session"])
    cc_library(
        name = name,
        srcs = [prefix + "src/" + source + ".c" for source in SQLITE_CORE_SOURCES] + [prefix + "ext/fts3/" + source + ".c" for source in SQLITE_FTS3_SOURCES] + [prefix + path for path in ["ext/icu/icu.c", "ext/rtree/rtree.c", "ext/session/sqlite3session.c", "ext/rbu/sqlite3rbu.c", "ext/misc/stmt.c"]] + [":" + name + "_generated_sources"],
        hdrs = [prefix + "headers"],
        deps = [":" + generated, ":" + name + "_headers"],
        local_defines = ["SQLITE_CORE"],
        defines = ["SQLITE_THREADSAFE=0", "SQLITE_OMIT_LOAD_EXTENSION"],
        copts = _C,
        linkstatic = True,
        target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE,
    )

def wasix_postgis_geos(name):
    _pin("geos", "c389f532d25fe6228861d9b19339f9cb57ca4bdb")
    prefix = "@postgis_geos//:"
    wasix_dependency_headers(name = name + "_config", kind = "geos", root = prefix + "Version.txt", inputs = [prefix + "include/geos/version.h.in", prefix + "capi/geos_c.h.in"], outs = ["geos_c.h", "geos/version.h"])
    postgis_source_headers(name = name + "_headers", root = prefix + "Version.txt", headers = [prefix + "headers"], include_dirs = ["include", "src/deps"])
    cc_library(name = name + "_ryu", srcs = [prefix + "native_c_sources"], deps = [":" + name + "_headers"], copts = _C, linkstatic = True, target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)
    cc_library(name = name, srcs = [prefix + "native_sources"], hdrs = [prefix + "headers"], deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_ryu"], copts = _CXX, defines = ["USE_UNSTABLE_GEOS_CPP_API", "HAVE_FENV"], linkstatic = True, target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)

def wasix_postgis_json_c(name):
    _pin("json-c", "41a55cfcedb54d9c1874f2f0eb07b504091d7e37")
    prefix = "@postgis_json_c//:"
    wasix_dependency_headers(name = name + "_config", kind = "json_c", root = prefix + "CMakeLists.txt", inputs = [prefix + "cmake/config.h.in", prefix + "cmake/json_config.h.in", prefix + "json.h.cmakein"], outs = ["config.h", "json_config.h", "json.h"])
    postgis_source_headers(name = name + "_headers", root = prefix + "CMakeLists.txt", headers = [prefix + "headers"], include_dirs = ["."])
    cc_library(name = name, srcs = [prefix + stem + ".c" for stem in _JSON_C], hdrs = [prefix + "headers"], deps = [":" + name + "_config", ":" + name + "_headers"], defines = ["_GNU_SOURCE"], copts = _C, linkstatic = True, target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)

def wasix_postgis_libxml2(name):
    _pin("libxml2", "d23960a130c5bb82779c9405fbbf85e65fb3c57c")
    prefix = "@postgis_libxml2//:"
    wasix_dependency_headers(name = name + "_config", kind = "libxml2", root = prefix + "VERSION", inputs = [prefix + "config.h.cmake.in", prefix + "include/libxml/xmlversion.h.in"], outs = ["config.h", "libxml/xmlversion.h"])
    postgis_source_headers(name = name + "_headers", root = prefix + "VERSION", headers = [prefix + "headers"], include_dirs = ["include", "."])
    cc_library(name = name, srcs = [prefix + stem + ".c" for stem in _XML], hdrs = [prefix + "headers"], deps = [":" + name + "_config", ":" + name + "_headers"], defines = ["HAVE_STRINGS_H", "HAVE_UNISTD_H"], copts = _C, linkstatic = True, target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)

def wasix_postgis_iconv(name):
    if EXTENSION_DEPENDENCIES["postgis"]["libiconv"]["sha256"] != "88dd96a8c0464eca144fc791ae60cd31cd8ee78321e67397e25fc095c4a19aa6":
        fail("review the WASI libiconv source/configuration recipe before changing its canonical pin")
    prefix = "@postgis_libiconv//:"
    wasix_dependency_headers(name = name + "_config", kind = "libiconv", root = prefix + "configure", inputs = [prefix + path for path in ["lib/config.h.in", "include/iconv.h.build.in", "libcharset/include/localcharset.h.build.in", "libcharset/include/libcharset.h.build.in"]], outs = ["config.h", "iconv.h", "localcharset.h", "libcharset.h"])
    postgis_source_headers(name = name + "_headers", root = prefix + "configure", headers = [prefix + "headers", prefix + "lib/encodings.def", prefix + "lib/encodings_local.def"], include_dirs = ["lib", "include", "libcharset/include"])
    cc_library(name = name, srcs = [prefix + path for path in ["lib/iconv.c", "lib/compat.c", "libcharset/lib/localcharset.c", "libcharset/lib/relocatable-stub.c"]], hdrs = [prefix + "headers"], deps = [":" + name + "_config", ":" + name + "_headers"], local_defines = ["BUILDING_LIBICONV", "BUILDING_LIBCHARSET"], copts = _C, linkstatic = True, target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)

def wasix_postgis_proj(name, sqlite):
    _pin("proj", "f08fa86c478c4bbbf003b1ec751dd84aa6eca486")
    prefix = "@postgis_proj//:"
    wasix_dependency_headers(name = name + "_config", kind = "proj", root = prefix + "CMakeLists.txt", inputs = [prefix + "cmake/proj_config.cmake.in"], outs = ["proj_config.h"])
    postgis_source_headers(name = name + "_headers", root = prefix + "CMakeLists.txt", headers = [prefix + "headers"], include_dirs = ["include", "src"])
    wasix_proj_database(name = name + "_database")
    wasix_proj_embed(name = name + "_embedded", database = ":" + name + "_database")
    native.filegroup(name = name + "_embedded_sources", srcs = [":" + name + "_embedded"], output_group = "library_sources")
    defines = ["PROJ_DLL=", "PROJ_HAS_PTHREADS", "EMBED_RESOURCE_FILES=1", "USE_ONLY_EMBEDDED_RESOURCE_FILES=1"]
    cc_library(name = name + "_c", srcs = [prefix + "native_c_sources", prefix + "src/embedded_resources.c", prefix + "src/memvfs.c", ":" + name + "_embedded_sources"], hdrs = [prefix + "headers"], deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_embedded", sqlite], defines = defines, copts = _C, linkstatic = True, target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)
    cc_library(name = name, srcs = [prefix + "native_sources"], hdrs = [prefix + "headers"], deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_c", sqlite], defines = defines, copts = _CXX, linkstatic = True, target_compatible_with = WASIX_DEPENDENCY_COMPATIBLE)

def wasix_postgis_dependencies():
    wasix_postgis_sqlite(name = "sqlite")
    wasix_postgis_geos(name = "geos")
    wasix_postgis_json_c(name = "json_c")
    wasix_postgis_libxml2(name = "libxml2")
    wasix_postgis_iconv(name = "iconv")
    wasix_postgis_proj(name = "proj", sqlite = ":sqlite")
