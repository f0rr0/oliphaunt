"""PostGIS SQL uses pinned upstream GPP and Perl generators."""

load("@oliphaunt_metadata//:metadata.bzl", "EXTENSION_SOURCES", "POSTGRES_SOURCE")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("//build_defs/extensions:platforms.bzl", "NATIVE_EXTENSION_COMPATIBLE")

def _preprocess_impl(ctx):
    contexts = [dep[CcInfo].compilation_context for dep in ctx.attr.headers]
    outputs = []
    for source in ctx.files.srcs:
        output = ctx.actions.declare_file(ctx.label.name + "/" + source.basename[:-3])
        # This is configure.ac's GPP SQLPP branch, including its SQL string mode.
        args = ctx.actions.args()
        args.add_all(["-C", "-s", "'", "-o", output.path])
        args.add_all(depset(transitive = [context.includes for context in contexts]), format_each = "-I%s")
        args.add(source)
        ctx.actions.run(executable = ctx.attr._gpp[DefaultInfo].files_to_run,
                        arguments = [args],
                        inputs = depset(ctx.files.inputs + [source], transitive = [context.headers for context in contexts]),
                        outputs = [output], mnemonic = "PostgisSqlPreprocess")
        outputs.append(output)
    return [DefaultInfo(files = depset(outputs))]

_preprocess = rule(implementation = _preprocess_impl,
    attrs = {"srcs": attr.label_list(allow_files = True), "inputs": attr.label_list(allow_files = True), "headers": attr.label_list(providers = [CcInfo]),
             "_gpp": attr.label(default = "@postgis_gpp//:gpp", executable = True, cfg = "exec")})

def _sql_impl(ctx):
    extension = ctx.actions.declare_directory(ctx.label.name + "/extension")
    data = ctx.actions.declare_directory(ctx.label.name + "/contrib")
    source = EXTENSION_SOURCES["postgis"]
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({"source": ctx.file.root.dirname, "extension": extension.path, "data": data.path,
        "preprocessed": {file.basename: file.path for file in ctx.files.preprocessed},
        "source_date_epoch": source["source_date_epoch"], "version": source["extension-control"]["default-version"],
        "postgres_version": int(POSTGRES_SOURCE["postgresql"]["version"].split(".")[0]) * 10}))
    perl = ctx.toolchains["@rules_perl//perl:exec_toolchain_type"].perl_runtime
    args = ctx.actions.args()
    args.add("--spec", spec)
    args.add("--perl", perl.interpreter)
    for option in perl.perlopt:
        args.add("--perl-option=" + option)
    ctx.actions.run(executable = ctx.attr._generator[DefaultInfo].files_to_run,
                    inputs = depset([spec, ctx.file.root] + ctx.files.inputs + ctx.files.preprocessed, transitive = [perl.runtime]),
                    outputs = [extension, data], arguments = [args], mnemonic = "PostgisUpstreamSql")
    return [DefaultInfo(files = depset([extension, data])), OutputGroupInfo(extension_sql = depset([extension]), data_sql = depset([data]))]

_sql = rule(implementation = _sql_impl,
    attrs = {"root": attr.label(allow_single_file = True), "inputs": attr.label_list(allow_files = True), "preprocessed": attr.label_list(allow_files = True),
             "_generator": attr.label(default = "//build_defs/extensions/postgis:sql", executable = True, cfg = "exec")},
    toolchains = ["@rules_perl//perl:exec_toolchain_type"])

def postgis_sql(name, configuration, headers):
    prefix = "@postgis//:"
    inputs = [prefix + "postgis_sql_inputs", prefix + "spatial_ref_sys.sql"]
    preprocessed = name + "_preprocessed"
    _preprocess(name = preprocessed,
                srcs = [prefix + "postgis/" + source + ".sql.in" for source in ["postgis", "legacy", "legacy_minimal", "legacy_gist"]] +
                       [prefix + "raster/rt_pg/" + source + ".sql.in" for source in ["rtpostgis", "rtpostgis_drop", "rtpostgis_upgrade_cleanup"]] +
                       [prefix + "extensions/postgis_extension_helper.sql.in"],
                inputs = inputs, headers = [configuration, headers], target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
    _sql(name = name, root = prefix + "Version.config", inputs = inputs, preprocessed = [":" + preprocessed], target_compatible_with = NATIVE_EXTENSION_COMPATIBLE)
