"""Bounded native MSVC export/resource/executable link actions for PostgreSQL."""

load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/common:cc_info.bzl", "CcInfo")
load("@rules_cc//cc:find_cc_toolchain.bzl", "find_cc_toolchain", "use_cc_toolchain")
load("@rules_cc//cc:action_names.bzl", "ACTION_NAMES")
load("//build_defs/foundation:bun-toolchain.bzl", "BUN_TOOLCHAIN_TYPE")

_BUN_TOOLCHAIN_TYPE = Label(BUN_TOOLCHAIN_TYPE)

def _cc(ctx):
    toolchain = find_cc_toolchain(ctx)
    features = cc_common.configure_features(ctx = ctx, cc_toolchain = toolchain, requested_features = ctx.features, unsupported_features = ctx.disabled_features)
    variables = cc_common.create_compile_variables(feature_configuration = features, cc_toolchain = toolchain)
    environment = cc_common.get_environment_variables(feature_configuration = features, action_name = ACTION_NAMES.c_compile, variables = variables)
    return toolchain, features, environment

def _exports_impl(ctx):
    toolchain, _, environment = _cc(ctx)
    archives = {}
    for dep in ctx.attr.roots:
        for linker_input in dep[CcInfo].linking_context.linker_inputs.to_list():
            for library in linker_input.libraries:
                # Shared dependencies expose interface libraries; never export
                # their imported symbols as though they belonged to the engine.
                archive = library.static_library or library.pic_static_library
                if archive:
                    archives[archive.path] = archive
    if not archives:
        fail("PostgreSQL Windows exports require actual producing core archives")
    symbols = ctx.actions.declare_file(ctx.label.name + ".symbols")
    ctx.actions.run(executable = ctx.file._dumpbin, arguments = ["/nologo", "/symbols", "/out:" + symbols.path] + sorted(archives),
                    inputs = depset(archives.values(), transitive = [toolchain.all_files]), outputs = [symbols], env = environment, mnemonic = "PostgresMsvcSymbols")
    output = ctx.actions.declare_file(ctx.label.name + ".def")
    bun = ctx.toolchains[_BUN_TOOLCHAIN_TYPE].bun
    ctx.actions.run(executable = bun, arguments = [ctx.file._parser.path, symbols.path, output.path],
                    inputs = [ctx.file._parser, symbols], outputs = [output], mnemonic = "PostgresMsvcExports")
    return [DefaultInfo(files = depset([output]))]

postgres_windows_exports = rule(
    implementation = _exports_impl,
    attrs = {
        "roots": attr.label_list(mandatory = True, providers = [CcInfo]),
        "_dumpbin": attr.label(default = Label("@native_msvc_sdk//:compiler_bin/dumpbin.exe"), allow_single_file = True, cfg = "exec"),
        "_parser": attr.label(default = Label("//build_defs/native:windows-exports.mts"), allow_single_file = True),
    },
    fragments = ["cpp"],
    toolchains = use_cc_toolchain() + [_BUN_TOOLCHAIN_TYPE],
)

def _resource_impl(ctx):
    toolchain, _, environment = _cc(ctx)
    headers = [file for file in ctx.files.configuration if file.basename == "pg_config.h"]
    if len(headers) != 1:
        fail("MSVC version resources require the selected single pg_config.h")
    template = ctx.actions.declare_file(ctx.label.name + ".rc")
    icon = 'IDI_ICON ICON "' + ctx.file.icon.path.replace("\\", "/") + '"' if ctx.file.icon else ""
    ctx.actions.expand_template(template = ctx.file.template, output = template, substitutions = {
        "FILEDESC": '"' + ctx.attr.description + '"',
        "_INTERNAL_NAME_": '"' + ctx.attr.filename + '"',
        "_ORIGINAL_NAME_": '"' + ctx.attr.filename + '"',
        "_ICO_": icon,
    })
    output = ctx.actions.declare_file(ctx.label.name + ".res")
    ctx.actions.run(executable = ctx.file._rc, arguments = ["/nologo", "/i", headers[0].dirname, "/fo", output.path, template.path],
                    inputs = depset([template] + ctx.files.configuration + ([ctx.file.icon] if ctx.file.icon else []), transitive = [toolchain.all_files]),
                    outputs = [output], env = environment, mnemonic = "PostgresMsvcResource")
    return [DefaultInfo(files = depset([output]))]

postgres_windows_resource = rule(
    implementation = _resource_impl,
    attrs = {
        "template": attr.label(mandatory = True, allow_single_file = True),
        "configuration": attr.label(mandatory = True, allow_files = True),
        "filename": attr.string(mandatory = True),
        "description": attr.string(mandatory = True),
        "icon": attr.label(allow_single_file = True),
        "_rc": attr.label(default = Label("@native_msvc_sdk//:sdk_bin/rc.exe"), allow_single_file = True, cfg = "exec"),
    },
    fragments = ["cpp"],
    toolchains = use_cc_toolchain(),
)

def _server_impl(ctx):
    toolchain, features, _ = _cc(ctx)
    # The ordinary server is an executable, but its extensions import backend
    # functions AND DATA from a postgres.exe import library. cc_binary's DLL
    # export helper only covers linkshared outputs, so declare this real output
    # directly through the same native C++ linker API.
    import_library = ctx.actions.declare_file("postgres.lib")
    output = cc_common.link(
        actions = ctx.actions,
        feature_configuration = features,
        cc_toolchain = toolchain,
        linking_contexts = [dep[CcInfo].linking_context for dep in ctx.attr.deps],
        user_link_flags = ctx.attr.linkopts + [file.path for file in ctx.files.resources] + ["/DEF:" + ctx.file.exports.path, "/IMPLIB:" + import_library.path],
        additional_inputs = [ctx.file.exports] + ctx.files.resources,
        additional_outputs = [import_library],
        name = "postgres",
        output_type = "executable",
        link_deps_statically = True,
        stamp = 0,
    )
    return [DefaultInfo(files = depset([output.executable]), executable = output.executable), OutputGroupInfo(interface_library = depset([import_library]))]

postgres_windows_server = rule(
    implementation = _server_impl,
    attrs = {
        "deps": attr.label_list(mandatory = True, providers = [CcInfo]),
        "exports": attr.label(mandatory = True, allow_single_file = True),
        "resources": attr.label_list(allow_files = True),
        "linkopts": attr.string_list(),
    },
    fragments = ["cpp"],
    toolchains = use_cc_toolchain(),
    executable = True,
)
