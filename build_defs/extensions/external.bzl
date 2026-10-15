"""Reviewed external C units, shared by explicit platform construction profiles."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_SOURCES")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("//build_defs/foundation:bun.bzl", "BunScriptInfo", "bun_action")
load("//build_defs/native:platform_config.bzl", "NATIVE_WINDOWS_COMPATIBLE")
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

def _windows_sources_impl(ctx):
    anchor = ctx.file.anchor
    root = anchor.path[:-len(ctx.attr.anchor_name)]
    source_paths = {file.path: True for file in ctx.files.srcs}
    sources = []
    headers = []
    compatibility = []
    companion_inputs = []
    rows = []
    seen = {}
    for file in ctx.files.srcs + ctx.files.hdrs:
        if file.path in seen:
            continue
        seen[file.path] = True
        if file.is_directory or not file.path.startswith(root):
            fail("Windows source preparation requires declared regular files in the pinned source repository")
        relative = file.path[len(root):]
        if not relative or any([part in ["", ".", ".."] for part in relative.split("/")]):
            fail("Windows source input escapes its pinned repository root")
        output = ctx.actions.declare_file(ctx.label.name + "/" + relative)
        rows.append({"name": relative, "source": file.path, "output": output.path})
        if file.path in source_paths:
            sources.append(output)
        else:
            headers.append(output)
    for target, relative in ctx.attr.companions.items():
        files = target[DefaultInfo].files.to_list()
        if len(files) != 1 or files[0].is_directory or not relative or any([part in ["", ".", ".."] for part in relative.split("/")]):
            fail("Windows companion header requires one regular file and a safe declared destination")
        output = ctx.actions.declare_file(ctx.label.name + "/" + relative)
        rows.append({"name": relative, "source": files[0].path, "output": output.path})
        headers.append(output)
        compatibility.append(output)
        companion_inputs.append(files[0])
    generated = []
    if ctx.attr.sql_name == "pg_textsearch":
        for relative in ["src/oliphaunt_windows_compat.h", "src/unistd.h"]:
            output = ctx.actions.declare_file(ctx.label.name + "/" + relative)
            headers.append(output)
            generated.append({"name": relative, "output": output.path})
            if relative.endswith("oliphaunt_windows_compat.h"):
                compatibility.append(output)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"extension": ctx.attr.sql_name, "files": rows, "headers": generated}))
    args = ctx.actions.args()
    args.add(spec)
    bun_action(ctx, ctx.attr._generator, arguments = [args], inputs = depset([spec] + ctx.files.srcs + ctx.files.hdrs + companion_inputs), outputs = sources + headers, mnemonic = "WindowsExtensionSources")
    output_root = (sources + headers)[0].path[:-len(rows[0]["name"])]
    groups = {"compatibility_header": depset(compatibility), "source_spec": depset([spec])}
    for directory in ctx.attr.source_groups:
        group = directory.split("/")[-1] + "_sources"
        if group in groups or any([part in ["", ".", ".."] for part in directory.split("/")]):
            fail("Windows source group requires a unique safe source directory")
        groups[group] = depset([file for file in sources if file.path.startswith(output_root + directory + "/")])
    return [
        DefaultInfo(files = depset(sources)),
        CcInfo(compilation_context = cc_common.create_compilation_context(headers = depset(headers), includes = depset([output_root + directory for directory in ctx.attr.include_dirs]))),
        OutputGroupInfo(**groups),
    ]

_windows_sources = rule(
    implementation = _windows_sources_impl,
    attrs = {
        "sql_name": attr.string(mandatory = True),
        "srcs": attr.label_list(allow_files = True, mandatory = True),
        "hdrs": attr.label_list(allow_files = True),
        "companions": attr.label_keyed_string_dict(allow_files = True),
        "source_groups": attr.string_list(),
        "anchor": attr.label(allow_single_file = True, mandatory = True),
        "anchor_name": attr.string(mandatory = True),
        "include_dirs": attr.string_list(),
        "_generator": attr.label(default = "//build_defs/extensions:windows_source_inputs", providers = [BunScriptInfo], cfg = "exec"),
    },
)

# The PostGIS recipe uses the same declared projection and pure source transforms.
windows_extension_sources = _windows_sources

def external_extension_inputs(name, sql_name, link_profile = "native"):
    """C source inputs only; callers supply their actual host/profile headers."""
    if link_profile not in ["native", "wasix"]:
        fail("unknown external extension link profile: " + link_profile)
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
    if sql_name == "pg_hashids":
        attrs["linkopts"] = ["-lm"] if link_profile == "wasix" else select({"//build_defs/native:windows_x64": [], "//conditions:default": ["-lm"]})
    return attrs

def native_external_extension_modules(name, sql_name = None):
    sql_name = sql_name or name
    attrs = external_extension_inputs(name = name, sql_name = sql_name)
    if sql_name in ["pg_uuidv7", "pg_textsearch"]:
        prepared = name + "_windows_sources"
        prefix = "@" + EXTENSION_SOURCES[sql_name]["name"] + "//:"
        anchor = "src/constants.h" if sql_name == "pg_textsearch" else "pg_uuidv7.c"
        _windows_sources(name = prepared, sql_name = sql_name, srcs = attrs["srcs"], hdrs = [prefix + "headers"] if sql_name == "pg_textsearch" else [], anchor = prefix + anchor, anchor_name = anchor, include_dirs = ["src"] if sql_name == "pg_textsearch" else [""], target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
        attrs["srcs"] = select({"//build_defs/native:windows_x64": [":" + prepared], "//conditions:default": attrs["srcs"]})
        attrs["hdrs"] = select({"//build_defs/native:windows_x64": [], "//conditions:default": attrs.get("hdrs", [])})
        attrs["deps"] = select({"//build_defs/native:windows_x64": [":" + prepared], "//conditions:default": attrs.get("deps", [])})
        if sql_name == "pg_textsearch":
            compatibility = prepared + "_compatibility"
            native.filegroup(name = compatibility, srcs = [":" + prepared], output_group = "compatibility_header", target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
            compatibility_inputs = select({"//build_defs/native:windows_x64": [":" + compatibility], "//conditions:default": []})
            attrs["hdrs"] = attrs["hdrs"] + compatibility_inputs
            attrs["additional_compiler_inputs"] = compatibility_inputs
            attrs["copts"] = select({"//build_defs/native:windows_x64": ["/FI$(location :%s)" % compatibility, '/DPG_TEXTSEARCH_VERSION="%s"' % extension_default_version(sql_name)], "//conditions:default": attrs["copts"]})
    if sql_name == "vector":
        # Clang's EVEX width permission preserves upstream's optional AVX512
        # dispatch without enabling AVX instructions in baseline functions.
        attrs["copts"] = select({"//build_defs/native:windows_x64": ["/fp:fast"], "//conditions:default": VECTOR_COPTS + ["-fPIC"]}) + select({
            "//build_defs/native:linux_x86_64_gnu_2_28": ["-mevex512"],
            "//conditions:default": [],
        })
        attrs["deps"] = attrs.get("deps", []) + select({
            "//build_defs/native:linux_x86_64_gnu_2_28": ["@pgvector_compiler_rt//:cpu_model"],
            "//conditions:default": [],
        })
    native_extension_modules(name = name, **attrs)
