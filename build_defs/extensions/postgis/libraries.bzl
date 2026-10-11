"""Direct target C/C++ libraries for the pinned PostGIS dependency closure."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_DEPENDENCIES", "EXTENSION_SOURCES", "POSTGRES_SOURCE")
load("@rules_cc//cc:defs.bzl", "cc_library")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("//build_defs/extensions:platforms.bzl", "NATIVE_EXTENSION_COMPATIBLE", "NATIVE_EXTENSION_CONFIGURATION")
load("//build_defs/extensions:mobile.bzl", "MOBILE_EXTENSION_COMPATIBLE", "MOBILE_EXTENSION_CONFIGURATION")
load("//build_defs/foundation:bun.bzl", "BunScriptInfo", "bun_action")
load("//build_defs/wasix/dependencies:proj_resources.bzl", "wasix_proj_embed")
load(":compiler_facts.bzl", "POSTGIS_COMPILER_FACTS", "POSTGIS_MOBILE_COMPILER_FACTS")

POSTGIS_NATIVE_COPTS = select({"//build_defs/native:windows_x64": ["/std:c11", "/D_CRT_SECURE_NO_WARNINGS", "/D_CRT_NONSTDC_NO_WARNINGS", "/D_USE_MATH_DEFINES"], "//conditions:default": []})
POSTGIS_NATIVE_CXX_COPTS = select({"//build_defs/native:windows_x64": ["/std:c++17", "/D_CRT_SECURE_NO_WARNINGS", "/D_USE_MATH_DEFINES"], "//conditions:default": ["-std=c++17"]})
POSTGIS_MATH_LINKOPTS = select({"//build_defs/native:windows_x64": [], "//build_defs/native:macos_arm64": [], "//conditions:default": ["-lm"]})
POSTGIS_THREAD_LINKOPTS = select({"//build_defs/native:windows_x64": [], "//build_defs/native:macos_arm64": [], "//conditions:default": ["-lm", "-pthread"]})
POSTGIS_DL_LINKOPTS = select({"//build_defs/native:windows_x64": [], "//build_defs/native:macos_arm64": [], "//conditions:default": ["-lm", "-pthread", "-ldl"]})

def postgis_profile(profile):
    if profile == "desktop":
        return struct(compatible = NATIVE_EXTENSION_COMPATIBLE, c = POSTGIS_NATIVE_COPTS, cxx = POSTGIS_NATIVE_CXX_COPTS)
    if profile == "mobile-static":
        return struct(compatible = MOBILE_EXTENSION_COMPATIBLE, c = ["-std=gnu11", "-g0"], cxx = ["-std=c++17", "-g0"])
    fail("unsupported PostGIS construction profile " + profile)

def _headers_impl(ctx):
    outputs = [ctx.actions.declare_file(ctx.label.name + "/" + path) for path in ctx.attr.outs]
    args = ctx.actions.args()
    args.add("--kind", ctx.attr.kind)
    args.add("--source", ctx.file.root.dirname)
    args.add("--output", outputs[0].path[:-len(ctx.attr.outs[0])])
    if ctx.attr.profile != "desktop":
        args.add("--profile", ctx.attr.profile)
    inputs = ctx.files.inputs + [ctx.file.root]
    if not ctx.attr.target.startswith("linux-"):
        if not ctx.file.facts:
            fail("foreign PostGIS templates require the selected target compiler facts")
        args.add("--target", ctx.attr.target)
        args.add("--facts", ctx.file.facts)
        inputs.append(ctx.file.facts)
    if ctx.attr.kind == "postgis":
        source = EXTENSION_SOURCES["postgis"]
        identity = ctx.actions.declare_file(ctx.label.name + ".identity.json")
        ctx.actions.write(identity, json.encode({"commit": source["commit"], "source_date_epoch": source["source_date_epoch"],
                                              "default_version": source["extension-control"]["default-version"],
                                              "postgres_major": int(POSTGRES_SOURCE["postgresql"]["version"].split(".")[0]),
                                              "postgres_version": POSTGRES_SOURCE["postgresql"]["version"],
                                              "dependencies": EXTENSION_DEPENDENCIES["postgis"]}))
        args.add("--identity", identity)
        inputs.append(identity)
    bun_action(ctx, ctx.attr._generator,
                    inputs = inputs, outputs = outputs,
                    arguments = [args], mnemonic = "PostgisDependencyConfig")
    return [DefaultInfo(files = depset(outputs)),
            OutputGroupInfo(control = depset([file for file in outputs if file.basename.endswith(".control")])),
            CcInfo(compilation_context = cc_common.create_compilation_context(
                headers = depset(outputs), includes = depset([outputs[0].path[:-len(ctx.attr.outs[0])].rstrip("/") + ("/" + directory if directory else "") for directory in ctx.attr.include_dirs])))]

_headers_rule = rule(
    implementation = _headers_impl,
    attrs = {
        "kind": attr.string(mandatory = True), "root": attr.label(allow_single_file = True, mandatory = True),
        "inputs": attr.label_list(allow_files = True), "outs": attr.string_list(mandatory = True),
        "include_dirs": attr.string_list(default = [""]),
        "target": attr.string(mandatory = True),
        "profile": attr.string(default = "desktop", values = ["desktop", "mobile-static"]),
        "facts": attr.label(allow_single_file = True),
        "_generator": attr.label(default = "//build_defs/extensions/postgis:configure_headers", providers = [BunScriptInfo], cfg = "exec"),
    },
)

def _headers(profile = "desktop", **kwargs):
    postgis_profile(profile)
    _headers_rule(target = NATIVE_EXTENSION_CONFIGURATION if profile == "desktop" else MOBILE_EXTENSION_CONFIGURATION,
                  facts = POSTGIS_COMPILER_FACTS if profile == "desktop" else POSTGIS_MOBILE_COMPILER_FACTS,
                  profile = profile, **kwargs)

def _source_headers_impl(ctx):
    root = ctx.file.root.dirname
    return [CcInfo(compilation_context = cc_common.create_compilation_context(
        headers = depset(ctx.files.headers),
        includes = depset([root + "/" + directory for directory in ctx.attr.include_dirs]),
    ))]

_source_headers = rule(
    implementation = _source_headers_impl,
    attrs = {"root": attr.label(allow_single_file = True, mandatory = True),
             "headers": attr.label_list(allow_files = True), "include_dirs": attr.string_list(mandatory = True)},
)

postgis_source_headers = _source_headers

def postgis_configuration(name, profile = "desktop"):
    if EXTENSION_SOURCES["postgis"]["commit"] != "3d12666588a84b23a3147618eaa9b40b0fe5e796":
        fail("review the PostGIS source/configuration recipe before changing its canonical source pin")
    prefix = "@postgis//:"
    _headers(name = name, profile = profile, kind = "postgis", root = prefix + "Version.config",
             inputs = [prefix + path for path in ["postgis_config.h.in", "liblwgeom/liblwgeom.h.in", "postgis/sqldefines.h.in", "extensions/postgis/postgis.control.in"]],
             outs = ["postgis_config.h", "liblwgeom/liblwgeom.h", "postgis/sqldefines.h", "extensions/postgis/postgis.control", "postgis_revision.h"],
             include_dirs = ["", "liblwgeom", "postgis"])

def _pin(name, commit):
    if EXTENSION_DEPENDENCIES["postgis"][name]["commit"] != commit:
        fail("review the native %s source/configuration recipe before updating its canonical pin" % name)

def postgis_geos(name, profile = "desktop", capi_name = None):
    settings = postgis_profile(profile)
    _pin("geos", "c389f532d25fe6228861d9b19339f9cb57ca4bdb")
    prefix = "@postgis_geos//:"
    _headers(name = name + "_config", profile = profile, kind = "geos", root = prefix + "Version.txt",
             inputs = [prefix + "include/geos/version.h.in", prefix + "capi/geos_c.h.in"],
             outs = ["geos_c.h", "geos/version.h"])
    _source_headers(name = name + "_headers", root = prefix + "Version.txt", headers = [prefix + "headers"],
                    include_dirs = ["include", "src/deps"])
    # Upstream src/CMakeLists.txt and src/deps/CMakeLists.txt recursively admit
    # precisely these C++ and Ryu C files. The C API adds its two capi units.
    cc_library(name = name + "_ryu", srcs = [prefix + "native_c_sources"], hdrs = [prefix + "headers"],
               deps = [":" + name + "_headers"], copts = settings.c, target_compatible_with = settings.compatible)
    cc_library(name = name, srcs = [prefix + ("native_sources" if profile == "desktop" else "native_core_sources")], hdrs = [prefix + "headers"],
               deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_ryu"],
               copts = settings.cxx + (select({"//build_defs/native:macos_arm64": ["-ffp-contract=off"], "//build_defs/native:windows_x64": ["/fp:precise"], "//conditions:default": []}) if profile == "desktop" else ["-ffp-contract=off"]),
               defines = ["USE_UNSTABLE_GEOS_CPP_API", "HAVE_FENV"],
               linkopts = POSTGIS_THREAD_LINKOPTS, target_compatible_with = settings.compatible)
    if profile == "mobile-static":
        if not capi_name:
            fail("mobile GEOS requires its separate canonical C API object root")
        cc_library(name = capi_name, srcs = [prefix + "native_capi_sources"], hdrs = [prefix + "headers"],
                   deps = [":" + name + "_config", ":" + name + "_headers", ":" + name],
                   copts = settings.cxx + ["-ffp-contract=off"], defines = ["USE_UNSTABLE_GEOS_CPP_API", "HAVE_FENV"],
                   target_compatible_with = settings.compatible)

def postgis_json_c(name, profile = "desktop"):
    settings = postgis_profile(profile)
    _pin("json-c", "41a55cfcedb54d9c1874f2f0eb07b504091d7e37")
    prefix = "@postgis_json_c//:"
    _headers(name = name + "_config", profile = profile, kind = "json_c", root = prefix + "CMakeLists.txt",
             inputs = [prefix + "cmake/config.h.in", prefix + "cmake/json_config.h.in", prefix + "json.h.cmakein"],
             outs = ["config.h", "json_config.h", "json.h"])
    _source_headers(name = name + "_headers", root = prefix + "CMakeLists.txt", headers = [prefix + "headers"], include_dirs = ["."])
    cc_library(name = name,
               srcs = [prefix + stem + ".c" for stem in ["arraylist", "debug", "json_c_version", "json_object", "json_object_iterator", "json_tokener", "json_util", "json_visit", "linkhash", "printbuf", "random_seed", "strerror_override", "json_pointer", "json_patch"]],
               hdrs = [prefix + "headers"], deps = [":" + name + "_config", ":" + name + "_headers"],
               copts = settings.c,
               defines = select({"//build_defs/native:windows_x64": [], "//conditions:default": ["_GNU_SOURCE"]}),
               linkopts = POSTGIS_MATH_LINKOPTS + select({"//build_defs/native:windows_x64": ["advapi32.lib"], "//conditions:default": []}), target_compatible_with = settings.compatible)

def postgis_libxml2(name, iconv = None, profile = "desktop"):
    settings = postgis_profile(profile)
    if profile == "desktop" and not iconv:
        fail("desktop libxml2 requires its pinned iconv dependency")
    _pin("libxml2", "d23960a130c5bb82779c9405fbbf85e65fb3c57c")
    prefix = "@postgis_libxml2//:"
    _headers(name = name + "_config", profile = profile, kind = "libxml2", root = prefix + "VERSION",
             inputs = [prefix + "config.h.cmake.in", prefix + "include/libxml/xmlversion.h.in"],
             outs = ["config.h", "libxml/xmlversion.h"])
    _source_headers(name = name + "_headers", root = prefix + "VERSION", headers = [prefix + "headers"], include_dirs = ["include", "."])
    cc_library(name = name,
               srcs = [prefix + stem + ".c" for stem in ["HTMLparser", "HTMLtree", "SAX2", "buf", "c14n", "catalog", "chvalid", "debugXML", "dict", "encoding", "entities", "error", "globals", "hash", "list", "nanohttp", "parser", "parserInternals", "pattern", "relaxng", "schematron", "threads", "tree", "uri", "valid", "xinclude", "xlink", "xmlIO", "xmlmemory", "xmlmodule", "xmlreader", "xmlregexp", "xmlsave", "xmlschemas", "xmlschemastypes", "xmlstring", "xmlunicode", "xmlwriter", "xpath", "xpointer", "xzlib"]],
               hdrs = [prefix + "headers"],
               deps = [":" + name + "_config", ":" + name + "_headers"] + ([iconv] if profile == "desktop" else []),
               copts = settings.c,
               defines = select({"//build_defs/native:windows_x64": [], "//conditions:default": ["HAVE_PTHREAD_H", "HAVE_STRINGS_H", "HAVE_UNISTD_H"]}) if profile == "desktop" else ["HAVE_STRINGS_H", "HAVE_UNISTD_H"],
               linkopts = POSTGIS_DL_LINKOPTS + select({"//build_defs/native:windows_x64": ["bcrypt.lib"], "//conditions:default": []}) if profile == "desktop" else POSTGIS_MATH_LINKOPTS,
               target_compatible_with = settings.compatible)

def postgis_proj(name, sqlite, profile = "desktop", database = None):
    settings = postgis_profile(profile)
    _pin("proj", "f08fa86c478c4bbbf003b1ec751dd84aa6eca486")
    prefix = "@postgis_proj//:"
    _headers(name = name + "_config", profile = profile, kind = "proj", root = prefix + "CMakeLists.txt",
             inputs = [prefix + "cmake/proj_config.cmake.in"], outs = ["proj_config.h"])
    _source_headers(name = name + "_headers", root = prefix + "CMakeLists.txt", headers = [prefix + "headers"], include_dirs = ["include", "src"])
    embedded_sources = []
    embedded_deps = []
    embedded_defines = []
    if profile == "mobile-static":
        if not database:
            fail("mobile PROJ requires the declared execution database")
        wasix_proj_embed(name = name + "_embedded", database = database, target_compatible_with = settings.compatible)
        native.filegroup(name = name + "_embedded_sources", srcs = [":" + name + "_embedded"], output_group = "library_sources")
        embedded_sources = [prefix + "src/embedded_resources.c", prefix + "src/memvfs.c", ":" + name + "_embedded_sources"]
        embedded_deps = [":" + name + "_embedded", sqlite]
        embedded_defines = ["PROJ_DLL=", "EMBED_RESOURCE_FILES=1", "USE_ONLY_EMBEDDED_RESOURCE_FILES=1"]
    cc_library(name = name + "_c", srcs = [prefix + "native_c_sources"] + embedded_sources, hdrs = [prefix + "headers"],
               deps = [":" + name + "_config", ":" + name + "_headers"] + embedded_deps,
               defines = embedded_defines, copts = settings.c, target_compatible_with = settings.compatible)
    cc_library(name = name, srcs = [prefix + "native_sources"], hdrs = [prefix + "headers"],
               deps = [":" + name + "_config", ":" + name + "_headers", ":" + name + "_c", sqlite],
               copts = settings.cxx,
               defines = ["PROJ_DLL="] + select({"//build_defs/native:windows_x64": [], "//conditions:default": ["PROJ_HAS_PTHREADS"]}) + (embedded_defines[1:] if profile == "mobile-static" else []),
               linkopts = select({"//build_defs/native:windows_x64": ["shell32.lib", "ole32.lib"], "//build_defs/native:macos_arm64": [], "//conditions:default": ["-ldl", "-lm", "-pthread"]}) if profile == "desktop" else POSTGIS_THREAD_LINKOPTS,
               target_compatible_with = settings.compatible)

def postgis_iconv(name, profile = "desktop", charset_name = None):
    settings = postgis_profile(profile)
    source = EXTENSION_DEPENDENCIES["postgis"]["libiconv"]
    if source["sha256"] != "88dd96a8c0464eca144fc791ae60cd31cd8ee78321e67397e25fc095c4a19aa6":
        fail("review native libiconv headers/object recipe before changing the canonical archive pin")
    prefix = "@postgis_libiconv//:"
    _headers(name = name + "_config", profile = profile, kind = "libiconv", root = prefix + "configure",
             inputs = [prefix + path for path in ["lib/config.h.in", "include/iconv.h.build.in", "libcharset/include/localcharset.h.build.in", "libcharset/include/libcharset.h.build.in"]],
             outs = ["config.h", "iconv.h", "localcharset.h", "libcharset.h"])
    _source_headers(name = name + "_headers", root = prefix + "configure", headers = [prefix + "headers", prefix + "lib/encodings.def", prefix + "lib/encodings_local.def"] + select({"//build_defs/native:windows_x64": [prefix + "lib/encodings_dos.def"], "//conditions:default": []}), include_dirs = ["lib", "include", "libcharset/include"])
    cc_library(name = name,
               srcs = [prefix + path for path in (["lib/iconv.c", "lib/compat.c", "libcharset/lib/localcharset.c", "libcharset/lib/relocatable-stub.c"] if profile == "desktop" else ["lib/iconv.c", "lib/compat.c", "libcharset/lib/localcharset.c"])],
               hdrs = [prefix + "headers"], deps = [":" + name + "_config", ":" + name + "_headers"],
               copts = settings.c,
               local_defines = ["BUILDING_LIBICONV", "BUILDING_LIBCHARSET"], target_compatible_with = settings.compatible)
    if profile == "mobile-static":
        if not charset_name:
            fail("mobile libiconv requires its separate charset object root")
        cc_library(name = charset_name, srcs = [prefix + path for path in ["libcharset/lib/localcharset.c", "libcharset/lib/relocatable-stub.c"]],
                   hdrs = [prefix + "headers"], deps = [":" + name + "_config", ":" + name + "_headers"],
                   copts = settings.c, local_defines = ["BUILDING_LIBCHARSET"], target_compatible_with = settings.compatible)
