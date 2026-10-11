"""Reviewed PostgreSQL 18.4 contrib units and their actual upstream generators.

Release membership, versions, module identities and ownership are imported from
the canonical metadata. These lists only replace the pinned PGXS object recipes.
"""

load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("@oliphaunt_metadata//:metadata.bzl", "CONTRIB_MEMBERS")
load("//build_defs/release:shipping.bzl", "shipping_package")
load("//build_defs/native:generators.bzl", "postgres_bison", "postgres_flex", "postgres_perl")
load(":extensions.bzl", "NATIVE_EXTENSION_CONFIGURATION", "extension_identity", "extension_member_payload", "extension_member_validation_test", "native_extension_modules")

CONTRIB_C_SOURCES = {
    "amcheck": ["verify_common", "verify_gin", "verify_heapam", "verify_nbtree"],
    "auto_explain": ["auto_explain"],
    "bloom": ["blcost", "blinsert", "blscan", "blutils", "blvacuum", "blvalidate"],
    "btree_gin": ["btree_gin"],
    "btree_gist": ["btree_bit", "btree_bool", "btree_bytea", "btree_cash", "btree_date", "btree_enum", "btree_float4", "btree_float8", "btree_gist", "btree_inet", "btree_int2", "btree_int4", "btree_int8", "btree_interval", "btree_macaddr", "btree_macaddr8", "btree_numeric", "btree_oid", "btree_text", "btree_time", "btree_ts", "btree_utils_num", "btree_utils_var", "btree_uuid"],
    "citext": ["citext"],
    "cube": ["cube"],
    "dict_int": ["dict_int"],
    "dict_xsyn": ["dict_xsyn"],
    "earthdistance": ["earthdistance"],
    "file_fdw": ["file_fdw"],
    "fuzzystrmatch": ["daitch_mokotoff", "dmetaphone", "fuzzystrmatch"],
    "hstore": ["hstore_compat", "hstore_gin", "hstore_gist", "hstore_io", "hstore_op", "hstore_subs"],
    "intarray": ["_int_bool", "_int_gin", "_int_gist", "_int_op", "_int_selfuncs", "_int_tool", "_intbig_gist"],
    "isn": ["isn"],
    "lo": ["lo"],
    "ltree": ["_ltree_gist", "_ltree_op", "crc32", "lquery_op", "ltree_gist", "ltree_io", "ltree_op", "ltxtquery_io", "ltxtquery_op"],
    "pageinspect": ["brinfuncs", "btreefuncs", "fsmfuncs", "ginfuncs", "gistfuncs", "hashfuncs", "heapfuncs", "rawpage"],
    "pg_buffercache": ["pg_buffercache_pages"],
    "pg_freespacemap": ["pg_freespacemap"],
    "pg_surgery": ["heap_surgery"],
    "pg_trgm": ["trgm_gin", "trgm_gist", "trgm_op", "trgm_regexp"],
    "pg_visibility": ["pg_visibility"],
    "pg_walinspect": ["pg_walinspect"],
    "pgcrypto": ["crypt-blowfish", "crypt-des", "crypt-gensalt", "crypt-md5", "crypt-sha", "mbuf", "openssl", "pgcrypto", "pgp-armor", "pgp-cfb", "pgp-compress", "pgp-decrypt", "pgp-encrypt", "pgp-info", "pgp-mpi", "pgp-mpi-openssl", "pgp-pgsql", "pgp-pubdec", "pgp-pubenc", "pgp-pubkey", "pgp-s2k", "pgp", "px-crypt", "px-hmac", "px"],
    "seg": ["seg"],
    "tablefunc": ["tablefunc"],
    "tcn": ["tcn"],
    "tsm_system_rows": ["tsm_system_rows"],
    "tsm_system_time": ["tsm_system_time"],
    "unaccent": ["unaccent"],
    "uuid_ossp": ["uuid-ossp"],
}

CONTRIB_HEADERS = {
    "amcheck": ["verify_common.h"],
    "bloom": ["bloom.h"],
    "btree_gist": ["btree_gist.h", "btree_utils_num.h", "btree_utils_var.h"],
    "cube": ["cubedata.h"],
    "hstore": ["hstore.h"],
    "intarray": ["_int.h"],
    "isn": ["EAN13.h", "ISBN.h", "ISMN.h", "ISSN.h", "UPC.h", "isn.h"],
    "ltree": ["crc32.h", "ltree.h"],
    "pageinspect": ["pageinspect.h"],
    "pg_trgm": ["trgm.h"],
    "pgcrypto": ["mbuf.h", "pgcrypto.h", "pgp.h", "px-crypt.h", "px.h"],
    "seg": ["segdata.h"],
}

def _generated_sources_impl(ctx):
    generated = ctx.files.srcs
    headers = ctx.files.include_headers + [file for file in generated if file.basename.endswith(".h")]
    include_directories = {file.dirname: True for file in headers}
    return [
        DefaultInfo(files = depset(generated)),
        CcInfo(compilation_context = cc_common.create_compilation_context(
            headers = depset(headers),
            includes = depset(include_directories.keys()),
        )),
    ]

_contrib_generated_inputs = rule(
    implementation = _generated_sources_impl,
    attrs = {
        "srcs": attr.label_list(allow_files = True),
        "include_headers": attr.label_list(allow_files = True),
    },
)

def contrib_generated_sources(name, grammar = None, scanner = None, header_script = None, include_headers = [], grammar_options = ["-d"], scanner_options = [], scanner_rule = postgres_flex):
    """Invoke upstream recipes through the maintained execution toolchains."""
    generated = []
    if grammar:
        stem = grammar.split("/")[-1][:-2]
        target = name + "_parser"
        postgres_bison(name = target, src = grammar, outs = [name + "/" + stem + ".c", name + "/" + stem + ".h"], options = grammar_options)
        generated.append(":" + target)
    if scanner:
        stem = scanner.split("/")[-1][:-2]
        target = name + "_scanner"
        scanner_rule(name = target, src = scanner, outs = [name + "/" + stem + ".c"], options = scanner_options)
        generated.append(":" + target)
    if header_script:
        target = name + "_header"
        postgres_perl(name = target, script = header_script, outs = [name + "/daitch_mokotoff.h"], arguments = ["$@"])
        generated.append(":" + target)
    _contrib_generated_inputs(name = name, srcs = generated, include_headers = include_headers)

def native_contrib_members(crypto = None):
    """Construct each admitted member; crypto requires an actual CcInfo input."""
    for member in CONTRIB_MEMBERS:
        name = member["id"]
        directory = member["contrib-dir"]
        if name not in CONTRIB_C_SOURCES:
            fail("contrib member %s has no reviewed PostgreSQL 18.4 source recipe" % name)
        # Until the separately pinned OpenSSL producer is available, there is no
        # pgcrypto construction target or pretend archive in this development graph.
        if name == "pgcrypto" and crypto == None:
            continue
        prefix = "@postgres//:contrib/" + directory + "/"
        sources = [prefix + source + ".c" for source in CONTRIB_C_SOURCES[name]]
        headers = [prefix + header for header in CONTRIB_HEADERS.get(name, [])]
        deps = []
        defines = []
        includes = []
        copts = []
        if name in ["cube", "seg"]:
            generated = name + "_generated"
            contrib_generated_sources(
                name = generated,
                grammar = prefix + name + "parse.y",
                scanner = prefix + name + "scan.l",
                include_headers = headers,
            )
            sources.append(":" + generated)
            deps.append(":" + generated)
        elif name == "fuzzystrmatch":
            generated = name + "_generated"
            contrib_generated_sources(name = generated, header_script = prefix + "daitch_mokotoff_header.pl")
            sources.append(":" + generated)
            deps.append(":" + generated)
        elif name == "uuid_ossp":
            sources.append("portable-uuid/portable_uuid.c")
            headers.append("portable-uuid/include/uuid/uuid.h")
            headers.append("//build_defs/extensions:uuid_config.h")
            includes.append("portable-uuid/include")
            # pg_config.h undefines optional UUID macros. Select this module's
            # explicit provider after that header, without changing the host.
            copts += ["-include", "build_defs/extensions/uuid_config.h"]
        elif name == "pgcrypto":
            deps.append(crypto)
        native_extension_modules(
            name = name,
            srcs = sources,
            hdrs = headers,
            deps = deps,
            defines = defines,
            includes = includes,
            copts = copts,
            linkopts = ["-lm"] if name in ["btree_gist", "cube", "earthdistance", "tsm_system_time"] else [],
        )
        resources = name + "_sql_resources"
        native.filegroup(
            name = resources,
            srcs = ["@postgres//:contrib_" + directory.replace("-", "_") + "_resources"] if member.get("default-version") else [],
        )
        payload = name + "_native_payload"
        construction_licenses = {}
        if name == "pgcrypto":
            construction_licenses = {"//src/third-party/openssl:LICENSE.txt": "share/licenses/openssl-native/LICENSE.txt", "//src/third-party/openssl:source.toml": "share/licenses/openssl-native/SOURCE.toml"}
        extension_member_payload(
            name = payload,
            sql_name = member["sql-name"],
            owner = extension_identity(member["sql-name"]),
            resources = [":" + resources],
            server_module = ":" + name + "_server.so",
            embedded_module = ":" + name + "_embedded.so",
            construction_licenses = construction_licenses,
        )
        shipping_package(
            name = name + "_native_member",
            owner = extension_identity(member["sql-name"]),
            artifacts = [":" + payload],
            ecosystem = "internal",
            package_name = member["sql-name"],
            configuration = NATIVE_EXTENSION_CONFIGURATION,
            role = "extension-member",
        )
        extension_member_validation_test(name = payload + "_test", payload = ":" + payload, sql_name = member["sql-name"])
