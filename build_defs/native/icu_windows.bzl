"""Direct Windows ICU shared construction with the canonical full data object."""

load("@rules_cc//cc:defs.bzl", "cc_binary", "cc_import", "cc_library", "cc_test")
load("@oliphaunt//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")

_WINDOWS = ["@platforms//os:windows", "@platforms//cpu:x86_64"]
_COPTS = ["/std:c++17", "/utf-8"]
_DEFINES = ["_CRT_SECURE_NO_DEPRECATE", "_HAS_EXCEPTIONS=0", "U_ATTRIBUTE_DEPRECATED="]

def _data_object_impl(ctx):
    output = ctx.actions.declare_file(ctx.label.name + ".obj")
    bun_file_action(
        ctx,
        entry_point = ctx.file._generator,
        source_files = [ctx.file._generator],
        arguments = [ctx.file.data.path, ctx.file.version.path, ctx.file.types.path, "amd64", output.path],
        inputs = [ctx.file._generator, ctx.file.data, ctx.file.version, ctx.file.types],
        outputs = [output],
        mnemonic = "IcuDataObject",
        progress_message = "Embed canonical ICU data %{label}",
    )
    return [DefaultInfo(files = depset([output]))]

_data_object = rule(
    implementation = _data_object_impl,
    attrs = {
        "data": attr.label(default = "@icu_data//:data", allow_single_file = True),
        "version": attr.label(mandatory = True, allow_single_file = True),
        "types": attr.label(mandatory = True, allow_single_file = True),
        "_generator": attr.label(default = Label("@oliphaunt//build_defs/native:icu-data-object.mts"), allow_single_file = True),
    },
    toolchains = BUN_SOURCE_TOOLCHAINS,
)

def _shared(name, srcs = [], deps = [], import_deps = [], linkopts = []):
    cc_binary(
        name = name,
        srcs = srcs,
        deps = deps,
        copts = _COPTS,
        linkopts = ["/INCREMENTAL:NO"] + linkopts,
        linkshared = True,
        linkstatic = True,
        # ICU's public declarations and the data object's directive explicitly
        # export the ABI; avoid an unrelated export-all symbol scan.
        features = ["no_windows_export_all_symbols"],
        target_compatible_with = _WINDOWS,
    )
    interface = name + "_interface"
    native.filegroup(name = interface, srcs = [":" + name], output_group = "interface_library", target_compatible_with = _WINDOWS)
    cc_import(
        name = name + "_import",
        shared_library = ":" + name,
        interface_library = ":" + interface,
        # Forward runtime/import dependencies, never implementation archives.
        deps = import_deps,
        target_compatible_with = _WINDOWS,
    )

def icu_windows_targets(common_sources, i18n_sources):
    """Declare ICU76.1's established Windows carrier DLL names, fenced by pin."""
    _data_object(name = "windows_data_object", version = "common/unicode/uvernum.h", types = "common/unicode/utypes.h", target_compatible_with = _WINDOWS)
    # Upstream pkgdata uses /NOENTRY for its data-only DLL: no CRT initializer
    # or bootstrap stub is part of the Unicode resource carrier.
    _shared(name = "icudt76.dll", srcs = [":windows_data_object"], linkopts = ["/NOENTRY", "/MANIFEST:NO"])

    for role, sources, headers, dependencies, definitions, linkopts in [
        ("common", common_sources, ":common_headers", [":icudt76.dll_import"], ["U_COMMON_IMPLEMENTATION", "U_PLATFORM_USES_ONLY_WIN32_API=1"], ["kernel32.lib", "advapi32.lib"]),
        ("i18n", i18n_sources, ":i18n_headers", [":icuuc76.dll_import"], ["U_I18N_IMPLEMENTATION"], ["kernel32.lib"]),
    ]:
        cc_library(
            name = "windows_" + role + "_objects",
            srcs = sources,
            deps = [headers] + dependencies,
            local_defines = _DEFINES + definitions,
            copts = _COPTS,
            alwayslink = True,
            linkstatic = True,
            target_compatible_with = _WINDOWS,
        )
        _shared(
            name = "icuuc76.dll" if role == "common" else "icuin76.dll",
            deps = [":windows_" + role + "_objects"] + dependencies,
            import_deps = dependencies,
            linkopts = linkopts,
        )
    native.filegroup(name = "windows_runtime_dlls", srcs = [":icudt76.dll", ":icuuc76.dll", ":icuin76.dll"], target_compatible_with = _WINDOWS)
    cc_test(
        name = "windows_icu_smoke_test",
        srcs = [Label("@oliphaunt//build_defs/native:icu-windows-smoke.cc")],
        deps = [":i18n"],
        copts = _COPTS,
        env = {"ICU_DATA": "/nonexistent-oliphaunt-icu-data"},
        target_compatible_with = _WINDOWS,
        size = "small",
    )
