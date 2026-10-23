"""Actual compiled mobile cohort from the canonical extension and component model."""

load("@oliphaunt_metadata//:metadata.bzl", "CONTRIB_MEMBERS", "EXTENSIONS", "EXTENSION_SOURCES", "NATIVE_COMPONENTS", "NATIVE_COMPONENT_SOURCES")
load("@rules_cc//cc:defs.bzl", "cc_import", "cc_library")
load("//build_defs/native:platform_config.bzl", "NATIVE_COPTS")
load("//build_defs/extensions/postgis:mobile.bzl", "POSTGIS_MOBILE_ARCHIVES", "POSTGIS_MOBILE_LIBRARIES")
load(":contrib.bzl", "contrib_extension_inputs")
load(":external.bzl", "VECTOR_COPTS", "external_extension_inputs")
load(":mobile.bzl", "MOBILE_EXTENSION_COMPATIBLE", "mobile_static_archive", "mobile_static_component", "native_mobile_extension")

_PACKAGE = "//build_defs/extensions/mobile:"
_DESCRIPTORS = {descriptor["sql-name"]: descriptor for descriptor in EXTENSIONS.values()}
_EXTERNAL_MEMBERS = [name for name in sorted(EXTENSION_SOURCES) if _DESCRIPTORS[name].get("native-module-file")]
_MEMBER_NAMES = {member["sql-name"]: member["id"] for member in CONTRIB_MEMBERS} | {name: name for name in _EXTERNAL_MEMBERS}

MOBILE_MEMBER_TARGETS = {sql_name: _PACKAGE + name for sql_name, name in _MEMBER_NAMES.items()}
MOBILE_MEMBER_LIBRARIES = {sql_name: target + "_library" for sql_name, target in MOBILE_MEMBER_TARGETS.items()}
MOBILE_MEMBER_ARCHIVE_OBJECTS = {
    sql_name: _PACKAGE + "oliphaunt_extension_" + _DESCRIPTORS[sql_name]["native-module-file"][:-3] + "_own_objects"
    for sql_name in _MEMBER_NAMES
} | {"postgis": "//build_defs/extensions/postgis/mobile:oliphaunt_extension_postgis-3_own_objects"}
MOBILE_SQL_ONLY_MEMBERS = [name for name in sorted(_DESCRIPTORS) if not _DESCRIPTORS[name].get("native-module-file")]

MOBILE_COMPONENT_ARCHIVES = POSTGIS_MOBILE_ARCHIVES | {"openssl": _PACKAGE + "crypto", "uuid": _PACKAGE + "uuid"}
MOBILE_COMPONENT_LIBRARIES = POSTGIS_MOBILE_LIBRARIES | {"openssl": _PACKAGE + "crypto_library", "uuid": _PACKAGE + "uuid_library"}
MOBILE_COMPONENT_ARCHIVE_OBJECTS = {identity: archive + "_own_objects" for identity, archive in MOBILE_COMPONENT_ARCHIVES.items()}
MOBILE_COMPONENT_TARGETS = {identity: _PACKAGE + "component_" + identity.replace("-", "_") for identity in MOBILE_COMPONENT_ARCHIVES}

def _component_source(identity):
    owners = [component for component in NATIVE_COMPONENTS["components"] if any([unit["id"] == identity for unit in component["link-units"]])]
    if len(owners) != 1:
        fail("static link unit requires exactly one canonical source owner: " + identity)
    component = owners[0]
    if component.get("source-path"):
        return {"path": component["source-path"]}
    if component["source"] not in NATIVE_COMPONENT_SOURCES:
        fail("static link unit lacks its canonical acquisition: " + identity)
    return NATIVE_COMPONENT_SOURCES[component["source"]]

def mobile_extension_members():
    """Build the existing units and separately owned dependency archives."""
    cc_library(name = "uuid_objects",
               srcs = ["//src/extensions/contrib:portable-uuid/portable_uuid.c"],
               hdrs = ["//src/extensions/contrib:portable-uuid/include/uuid/uuid.h"],
               strip_include_prefix = "/src/extensions/contrib/portable-uuid/include",
               deps = ["//src/native/runtime:postgres_embedded_headers"],
               copts = NATIVE_COPTS + ["-g0"], target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    mobile_static_archive(name = "uuid", roots = [":uuid_objects"], target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    cc_import(name = "uuid_import", static_library = ":uuid", target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    cc_library(name = "uuid_library", deps = [":uuid_import"], target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    mobile_static_archive(name = "crypto", roots = ["@openssl//:crypto"], target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    cc_import(name = "crypto_import", static_library = ":crypto", target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    cc_library(name = "crypto_library", deps = [":crypto_import"],
               linkopts = select({"//build_defs/native:android": ["-ldl", "-pthread"], "//conditions:default": ["-pthread"]}),
               target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
    for identity, archive in MOBILE_COMPONENT_ARCHIVES.items():
        mobile_static_component(name = "component_" + identity.replace("-", "_"), identity = identity, archive = archive, source = _component_source(identity))
    for member in CONTRIB_MEMBERS:
        name = member["id"]
        inputs = contrib_extension_inputs(name = name, member = member, crypto = "@openssl//:crypto", uuid_provider = ":uuid_objects")
        consumer_deps = [":crypto_library"] if name == "pgcrypto" else [":uuid_library"] if name == "uuid_ossp" else None
        native_mobile_extension(name = name, sql_name = member["sql-name"], consumer_deps = consumer_deps, **inputs)
    for sql_name in _EXTERNAL_MEMBERS:
        if sql_name == "postgis":
            native.alias(name = sql_name, actual = "//build_defs/extensions/postgis/mobile:extension")
            native.alias(name = sql_name + "_library", actual = "//build_defs/extensions/postgis/mobile:extension_library")
        else:
            inputs = external_extension_inputs(name = sql_name, sql_name = sql_name)
            if sql_name == "vector":
                inputs["copts"] = inputs.get("copts", []) + VECTOR_COPTS + ["-fPIC"]
            native_mobile_extension(name = sql_name, sql_name = sql_name, **inputs)
    native.filegroup(name = "compiled_members", srcs = MOBILE_MEMBER_TARGETS.values(), target_compatible_with = MOBILE_EXTENSION_COMPATIBLE)
