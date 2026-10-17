"""Validate and extract the exact portable guest from one authenticated final File."""

load("@oliphaunt_metadata//:metadata.bzl", "WASIX_ARTIFACTS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "bun_file_action")
load("//build_defs/release:identity.bzl", "ReleaseIdentityInfo")
load(":release-asset.bzl", "POSTMASTER_RELEASE_HELPERS")
load(":aot.bzl", "PostmasterModulesInfo", "postmaster_module_outputs")

GUEST_INPUT_ATTRIBUTES = {
    "configuration": attr.label(mandatory = True, allow_files = True),
    "patches": attr.label_list(mandatory = True, allow_files = [".patch"]),
    "overlays": attr.label(default = "//src/wasix/postmaster:postgres_overlays", allow_files = True),
    "source": attr.label(default = "//src/third-party/postgres:source.toml", allow_single_file = True),
    "series": attr.label(default = "//src/wasix/postmaster:postgres/series", allow_single_file = True),
    "libc_source": attr.label(default = "@postmaster_wasix_libc//:source.json", allow_single_file = True),
    "libc_patch": attr.label(default = "//src/wasix/postmaster:wasmer/patches/wasix-libc/0001-postgres-wasix-blockers.patch", allow_single_file = True),
}

def guest_input_spec(ctx):
    configuration = {}
    for file in ctx.files.configuration:
        if file.basename in configuration:
            fail("Duplicate declared guest configuration basename: " + file.basename)
        configuration[file.basename] = file.path
    return {
        "source": ctx.file.source.path,
        "series": ctx.file.series.path,
        "patches": {file.short_path: file.path for file in ctx.files.patches},
        "overlays": {file.short_path.removeprefix("src/wasix/postmaster/postgres/overlays/wasix-core/"): file.path for file in ctx.files.overlays},
        "configuration": configuration,
        "libcSource": ctx.file.libc_source.path,
        "libcPatch": ctx.file.libc_patch.path,
    }

def guest_input_files(ctx):
    return [ctx.file.source, ctx.file.series, ctx.file.libc_source, ctx.file.libc_patch] + ctx.files.patches + ctx.files.overlays + ctx.files.configuration

def _import_guest_impl(ctx):
    owner = ctx.attr.owner[ReleaseIdentityInfo]
    rows = [row for row in WASIX_ARTIFACTS if row["product"] == owner.id and row["target"] == "linux-x64-gnu" and row["kind"] == "wasix-postmaster-runtime"]
    if len(rows) != 1:
        fail("Imported postmaster guest requires one canonical Linux producer row")
    output = ctx.actions.declare_directory(ctx.label.name)
    receipt = ctx.actions.declare_file(ctx.label.name + ".guest-build.receipt")
    modules = postmaster_module_outputs(ctx, ctx.attr.module_paths)
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode(guest_input_spec(ctx) | {"archive": ctx.file.archive.path, "version": owner.version, "artifact": rows[0], "moduleOutputs": {path: file.path for path, file in modules.items()}}))
    bun_file_action(ctx, ctx.file._writer, arguments = [spec.path, output.path, receipt.path],
                    source_files = ctx.files._helpers,
                    inputs = [spec, ctx.file.archive] + guest_input_files(ctx), outputs = [output, receipt] + modules.values(), mnemonic = "PostmasterImportedGuest")
    return [DefaultInfo(files = depset([output])), OutputGroupInfo(receipt = depset([receipt])), PostmasterModulesInfo(modules = modules)]

postmaster_import_guest = rule(
    implementation = _import_guest_impl,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = GUEST_INPUT_ATTRIBUTES | {
        "archive": attr.label(default = "@postmaster_guest//:archive", allow_single_file = True),
        "module_paths": attr.string_list(mandatory = True),
        "owner": attr.label(default = "@oliphaunt_metadata//:product_liboliphaunt-wasix-postmaster", providers = [ReleaseIdentityInfo]),
        "_writer": attr.label(default = "//build_defs/wasix/postmaster:import-guest.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = POSTMASTER_RELEASE_HELPERS + ["//build_defs/wasix/postmaster:guest-inputs.mts"], allow_files = True),
    },
)
