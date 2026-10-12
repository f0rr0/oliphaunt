"""Regenerate host AOT and the public carrier from the preserved Linux guest."""

load("@postmaster_guest//:guest.bzl", "POSTMASTER_GUEST_MODULE_PATHS")
load("@postmaster_postgres//:patches.bzl", "POSTGRES_PATCHES")
load(":aot.bzl", "postmaster_aot")
load(":carrier.bzl", "postmaster_carrier")
load(":import-guest.bzl", "postmaster_import_guest")
load(":postgres.bzl", "postmaster_patch_inputs")
load(":release-asset.bzl", "postmaster_release_asset")
load(":runtime-test.bzl", "postmaster_runtime_test")

def postmaster_imported_host_carrier(target, native_platform, execution, name = None, archive = "@postmaster_guest//:archive", aot_modules = None, aot_receipts = None):
    """A declared host profile; runtime qualification executes on that host."""
    name = name or target.replace("-", "_")
    compatible = ["@platforms//cpu:wasm32", "@platforms//os:wasi"]
    guest = name + "_guest"
    postmaster_import_guest(name = guest, archive = archive, configuration = "@postmaster_postgres//:configuration", patches = postmaster_patch_inputs(POSTGRES_PATCHES),
                            target_compatible_with = compatible, exec_compatible_with = execution)
    native.filegroup(name = guest + "_receipt", srcs = [":" + guest], output_group = "receipt", target_compatible_with = compatible)
    if not aot_modules:
        aot = []
        for path in POSTMASTER_GUEST_MODULE_PATHS:
            module = name + "_" + path.replace("/", "_").replace(".", "_") + "_aot"
            postmaster_aot(name = module, sealed = ":" + guest, module_path = path,
                           target_compatible_with = compatible, exec_compatible_with = execution)
            aot.append(":" + module)
        native.filegroup(name = name + "_aot", srcs = aot, target_compatible_with = compatible)
        native.filegroup(name = name + "_aot_receipts", srcs = aot, output_group = "receipt", target_compatible_with = compatible)
        aot_modules = ":" + name + "_aot"
        aot_receipts = ":" + name + "_aot_receipts"
    carrier = name + "_carrier"
    postmaster_carrier(name = carrier, sealed = ":" + guest, guest_receipt = ":" + guest + "_receipt",
                       native_platform = native_platform, aot = aot_modules, aot_receipts = aot_receipts,
                       configuration = "@postmaster_postgres//:configuration", patches = postmaster_patch_inputs(POSTGRES_PATCHES),
                       target_compatible_with = compatible, exec_compatible_with = execution)
    postmaster_runtime_test(name = name + "_runtime_test", carrier = ":" + carrier, native_platform = native_platform,
                            target = target, target_compatible_with = compatible, exec_compatible_with = execution,
                            tags = ["manual"], size = "medium", timeout = "long")
    postmaster_release_asset(name = name, target = target, carrier = ":" + carrier, execution = execution, qualification = [":" + name + "_runtime_test"])
