"""Portable extension modules using shared reviewed source construction units."""

load("@rules_cc//cc:defs.bzl", "cc_library")
load("@oliphaunt_metadata//:metadata.bzl", "CONTRIB_MEMBERS")
load("//build_defs/extensions:contrib.bzl", "CONTRIB_C_SOURCES", "CONTRIB_HEADERS", "contrib_generated_sources")
load("//build_defs/extensions:external.bzl", "EXTERNAL_C_SOURCES", "VECTOR_COPTS", "external_extension_inputs")
load(":config.bzl", "WASIX_COPTS")
load(":wasm.bzl", "wasix_module")

_COMPATIBLE = ["@platforms//cpu:wasm32", "@platforms//os:wasi"]

def wasix_contrib_modules(crypto = None):
    modules = []
    for member in CONTRIB_MEMBERS:
        identity = member["id"]
        if identity not in CONTRIB_C_SOURCES:
            fail("No reviewed WASIX contrib construction unit: " + identity)
        # The OpenSSL WASIX profile must be real before admitting pgcrypto.
        if identity == "pgcrypto" and crypto == None:
            continue
        name = "contrib_" + identity
        prefix = "@postgres_wasix//:contrib/" + member["contrib-dir"] + "/"
        sources = [prefix + stem + ".c" for stem in CONTRIB_C_SOURCES[identity]]
        headers = [prefix + header for header in CONTRIB_HEADERS.get(identity, [])]
        deps = ["@postgres_wasix//:server_headers"]
        copts = WASIX_COPTS
        if identity in ["cube", "seg"]:
            generated = name + "_generated"
            contrib_generated_sources(name = generated, grammar = prefix + identity + "parse.y", scanner = prefix + identity + "scan.l", include_headers = headers)
            sources.append(":" + generated)
            deps.append(":" + generated)
        elif identity == "fuzzystrmatch":
            generated = name + "_generated"
            contrib_generated_sources(name = generated, header_script = prefix + "daitch_mokotoff_header.pl")
            sources.append(":" + generated)
            deps.append(":" + generated)
        elif identity == "uuid_ossp":
            sources.append("//src/extensions/contrib:portable-uuid/portable_uuid.c")
            uuid_headers = name + "_uuid_headers"
            cc_library(
                name = uuid_headers,
                hdrs = ["//src/extensions/contrib:portable-uuid/include/uuid/uuid.h"],
                strip_include_prefix = "/src/extensions/contrib/portable-uuid/include",
                linkstatic = True,
                target_compatible_with = _COMPATIBLE,
            )
            headers.append("//build_defs/extensions:uuid_config.h")
            deps.append(":" + uuid_headers)
            copts = copts + ["-include", "build_defs/extensions/uuid_config.h"]
        elif identity == "pgcrypto":
            deps.append(crypto)
        cc_library(name = name + "_objects", srcs = sources, hdrs = headers, deps = deps, copts = copts, linkstatic = True, target_compatible_with = _COMPATIBLE)
        wasix_module(name = name, output_name = member["module-file"], deps = [":" + name + "_objects"], target_compatible_with = _COMPATIBLE)
        modules.append(":" + name)
    return modules

def wasix_external_c_modules():
    modules = []
    for sql_name in EXTERNAL_C_SOURCES:
        name = "external_" + sql_name
        attrs = external_extension_inputs(name = name, sql_name = sql_name, link_profile = "wasix")
        # The CcInfo linker context must contain archives only. Forward the
        # reviewed math dependency explicitly to the WASIX side-module link.
        linkopts = attrs.pop("linkopts", [])
        if type(linkopts) != "list":
            fail("external WASIX input requires explicit literal linker options: " + sql_name)
        attrs["deps"] = attrs.get("deps", []) + ["@postgres_wasix//:server_headers"]
        attrs["copts"] = attrs.get("copts", []) + WASIX_COPTS + (VECTOR_COPTS if sql_name == "vector" else [])
        if sql_name == "pg_hashids":
            # PG_FUNCTION_INFO_V1 keeps every SQL entry point PGDLLEXPORT.
            # Internal hashids helpers are not the PostgreSQL module API.
            attrs["copts"].append("-fvisibility=hidden")
        cc_library(name = name + "_objects", linkstatic = True, target_compatible_with = _COMPATIBLE, **attrs)
        wasix_module(name = name, output_name = sql_name + ".so", deps = [":" + name + "_objects"], linkopts = linkopts, target_compatible_with = _COMPATIBLE)
        modules.append(":" + name)
    return modules
