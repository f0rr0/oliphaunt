"""Direct PostgreSQL generator/C targets for the initial Linux x86_64 slice.

No upstream Make/Meson/Configure producer is run by these targets. Optional
release-parity features remain separate gates; the local development profile
does not claim to be a publishable replacement for every native product.
"""

load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_import", "cc_library")
load(":config.bzl", "pg_config")
load(":generators.bzl", "postgres_bison", "postgres_flex", "postgres_perl")
load(":host_config.bzl", "postgres_host_configuration_targets")
load(":windows_link.bzl", "postgres_windows_exports", "postgres_windows_resource", "postgres_windows_server")
load(":platform_config.bzl", "NATIVE_CONFIG", "NATIVE_PROFILE", "NATIVE_C_COMPATIBLE", "NATIVE_PORT_REPLACEMENTS", "NATIVE_OS_HEADER", "NATIVE_BACKEND_PORT_SOURCES", "NATIVE_LINKOPTS", "NATIVE_RELEASE_LINKOPTS", "NATIVE_EMBEDDED_DEFINES", "NATIVE_CONFIGURATION", "NATIVE_CONFIGURATION_ADMISSION", "NATIVE_INCLUDE_DIRECTORIES", "NATIVE_HEADER_DEFINES", "NATIVE_COPTS", "NATIVE_BACKEND_DEFINES", "NATIVE_PORT_ADDITIONAL_SOURCES", "NATIVE_PORT_CRC_SOURCES", "NATIVE_LIBPQ_ADDITIONAL_SOURCES", "NATIVE_FRONTEND_LINKOPTS", "NATIVE_SERVER_LINKOPTS", "NATIVE_MODULE_LINKOPTS", "NATIVE_LIBPQ_LINKOPTS", "NATIVE_UNIX_COMPATIBLE", "NATIVE_ELF_C_COMPATIBLE", "NATIVE_MACOS_COMPATIBLE", "NATIVE_WINDOWS_COMPATIBLE")
load(":resources.bzl", "timezone_database")
load(":frontend_sources.bzl", "POSTGRES_DUMP_COMMON_SOURCES", "POSTGRES_DUMP_SOURCES", "POSTGRES_BASEBACKUP_COMMON_SOURCES", "POSTGRES_PSQL_SOURCES")
load(":postgres_sources.bzl",
    "POSTGRES_BACKEND_SOURCES",
    "POSTGRES_MAIN_SOURCES",
    "POSTGRES_BACKEND_GENERATED_SOURCES",
    "POSTGRES_BACKEND_FLEX_INPUTS",
    "POSTGRES_BACKEND_BISON_INPUTS",
    "POSTGRES_FLEX_OPTIONS",
    "POSTGRES_BACKEND_TEXTUAL_SOURCES",
    "POSTGRES_COMMON_SOURCES",
    "POSTGRES_COMMON_RYU_SOURCES",
    "POSTGRES_COMMON_CONFIG_INFO_SOURCES",
    "POSTGRES_COMMON_BUILTIN_CRYPTO_SOURCES",
    "POSTGRES_COMMON_FRONTEND_SHARED_ADDITIONAL_SOURCES",
    "POSTGRES_COMMON_FRONTEND_STATIC_ADDITIONAL_SOURCES",
    "POSTGRES_PORT_SOURCES",
    "POSTGRES_PORT_CRC_GENERIC_SOURCES",
    "POSTGRES_TIMEZONE_SOURCES",
    "POSTGRES_ZIC_SOURCES",
    "POSTGRES_SNOWBALL_SOURCES",
    "POSTGRES_SNOWBALL_STOPWORDS",
    "POSTGRES_SNOWBALL_SQL_INPUTS",
    "POSTGRES_PLPGSQL_SOURCES",
    "POSTGRES_PLPGSQL_GENERATED_SOURCES",
    "POSTGRES_PLPGSQL_GENERATED_HEADERS",
    "POSTGRES_LIBPQ_SOURCES",
    "POSTGRES_INITDB_SOURCES",
    "POSTGRES_PG_CONFIG_SOURCES",
    "POSTGRES_FRONTEND_UTIL_SOURCES",
    "POSTGRES_CATALOG_HEADERS",
    "POSTGRES_CATALOG_DATA",
    "POSTGRES_CATALOG_GENERATOR_EXTRA_INPUTS",
    "POSTGRES_CATALOG_GENERATED_HEADERS",
    "POSTGRES_NODE_GENERATOR_INPUTS",
    "POSTGRES_NODE_GENERATED_TEXTUAL_SOURCES",
    "POSTGRES_WAIT_EVENT_GENERATED_TEXTUAL_SOURCES",
    "POSTGRES_BACKEND_GENERATED_HEADERS",
    "POSTGRES_COMMON_GENERATED_HEADERS",
    "POSTGRES_BACKEND_INCLUDE_DIRECTORIES",
)

_COMPATIBLE = NATIVE_C_COMPATIBLE
_COPTS = NATIVE_COPTS
_LINKOPTS = NATIVE_LINKOPTS
_FRONTEND_LINKOPTS = NATIVE_FRONTEND_LINKOPTS

def _locations(paths):
    return ["$(location " + name + ")" for name in paths]

def _perl(name, script, inputs, outputs, arguments, capture = False, options = []):
    postgres_perl(
        name = name,
        script = script,
        srcs = inputs,
        outs = outputs,
        arguments = arguments,
        options = options,
        capture_stdout = capture,
    )

def _parser(name, source, output, scanner = False, options_override = None):
    options = options_override.split(" ") if options_override != None else (POSTGRES_FLEX_OPTIONS.get(output, []) if scanner else ["-d"])
    outputs = [output] if scanner else [output, output[:-2] + ".h"]
    generator = postgres_flex if scanner else postgres_bison
    generator(
        name = name,
        src = source,
        outs = outputs,
        options = options,
    )

def postgres_generated_targets(version):
    """Generate upstream PG sources in the caller's patched source repository."""
    include_path = "$(dirname src/include/catalog/pg_proc.h)/.."
    catalog_outputs = POSTGRES_CATALOG_GENERATED_HEADERS + ["src/include/catalog/postgres.bki", "src/include/catalog/system_constraints.sql"]
    _perl("catalog", "src/backend/catalog/genbki.pl", POSTGRES_CATALOG_HEADERS + POSTGRES_CATALOG_DATA + POSTGRES_CATALOG_GENERATOR_EXTRA_INPUTS, catalog_outputs,
          ["--include-path=" + include_path, "--set-version=" + version.split(".")[0], "--output=$(RULEDIR)/src/include/catalog"] + _locations(POSTGRES_CATALOG_HEADERS))
    _perl("nodes", "src/backend/nodes/gen_node_support.pl", POSTGRES_NODE_GENERATOR_INPUTS + ["src/backend/catalog/Catalog.pm"], POSTGRES_NODE_GENERATED_TEXTUAL_SOURCES,
          ["-o", "$(RULEDIR)/src/include/nodes"] + _locations(POSTGRES_NODE_GENERATOR_INPUTS))
    _perl("wait_events", "src/backend/utils/activity/generate-wait_event_types.pl", ["src/backend/utils/activity/wait_event_names.txt"], POSTGRES_WAIT_EVENT_GENERATED_TEXTUAL_SOURCES,
          ["--outdir", "$(RULEDIR)/src/include/utils", "--code", "$(location src/backend/utils/activity/wait_event_names.txt)"])
    _perl("errcodes", "src/backend/utils/generate-errcodes.pl", ["src/backend/utils/errcodes.txt"], ["src/include/utils/errcodes.h"],
          ["--outfile", "$@", "$(location src/backend/utils/errcodes.txt)"])
    _perl("dummy_probes", "src/backend/utils/Gen_dummy_probes.pl", ["src/backend/utils/probes.d"], ["src/include/utils/probes.h"],
          ["$(location src/backend/utils/probes.d)"], capture = True, options = ["-n"])
    _perl("fmgrtab", "src/backend/utils/Gen_fmgrtab.pl", ["src/include/catalog/pg_proc.h", "src/include/catalog/pg_proc.dat", "src/backend/catalog/Catalog.pm"],
          ["src/include/utils/fmgroids.h", "src/include/utils/fmgrprotos.h", "src/include/utils/fmgrtab.c"],
          ["--include-path=" + include_path, "--output=$(RULEDIR)/src/include/utils", "$(location src/include/catalog/pg_proc.dat)"],
          options = ["-I", "$(dirname src/backend/catalog/Catalog.pm)"])
    _perl("lwlocks", "src/backend/storage/lmgr/generate-lwlocknames.pl", ["src/include/storage/lwlocklist.h", "src/backend/utils/activity/wait_event_names.txt"], ["src/include/storage/lwlocknames.h"],
          ["-o", "$(RULEDIR)/src/include/storage", "$(location src/include/storage/lwlocklist.h)", "$(location src/backend/utils/activity/wait_event_names.txt)"])
    _perl("keywords", "src/tools/gen_keywordlist.pl", ["src/tools/PerfectHash.pm", "src/include/parser/kwlist.h"], POSTGRES_COMMON_GENERATED_HEADERS,
          ["--output", "$(RULEDIR)/src/common", "--extern", "$(location src/include/parser/kwlist.h)"])
    for output, source in POSTGRES_BACKEND_BISON_INPUTS.items():
        _parser("bison_" + output.rsplit("/", 1)[1][:-2], source, output)
    for output, source in POSTGRES_BACKEND_FLEX_INPUTS.items():
        _parser("flex_" + output.rsplit("/", 1)[1][:-2].replace("-", "_"), source, output, scanner = True)
    _parser("plpgsql_grammar", "src/pl/plpgsql/src/pl_gram.y", "src/pl/plpgsql/src/pl_gram.c")
    _perl("plpgsql_errcodes", "src/pl/plpgsql/src/generate-plerrcodes.pl", ["src/backend/utils/errcodes.txt"], ["src/pl/plpgsql/src/plerrcodes.h"],
          ["$(location src/backend/utils/errcodes.txt)"], capture = True)
    for kind, variable in [("reserved", "ReservedPLKeywords"), ("unreserved", "UnreservedPLKeywords")]:
        source = "src/pl/plpgsql/src/pl_" + kind + "_kwlist.h"
        _perl("plpgsql_" + kind, "src/tools/gen_keywordlist.pl", ["src/tools/PerfectHash.pm", source], [source[:-2] + "_d.h"],
              ["--output", "$(RULEDIR)/src/pl/plpgsql/src", "--varname", variable, "$(location " + source + ")"])
    _perl("snowball_sql", "src/backend/snowball/snowball_create.pl", POSTGRES_SNOWBALL_SQL_INPUTS,
          ["src/backend/snowball/snowball_create.sql"],
          ["--input", "$(dirname src/backend/snowball/snowball.sql.in)", "--outdir", "$(RULEDIR)/src/backend/snowball"])

def postgres_frontend_generated_targets():
    """Generate frontend scanners/completion/help in the caller's PG source."""
    _parser("frontend_scan", "src/fe_utils/psqlscan.l", "src/fe_utils/psqlscan.c", scanner = True)
    _parser("psql_slash_scan", "src/bin/psql/psqlscanslash.l", "src/bin/psql/psqlscanslash.c", scanner = True, options_override = "-Cfe -p -p")
    _perl("psql_completion", "src/bin/psql/gen_tabcomplete.pl", ["src/bin/psql/tab-complete.in.c"], ["src/bin/psql/tab-complete.c"],
          ["$(location src/bin/psql/tab-complete.in.c)", "--outfile", "$@"])
    help_inputs = native.glob(["doc/src/sgml/ref/*.sgml"])
    _perl("psql_help", "src/bin/psql/create_help.pl", help_inputs, ["src/bin/psql/sql_help.c", "src/bin/psql/sql_help.h"],
          ["--docdir", "$(dirname " + help_inputs[0] + ")", "--outdir", "$(RULEDIR)/src/bin/psql", "--basename", "sql_help"])

def postgres_native_targets(version):
    """Declare explicit sources and generated outputs, separately by ABI role."""
    pg_config(name = "static_configuration", template = "src/include/pg_config.h.in", os_header = NATIVE_OS_HEADER, version = version,
              values = NATIVE_CONFIG, profile = NATIVE_PROFILE)
    postgres_host_configuration_targets(version)
    native.filegroup(name = "configuration", srcs = NATIVE_CONFIGURATION)
    postgres_generated_targets(version)
    postgres_frontend_generated_targets()
    generated_headers = POSTGRES_CATALOG_GENERATED_HEADERS + POSTGRES_NODE_GENERATED_TEXTUAL_SOURCES + POSTGRES_WAIT_EVENT_GENERATED_TEXTUAL_SOURCES + POSTGRES_BACKEND_GENERATED_HEADERS + POSTGRES_COMMON_GENERATED_HEADERS + POSTGRES_PLPGSQL_GENERATED_HEADERS
    cc_library(
        name = "server_headers",
        hdrs = native.glob(["src/include/**/*.h", "src/backend/**/*.h", "src/common/**/*.h", "src/pl/plpgsql/src/*.h", "src/interfaces/libpq/*.h", "src/timezone/*.h"]) + generated_headers + [":configuration"],
        textual_hdrs = POSTGRES_BACKEND_TEXTUAL_SOURCES,
        deps = ["@icu//:i18n_headers"] + NATIVE_CONFIGURATION_ADMISSION,
        includes = NATIVE_INCLUDE_DIRECTORIES + POSTGRES_BACKEND_INCLUDE_DIRECTORIES + ["src/common", "src/pl/plpgsql/src", "src/interfaces/libpq", "src/include/snowball", "src/timezone"],
        defines = NATIVE_HEADER_DEFINES,
        target_compatible_with = _COMPATIBLE,
    )
    cc_library(name = "embedded_headers", deps = [":server_headers"], defines = ["OLIPHAUNT_EMBEDDED"] + NATIVE_EMBEDDED_DEFINES, target_compatible_with = _COMPATIBLE)
    common_sources = POSTGRES_COMMON_SOURCES + POSTGRES_COMMON_RYU_SOURCES + POSTGRES_COMMON_CONFIG_INFO_SOURCES + POSTGRES_COMMON_BUILTIN_CRYPTO_SOURCES
    port_sources = POSTGRES_PORT_SOURCES + NATIVE_PORT_CRC_SOURCES + NATIVE_PORT_ADDITIONAL_SOURCES + NATIVE_PORT_REPLACEMENTS
    for role, headers, definitions, additions in [
        ("server", ":server_headers", [], []),
        ("embedded", ":embedded_headers", [], []),
        ("frontend", ":server_headers", ["FRONTEND", "USE_PRIVATE_ENCODING_FUNCS"], POSTGRES_COMMON_FRONTEND_SHARED_ADDITIONAL_SOURCES + POSTGRES_COMMON_FRONTEND_STATIC_ADDITIONAL_SOURCES),
    ]:
        core_definitions = NATIVE_BACKEND_DEFINES if role != "frontend" else []
        cc_library(name = "common_" + role, srcs = common_sources + additions, deps = [headers], local_defines = definitions + core_definitions, copts = _COPTS, linkopts = _LINKOPTS, target_compatible_with = _COMPATIBLE)
        cc_library(name = "port_" + role, srcs = port_sources, deps = [headers], local_defines = definitions + core_definitions, copts = _COPTS, target_compatible_with = _COMPATIBLE)
        if role != "frontend":
            cc_library(name = "timezone_" + role, srcs = POSTGRES_TIMEZONE_SOURCES, deps = [headers], local_defines = core_definitions, copts = _COPTS, target_compatible_with = _COMPATIBLE)
            cc_library(name = "backend_" + role, srcs = POSTGRES_BACKEND_SOURCES + NATIVE_BACKEND_PORT_SOURCES + POSTGRES_BACKEND_GENERATED_SOURCES,
                       deps = [headers, ":common_" + role, ":port_" + role, ":timezone_" + role, "@icu//:i18n"],
                       local_defines = core_definitions, copts = _COPTS, alwayslink = True, target_compatible_with = _COMPATIBLE)
            cc_library(name = "plpgsql_" + role, srcs = POSTGRES_PLPGSQL_SOURCES + POSTGRES_PLPGSQL_GENERATED_SOURCES,
                       deps = [headers], copts = _COPTS, alwayslink = True, target_compatible_with = _COMPATIBLE)
            cc_library(name = "snowball_" + role, srcs = POSTGRES_SNOWBALL_SOURCES, deps = [headers], copts = _COPTS, alwayslink = True, target_compatible_with = _COMPATIBLE)
    cc_library(name = "snowball_builtin", srcs = POSTGRES_SNOWBALL_SOURCES, deps = [":embedded_headers"],
               local_defines = ["Pg_magic_func=oliphaunt_builtin_dict_snowball_Pg_magic_func"],
               copts = _COPTS, alwayslink = True, target_compatible_with = _COMPATIBLE)
    # MSVC builtin objects produce engine DATA; module objects import it.
    cc_library(name = "plpgsql_builtin_windows", srcs = POSTGRES_PLPGSQL_SOURCES + POSTGRES_PLPGSQL_GENERATED_SOURCES,
               deps = [":embedded_headers"], local_defines = NATIVE_BACKEND_DEFINES, copts = _COPTS, alwayslink = True, target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
    # libpq exports public encoding functions and must not pull frontend logging
    # or exit-on-OOM implementations. Keep upstream's shared/frontend role split.
    cc_library(name = "common_frontend_shlib", srcs = common_sources + POSTGRES_COMMON_FRONTEND_SHARED_ADDITIONAL_SOURCES,
               deps = [":server_headers"], local_defines = ["FRONTEND", "JSONAPI_USE_PQEXPBUFFER"],
               copts = _COPTS, linkopts = _LINKOPTS, target_compatible_with = _COMPATIBLE)
    cc_library(name = "libpq_objects", srcs = POSTGRES_LIBPQ_SOURCES + NATIVE_LIBPQ_ADDITIONAL_SOURCES, deps = [":server_headers", ":common_frontend_shlib", ":port_frontend"], local_defines = ["FRONTEND", "SO_MAJOR_VERSION=5"], copts = _COPTS, alwayslink = True, target_compatible_with = _COMPATIBLE)
    cc_binary(name = "libpq.so", deps = [":libpq_objects"], linkshared = True,
              features = ["-soname"], linkopts = NATIVE_LIBPQ_LINKOPTS + _LINKOPTS + NATIVE_RELEASE_LINKOPTS, target_compatible_with = NATIVE_ELF_C_COMPATIBLE)
    cc_binary(name = "libpq.dylib", deps = [":libpq_objects"], linkshared = True, linkopts = NATIVE_LIBPQ_LINKOPTS + _LINKOPTS, target_compatible_with = NATIVE_MACOS_COMPATIBLE)
    _postgres_windows_targets()
    native.alias(name = "libpq_shared", actual = select({"@oliphaunt//build_defs/native:macos_arm64": ":libpq.dylib", "@oliphaunt//build_defs/native:windows_x64": ":libpq.dll", "//conditions:default": ":libpq.so"}))
    cc_import(name = "libpq", shared_library = ":libpq_shared", interface_library = select({"@oliphaunt//build_defs/native:windows_x64": ":libpq_windows_interface", "//conditions:default": None}), target_compatible_with = _COMPATIBLE)
    # Match upstream fe_utils Windows Winsock capacity without exporting it to other targets.
    cc_library(name = "frontend_utils", srcs = POSTGRES_FRONTEND_UTIL_SOURCES + ["src/fe_utils/psqlscan.c"],
               deps = [":server_headers", ":common_frontend", ":port_frontend", ":libpq"],
               defines = ["FRONTEND"],
               local_defines = select({"@oliphaunt//build_defs/native:windows_x64": ["FD_SETSIZE=1024"], "//conditions:default": []}),
               copts = _COPTS, target_compatible_with = _COMPATIBLE)
    cc_library(name = "tools_headers", hdrs = native.glob(["src/bin/pg_dump/*.h", "src/bin/pg_basebackup/*.h", "src/bin/psql/*.h"]) + ["src/bin/psql/sql_help.h"],
               deps = [":server_headers"], includes = ["src/bin/pg_dump", "src/bin/pg_basebackup", "src/bin/psql"], target_compatible_with = _COMPATIBLE)
    frontend_deps = [":server_headers", ":common_frontend", ":port_frontend", ":libpq", ":frontend_utils"]
    cc_binary(name = "pg_ctl", srcs = ["src/bin/pg_ctl/pg_ctl.c"], deps = [":server_headers", ":common_frontend", ":port_frontend"] + select({"@oliphaunt//build_defs/native:windows_x64": [":libpq"], "//conditions:default": []}),
              defines = ["FRONTEND"], copts = _COPTS, linkopts = NATIVE_RELEASE_LINKOPTS, target_compatible_with = _COMPATIBLE)
    cc_binary(name = "pg_config", srcs = POSTGRES_PG_CONFIG_SOURCES, deps = [":server_headers", ":common_frontend", ":port_frontend"],
              defines = ["FRONTEND"], copts = _COPTS, target_compatible_with = _COMPATIBLE)
    cc_library(name = "dump_common", srcs = POSTGRES_DUMP_COMMON_SOURCES, deps = frontend_deps + [":tools_headers"],
               defines = ["FRONTEND"], copts = _COPTS, target_compatible_with = _COMPATIBLE)
    cc_binary(name = "pg_dump", srcs = POSTGRES_DUMP_SOURCES, deps = frontend_deps + [":tools_headers", ":dump_common"],
              defines = ["FRONTEND"], copts = _COPTS, linkopts = _FRONTEND_LINKOPTS + NATIVE_RELEASE_LINKOPTS, target_compatible_with = _COMPATIBLE)
    cc_library(name = "basebackup_common", srcs = POSTGRES_BASEBACKUP_COMMON_SOURCES, deps = frontend_deps + [":tools_headers"],
               defines = ["FRONTEND"], copts = _COPTS, target_compatible_with = _COMPATIBLE)
    cc_binary(name = "pg_basebackup", srcs = ["src/bin/pg_basebackup/pg_basebackup.c"], deps = frontend_deps + [":tools_headers", ":basebackup_common"],
              defines = ["FRONTEND"], copts = _COPTS, linkopts = _FRONTEND_LINKOPTS + NATIVE_RELEASE_LINKOPTS, target_compatible_with = _COMPATIBLE)
    cc_binary(name = "psql", srcs = POSTGRES_PSQL_SOURCES + ["src/bin/psql/psqlscanslash.c", "src/bin/psql/tab-complete.c", "src/bin/psql/sql_help.c"],
              deps = frontend_deps + [":tools_headers"], defines = ["FRONTEND"], copts = _COPTS, linkopts = _FRONTEND_LINKOPTS + NATIVE_RELEASE_LINKOPTS, target_compatible_with = _COMPATIBLE)
    # Original PostgreSQL regression driver, constructed only by test consumers.
    cc_binary(
        name = "pg_regress",
        srcs = ["src/test/regress/pg_regress.c", "src/test/regress/pg_regress_main.c", "src/test/regress/pg_regress.h"],
        deps = [":server_headers", ":common_frontend", ":port_frontend", ":libpq"],
        defines = ["FRONTEND"],
        copts = _COPTS + ["-DSHELLPROG=\\\"/bin/sh\\\""] + select({
            "@oliphaunt//build_defs/native:linux_aarch64_gnu_2_28": ["-DHOST_TUPLE=\\\"aarch64-unknown-linux-gnu\\\""],
            "//conditions:default": ["-DHOST_TUPLE=\\\"x86_64-pc-linux-gnu\\\""],
        }),
        linkopts = _FRONTEND_LINKOPTS + NATIVE_RELEASE_LINKOPTS,
        target_compatible_with = select({
            "@oliphaunt//build_defs/native:linux_x86_64": [],
            "@oliphaunt//build_defs/native:linux_aarch64_gnu_2_28": [],
            "//conditions:default": ["@platforms//:incompatible"],
        }),
        testonly = True,
    )
    cc_library(name = "initdb_frontend_utils", srcs = ["src/fe_utils/option_utils.c", "src/fe_utils/string_utils.c"],
               deps = [":server_headers", ":common_frontend", ":port_frontend", ":libpq"], defines = ["FRONTEND"], copts = _COPTS, target_compatible_with = _COMPATIBLE)
    cc_binary(name = "postgres", srcs = POSTGRES_MAIN_SOURCES, deps = [":backend_server"], copts = _COPTS,
              linkopts = NATIVE_SERVER_LINKOPTS + _LINKOPTS + NATIVE_RELEASE_LINKOPTS, target_compatible_with = NATIVE_UNIX_COMPATIBLE)
    native.alias(name = "server_executable", actual = select({"@oliphaunt//build_defs/native:windows_x64": ":postgres_windows", "//conditions:default": ":postgres"}))
    cc_library(name = "main_embedded", srcs = POSTGRES_MAIN_SOURCES, deps = [":embedded_headers"],
               local_defines = ["main=oliphaunt_postgres_main"] + NATIVE_BACKEND_DEFINES, copts = _COPTS, target_compatible_with = _COMPATIBLE)
    cc_binary(name = "initdb", srcs = POSTGRES_INITDB_SOURCES, deps = [":server_headers", ":common_frontend", ":port_frontend", ":libpq", ":initdb_frontend_utils", "@icu//:i18n"],
              defines = ["FRONTEND", "USE_PRIVATE_ENCODING_FUNCS"], copts = _COPTS, linkopts = _LINKOPTS + _FRONTEND_LINKOPTS + NATIVE_RELEASE_LINKOPTS, target_compatible_with = _COMPATIBLE)
    cc_library(name = "zic_headers", hdrs = [
        "src/include/c.h", "src/include/pg_config_manual.h", "src/include/postgres_ext.h", "src/include/port.h",
        "src/include/postgres_fe.h", "src/include/common/fe_memutils.h", "src/include/pg_getopt.h", "src/include/pgtime.h", "src/include/lib/sort_template.h",
        "src/timezone/private.h", "src/timezone/tzfile.h", ":configuration",
    ] + select({"@oliphaunt//build_defs/native:windows_x64": native.glob(["src/include/port/win32/**/*.h", "src/include/port/win32_msvc/**/*.h"]), "//conditions:default": []}),
               includes = NATIVE_INCLUDE_DIRECTORIES + ["src/include", "src/timezone"], defines = NATIVE_HEADER_DEFINES, deps = NATIVE_CONFIGURATION_ADMISSION, target_compatible_with = _COMPATIBLE)
    cc_library(name = "zic_port", srcs = ["src/port/qsort.c", "src/port/snprintf.c", "src/port/strerror.c"], deps = [":zic_headers"],
               defines = ["FRONTEND"], copts = _COPTS, linkopts = select({"@oliphaunt//build_defs/native:windows_x64": [], "//conditions:default": ["-lm"]}), target_compatible_with = NATIVE_UNIX_COMPATIBLE)
    cc_binary(name = "zic", srcs = POSTGRES_ZIC_SOURCES, deps = [":zic_headers"] + select({"@oliphaunt//build_defs/native:windows_x64": [":common_frontend", ":port_frontend"], "//conditions:default": [":zic_port"]}),
              defines = ["FRONTEND"], copts = _COPTS, target_compatible_with = _COMPATIBLE)
    timezone_database(name = "timezone", source = "src/timezone/data/tzdata.zi", zic = ":zic")
    for name, dependency in [("plpgsql", ":plpgsql_server"), ("dict_snowball", ":snowball_server")]:
        cc_binary(name = name + ".so", deps = [dependency], linkshared = True, linkopts = NATIVE_RELEASE_LINKOPTS, target_compatible_with = NATIVE_ELF_C_COMPATIBLE)
        cc_binary(name = name + ".dylib", deps = [dependency], linkshared = True, linkopts = NATIVE_MODULE_LINKOPTS, target_compatible_with = NATIVE_MACOS_COMPATIBLE)
        cc_binary(name = name + ".dll", deps = [dependency, ":server_import_library"], linkshared = True, target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
        native.alias(name = name + "_module", actual = select({"@oliphaunt//build_defs/native:macos_arm64": ":" + name + ".dylib", "@oliphaunt//build_defs/native:windows_x64": ":" + name + ".dll", "//conditions:default": ":" + name + ".so"}))
    postgres_resource_targets()

def _postgres_windows_targets():
    _perl("libpq_windows_exports", "src/tools/gen_export.pl", ["src/interfaces/libpq/exports.txt"], ["libpq.def"],
          ["--format", "win", "--libname", "libpq", "--input", "$(location src/interfaces/libpq/exports.txt)", "--output", "$@"])
    cc_binary(name = "libpq.dll", deps = [":libpq_objects"], linkshared = True, win_def_file = "libpq.def", features = ["no_windows_export_all_symbols"],
              linkopts = _LINKOPTS, target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
    native.filegroup(name = "libpq_windows_interface", srcs = [":libpq.dll"], output_group = "interface_library", target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
    cc_library(name = "main_server_windows", srcs = POSTGRES_MAIN_SOURCES, deps = [":server_headers"], local_defines = NATIVE_BACKEND_DEFINES, copts = _COPTS, target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
    postgres_windows_exports(name = "server_windows_exports", roots = [":backend_server", ":main_server_windows"], target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
    postgres_windows_resource(name = "server_windows_resource", template = "src/port/win32ver.rc", configuration = ":configuration", filename = "postgres.exe", description = "PostgreSQL Server", icon = "src/port/win32.ico", target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
    postgres_windows_server(name = "postgres_windows", deps = [":backend_server", ":main_server_windows"], exports = ":server_windows_exports", resources = [":server_windows_resource"], linkopts = _LINKOPTS, target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
    native.filegroup(name = "server_windows_interface", srcs = [":postgres_windows"], output_group = "interface_library", target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)
    cc_import(name = "server_import_library", interface_library = ":server_windows_interface", system_provided = True, target_compatible_with = NATIVE_WINDOWS_COMPATIBLE)

def postgres_resource_targets():
    """Declare resources in the caller's actual patched/generated PG context."""
    native.filegroup(name = "catalog_runtime_data", srcs = [
        "src/include/catalog/postgres.bki",
        "src/include/catalog/system_constraints.sql",
        "src/backend/snowball/snowball_create.sql",
        "src/backend/catalog/information_schema.sql",
        "src/backend/catalog/system_functions.sql",
        "src/backend/catalog/system_views.sql",
        "src/backend/catalog/sql_features.txt",
        "src/backend/utils/misc/postgresql.conf.sample",
        "src/backend/libpq/pg_hba.conf.sample",
        "src/backend/libpq/pg_ident.conf.sample",
    ])
    native.filegroup(name = "stopwords", srcs = POSTGRES_SNOWBALL_STOPWORDS)
    native.filegroup(name = "timezone_abbreviations", srcs = native.glob(["src/timezone/tznames/*"], exclude = ["src/timezone/tznames/README"]))
    native.filegroup(name = "license", srcs = ["COPYRIGHT"])
    native.filegroup(name = "builtin_extension_data", srcs = native.glob(["src/pl/plpgsql/src/plpgsql.control", "src/pl/plpgsql/src/plpgsql--*.sql"]))
    directories = {control.rsplit("/", 1)[0]: True for control in native.glob(["contrib/*/*.control"])}
    for directory in directories:
        name = directory.split("/")[-1].replace("-", "_")
        native.filegroup(name = "contrib_" + name + "_resources", srcs = native.glob([directory + "/*.control", directory + "/*--*.sql", directory + "/*.rules"], allow_empty = True))
