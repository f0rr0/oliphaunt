"""Reviewed external C units, shared by explicit platform construction profiles."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_SOURCES")
load(":extensions.bzl", "extension_default_version", "extension_source_headers", "native_extension_modules")

EXTERNAL_C_SOURCES = {
    "pg_hashids": ["pg_hashids.c", "hashids.c"],
    "pg_uuidv7": ["pg_uuidv7.c"],
    "pg_ivm": ["createas.c", "matview.c", "pg_ivm.c", "ruleutils.c", "subselect.c"],
    "pg_textsearch": ["src/" + unit + ".c" for unit in [
        "mod", "source", "am/handler", "am/build", "am/build_context", "am/build_parallel", "am/scan", "am/vacuum",
        "memtable/arena", "memtable/expull", "memtable/memtable", "memtable/posting", "memtable/stringtable", "memtable/scan", "memtable/source",
        "segment/segment", "segment/dictionary", "segment/scan", "segment/merge", "segment/docmap", "segment/compression",
        "query/bmw", "query/score", "types/vector", "types/query", "state/state", "state/registry", "state/metapage", "state/limit",
        "planner/hooks", "planner/cost", "debug/dump",
    ]],
    "vector": ["src/" + unit + ".c" for unit in [
        "bitutils", "bitvec", "halfutils", "halfvec", "hnsw", "hnswbuild",
        "hnswinsert", "hnswscan", "hnswutils", "hnswvacuum", "ivfbuild",
        "ivfflat", "ivfinsert", "ivfkmeans", "ivfscan", "ivfutils", "ivfvacuum",
        "sparsevec", "vector",
    ]],
}

EXTERNAL_HEADERS = {
    "pg_hashids": ["hashids.h"],
    "pg_ivm": ["pg_ivm.h", "ruleutils_13.c", "ruleutils_14.c"],
}

VECTOR_COPTS = ["-ftree-vectorize", "-fassociative-math", "-fno-signed-zeros", "-fno-trapping-math"]

def external_extension_inputs(name, sql_name):
    """C source inputs only; callers supply their actual host/profile headers."""
    if sql_name not in EXTERNAL_C_SOURCES:
        fail("%s has no reviewed external C construction recipe" % sql_name)
    prefix = "@" + EXTENSION_SOURCES[sql_name]["name"] + "//:"
    attrs = {
        "srcs": [prefix + source for source in EXTERNAL_C_SOURCES[sql_name]],
        "hdrs": [prefix + header for header in EXTERNAL_HEADERS.get(sql_name, [])],
    }
    if sql_name == "vector":
        attrs["hdrs"].append(prefix + "headers")
    if sql_name == "pg_textsearch":
        headers = name + "_source_headers"
        extension_source_headers(name = headers, hdrs = [prefix + "headers"], include_root = prefix + "src/constants.h")
        attrs["deps"] = [":" + headers]
        attrs["copts"] = ["-DPG_TEXTSEARCH_VERSION=\\\"%s\\\"" % extension_default_version(sql_name)]
    return attrs

def native_external_extension_modules(name, sql_name = None):
    sql_name = sql_name or name
    attrs = external_extension_inputs(name = name, sql_name = sql_name)
    if sql_name == "vector":
        # Clang's EVEX width permission preserves upstream's optional AVX512
        # dispatch without enabling AVX instructions in baseline functions.
        attrs["copts"] = VECTOR_COPTS + ["-fPIC"] + select({
            "//build_defs/native:linux_x86_64_gnu_2_28": ["-mevex512"],
            "//conditions:default": [],
        })
        attrs["deps"] = attrs.get("deps", []) + select({
            "//build_defs/native:linux_x86_64_gnu_2_28": ["@pgvector_compiler_rt//:cpu_model"],
            "//conditions:default": [],
        })
    elif sql_name == "pg_hashids":
        attrs["linkopts"] = ["-lm"]
    native_extension_modules(name = name, **attrs)
