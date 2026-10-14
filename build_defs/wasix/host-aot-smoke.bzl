"""Execute a bounded source-built side module and split tools on their native host."""

load("@oliphaunt_metadata//:metadata.bzl", "PRODUCTS", "PUBLICATION_CARRIERS")
load("//build_defs/foundation:bun.bzl", "BUN_SOURCE_TOOLCHAINS", "BUN_TEST_ENTRYPOINT_ATTRS", "bun_test_entrypoint", "bun_test_entrypoint_args")
load("//build_defs/extensions:wasix_carriers.bzl", "wasix_sql_carrier_helpers")
load(":npm.bzl", "RUNTIME_NPM_NOTICES")

def _host_aot_smoke_impl(ctx):
    binary = ctx.attr.binary[DefaultInfo].files_to_run.executable
    rows = [row for row in PUBLICATION_CARRIERS if row["ecosystem"] == "cargo" and (
        row["name"] == "liboliphaunt-wasix-portable" or
        (row["name"].startswith("oliphaunt-extension-contrib-pg18-") and row["target"] in ["wasix-portable", ctx.attr.target_triple]) or
        (row["product"] == "postgres-tools-wasix" and row["target"] in [None, ctx.attr.target_triple])
    )]
    expected = [row["name"] + "-" + row["version"] + ".crate" for row in rows]
    crates = [file for file in ctx.files.carriers if file.basename in expected]
    if len(expected) != 5 or sorted([file.basename for file in crates]) != sorted(expected) or any([file.is_directory for file in crates]):
        fail("WASIX host smoke requires its exact portable core, contrib/tools and matching host AOT Files")
    spec = ctx.actions.declare_file(ctx.label.name + ".inputs.json")
    ctx.actions.write(spec, json.encode({
        "target": ctx.attr.target_triple,
        "runtimeVersion": PRODUCTS["liboliphaunt-wasix"]["version"],
        "toolsVersion": PRODUCTS["postgres-tools-wasix"]["version"],
        "crates": {file.basename: file.path for file in crates},
    }))
    files = crates + [spec, binary] + ctx.files._helpers
    return bun_test_entrypoint(ctx, ctx.file._runner, [spec, binary], files,
        source_files = [ctx.file._runner] + ctx.files._helpers,
        additional_runfiles = ctx.attr.binary[DefaultInfo].default_runfiles)

_host_aot_smoke_test = rule(
    implementation = _host_aot_smoke_impl,
    test = True,
    toolchains = BUN_SOURCE_TOOLCHAINS,
    attrs = dict(BUN_TEST_ENTRYPOINT_ATTRS, **{
        "target_triple": attr.string(mandatory = True),
        "carriers": attr.label(default = "@wasix_runtime_carriers//:host_smoke", allow_files = True),
        "binary": attr.label(default = "//src/wasix/sdks/rust:host_aot_smoke_unit_test", executable = True, cfg = "target"),
        "_runner": attr.label(default = "//build_defs/wasix:host-aot-smoke.mts", allow_single_file = True),
        "_helpers": attr.label_list(default = wasix_sql_carrier_helpers() + ["//src/wasix/postgres-tools:tools/package-assets.mts", "//src/wasix/runtime:tools/package-release-assets.mts"] + RUNTIME_NPM_NOTICES.keys(), allow_files = True),
    }),
)

def wasix_host_aot_smoke_test(name, **kwargs):
    _host_aot_smoke_test(name = name, args = bun_test_entrypoint_args(name), **kwargs)
