"""Declared PostgreSQL configuration and filesystem layout headers."""

_DIRECTORIES = {
    "PGBINDIR": "bin",
    "PGSHAREDIR": "share/postgresql",
    "SYSCONFDIR": "etc",
    "INCLUDEDIR": "include",
    "PKGINCLUDEDIR": "include/postgresql",
    "INCLUDEDIRSERVER": "include/postgresql/server",
    "LIBDIR": "lib",
    "PKGLIBDIR": "lib/postgresql",
    "LOCALEDIR": "share/locale",
    "DOCDIR": "share/doc",
    "HTMLDIR": "share/doc/html",
    "MANDIR": "share/man",
}

def _layout(ctx, output_directory):
    os_header = ctx.actions.declare_file(output_directory + "/pg_config_os.h")
    ctx.actions.symlink(output = os_header, target_file = ctx.file.os_header)
    paths = ctx.actions.declare_file(output_directory + "/pg_config_paths.h")
    prefix = ctx.attr.prefix.rstrip("/")
    ctx.actions.write(paths, "".join(['#define ' + key + ' "' + prefix + '/' + value + '"\n' for key, value in _DIRECTORIES.items()]))
    return [os_header, paths]

def _pg_config_impl(ctx):
    parts = ctx.attr.version.split(".")
    major = int(parts[0])
    minor = int(parts[1])
    values = dict(ctx.attr.values)
    values.update({
        "PACKAGE_STRING": '"PostgreSQL ' + ctx.attr.version + '"',
        "PACKAGE_VERSION": '"' + ctx.attr.version + '"',
        "PG_MAJORVERSION": '"' + parts[0] + '"',
        "PG_MAJORVERSION_NUM": str(major),
        "PG_MINORVERSION_NUM": str(minor),
        "PG_VERSION": '"' + ctx.attr.version + '"',
        "PG_VERSION_NUM": str(major * 10000 + minor),
        "PG_VERSION_STR": '"PostgreSQL ' + ctx.attr.version + ' ' + ctx.attr.profile + ', ' + str(int(values["SIZEOF_VOID_P"]) * 8) + '-bit"',
    })
    config = ctx.actions.declare_file("src/include/pg_config.h")
    ctx.actions.expand_template(
        template = ctx.file.template,
        output = config,
        substitutions = {"#undef " + key + "\n": "#define " + key + " " + value + "\n" for key, value in values.items()},
    )
    return [DefaultInfo(files = depset([config] + _layout(ctx, "src/include")))]

pg_config = rule(
    implementation = _pg_config_impl,
    attrs = {
        "template": attr.label(allow_single_file = True, mandatory = True),
        "os_header": attr.label(allow_single_file = True, mandatory = True),
        "version": attr.string(mandatory = True),
        "values": attr.string_dict(mandatory = True),
        "profile": attr.string(mandatory = True),
        "prefix": attr.string(default = "/oliphaunt/runtime"),
    },
)

def _pg_config_layout_impl(ctx):
    return [DefaultInfo(files = depset(_layout(ctx, ctx.attr.output_directory)))]

pg_config_layout = rule(
    implementation = _pg_config_layout_impl,
    attrs = {
        "os_header": attr.label(allow_single_file = True, mandatory = True),
        "output_directory": attr.string(default = "host_config/src/include"),
        "prefix": attr.string(default = "/oliphaunt/runtime"),
    },
)
