"""Direct SQLite 3.53.1 construction from its canonical Git source.

The source-built execution Jim/Lemon helpers run upstream Tcl generators; the
target library compiles the individual upstream non-amalgamation object recipe.
This private SQLite profile supports PROJ database construction and lookup.
"""

load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_library")
load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_DEPENDENCIES")
load("//build_defs/extensions:platforms.bzl", "NATIVE_EXTENSION_COMPATIBLE")
load(":libraries.bzl", "postgis_source_headers")

_CORE = "alter analyze attach auth backup bitvec btmutex btree build callback carray complete date dbpage dbstat delete expr fault fkey func global hash insert json legacy loadext main malloc mem0 mem1 mem2 mem3 mem5 memdb memjournal mutex mutex_noop mutex_unix mutex_w32 notify os os_kv os_unix os_win pager pcache pcache1 pragma prepare printf random resolve rowset select status table threads tokenize treeview trigger update upsert utf util vacuum vdbe vdbeapi vdbeaux vdbeblob vdbemem vdbesort vdbetrace vdbevtab vtab wal walker where wherecode whereexpr window".split(" ")
_FTS3 = "fts3 fts3_aux fts3_expr fts3_hash fts3_icu fts3_porter fts3_snippet fts3_tokenizer fts3_tokenizer1 fts3_tokenize_vtab fts3_unicode fts3_unicode2 fts3_write".split(" ")
_GENERATED = ["sqlite3.h", "parse.c", "parse.h", "keywordhash.h", "pragma.h", "ctime.c", "opcodes.h", "opcodes.c", "shell.c"]

def _generate_impl(ctx):
    outputs = [ctx.actions.declare_file(ctx.label.name + "/" + name) for name in _GENERATED]
    args = ctx.actions.args()
    args.add("--source", ctx.file.version.dirname)
    args.add("--output", outputs[0].dirname)
    for name in ["jim", "lemon", "mksourceid", "mkkeywordhash"]:
        args.add("--" + name, getattr(ctx.executable, name))
    ctx.actions.run(
        executable = ctx.attr._generator[DefaultInfo].files_to_run,
        inputs = ctx.files.inputs + [ctx.file.version],
        tools = [getattr(ctx.attr, name)[DefaultInfo].files_to_run for name in ["jim", "lemon", "mksourceid", "mkkeywordhash"]],
        outputs = outputs,
        arguments = [args],
        mnemonic = "SqliteUpstreamGenerators",
    )
    headers = [file for file in outputs if file.basename.endswith(".h")]
    return [DefaultInfo(files = depset(outputs)),
            OutputGroupInfo(library_sources = depset([file for file in outputs if file.basename in ["parse.c", "ctime.c", "opcodes.c"]]),
                            headers = depset(headers), shell = depset([file for file in outputs if file.basename == "shell.c"])),
            CcInfo(compilation_context = cc_common.create_compilation_context(headers = depset(headers), includes = depset([outputs[0].dirname])))]

_sqlite_generate = rule(
    implementation = _generate_impl,
    attrs = {
        "inputs": attr.label_list(allow_files = True),
        "version": attr.label(allow_single_file = True, mandatory = True),
        "jim": attr.label(executable = True, cfg = "exec", mandatory = True),
        "lemon": attr.label(executable = True, cfg = "exec", mandatory = True),
        "mksourceid": attr.label(executable = True, cfg = "exec", mandatory = True),
        "mkkeywordhash": attr.label(executable = True, cfg = "exec", mandatory = True),
        "_generator": attr.label(default = "//build_defs/extensions/postgis:sqlite_generate", executable = True, cfg = "exec"),
    },
)

def postgis_sqlite(name):
    if EXTENSION_DEPENDENCIES["postgis"]["sqlite"]["commit"] != "ccd445d76a9362c63add000354fac84ba9022176":
        fail("review the upstream SQLite object/generator recipe before changing its canonical source pin")
    prefix = "@postgis_sqlite//:"
    for tool in ["jim", "lemon", "mksourceid", "mkkeywordhash"]:
        source = "autosetup/jimsh0.c" if tool == "jim" else "tool/" + tool + ".c"
        cc_binary(
            name = name + "_" + tool,
            srcs = [prefix + source],
            defines = ["HAVE_REALPATH"] if tool == "jim" else [],
            linkopts = ["-lm", "-ldl"] if tool == "jim" else [],
            target_compatible_with = NATIVE_EXTENSION_COMPATIBLE,
        )
    generated = name + "_generated"
    _sqlite_generate(name = generated, inputs = [prefix + "all_sources"], version = prefix + "VERSION",
                     jim = ":" + name + "_jim", lemon = ":" + name + "_lemon",
                     mksourceid = ":" + name + "_mksourceid", mkkeywordhash = ":" + name + "_mkkeywordhash")
    native.filegroup(name = name + "_generated_sources", srcs = [":" + generated], output_group = "library_sources")
    native.filegroup(name = name + "_shell_source", srcs = [":" + generated], output_group = "shell")
    # main.mk T.cc.sqlite carries these upstream extension header roots.
    postgis_source_headers(name = name + "_source_headers", root = prefix + "VERSION",
                           headers = [prefix + "headers", prefix + "ext/rtree/geopoly.c"],
                           include_dirs = ["src", "ext/rtree", "ext/icu", "ext/fts3", "ext/session"])
    cc_library(
        name = name,
        srcs = [prefix + "src/" + source + ".c" for source in _CORE] +
               [prefix + "ext/fts3/" + source + ".c" for source in _FTS3] +
               [prefix + path for path in ["ext/icu/icu.c", "ext/rtree/rtree.c", "ext/session/sqlite3session.c", "ext/rbu/sqlite3rbu.c", "ext/misc/stmt.c"]] +
               [":" + name + "_generated_sources"],
        hdrs = [prefix + "headers"],
        deps = [":" + generated, ":" + name + "_source_headers"],
        local_defines = ["SQLITE_CORE"],
        defines = ["SQLITE_THREADSAFE=1", "SQLITE_OMIT_LOAD_EXTENSION", "SQLITE_ENABLE_RTREE", "SQLITE_ENABLE_COLUMN_METADATA"],
        includes = [],
        linkopts = ["-lm", "-pthread"],
        target_compatible_with = NATIVE_EXTENSION_COMPATIBLE,
    )
    cc_binary(name = name + "_cli", srcs = [":" + name + "_shell_source"], deps = [":" + name],
              defines = ["SQLITE_OMIT_LOAD_EXTENSION"], target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
